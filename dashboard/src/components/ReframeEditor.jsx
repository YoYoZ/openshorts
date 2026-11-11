import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X, Loader2, Crosshair, RotateCcw, AlertCircle, Play, Pause, Scissors, Merge, ListTree, Wand2, Square } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiJson } from '../lib/api';

// Manual reframing, zone by zone.
//
// The server is asked once: it cuts the clip from source, detects scenes and
// makes a light preview (all cached per clip). Zones are then edited here, on
// a timeline like an NLE's: drag a cut, double-click the bar to add one,
// double-click a cut to remove it. Each zone gets a layout:
//   auto  - what the automatic pass decides
//   fill  - a vertical crop, placed where the rectangle is
//   fit   - the whole frame over a blurred copy of itself
//   zoom  - a wider window of the frame (zoomed in), over a blurred backdrop
//   split - two boxes stacked, top and bottom; each box is scaled to its half
// Zones left on auto are not sent, so fixing one bad stretch cannot spoil the
// ones the tracker got right.

const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
};

const MODES = [
    { id: 'auto', label: 'auto', hint: 'the automatic camera', color: 'rgba(255,255,255,0.10)' },
    { id: 'fill', label: 'fill', hint: 'a vertical crop where the rectangle is', color: 'rgba(214,170,90,0.55)' },
    { id: 'fit', label: 'fit', hint: 'the whole frame on a blurred background', color: 'rgba(96,165,250,0.50)' },
    { id: 'zoom', label: 'zoom', hint: 'a wider window of the frame, zoomed in', color: 'rgba(167,139,250,0.55)' },
    { id: 'split', label: 'split', hint: 'two boxes stacked, top and bottom', color: 'rgba(52,211,153,0.50)' },
];
const MODE_COLOR = Object.fromEntries(MODES.map((m) => [m.id, m.color]));

const MIN_ZONE = 0.3;     // seconds
const SNAP = 0.35;        // seconds: a dragged cut snaps to a sentence edge this close

const modeOf = (v) => {
    if (v === undefined || v === null) return 'auto';
    if (typeof v === 'number') return 'fill';
    if (v.mode) return v.mode;
    if (v.top && v.bottom) return 'split';
    return 'auto';
};

const tidy = (cuts, duration) => {
    const out = [];
    [...cuts].sort((a, b) => a - b).forEach((c) => {
        const t = Math.round(c * 1000) / 1000;
        if (t < MIN_ZONE || t > duration - MIN_ZONE) return;
        if (out.length && t - out[out.length - 1] < MIN_ZONE) return;
        out.push(t);
    });
    return out;
};

