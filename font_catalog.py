"""The fonts installed on this computer, for the caption editor's font picker.

libass (inside ffmpeg) finds installed fonts by family name on its own
(DirectWrite on Windows, fontconfig elsewhere), so burning needs nothing but
the name. This module lists the families, with which faces exist (bold,
italic) and whether they can write Cyrillic, and finds a family's file for
the caption width estimate (subtitles.fit_scale).

The scan reads the name/OS-2/cmap tables of every file (several seconds for a
few hundred fonts), so its result is kept in font_catalog.json next to the
settings and redone only when a font folder changes (a font installed).
"""
import json
import os
import sys
import threading

_FONTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
_EXTS = (".ttf", ".otf", ".ttc")
_lock = threading.Lock()
_catalog = None   # {family_lower: {"family", "faces": {(bold, italic): path}, "cyrillic"}}


def _font_dirs():
    dirs = [_FONTS_DIR]
    if sys.platform == "win32":
        dirs.append(os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts"))
        local = os.environ.get("LOCALAPPDATA")
        if local:
            dirs.append(os.path.join(local, "Microsoft", "Windows", "Fonts"))
    elif sys.platform == "darwin":
        dirs += ["/System/Library/Fonts", "/Library/Fonts", os.path.expanduser("~/Library/Fonts")]
    else:
        dirs += ["/usr/share/fonts", "/usr/local/share/fonts",
                 os.path.expanduser("~/.local/share/fonts"), os.path.expanduser("~/.fonts")]
    return [d for d in dirs if os.path.isdir(d)]


def _name(font, *ids):
    table = font["name"]
    for nid in ids:
        rec = table.getName(nid, 3, 1, 0x409) or table.getName(nid, 1, 0, 0)
        if rec is None:
            for r in table.names:
                if r.nameID == nid:
                    rec = r
                    break
        if rec is not None:
            try:
                text = rec.toUnicode().strip()
            except Exception:
                continue
            if text:
                return text
    return None


def _scan_file(path, out):
    from fontTools.ttLib import TTFont, TTCollection
    fonts = []
    try:
        if path.lower().endswith(".ttc"):
            fonts = list(TTCollection(path, lazy=True).fonts)
        else:
            fonts = [TTFont(path, lazy=True)]
    except Exception:
        return
    for font in fonts:
        try:
            # Typographic family (16) groups "Arial Black" style names under
            # their real family; libass matches on the legacy family (1).
            family = _name(font, 1)
            if not family or family.startswith((".", "#")):
                continue
            os2 = font["OS/2"] if "OS/2" in font else None
            sel = os2.fsSelection if os2 is not None else 0
            weight = os2.usWeightClass if os2 is not None else 400
            bold = bool(sel & 0x20) or weight >= 600
            italic = bool(sel & 0x01)
            cmap = font.getBestCmap() or {}
            entry = out.setdefault(family.lower(), {"family": family, "faces": {}, "cyrillic": False})
            entry["faces"].setdefault((bold, italic), path)
            entry["cyrillic"] = entry["cyrillic"] or (0x0416 in cmap and 0x0456 in cmap)   # Ж, і
        except Exception:
            continue


def _cache_path():
    base = os.environ.get("LOCAL_SETTINGS_PATH") or os.environ.get("LLM_SPEND_PATH")
    folder = os.path.dirname(base) if base else os.path.dirname(os.path.abspath(__file__))
    return os.path.join(folder or ".", "font_catalog.json")


def _signature(dirs):
    sig = []
    for d in dirs:
        try:
            sig.append([d, os.path.getmtime(d)])
        except OSError:
            pass
    return sig


def catalog():
    global _catalog
    with _lock:
        if _catalog is not None:
            return _catalog
        dirs = _font_dirs()
        sig = _signature(dirs)
        try:
            with open(_cache_path(), encoding="utf-8") as f:
                cached = json.load(f)
            if cached.get("signature") == sig:
                _catalog = {k: {**v, "faces": {(f2[0], f2[1]): f2[2] for f2 in v["faces"]}}
                            for k, v in cached["families"].items()}
                return _catalog
        except (OSError, ValueError, KeyError, TypeError):
            pass
        out = {}
        for d in dirs:
            for root, _dirs, files in os.walk(d):
                for f in files:
                    if f.lower().endswith(_EXTS):
                        _scan_file(os.path.join(root, f), out)
        _catalog = out
        try:
            with open(_cache_path(), "w", encoding="utf-8") as f:
                json.dump({"signature": sig, "families": {
                    k: {**v, "faces": [[b, i, p] for (b, i), p in v["faces"].items()]}
                    for k, v in out.items()}}, f)
        except OSError:
            pass
        return out


def families():
    """[{family, bold, italic, cyrillic}] sorted by name, for the font picker."""
    items = []
    for e in catalog().values():
        faces = e["faces"]
        items.append({
            "family": e["family"],
            "regular": (False, False) in faces,
            "bold": any(b for b, _ in faces),
            "italic": any(i for _, i in faces),
            "cyrillic": e["cyrillic"],
        })
    items.sort(key=lambda x: x["family"].lower())
    return items


def find(family, bold=True, italic=False):
    """Path of the closest face of ``family``, or None when not installed."""
    e = catalog().get(str(family or "").strip().lower())
    if not e:
        return None
    faces = e["faces"]
    for key in ((bold, italic), (bold, False), (False, italic), (False, False), (True, False)):
        if key in faces:
            return faces[key]
    return next(iter(faces.values()), None)
