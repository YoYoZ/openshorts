import { renderStillOnWeb } from '@remotion/web-renderer';
import { groupCaptionsIntoBlocks } from '../remotion/lib/captions';
import { CaptionsOnly } from '../remotion/compositions/CaptionsOnly';

const hash = async (value) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = await crypto.subtle.digest('SHA-1', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

export async function renderCaptionFrames({ subtitles, durationInSeconds, fps = 30, onProgress, signal }) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const blocks = groupCaptionsIntoBlocks(subtitles.captions, subtitles.maxChars ?? 20, subtitles.maxDurationMs ?? 2000);
    const states = [];
    blocks.forEach((block) => {
        const wordStarts = block.words.map((w) => w.startMs / 1000).filter((t) => t > block.startMs / 1000);
        const boundaries = [block.startMs / 1000, ...wordStarts, block.endMs / 1000];
        boundaries.slice(0, -1).forEach((start, i) => {
            const end = boundaries[i + 1];
            if (end > start) states.push({ start, end });
        });
    });
    const fingerprint = await hash({ captions: subtitles.captions.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })), style: subtitles, durationInSeconds });
    const frames = [];
    for (let i = 0; i < states.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const state = states[i];
        const frame = Math.max(0, Math.min(Math.ceil(durationInSeconds * fps) - 1,
            Math.floor(Math.min(state.start + 6 / fps, state.end - 1 / fps) * fps)));
        const result = await renderStillOnWeb({
            composition: { id: 'CaptionsOnly', component: CaptionsOnly, width: 1080, height: 1920, fps, durationInFrames: Math.max(1, Math.ceil(durationInSeconds * fps)), defaultProps: { subtitles } },
            inputProps: { subtitles }, frame, signal: signal || null,
        });
        frames.push({ ...state, blob: await result.blob({ format: 'png' }) });
        onProgress?.(i + 1, states.length);
    }
    return { fingerprint, frames };
}
