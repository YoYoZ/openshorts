"""Delete superseded renders inside a project folder.

Every subtitle / hook / recut / reframe pass writes a full new copy of the clip
(``audio_<ts>_``, ``subtitled_<ts>_``, ``hooked_<ts>_``, ``recut_<ts>_<hex>_`` prefixes) and the
old ones were never removed: a 10-clip project grew to ~5 GB, ~4 GB of it dead
copies. ``plan()`` works out what is safe to drop; ``collect()`` drops it.

Kept, always:
* each clip's current file and every file it is rebuilt from: the names left
  after stripping its burned-layer prefixes one at a time (captions and hooks
  are re-applied on top of those bases, see app._rebuild_layers);
* any file a clip's metadata mentions by name (dubs, sidecars, thumbnails);
* the source video, metadata (and its backups), caches, anything unrecognised;
* anything modified in the last ``keep_hours`` (before/after, in-flight work).

Only files of a known derived kind are ever deleted: videos carrying a render
prefix or a ``_clip_N`` name, their ``.json`` sidecars, ``temp_*`` files and
``autosubs_*.ass`` caption scripts.
"""
import os
import re
import time

_LAYER = re.compile(r"^(audio_\d+_|subtitled_\d+_|hooked_\d+_|recut_\d+_[0-9a-f]+_|edited_|wm_)")
_DERIVED_VIDEO = re.compile(r"(^audio_|^subtitled_|^hooked_|^recut_|^edited_|^wm_|^temp_|_clip_\d+\.mp4$)")
_VIDEO_EXT = (".mp4", ".mov", ".mkv", ".webm")


def ancestors(name):
    """``name`` and each base left by stripping one render prefix at a time."""
    out = [name]
    while True:
        stripped = _LAYER.sub("", name, count=1)
        if stripped == name:
            return out
        name = stripped
        out.append(name)


def _mentioned(value, found):
    """Basenames of every file-looking string inside a clip's metadata."""
    if isinstance(value, dict):
        for v in value.values():
            _mentioned(v, found)
    elif isinstance(value, list):
        for v in value:
            _mentioned(v, found)
    elif isinstance(value, str) and re.search(r"\.(mp4|mov|json|ass|srt|jpg|jpeg|png|webm|m4a|mp3|wav)(\?|$)", value):
        found.add(os.path.basename(value.split("?")[0]).replace("%20", " "))


def _deletable_kind(name):
    if name.startswith("temp_"):
        return "temp file"
    if name.startswith("autosubs_") and name.endswith(".ass"):
        return "caption script"
    if name.startswith("audiopreview_") and name.endswith(".wav"):
        return "audio preview"
    lower = name.lower()
    if lower.endswith(_VIDEO_EXT) and _DERIVED_VIDEO.search(name):
        return "old render"
    if lower.endswith(".mp4.json") and _DERIVED_VIDEO.search(name[:-5]):
        return "render sidecar"
    return None


def plan(job_dir, clips, keep_hours=24.0, now=None):
    """[(path, bytes, reason)] that can go, plus the set of protected names."""
    import urllib.parse
    now = now or time.time()
    keep = set()
    for clip in clips or []:
        current = os.path.basename(urllib.parse.unquote(str(clip.get("video_url") or "").split("?")[0]))
        if current:
            for name in ancestors(current):
                keep.add(name)
                keep.add(name + ".json")
        _mentioned(clip, keep)
    # The canonical render of each clip is the reset point: never drop it.
    for name in list(keep):
        for base in ancestors(name):
            keep.add(base)
    out = []
    try:
        names = os.listdir(job_dir)
    except OSError:
        return [], keep
    for name in names:
        if name in keep:
            continue
        reason = _deletable_kind(name)
        if not reason:
            continue
        path = os.path.join(job_dir, name)
        try:
            st = os.stat(path)
        except OSError:
            continue
        if not os.path.isfile(path) or now - st.st_mtime < keep_hours * 3600:
            continue
        # A clip_N canonical render no clip points at any more still stays
        # when it is the only copy of that clip number (nothing derives from
        # it) - only renders with a prefix are certainly superseded.
        if reason == "old render" and not _LAYER.match(name) and not name.startswith("temp_"):
            continue
        out.append((path, st.st_size, reason))
    return out, keep


def collect(job_dir, clips, keep_hours=24.0, dry_run=False):
    """Delete what ``plan`` allows. Returns {"files", "bytes", "kept"}."""
    doomed, keep = plan(job_dir, clips, keep_hours)
    freed = files = 0
    for path, size, _ in doomed:
        if dry_run:
            freed += size
            files += 1
            continue
        try:
            os.remove(path)
            freed += size
            files += 1
        except OSError:
            pass
    return {"files": files, "bytes": freed, "kept": len(keep)}
