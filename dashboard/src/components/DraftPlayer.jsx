import React, { useEffect, useMemo, useRef } from 'react';
import { Player } from '@remotion/player';
import { ClipDraft } from '../remotion/compositions/ClipDraft';
import { useClipDraft } from '../lib/clipDraft';
import { useWorkspace } from '../lib/workspace';

export default function DraftPlayer({ overlay }) {
    const { data } = useClipDraft();
    const { timeRef, setTime, subscribe } = useWorkspace();
    const ref = useRef(null);
    const seeded = useRef(false);
    const fps = 30;
    const duration = Math.max(1, data.duration || data.segments.reduce((n, s) => n + s.end - s.start, 0));
    const frames = Math.max(1, Math.floor(duration * fps));
    const inputProps = useMemo(() => ({ ...data, durationInFrames: frames, fps }), [data, frames]);
    useEffect(() => subscribe((time) => { const p = ref.current; if (p && Math.abs(p.getCurrentFrame() / fps - time) > .12) p.seekTo(Math.round(time * fps)); }), [subscribe]);
    useEffect(() => {
        const p = ref.current;
        if (!p) return undefined;
        const onFrame = (e) => { if (seeded.current) setTime(e.detail.frame / fps); };
        p.addEventListener('frameupdate', onFrame);
        if (!seeded.current) { p.seekTo(Math.min(frames - 1, Math.round(timeRef.current * fps))); seeded.current = true; }
        return () => p.removeEventListener('frameupdate', onFrame);
    }, [frames, setTime, timeRef]);
    return <div className="relative w-full h-full max-h-full max-w-full mx-auto bg-black rounded-card overflow-hidden"><Player ref={ref} component={ClipDraft} inputProps={inputProps} durationInFrames={frames} fps={fps} compositionWidth={1080} compositionHeight={1920} controls loop style={{ width: '100%', height: '100%' }} />{overlay}</div>;
}
