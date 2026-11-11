"""Restore punctuation in long unpunctuated stretches of a transcript."""
import logging
import re
import copy
from typing import List

from pydantic import BaseModel

import llm_backend

log = logging.getLogger(__name__)
_SENTENCE_END = re.compile(r"[.!?…][\"'»”’)]*$")
_STRIP = re.compile(r"[^\w]+", re.UNICODE)


class _WordsResponse(BaseModel):
    words: List[str]


def find_dry_runs(words, min_seconds=20):
    """Return [start, end) word-index ranges containing no sentence stops."""
    runs, start = [], 0
    for i, item in enumerate(words):
        if _SENTENCE_END.search((item.get("word") or "").rstrip()):
            if start < i and words[i - 1].get("end", 0) - words[start].get("start", 0) >= min_seconds:
                runs.append((start, i))
            start = i + 1
    if start < len(words) and words[-1].get("end", 0) - words[start].get("start", 0) >= min_seconds:
        runs.append((start, len(words)))
    return runs


def _normalize(word):
    return _STRIP.sub("", word or "").casefold()


def restore(transcript, language):
    """Restore dry-run punctuation. Never raises; returns (transcript, report)."""
    report = {"runs": 0, "fixed": 0, "words_changed": 0}
    try:
        if not llm_backend.available() or not transcript:
            return transcript, report
        working = copy.deepcopy(transcript)
        flat = []
        for si, segment in enumerate(working.get("segments", [])):
            for wi, word in enumerate(segment.get("words", [])):
                flat.append((si, wi, word))
        ranges = find_dry_runs([x[2] for x in flat])
        report["runs"] = len(ranges)
        for a, b in ranges:
            for chunk_start in range(a, b, 600):
                chunk_end = min(b, chunk_start + 600)
                entries = flat[chunk_start:chunk_end]
                source = [x[2].get("word", "") for x in entries]
                prompt = (f"Add natural punctuation and sentence capitalization to these {language or 'unknown-language'} transcript words. "
                          "Return exactly the same words in the same order, changing only punctuation and capitalization. "
                          "Preserve leading spaces. Each array item corresponds to one input word.\n" + repr(source))
                parsed, _ = llm_backend.generate_json(prompt, _WordsResponse, tier="simple")
                result = parsed.get("words") if isinstance(parsed, dict) else None
                if not isinstance(result, list) or len(result) != len(source) or any(_normalize(x) != _normalize(y) for x, y in zip(source, result)):
                    continue
                changed = 0
                for (si, wi, original), replacement in zip(entries, result):
                    # Whisper words carry their leading space (" слово"); the
                    # model may drop it, and captions are rebuilt from words.
                    old = original.get("word", "")
                    replacement = old[:len(old) - len(old.lstrip())] + str(replacement).strip()
                    if replacement != old:
                        original["word"] = replacement
                        changed += 1
                if changed:
                    touched = {x[0] for x in entries}
                    for si in touched:
                        seg = working["segments"][si]
                        seg["text"] = "".join(w.get("word", "") for w in seg.get("words", [])).strip()
                    report["fixed"] += 1
                    report["words_changed"] += changed
        if report["words_changed"]:
            transcript.clear()
            transcript.update(working)
    except Exception:
        log.exception("Punctuation restoration failed; leaving transcript unchanged")
    return transcript, report
