"""Helpers for browser-rendered caption overlays."""
import hashlib
import json
import os


def stable_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def overlay_is_valid(overlay, clip, split_ranges=()):
    if not overlay or split_ranges:
        return False
    if not os.path.isdir(overlay.get("dir", "")):
        return False
    if overlay.get("recipe") != (clip.get("recipe") or {}).get("segments"):
        return False
    return overlay.get("caption_style_hash") == stable_hash(clip.get("caption_style") or {})


def build_concat_list(frames, duration, directory, list_path):
    """Write concat-demuxer entries, inserting transparent intervals for gaps."""
    import struct
    import zlib

    blank = os.path.join(directory, "transparent.png")
    if not os.path.exists(blank):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
        width, height = 1080, 1920
        raw = (b"\x00" + b"\x00" * (width * 4)) * height
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
        with open(blank, "wb") as f:
            f.write(png)
    entries = []
    cursor = 0.0
    for frame in sorted(frames, key=lambda item: float(item["start"])):
        start, end = max(cursor, float(frame["start"])), min(float(duration), float(frame["end"]))
        if start > cursor:
            entries.append((blank, start - cursor))
        if end > start:
            entries.append((os.path.join(directory, frame["name"]), end - start))
            cursor = end
    if cursor < duration:
        entries.append((blank, duration - cursor))
    with open(list_path, "w", encoding="utf-8") as f:
        for path, seconds in entries:
            f.write(f"file '{os.path.abspath(path).replace(chr(39), chr(39)+chr(92)+chr(39)+chr(39))}'\n")
            f.write(f"duration {seconds:.6f}\n")
        if entries:
            f.write(f"file '{os.path.abspath(entries[-1][0])}'\n")
    return list_path
