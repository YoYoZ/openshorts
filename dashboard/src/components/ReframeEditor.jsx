import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Loader2, Crosshair, RotateCcw, AlertCircle, Play, Pause, Scissors, Merge, ListTree, Wand2 } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiJson } from '../lib/api';

// Manual reframing, zone by zone.
//
// A zone is a stretch of the clip with one layout. Zones start as the scenes
// the detector found (camera cuts); when it finds too few, the user can split
// the clip by sentences, or cut and merge zones by hand. Each zone then gets a
// layout:
//   auto  - what the automatic pass decides
//   fill  - a vertical crop, placed where the rectangle is
//   fit   - the whole frame over a blurred copy of itself
//   zoom  - a wider window of the frame (zoomed in), over a blurred backdrop
//   split - two regions stacked, top and bottom
// Zones left on auto are not sent, so fixing one bad stretch cannot spoil the
// ones the tracker got right.

const fmt = (s) => {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}`;
};

const MODES = [
    { id: 'auto', label: 'auto', hint: 'the automatic camera' },
    { id: 'fill', label: 'fill', hint: 'a vertical crop where the rectangle is' },
    { id: 'fit', label: 'fit', hint: 'the whole frame on a blurred background' },
    { id: 'zoom', label: 'zoom', hint: 'a wider window of the frame, zoomed in' },
    { id: 'split', label: 'split', hint: 'two regions stacked, top and bottom' },
];

// An override value -> its mode.
const modeOf = (v) => {
    if (v === undefined || v === null) return 'auto';
    if (typeof v === 'number') return 'fill';
    if (v.mode) return v.mode;
    if (v.top && v.bottom) return 'split';
    return 'auto';
};

export default function ReframeEditor({ jobId, clipIndex, clipTitle, onClose, onReframed, inline = false }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [data, setData] = useState(null);
    const [overrides, setOverrides] = useState({});   // zone idx -> value (see modeOf)
    const [cuts, setCuts] = useState(null);           // zone edges in clip seconds; null = detected scenes
    const [cutsChanged, setCutsChanged] = useState(false);
    const [playing, setPlaying] = useState(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async (wantCuts, carry) => {
        setLoading(true);
        setError(null);
        try {
            const q = wantCuts ? `?cuts=${encodeURIComponent(wantCuts.join(','))}` : '';
            const res = await apiJson(`/api/clip/${jobId}/${clipIndex}/scenes${q}`);
            setData(res);
            if (carry) {
                // Re-zoned: each new zone keeps the layout of the old zone
                // its middle falls in.
                const next = {};
                res.scenes.forEach((z) => {
                    const mid = (z.start + z.end) / 2;
                    const old = carry.zones.find((o) => mid >= o.start && mid < o.end);
                    if (old && carry.overrides[old.index] !== undefined) next[z.index] = carry.overrides[old.index];
                });
                setOverrides(next);
            } else {
                // Start from what is applied: a re-render rebuilds from source
                // with only what it receives, so opening blank would discard
                // every earlier adjustment on the next save.
                const saved = res.saved_overrides || {};
                setOverrides(Object.fromEntries(Object.entries(saved).map(([k, v]) => [Number(k), v])));
                setCuts(res.saved_cuts?.length ? res.saved_cuts : null);
            }
        } catch (e) {
            setError(e?.message || 'Could not read the scenes of this clip.');
        } finally {
            setLoading(false);
        }
    }, [jobId, clipIndex]);

    useEffect(() => { load(null, null); }, [load]);

    const zones = data?.scenes || [];
    const rezone = (nextCuts) => {
        const clean = nextCuts ? [...new Set(nextCuts.map((c) => Math.round(c * 1000) / 1000))].sort((a, b) => a - b) : null;
        setCuts(clean && clean.length ? clean : null);
        setCutsChanged(true);
        setPlaying(null);
        load(clean && clean.length ? clean : null, { zones, overrides });
    };
    const edgesOf = () => zones.slice(0, -1).map((z) => z.end);
    const splitBySentences = () => rezone(data?.sentence_cuts || []);
    const splitZone = (z) => rezone([...edgesOf(), (z.start + z.end) / 2]);
    const mergeWithNext = (z) => rezone(edgesOf().filter((e) => Math.abs(e - z.end) > 0.01));

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
            return setZone(zone.index, { top: { x: clamp(x - 0.2), y }, bottom: { x: clamp(x + 0.2), y } });
        }
        return undefined;
    };

    const adjusted = Object.keys(overrides).length;
    const canSave = (adjusted > 0 || cutsChanged) && !saving;

    const handleSave = async () => {
        if (!canSave) return;
        setSaving(true);
        setError(null);
        try {
            const r4 = (n) => Number(Number(n).toFixed(4));
            const payload = Object.fromEntries(Object.entries(overrides).map(([k, v]) => {
                let out;
                if (typeof v === 'number') out = r4(v);
                else if (v.mode === 'zoom') out = { mode: 'zoom', x: r4(v.x), width: r4(v.width) };
                else if (v.mode) out = { mode: v.mode };
                else out = { top: { x: r4(v.top.x), y: r4(v.top.y) }, bottom: { x: r4(v.bottom.x), y: r4(v.bottom.y) } };
                return [String(k), out];
            }));
            if (cuts?.length) payload.cuts = cuts;
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

                {/* Zones: how the clip is divided, before the layout of each. */}
                <div className="px-4 py-3 border-b border-rule flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink2 mr-1">
                        {zones.length} zone{zones.length === 1 ? '' : 's'}
                        <span className="text-muted"> · {cuts ? 'cut by hand' : 'camera cuts found automatically'}</span>
                    </span>
                    <button type="button" onClick={splitBySentences} disabled={loading || !data?.sentence_cuts?.length}
                        className="btn-ghost px-3 py-1.5 text-xs" title="one zone per sentence">
                        <ListTree size={13} /> split by sentences
                    </button>
                    {cuts && (
                        <button type="button" onClick={() => rezone(null)} disabled={loading}
                            className="btn-ghost px-3 py-1.5 text-xs" title="back to the camera cuts the detector found">
                            <Wand2 size={13} /> automatic zones
                        </button>
                    )}
                    <span className="text-[11px] text-muted basis-full sm:basis-auto sm:ml-auto">
                        cut or merge single zones from their rows
                    </span>
                </div>

                <div className="flex-1 overflow-y-auto overscroll-contain custom-scrollbar p-4 space-y-5">
                    {loading && (
                        <div className="flex items-center gap-2 text-sm text-muted py-8 justify-center">
                            <Loader2 size={18} className="animate-spin text-brass" />
                            reading the zones…
                        </div>
                    )}

                    {error && (
                        <div className="flex items-start gap-2 text-xs text-warn border border-warn/40 rounded-input p-3">
                            <AlertCircle size={14} className="shrink-0 mt-0.5" />
                            <span>{error}</span>
                        </div>
                    )}

                    {!loading && zones.map((zone, i) => (
                        <ZoneRow
                            key={`${zone.index}-${zone.start}`}
                            zone={zone}
                            value={overrides[zone.index]}
                            mode={modeOf(overrides[zone.index])}
                            fillWidth={data.crop_width_fraction}
                            previewUrl={data.preview_url}
                            playing={playing === zone.index}
                            onPlayToggle={() => setPlaying((p) => (p === zone.index ? null : zone.index))}
                            onMode={(m) => setMode(zone, m)}
                            onValue={(v) => setZone(zone.index, v)}
                            clamp={clamp}
                            canMerge={i < zones.length - 1}
                            onSplit={() => splitZone(zone)}
                            onMerge={() => mergeWithNext(zone)}
                        />
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


// One zone: its layout picker, and the frame with the window(s) to drag.
// While it plays, the frame is the uncropped preview seeked to this zone, so
// the window can be judged against moving pictures and sound.
function ZoneRow({ zone, value, mode, fillWidth, previewUrl, playing, onPlayToggle, onMode, onValue,
                   clamp, canMerge, onSplit, onMerge }) {
    const boxRef = useRef(null);
    const videoRef = useRef(null);
    const [dragging, setDragging] = useState(null);   // null | 'single' | 'top' | 'bottom'

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
    // What the window shows: the chosen centre, else the suggestion (biggest face).
    const centre = typeof value === 'number' ? value
        : (value?.x ?? clamp(zone.suggested_center, zoomW / 2));

    const fractionFromEvent = useCallback((clientX) => {
        const el = boxRef.current;
        if (!el) return 0.5;
        const rect = el.getBoundingClientRect();
        return (clientX - rect.left) / rect.width;
    }, []);

    const move = useCallback((which, f) => {
        if (which === 'single') {
            if (mode === 'zoom') onValue({ ...value, mode: 'zoom', x: clamp(f, zoomW / 2), width: zoomW });
            else onValue(clamp(f));   // dragging an auto zone makes it a fill
        } else {
            const base = value && value.top ? value : { top: { x: 0.3, y: 0.5 }, bottom: { x: 0.7, y: 0.5 } };
            onValue({ ...base, [which]: { x: clamp(f), y: base[which]?.y ?? 0.5 } });
        }
    }, [mode, value, onValue, clamp, zoomW]);

    useEffect(() => {
        if (!dragging) return undefined;
        const onMove = (e) => {
            const x = e.touches ? e.touches[0].clientX : e.clientX;
            move(dragging, fractionFromEvent(x));
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

    const startDrag = (which) => (e) => {
        e.stopPropagation();
        setDragging(which);
        const x = e.touches ? e.touches[0].clientX : e.clientX;
        move(which, fractionFromEvent(x));
    };

    const win = (c, w, label, which) => (
        <div key={which} onMouseDown={startDrag(which)} onTouchStart={startDrag(which)}
            className={`absolute inset-y-0 border-2 cursor-ew-resize ${mode === 'auto' ? 'border-white/50 border-dashed' : 'border-brass'}`}
            style={{ left: `${(c - w / 2) * 100}%`, width: `${w * 100}%` }}>
            {label && (
                <span className="absolute top-1 left-1 text-[10px] px-1 rounded bg-brass text-brassink lowercase">{label}</span>
            )}
        </div>
    );

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
                    <button type="button" onClick={onSplit} disabled={zone.end - zone.start < 1}
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
                ) : (
                    <div className="w-full aspect-video bg-paper3" />
                )}

                {/* Outside the kept window is dimmed: what stays bright is what survives. */}
                {showsWindow && mode !== 'auto' && (
                    <>
                        <div className="absolute inset-y-0 left-0 bg-black/65 pointer-events-none"
                            style={{ width: `${Math.max(0, (centre - zoomW / 2) * 100)}%` }} />
                        <div className="absolute inset-y-0 right-0 bg-black/65 pointer-events-none"
                            style={{ width: `${Math.max(0, 100 - (centre + zoomW / 2) * 100)}%` }} />
                    </>
                )}
                {showsWindow && win(centre, zoomW, mode === 'zoom' ? 'zoom' : null, 'single')}
                {mode === 'split' && value?.top && [
                    win(value.top.x, fillWidth, 'top', 'top'),
                    win(value.bottom.x, fillWidth, 'bottom', 'bottom'),
                ]}
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
                <p className="text-[11px] text-muted">Two regions stacked: <strong>top</strong> above, <strong>bottom</strong> below. Drag each onto its person.</p>
            )}
            {mode === 'auto' && <p className="text-[11px] text-muted">Automatic. Drag the window or pick a layout to take over.</p>}
        </div>
    );
}
