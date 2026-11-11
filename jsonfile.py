"""Atomic JSON writes for files that other requests read while they change."""
import json
import os
import tempfile
import time


def write_json_atomic(path, data, **dump_kwargs):
    """Write JSON to a same-directory temporary file, then replace the target."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(
        dir=directory,
        prefix=f".{os.path.basename(path)}.",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, **dump_kwargs)
        try:
            mode = os.stat(path).st_mode & 0o777
        except FileNotFoundError:
            mode = 0o644
        os.chmod(tmp, mode)
        # Windows refuses to replace a file another handle has open (a
        # dashboard request reading it this instant): retry briefly.
        for attempt in range(40):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(0.05)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
