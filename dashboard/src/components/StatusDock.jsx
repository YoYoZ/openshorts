import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Cpu, Coins, Bot, CheckCircle2, AlertCircle, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Render kinds are already human labels ("burning subtitles", "adding hook").
const KIND_LABEL = {};
const STAGE_ORDER = ['download', 'transcribe', 'select', 'render'];
const STAGE_LABEL = { download: 'downloading', transcribe: 'transcribing', select: 'picking moments', render: 'rendering clips' };

// Finished renders and jobs are announced inside the app window (bottom
// right), never as system notifications.
const TOAST_MS = 6000;

function Bar({ pct }) {
    return (
        <div className="h-1 rounded-full bg-paper3 overflow-hidden mt-1">
            {pct == null
                ? <div className="h-full w-1/3 bg-brass/60 animate-pulse" />
                : <div className="h-full bg-brass transition-all" style={{ width: `${Math.max(2, pct)}%` }} />}
        </div>
    );
}

// Sidebar footer: everything rendering right now (all projects), the month's
// AI spend, the model the chain will use next, and machine load.
export default function StatusDock({ onOpen }) {
    const [act, setAct] = useState(null);
    const [sys, setSys] = useState(null);
    const [llm, setLlm] = useState(null);
    const seenJobs = useRef(new Map());   // job_id -> title, while queued/processing
    const lastRecent = useRef(null);      // newest finished render already handled
    const [toasts, setToasts] = useState([]);
    const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));
    const notifyRef = useRef(null);
    notifyRef.current = (title, body, ok = true, jobId = null) => {
        const id = Math.random().toString(36).slice(2);
        setToasts((t) => [...t.slice(-3), { id, title, body, ok, jobId }]);
        setTimeout(() => dismiss(id), TOAST_MS);
    };
    const notify = (...args) => notifyRef.current(...args);

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const a = await apiFetch('/api/activity').then((r) => r.json());
                if (stop) return;
                setAct(a);
                // Finished re-renders since the last poll.
                const recent = a.recent || [];
                const newest = recent.length ? recent[recent.length - 1].finished : 0;
                if (lastRecent.current !== null) {
                    recent.filter((r) => r.finished > lastRecent.current).forEach((r) => {
                        notify(r.ok ? `Clip #${r.clip_index + 1} ready` : `Clip #${r.clip_index + 1} failed`,
                            `${KIND_LABEL[r.kind] || r.kind} · ${r.title}`, r.ok, r.job_id);
                    });
                }
                lastRecent.current = Math.max(lastRecent.current || 0, newest);
                // Pipeline jobs that left the queue: ask how they ended.
                const live = new Set((a.jobs || []).map((j) => j.job_id));
                for (const [id, title] of seenJobs.current) {
                    if (live.has(id)) continue;
                    seenJobs.current.delete(id);
                    apiFetch(`/api/status/${id}`).then((r) => r.json()).then((s) => {
                        if (s.status === 'completed') notify('Clips ready', `${s.result?.clips?.length ?? ''} clips · ${title}`, true, id);
                        else if (s.status === 'failed') notify('Processing failed', title, false, id);
                    }).catch(() => {});
                }
                (a.jobs || []).forEach((j) => seenJobs.current.set(j.job_id, j.title));
            } catch { /* backend restarting */ }
        };
        tick();
        const t = setInterval(tick, 1500);
        return () => { stop = true; clearInterval(t); };
    }, []);

    useEffect(() => {
        let stop = false;
        const tick = async () => {
            try {
                const [s, cfg] = await Promise.all([
                    apiFetch('/api/system').then((r) => r.json()),
                    apiFetch('/api/settings').then((r) => r.json()),
                ]);
                if (stop) return;
                setSys(s);
                const chain = (cfg?.llm_chain || []).filter((e) => e.enabled !== false && e.model);
                const next = chain.find((e) => !(e.budget_usd > 0 && (e.spent_usd || 0) >= e.budget_usd));
                const month = chain.filter((e) => (e.period || 'month') === 'month')
                    .reduce((sum, e) => sum + (e.spent_usd || 0), 0);
                setLlm({ next: next?.model || null, exhausted: chain.length > 0 && !next, month, any: chain.length > 0 });
            } catch { /* ignore */ }
        };
        tick();
        const t = setInterval(tick, 5000);
        return () => { stop = true; clearInterval(t); };
    }, []);

    const jobs = act?.jobs || [];
    const renders = act?.renders || [];
    const busy = jobs.length + renders.length;

    const toastStack = toasts.length > 0 && createPortal(
        <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 w-[320px] max-w-[calc(100vw-2rem)]" aria-live="polite">
            {toasts.map((t) => (
                <div key={t.id} className="card flex items-start gap-3 px-3.5 py-3 shadow-2xl animate-fade">
                    {t.ok ? <CheckCircle2 size={16} className="text-ok shrink-0 mt-0.5" /> : <AlertCircle size={16} className="text-danger shrink-0 mt-0.5" />}
                    <button type="button" onClick={() => { if (t.jobId) onOpen?.(t.jobId); dismiss(t.id); }}
                        className="flex-1 min-w-0 text-left">
                        <span className="block text-sm text-ink">{t.title}</span>
                        <span className="block text-xs text-muted truncate">{t.body}</span>
                    </button>
                    <button type="button" onClick={() => dismiss(t.id)} aria-label="dismiss" className="text-muted hover:text-ink shrink-0">
                        <X size={14} />
                    </button>
                </div>
            ))}
        </div>,
        document.body,
    );

    return (
        <div className="space-y-3 text-xs">
            {toastStack}
            {busy > 0 && (
                <div className="hidden lg:block space-y-2">
                    <p className="readout text-muted flex items-center gap-1.5">
                        <Loader2 size={11} className="animate-spin text-brass" /> working · {busy}
                    </p>
                    {jobs.map((j) => {
                        // progress is {stage: {pct, ...}}; show the latest stage reached.
                        const prog = j.progress || {};
                        const key = [...STAGE_ORDER].reverse().find((k) => prog[k]);
                        const p = key ? { ...prog[key], label: STAGE_LABEL[key] } : {};
                        const pct = typeof p.pct === 'number' ? p.pct : null;
                        return (
                            <button key={j.job_id} type="button" onClick={() => onOpen?.(j.job_id)}
                                className="block w-full text-left hover:bg-paper3/50 rounded px-1 -mx-1 py-0.5">
                                <span className="block truncate text-ink2">{j.title}</span>
                                <span className="text-muted">{j.status === 'queued' ? 'queued' : (p.label || 'starting')}{pct != null ? ` · ${Math.round(pct)}%` : ''}</span>
                                <Bar pct={j.status === 'queued' ? 0 : pct} />
                            </button>
                        );
                    })}
                    {renders.map((r) => (
                        <button key={`${r.job_id}-${r.clip_index}`} type="button" onClick={() => onOpen?.(r.job_id)}
                            className="block w-full text-left hover:bg-paper3/50 rounded px-1 -mx-1 py-0.5">
                            <span className="block truncate text-ink2">#{r.clip_index + 1} {KIND_LABEL[r.kind] || r.kind}</span>
                            <span className="block truncate text-muted">{r.title}{r.step > 1 ? ` · pass ${r.step}` : ''}</span>
                            <Bar pct={r.pct} />
                        </button>
                    ))}
                </div>
            )}
            {busy === 0 && act?.recent?.length > 0 && (() => {
                const r = act.recent[act.recent.length - 1];
                if ((act.now || 0) - r.finished > 120) return null;
                return (
                    <p className="hidden lg:flex items-center gap-1.5 text-muted">
                        {r.ok ? <CheckCircle2 size={11} className="text-ok" /> : <AlertCircle size={11} className="text-danger" />}
                        <span className="truncate">#{r.clip_index + 1} {KIND_LABEL[r.kind] || r.kind} {r.ok ? 'done' : 'failed'}</span>
                    </p>
                );
            })()}
            {busy > 0 && (
                <span className="lg:hidden flex justify-center" title={`${busy} running`}>
                    <Loader2 size={16} className="animate-spin text-brass" />
                </span>
            )}

            <div className="space-y-1 text-muted">
                {llm?.any && (
                    <p className="flex items-center gap-2" title="next model in the AI chain (Settings → AI models)">
                        <Bot size={13} className="shrink-0" />
                        <span className={`hidden lg:block truncate ${llm.exhausted ? 'text-danger' : ''}`}>
                            {llm.exhausted ? 'all budgets used' : llm.next}
                        </span>
                    </p>
                )}
                {llm?.any && (
                    <p className="flex items-center gap-2" title="AI spend this month (models with a monthly period)">
                        <Coins size={13} className="shrink-0" />
                        <span className="hidden lg:block readout">${llm.month.toFixed(3)} this month</span>
                    </p>
                )}
                {sys && (
                    <p className="flex items-center gap-2" title={sys.gpu ? sys.gpu.name : 'no NVIDIA GPU found'}>
                        <Cpu size={13} className="shrink-0" />
                        <span className="hidden lg:block readout">
                            cpu {Math.round(sys.cpu)}%{sys.gpu ? ` · gpu ${Math.round(sys.gpu.util)}%` : ''}
                        </span>
                    </p>
                )}
            </div>
        </div>
    );
}
