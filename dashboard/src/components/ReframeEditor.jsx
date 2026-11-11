import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X, Loader2, Crosshair, RotateCcw, AlertCircle, Play, Pause, Scissors, Merge, ListTree, Wand2, Square } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiJson } from '../lib/api';

// Manual reframing laid out like a non-linear editor.
//
//   viewport  - the uncropped source at the playhead, with the boxes of the
//               zone under the playhead to drag / resize
//   output    - the short as it will look, drawn live from the same video
//   timeline  - zones coloured by layout, sentence ticks, cuts to drag (the
//               viewport follows the cut), a playhead to scrub
//
// The server is asked once (clip cut, scenes, preview: cached per clip);
// everything after that is local. Layouts per zone:
//   auto  - what the automatic pass decides (output shows the face-centred crop)
//   fill  - a vertical crop where the window is
//   fit   - the whole frame over a blurred copy of itself
//   zoom  - a wider window over a blurred backdrop
//   split - two boxes stacked; each box is scaled to fill its half
// Zones left on auto are not sent.

const fmt = (s, frac = false) => {
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return frac ? `${m}:${r.toFixed(2).padStart(5, '0')}` : `${m}:${String(Math.floor(r)).padStart(2, '0')}`;
};

const MODES = [
    { id: 'auto', label: 'auto', key: '1', hint: 'the automatic camera', color: 'rgba(255,255,255,0.12)' },
    { id: 'fill', label: 'fill', key: '2', hint: 'a vertical crop where the window is', color: 'rgba(214,170,90,0.60)' },
    { id: 'fit', label: 'fit', key: '3', hint: 'the whole frame on a blurred background', color: 'rgba(96,165,250,0.55)' },
    { id: 'zoom', label: 'zoom', key: '4', hint: 'a wider window of the frame, zoomed in', color: 'rgba(167,139,250,0.60)' },
    { id: 'split', label: 'split', key: '5', hint: 'two boxes stacked, top and bottom', color: 'rgba(52,211,153,0.55)' },
];
const MODE_COLOR = Object.fromEntries(MODES.map((m) => [m.id, m.color]));

const MIN_ZONE = 0.3;     // seconds
const SNAP = 0.3;         // seconds: a dragged cut snaps to a sentence edge this close
const STEP = 1 / 30;

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

// One split half: a box with the half's aspect, placed by a point it keeps a
// little above its middle (split_layout.split_geometry does the same).
const halfGeom = (h, sb) => {
    const ratio = sb.h / sb.w;
    const maxW = Math.min(1, 1 / ratio);
    const w = Math.min(maxW, Math.max(0.1, h?.w ?? sb.w));
    const hh = w * ratio;
    const x = Math.min(1 - w / 2, Math.max(w / 2, h?.x ?? 0.5));
    const cy = Math.min(1 - hh * (1 - sb.y_bias), Math.max(hh * sb.y_bias, h?.y ?? 0.5));
    return { w, hh, x, cy, top: cy - hh * sb.y_bias, maxW };
};

// The short, drawn from the source video at its current frame.
function drawOutput(ctx, v, W, H, mode, value, zone, geo) {
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!vw || !vh) return;
    const cover = () => {
        const s = Math.max(W / vw, H / vh);
        ctx.filter = 'blur(14px) brightness(0.65)';
        ctx.drawImage(v, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s);
        ctx.filter = 'none';
    };
    const band = (sx, sw) => {           // full-height window, fitted to the width
        const h = vh * (W / sw);
        ctx.drawImage(v, sx, 0, sw, vh, 0, (H - h) / 2, W, h);
    };
    if (mode === 'fit') { cover(); band(0, vw); return; }
    if (mode === 'zoom') {
        const w = value?.width ?? 0.75;
        const cx = Math.min(1 - w / 2, Math.max(w / 2, value?.x ?? 0.5));
        cover(); band((cx - w / 2) * vw, w * vw); return;
    }
    if (mode === 'split' && value?.top) {
        ['top', 'bottom'].forEach((part, i) => {
            const g = halfGeom(value[part], geo.sb);
            ctx.drawImage(v, (g.x - g.w / 2) * vw, g.top * vh, g.w * vw, g.hh * vh, 0, (i * H) / 2, W, H / 2);
        });
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, H / 2 - 1, W, 2);
        return;
    }
    const cw = geo.cwf;
    const c = typeof value === 'number' ? value : (zone?.suggested_center ?? 0.5);
    const cx = Math.min(1 - cw / 2, Math.max(cw / 2, c));
    ctx.drawImage(v, (cx - cw / 2) * vw, 0, cw * vw, vh, 0, 0, W, H);
}

