"""Progress of clip re-renders (subtitles, hook, recut, edit) inside the API.

An endpoint marks what it is doing with ``op(job_id, clip_index, kind)``; the
ffmpeg calls on those paths go through ``run()``, which adds ``-progress`` and
turns ffmpeg's out_time into a percentage for every op open on that job (the
job id is read from the output path, output/<job_id>/...). The dashboard polls
``snapshot(job_id)`` through /api/clip-ops/{job_id}.
"""
import contextlib
import re
import subprocess
import threading
import time

_lock = threading.Lock()
_recent = []   # finished ops, newest last (for the queue panel)
_ops = {}   # job_id -> {clip_index: {kind, started, pct, step, detail}}

_JOB_IN_PATH = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


@contextlib.contextmanager
def op(job_id, clip_index, kind):
    """Mark clip ``clip_index`` of ``job_id`` as being re-rendered."""
    with _lock:
        _ops.setdefault(job_id, {})[clip_index] = {
            "kind": kind, "started": time.time(), "pct": None, "step": 0, "detail": kind}
    ok = False
    try:
        yield
        ok = True
    finally:
        with _lock:
            job_ops = _ops.get(job_id, {})
            entry = job_ops.pop(clip_index, None)
            if not job_ops:
                _ops.pop(job_id, None)
            if entry:
                _recent.append({"job_id": job_id, "clip_index": clip_index, "kind": kind,
                                "ok": ok, "finished": time.time(),
                                "seconds": round(time.time() - entry["started"], 1)})
                del _recent[:-30]


def snapshot(job_id):
    with _lock:
        return {str(k): dict(v) for k, v in _ops.get(job_id, {}).items()}


def snapshot_all():
    """Every re-render in flight, plus the last finished ones (newest last)."""
    with _lock:
        running = [{"job_id": j, "clip_index": k, **dict(v)}
                   for j, ops in _ops.items() for k, v in ops.items()]
        return running, [dict(r) for r in _recent]


def _update(job_id, **fields):
    with _lock:
        for entry in _ops.get(job_id, {}).values():
            entry.update(fields)


def _seconds(value):
    try:
        if ":" in str(value):
            parts = [float(p) for p in str(value).split(":")]
            total = 0.0
            for p in parts:
                total = total * 60 + p
            return total
        return float(value)
    except (TypeError, ValueError):
        return None


def _expected_duration(cmd):
    """Output duration of an ffmpeg command: -t, or -to minus -ss, else the
    first input's length."""
    args = list(cmd)
    ss = to = t = None
    for i, a in enumerate(args[:-1]):
        if a == "-ss" and ss is None:
            ss = _seconds(args[i + 1])
        elif a == "-to" and to is None:
            to = _seconds(args[i + 1])
        elif a == "-t" and t is None:
            t = _seconds(args[i + 1])
    if t:
        return t
    if to is not None:
        return max(0.1, to - (ss or 0))
    if "-i" in args:
        src = args[args.index("-i") + 1]
        try:
            out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                  "-of", "csv=p=0", src], capture_output=True, text=True, timeout=10)
            return float(out.stdout.strip())
        except Exception:
            return None
    return None


def run(cmd, **kwargs):
    """subprocess.run for an ffmpeg command, reporting its progress to the ops
    open on the job its output belongs to. Same return/raise contract as
    subprocess.run for the arguments these call sites use."""
    import os
    args = ([os.fsdecode(a) if isinstance(a, bytes) else str(a) for a in cmd]
            if not isinstance(cmd, (bytes, str)) else cmd)
    if isinstance(args, (bytes, str)) or not args or "ffmpeg" not in args[0]:
        return subprocess.run(cmd, **kwargs)
    match = _JOB_IN_PATH.search(args[-1]) or _JOB_IN_PATH.search(" ".join(args))
    job_id = match.group(0) if match else None
    with _lock:
        tracked = bool(job_id and _ops.get(job_id))
    if not tracked:
        return subprocess.run(cmd, **kwargs)

    check = kwargs.pop("check", False)
    timeout = kwargs.pop("timeout", None)
    text = kwargs.pop("text", False) or kwargs.pop("universal_newlines", False)
    kwargs.pop("capture_output", None)
    kwargs.pop("stdout", None)
    stderr_target = kwargs.pop("stderr", subprocess.PIPE)
    errors = kwargs.pop("errors", None)

    duration = _expected_duration(args)
    # A re-render can be several ffmpeg passes (cut, burn, mux): count them so
    # the UI can say "pass 2" instead of a bar that silently restarts.
    with _lock:
        for entry in _ops.get(job_id, {}).values():
            entry["step"] = (entry.get("step") or 0) + 1
            entry["pct"] = 0.0
    full = [args[0], "-progress", "pipe:1", "-nostats", *args[1:]]
    proc = subprocess.Popen(full, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE if stderr_target is not subprocess.DEVNULL
                            else subprocess.DEVNULL, **kwargs)
    err_chunks = []
    if proc.stderr is not None:
        reader = threading.Thread(target=lambda: err_chunks.append(proc.stderr.read()), daemon=True)
        reader.start()
    else:
        reader = None
    started = time.time()
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if line.startswith("out_time_us=") and duration:
            try:
                done = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            if done < 0:   # ffmpeg reports a sentinel before the first frame
                continue
            _update(job_id, pct=round(min(99.0, done / duration * 100), 1))
        if timeout and time.time() - started > timeout:
            proc.kill()
            raise subprocess.TimeoutExpired(full, timeout)
    proc.wait()
    if proc.returncode == 0:
        _update(job_id, pct=100.0)
    if reader:
        reader.join(timeout=5)
    err = b"".join(c for c in err_chunks if c)
    if text:
        err = err.decode("utf-8", errors or "replace")
    result = subprocess.CompletedProcess(full, proc.returncode, stdout=None if not text else "",
                                         stderr=err if stderr_target is not subprocess.DEVNULL else None)
    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, full, output=None, stderr=result.stderr)
    return result
