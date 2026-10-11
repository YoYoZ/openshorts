import React, { useEffect, useState } from 'react';
import { Check, Loader2, Circle, Cpu, MemoryStick, Gauge } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Real progress for a running job: one bar per pipeline stage, fed by the
// PROGRESS events main.py emits (see progress_events.py / app.enqueue_output),
// plus live CPU / RAM / GPU load from /api/system.

const STAGES = [
    { key: 'download', label: 'download' },
    { key: 'transcribe', label: 'transcribe' },
    { key: 'select', label: 'pick moments' },
    { key: 'render', label: 'render clips' },
];

const fmtSecs = (s) => {
    if (s == null || !Number.isFinite(s)) return '';
    s = Math.max(0, Math.round(s));
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

function useNow(active) {
    const [now, setNow] = useState(() => Date.now() / 1000);
    useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now() / 1000), 1000);
        return () => clearInterval(id);
    }, [active]);
    return now;
}

function StageRow({ label, p, state, now }) {
    const pct = p?.pct ?? 0;
    const elapsed = p?.started ? (state === 'done' ? p.updated - p.started : now - p.started) : null;
    const counts = p?.total ? `${p.done ?? 0}/${p.total}` : null;
    return (
        <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
                {state === 'done' && <Check size={14} className="text-ok shrink-0" />}
                {state === 'active' && <Loader2 size={14} className="text-brass animate-spin shrink-0" />}
                {state === 'waiting' && <Circle size={14} className="text-muted opacity-40 shrink-0" />}
                <span className={`lowercase ${state === 'waiting' ? 'text-muted' : 'text-ink'}`}>{label}</span>
                {counts && <span className="readout">{counts}</span>}
                <span className="ml-auto readout tabular-nums">
                    {state !== 'waiting' && `${Math.round(pct)}%`}
                    {elapsed != null && ` · ${fmtSecs(elapsed)}`}
                    {state === 'active' && p?.eta ? ` · ~${fmtSecs(p.eta)} left` : ''}
                </span>
            </div>
            <div className="h-1.5 rounded-full bg-paper3 overflow-hidden">
                <div
                    className={`h-full rounded-full transition-[width] duration-500 ${state === 'done' ? 'bg-ok' : 'bg-brass'}`}
                    style={{ width: `${state === 'waiting' ? 0 : Math.max(2, pct)}%` }}
                />
            </div>
            {p?.detail && state === 'active' && (
                <p className="readout normal-case truncate">{p.detail}</p>
            )}
        </div>
    );
}

function LoadBar({ icon, label, pct, text }) {
    const v = Math.max(0, Math.min(100, pct ?? 0));
    const color = v > 90 ? 'bg-danger' : v > 70 ? 'bg-warn' : 'bg-ink2';
    return (
        <div className="space-y-1">
            <div className="flex items-center gap-1.5 readout">
                {React.createElement(icon, { size: 11 })} {label}
                <span className="ml-auto tabular-nums normal-case">{text}</span>
            </div>
            <div className="h-1 rounded-full bg-paper3 overflow-hidden">
                <div className={`h-full ${color} transition-[width] duration-700`} style={{ width: `${v}%` }} />
            </div>
        </div>
    );
}

function SystemLoad() {
    const [sys, setSys] = useState(null);
    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const res = await apiFetch('/api/system');
                if (res.ok && alive) setSys(await res.json());
            } catch { /* backend busy; keep the last reading */ }
        };
        tick();
        const id = setInterval(tick, 1500);
        return () => { alive = false; clearInterval(id); };
    }, []);
    if (!sys) return null;
    const gb = (b) => (b / 1073741824).toFixed(1);
    const g = sys.gpu;
    return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-3 border-t border-rule">
            <LoadBar icon={Cpu} label="cpu" pct={sys.cpu} text={`${Math.round(sys.cpu)}%`} />
            <LoadBar icon={MemoryStick} label="ram" pct={sys.ram_used / sys.ram_total * 100}
                text={`${gb(sys.ram_used)} / ${gb(sys.ram_total)} GB`} />
            {g && <LoadBar icon={Gauge} label="gpu" pct={g.util}
                text={`${Math.round(g.util)}%${g.encoder != null ? ` · nvenc ${Math.round(g.encoder)}%` : ''}`} />}
            {g && <LoadBar icon={MemoryStick} label="vram" pct={g.mem_used / g.mem_total * 100}
                text={`${(g.mem_used / 1024).toFixed(1)} / ${(g.mem_total / 1024).toFixed(1)} GB`} />}
        </div>
    );
}

export default function JobProgress({ progress, running, isUpload }) {
    const now = useNow(running);
    const p = progress || {};
    const stages = STAGES.filter((s) => !(isUpload && s.key === 'download'));
    // A stage is done once it hits 100% or a later stage has started; the
    // download and transcription overlap (audio is transcribed while the
    // video is still coming in), so both can be active at once.
    const states = stages.map((s, i) => {
        const cur = p[s.key];
        const later = stages.slice(i + 1).some((n) => p[n.key]);
        if (cur && (cur.pct >= 100 || (later && s.key !== 'download' && s.key !== 'transcribe'))) return 'done';
        if (cur) return 'active';
        // Never reported but a later stage already ran: skipped (cached
        // transcript on a resumed job, for instance), so it is done.
        if (stages.slice(i + 2).some((n) => p[n.key]) || (later && s.key === 'transcribe')) return 'done';
        return 'waiting';
    });
    const started = Object.values(p).map((x) => x.started).filter(Boolean);
    const total = started.length ? now - Math.min(...started) : null;

    return (
        <div className="rounded-card border border-rule bg-paper p-4 space-y-4 mb-4">
            <div className="flex items-center justify-between">
                <span className="eyebrow">progress</span>
                {total != null && running && <span className="readout tabular-nums">{fmtSecs(total)} elapsed</span>}
            </div>
            {stages.map((s, i) => (
                <StageRow key={s.key} label={s.label} p={p[s.key]} state={states[i]} now={now} />
            ))}
            {running && <SystemLoad />}
        </div>
    );
}
