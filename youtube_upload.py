"""Direct YouTube uploads (Data API v3), for one or several channels.

Each channel is an authorized-user token (client_id, client_secret,
refresh_token, token_uri) with the youtube.upload scope:
  youtube_auth/token.json            account "default" (the first one connected)
  youtube_auth/accounts/<name>.json  one more account per file
Tokens are refreshed here for short-lived access tokens on demand. Uploads
are resumable and sent in chunks so a caller can report progress.
"""
import json
import os
import threading
import time

import httpx

AUTH_DIR = os.environ.get("YOUTUBE_AUTH_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "youtube_auth")
TOKEN_PATH = os.path.join(AUTH_DIR, "token.json")
ACCOUNTS_DIR = os.path.join(AUTH_DIR, "accounts")
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
API = "https://www.googleapis.com/youtube/v3"
CHUNK = 8 * 1024 * 1024

_lock = threading.Lock()
_access = {}     # account -> {"token", "expires"}
_channels = {}   # account -> (fetched_at, {id, title, handle})


class QuotaExceeded(RuntimeError):
    """The project's daily YouTube API quota is used up (resets at midnight PT)."""


class NotConnected(RuntimeError):
    """No usable token in youtube_auth/."""


def accounts():
    """Account names with a token file, "default" first."""
    names = ["default"] if os.path.isfile(TOKEN_PATH) else []
    try:
        names += sorted(f[:-5] for f in os.listdir(ACCOUNTS_DIR)
                        if f.endswith(".json") and f[:-5] != "default")
    except OSError:
        pass
    return names


def _token_path(account):
    account = account or default_account()
    if not account:
        raise NotConnected("no YouTube channel connected")
    if account == "default":
        return TOKEN_PATH
    name = os.path.basename(str(account))
    return os.path.join(ACCOUNTS_DIR, f"{name}.json")


def default_account():
    """Settings → YouTube default channel when it still exists, else the first."""
    names = accounts()
    try:
        import settings_store
        wanted = settings_store.load()["youtube"].get("default_account")
    except Exception:
        wanted = None
    if wanted in names:
        return wanted
    return names[0] if names else None


def _load_token(account=None):
    path = _token_path(account)
    try:
        with open(path, encoding="utf-8") as f:
            t = json.load(f)
    except (OSError, ValueError):
        raise NotConnected(f"no YouTube token for account {account or 'default'}")
    if not t.get("refresh_token"):
        raise NotConnected("the YouTube token has no refresh_token")
    return t


def access_token(account=None):
    account = account or default_account()
    with _lock:
        cached = _access.get(account)
        if cached and time.time() < cached["expires"] - 60:
            return cached["token"]
        t = _load_token(account)
        r = httpx.post(t.get("token_uri") or "https://oauth2.googleapis.com/token", data={
            "client_id": t["client_id"], "client_secret": t["client_secret"],
            "refresh_token": t["refresh_token"], "grant_type": "refresh_token"}, timeout=30)
        if r.status_code != 200:
            raise NotConnected(f"token refresh failed: HTTP {r.status_code} {r.text[:200]}")
        body = r.json()
        _access[account] = {"token": body["access_token"],
                            "expires": time.time() + int(body.get("expires_in", 3600))}
        return body["access_token"]


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


def channel(account=None):
    """{id, title, handle} of an account's channel (cached for an hour)."""
    account = account or default_account()
    hit = _channels.get(account)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    r = httpx.get(f"{API}/channels", params={"part": "snippet", "mine": "true"},
                  headers={"Authorization": f"Bearer {access_token(account)}"}, timeout=30)
    _raise_for(r)
    item = (r.json().get("items") or [{}])[0]
    snip = item.get("snippet", {})
    info = {"id": item.get("id"), "title": snip.get("title"), "handle": snip.get("customUrl")}
    _channels[account] = (time.time(), info)
    return info


def channels():
    """Every connected account with its channel, or the error that stops it."""
    out = []
    for name in accounts():
        try:
            out.append({"account": name, **channel(name)})
        except Exception as e:
            out.append({"account": name, "error": str(e)[:200]})
    return out


def upload(path, title, description, tags=None, publish_at=None, privacy="private",
           category_id="28", language=None, on_progress=None, account=None):
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
    headers = {"Authorization": f"Bearer {access_token(account)}"}
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
