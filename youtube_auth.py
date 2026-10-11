"""Connect a YouTube channel: turn a Google OAuth client file into the
``youtube_auth/token.json`` that youtube_upload.py uses.

    python youtube_auth.py path/to/client_secret.json [--out DIR]

Opens Google's consent page in the browser, catches the answer on a
localhost port, exchanges it for a refresh token and writes token.json.
``--out`` defaults to ./youtube_auth (the dev setup); the installed desktop
app reads <app data>/youtube_auth instead (see README).

The client must be an OAuth client of type "Desktop app" in a Google Cloud
project with the YouTube Data API v3 enabled.
"""
import argparse
import http.server
import json
import os
import secrets
import sys
import threading
import urllib.parse
import webbrowser

import httpx

SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly"]
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"


def _client(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    c = data.get("installed") or data.get("web") or data
    if not c.get("client_id") or not c.get("client_secret"):
        sys.exit("That file has no client_id / client_secret: download the JSON of an "
                 "OAuth client of type 'Desktop app'.")
    return c["client_id"], c["client_secret"]


def _wait_for_code(port, state):
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if q.get("state", [""])[0] != state:
                self.send_response(400)
                self.end_headers()
                return
            result["code"] = q.get("code", [None])[0]
            result["error"] = q.get("error", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "Connected. You can close this tab." if result["code"] else f"Failed: {result['error']}"
            self.wfile.write(f"<p style='font:16px sans-serif'>{msg}</p>".encode())
            threading.Thread(target=self.server.shutdown, daemon=True).start()

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("client_secret", help="OAuth client JSON downloaded from Google Cloud")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "youtube_auth"),
                    help="folder to write token.json into")
    args = ap.parse_args()

    client_id, client_secret = _client(args.client_secret)
    with __import__("socket").socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    redirect = f"http://127.0.0.1:{port}"
    state = secrets.token_urlsafe(16)
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent", "state": state,
    })
    print("Opening Google sign-in in your browser. If it does not open, visit:\n" + url)
    webbrowser.open(url)
    answer = _wait_for_code(port, state)
    if not answer.get("code"):
        sys.exit(f"Not connected: {answer.get('error') or 'no code returned'}")

    r = httpx.post(TOKEN_URL, data={
        "code": answer["code"], "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": redirect, "grant_type": "authorization_code"}, timeout=30)
    tok = r.json()
    if r.status_code != 200 or not tok.get("refresh_token"):
        sys.exit(f"Token exchange failed: {tok.get('error_description') or tok}")

    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, "token.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"client_id": client_id, "client_secret": client_secret,
                   "refresh_token": tok["refresh_token"], "token_uri": TOKEN_URL,
                   "scopes": SCOPES}, f, indent=2)
    print(f"Saved {path}. Restart AutoShortsCut; Schedule shows the channel when it works.")


if __name__ == "__main__":
    main()