export default function ReframeEditor({ jobId, clipIndex, clipTitle, onClose, onReframed, inline = false }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [data, setData] = useState(null);
    const [overrides, setOverrides] = useState({});   // zone idx -> value (see modeOf)
    const [cuts, setCuts] = useState([]);             // zone edges, clip seconds
    const [cutsChanged, setCutsChanged] = useState(false);
    const [rendering, setRendering] = useState(false);
    const renderLock = useRef(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const [t, setT] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [selCut, setSelCut] = useState(null);      // index of the cut picked on the timeline (merge removes it)
    const [dragging, setDragging] = useState(null);  // viewport drag: 'single' | 'top' | 'bottom' | 'top-size' | 'bottom-size'

    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const viewRef = useRef(null);

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiJson(`/api/clip/${jobId}/${clipIndex}/scenes`);
                if (!alive) return;
                setData(res);
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
    const cwf = data?.crop_width_fraction ?? 0.316;
    const srcAspect = data?.source_width && data?.source_height ? data.source_width / data.source_height : 16 / 9;
    const outAspect = cwf * srcAspect;               // 9/16 for a 9:16 short
    const sb = useMemo(() => data?.split_box || { w: cwf, h: 1, y_bias: 0.42 }, [data, cwf]);

    const zones = useMemo(() => {
        if (!data) return [];
        const edges = [0, ...cuts, duration];
        return edges.slice(0, -1).map((start, i) => {
            const end = edges[i + 1];
            const mid = (start + end) / 2;
            const near = data.scenes.find((z) => mid >= z.start && mid < z.end) || data.scenes[data.scenes.length - 1];
            return {
                index: i, start, end, mid,
                suggested_center: near?.suggested_center ?? 0.5,
                suggested_center_y: near?.suggested_center_y ?? 0.5,
            };
        });
    }, [data, cuts, duration]);

    const cur = zones.find((z) => t >= z.start && t < z.end) || zones[zones.length - 1];
    const curValue = cur ? overrides[cur.index] : undefined;
    const curMode = modeOf(curValue);

    // ---- playback -------------------------------------------------------
    const seek = useCallback((tt) => {
        const v = videoRef.current;
        const c = Math.min(Math.max(0, tt), Math.max(0, duration - 0.01));
        if (v) v.currentTime = c;
        setT(c);
    }, [duration]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) { v.play().catch(() => {}); setPlaying(true); } else { v.pause(); setPlaying(false); }
    }, []);

    // Draw the output every frame; while playing, the playhead follows the video.
    const drawRef = useRef(null);
    drawRef.current = { zones, overrides, sb, cwf };
    useEffect(() => {
        let raf;
        const loop = () => {
            const v = videoRef.current;
            const cv = canvasRef.current;
            if (v && cv) {
                const s = drawRef.current;
                const now = v.currentTime;
                if (!v.paused) setT(now);
                const z = s.zones.find((q) => now >= q.start && now < q.end) || s.zones[s.zones.length - 1];
                const val = z ? s.overrides[z.index] : undefined;
                drawOutput(cv.getContext('2d'), v, cv.width, cv.height, modeOf(val), val, z, s);
            }
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, []);

    // ---- zones ----------------------------------------------------------
    const rezone = useCallback((next) => {
        const clean = tidy(next, duration);
        setCutsChanged(true);
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

    const moveCut = useCallback((i, tt, snap) => {
        let v = Math.min((cuts[i + 1] ?? duration) - MIN_ZONE, Math.max((cuts[i - 1] ?? 0) + MIN_ZONE, tt));
        if (snap && data?.sentence_cuts?.length) {
            const best = data.sentence_cuts.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
            if (Math.abs(best - v) < SNAP) v = best;
        }
        v = Math.round(v * 1000) / 1000;
        const next = [...cuts];
        next[i] = v;
        setCuts(next);
        setCutsChanged(true);
        seek(v);                         // the viewport shows the first frame after the cut
    }, [cuts, duration, data, seek]);

    const splitAtPlayhead = useCallback(() => { rezone([...cuts, t]); setSelCut(null); }, [rezone, cuts, t]);
    const mergeAt = useCallback((i) => {
        if (i === null || i === undefined || i < 0 || i >= cuts.length) return;
        rezone(cuts.filter((_, j) => j !== i));
        setSelCut(null);
    }, [rezone, cuts]);

    const setZone = useCallback((idx, value) => setOverrides((o) => {
        const next = { ...o };
        if (value === undefined) delete next[idx]; else next[idx] = value;
        return next;
    }), []);

    const clamp = useCallback((v, h = cwf / 2) => Math.min(1 - h, Math.max(h, v)), [cwf]);

    const setMode = useCallback((zone, mode) => {
        if (!zone) return;
        const was = overrides[zone.index];
        const x = typeof was === 'number' ? was : (was?.x ?? clamp(zone.suggested_center));
        const y = zone.suggested_center_y ?? 0.5;
        if (mode === 'auto') setZone(zone.index, undefined);
        else if (mode === 'fill') setZone(zone.index, clamp(x));
        else if (mode === 'fit') setZone(zone.index, { mode: 'fit' });
        else if (mode === 'zoom') {
            const w = data?.zoom_default_width ?? 0.75;
            setZone(zone.index, { mode: 'zoom', x: clamp(x, w / 2), width: w });
        } else if (mode === 'split') {
            setZone(zone.index, { top: { x: Math.max(0.25, x - 0.25), y }, bottom: { x: Math.min(0.75, x + 0.25), y } });
        }
    }, [overrides, clamp, setZone, data]);

    // ---- keyboard -------------------------------------------------------
    useEffect(() => {
        const onKey = (e) => {
            if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
            if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
            else if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitAtPlayhead(); }
            else if ((e.key === 'Delete' || e.key === 'Backspace') && selCut !== null) { e.preventDefault(); mergeAt(selCut); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(t - (e.shiftKey ? 1 : STEP)); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); seek(t + (e.shiftKey ? 1 : STEP)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); const p = [...cuts].reverse().find((c) => c < t - 0.01); seek(p ?? 0); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); const n = cuts.find((c) => c > t + 0.01); if (n !== undefined) seek(n); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [togglePlay, splitAtPlayhead, seek, t, cuts, selCut, mergeAt]);

    // ---- viewport dragging ---------------------------------------------
    const frac = useCallback((e) => {
        const r = viewRef.current.getBoundingClientRect();
        const p = e.touches ? e.touches[0] : e;
        return [(p.clientX - r.left) / r.width, (p.clientY - r.top) / r.height];
    }, []);

    const applyDrag = useCallback((which, [f, fy]) => {
        if (!cur) return;
        const value = overrides[cur.index];
        const mode = modeOf(value);
        if (which === 'single') {
            if (mode === 'zoom') {
                const w = value?.width ?? 0.75;
                setZone(cur.index, { mode: 'zoom', width: w, x: clamp(f, w / 2) });
            } else setZone(cur.index, clamp(f));      // dragging an auto window makes it a fill
            return;
        }
        const base = value?.top ? value : { top: { x: 0.3, y: 0.5 }, bottom: { x: 0.7, y: 0.5 } };
        if (which.endsWith('-size')) {
            const part = which.split('-')[0];
            const g = halfGeom(base[part], sb);
            setZone(cur.index, { ...base, [part]: { ...base[part], w: Math.min(g.maxW, Math.max(0.1, 2 * Math.abs(f - g.x))) } });
        } else {
            setZone(cur.index, { ...base, [which]: { ...base[which], x: f, y: fy } });
        }
    }, [cur, overrides, setZone, clamp, sb]);

    useEffect(() => {
        if (!dragging) return undefined;
        const mv = (e) => applyDrag(dragging, frac(e));
        const up = () => setDragging(null);
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
        return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    }, [dragging, applyDrag, frac]);

    const grab = (which, jump = true) => (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (videoRef.current && !videoRef.current.paused) togglePlay();
        setDragging(which);
        if (jump) applyDrag(which, frac(e));
    };

    // ---- save -----------------------------------------------------------
    const adjusted = Object.keys(overrides).length;
    const canSave = (adjusted > 0 || cutsChanged) && !loading;

    const handleSave = () => {
        if (!canSave || renderLock.current) return;
        renderLock.current = true;
        setRendering(true);
        setError(null);
        const run = async () => {
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
            if (alive.current && inline) setCutsChanged(false);   // the workspace tab stays open
            else if (alive.current) onClose();
        } catch (e) {
            if (alive.current) setError(e?.message || 'The re-render failed.');
        } finally {
            renderLock.current = false;
            if (alive.current) setRendering(false);
          }
        };
        void run();
    };

    // ---- render ---------------------------------------------------------
    const OUT_W = 270;
    const winW = curMode === 'zoom' ? (curValue?.width ?? 0.75) : cwf;
    const winC = typeof curValue === 'number' ? curValue : clamp(curValue?.x ?? cur?.suggested_center ?? 0.5, winW / 2);
    const showsWindow = curMode === 'auto' || curMode === 'fill' || curMode === 'zoom';

    return (
        <div className={inline ? 'h-full min-h-0 flex justify-center' : 'fixed inset-0 z-50 bg-black/55 backdrop-blur-md flex items-center justify-center p-0 sm:p-4'}>
            <div className={inline ? 'card w-full max-w-6xl h-full min-h-0 flex flex-col' : 'card w-full max-w-6xl h-full sm:h-[92vh] flex flex-col'}>
                <div className="flex items-center justify-between px-4 py-3 border-b border-rule">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <Crosshair size={18} className="text-brass shrink-0" />
                        <h2 className="text-base font-medium text-ink lowercase">framing</h2>
                        {clipTitle && <p className="text-xs text-muted truncate">{clipTitle}</p>}
                    </div>
                    <button onClick={onClose} className="p-1.5 hover:bg-paper3 rounded-input transition-colors">
                        <X size={18} className="text-muted" />
                    </button>
                </div>

                {loading && (
                    <div className="flex-1 flex items-center gap-2 text-sm text-muted justify-center">
                        <Loader2 size={18} className="animate-spin text-brass" />
                        cutting the clip from source (only the first time per clip)…
                    </div>
                )}
                {error && (
                    <div className="m-4 flex items-start gap-2 text-xs text-warn border border-warn/40 rounded-input p-3">
                        <AlertCircle size={14} className="shrink-0 mt-0.5" />
                        <span>{error}</span>
                    </div>
                )}

                {!loading && data && (
                    <>
                        {/* viewport + output */}
                        <div className="flex-1 min-h-0 flex gap-4 p-4">
                            <div className="flex-1 min-w-0 flex items-center justify-center">
                                <div ref={viewRef} className="relative w-full select-none bg-black rounded-input overflow-hidden"
                                    style={{ aspectRatio: `${srcAspect}`, maxHeight: '100%', maxWidth: `calc((100vh - 360px) * ${srcAspect})` }}>
                                    <video ref={videoRef} src={getApiUrl(data.preview_url)} playsInline preload="auto"
                                        onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)}
                                        onLoadedMetadata={() => seek(0)}
                                        className="absolute inset-0 w-full h-full object-contain" />
                                    {showsWindow && curMode !== 'auto' && (
                                        <>
                                            <div className="absolute inset-y-0 left-0 bg-black/60 pointer-events-none" style={{ width: `${Math.max(0, (winC - winW / 2) * 100)}%` }} />
                                            <div className="absolute inset-y-0 right-0 bg-black/60 pointer-events-none" style={{ width: `${Math.max(0, 100 - (winC + winW / 2) * 100)}%` }} />
                                        </>
                                    )}
                                    {showsWindow && (
                                        <div onPointerDown={grab('single')}
                                            className={`absolute inset-y-0 border-2 cursor-ew-resize ${curMode === 'auto' ? 'border-white/50 border-dashed' : 'border-brass'}`}
                                            style={{ left: `${(winC - winW / 2) * 100}%`, width: `${winW * 100}%` }} />
                                    )}
                                    {curMode === 'split' && curValue?.top && ['top', 'bottom'].map((part) => {
                                        const g = halfGeom(curValue[part], sb);
                                        return (
                                            <div key={part} onPointerDown={grab(part)}
                                                className="absolute border-2 border-brass cursor-move bg-brass/5"
                                                style={{ left: `${(g.x - g.w / 2) * 100}%`, width: `${g.w * 100}%`, top: `${g.top * 100}%`, height: `${g.hh * 100}%` }}>
                                                <span className="absolute top-1 left-1 text-[10px] px-1 rounded bg-brass text-brassink lowercase">{part}</span>
                                                <span onPointerDown={grab(`${part}-size`, false)} title="drag to resize"
                                                    className="absolute -right-1.5 -bottom-1.5 w-4 h-4 rounded-sm bg-brass border border-black/40 cursor-nwse-resize" />
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                            <div className="shrink-0 flex flex-col items-center gap-2 order-first">
                                <canvas ref={canvasRef} width={OUT_W} height={Math.round(OUT_W / outAspect)}
                                    className="rounded-input border border-rule bg-black"
                                    style={{ width: OUT_W, maxHeight: 'calc(100vh - 380px)', objectFit: 'contain' }} />
                                <span className="text-[10px] text-muted readout">output · live</span>
                            </div>
                        </div>

                        {/* transport + zone controls */}
                        <div className="px-4 pb-2 flex flex-wrap items-center gap-2 text-xs">
                            <button onClick={togglePlay} className="btn-ghost px-2.5 py-1.5" title="play / pause (space)">
                                {playing ? <Pause size={14} /> : <Play size={14} />}
                            </button>
                            <span className="readout text-ink2 w-28">{fmt(t, true)} / {fmt(duration)}</span>
                            <span className="text-muted">zone {cur ? cur.index + 1 : '-'}/{zones.length}</span>
                            <div className="flex items-center gap-1 ml-1">
                                {MODES.map((m) => (
                                    <button key={m.id} type="button" onClick={() => setMode(cur, m.id)} title={m.hint}
                                        className={`px-2.5 py-1 rounded-full border transition-colors ${curMode === m.id
                                            ? 'border-brass bg-brass/15 text-ink' : 'border-rule2 text-muted hover:text-ink2'}`}>
                                        <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: m.color }} />
                                        {m.label}
                                    </button>
                                ))}
                            </div>
                            {curMode === 'zoom' && (
                                <input type="range" min={0.4} max={0.95} step={0.01} value={curValue?.width ?? 0.75}
                                    onChange={(e) => { const w = Number(e.target.value); setZone(cur.index, { mode: 'zoom', width: w, x: clamp(winC, w / 2) }); }}
                                    className="w-28 accent-[color:var(--color-accent)]" title="zoom" />
                            )}
                            <span className="w-px h-4 bg-[color:var(--color-rule-2)] mx-1" />
                            <button type="button" onClick={splitAtPlayhead} className="btn-ghost px-2.5 py-1.5" title="cut at the playhead (S)">
                                <Scissors size={13} /> cut
                            </button>
                            <button type="button" disabled={selCut === null}
                                onClick={() => mergeAt(selCut)}
                                className="btn-ghost px-2.5 py-1.5 disabled:opacity-30"
                                title={selCut === null ? 'click a cut on the timeline first' : 'remove the selected cut, joining its two zones (Delete)'}>
                                <Merge size={13} /> merge
                            </button>
                            {curMode !== 'auto' && (
                                <button type="button" onClick={() => setMode(cur, 'auto')} className="p-1 text-muted hover:text-brass" title="back to automatic">
                                    <RotateCcw size={13} />
                                </button>
                            )}
                            <div className="ml-auto flex items-center gap-1">
                                <button type="button" onClick={() => rezone(data.sentence_cuts || [])} disabled={!data.sentence_cuts?.length}
                                    className="btn-quiet px-2 py-1 text-xs" title="one zone per sentence"><ListTree size={12} /> sentences</button>
                                <button type="button" onClick={() => rezone(data.auto_cuts || [])}
                                    className="btn-quiet px-2 py-1 text-xs" title="the camera cuts the detector found"><Wand2 size={12} /> camera cuts</button>
                                <button type="button" onClick={() => rezone([])}
                                    className="btn-quiet px-2 py-1 text-xs" title="one zone for the whole clip"><Square size={12} /> one zone</button>
                            </div>
                        </div>

                        <div className="px-4 pb-3">
                            <Timeline zones={zones} cuts={cuts} duration={duration} overrides={overrides} t={t}
                                sentenceCuts={data.sentence_cuts || []}
                                onSeek={(tt) => { if (videoRef.current && !videoRef.current.paused) togglePlay(); seek(tt); }}
                                onMove={moveCut} selected={selCut} onSelect={setSelCut}
                                onRemove={mergeAt} />
                            <p className="mt-1.5 text-[10px] text-muted">
                                space play · S cut at playhead · click a cut, then merge (or Delete) · drag a cut (alt: no snap) · ←/→ frame (shift 1 s) · ↑/↓ previous/next cut
                            </p>
                        </div>
                    </>
                )}

                <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-rule">
                    <span className="text-xs text-muted">
                        {adjusted === 0 && !cutsChanged
                            ? 'nothing changed yet'
                            : `${zones.length} zones · ${adjusted} with a chosen layout${cutsChanged ? ' · cuts changed' : ''}`}
                    </span>
                    <div className="flex items-center gap-2">
                        <button onClick={onClose} className="btn-quiet py-2 px-4 text-sm">cancel</button>
                        {rendering && <span className="text-xs text-muted">rendering in background</span>}
                        <button onClick={handleSave} disabled={!canSave || rendering} title={rendering ? 'a re-render is already running for this clip' : undefined} className="btn-primary py-2 px-4 text-sm disabled:opacity-40">
                            {rendering ? <Loader2 size={16} className="animate-spin" /> : null}
                            apply framing
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}


// Zones coloured by layout, sentence ticks, draggable cuts, a scrubbable playhead.
function Timeline({ zones, cuts, duration, overrides, t, sentenceCuts, onSeek, onMove, onRemove, selected, onSelect }) {
    const barRef = useRef(null);
    const [drag, setDrag] = useState(null);   // cut index | 'head'

    const tAt = useCallback((clientX) => {
        const r = barRef.current.getBoundingClientRect();
        return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
    }, [duration]);

    useEffect(() => {
        if (drag === null) return undefined;
        const mv = (e) => (drag === 'head' ? onSeek(tAt(e.clientX)) : onMove(drag, tAt(e.clientX), !e.altKey));
        const up = () => setDrag(null);
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
        return () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    }, [drag, tAt, onMove, onSeek]);

    const pct = (x) => `${(x / duration) * 100}%`;

    return (
        <div ref={barRef} className="relative h-14 rounded-input border border-rule bg-paper3 select-none cursor-text"
            onPointerDown={(e) => { e.preventDefault(); setDrag('head'); onSelect(null); onSeek(tAt(e.clientX)); }}>
            {zones.map((z) => (
                <div key={z.index}
                    className="absolute top-0 bottom-3 border-r border-black/40 text-[10px] text-ink2 px-1 overflow-hidden pointer-events-none"
                    style={{ left: pct(z.start), width: pct(z.end - z.start), background: MODE_COLOR[modeOf(overrides[z.index])] }}>
                    {z.end - z.start > duration / 30 ? z.index + 1 : ''}
                </div>
            ))}
            {sentenceCuts.map((s) => (
                <span key={`s${s}`} className="absolute bottom-0 h-3 w-px bg-white/45 pointer-events-none" style={{ left: pct(s) }} />
            ))}
            {cuts.map((c, i) => (
                <div key={`c${i}`}
                    onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setDrag(i); onSelect(i); onMove(i, c, false); }}
                    onDoubleClick={(e) => { e.stopPropagation(); onRemove(i); }}
                    title={`${c.toFixed(2)} s · drag to move · double-click to remove`}
                    className="absolute top-0 bottom-3 -ml-[6px] w-[12px] cursor-ew-resize group z-10"
                    style={{ left: pct(c) }}>
                    <div className={`mx-auto h-full rounded ${selected === i ? 'w-[5px] bg-white shadow-[0_0_0_2px_rgba(214,170,90,0.9)]' : `w-[3px] ${drag === i ? 'bg-white' : 'bg-brass group-hover:bg-white'}`}`} />
                </div>
            ))}
            {/* the playhead: grab the line or its head and drag */}
            <div onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); setDrag('head'); onSelect(null); }}
                className="absolute -top-2 -bottom-1 -ml-[7px] w-[14px] z-[5] cursor-grab active:cursor-grabbing"
                style={{ left: pct(t) }}>
                <div className="mx-auto h-full w-[2px] bg-red-500" />
                <div className="absolute top-0 left-[2px] w-[10px] h-[10px] rotate-45 bg-red-500" />
            </div>
        </div>
    );
}
