import punctuation


def _words(tokens, duration=2):
    return [{"word": token, "start": i * duration, "end": (i + 1) * duration}
            for i, token in enumerate(tokens)]


def test_find_dry_runs():
    words = _words(["one", "two", "three.", "four", "five", "six", "seven."], 5)
    assert punctuation.find_dry_runs(words, min_seconds=10) == [(0, 2), (3, 6)]


def _transcript(tokens=(" hello", " world")):
    words = [{"word": t, "start": i * 11, "end": (i + 1) * 11} for i, t in enumerate(tokens)]
    return {"language": "en", "segments": [{"text": "".join(tokens).strip(), "words": words}]}


def _answer(monkeypatch, text):
    monkeypatch.setattr(punctuation.llm_backend, "available", lambda: True)
    monkeypatch.setattr(punctuation.llm_backend, "generate_json",
                        lambda *a, **k: ({"text": text}, None))


def test_restore_applies_punctuation_and_keeps_leading_spaces(monkeypatch):
    _answer(monkeypatch, "Hello world.")
    transcript, report = punctuation.restore(_transcript(), "en")
    assert [w["word"] for w in transcript["segments"][0]["words"]] == [" Hello", " world."]
    assert transcript["segments"][0]["text"] == "Hello world."
    assert report == {"runs": 1, "fixed": 1, "words_changed": 2}


def test_restore_tolerates_a_changed_word_by_aligning(monkeypatch):
    # 10 words, the model rewrites one: 9/10 align (>= MIN_MATCH), that word stays as it was.
    tokens = [f" w{i}" for i in range(10)]
    answer = " ".join(["W0,"] + [f"w{i}" for i in range(1, 9)] + ["CHANGED."])
    _answer(monkeypatch, answer)
    transcript, _ = punctuation.restore(_transcript(tokens), "en")
    words = [w["word"] for w in transcript["segments"][0]["words"]]
    assert words[0] == " W0,"
    assert words[9] == " w9"          # the changed word is not taken over


def test_restore_rejects_a_mostly_different_answer(monkeypatch):
    _answer(monkeypatch, "Something else entirely.")
    original = _transcript()
    transcript, report = punctuation.restore(original, "en")
    assert transcript == _transcript()
    assert report["words_changed"] == 0


def test_restore_exception_returns_unchanged(monkeypatch):
    monkeypatch.setattr(punctuation.llm_backend, "available", lambda: True)
    def fail(*args, **kwargs):
        raise RuntimeError("offline")
    monkeypatch.setattr(punctuation.llm_backend, "generate_json", fail)
    transcript, report = punctuation.restore(_transcript(), "en")
    assert transcript == _transcript()
    assert report["words_changed"] == 0
