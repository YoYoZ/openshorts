"""Direct YouTube uploads (Data API v3) with the OAuth token in youtube_auth/.

youtube_auth/token.json holds an authorized-user token (client_id,
client_secret, refresh_token, token_uri) with the youtube.upload scope; it is
refreshed here for a short-lived access token on demand. Uploads are
resumable and sent in chunks so a caller can report progress.
"""
import json
import os
import threading
import time

import httpx

AUTH_DIR = os.environ.get("YOUTUBE_AUTH_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "youtube_auth")
TOKEN_PATH = os.path.join(AUTH_DIR, "token.json")
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
API = "https://www.googleapis.com/youtube/v3"
CHUNK = 8 * 1024 * 1024

_lock = threading.Lock()
_access = {"token": None, "expires": 0.0}


class QuotaExceeded(RuntimeError):
    """The project's daily YouTube API quota is used up (resets at midnight PT)."""


class NotConnected(RuntimeError):
    """No usable token in youtube_auth/."""


def _load_token():
    try:
        with open(TOKEN_PATH, encoding="utf-8") as f:
            t = json.load(f)
    except (OSError, ValueError):
        raise NotConnected(f"no YouTube token at {TOKEN_PATH}")
    if not t.get("refresh_token"):
        raise NotConnected("the YouTube token has no refresh_token")
    return t


def access_token():
    with _lock:
        if _access["token"] and time.time() < _access["expires"] - 60:
            return _access["token"]
        t = _load_token()
        r = httpx.post(t.get("token_uri") or "https://oauth2.googleapis.com/token", data={
            "client_id": t["client_id"], "client_secret": t["client_secret"],
            "refresh_token": t["refresh_token"], "grant_type": "refresh_token"}, timeout=30)
        if r.status_code != 200:
            raise NotConnected(f"token refresh failed: HTTP {r.status_code} {r.text[:200]}")
        body = r.json()
        _access.update(token=body["access_token"], expires=time.time() + int(body.get("expires_in", 3600)))
        return _access["token"]


def _raise_for(resp):
    if resp.status_code < 400:
        return
    try:
        reasons = [e.get("reason") for e in resp.json()["error"].get("errors", [])]
    except Exception:
        reasons = []
    if "quotaExceeded" in reasons or "uploadLimitExceeded" in reasons:
        raise QuotaExceeded("YouTube daily upload quota reached; try again tomorrow")
    raise RuntimeError(f"YouTube API HTTP {resp.status_code}: {resp.text[:300]}")


def channel():
    """{id, title, handle} of the connected channel."""
    r = httpx.get(f"{API}/channels", params={"part": "snippet", "mine": "true"},
                  headers={"Authorization": f"Bearer {access_token()}"}, timeout=30)
    _raise_for(r)
    item = (r.json().get("items") or [{}])[0]
    snip = item.get("snippet", {})
    return {"id": item.get("id"), "title": snip.get("title"), "handle": snip.get("customUrl")}


def upload(path, title, description, tags=None, publish_at=None, privacy="private",
           category_id="28", language=None, on_progress=None):
    """Upload ``path``. ``publish_at`` (RFC 3339 UTC) schedules it: the video
    stays private and YouTube makes it public at that time. Returns the API's
    video resource (id, status)."""
    status = {"privacyStatus": "private" if publish_at else privacy,
              "selfDeclaredMadeForKids": False}
    if publish_at:
        status["publishAt"] = publish_at
    snippet = {"title": title[:100], "description": description[:5000],
               "tags": tags or [], "categoryId": category_id}
    if language:
        snippet["defaultLanguage"] = language
        snippet["defaultAudioLanguage"] = language
    size = os.path.getsize(path)
    headers = {"Authorization": f"Bearer {access_token()}"}
    init = httpx.post(UPLOAD_URL, params={"uploadType": "resumable", "part": "snippet,status"},
                      headers={**headers, "Content-Type": "application/json; charset=UTF-8",
                               "X-Upload-Content-Type": "video/mp4",
                               "X-Upload-Content-Length": str(size)},
                      content=json.dumps({"snippet": snippet, "status": status},
                                         ensure_ascii=False).encode("utf-8"), timeout=60)
    _raise_for(init)
    session = init.headers["Location"]
    sent = 0
    with open(path, "rb") as f, httpx.Client(timeout=300) as client:
        while sent < size:
            chunk = f.read(CHUNK)
            end = sent + len(chunk) - 1
            r = client.put(session, content=chunk, headers={
                **headers, "Content-Type": "video/mp4",
                "Content-Range": f"bytes {sent}-{end}/{size}"})
            if r.status_code == 308:          # chunk stored, send the next one
                rng = r.headers.get("Range")
                sent = int(rng.split("-")[1]) + 1 if rng else end + 1
                f.seek(sent)
            elif r.status_code in (200, 201):
                sent = size
                if on_progress:
                    on_progress(100.0)
                return r.json()
            else:
                _raise_for(r)
            if on_progress:
                on_progress(sent / size * 100)
    raise RuntimeError("upload ended without a response from YouTube")
