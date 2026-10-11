import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Square, CheckCircle2, AlertTriangle, Clock, Trash2, FolderOpen } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Sidebar list of every job in the server's output dir (/api/local/projects):
// open any of them, see which are still running, and stop a running one.

// Rough share of the total time each stage takes, for one overall percentage.
const STAGE_WEIGHT = { download: 10, transcribe: 30, select: 20, render: 40 };

const overallPct = (progress) => {
    if (!progress) return null;
    let done = 0;
    let total = 0;
    for (const [stage, w] of Object.entries(STAGE_WEIGHT)) {
        total += w;
        done += w * Math.min(1, (progress[stage]?.pct ?? 0) / 100);
    }
    return Math.round((done / total) * 100);
};

const ago = (epoch) => {
    if (!epoch) return '';
    const s = Date.now() / 1000 - epoch;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(epoch * 1000).toLocaleDateString();
};

const RUNNING = new Set(['processing', 'queued']);

// Last list fetched, kept across remounts so the sidebar never flashes empty.
let cachedProjects = null;

export default function RecentProjects({ activeJobId, onOpen, onDeleted }) {
    const [projects, setProjects] = useState(cachedProjects);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch('/api/local/projects');
            if (!res.ok) return;
            const next = await res.json();
            // Only re-render when something actually changed.
            if (JSON.stringify(next) !== JSON.stringify(cachedProjects)) {
                cachedProjects = next;
                setProjects(next);
            }
        } catch { /* backend down: keep the last list */ }
    }, []);

    useEffect(() => {
        load();
        const id = setInterval(load, 3000);
        return () => clearInterval(id);
    }, [load]);

    const cancel = async (e, p) => {
        e.stopPropagation();
        if (!window.confirm(`Stop "${p.title}"? Its rendering and API calls end now.`)) return;
        await apiFetch(`/api/jobs/${p.job_id}/cancel`, { method: 'POST' }).catch(() => {});
        load();
    };

    const remove = async (e, p) => {
        e.stopPropagation();
        if (!window.confirm(`Delete "${p.title}"? Its source video and all clips are removed from disk.`)) return;
        const res = await apiFetch(`/api/local/projects/${p.job_id}`, { method: 'DELETE' }).catch(() => null);
        if (res && !res.ok) {
            const body = await res.json().catch(() => ({}));
            window.alert(body.detail || 'Could not delete this project.');
        }
        if (res?.ok && onDeleted) onDeleted(p.job_id);
        load();
    };

    if (!projects) return null;

    return (
        <div className="px-4 pb-4">
            <p className="eyebrow px-3 mb-2">recent projects</p>
            {projects.length === 0 && (
                <p className="px-3 text-xs text-muted lowercase">nothing yet</p>
            )}
            <div className="space-y-0.5">
                {projects.map((p) => {
                    const running = RUNNING.has(p.status);
                    const openable = p.status !== 'incomplete';
                    const pct = running ? overallPct(p.progress) : null;
                    const isActive = p.job_id === activeJobId;
                    return (
                        <div
                            key={p.job_id}
                            role="button"
                            tabIndex={openable ? 0 : -1}
                            onClick={() => openable && onOpen(p.job_id)}
                            onKeyDown={(e) => { if (openable && e.key === 'Enter') onOpen(p.job_id); }}
                            title={openable ? p.title : 'interrupted before any clips were picked'}
                            className={`group relative rounded-input px-3 py-2 transition-colors ${isActive ? 'bg-paper3' : 'hover:bg-paper3/50'} ${openable ? 'cursor-pointer' : 'opacity-50 cursor-default'}`}
                        >
                            <div className="flex items-start gap-2 min-w-0">
                                <span className="mt-0.5 shrink-0">
                                    {running && <Loader2 size={13} className="text-brass animate-spin" />}
                                    {p.status === 'completed' && <CheckCircle2 size={13} className="text-ok" />}
                                    {(p.status === 'failed' || p.status === 'cancelled') && <AlertTriangle size={13} className="text-danger" />}
                                    {p.status === 'incomplete' && <Clock size={13} className="text-muted" />}
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className={`text-[13px] leading-snug truncate ${isActive ? 'text-ink' : 'text-ink2'}`}>{p.title}</p>
                                    <p className="readout normal-case truncate">
                                        {running
                                            ? `${p.status === 'queued' ? 'queued' : 'running'}${pct != null ? ` · ${pct}%` : ''}`
                                            : [ago(p.created),
                                                p.clips != null ? `${p.clips} clips` : p.status,
                                                p.cost ? `$${p.cost.toFixed(2)}` : null].filter(Boolean).join(' · ')}
                                    </p>
                                </div>
                                {window.desktop && (
                                    <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); window.desktop.openProjectFolder(p.job_id); }}
                                        title="open project folder"
                                        className="shrink-0 p-1 rounded text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-ink hover:bg-paper3"
                                    >
                                        <FolderOpen size={12} />
                                    </button>
                                )}
                                {!running && (
                                    <button
                                        type="button"
                                        onClick={(e) => remove(e, p)}
                                        title="delete this project"
                                        className="shrink-0 p-1 rounded text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger hover:bg-danger/10"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                )}
                                {running && (
                                    <button
                                        type="button"
                                        onClick={(e) => cancel(e, p)}
                                        title="stop this job"
                                        className="shrink-0 p-1 rounded text-muted hover:text-danger hover:bg-danger/10"
                                    >
                                        <Square size={12} />
                                    </button>
                                )}
                            </div>
                            {running && pct != null && (
                                <div className="mt-1.5 h-1 rounded-full bg-paper3 overflow-hidden">
                                    <div className="h-full bg-brass transition-[width] duration-500" style={{ width: `${Math.max(2, pct)}%` }} />
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
