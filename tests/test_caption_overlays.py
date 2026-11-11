import asyncio
import io

import pytest

import app
from caption_overlays import build_concat_list, overlay_is_valid, stable_hash


def test_concat_builder_fills_gaps_and_bounds(monkeypatch):
    class KeptStringIO(io.StringIO):
        def close(self):
            pass

    written = KeptStringIO()
    monkeypatch.setattr("caption_overlays.os.path.exists", lambda _path: True)
    monkeypatch.setattr("builtins.open", lambda *_a, **_k: written)
    frames = [{"start": 1, "end": 2, "name": "frame_0.png"}]
    build_concat_list(frames, 3, ".", "list.txt")
    contents = written.getvalue()
    assert contents.count("file '") == 4  # blank gap, frame, blank tail, concat repeat
    assert "duration 1.000000" in contents
    assert "transparent.png" in contents


def test_overlay_validity_checks_recipe_style_dir_and_split():
    clip = {"recipe": {"segments": [{"start": 1, "end": 3}]}, "caption_style": {"font_size": 44}}
    overlay = {"dir": ".", "recipe": clip["recipe"]["segments"],
               "caption_style_hash": stable_hash(clip["caption_style"])}
    assert overlay_is_valid(overlay, clip)
    assert not overlay_is_valid(overlay, clip, [(0, 1)])
    assert not overlay_is_valid(overlay, {**clip, "recipe": {"segments": []}})
    assert not overlay_is_valid(overlay, {**clip, "caption_style": {"font_size": 56}})


def test_caption_frame_endpoint_rejects_invalid_metadata(monkeypatch):
    monkeypatch.setattr(app, "_ensure_job_files", lambda *_: asyncio.sleep(0, result=True))
    monkeypatch.setattr(app, "_assert_job_owner", lambda *_: asyncio.sleep(0))
    monkeypatch.setitem(app.jobs, "frame-validation-test", {})
    with pytest.raises(app.HTTPException) as exc:
        asyncio.run(app.upload_caption_frames("frame-validation-test", 0, None, "{}", []))
    assert exc.value.status_code == 400
    app.jobs.pop("frame-validation-test", None)
