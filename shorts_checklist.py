"""Pre-publish checklist for one short: format, audio, opening, safe zones,
title/description, publishing state.

``media_facts(path)`` measures the rendered file with ffprobe/ffmpeg (a few
seconds per clip) and is cached per file in ``.checks_cache.json`` inside the
project folder; ``run(clip, facts, siblings)`` turns the facts plus the clip's
metadata into checklist items, cheap enough to recompute on every request.

Each item: {"id", "group", "label", "status": ok|warn|fail|info, "detail"}.
"fail" means YouTube will reject or mistreat the upload; "warn" costs reach.
"""
import json
import os
import re
import subprocess
import threading
import time

# Shorts UI, as frame-height fractions (the dashboard's safe-zone overlay draws
# the same areas): top bar, bottom title/channel block, the right-hand
# like/comment/share column between these heights.
TOP_UI = 0.07
BOTTOM_UI = 0.78
RIGHT_COLUMN = (0.38, 0.78)

# Captions burned before this moment used MarginV 43 (bottom edge ~85%,
# inside BOTTOM_UI); from then on bottom captions end at ~74%.
SAFE_CAPTIONS_SINCE = 1791735875

_cache_lock = threading.Lock()


def _run(cmd, timeout=180):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout)


def _probe(path):
    out = _run(["ffprobe", "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", path], timeout=30)
    data = json.loads(out.stdout or "{}")
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    audio = next((s for s in data.get("streams", []) if s.get("codec_type") == "audio"), None)
    fps = None
    try:
        num, den = (video.get("avg_frame_rate") or "0/1").split("/")
        fps = float(num) / float(den) if float(den) else None
    except (ValueError, ZeroDivisionError):
        pass
    fmt = data.get("format", {})
    return {
        "duration": float(fmt.get("duration") or 0),
        "size": int(fmt.get("size") or 0),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "fps": round(fps, 2) if fps else None,
        "vcodec": video.get("codec_name"),
        "acodec": audio.get("codec_name") if audio else None,
        "has_audio": audio is not None,
    }


def _audio_analysis(path):
    """Integrated loudness, true peak and silences in one decode."""
    out = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-vn",
                "-af", "ebur128=peak=true,silencedetect=noise=-35dB:d=0.6",
                "-f", "null", "-"])
    err = out.stderr
    lufs = peak = None
    summary = err[err.rfind("Summary:"):] if "Summary:" in err else ""
    m = re.search(r"I:\s+(-?[\d.]+|-inf) LUFS", summary)
    if m and m.group(1) != "-inf":
        lufs = float(m.group(1))
    m = re.search(r"Peak:\s+(-?[\d.]+|-inf) dBFS", summary)
    if m and m.group(1) != "-inf":
        peak = float(m.group(1))
    silences, start = [], None
    for line in err.splitlines():
        m = re.search(r"silence_start: (-?[\d.]+)", line)
        if m:
            start = max(0.0, float(m.group(1)))
        m = re.search(r"silence_end: (-?[\d.]+)", line)
        if m and start is not None:
            silences.append([round(start, 2), round(float(m.group(1)), 2)])
            start = None
    if start is not None:   # silent until the end
        silences.append([round(start, 2), None])
    return {"lufs": lufs, "true_peak": peak, "silences": silences}


def _black_start(path):
    """Seconds of black at the very start (0 when the first frame has picture)."""
    out = _run(["ffmpeg", "-hide_banner", "-nostats", "-t", "2", "-i", path,
                "-vf", "blackdetect=d=0.1:pix_th=0.10", "-an", "-f", "null", "-"], timeout=60)
    m = re.search(r"black_start:(\d+(?:\.\d+)?) black_end:(\d+(?:\.\d+)?)", out.stderr)
    if m and float(m.group(1)) < 0.05:
        return round(float(m.group(2)), 2)
    return 0.0


def media_facts(path):
    """Measured facts about a rendered clip, cached by file name + mtime."""
    folder, name = os.path.split(path)
    mtime = os.path.getmtime(path)
    cache_path = os.path.join(folder, ".checks_cache.json")
    with _cache_lock:
        try:
            with open(cache_path, encoding="utf-8") as f:
                cache = json.load(f)
        except (OSError, ValueError):
            cache = {}
        hit = cache.get(name)
        if hit and hit.get("mtime") == mtime:
            return hit["facts"]
    facts = _probe(path)
    facts["mtime"] = mtime
    if facts["has_audio"]:
        facts.update(_audio_analysis(path))
    facts["black_start"] = _black_start(path)
    with _cache_lock:
        try:
            with open(cache_path, encoding="utf-8") as f:
                cache = json.load(f)
        except (OSError, ValueError):
            cache = {}
        cache[name] = {"mtime": mtime, "facts": facts, "at": time.time()}
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    return facts


def _item(items, group, id_, label, status, detail=""):
    items.append({"id": id_, "group": group, "label": label, "status": status, "detail": detail})


def _fmt_s(s):
    return f"{s:.1f} s"


