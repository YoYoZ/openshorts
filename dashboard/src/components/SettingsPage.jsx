import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Bot, KeyRound, Mic, Scissors, Type, Wand2, Youtube, Download, FolderOpen,
    ArrowUp, ArrowDown, Trash2, Plus, Check, AlertTriangle, Loader2, ExternalLink,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import FolderSettings from './FolderSettings';

// AutoShortsCut settings (/api/settings, settings_store.py): every section is
// edited as a draft and saved on its own. Keys come back masked; typing a new
// one replaces the stored key.

const SECTIONS = [
    { id: 'models', label: 'AI models', icon: Bot },
    { id: 'keys', label: 'API keys', icon: KeyRound },
    { id: 'transcription', label: 'transcription', icon: Mic },
    { id: 'clips', label: 'clips', icon: Scissors },
    { id: 'subtitles', label: 'subtitles', icon: Type },
    { id: 'hook', label: 'hook', icon: Wand2 },
    { id: 'youtube', label: 'YouTube', icon: Youtube },
    { id: 'downloads', label: 'downloads', icon: Download },
    { id: 'folders', label: 'folders', icon: FolderOpen, desktopOnly: true },
];

const PROVIDER_ORDER = ['anthropic', 'gemini', 'groq', 'openai', 'openrouter', 'custom'];

// ---------------------------------------------------------------- small UI

const Field = ({ label, hint, children }) => (
    <label className="block">
        <span className="flex items-baseline justify-between mb-1.5">
            <span className="text-sm text-ink2 lowercase">{label}</span>
            {hint && <span className="readout normal-case">{hint}</span>}
        </span>
        {children}
    </label>
);

const Select = ({ value, onChange, options }) => (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="input-field appearance-none cursor-pointer">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
);

const Toggle = ({ checked, onChange, label }) => (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center justify-between w-full py-1">
        <span className="text-sm text-ink2 lowercase">{label}</span>
        <span className={`w-9 h-5 rounded-full relative transition-colors ${checked ? 'bg-brass' : 'bg-paper3'}`}>
            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
        </span>
    </button>
);

