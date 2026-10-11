// Re-time an edited caption text against the original word timings.
//
// The text box hands back one free-form string; spreading its words evenly
// over the clip threw away every timestamp the moment a single word changed.
// Instead, diff the edited words against the original ones (LCS on a
// normalised form, so case and punctuation fixes still match):
//   - a kept word keeps its own startMs/endMs (with the edited spelling),
//   - words that replace a run of originals share that run's time span,
//   - a pure insertion takes the gap before the next word, or, when there is
//     no real gap, the second half of the word before it,
//   - deleted words simply drop out.

const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function alignEditedWords(original, newText) {
    const words = newText.split(/\s+/).filter(Boolean);
    if (!words.length || !original.length) return [];

    const a = original.map((c) => norm(c.text));
    const b = words.map(norm);
    const n = a.length;
    const m = b.length;

    // LCS table, filled from the end so the walk below goes forwards.
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = a[i] && a[i] === b[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const out = [];
    let i = 0;
    let j = 0;
    let runOrig = [];
    let runNew = [];

    const spread = (texts, start, end) => {
        const step = (end - start) / texts.length;
        texts.forEach((text, k) => out.push({
            text,
            startMs: Math.round(start + k * step),
            endMs: Math.round(start + (k + 1) * step),
        }));
    };

    // Resolve the pending unmatched run, given the next kept original word
    // (or undefined at the end).
    const flush = (next) => {
        if (runNew.length) {
            if (runOrig.length) {
                spread(runNew, runOrig[0].startMs, runOrig[runOrig.length - 1].endMs);
            } else {
                const prev = out[out.length - 1];
                const gapStart = prev ? prev.endMs : (next ? Math.max(0, next.startMs - 400) : 0);
                const gapEnd = next ? next.startMs : gapStart + 400 * runNew.length;
                if (gapEnd - gapStart >= 120 * runNew.length) {
                    spread(runNew, gapStart, gapEnd);
                } else if (prev) {
                    // No room: split the previous word's time with the new ones.
                    const mid = Math.round((prev.startMs + prev.endMs) / 2);
                    const end = prev.endMs;
                    prev.endMs = mid;
                    spread(runNew, mid, end);
                } else if (next) {
                    // Inserted before the very first word: borrow its first half.
                    const mid = Math.round((next.startMs + next.endMs) / 2);
                    spread(runNew, next.startMs, mid);
                    next._startOverride = mid;
                } else {
                    spread(runNew, gapStart, gapEnd);
                }
            }
        }
        runOrig = [];
        runNew = [];
    };

    while (i < n || j < m) {
        if (i < n && j < m && a[i] && a[i] === b[j]) {
            const next = original[i];
            flush(next);
            out.push({
                text: words[j],
                startMs: next._startOverride ?? next.startMs,
                endMs: next.endMs,
            });
            delete next._startOverride;
            i++;
            j++;
        } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
            runNew.push(words[j++]);
        } else {
            runOrig.push(original[i++]);
        }
    }
    flush(undefined);
    return out;
}
