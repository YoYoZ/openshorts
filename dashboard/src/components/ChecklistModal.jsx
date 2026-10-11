import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, Loader2, RotateCcw } from 'lucide-react';
import Modal from './ui/Modal';
import { apiFetch } from '../lib/api';

const GROUPS = [
    ['format', 'format'], ['audio', 'audio'], ['opening', 'first seconds'],
    ['safe', 'safe zones'], ['text', 'title & description'], ['publish', 'publishing'],
];

const STATUS_ICON = {
    ok: <CheckCircle2 size={14} className="text-ok shrink-0" />,
    warn: <AlertTriangle size={14} className="text-warn shrink-0" />,
    fail: <XCircle size={14} className="text-danger shrink-0" />,
    info: <Info size={14} className="text-muted shrink-0" />,
};

// Compact badge for a checklist summary: red count, amber count, or a tick.
export function ChecksBadge({ summary, className = '' }) {
    if (!summary) return null;
    if (summary.fail) return <span className={`readout text-danger ${className}`}>{summary.fail}✕</span>;
    if (summary.warn) return <span className={`readout text-warn ${className}`}>{summary.warn}!</span>;
    return <span className={`readout text-ok ${className}`}>✓</span>;
}

// Pre-publish checklist for one clip (GET /api/clip/{job}/{index}/checks).
export default function ChecklistModal({ isOpen, onClose, jobId, clipIndex, clipVersion, onResult }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await apiFetch(`/api/clip/${jobId}/${clipIndex}/checks`);
            const body = await res.json();
            if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
            setData(body);
            onResult?.(clipIndex, body);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, clipVersion]);

    const items = data?.items || [];
    return (
        <Modal isOpen={isOpen} onClose={onClose} eyebrow="BEFORE YOU POST" title={`checklist · clip #${clipIndex + 1}`} size="md"
            footer={(
                <div className="flex items-center gap-3">
                    {data?.summary && (
                        <span className="text-xs text-muted mr-auto">
                            {data.summary.fail ? <span className="text-danger">{data.summary.fail} blocking · </span> : null}
                            {data.summary.warn ? <span className="text-warn">{data.summary.warn} to improve · </span> : null}
                            {data.summary.ok} fine
                        </span>
                    )}
                    <button type="button" onClick={load} disabled={loading} className="btn-ghost px-3 py-1.5 text-xs">
                        {loading ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} re-check
                    </button>
                    <button type="button" onClick={onClose} className="btn-primary px-3 py-1.5 text-xs">close</button>
                </div>
            )}>
            {error && <p className="text-sm text-danger">{error}</p>}
            {loading && !data && (
                <p className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> measuring the clip…</p>
            )}
            {data?.error && <p className="text-sm text-danger">{data.error}</p>}
            <div className="space-y-4">
                {GROUPS.map(([key, label]) => {
                    const rows = items.filter((i) => i.group === key);
                    if (!rows.length) return null;
                    return (
                        <div key={key}>
                            <p className="eyebrow mb-1.5">{label}</p>
                            <div className="divide-y divide-rule border border-rule rounded-input">
                                {rows.map((i) => (
                                    <div key={i.id} className="flex items-start gap-2.5 px-3 py-2">
                                        <span className="mt-0.5">{STATUS_ICON[i.status]}</span>
                                        <div className="min-w-0">
                                            <p className="text-sm text-ink2">{i.label}</p>
                                            {i.detail && (
                                                <p className={`text-xs break-words ${i.status === 'ok' || i.status === 'info' ? 'text-muted' : 'text-ink2/80'}`}>{i.detail}</p>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    );
                })}
            </div>
        </Modal>
    );
}
