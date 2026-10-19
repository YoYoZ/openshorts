import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown, Wand2, Play, AlertTriangle, Check } from 'lucide-react';
import { getApiUrl } from '../config';
import { apiFetch } from '../lib/api';
import { SliderField, ToggleChip } from './TypographyControls';

// Workspace "Audio" tab: find clipping, build an effect chain from built-in
// effects and the VST3/AU plugins installed here (audio_fx.py), listen A/B,
// apply it to the clip as its outermost layer.

let effectsPromise = null;
function loadEffects() {
    if (!effectsPromise) {
        effectsPromise = apiFetch('/api/audio/effects').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    return effectsPromise;
}
const pluginParamCache = {};
function loadPluginParams(path) {
    if (!pluginParamCache[path]) {
        pluginParamCache[path] = apiFetch(`/api/audio/plugin?path=${encodeURIComponent(path)}`)
            .then(async (r) => {
                const body = await r.json();
                if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
                return body;
            });
        pluginParamCache[path].catch(() => { delete pluginParamCache[path]; });
    }
    return pluginParamCache[path];
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtDb = (v, unit = 'dB') => (v === null || v === undefined ? '—' : `${v.toFixed(1)} ${unit}`);
const niceName = (n) => String(n).replace(/_/g, ' ');

function Stats({ title, a }) {
    if (!a) return null;
    return (
        <div className="flex-1 min-w-0 rounded-input border border-rule px-3 py-2">
            <p className="eyebrow mb-1">{title}</p>
            <p className="text-xs text-ink2 tabular-nums">peak {fmtDb(a.peak_db)} · {fmtDb(a.lufs, 'LUFS')}</p>
            <p className={`text-xs mt-0.5 ${a.clipping ? 'text-warn' : 'text-ok'}`}>
                {a.clipping ? `${a.regions.length} clipped spot${a.regions.length === 1 ? '' : 's'}` : 'no clipping'}
            </p>
        </div>
    );
}

// Clipped regions on a strip as long as the clip; click jumps there.
function ClipStrip({ duration, before, after, onSeek, time }) {
    if (!duration) return null;
    const pct = (t) => `${Math.min(100, (t / duration) * 100)}%`;
    const row = (regions, color) => (regions || []).map((r, i) => (
        <button key={i} type="button" onClick={() => onSeek(Math.max(0, r.start - 0.75))}
            title={`${fmtTime(r.start)} · ${r.samples} samples`}
            className={`absolute top-0 h-full ${color} hover:opacity-80`}
            style={{ left: pct(r.start), width: `max(3px, ${pct(r.end - r.start)})` }} />
    ));
    return (
        <div className="space-y-1">
            <div className="relative h-3 rounded bg-paper3 overflow-hidden">
                {row(before, 'bg-danger')}
                <span className="absolute top-0 h-full w-px bg-ink" style={{ left: pct(time) }} />
            </div>
            {after && (
                <div className="relative h-3 rounded bg-paper3 overflow-hidden">
                    {row(after, 'bg-warn')}
                    <span className="absolute top-0 h-full w-px bg-ink" style={{ left: pct(time) }} />
                </div>
            )}
            <p className="readout normal-case text-[11px]">
                <span className="text-danger">■</span> clipped now{after ? <> · <span className="text-warn">■</span> after the chain</> : null} · click a mark to hear it
            </p>
        </div>
    );
}

function PluginParams({ step, onParams }) {
    const [desc, setDesc] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let live = true;
        loadPluginParams(step.path).then((d) => live && setDesc(d)).catch((e) => live && setError(e.message));
        return () => { live = false; };
    }, [step.path]);
    if (error) return <p className="text-xs text-danger">{error}</p>;
    if (!desc) return <p className="text-xs text-muted flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> loading plugin…</p>;
    const set = (name, v) => onParams({ ...step.params, [name]: v });
    const shown = desc.params.filter((p) => !/bypass/i.test(p.name));
    return (
        <div className="space-y-3">
            {shown.map((p) => {
                // audio_fx turns a de-clipper's post-limiter off unless set.
                const fallback = p.name === 'post_limiter' && /de-?clip/i.test(step.name || '') ? false : p.value;
                const v = step.params?.[p.name] ?? fallback;
                if (p.kind === 'bool') {
                    return (
                        <div key={p.name} className="flex items-center justify-between">
                            <span className="eyebrow">{niceName(p.name)}</span>
                            <ToggleChip on={!!v} onClick={() => set(p.name, !v)}>{v ? 'on' : 'off'}</ToggleChip>
                        </div>
                    );
                }
                if (p.kind === 'choice') {
                    return (
                        <label key={p.name} className="flex items-center justify-between gap-3">
                            <span className="eyebrow">{niceName(p.name)}</span>
                            <select value={v} onChange={(e) => set(p.name, e.target.value)} className="input-field py-1 text-xs w-40">
                                {p.choices.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                        </label>
                    );
                }
                return (
                    <SliderField key={p.name} label={niceName(p.name)} value={Number(v)} min={p.min} max={p.max}
                        step={(p.max - p.min) / 200} format={(x) => `${Number(x).toFixed(2)}${p.unit ? ` ${p.unit}` : ''}`}
                        onChange={(x) => set(p.name, x)} />
                );
            })}
        </div>
    );
}

function BuiltinParams({ step, spec, onParams }) {
    if (!spec?.params?.length) {
        return <p className="text-xs text-muted">Rebuilds flat-topped peaks (ffmpeg adeclip). Runs first.</p>;
    }
    return (
        <div className="space-y-3">
            {spec.params.map((p) => (
                <SliderField key={p.name} label={p.label} value={Number(step.params?.[p.name] ?? p.default)}
                    min={p.min} max={p.max} step={p.step} format={(x) => `${x}${p.unit ? ` ${p.unit}` : ''}`}
                    onChange={(x) => onParams({ ...step.params, [p.name]: x })} />
            ))}
        </div>
    );
}

export default function AudioEditor({ jobId, clipIndex, onApplied }) {
    const [effects, setEffects] = useState(null);
    const [info, setInfo] = useState(null);         // {analysis, chain, source_url}
    const [chain, setChain] = useState([]);
    const [preview, setPreview] = useState(null);   // {url, analysis}
    const [busy, setBusy] = useState(null);         // 'preview' | 'apply'
    const [error, setError] = useState(null);
    const [listen, setListen] = useState('original');
    const [time, setTime] = useState(0);
    const [adding, setAdding] = useState('');
    const videoRef = useRef(null);
    const audioRef = useRef(null);

    useEffect(() => { loadEffects().then(setEffects); }, []);
    useEffect(() => {
        let live = true;
        setInfo(null);
        apiFetch(`/api/clip/${jobId}/${clipIndex}/audio`)
            .then(async (r) => {
                const body = await r.json();
                if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
                if (!live) return;
                setInfo(body);
                setChain(body.chain || []);
            })
            .catch((e) => live && setError(e.message));
        return () => { live = false; };
    }, [jobId, clipIndex]);

    const specs = useMemo(() => Object.fromEntries((effects?.builtins || []).map((b) => [b.name, b])), [effects]);
    const declipPlugin = useMemo(() => (effects?.plugins || []).find((p) => /de-?clip/i.test(p.name)), [effects]);
    const saved = JSON.stringify(info?.chain || []);
    const dirty = JSON.stringify(chain) !== saved;
    const previewStale = preview && preview.chainKey !== JSON.stringify(chain);

    // A/B: the video always plays; in "processed" its sound is muted and the
    // rendered audio follows its clock.
    const sync = () => {
        const v = videoRef.current, a = audioRef.current;
        if (!v || !a) return;
        if (Math.abs(a.currentTime - v.currentTime) > 0.12) a.currentTime = v.currentTime;
        if (listen === 'processed' && !v.paused && a.paused) a.play().catch(() => {});
        if ((v.paused || listen !== 'processed') && !a.paused) a.pause();
    };
    useEffect(() => {
        const v = videoRef.current;
        if (v) v.muted = listen === 'processed';
        sync();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [listen, preview?.url]);

    const seek = (t) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = t;
        v.play().catch(() => {});
    };

    const update = (i, patch) => setChain((c) => c.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    const move = (i, d) => setChain((c) => {
        const n = c.slice();
        const j = i + d;
        if (j < 0 || j >= n.length) return c;
        [n[i], n[j]] = [n[j], n[i]];
        return n;
    });
    const addStep = (key) => {
        if (!key) return;
        if (key.startsWith('plugin:')) {
            const p = effects.plugins.find((x) => x.path === key.slice(7));
            if (p) setChain((c) => [...c, { type: 'plugin', path: p.path, name: p.name, params: {}, enabled: true }]);
        } else {
            const spec = specs[key];
            const params = Object.fromEntries((spec?.params || []).map((p) => [p.name, p.default]));
            const step = { type: 'builtin', name: key, params, enabled: true };
            // De-clip only works on the raw signal: always first.
            setChain((c) => (key === 'declip' ? [step, ...c] : [...c, step]));
        }
        setAdding('');
    };
    const suggested = (useRx) => {
        const base = (effects?.suggested || []).map((s) => ({ ...s, params: { ...s.params } }));
        if (useRx && declipPlugin) {
            base[0] = { type: 'plugin', path: declipPlugin.path, name: declipPlugin.name, params: {}, enabled: true };
        }
        setChain(base);
    };

    const run = async (kind) => {
        setBusy(kind);
        setError(null);
        try {
            const res = await apiFetch(`/api/clip/${jobId}/${clipIndex}/audio/${kind}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chain }),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
            if (kind === 'preview') {
                setPreview({ ...body, chainKey: JSON.stringify(chain) });
                setListen('processed');
            } else {
                setInfo((i) => ({ ...i, chain: body.audio_fx?.chain || [] }));
                onApplied?.(body);
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(null);
        }
    };

    const a = info?.analysis;
    return (
        <div className="h-full flex flex-col md:flex-row gap-6 p-3 sm:p-6 min-h-0">
            {/* Preview + what is wrong */}
            <div className="flex flex-col gap-3 md:h-full md:min-h-0 md:w-auto md:max-w-[36%] shrink-0">
                <div className="bg-black rounded-card border border-rule overflow-hidden aspect-[9/16] md:h-full md:min-h-0 max-h-[70vh] mx-auto">
                    {info && (
                        <video ref={videoRef} src={getApiUrl(info.source_url)} controls playsInline className="w-full h-full object-contain"
                            onPlay={sync} onPause={sync} onSeeked={sync}
                            onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); sync(); }} />
                    )}
                    {preview && <audio ref={audioRef} src={getApiUrl(preview.url)} preload="auto" />}
                </div>
            </div>

            <div className="flex-1 min-w-0 flex flex-col gap-4 md:h-full md:min-h-0 md:overflow-y-auto custom-scrollbar md:pr-1">
                {!info && !error && <p className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> measuring the audio…</p>}
                {a && (
                    <>
                        <div className="flex gap-2">
                            <Stats title="now" a={a} />
                            {preview && <Stats title={previewStale ? 'after (old chain)' : 'after the chain'} a={preview.analysis} />}
                        </div>
                        <ClipStrip duration={a.duration} before={a.regions} after={preview?.analysis?.regions}
                            onSeek={seek} time={time} />
                        {a.clipping && !chain.length && (
                            <div className="rounded-input border border-warn/40 bg-warn/5 p-3 text-sm text-ink2 space-y-2">
                                <p className="flex items-center gap-2"><AlertTriangle size={14} className="text-warn" /> This clip clips: the loud parts are flattened and sound distorted.</p>
                                <div className="flex flex-wrap gap-2">
                                    <button type="button" onClick={() => suggested(false)} className="btn-primary px-3 py-1.5 text-xs"><Wand2 size={12} /> suggested fix</button>
                                    {declipPlugin && (
                                        <button type="button" onClick={() => suggested(true)} className="btn-ghost px-3 py-1.5 text-xs">
                                            <Wand2 size={12} /> suggested fix with {declipPlugin.name}
                                        </button>
                                    )}
                                </div>
                                <p className="text-xs text-muted">
                                    De-clip, then a gentle compressor, then loudness to -14 LUFS with peaks under -1 dB.
                                    De-clipping truly rebuilds peaks only on lossless sound (e.g. a camera file you uploaded);
                                    on a YouTube download it softens the distortion. Compare A and B by ear.
                                </p>
                            </div>
                        )}
                        {!a.clipping && !chain.length && (
                            <p className="text-sm text-muted flex items-center gap-2"><Check size={14} className="text-ok" /> No clipping found. You can still add effects below.</p>
                        )}
                    </>
                )}
                {preview && (
                    <div>
                        <p className="eyebrow mb-1.5">listen</p>
                        <div className="flex gap-1.5">
                            <ToggleChip on={listen === 'original'} onClick={() => setListen('original')}>A · original</ToggleChip>
                            <ToggleChip on={listen === 'processed'} onClick={() => setListen('processed')}>B · with the chain</ToggleChip>
                        </div>
                    </div>
                )}
                {error && <p className="text-sm text-danger">{error}</p>}
            </div>

            {/* The chain */}
            <div className="w-full md:w-[400px] md:shrink-0 flex flex-col md:h-full md:min-h-0">
                <p className="eyebrow mb-2">effect chain · top to bottom</p>
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                    {!chain.length && <p className="text-xs text-muted">Empty: the clip keeps its original sound.</p>}
                    {chain.map((s, i) => (
                        <div key={i} className={`rounded-input border p-3 ${s.enabled === false ? 'border-rule opacity-60' : 'border-rule2'}`}>
                            <div className="flex items-center gap-2 mb-2">
                                <input type="checkbox" checked={s.enabled !== false} onChange={(e) => update(i, { enabled: e.target.checked })}
                                    aria-label="enabled" className="accent-[color:var(--color-accent)]" />
                                <span className="text-sm text-ink flex-1 truncate" title={s.path || ''}>
                                    {s.type === 'plugin' ? s.name : specs[s.name]?.label || s.name}
                                    {s.type === 'plugin' && <span className="readout ml-2">plugin</span>}
                                </span>
                                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 text-muted hover:text-ink disabled:opacity-30" aria-label="move up"><ArrowUp size={13} /></button>
                                <button type="button" onClick={() => move(i, 1)} disabled={i === chain.length - 1} className="p-1 text-muted hover:text-ink disabled:opacity-30" aria-label="move down"><ArrowDown size={13} /></button>
                                <button type="button" onClick={() => setChain((c) => c.filter((_, j) => j !== i))} className="p-1 text-muted hover:text-danger" aria-label="remove"><Trash2 size={13} /></button>
                            </div>
                            {s.type === 'plugin'
                                ? <PluginParams step={s} onParams={(params) => update(i, { params })} />
                                : <BuiltinParams step={s} spec={specs[s.name]} onParams={(params) => update(i, { params })} />}
                        </div>
                    ))}
                </div>
                <div className="pt-3 space-y-2 shrink-0">
                    <div className="flex items-center gap-2">
                        <Plus size={14} className="text-muted shrink-0" />
                        <select value={adding} onChange={(e) => addStep(e.target.value)} className="input-field py-1.5 text-sm flex-1">
                            <option value="">add an effect…</option>
                            <optgroup label="built in">
                                {(effects?.builtins || []).map((b) => <option key={b.name} value={b.name}>{b.label}</option>)}
                            </optgroup>
                            {effects?.plugins?.length > 0 && (
                                <optgroup label="installed plugins">
                                    {effects.plugins.map((p) => <option key={p.path} value={`plugin:${p.path}`}>{p.name} ({p.format})</option>)}
                                </optgroup>
                            )}
                        </select>
                    </div>
                    <div className="flex gap-2">
                        <button type="button" onClick={() => run('preview')} disabled={!!busy || !chain.length} className="btn-ghost flex-1 py-2 text-sm">
                            {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} preview
                        </button>
                        <button type="button" onClick={() => run('apply')} disabled={!!busy || (!dirty && !!info)} className="btn-primary flex-1 py-2 text-sm">
                            {busy === 'apply' ? <Loader2 size={14} className="animate-spin" /> : null}
                            {chain.length ? (dirty ? 'apply to clip' : 'applied') : (info?.chain?.length ? 'remove audio fix' : 'apply to clip')}
                        </button>
                    </div>
                    <p className="readout normal-case text-[11px]">
                        Applied as the clip&apos;s last layer: hooks, captions and trims keep it.
                    </p>
                </div>
            </div>
        </div>
    );
}
