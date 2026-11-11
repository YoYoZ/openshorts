import punctuation


def _words(tokens, duration=2):
    return [{"word": token, "start": i * duration, "end": (i + 1) * duration}
            for i, token in enumerate(tokens)]


def test_find_dry_runs():
    words = _words(["one", "two", "three.", "four", "five", "six", "seven."], 5)
    assert punctuation.find_dry_runs(words, min_seconds=10) == [(0, 2), (3, 6)]


def _transcript():
    return {"language": "en", "segments": [{"text": " hello world", "words": [
        {"word": " hello", "start": 0, "end": 11},
        {"word": " world", "start": 11, "end": 22},
    ]}]}


def test_restore_applies_valid_words(monkeypatch):
    monkeypatch.setattr(punctuation.llm_backend, "available", lambda: True)
    monkeypatch.setattr(punctuation.llm_backend, "generate_json",
                        lambda *a, **k: ({"words": [" Hello", " world."]}, None))
    transcript, report = punctuation.restore(_transcript(), "en")
    assert [w["word"] for w in transcript["segments"][0]["words"]] == [" Hello", " world."]
    assert transcript["segments"][0]["text"] == "Hello world."
    assert report == {"runs": 1, "fixed": 1, "words_changed": 2}


def test_restore_rejects_changed_word_and_count(monkeypatch):
    monkeypatch.setattr(punctuation.llm_backend, "available", lambda: True)
    original = _transcript()
    for result in ([" Hello", " earth."], [" Hello"]):
        monkeypatch.setattr(punctuation.llm_backend, "generate_json",
                            lambda *a, _r=result, **k: ({"words": _r}, None))
        transcript, report = punctuation.restore(original, "en")
        assert transcript == original
        assert report["words_changed"] == 0


def test_restore_exception_returns_unchanged(monkeypatch):
    monkeypatch.setattr(punctuation.llm_backend, "available", lambda: True)
    original = _transcript()
    def fail(*args, **kwargs):
        raise RuntimeError("offline")
    monkeypatch.setattr(punctuation.llm_backend, "generate_json", fail)
    transcript, report = punctuation.restore(original, "en")
    assert transcript == original
    assert report["words_changed"] == 0