export default function ReframeEditor({ jobId, clipIndex, clipTitle, onClose, onReframed, inline = false }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [data, setData] = useState(null);
    const [overrides, setOverrides] = useState({});   // zone idx -> value (see modeOf)
    const [cuts, setCuts] = useState([]);             // zone edges, clip seconds
    const [cutsChanged, setCutsChanged] = useState(false);
    const [playing, setPlaying] = useState(null);
    const [saving, setSaving] = useState(false);
    const rowRefs = useRef({});

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiJson(`/api/clip/${jobId}/${clipIndex}/scenes`);
                if (!alive) return;
                setData(res);
                // Start from what is applied: a re-render rebuilds from source
                // with only what it receives.
                const saved = res.saved_overrides || {};
                setOverrides(Object.fromEntries(Object.entries(saved).map(([k, v]) => [Number(k), v])));
                setCuts(res.saved_cuts ?? res.auto_cuts ?? res.scenes.slice(1).map((z) => z.start));
            } catch (e) {
                if (alive) setError(e?.message || 'Could not read the scenes of this clip.');
            } finally {
                if (alive) setLoading(false);
            }
        })();
        return () => { alive = false; };
    }, [jobId, clipIndex]);

    const duration = data?.duration || (data?.scenes?.length ? data.scenes[data.scenes.length - 1].end : 0);

    // Zones from the cuts. A zone that matches a server scene keeps its full
    // resolution frame; the rest are drawn from the preview at their middle.
    const zones = useMemo(() => {
        if (!data) return [];
        const edges = [0, ...cuts, duration];
        return edges.slice(0, -1).map((start, i) => {
            const end = edges[i + 1];
            const mid = (start + end) / 2;
            const near = data.scenes.find((z) => mid >= z.start && mid < z.end) || data.scenes[data.scenes.length - 1];
            const exact = data.scenes.find((z) => Math.abs(z.start - start) < 0.05 && Math.abs(z.end - end) < 0.05);
            return {
                index: i, start, end, mid,
                thumbnail_url: exact?.thumbnail_url || null,
                suggested_center: near?.suggested_center ?? 0.5,
                suggested_center_y: near?.suggested_center_y ?? 0.5,
            };
        });
    }, [data, cuts, duration]);

    // New cut list: each new zone keeps the layout of the old zone its
    // middle falls in (only when the zone count changes; a drag keeps indices).
    const rezone = useCallback((next) => {
        const clean = tidy(next, duration);
        setCutsChanged(true);
        setPlaying(null);
        if (clean.length !== cuts.length) {
            const edges = [0, ...clean, duration];
            const remapped = {};
            edges.slice(0, -1).forEach((s, i) => {
                const mid = (s + edges[i + 1]) / 2;
                const old = zones.find((z) => mid >= z.start && mid < z.end);
                if (old && overrides[old.index] !== undefined) remapped[i] = overrides[old.index];
            });
            setOverrides(remapped);
        }
        setCuts(clean);
    }, [cuts.length, duration, zones, overrides]);

    const moveCut = (i, t, snap) => {
        let v = Math.min((cuts[i + 1] ?? duration) - MIN_ZONE, Math.max((cuts[i - 1] ?? 0) + MIN_ZONE, t));
        if (snap && data?.sentence_cuts?.length) {
            const best = data.sentence_cuts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
            if (Math.abs(best - v) < SNAP) v = best;
        }
        const next = [...cuts];
        next[i] = Math.round(v * 1000) / 1000;
        setCuts(next);
        setCutsChanged(true);
    };

    const half = (data?.crop_width_fraction ?? 0.5) / 2;
    const clamp = useCallback((v, h = half) => Math.min(1 - h, Math.max(h, v)), [half]);

    const setZone = (idx, value) => setOverrides((o) => {
        const next = { ...o };
        if (value === undefined) delete next[idx]; else next[idx] = value;
        return next;
    });

    const setMode = (zone, mode) => {
        const cur = overrides[zone.index];
        const x = typeof cur === 'number' ? cur : (cur?.x ?? clamp(zone.suggested_center));
        const y = zone.suggested_center_y ?? 0.5;
        if (mode === 'auto') return setZone(zone.index, undefined);
        if (mode === 'fill') return setZone(zone.index, clamp(x));
        if (mode === 'fit') return setZone(zone.index, { mode: 'fit' });
        if (mode === 'zoom') {
            const w = data?.zoom_default_width ?? 0.75;
            return setZone(zone.index, { mode: 'zoom', x: clamp(x, w / 2), width: w });
        }
        if (mode === 'split') {
            return setZone(zone.index, { top: { x: Math.max(0.25, x - 0.25), y }, bottom: { x: Math.min(0.75, x + 0.25), y } });
        }
        return undefined;
    };

    const adjusted = Object.keys(overrides).length;
    const canSave = (adjusted > 0 || cutsChanged) && !saving && !loading;

    const handleSave = async () => {
        if (!canSave) return;
        setSaving(true);
        setError(null);
        try {
            const r4 = (n) => Number(Number(n).toFixed(4));
            const halfOut = (h) => ({ x: r4(h.x), y: r4(h.y), ...(h.w ? { w: r4(h.w) } : {}) });
            const payload = Object.fromEntries(Object.entries(overrides).map(([k, v]) => {
                let out;
                if (typeof v === 'number') out = r4(v);
                else if (v.mode === 'zoom') out = { mode: 'zoom', x: r4(v.x), width: r4(v.width) };
                else if (v.mode) out = { mode: v.mode };
                else out = { top: halfOut(v.top), bottom: halfOut(v.bottom) };
                return [String(k), out];
            }));
            payload.cuts = cuts;
            const res = await apiJson('/api/clip/reframe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_id: jobId, clip_index: clipIndex, crop_overrides: payload }),
            });
            if (onReframed) onReframed(clipIndex, res);
            onClose();
        } catch (e) {
            setError(e?.message || 'The re-render failed.');
        } finally {
            setSaving(false);
        }
    };

    const jumpTo = (i) => rowRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    return (
        <div className={inline ? 'h-full min-h-0 flex justify-center' : 'fixed inset-0 z-50 bg-black/55 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4'}>
            <div className={inline
                ? 'card w-full max-w-5xl h-full min-h-0 flex flex-col'
                : 'card w-full max-w-3xl max-h-[92vh] sm:max-h-[90vh] flex flex-col rounded-b-none sm:rounded-card animate-sheet-up sm:animate-none'}>
                <div className="flex items-center justify-between p-4 border-b border-rule">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <Crosshair size={18} className="text-brass shrink-0" />
                        <div className="min-w-0">
                            <h2 className="text-base font-medium text-ink lowercase truncate">framing</h2>
                            {clipTitle && <p className="text-xs text-muted truncate">{clipTitle}</p>}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 hover:bg-paper3 rounded-input transition-colors">
                        <X size={18} className="text-muted" />
                    </button>
                </div>

                {/* Zones: the timeline, before the layout of each. */}
                <div className="px-4 py-3 border-b border-rule space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink2 mr-1">{zones.length} zone{zones.length === 1 ? '' : 's'}</span>
                        <button type="button" onClick={() => rezone(data?.sentence_cuts || [])} disabled={loading || !data?.sentence_cuts?.length}
                            className="btn-ghost px-3 py-1.5 text-xs" title="one zone per sentence">
                            <ListTree size={13} /> by sentences
                        </button>
                        <button type="button" onClick={() => rezone(data?.auto_cuts || [])} disabled={loading}
                            className="btn-ghost px-3 py-1.5 text-xs" title="the camera cuts the detector found">
                            <Wand2 size={13} /> camera cuts
                        </button>
                        <button type="button" onClick={() => rezone([])} disabled={loading}
                            className="btn-ghost px-3 py-1.5 text-xs" title="one zone for the whole clip">
                            <Square size={13} /> one zone
                        </button>
                        <span className="text-[11px] text-muted basis-full sm:basis-auto sm:ml-auto">
                            drag a cut · double-click the bar to add · double-click a cut to remove · alt = no snap
                        </span>
                    </div>
                    {!loading && duration > 0 && (
                        <Timeline zones={zones} cuts={cuts} duration={duration} overrides={overrides}
                            sentenceCuts={data?.sentence_cuts || []}
                            onMove={moveCut} onAdd={(t) => rezone([...cuts, t])}
                            onRemove={(i) => rezone(cuts.filter((_, j) => j !== i))} onPick={jumpTo} />
                    )}
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar p-4 space-y-5">
                    {loading && (
                        <div className="flex items-center gap-2 text-sm text-muted py-8 justify-center">
                            <Loader2 size={18} className="animate-spin text-brass" />
                            cutting the clip from source (only the first time)…
                        </div>
                    )}

                    {error && (
                        <div className="flex items-start gap-2 text-xs text-warn border border-warn/40 rounded-input p-3">
                            <AlertCircle size={14} className="shrink-0 mt-0.5" />
                            <span>{error}</span>
                        </div>
                    )}

                    {!loading && zones.map((zone, i) => (
                        <div key={i} ref={(el) => { rowRefs.current[i] = el; }}>
                            <ZoneRow
                                zone={zone}
                                value={overrides[zone.index]}
                                mode={modeOf(overrides[zone.index])}
                                fillWidth={data.crop_width_fraction}
                                splitBox={data.split_box}
                                previewUrl={data.preview_url}
                                playing={playing === zone.index}
                                onPlayToggle={() => setPlaying((p) => (p === zone.index ? null : zone.index))}
                                onMode={(m) => setMode(zone, m)}
                                onValue={(v) => setZone(zone.index, v)}
                                clamp={clamp}
                                canMerge={i < zones.length - 1}
                                onSplit={() => rezone([...cuts, zone.mid])}
                                onMerge={() => rezone(cuts.filter((_, j) => j !== i))}
                            />
                        </div>
                    ))}
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-t border-rule">
                    <span className="text-xs text-muted">
                        {adjusted === 0 && !cutsChanged
                            ? 'nothing changed yet'
                            : `${adjusted} zone${adjusted === 1 ? '' : 's'} with a chosen layout${cutsChanged ? ' · zones changed' : ''}`}
                    </span>
                    <div className="flex items-center gap-2 [&>button]:flex-1 sm:[&>button]:flex-none">
                        <button onClick={onClose} className="btn-quiet py-2 px-4 text-sm">cancel</button>
                        <button onClick={handleSave} disabled={!canSave} className="btn-primary py-2 px-4 text-sm disabled:opacity-40">
                            {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                            {saving ? 're-rendering…' : 'apply framing'}
                        </button>
                    </div>
                </div>
                <div className="sm:hidden safe-bottom" />
            </div>
        </div>
    );
}


