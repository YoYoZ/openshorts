"""Machine-readable progress from the job process to the API.

main.py runs as a child process whose stdout the API reads line by line
(app.enqueue_output). A line starting with ``PROGRESS `` carries one JSON
object and is consumed there into ``job['progress']`` instead of the log, so
the dashboard can draw real progress bars without scraping log text.

Stages: download, transcribe, select, render. Each event may carry
``pct`` (0-100), ``detail`` (short human text), ``done`` / ``total`` counts.
"""
import json
import threading
import time

_lock = threading.Lock()
_last = {}   # stage -> (time, pct) of the last event sent, for throttling


def emit(stage, pct=None, detail=None, force=False, **extra):
    """Send one progress event; same-stage events are throttled to ~4/s
    unless the percentage moved by at least 1 or ``force`` is set."""
    now = time.time()
    with _lock:
        prev = _last.get(stage)
        if not force and prev and pct is not None:
            if now - prev[0] < 0.25 and abs(pct - (prev[1] or 0)) < 1:
                return
        _last[stage] = (now, pct)
    event = {"stage": stage}
    if pct is not None:
        event["pct"] = round(max(0.0, min(100.0, float(pct))), 1)
    if detail is not None:
        event["detail"] = str(detail)
    event.update(extra)
    print("PROGRESS " + json.dumps(event, ensure_ascii=False), flush=True)


_counts = {}


def tick(stage, total, detail=None):
    """Count one finished unit of ``stage`` (e.g. a rendered clip) and emit
    done/total. Safe to call from parallel workers."""
    with _lock:
        _counts[stage] = _counts.get(stage, 0) + 1
        done = _counts[stage]
    emit(stage, done / max(1, total) * 100, detail=detail, force=True,
         done=done, total=total)
