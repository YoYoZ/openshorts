import type { CaptionWord } from "./types";

export interface CaptionBlock {
  words: CaptionWord[];
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Groups word-level captions into display blocks.
 * Same logic as OpenShorts' generate_srt: max chars per block, max duration per block.
 */
export function groupCaptionsIntoBlocks(
  captions: CaptionWord[],
  maxChars = 20,
  maxDurationMs = 2000
): CaptionBlock[] {
  const blocks: CaptionBlock[] = [];
  let currentWords: CaptionWord[] = [];
  let blockStartMs = 0;

  // Spoken order, times made monotonic (subtitles.fix_word_overlaps): no
  // word runs past the next one's start, and a word stamped before the
  // previous one starts where that one ends. Never sort by time: a
  // mis-stamped word would jump to the wrong place in the sentence.
  const sorted = captions.map((w) => ({ ...w }));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b.startMs >= a.endMs) continue;
    if (b.startMs >= a.startMs + 40) a.endMs = b.startMs;
    else b.startMs = Math.max(a.endMs, a.startMs + 40);
    if (b.endMs < b.startMs + 40) b.endMs = b.startMs + 40;
  }

  for (const word of sorted) {
    if (currentWords.length === 0) {
      currentWords.push(word);
      blockStartMs = word.startMs;
      continue;
    }

    const currentTextLen = currentWords.reduce(
      (sum, w) => sum + w.text.length + 1,
      0
    );
    const duration = word.endMs - blockStartMs;

    if (
      currentTextLen + word.text.length > maxChars ||
      duration > maxDurationMs
    ) {
      // Finalize current block
      const lastWord = currentWords[currentWords.length - 1];
      blocks.push({
        words: [...currentWords],
        startMs: blockStartMs,
        endMs: lastWord.endMs,
        text: currentWords.map((w) => w.text).join(" "),
      });

      currentWords = [word];
      blockStartMs = word.startMs;
    } else {
      currentWords.push(word);
    }
  }

  // Final block
  if (currentWords.length > 0) {
    const lastWord = currentWords[currentWords.length - 1];
    blocks.push({
      words: [...currentWords],
      startMs: blockStartMs,
      endMs: lastWord.endMs,
      text: currentWords.map((w) => w.text).join(" "),
    });
  }

  return blocks;
}

/**
 * Find the active word at a given time in milliseconds.
 */
export function getActiveWordIndex(
  words: CaptionWord[],
  timeMs: number
): number {
  for (let i = 0; i < words.length; i++) {
    if (timeMs >= words[i].startMs && timeMs < words[i].endMs) {
      return i;
    }
  }
  return -1;
}
