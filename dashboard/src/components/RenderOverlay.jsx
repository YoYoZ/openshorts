import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Live progress of a server-side re-render of one clip (subtitles, hook,
// recut, reframe, auto edit), from /api/clip-ops/{job} (render_ops.py).
// Covers the clip preview while it runs; renders nothing otherwise.
// One poll per project, shared by every card of it: ten cards each polling
// /api/clip-ops on their own was ~5 requests a second for the same answer.
const pollers = new Map();   // jobId -> { subs: Set<{clipIndex, fast, cb}>, timer }

function subscribe(jobId, sub) {
    let p = pollers.get(jobId);
    if (!p) {
        p = { subs: new Set(), timer: null };
        pollers.set(jobId, p);
        const tick = async () => {
            let ops = {};
            try {
                const res = await apiFetch(`/api/clip-ops/${jobId}`);
                if (res.ok) ops = await res.json();
            } catch { /* keep polling */ }
            if (pollers.get(jobId) !== p) return;
            p.subs.forEach((s) => s.cb(ops[String(s.clipIndex)] || null));
            // Fast while anything renders (or a card expects it to), slow otherwise.
            const fast = Object.keys(ops).length > 0 || [...p.subs].some((s) => s.fast);
            p.timer = setTimeout(tick, fast ? 700 : 2000);
        };
        tick();
    }
    p.subs.add(sub);
    return () => {
        p.subs.delete(sub);
        if (p.subs.size === 0) {
            clearTimeout(p.timer);
            pollers.delete(jobId);
        }
    };
}

export default function RenderOverlay({ jobId, clipIndex, fallbackLabel, onBusyChange }) {
    const [op, setOp] = useState(null);
    const [now, setNow] = useState(() => Date.now() / 1000);

    useEffect(() => {
        if (!jobId) return undefined;
        return subscribe(jobId, {
            clipIndex,
            fast: !!fallbackLabel,
            cb: (next) => {
                setOp(next);
                onBusyChange?.(!!next);
                setNow(Date.now() / 1000);
            },
        });
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