// The zone bar: segments coloured by layout, sentence edges as ticks, cuts as
// handles. Everything is local; nothing here asks the server.
function Timeline({ zones, cuts, duration, overrides, sentenceCuts, onMove, onAdd, onRemove, onPick }) {
    const barRef = useRef(null);
    const [drag, setDrag] = useState(null);   // cut index

    const tAt = useCallback((clientX) => {
        const r = barRef.current.getBoundingClientRect();
        return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
    }, [duration]);

    useEffect(() => {
        if (drag === null) return undefined;
        const mv = (e) => onMove(drag, tAt(e.clientX), !e.altKey);
        const up = () => setDrag(null);
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
        return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    }, [drag, tAt, onMove]);

    const pct = (t) => `${(t / duration) * 100}%`;

    return (
        <div className="select-none">
            <div ref={barRef} onDoubleClick={(e) => onAdd(tAt(e.clientX))}
                className="relative h-10 rounded-input overflow-hidden border border-rule bg-paper3 cursor-copy">
                {zones.map((z) => (
                    <button key={z.index} type="button" onClick={() => onPick(z.index)}
                        title={`zone ${z.index + 1} · ${fmt(z.start)}–${fmt(z.end)} · ${modeOf(overrides[z.index])}`}
                        className="absolute inset-y-0 border-r border-black/30 text-[10px] text-ink2 hover:brightness-125 overflow-hidden"
                        style={{ left: pct(z.start), width: pct(z.end - z.start), background: MODE_COLOR[modeOf(overrides[z.index])] }}>
                        {z.end - z.start > duration / 40 ? z.index + 1 : ''}
                    </button>
                ))}
                {sentenceCuts.map((t) => (
                    <span key={`s${t}`} className="absolute bottom-0 h-2 w-px bg-white/40 pointer-events-none" style={{ left: pct(t) }} />
                ))}
                {cuts.map((t, i) => (
                    <div key={`c${i}`}
                        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setDrag(i); }}
                        onDoubleClick={(e) => { e.stopPropagation(); onRemove(i); }}
                        title={`${t.toFixed(2)}s · drag to move · double-click to remove`}
                        className="absolute inset-y-0 -ml-[5px] w-[10px] cursor-ew-resize group z-10"
                        style={{ left: pct(t) }}>
                        <div className={`mx-auto h-full w-[3px] ${drag === i ? 'bg-white' : 'bg-brass group-hover:bg-white'}`} />
                    </div>
                ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted readout mt-1">
                <span>0:00</span><span>{fmt(duration)}</span>
            </div>
        </div>
    );
}


// A frame of the preview at time t (for zones the server has no still for).
function FrameAt({ src, t }) {
    const ref = useRef(null);
    useEffect(() => {
        const v = ref.current;
        if (!v) return undefined;
        const seek = () => { try { v.currentTime = t; } catch { /* not ready */ } };
        if (v.readyState >= 1) seek();
        v.addEventListener('loadedmetadata', seek);
        return () => v.removeEventListener('loadedmetadata', seek);
    }, [t]);
    return <video ref={ref} src={src} muted playsInline preload="auto" className="w-full block pointer-events-none" />;
}


// One zone: its layout picker, and the frame with the window(s) to drag.
function ZoneRow({ zone, value, mode, fillWidth, splitBox, previewUrl, playing, onPlayToggle, onMode, onValue,
                   clamp, canMerge, onSplit, onMerge }) {
    const boxRef = useRef(null);
    const videoRef = useRef(null);
    const [dragging, setDragging] = useState(null);   // null | 'single' | 'top' | 'bottom' | 'top-size' | 'bottom-size'

    useEffect(() => {
        const v = videoRef.current;
        if (!v) return undefined;
        if (!playing) { v.pause(); return undefined; }
        v.currentTime = zone.start;
        v.play().catch(() => {});
        const stopAtEnd = () => { if (v.currentTime >= zone.end) v.pause(); };
        v.addEventListener('timeupdate', stopAtEnd);
        return () => v.removeEventListener('timeupdate', stopAtEnd);
    }, [playing, zone.start, zone.end]);

    const zoomW = mode === 'zoom' ? (value?.width ?? 0.75) : fillWidth;
    const centre = typeof value === 'number' ? value
        : (value?.x ?? clamp(zone.suggested_center, zoomW / 2));

    // A split half is a box with the half's aspect (9:8 on a 9:16 short). Its
    // width can be changed; the render scales the box to fill the half.
    const sb = splitBox || { w: fillWidth, h: 1, y_bias: 0.42 };
    const ratio = sb.h / sb.w;                       // box height per unit width (source fractions)
    const maxW = Math.min(1, 1 / ratio);
    const halfGeom = useCallback((h) => {
        const w = Math.min(maxW, Math.max(0.1, h?.w ?? sb.w));
        const hh = w * ratio;
        const x = Math.min(1 - w / 2, Math.max(w / 2, h?.x ?? 0.5));
        const cy = Math.min(1 - hh * (1 - sb.y_bias), Math.max(hh * sb.y_bias, h?.y ?? 0.5));
        return { w, hh, x, cy, top: cy - hh * sb.y_bias };
    }, [maxW, ratio, sb.w, sb.y_bias]);

    const fractionFromEvent = useCallback((clientX, clientY) => {
        const el = boxRef.current;
        if (!el) return [0.5, 0.5];
        const rect = el.getBoundingClientRect();
        return [(clientX - rect.left) / rect.width, (clientY - rect.top) / rect.height];
    }, []);

    const move = useCallback((which, [f, fy]) => {
        if (which === 'single') {
            if (mode === 'zoom') onValue({ ...value, mode: 'zoom', x: clamp(f, zoomW / 2), width: zoomW });
            else onValue(clamp(f));
            return;
        }
        const base = value && value.top ? value : { top: { x: 0.3, y: 0.5 }, bottom: { x: 0.7, y: 0.5 } };
        if (which.endsWith('-size')) {
            const part = which.split('-')[0];
            const g = halfGeom(base[part]);
            const w = Math.min(maxW, Math.max(0.1, 2 * Math.abs(f - g.x)));
            onValue({ ...base, [part]: { ...base[part], w } });
        } else {
            onValue({ ...base, [which]: { ...base[which], x: f, y: fy } });
        }
    }, [mode, value, onValue, clamp, zoomW, halfGeom, maxW]);

    useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (e) => {
            const p = e.touches ? e.touches[0] : e;
            move(dragging, fractionFromEvent(p.clientX, p.clientY));
        };
        const up = () => setDragging(null);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', up);
        window.addEventListener('touchmove', onMove);
        window.addEventListener('touchend', up);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', up);
            window.removeEventListener('touchmove', onMove);
            window.removeEventListener('touchend', up);
        };
    }, [dragging, fractionFromEvent, move]);

    const startDrag = (which, jump = true) => (e) => {
        e.stopPropagation();
        e.preventDefault();
        setDragging(which);
        if (jump) {
            const p = e.touches ? e.touches[0] : e;
            move(which, fractionFromEvent(p.clientX, p.clientY));
        }
    };

    const win = (c, w, label) => (
        <div onMouseDown={startDrag('single')} onTouchStart={startDrag('single')}
            className={`absolute inset-y-0 border-2 cursor-ew-resize ${mode === 'auto' ? 'border-white/50 border-dashed' : 'border-brass'}`}
            style={{ left: `${(c - w / 2) * 100}%`, width: `${w * 100}%` }}>
            {label && <span className="absolute top-1 left-1 text-[10px] px-1 rounded bg-brass text-brassink lowercase">{label}</span>}
        </div>
    );

    const splitWin = (part) => {
        const g = halfGeom(value[part]);
        return (
            <div key={part} onMouseDown={startDrag(part)} onTouchStart={startDrag(part)}
                className="absolute border-2 border-brass cursor-move bg-brass/5"
                style={{ left: `${(g.x - g.w / 2) * 100}%`, width: `${g.w * 100}%`, top: `${g.top * 100}%`, height: `${g.hh * 100}%` }}>
                <span className="absolute top-1 left-1 text-[10px] px-1 rounded bg-brass text-brassink lowercase">{part}</span>
                <span onMouseDown={startDrag(`${part}-size`, false)} onTouchStart={startDrag(`${part}-size`, false)}
                    title="drag to resize"
                    className="absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-sm bg-brass border border-black/40 cursor-nwse-resize" />
            </div>
        );
    };

    const showsWindow = mode === 'auto' || mode === 'fill' || mode === 'zoom';

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                    <button onClick={onPlayToggle} className="flex items-center gap-1 text-ink2 hover:text-brass transition-colors"
                        title="play this zone with sound">
                        {playing ? <Pause size={13} /> : <Play size={13} />}
                    </button>
                    <span className="readout text-muted truncate">
                        zone {zone.index + 1} · {fmt(zone.start)}–{fmt(zone.end)}
                    </span>
                </div>
                <div className="flex items-center gap-1">
                    {MODES.map((m) => (
                        <button key={m.id} type="button" onClick={() => onMode(m.id)} title={m.hint}
                            className={`px-2.5 py-1 rounded-full border transition-colors ${mode === m.id
                                ? 'border-brass bg-brass/15 text-ink' : 'border-rule2 text-muted hover:text-ink2'}`}>
                            {m.label}
                        </button>
                    ))}
                    <span className="w-px h-4 bg-[color:var(--color-rule-2)] mx-1" />
                    <button type="button" onClick={onSplit} disabled={zone.end - zone.start < 2 * MIN_ZONE}
                        className="p-1 text-muted hover:text-ink2 disabled:opacity-30" title="cut this zone in two">
                        <Scissors size={13} />
                    </button>
                    <button type="button" onClick={onMerge} disabled={!canMerge}
                        className="p-1 text-muted hover:text-ink2 disabled:opacity-30" title="merge with the next zone">
                        <Merge size={13} />
                    </button>
                    {mode !== 'auto' && (
                        <button type="button" onClick={() => onMode('auto')} className="p-1 text-muted hover:text-brass" title="back to automatic">
                            <RotateCcw size={13} />
                        </button>
                    )}
                </div>
            </div>

            <div ref={boxRef} className={`relative overflow-hidden rounded-input select-none border ${mode !== 'auto' ? 'border-brass' : 'border-rule'}`}>
                {playing && previewUrl ? (
                    <video ref={videoRef} src={getApiUrl(previewUrl)} playsInline className="w-full block" />
                ) : zone.thumbnail_url ? (
                    <img src={getApiUrl(zone.thumbnail_url)} alt="" draggable={false} className="w-full block pointer-events-none" />
                ) : previewUrl ? (
                    <FrameAt src={getApiUrl(previewUrl)} t={zone.mid} />
                ) : (
                    <div className="w-full aspect-video bg-paper3" />
                )}

                {showsWindow && mode !== 'auto' && (
                    <>
                        <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none"
                            style={{ width: `${Math.max(0, (centre - zoomW / 2) * 100)}%` }} />
                        <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none"
                            style={{ width: `${Math.max(0, 100 - (centre + zoomW / 2) * 100)}%` }} />
                    </>
                )}
                {showsWindow && win(centre, zoomW, mode === 'zoom' ? 'zoom' : null)}
                {mode === 'split' && value?.top && [splitWin('top'), splitWin('bottom')]}
            </div>

            {mode === 'zoom' && (
                <label className="flex items-center gap-3 text-[11px] text-muted">
                    <span className="shrink-0">zoom</span>
                    <input type="range" min={0.4} max={0.95} step={0.01} value={zoomW}
                        onChange={(e) => {
                            const w = Number(e.target.value);
                            onValue({ mode: 'zoom', width: w, x: clamp(centre, w / 2) });
                        }}
                        className="flex-1 accent-[color:var(--color-accent)]" />
                    <span className="readout w-16 text-right">{Math.round(100 / zoomW)}% · {Math.round(zoomW * 100)}% wide</span>
                </label>
            )}
            {mode === 'fit' && <p className="text-[11px] text-muted">The whole frame, on a blurred copy of itself.</p>}
            {mode === 'split' && (
                <p className="text-[11px] text-muted">Each box is exactly what its half shows: drag to move, the corner to resize (smaller = closer).</p>
            )}
            {mode === 'auto' && <p className="text-[11px] text-muted">Automatic. Drag the window or pick a layout to take over.</p>}
        </div>
    );
}
