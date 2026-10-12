import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Caption typography controls: a picker over every font installed on this
// computer (/api/fonts, font_catalog.py), real colour pickers and sliders.

let fontsPromise = null;
function loadFonts() {
    if (!fontsPromise) {
        fontsPromise = apiFetch('/api/fonts').then((r) => (r.ok ? r.json() : [])).catch(() => []);
    }
    return fontsPromise;
}

export function FontPicker({ value, onChange, needsCyrillic = false }) {
    const [fonts, setFonts] = useState(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [cyrOnly, setCyrOnly] = useState(needsCyrillic);
    const boxRef = useRef(null);
    const listRef = useRef(null);

    useEffect(() => { loadFonts().then(setFonts); }, []);
    useEffect(() => { setCyrOnly(needsCyrillic); }, [needsCyrillic]);
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    const current = (fonts || []).find((f) => f.family.toLowerCase() === String(value || '').toLowerCase());
    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return (fonts || []).filter((f) => (!q || f.family.toLowerCase().includes(q)) && (!cyrOnly || f.cyrillic));
    }, [fonts, query, cyrOnly]);
    const sample = needsCyrillic ? 'Привіт Aa' : 'Hello Aa';

    return (
        <div ref={boxRef} className="relative">
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
                className="input-field w-full flex items-center justify-between gap-2 text-left">
                <span className="truncate" style={{ fontFamily: `"${value}", sans-serif` }}>{value || 'choose a font'}</span>
                <span className="flex items-center gap-2 shrink-0">
                    {current && needsCyrillic && !current.cyrillic && (
                        <span className="text-[10px] text-warn" title="this font has no Cyrillic letters; another font will draw them">no Cyrillic</span>
                    )}
                    <ChevronDown size={14} className="text-muted" />
                </span>
            </button>
            {open && (
                <div className="absolute z-30 mt-1 w-full rounded-input border border-rule2 bg-paper2 shadow-2xl">
                    <div className="p-2 border-b border-rule flex items-center gap-2">
                        <Search size={14} className="text-muted shrink-0" />
                        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
                            placeholder={fonts ? `search ${fonts.length} fonts` : 'loading fonts…'}
                            className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-muted" />
                        <label className="flex items-center gap-1.5 text-[11px] text-muted shrink-0 cursor-pointer select-none">
                            <input type="checkbox" checked={cyrOnly} onChange={(e) => setCyrOnly(e.target.checked)}
                                className="accent-[var(--color-accent)]" />
                            Cyrillic
                        </label>
                    </div>
                    <div ref={listRef} className="max-h-72 overflow-y-auto custom-scrollbar py-1" role="listbox">
                        {fonts === null && <p className="px-3 py-2 text-xs text-muted">Reading the installed fonts…</p>}
                        {fonts && shown.length === 0 && <p className="px-3 py-2 text-xs text-muted">No font matches.</p>}
                        {shown.map((f) => {
                            const on = current && f.family === current.family;
                            return (
                                <button key={f.family} type="button" role="option" aria-selected={on}
                                    onClick={() => { onChange(f.family); setOpen(false); setQuery(''); }}
                                    className={`w-full flex items-center gap-3 px-3 py-1.5 text-left hover:bg-paper3 ${on ? 'bg-paper3' : ''}`}>
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-[11px] text-muted truncate">{f.family}</span>
                                        <span className="block text-base text-ink truncate leading-tight"
                                            style={{ fontFamily: `"${f.family}", sans-serif` }}>{sample}</span>
                                    </span>
                                    <span className="text-[10px] text-muted shrink-0">
                                        {[f.bold && 'B', f.italic && 'I'].filter(Boolean).join(' ')}
                                    </span>
                                    {on && <Check size={14} className="text-brass shrink-0" />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export function ColorField({ label, value, onChange, presets = [] }) {
    const [text, setText] = useState(value);
    useEffect(() => { setText(value); }, [value]);
    return (
        <div>
            {label && <p className="eyebrow mb-2">{label}</p>}
            <div className="flex items-center gap-2">
                <label className="relative w-9 h-9 rounded-input border border-rule2 cursor-pointer overflow-hidden shrink-0" title="pick any colour">
                    <span className="block w-full h-full" style={{ backgroundColor: value }} />
                    <input type="color" value={HEX.test(value) ? value : '#ffffff'} onChange={(e) => onChange(e.target.value.toUpperCase())}
                        className="absolute inset-0 opacity-0 cursor-pointer" />
                </label>
                <input value={text} onChange={(e) => {
                    const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
                    setText(v);
                    if (HEX.test(v)) onChange(v.toUpperCase());
                }} spellCheck={false} maxLength={7}
                    className="input-field w-24 font-mono text-xs uppercase py-2" aria-label={`${label || 'colour'} hex`} />
                <div className="flex flex-wrap gap-1.5 min-w-0">
                    {presets.map((c) => (
                        <button key={c} type="button" onClick={() => onChange(c)} title={c}
                            className={`w-6 h-6 rounded-full border ${String(value).toUpperCase() === c.toUpperCase() ? 'border-brass ring-2 ring-brass/40' : 'border-rule2'}`}
                            style={{ backgroundColor: c }} />
                    ))}
                </div>
            </div>
        </div>
    );
}

export function SliderField({ label, value, onChange, min, max, step = 1, format = (v) => v, hint }) {
    return (
        <label className="block">
            <span className="flex items-baseline justify-between mb-1.5">
                <span className="eyebrow">{label}</span>
                <span className="readout normal-case text-ink2">{format(value)}</span>
            </span>
            <input type="range" min={min} max={max} step={step} value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className="w-full accent-[var(--color-accent)]" />
            {hint && <span className="text-[11px] text-muted">{hint}</span>}
        </label>
    );
}

export function ToggleChip({ on, onClick, children, title }) {
    return (
        <button type="button" onClick={onClick} aria-pressed={on} title={title}
            className={`h-9 min-w-9 px-3 rounded-input border text-sm transition-colors ${on ? 'border-brass bg-brass/10 text-ink' : 'border-rule2 text-muted hover:text-ink2'}`}>
            {children}
        </button>
    );
}
