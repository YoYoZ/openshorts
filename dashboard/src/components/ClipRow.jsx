import React, { memo } from 'react';
import { Check } from 'lucide-react';
import { ChecksBadge } from './ChecklistModal';

// One clip in the project list. Deliberately light: no <video>, no player.
// The one selected clip gets the full ResultCard in the detail pane, so a
// 10-clip project mounts one player instead of ten.

const STATUS = {
    todo: { label: 'To edit', cls: 'text-ink2' },
    done: { label: 'Done', cls: 'text-ok' },
    scheduled: { label: 'Scheduled', cls: 'text-info' },
    published: { label: 'Published', cls: 'text-info' },
    rejected: { label: 'Rejected', cls: 'text-muted' },
};

const fmtLen = (s) => {
    if (!Number.isFinite(s) || s <= 0) return '';
    const r = Math.round(s);
    return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
};

function clipLength(clip) {
    const segs = clip?.recipe?.segments;
    if (Array.isArray(segs) && segs.length) {
        return segs.reduce((t, s) => t + Math.max(0, (Number(s.end) || 0) - (Number(s.start) || 0)), 0);
    }
    return (Number(clip?.end) || 0) - (Number(clip?.start) || 0);
}

function when(clip) {
    const at = clip?.youtube?.publish_at;
    if (!at) return '';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ClipRow({ clip, index, status, active, selected, checks, onOpen, onToggleSelect }) {
    const st = STATUS[status] || STATUS.todo;
    const score = Number.isFinite(clip?.predicted_score) ? Math.round(clip.predicted_score) : null;
    const scheduledAt = status === 'scheduled' || status === 'published' ? when(clip) : '';
    return (
        <div className={`group flex items-center gap-3 rounded-input border px-2.5 py-2 transition-colors ${active ? 'bg-paper3 border-rule2' : 'border-transparent hover:bg-paper2'}`}>
            {onToggleSelect && (
                <button type="button" onClick={() => onToggleSelect(index)} aria-pressed={selected}
                    aria-label={`select clip ${index + 1}`}
                    className={`w-5 h-5 shrink-0 rounded-[5px] border flex items-center justify-center ${selected ? 'bg-brass border-brass text-brassink' : 'border-rule2 text-transparent group-hover:border-muted'}`}>
                    <Check size={12} strokeWidth={3} />
                </button>
            )}
            <button type="button" onClick={() => onOpen(index)} className="flex flex-1 items-center gap-3 min-w-0 text-left">
                <span aria-hidden="true" className="w-9 h-16 shrink-0 rounded-md bg-paper3 border border-rule flex flex-col items-center justify-between py-1.5 readout normal-case text-[10px]">
                    <span className="text-ink2">#{index + 1}</span>
                    <span>{fmtLen(clipLength(clip))}</span>
                </span>
                <span className="flex flex-col gap-1 min-w-0 flex-1">
                    <span className={`text-sm truncate ${status === 'rejected' ? 'text-muted line-through' : 'text-ink'}`}>
                        {clip?.video_title_for_youtube_short || `Clip ${index + 1}`}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted min-w-0">
                        <span className={st.cls}>{st.label}</span>
                        {scheduledAt && <span className="truncate">· {scheduledAt}</span>}
                        {checks && status !== 'rejected' && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-px rounded border border-rule">
                                <ChecksBadge summary={checks} />
                                <span>{checks.fail ? 'blocked' : checks.warn ? 'to improve' : 'ready'}</span>
                            </span>
                        )}
                    </span>
                </span>
                {score !== null && (
                    <span className="flex flex-col items-end shrink-0">
                        <span className={`font-mono text-[15px] ${score >= 70 ? 'text-brass' : 'text-ink2'}`}>{score}</span>
                        <span className="text-[10px] text-muted">score</span>
                    </span>
                )}
            </button>
        </div>
    );
}

export default memo(ClipRow);