function SaveBar({ dirty, saving, onSave, onReset, status }) {
    return (
        <div className="flex items-center gap-3 pt-5 mt-6 border-t border-rule">
            <button type="button" onClick={onSave} disabled={!dirty || saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-40">
                {saving ? <Loader2 size={14} className="animate-spin" /> : null} save
            </button>
            {dirty && !saving && <button type="button" onClick={onReset} className="text-xs text-muted hover:text-ink2 lowercase">discard changes</button>}
            {status && <span className={`text-xs ${status.ok ? 'text-ok' : 'text-danger'}`}>{status.text}</span>}
        </div>
    );
}

// Generic draft + save for one settings section.
function useSection(settings, key, onSaved) {
    const [draft, setDraft] = useState(() => settings?.[key]);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState(null);
    useEffect(() => { setDraft(settings?.[key]); }, [settings, key]);
    const dirty = JSON.stringify(draft) !== JSON.stringify(settings?.[key]);
    const save = async (value = draft) => {
        setSaving(true);
        setStatus(null);
        try {
            const res = await apiFetch(`/api/settings/${key}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
            onSaved(body);
            setStatus({ ok: true, text: 'saved, applies to new jobs' });
        } catch (e) {
            setStatus({ ok: false, text: e.message });
        } finally {
            setSaving(false);
        }
    };
    const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
    return { draft, setDraft, set, dirty, saving, status, save, reset: () => setDraft(settings?.[key]) };
}

// ---------------------------------------------------------------- sections

function ModelsSection({ settings, onSaved }) {
    const s = useSection(settings, 'llm_chain', onSaved);
    const chain = useMemo(() => s.draft || [], [s.draft]);
    const [models, setModels] = useState({});   // provider -> [ids]
    const providers = settings.providers;
    const usable = PROVIDER_ORDER.filter((p) => providers[p]?.has_key || p === 'custom');

    const loadModels = useCallback(async (provider) => {
        if (models[provider]) return;
        try {
            const res = await apiFetch(`/api/settings/models?provider=${provider}`);
            const body = await res.json();
            setModels((m) => ({ ...m, [provider]: body.models || [] }));
        } catch { /* typed by hand then */ }
    }, [models]);
    useEffect(() => { chain.forEach((e) => loadModels(e.provider)); }, [chain, loadModels]);

    const update = (i, patch) => s.setDraft(chain.map((e, k) => {
        if (k !== i) return e;
        const next = { ...e, ...patch };
        // A known model fills in its price.
        const known = settings.known_prices?.[next.model];
        if (patch.model && known) { next.price_in = known[0]; next.price_out = known[1]; }
        return next;
    }));
    const move = (i, d) => {
        const next = [...chain];
        [next[i], next[i + d]] = [next[i + d], next[i]];
        s.setDraft(next);
    };
    const add = () => {
        const provider = usable[0] || 'anthropic';
        s.setDraft([...chain, { id: Math.random().toString(16).slice(2, 10), provider, model: '', enabled: true,
            budget_usd: 0, period: 'month', price_in: 0, price_out: 0 }]);
        loadModels(provider);
    };

    return (
        <div>
            <p className="text-sm text-muted mb-5">
                Picks the moments and writes titles. Models are tried top to bottom: one whose budget for the period
                is spent is skipped, and if one fails (error, rate limit, bad answer) the next takes over.
                Budgets need prices; known models fill them in.
            </p>
            {chain.length === 0 && <p className="text-sm text-warn mb-4">No models yet: jobs fall back to the .env setup.</p>}
            <div className="space-y-3">
                {chain.map((e, i) => {
                    const pct = e.budget_usd > 0 ? Math.min(100, ((e.spent_usd || 0) / e.budget_usd) * 100) : 0;
                    return (
                        <div key={e.id} className={`rounded-input border p-4 ${e.enabled ? 'border-rule2' : 'border-rule opacity-60'}`}>
                            <div className="flex items-center gap-2 mb-3">
                                <span className="readout w-5">{i + 1}</span>
                                <div className="w-44 shrink-0">
                                    <Select value={e.provider} onChange={(v) => { update(i, { provider: v, model: '' }); loadModels(v); }}
                                        options={PROVIDER_ORDER.map((p) => ({ value: p, label: providers[p]?.label || p }))} />
                                </div>
                                <input
                                    list={`models-${e.id}`}
                                    value={e.model}
                                    onChange={(ev) => update(i, { model: ev.target.value })}
                                    onFocus={() => loadModels(e.provider)}
                                    placeholder="model id"
                                    className="input-field flex-1 font-mono text-xs"
                                />
                                <datalist id={`models-${e.id}`}>
                                    {(models[e.provider] || []).map((m) => <option key={m} value={m} />)}
                                </datalist>
                                <button type="button" title="up" disabled={i === 0} onClick={() => move(i, -1)} className="p-1.5 text-muted hover:text-ink disabled:opacity-30"><ArrowUp size={14} /></button>
                                <button type="button" title="down" disabled={i === chain.length - 1} onClick={() => move(i, 1)} className="p-1.5 text-muted hover:text-ink disabled:opacity-30"><ArrowDown size={14} /></button>
                                <button type="button" title="remove" onClick={() => s.setDraft(chain.filter((_, k) => k !== i))} className="p-1.5 text-muted hover:text-danger"><Trash2 size={14} /></button>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 items-end">
                                <Field label="budget $" hint="0 = none">
                                    <input type="number" min="0" step="0.5" value={e.budget_usd}
                                        onChange={(ev) => update(i, { budget_usd: Number(ev.target.value) })} className="input-field" />
                                </Field>
                                <Field label="per">
                                    <Select value={e.period} onChange={(v) => update(i, { period: v })}
                                        options={[{ value: 'day', label: 'day' }, { value: 'month', label: 'month' }, { value: 'total', label: 'total' }]} />
                                </Field>
                                <Field label="$ / M in">
                                    <input type="number" min="0" step="0.01" value={e.price_in}
                                        onChange={(ev) => update(i, { price_in: Number(ev.target.value) })} className="input-field" />
                                </Field>
                                <Field label="$ / M out">
                                    <input type="number" min="0" step="0.01" value={e.price_out}
                                        onChange={(ev) => update(i, { price_out: Number(ev.target.value) })} className="input-field" />
                                </Field>
                                <Toggle checked={e.enabled} onChange={(v) => update(i, { enabled: v })} label="enabled" />
                            </div>
                            <div className="mt-3">
                                <div className="flex justify-between readout normal-case mb-1">
                                    <span>spent this {e.period === 'total' ? 'lifetime' : e.period}: ${(e.spent_usd || 0).toFixed(3)}</span>
                                    {e.budget_usd > 0 && <span>of ${Number(e.budget_usd).toFixed(2)}</span>}
                                    {!(e.price_in || e.price_out) && <span className="text-warn">no price: spend not counted</span>}
                                </div>
                                {e.budget_usd > 0 && (
                                    <div className="h-1 rounded-full bg-paper3 overflow-hidden">
                                        <div className={`h-full ${pct >= 100 ? 'bg-danger' : 'bg-brass'}`} style={{ width: `${pct}%` }} />
                                    </div>
                                )}
                                {!providers[e.provider]?.has_key && e.provider !== 'custom' && (
                                    <p className="text-xs text-warn mt-1">No {providers[e.provider]?.label} key: this model is skipped.</p>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            <button type="button" onClick={add} className="btn-ghost mt-3 px-4 py-2 text-sm"><Plus size={14} /> add model</button>
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

function KeysSection({ settings, onSaved }) {
    const [inputs, setInputs] = useState({});
    const [baseUrl, setBaseUrl] = useState(settings.providers.custom?.base_url || '');
    const [tests, setTests] = useState({});
    const [saving, setSaving] = useState(null);

    const save = async (name, payload) => {
        setSaving(name);
        try {
            const res = await apiFetch('/api/settings/providers', {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [name]: payload }),
            });
            onSaved(await res.json());
            setInputs((x) => ({ ...x, [name]: '' }));
            setTests((t) => ({ ...t, [name]: null }));
        } finally {
            setSaving(null);
        }
    };
    const test = async (name) => {
        setTests((t) => ({ ...t, [name]: { running: true } }));
        try {
            const res = await apiFetch('/api/settings/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: name }),
            });
            const body = await res.json();
            setTests((t) => ({ ...t, [name]: body }));
        } catch (e) {
            setTests((t) => ({ ...t, [name]: { ok: false, error: e.message } }));
        }
    };

    return (
        <div>
            <p className="text-sm text-muted mb-5">
                Stored on this computer only, in the app&apos;s settings file. Groq is also used for transcription;
                Gemini also powers the automatic layout choice (fill or blur).
            </p>
            <div className="space-y-3">
                {PROVIDER_ORDER.map((name) => {
                    const p = settings.providers[name] || {};
                    const t = tests[name];
                    return (
                        <div key={name} className="rounded-input border border-rule p-4">
                            <div className="flex items-center gap-2 mb-2">
                                <span className="text-sm text-ink">{p.label}</span>
                                {p.has_key
                                    ? <span className="badge-ok normal-case font-mono"><Check size={11} /> {p.key}</span>
                                    : <span className="readout normal-case">no key</span>}
                                {p.key_url && (
                                    <a href={p.key_url} target="_blank" rel="noopener noreferrer" className="ml-auto text-xs text-muted hover:text-brass inline-flex items-center gap-1">
                                        get a key <ExternalLink size={11} />
                                    </a>
                                )}
                            </div>
                            {name === 'custom' && (
                                <div className="flex gap-2 mb-2">
                                    <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1"
                                        className="input-field flex-1 font-mono text-xs" />
                                    <button type="button" onClick={() => save(name, { base_url: baseUrl })} className="btn-ghost px-3 text-xs">save URL</button>
                                </div>
                            )}
                            <div className="flex gap-2">
                                <input
                                    type="password"
                                    value={inputs[name] || ''}
                                    onChange={(e) => setInputs((x) => ({ ...x, [name]: e.target.value }))}
                                    placeholder={p.has_key ? 'paste a new key to replace' : 'paste key'}
                                    className="input-field flex-1 font-mono text-xs"
                                    autoComplete="off"
                                />
                                <button type="button" disabled={!inputs[name] || saving === name} onClick={() => save(name, { key: inputs[name] })}
                                    className="btn-primary px-3 text-xs disabled:opacity-40">save</button>
                                <button type="button" disabled={!p.has_key && name !== 'custom'} onClick={() => test(name)}
                                    className="btn-ghost px-3 text-xs disabled:opacity-40">test</button>
                                {p.has_key && (
                                    <button type="button" onClick={() => { if (window.confirm(`Remove the ${p.label} key?`)) save(name, { key: null }); }}
                                        className="p-2 text-muted hover:text-danger" title="remove key"><Trash2 size={14} /></button>
                                )}
                            </div>
                            {t && (
                                <p className={`text-xs mt-2 ${t.running ? 'text-muted' : t.ok ? 'text-ok' : 'text-danger'}`}>
                                    {t.running ? 'testing…' : t.ok ? `works: ${t.models ?? '?'} models available (${t.ms} ms)` : t.error}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function TranscriptionSection({ settings, onSaved }) {
    const s = useSection(settings, 'transcription', onSaved);
    const d = s.draft || {};
    const groqKey = settings.providers.groq?.has_key;
    return (
        <div className="space-y-5">
            <Field label="engine">
                <Select value={d.mode} onChange={(v) => s.set({ mode: v })} options={[
                    { value: 'auto', label: 'auto: Groq first, local whisper if it fails' },
                    { value: 'groq', label: 'Groq only (hosted, ~20 s for a 25-min video)' },
                    { value: 'whisper', label: 'local only (your GPU, nothing leaves the PC)' },
                ]} />
            </Field>
            {d.mode !== 'whisper' && !groqKey && <p className="text-xs text-warn">No Groq key under API keys: jobs will transcribe locally.</p>}
            <div className="grid grid-cols-2 gap-4">
                <Field label="Groq model">
                    <Select value={d.groq_model} onChange={(v) => s.set({ groq_model: v })} options={[
                        { value: 'whisper-large-v3', label: 'whisper-large-v3 (most accurate)' },
                        { value: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo (faster)' },
                    ]} />
                </Field>
                <Field label="local model">
                    <Select value={d.local_model} onChange={(v) => s.set({ local_model: v })} options={[
                        { value: 'large-v3', label: 'large-v3 (best, ~5 GB VRAM)' },
                        { value: 'large-v3-turbo', label: 'large-v3-turbo (faster)' },
                        { value: 'medium', label: 'medium' },
                        { value: 'small', label: 'small (CPU-friendly)' },
                    ]} />
                </Field>
            </div>
            <Field label="language" hint="fixed language skips detection">
                <Select value={d.language} onChange={(v) => s.set({ language: v })} options={[
                    { value: '', label: 'detect automatically' }, { value: 'uk', label: 'Ukrainian' },
                    { value: 'en', label: 'English' }, { value: 'ru', label: 'Russian' }, { value: 'pl', label: 'Polish' },
                    { value: 'de', label: 'German' }, { value: 'es', label: 'Spanish' },
                ]} />
            </Field>
            <Field label="glossary" hint="names, brands, terms: one per line or comma separated">
                <textarea value={d.glossary || ''} onChange={(e) => s.set({ glossary: e.target.value })} rows={5}
                    placeholder={'Deye\nLiFePO4\nEcoFlow, Jackery, BMS, MPPT'} className="input-field font-mono text-xs" />
            </Field>
            <p className="text-xs text-muted -mt-2">Passed to Whisper as a spelling hint, so these come out right more often.</p>
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

function ClipsSection({ settings, onSaved }) {
    const s = useSection(settings, 'clips', onSaved);
    const d = s.draft || {};
    const num = (v) => (v === '' || v === null ? null : Number(v));
    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
                <Field label="shortest clip" hint="seconds">
                    <input type="number" min="5" max="180" value={d.min_seconds} onChange={(e) => s.set({ min_seconds: num(e.target.value) })} className="input-field" />
                </Field>
                <Field label="longest clip" hint="seconds">
                    <input type="number" min="10" max="180" value={d.max_seconds} onChange={(e) => s.set({ max_seconds: num(e.target.value) })} className="input-field" />
                </Field>
                <Field label="at least" hint="clips per video, blank = auto">
                    <input type="number" min="1" max="30" value={d.count_min ?? ''} onChange={(e) => s.set({ count_min: num(e.target.value) })} className="input-field" />
                </Field>
                <Field label="at most" hint="clips per video, blank = auto">
                    <input type="number" min="1" max="30" value={d.count_max ?? ''} onChange={(e) => s.set({ count_max: num(e.target.value) })} className="input-field" />
                </Field>
            </div>
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

const sizeToPct = (fs) => Math.round((fs * 0.85 / 288) * 100 * 2) / 2;
const pctToSize = (p) => Math.round((p / 100) * 288 / 0.85 * 10) / 10;

function SubtitlesSection({ settings, onSaved }) {
    const s = useSection(settings, 'subtitle_defaults', onSaved);
    const d = s.draft || {};
    return (
        <div className="space-y-5">
            <p className="text-sm text-muted">The look new projects&apos; captions get, and what the subtitle editor starts from.</p>
            <div className="grid grid-cols-2 gap-4">
                <Field label="font">
                    <Select value={d.font_name} onChange={(v) => s.set({ font_name: v })} options={[
                        'Montserrat ExtraBold', 'Anton', 'Impact', 'Verdana', 'Arial',
                    ].map((f) => ({ value: f, label: f }))} />
                </Field>
                <Field label="animation">
                    <Select value={d.effect} onChange={(v) => s.set({ effect: v })} options={[
                        { value: 'pop', label: 'pop' }, { value: 'glow', label: 'glow' },
                        { value: 'highlight', label: 'box' }, { value: 'none', label: 'none' },
                    ]} />
                </Field>
                <Field label="position">
                    <Select value={d.position} onChange={(v) => s.set({ position: v })} options={[
                        { value: 'top', label: 'top' }, { value: 'middle', label: 'middle' }, { value: 'bottom', label: 'bottom' },
                    ]} />
                </Field>
                <Field label="characters per caption" hint="1 = one word at a time">
                    <input type="number" min="1" max="40" value={d.max_chars} onChange={(e) => s.set({ max_chars: Number(e.target.value) })} className="input-field" />
                </Field>
            </div>
            <Field label="size" hint={`${sizeToPct(d.font_size || 44).toFixed(1)}% of frame height`}>
                <input type="range" min={4} max={20} step={0.5} value={sizeToPct(d.font_size || 44)}
                    onChange={(e) => s.set({ font_size: pctToSize(Number(e.target.value)) })} className="w-full accent-[color:var(--color-accent)]" />
            </Field>
            <div className="grid grid-cols-3 gap-4">
                {[['font_color', 'text'], ['highlight_color', 'active word'], ['border_color', 'outline']].map(([k, label]) => (
                    <Field key={k} label={label}>
                        <input type="color" value={d[k] || '#ffffff'} onChange={(e) => s.set({ [k]: e.target.value })} className="w-full h-9 rounded-input bg-transparent cursor-pointer" />
                    </Field>
                ))}
            </div>
            <Field label="outline thickness" hint={String(d.border_width)}>
                <input type="range" min={0} max={10} step={1} value={d.border_width ?? 4}
                    onChange={(e) => s.set({ border_width: Number(e.target.value) })} className="w-full accent-[color:var(--color-accent)]" />
            </Field>
            <Toggle checked={!!d.uppercase} onChange={(v) => s.set({ uppercase: v })} label="uppercase" />
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

function HookSection({ settings, onSaved }) {
    const s = useSection(settings, 'hook_defaults', onSaved);
    const d = s.draft || {};
    return (
        <div className="space-y-5">
            <p className="text-sm text-muted">The look of the hook new projects get. &quot;Apply this style to all clips&quot; in the hook editor also saves here.</p>
            <div className="grid grid-cols-2 gap-4">
                <Field label="style">
                    <Select value={d.style} onChange={(v) => s.set({ style: v })} options={[
                        'pill', 'classic', 'dark', 'yellow', 'red', 'outline', 'outline_yellow',
                    ].map((v) => ({ value: v, label: v.replace('_', ' ') }))} />
                </Field>
                <Field label="font">
                    <Select value={d.font || 'montserrat'} onChange={(v) => s.set({ font: v })} options={[
                        { value: 'montserrat', label: 'Montserrat' }, { value: 'anton', label: 'Anton' }, { value: 'serif', label: 'Serif' },
                    ]} />
                </Field>
                <Field label="position">
                    <Select value={d.position} onChange={(v) => s.set({ position: v })} options={[
                        { value: 'auto', label: 'auto (off faces and captions)' }, { value: 'top', label: 'top' },
                        { value: 'center', label: 'center' }, { value: 'bottom', label: 'bottom' },
                    ]} />
                </Field>
                <Field label="shown for" hint="seconds">
                    <input type="number" min="1" max="60" value={d.duration_seconds} onChange={(e) => s.set({ duration_seconds: Number(e.target.value) })} className="input-field" />
                </Field>
            </div>
            <Field label="size" hint={`${Math.round((d.scale || 1) * 100)}%`}>
                <input type="range" min={0.5} max={2} step={0.05} value={d.scale || 1}
                    onChange={(e) => s.set({ scale: Number(e.target.value) })} className="w-full accent-[color:var(--color-accent)]" />
            </Field>
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

function YouTubeSection({ settings, onSaved }) {
    const s = useSection(settings, 'youtube', onSaved);
    const d = s.draft || {};
    const [conn, setConn] = useState(null);
    useEffect(() => {
        apiFetch('/api/youtube/status').then((r) => r.json()).then(setConn).catch(() => setConn({ connected: false }));
    }, []);
    return (
        <div className="space-y-5">
            <div className="rounded-input border border-rule p-3 text-sm">
                {conn === null ? <span className="text-muted">checking connection…</span>
                    : conn.connected ? <span className="text-ok inline-flex items-center gap-1.5"><Check size={14} /> connected to {conn.channel?.title} {conn.channel?.handle}</span>
                        : <span className="text-warn inline-flex items-center gap-1.5"><AlertTriangle size={14} /> not connected ({conn.error || 'no token in youtube_auth'})</span>}
            </div>
            <div className="grid grid-cols-2 gap-4">
                <Field label="visibility" hint="when not scheduled">
                    <Select value={d.privacy} onChange={(v) => s.set({ privacy: v })} options={[
                        { value: 'private', label: 'private' }, { value: 'unlisted', label: 'unlisted' }, { value: 'public', label: 'public' },
                    ]} />
                </Field>
                <Field label="category">
                    <Select value={d.category} onChange={(v) => s.set({ category: v })} options={[
                        { value: '28', label: 'Science & Technology' }, { value: '27', label: 'Education' },
                        { value: '26', label: 'Howto & Style' }, { value: '22', label: 'People & Blogs' },
                        { value: '24', label: 'Entertainment' }, { value: '20', label: 'Gaming' },
                    ]} />
                </Field>
                <Field label="post time">
                    <input type="time" value={d.default_time} onChange={(e) => s.set({ default_time: e.target.value })} className="input-field [color-scheme:dark]" />
                </Field>
                <Field label="how often">
                    <Select value={d.cadence} onChange={(v) => s.set({ cadence: v })} options={[
                        { value: 'twice', label: '2 a day' }, { value: 'daily', label: '1 a day' },
                        { value: 'every2', label: 'every 2 days' }, { value: 'weekly', label: '1 a week' },
                    ]} />
                </Field>
            </div>
            <Field label="timezone">
                <input value={d.timezone} onChange={(e) => s.set({ timezone: e.target.value })} placeholder="Europe/Kyiv" className="input-field font-mono text-xs" />
            </Field>
            <Field label="description template" hint="{description} {title} {source_url}">
                <textarea value={d.description_template} onChange={(e) => s.set({ description_template: e.target.value })} rows={5} className="input-field text-sm" />
            </Field>
            <p className="text-xs text-muted -mt-2">A line with {'{source_url}'} is left out when the project has no source link.</p>
            <Field label="tags" hint="comma separated, added to every upload">
                <input value={d.tags} onChange={(e) => s.set({ tags: e.target.value })} placeholder="інвертор, електрика, автономність" className="input-field" />
            </Field>
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

function DownloadsSection({ settings, onSaved }) {
    const s = useSection(settings, 'download', onSaved);
    const d = s.draft || {};
    return (
        <div className="space-y-5">
            <Field label="YouTube cookies" hint="Netscape cookies.txt format">
                <textarea value={d.youtube_cookies || ''} onChange={(e) => s.set({ youtube_cookies: e.target.value })} rows={8}
                    placeholder="# Netscape HTTP Cookie File" className="input-field font-mono text-[11px]" />
            </Field>
            <p className="text-xs text-muted -mt-2">
                Only needed when YouTube blocks downloads (&quot;sign in to confirm you&apos;re not a bot&quot;). Export them from a
                browser signed in to YouTube with a cookies.txt extension.
            </p>
            <SaveBar dirty={s.dirty} saving={s.saving} onSave={() => s.save()} onReset={s.reset} status={s.status} />
        </div>
    );
}

// ---------------------------------------------------------------- page

export default function SettingsPage() {
    const [settings, setSettings] = useState(null);
    const [error, setError] = useState(null);
    const [section, setSection] = useState(() => {
        try { return localStorage.getItem('settings_section') || 'models'; } catch { return 'models'; }
    });
    const desktop = typeof window !== 'undefined' && !!window.desktop;
    const sections = useMemo(() => SECTIONS.filter((x) => !x.desktopOnly || desktop), [desktop]);

    useEffect(() => {
        apiFetch('/api/settings').then(async (r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            setSettings(await r.json());
        }).catch((e) => setError(e.message));
    }, []);
    const pick = (id) => {
        setSection(id);
        try { localStorage.setItem('settings_section', id); } catch { /* ignore */ }
    };

    const props = { settings, onSaved: setSettings };
    return (
        <div className="h-full overflow-y-auto p-4 sm:p-8 animate-fade">
            <div className="max-w-5xl mx-auto">
                <p className="eyebrow mb-1.5">SETTINGS</p>
                <h1 className="font-display lowercase text-2xl text-ink mb-6">settings</h1>
                {error && <p className="text-danger text-sm">Could not load settings: {error}</p>}
                {!settings && !error && <Loader2 className="animate-spin text-brass" />}
                {settings && (
                    <div className="flex flex-col md:flex-row gap-6">
                        <nav className="md:w-48 shrink-0 flex md:flex-col gap-1 overflow-x-auto">
                            {sections.map(({ id, label, icon: Icon }) => (
                                <button key={id} type="button" onClick={() => pick(id)}
                                    className={`flex items-center gap-2.5 px-3 py-2 rounded-input text-sm lowercase whitespace-nowrap transition-colors ${section === id ? 'bg-paper3 text-ink' : 'text-muted hover:text-ink2 hover:bg-paper3/50'}`}>
                                    {React.createElement(Icon, { size: 15, className: section === id ? 'text-brass' : '' })}
                                    {label}
                                </button>
                            ))}
                        </nav>
                        <div className="flex-1 min-w-0 card p-5 sm:p-6">
                            {section === 'models' && <ModelsSection {...props} />}
                            {section === 'keys' && <KeysSection {...props} />}
                            {section === 'transcription' && <TranscriptionSection {...props} />}
                            {section === 'clips' && <ClipsSection {...props} />}
                            {section === 'subtitles' && <SubtitlesSection {...props} />}
                            {section === 'hook' && <HookSection {...props} />}
                            {section === 'youtube' && <YouTubeSection {...props} />}
                            {section === 'downloads' && <DownloadsSection {...props} />}
                            {section === 'folders' && <FolderSettings />}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
