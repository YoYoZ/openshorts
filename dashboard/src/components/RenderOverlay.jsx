import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Live progress of a server-side re-render of one clip (subtitles, hook,
// recut, reframe, auto edit), from /api/clip-ops/{job} (render_ops.py).
// Covers the clip preview while it runs; renders nothing otherwise.
export default function RenderOverlay({ jobId, clipIndex, fallbackLabel, onBusyChange }) {
    const [op, setOp] = useState(null);
    const [now, setNow] = useState(() => Date.now() / 1000);

    useEffect(() => {
        if (!jobId) return undefined;
        let alive = true;
        let timer;
        const tick = async () => {
            let next = null;
            try {
                const res = await apiFetch(`/api/clip-ops/${jobId}`);
                if (res.ok) next = (await res.json())[String(clipIndex)] || null;
            } catch { /* keep polling */ }
            if (!alive) return;
            setOp(next);
            onBusyChange?.(!!next);
            setNow(Date.now() / 1000);
            // Fast while something runs on this clip, slow otherwise.
            timer = setTimeout(tick, next || fallbackLabel ? 700 : 2000);
        };
        tick();
        return () => { alive = false; clearTimeout(timer); };
    }, [jobId, clipIndex, fallbackLabel, onBusyChange]);

    if (!op && !fallbackLabel) return null;
    const pct = op?.pct;
    const elapsed = op?.started ? Math.max(0, Math.round(now - op.started)) : null;

    return (
        <div className="absolute inset-0 bg-black/75 flex flex-col items-center justify-center z-10 p-5 text-center">
            <Loader2 size={26} className="text-brass animate-spin mb-3" />
            <span className="text-xs text-ink lowercase">{op?.kind || fallbackLabel}…</span>
            <div className="w-full max-w-[180px] h-1.5 rounded-full bg-paper3 overflow-hidden mt-3">
                <div className="h-full bg-brass transition-[width] duration-500" style={{ width: `${pct != null ? Math.max(3, pct) : 3}%` }} />
            </div>
            <span className="readout mt-2 tabular-nums">
                {pct != null ? `${Math.round(pct)}%` : 'preparing'}
                {op?.step > 1 ? ` · pass ${op.step}` : ''}
                {elapsed != null ? ` · ${elapsed}s` : ''}
            </span>
        </div>
    );
}