def run(clip, facts, siblings=()):
    items = []
    d = facts.get("duration") or 0

    # --- format -----------------------------------------------------------
    if d > 180:
        _item(items, "format", "duration", "Length", "fail",
              f"{_fmt_s(d)}: over 3 minutes, YouTube uploads it as a regular video, not a Short.")
    elif d > 60:
        _item(items, "format", "duration", "Length", "warn",
              f"{_fmt_s(d)}: Shorts allow up to 3 min, but past 60 s completion rate (and reach) usually drops.")
    elif d < 10:
        _item(items, "format", "duration", "Length", "warn",
              f"{_fmt_s(d)}: very short; under ~10 s rarely carries a full idea.")
    else:
        _item(items, "format", "duration", "Length", "ok", _fmt_s(d))

    w, h = facts.get("width") or 0, facts.get("height") or 0
    if not w or not h:
        _item(items, "format", "aspect", "Vertical 9:16", "fail", "Could not read the video size.")
    elif w >= h:
        _item(items, "format", "aspect", "Vertical 9:16", "fail",
              f"{w}×{h} is not vertical; YouTube shows it as a regular video.")
    elif abs(w / h - 9 / 16) > 0.02:
        _item(items, "format", "aspect", "Vertical 9:16", "warn",
              f"{w}×{h} ({w / h:.3f}); the Shorts player adds bars or crops.")
    else:
        _item(items, "format", "aspect", "Vertical 9:16", "ok", f"{w}×{h}")

    if h and h < 1280:
        _item(items, "format", "resolution", "Resolution", "warn", f"{h}p: looks soft on phones; aim for 1080×1920.")
    elif h and h < 1920:
        _item(items, "format", "resolution", "Resolution", "warn", f"{h}p: below 1080×1920.")
    elif h:
        _item(items, "format", "resolution", "Resolution", "ok", f"{h}p")

    fps = facts.get("fps")
    if fps and (fps < 23.5 or fps > 60.5):
        _item(items, "format", "fps", "Frame rate", "warn", f"{fps} fps: use 24–60.")
    elif fps:
        _item(items, "format", "fps", "Frame rate", "ok", f"{fps:g} fps")

    vc, ac = facts.get("vcodec"), facts.get("acodec")
    if vc not in ("h264", "hevc") or (ac and ac not in ("aac", "mp3", "opus")):
        _item(items, "format", "codec", "Codecs", "warn", f"{vc} / {ac}: H.264 + AAC is the safe pair.")
    else:
        _item(items, "format", "codec", "Codecs", "ok", f"{vc} / {ac}")

    # --- audio ------------------------------------------------------------
    if not facts.get("has_audio"):
        _item(items, "audio", "audio", "Has sound", "fail", "No audio track.")
    else:
        lufs, peak = facts.get("lufs"), facts.get("true_peak")
        if lufs is None:
            _item(items, "audio", "loudness", "Loudness", "warn", "Silent or unreadable audio.")
        elif lufs < -18:
            _item(items, "audio", "loudness", "Loudness", "warn",
                  f"{lufs:.1f} LUFS: quiet. YouTube turns loud videos down but never quiet ones up; aim for about -14.")
        elif lufs > -10:
            _item(items, "audio", "loudness", "Loudness", "warn",
                  f"{lufs:.1f} LUFS: loud; YouTube will turn it down and it may sound squashed. Aim for about -14.")
        else:
            _item(items, "audio", "loudness", "Loudness", "ok", f"{lufs:.1f} LUFS")
        if peak is not None and peak > -0.5:
            _item(items, "audio", "peak", "Clipping", "warn", f"Peaks at {peak:.1f} dBFS: likely distortion.")

        silences = facts.get("silences") or []
        lead = next((s for s in silences if s[0] <= 0.05), None)
        lead_len = ((lead[1] if lead[1] is not None else d) - lead[0]) if lead else 0
        if lead_len > 0.8:
            _item(items, "opening", "lead_silence", "Talks right away", "warn",
                  f"{_fmt_s(lead_len)} of silence before anyone speaks; viewers swipe in the first second.")
        else:
            _item(items, "opening", "lead_silence", "Talks right away", "ok", "")
        inner = [s for s in silences if s[0] > 0.05 and s[1] is not None and s[1] < d - 0.3]
        longest = max(inner, key=lambda s: s[1] - s[0], default=None)
        if longest and longest[1] - longest[0] > 2.0:
            _item(items, "audio", "dead_air", "No dead air", "warn",
                  f"{_fmt_s(longest[1] - longest[0])} pause at {longest[0]:.1f} s; trim it.")
        tail = next((s for s in silences if (s[1] is None or s[1] >= d - 0.3) and s[0] > 0.05), None)
        if tail and d - tail[0] > 1.5:
            _item(items, "audio", "tail_silence", "Ends cleanly", "warn",
                  f"{_fmt_s(d - tail[0])} of silence at the end; cut it so the loop restarts sooner.")

    # --- opening ----------------------------------------------------------
    bs = facts.get("black_start") or 0
    if bs > 0.1:
        _item(items, "opening", "black_start", "Opens on picture", "warn",
              f"{_fmt_s(bs)} of black at the start; the feed shows that frame first.")
    else:
        _item(items, "opening", "black_start", "Opens on picture", "ok", "")

    hook = clip.get("auto_hook") or {}
    if hook.get("text"):
        _item(items, "opening", "hook", "On-screen hook", "ok", hook["text"])
    else:
        _item(items, "opening", "hook", "On-screen hook", "warn",
              "No hook text; most viewers decide with the sound off in the first 2 seconds.")

    has_captions = bool(clip.get("caption_style") or clip.get("caption_words"))
    if has_captions:
        _item(items, "opening", "captions", "Captions", "ok", "")
    else:
        _item(items, "opening", "captions", "Captions", "warn", "No captions; many watch muted.")

    # --- safe zones -------------------------------------------------------
    if has_captions:
        style = clip.get("caption_style") or {}
        pos = str(style.get("position") or style.get("alignment") or "bottom").lower()
        if pos == "bottom" and (facts.get("mtime") or 0) < SAFE_CAPTIONS_SINCE:
            _item(items, "safe", "captions_zone", "Captions clear of YouTube UI", "warn",
                  "Rendered with the old bottom position, under the title/channel block. Re-apply subtitles.")
        else:
            _item(items, "safe", "captions_zone", "Captions clear of YouTube UI", "ok", pos)
    if hook.get("text"):
        y, hh = hook.get("y"), hook.get("height")
        position = str(hook.get("position") or "auto").lower()
        if y is None:
            y = {"top": 0.20, "center": 0.45, "bottom": 0.70}.get(position)
        hh = hh or 0.08
        if y is None:
            _item(items, "safe", "hook_zone", "Hook clear of YouTube UI", "info",
                  "Placed automatically before positions were recorded; check it with the safe-zone overlay.")
        elif y < TOP_UI:
            _item(items, "safe", "hook_zone", "Hook clear of YouTube UI", "warn", "Hook starts under the top bar.")
        elif y + hh > BOTTOM_UI:
            _item(items, "safe", "hook_zone", "Hook clear of YouTube UI", "warn",
                  "Hook reaches into the bottom title/channel block.")
        else:
            _item(items, "safe", "hook_zone", "Hook clear of YouTube UI", "ok", f"{y:.0%}–{y + hh:.0%} of the height")

    # --- title & description ----------------------------------------------
    title = (clip.get("video_title_for_youtube_short") or "").strip()
    desc = (clip.get("video_description_for_tiktok") or "").strip()
    if not title:
        _item(items, "text", "title", "Title", "fail", "No title.")
    elif "<" in title or ">" in title:
        _item(items, "text", "title", "Title", "fail", "Contains < or >, which YouTube rejects.")
    elif len(title) > 100:
        _item(items, "text", "title", "Title", "fail", f"{len(title)} characters; YouTube's limit is 100.")
    elif len(title) > 70:
        _item(items, "text", "title", "Title", "warn",
              f"{len(title)} characters; the Shorts feed shows roughly the first 40–60.")
    else:
        _item(items, "text", "title", "Title", "ok", f"{len(title)} characters")

    others = [(s.get("video_title_for_youtube_short") or "").strip().lower() for s in siblings]
    if title and others.count(title.lower()) > 0:
        _item(items, "text", "title_dup", "Unique title", "warn", "Another clip in this project has the same title.")

    tags = re.findall(r"#[\w\u0400-\u04FF]+", desc)
    if "<" in desc or ">" in desc:
        _item(items, "text", "description", "Description", "fail", "Contains < or >, which YouTube rejects.")
    elif len(desc) > 5000:
        _item(items, "text", "description", "Description", "fail", f"{len(desc)} characters; the limit is 5000.")
    elif not desc:
        _item(items, "text", "description", "Description", "warn", "Empty; a line of context helps search.")
    else:
        _item(items, "text", "description", "Description", "ok", f"{len(desc)} characters")
    if len(tags) > 60:
        _item(items, "text", "hashtags", "Hashtags", "fail", f"{len(tags)} hashtags: over 60 and YouTube ignores all of them.")
    elif len(tags) > 15:
        _item(items, "text", "hashtags", "Hashtags", "warn", f"{len(tags)} hashtags; 3–5 relevant ones work better.")
    elif not tags:
        _item(items, "text", "hashtags", "Hashtags", "warn", "None; add 3–5 relevant ones.")
    else:
        _item(items, "text", "hashtags", "Hashtags", "ok", " ".join(tags[:5]))

    # --- publishing -------------------------------------------------------
    yt = clip.get("youtube") or {}
    if yt.get("video_id"):
        when = yt.get("publish_at")
        try:
            from datetime import datetime
            when = datetime.fromisoformat(str(when).replace("Z", "+00:00")).astimezone().strftime("%d %b %H:%M") if when else None
        except ValueError:
            pass
        _item(items, "publish", "youtube", "On YouTube", "info",
              f"Scheduled for {when} (your time)" if when else "Uploaded")
    if clip.get("rejected"):
        _item(items, "publish", "rejected", "Rejected", "info", "Marked rejected.")

    summary = {k: sum(1 for i in items if i["status"] == k) for k in ("ok", "warn", "fail", "info")}
    return {"items": items, "summary": summary}
