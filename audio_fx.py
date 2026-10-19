"""Audio repair for clips: find clipping, run an effect chain, remux.

The chain is a list of steps, run top to bottom:
  {"type": "builtin", "name": "compressor", "params": {...}, "enabled": true}
  {"type": "plugin", "path": ".../RX 11 De-clip.vst3", "params": {...}}
Built-ins are pedalboard's own effects plus two ffmpeg/meter steps (declip,
loudness). Plugins are the VST3 (and, on macOS, AU) plugins installed on this
computer, hosted by pedalboard; only paths found by ``scan_plugins`` load.

Plugins are native code: anything that loads one (``plugin_params``,
``render``) runs in a child process (``python audio_fx.py <command>``) so a
plugin that crashes takes that process down, not the API.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

import numpy as np

SAMPLE_RATE = 48000
CLIP_LEVEL = 0.98          # |sample| at or above this counts as clipped
CLIP_RUN = 3               # ...when that many samples in a row sit there
REGION_GAP = 0.3           # clipped runs closer than this (s) form one region
MIN_REGION_SAMPLES = 24    # fewer hot samples than this in a region: a click
BINS = 80                  # amplitude histogram (clip_level)
BUMP_RATIO = 1.3           # a bin this much above the lowest one below it...
MIN_PILE = 0.0005          # ...holding at least this share of all samples

# Built-in steps: label, params [(name, label, min, max, default, step, unit)].
BUILTINS = {
    "declip": ("De-clip (ffmpeg)", []),   # any position; usually first
    "highpass": ("High-pass", [("cutoff_frequency_hz", "cutoff", 20, 400, 80, 1, "Hz")]),
    "noisegate": ("Noise gate", [("threshold_db", "threshold", -90, 0, -50, 1, "dB"),
                                 ("ratio", "ratio", 1, 20, 4, 0.5, ":1"),
                                 ("release_ms", "release", 10, 1000, 150, 10, "ms")]),
    "peak": ("EQ band", [("cutoff_frequency_hz", "frequency", 40, 16000, 3000, 10, "Hz"),
                         ("gain_db", "gain", -18, 18, 0, 0.5, "dB"),
                         ("q", "Q", 0.1, 10, 1, 0.1, "")]),
    "compressor": ("Compressor", [("threshold_db", "threshold", -60, 0, -18, 0.5, "dB"),
                                  ("ratio", "ratio", 1, 20, 3, 0.5, ":1"),
                                  ("attack_ms", "attack", 0.1, 100, 5, 0.1, "ms"),
                                  ("release_ms", "release", 10, 1000, 120, 10, "ms")]),
    "gain": ("Gain", [("gain_db", "gain", -24, 24, 0, 0.5, "dB")]),
    "limiter": ("Limiter", [("threshold_db", "ceiling", -12, 0, -1, 0.1, "dB"),
                            ("release_ms", "release", 10, 500, 80, 5, "ms")]),
    "loudness": ("Loudness target", [("target_lufs", "target", -24, -8, -14, 0.5, "LUFS"),
                                     ("ceiling_db", "true peak", -3, 0, -1, 0.1, "dB")]),
}

# The one-click fix offered when clipping is found.
SUGGESTED_CHAIN = [
    {"type": "builtin", "name": "declip", "params": {}, "enabled": True},
    {"type": "builtin", "name": "compressor",
     "params": {"threshold_db": -18, "ratio": 3, "attack_ms": 5, "release_ms": 120}, "enabled": True},
    {"type": "builtin", "name": "loudness", "params": {"target_lufs": -14, "ceiling_db": -1}, "enabled": True},
]


def builtin_specs():
    return [{"name": k, "label": label,
             "params": [dict(zip(("name", "label", "min", "max", "default", "step", "unit"), p))
                        for p in params]}
            for k, (label, params) in BUILTINS.items()]


# --- plugins on this computer -------------------------------------------------

def _plugin_dirs():
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        common = os.environ.get("COMMONPROGRAMFILES", r"C:\Program Files\Common Files")
        return [os.path.join(common, "VST3"),
                os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Common", "VST3")]
    if sys.platform == "darwin":
        return ["/Library/Audio/Plug-Ins/VST3", f"{home}/Library/Audio/Plug-Ins/VST3",
                "/Library/Audio/Plug-Ins/Components", f"{home}/Library/Audio/Plug-Ins/Components"]
    return [f"{home}/.vst3", "/usr/lib/vst3", "/usr/local/lib/vst3"]


def scan_plugins():
    """[{name, path, format}] of the plugin bundles installed here. A .vst3
    bundle is a folder on macOS/Linux (and often on Windows), so the walk
    stops at it instead of descending."""
    found = []
    for root in _plugin_dirs():
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            for name in list(dirnames) + filenames:
                low = name.lower()
                fmt = "VST3" if low.endswith(".vst3") else "AU" if low.endswith(".component") else None
                if fmt:
                    found.append({"name": os.path.splitext(name)[0],
                                  "path": os.path.join(dirpath, name), "format": fmt})
            dirnames[:] = [d for d in dirnames if not d.lower().endswith((".vst3", ".component"))]
    seen, out = set(), []
    for p in sorted(found, key=lambda p: p["name"].lower()):
        if p["path"] not in seen:
            seen.add(p["path"])
            out.append(p)
    return out


def is_known_plugin(path):
    norm = os.path.normcase(os.path.abspath(path or ""))
    return any(os.path.normcase(os.path.abspath(p["path"])) == norm for p in scan_plugins())


def _describe_param(name, p):
    try:
        text = p.string_value
    except Exception:
        text = ""
    valid = getattr(p, "valid_values", None) or []
    lo, hi = getattr(p, "min_value", None), getattr(p, "max_value", None)
    if isinstance(lo, bool) or (len(valid) == 2 and isinstance(lo, bool)):
        return {"name": name, "kind": "bool", "value": text.lower() in ("on", "true", "1", "yes")}
    if isinstance(lo, (int, float)) and isinstance(hi, (int, float)):
        try:
            value = float(re.findall(r"-?\d+(?:\.\d+)?", text)[0])
        except (IndexError, ValueError):
            value = lo
        return {"name": name, "kind": "float", "min": lo, "max": hi, "value": value,
                "unit": getattr(p, "units", "") or ""}
    if valid:
        return {"name": name, "kind": "choice", "choices": [str(v) for v in valid], "value": text}
    return None


def _load(path):
    import pedalboard
    return pedalboard.load_plugin(path)


def _set_params(plugin, params):
    for k, v in (params or {}).items():
        try:
            setattr(plugin, k, v)
        except Exception as e:
            print(f"audio_fx: {k}={v!r} not set: {e}", file=sys.stderr)


def _plugin_params_inproc(path):
    plugin = _load(path)
    out = [d for d in (_describe_param(k, p) for k, p in plugin.parameters.items()) if d]
    return {"name": getattr(plugin, "name", os.path.basename(path)), "params": out}


# --- audio in and out ---------------------------------------------------------

def _ffmpeg():
    return os.environ.get("FFMPEG_BINARY") or "ffmpeg"


def decode(path):
    """Float32 (channels, samples) at SAMPLE_RATE, stereo."""
    cmd = [_ffmpeg(), "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", str(SAMPLE_RATE),
           "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def encode_wav(audio, path):
    data = np.clip(audio, -1.0, 1.0).T.astype(np.float32).tobytes()
    subprocess.run([_ffmpeg(), "-v", "error", "-y", "-f", "f32le", "-ar", str(SAMPLE_RATE),
                    "-ac", "2", "-i", "-", "-c:a", "pcm_s16le", path],
                   input=data, check=True)


def ffmpeg_filter(audio, af):
    """Run float audio through an ffmpeg filter graph and back."""
    r = subprocess.run([_ffmpeg(), "-v", "error", "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2",
                        "-i", "-", "-af", af, "-f", "f32le", "-ar", str(SAMPLE_RATE), "-ac", "2", "-"],
                       input=audio.T.astype(np.float32).tobytes(), capture_output=True, check=True)
    out = np.frombuffer(r.stdout, dtype=np.float32).reshape(-1, 2).T.copy()
    return out[:, :audio.shape[1]]


def limit(audio, ceiling_db=-1.0, release_ms=60):
    """A real ceiling: ffmpeg's lookahead alimiter, no makeup gain
    (pedalboard's Limiter normalises its threshold up to 0 dBFS)."""
    lim = 10 ** (float(ceiling_db) / 20)
    rel = max(1, min(8000, float(release_ms)))
    return ffmpeg_filter(audio, f"alimiter=limit={lim:.5f}:level=disabled:attack=5:release={rel:g}:asc=1")


def loudness_lufs(audio):
    """Integrated loudness (EBU R128) via ffmpeg's ebur128 meter."""
    data = audio.T.astype(np.float32).tobytes()
    r = subprocess.run([_ffmpeg(), "-v", "info", "-nostats", "-f", "f32le", "-ar", str(SAMPLE_RATE),
                        "-ac", "2", "-i", "-", "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
                       input=data, capture_output=True)
    m = re.findall(r"I:\s*(-?[\d.]+|-inf)\s*LUFS", r.stderr.decode("utf-8", "ignore"))
    try:
        return float(m[-1])
    except (IndexError, ValueError):
        return None


def clip_level(a):
    """The amplitude a recording was clipped at, or None.

    Clipping piles samples up at one level, so the amplitude histogram, which
    falls steadily for clean speech, rises into a bump there. That survives
    the loudness normalisation the clip got afterwards (the bump just sits
    lower than full scale) and the AAC encode (which ripples the flat tops
    and overshoots them, so the measured peak lies above the bump)."""
    pk = float(a.max()) if a.size else 0.0
    if pk <= 0:
        return None
    h, edges = np.histogram(a, bins=BINS, range=(0, pk))
    h = np.convolve(h, [0.25, 0.5, 0.25], mode="same")
    lo = int(BINS * 0.3)
    best, at, floor = 1.0, None, h[lo]
    for i in range(lo + 1, BINS):
        floor = min(floor, h[i - 1])
        if h[i] >= MIN_PILE * a.size and h[i] / max(floor, 1.0) > best:
            best, at = h[i] / max(floor, 1.0), i
    if at is None or best < BUMP_RATIO:
        return None
    return float((edges[at] + edges[at + 1]) / 2)


def analyze_audio(audio):
    """Clipping regions [{start, end, samples}], the clip level, peak dBFS
    and loudness."""
    amp = np.abs(audio).max(axis=0)
    level = clip_level(amp)
    if level is not None:
        hot, run = amp >= level * 0.93, 1
    else:   # no pile-up: only flat tops at full scale count
        hot, run = amp >= CLIP_LEVEL, CLIP_RUN
    regions = []
    if hot.any():
        edges = np.diff(np.concatenate(([0], hot.astype(np.int8), [0])))
        starts, ends = np.where(edges == 1)[0], np.where(edges == -1)[0]
        keep = (ends - starts) >= run
        for s, e in zip(starts[keep], ends[keep]):
            t0, t1 = s / SAMPLE_RATE, e / SAMPLE_RATE
            if regions and t0 - regions[-1]["end"] <= REGION_GAP:
                regions[-1]["end"] = t1
                regions[-1]["samples"] += int(e - s)
            else:
                regions.append({"start": t0, "end": t1, "samples": int(e - s)})
    # A lone hot sample is a click, not distortion.
    regions = [r for r in regions if r["samples"] >= MIN_REGION_SAMPLES]
    for r in regions:
        r["start"], r["end"] = round(r["start"], 3), round(max(r["end"], r["start"] + 0.05), 3)
    peak = float(amp.max()) if amp.size else 0.0
    return {
        "duration": round(audio.shape[1] / SAMPLE_RATE, 3),
        "peak_db": round(float(20 * np.log10(peak)), 2) if peak > 0 else None,
        "clip_level_db": round(float(20 * np.log10(level)), 2) if level else None,
        "lufs": loudness_lufs(audio),
        "clipped_samples": int(sum(r["samples"] for r in regions)),
        "regions": regions,
        "clipping": len(regions) > 0,
    }


def analyze(path):
    return analyze_audio(decode(path))


# --- the chain ----------------------------------------------------------------

def _builtin(name, params):
    import pedalboard as pb
    p = {k: float(v) for k, v in (params or {}).items()}
    if name == "highpass":
        return pb.HighpassFilter(cutoff_frequency_hz=p.get("cutoff_frequency_hz", 80))
    if name == "noisegate":
        return pb.NoiseGate(threshold_db=p.get("threshold_db", -50), ratio=p.get("ratio", 4),
                            release_ms=p.get("release_ms", 150))
    if name == "peak":
        return pb.PeakFilter(cutoff_frequency_hz=p.get("cutoff_frequency_hz", 3000),
                             gain_db=p.get("gain_db", 0), q=p.get("q", 1))
    if name == "compressor":
        return pb.Compressor(threshold_db=p.get("threshold_db", -18), ratio=p.get("ratio", 3),
                             attack_ms=p.get("attack_ms", 5), release_ms=p.get("release_ms", 120))
    if name == "gain":
        return pb.Gain(gain_db=p.get("gain_db", 0))
    raise ValueError(f"unknown effect {name}")


def _render_inproc(src, chain, out_wav):
    import pedalboard as pb
    steps = [s for s in chain or [] if s.get("enabled", True)]
    audio = decode(src)
    # De-clippers look for flat tops near full scale; a clip that was
    # normalised after clipping has them lower. Lift the clip level to -1 dBFS
    # around every de-clip step, then back down.
    level = clip_level(np.abs(audio).max(axis=0))
    lift = max(0.0, -1.0 - 20 * np.log10(level)) if level else 0.0
    for s in steps:
        is_declip = (s.get("name") == "declip" if s.get("type") == "builtin"
                     else bool(re.search(r"de-?clip", s.get("name") or os.path.basename(s.get("path") or ""), re.I)))
        if is_declip and lift:
            audio = audio * np.float32(10 ** (lift / 20))
        if s.get("type") == "plugin":
            if not is_known_plugin(s.get("path")):
                raise ValueError(f"not an installed plugin: {s.get('path')}")
            plugin = _load(s["path"])
            params = dict(s.get("params") or {})
            if is_declip and "post_limiter" in plugin.parameters and "post_limiter" not in params:
                # RX's post-limiter flattens the peaks it just rebuilt into a
                # new plateau; the chain's own loudness step limits later.
                params["post_limiter"] = False
            _set_params(plugin, params)
            audio = plugin(audio, SAMPLE_RATE)
        elif s.get("name") == "declip":
            audio = ffmpeg_filter(audio, "adeclip")
        elif s.get("name") == "limiter":
            p = s.get("params") or {}
            audio = limit(audio, p.get("threshold_db", -1), p.get("release_ms", 80))
        elif s.get("name") == "loudness":
            # Gain to the target, limit, then once more: the limiter takes a
            # little loudness back off the peaks.
            p = s.get("params") or {}
            target, ceiling = float(p.get("target_lufs", -14)), float(p.get("ceiling_db", -1))
            for _ in range(2):
                now = loudness_lufs(audio)
                if now is None or abs(target - now) < 0.3:
                    break
                audio = pb.Gain(gain_db=target - now)(audio, SAMPLE_RATE)
                audio = limit(audio, ceiling)
        else:
            audio = _builtin(s["name"], s.get("params"))(audio, SAMPLE_RATE)
        if is_declip and lift:
            audio = np.asarray(audio, dtype=np.float32) * np.float32(10 ** (-lift / 20))
    audio = np.asarray(audio, dtype=np.float32)
    encode_wav(audio, out_wav)
    return analyze_audio(audio)


def remux(video_path, wav_path, out_path):
    """The video stream untouched, the processed audio in place of the old."""
    subprocess.run([_ffmpeg(), "-v", "error", "-y", "-i", video_path, "-i", wav_path,
                    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                    "-shortest", "-movflags", "+faststart", out_path], check=True)


# --- child-process entry points ---------------------------------------------

def _child(command, payload, timeout):
    r = subprocess.run([sys.executable, os.path.abspath(__file__), command],
                       input=json.dumps(payload).encode(), capture_output=True, timeout=timeout)
    if r.returncode != 0:
        tail = r.stderr.decode("utf-8", "ignore").strip().splitlines()[-3:]
        raise RuntimeError("audio processing failed (exit %s): %s" % (r.returncode, " | ".join(tail)))
    return json.loads(r.stdout.decode("utf-8").strip().splitlines()[-1])


def plugin_params(path):
    if not is_known_plugin(path):
        raise ValueError("not an installed plugin")
    return _child("params", {"path": path}, timeout=120)


def render(src, chain, out_wav):
    """Run ``chain`` over the audio of ``src`` into ``out_wav``; returns the
    analysis of the result."""
    return _child("render", {"src": src, "chain": chain, "out": out_wav}, timeout=900)


def apply_to_video(src, chain, out_path):
    fd, wav = tempfile.mkstemp(suffix=".wav", dir=os.path.dirname(out_path))
    os.close(fd)
    try:
        result = render(src, chain, wav)
        remux(src, wav, out_path)
        return result
    finally:
        try:
            os.remove(wav)
        except OSError:
            pass


if __name__ == "__main__":
    cmd = sys.argv[1]
    req = json.loads(sys.stdin.read() or "{}")
    if cmd == "params":
        res = _plugin_params_inproc(req["path"])
    elif cmd == "render":
        res = _render_inproc(req["src"], req["chain"], req["out"])
    else:
        sys.exit(f"unknown command {cmd}")
    sys.stdout.write("\n" + json.dumps(res) + "\n")
