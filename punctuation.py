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


class _TextResponse(BaseModel):
    text: str


MIN_MATCH = 0.9   # share of the stretch's words the answer must align with


def _align(source_norm, answer_norm):
    """Longest common subsequence of two token lists: [(i, j)] matched pairs.
    The model is asked for the same words, but sometimes changes a form or
    splits a token; aligning keeps every word it did not touch."""
    n, m = len(source_norm), len(answer_norm)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if source_norm[i] == answer_norm[j] and source_norm[i] \
                else max(dp[i + 1][j], dp[i][j + 1])
    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if source_norm[i] == answer_norm[j] and source_norm[i]:
            pairs.append((i, j)); i += 1; j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return pairs


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
                prompt = (f"Add natural punctuation (commas, full stops, question marks) and sentence capitalization to "
                          f"this {language or 'unknown-language'} speech transcript. Do not change, add, remove or reorder "
                          "any word. Return the text only.\n\n" + " ".join(w.strip() for w in source))
                parsed, _ = llm_backend.generate_json(prompt, _TextResponse, tier="simple")
                answer = str((parsed or {}).get("text") or "").split()
                pairs = _align([_normalize(w) for w in source], [_normalize(w) for w in answer])
                if len(pairs) < MIN_MATCH * len(source):
                    log.info("punctuation: stretch skipped, answer aligned %d/%d words", len(pairs), len(source))
                    continue
                result = list(source)
                for i, j in pairs:
                    result[i] = answer[j]
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
