import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
// The Remotion player is the heaviest part of the bundle: load it when this
// editor first opens, not with the app.
const RemotionPreviewLazy = React.lazy(() => import('./RemotionPreview'));
function RemotionPreview(props) {
    return <React.Suspense fallback={<div className="w-full h-full bg-black" />}><RemotionPreviewLazy {...props} /></React.Suspense>;
}
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';

const ENTRANCE_OPTIONS = [
    { value: 'spring', label: 'Bounce' },
    { value: 'fade', label: 'Fade' },
    { value: 'slide-up', label: 'Slide Up' },
    { value: 'none', label: 'None' },
];

// Must mirror hooks.py HOOK_STYLES.
const HOOK_STYLES = [
    { value: 'pill', label: 'Pills', box: 'rgba(255,255,255,0.98)', text: '#000', sans: true },
    { value: 'classic', label: 'Classic', box: 'rgba(255,255,255,0.94)', text: '#000' },
    { value: 'dark', label: 'Dark', box: 'rgba(18,18,20,0.92)', text: '#fff' },
    { value: 'yellow', label: 'Yellow', box: 'rgba(255,214,0,0.96)', text: '#000' },
    { value: 'red', label: 'Red', box: 'rgba(220,38,38,0.96)', text: '#fff' },
    { value: 'outline', label: 'Outline', box: 'transparent', text: '#fff', outline: true },
    { value: 'outline_yellow', label: 'Outline+', box: 'transparent', text: '#FFD600', outline: true },
];

// Must mirror hooks.py HOOK_FONTS (all bundled: /fonts/*.ttf).
const FONT_OPTIONS = [
    { value: 'montserrat', label: 'Montserrat' },
    { value: 'anton', label: 'Anton' },
    { value: 'serif', label: 'Serif' },
];
const FONT_CSS = {
    montserrat: { fontFamily: "'Montserrat-ExtraBold', 'Montserrat', sans-serif", fontWeight: 800 },
    anton: { fontFamily: "'Anton-Regular', Impact, sans-serif", fontWeight: 400 },
    serif: { fontFamily: "'Noto Serif', Georgia, serif", fontWeight: 700 },
};
// The style's own typeface when none is picked (what hooks.py renders).
// Montserrat for every style unless another face is picked (hooks.py agrees).
const styleFont = () => 'montserrat';

// auto: the server keeps the hook off the speaker's face and the captions
// (hook_placement.py). The preview cannot see faces and draws it at the top.
const POSITION_OPTIONS = [
    { value: 'auto', label: 'auto' },
    { value: 'top', label: 'top' },
    { value: 'center', label: 'center' },
    { value: 'bottom', label: 'bottom' },
];

const SIZE_OPTIONS = [
    { value: 'S', label: 'Small' },
    { value: 'M', label: 'Medium' },
    { value: 'L', label: 'Large' },
];

// Last-used hook settings, restored on the next open (style always reset to
// classic otherwise, which users read as the picker being broken).
function loadHookPrefs() {
    try { return JSON.parse(localStorage.getItem('os_hook_prefs')) || {}; } catch { return {}; }
}

export default function HookModal({ inline = false, isOpen, onClose, onGenerate, onApplyAll, bulkCount = 0, bulkProgress, onRemove, isProcessing, videoUrl, initialText, durationInSeconds, existingSubtitles, hasCaptions, serverRender, burnedHook }) {
    const prefs = loadHookPrefs();
    const [text, setText] = useState(initialText || 'POV: You are using the viral hook feature');
    // Stored as `pos`, not `position`: before 'auto' existed every save wrote
    // 'top' whether or not the user ever touched the control.
    const [position, setPosition] = useState(prefs.pos || 'auto');
    // Size multiplier (1 = the style's default); old prefs stored S/M/L.
    const LEGACY_SIZES = { S: 0.8, M: 1.0, L: 1.3 };
    const [size, setSize] = useState(
        typeof prefs.size === 'number' ? prefs.size : (LEGACY_SIZES[prefs.size] ?? 1.0));
    const [style, setStyle] = useState(prefs.style || 'pill');
    // null = follow the style's own typeface.
    const [font, setFont] = useState(prefs.font || null);
    const effectiveFont = font || styleFont(style);
    const [entranceAnimation, setEntranceAnimation] = useState(prefs.entranceAnimation || 'spring');
    const [displayDuration, setDisplayDuration] = useState(5);

    if (!isOpen) return null;

    // Build hook config for Remotion preview
    const hookConfig = {
        text: text || 'Enter your text...',
        position,
        size,
        style,
        font: effectiveFont,
        entranceAnimation,
        displayDurationSec: displayDuration,
    };

    const useRemotionPreview = !!videoUrl;

    // Fallback preview logic (same as original)
    const getPositionClass = () => {
        switch (position) {
            case 'center': return 'items-center justify-center';
            case 'bottom': return 'items-center justify-end pb-[20%]';
            case 'top': default: return 'items-center justify-start pt-[20%]';
        }
    };

    const getSizeStyle = () => ({ fontSize: `${Math.round(18 * size)}px`, maxWidth: '95%' });

    const pillFontFace = "@font-face{font-family:'Montserrat-ExtraBold';src:url('/fonts/Montserrat-ExtraBold.ttf') format('truetype');font-weight:800;}"
        + "@font-face{font-family:'Anton-Regular';src:url('/fonts/Anton-Regular.ttf') format('truetype');font-weight:400;}";

    return (
        <Modal inline={inline} isOpen={isOpen} onClose={onClose} size="lg" eyebrow="EDITOR · HOOK" title="edit hook">
            <style>{pillFontFace}</style>
            {/* Inline (workspace tab): preview | text, style, font | placement,
                timing, actions, all at full height so nothing scrolls. */}
            <div className={`flex flex-col md:flex-row gap-6 ${inline ? 'md:h-full md:min-h-0' : ''}`}>
                {/* Left: Preview */}
                <div className={`w-full max-w-[300px] mx-auto md:mx-0 shrink-0 flex flex-col items-center justify-center bg-black rounded-card border border-rule overflow-hidden relative aspect-[9/16] ${inline ? 'md:h-full md:min-h-0 md:w-auto md:max-w-[38%]' : 'md:w-[300px] self-start'}`}>
                    {useRemotionPreview ? (
                        <RemotionPreview
                            videoUrl={videoUrl}
                            durationInSeconds={durationInSeconds || 30}
                            hook={hookConfig}
                            subtitles={existingSubtitles || null}
                        />
                    ) : (
                        <>
                            <video src={videoUrl} className="w-full h-full object-contain opacity-50" muted playsInline />
                            <div className={`absolute w-full px-8 text-center transition-all duration-300 pointer-events-none flex flex-col h-full ${getPositionClass()}`}>
                                <div
                                    className="text-black font-bold px-3 py-2 rounded-xl shadow-2xl text-center whitespace-pre-wrap transition-all duration-200"
                                    style={{
                                        ...getSizeStyle(),
                                        backgroundColor: 'rgba(255, 255, 255, 0.82)',
                                        ...FONT_CSS[effectiveFont],
                                        boxShadow: '0 4px 15px rgba(0,0,0,0.5)',
                                        paddingTop: '10px',
                                        paddingBottom: '10px',
                                        paddingLeft: '12px',
                                        paddingRight: '12px'
                                    }}
                                >
                                    {text || "Enter your text..."}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Middle: what the hook says and how it looks */}
                <div className={`w-full flex flex-col space-y-5 ${inline ? 'md:flex-1 md:min-w-[280px] md:h-full md:min-h-0 md:overflow-y-auto custom-scrollbar md:pr-1' : 'md:w-80'}`}>
                        {/* Text Input */}
                        <div>
                            <p className="eyebrow mb-2">Text</p>
                            <textarea
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                rows={inline ? 3 : 4}
                                className="input-field resize-none"
                                placeholder="Enter text that will stop the scroll..."
                            />
                        </div>

                        {/* Style (new) */}
                        <div>
                            <p className="eyebrow mb-2">Style</p>
                            <div className={`grid gap-1.5 ${inline ? 'grid-cols-4' : 'grid-cols-3'}`}>
                                {HOOK_STYLES.map((s) => (
                                    <button
                                        key={s.value}
                                        onClick={() => setStyle(s.value)}
                                        className={`px-1 py-2 rounded-input border text-xs transition-colors
                                            ${style === s.value ? 'border-[color:var(--color-accent)]' : 'border-rule2 hover:border-[color:var(--color-accent)]'}`}
                                        title={s.label}
                                    >
                                        {s.value === 'pill' ? (
                                            <span className="flex flex-col items-center gap-0.5 py-0.5" style={FONT_CSS[font || styleFont(s.value)]}>
                                                <span className="rounded-md px-1.5 text-[13px] leading-5 bg-white text-black">Aa Bb</span>
                                                <span className="rounded-md px-1.5 text-[13px] leading-5 bg-white text-black">Cc</span>
                                            </span>
                                        ) : (
                                            <span
                                                className="block rounded-md px-1 py-1.5 text-[15px] leading-5"
                                                style={{
                                                    ...FONT_CSS[font || styleFont(s.value)],
                                                    backgroundColor: s.box,
                                                    color: s.text,
                                                    textShadow: s.outline ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000' : 'none',
                                                }}
                                            >Aa</span>
                                        )}
                                        <span className="block mt-1 text-muted">{s.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Typeface */}
                        <div>
                            <p className="eyebrow mb-2">Font</p>
                            <div className="grid grid-cols-3 gap-1.5">
                                {FONT_OPTIONS.map((f) => (
                                    <button
                                        key={f.value}
                                        onClick={() => setFont(f.value)}
                                        className={`px-1 py-2 rounded-input border text-[15px] text-ink transition-colors
                                            ${effectiveFont === f.value ? 'border-[color:var(--color-accent)]' : 'border-rule2 hover:border-[color:var(--color-accent)]'}`}
                                        style={FONT_CSS[f.value]}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                </div>

                {/* Right: placement, timing, actions */}
                <div className={`w-full flex flex-col ${inline ? 'md:w-80 md:shrink-0 md:h-full md:min-h-0' : 'md:w-80'}`}>
                    <div className="space-y-5 flex-1 overflow-y-auto custom-scrollbar pr-1">
                        {/* Position Control */}
                        <div>
                            <p className="eyebrow mb-2">Position</p>
                            <SegmentedControl
                                options={POSITION_OPTIONS}
                                value={position}
                                onChange={setPosition}
                                size="sm"
                            />
                            {position === 'auto' && (
                                <p className="text-[11px] text-muted mt-1.5 leading-relaxed">
                                    Placed where it covers no face and no captions.
                                    The preview shows it at the top.
                                </p>
                            )}
                            {position === 'bottom' && hasCaptions && (
                                <p className="text-[11px] text-warn mt-1.5 leading-relaxed">
                                    This clip has captions near the bottom — the hook may
                                    overlap them (and TikTok's UI). Top is the safe zone.
                                </p>
                            )}
                        </div>

                        {/* Size Control */}
                        <div>
                            <div className="flex items-baseline justify-between mb-2">
                                <p className="eyebrow">Size</p>
                                <span className="readout tabular-nums">{Math.round(size * 100)}%</span>
                            </div>
                            <input
                                type="range"
                                min={0.5}
                                max={2}
                                step={0.05}
                                value={size}
                                onChange={(e) => setSize(Number(e.target.value))}
                                className="w-full accent-[color:var(--color-accent)]"
                            />
                            <div className="flex justify-between readout mt-1"><span>50%</span><span>200%</span></div>
                        </div>

                        {/* Entrance Animation (new) */}
                        {!serverRender && (
                        <div>
                            <p className="eyebrow mb-2">Entrance</p>
                            <SegmentedControl
                                options={ENTRANCE_OPTIONS}
                                value={entranceAnimation}
                                onChange={setEntranceAnimation}
                                columns={2}
                                size="sm"
                            />
                        </div>
                        )}

                        {/* Display Duration (new) */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <p className="eyebrow">Duration</p>
                                <span className="readout">{displayDuration}S</span>
                            </div>
                            <input
                                type="range"
                                min="2"
                                max="15"
                                value={displayDuration}
                                onChange={(e) => setDisplayDuration(parseInt(e.target.value))}
                                className="w-full accent-[var(--color-accent)]"
                            />
                            <div className="flex justify-between">
                                <span className="readout">2S</span>
                                <span className="readout">15S</span>
                            </div>
                        </div>

                        {burnedHook && (
                            <div className="p-3 border border-rule rounded-input text-xs text-muted space-y-2">
                                <p>
                                    This clip has a hook burned in ("{burnedHook}").
                                    Generating replaces it with the new one.
                                </p>
                                {onRemove && (
                                    <button
                                        onClick={onRemove}
                                        disabled={isProcessing}
                                        className="text-warn underline underline-offset-2 hover:opacity-80 transition-opacity"
                                    >
                                        remove hook from clip
                                    </button>
                                )}
                            </div>
                        )}

                        <div className="p-3 border border-rule rounded-input text-xs text-muted">
                            Tip: keep it short and punchy. Using "POV:" or specific questions works best for retention.
                        </div>
                    </div>

                    <div className="flex gap-2 mt-5 shrink-0">
                        <button onClick={onClose} className="btn-ghost">
                            cancel
                        </button>
                        <button
                            onClick={() => {
                                try {
                                    localStorage.setItem('os_hook_prefs', JSON.stringify({
                                        style, font, pos: position, size, entranceAnimation,
                                    }));
                                } catch { /* ignore */ }
                                onGenerate({
                                    text, position, size, style, font: effectiveFont,
                                    // Remotion data
                                    remotion: hookConfig,
                                });
                            }}
                            disabled={isProcessing || !text.trim()}
                            className="btn-primary flex-1"
                        >
                            {isProcessing && <Loader2 size={16} className="animate-spin text-brassink" />}
                            {isProcessing ? 'saving...' : (burnedHook ? 'update hook' : 'add hook')}
                        </button>
                    </div>
                    {onApplyAll && bulkCount > 1 && (() => {
                        const running = !!bulkProgress?.running;
                        const finished = !running && bulkProgress?.total > 0 && bulkProgress.current === bulkProgress.total;
                        return (
                            <div className="mt-2 shrink-0">
                                <button
                                    type="button"
                                    onClick={() => {
                                        try {
                                            localStorage.setItem('os_hook_prefs', JSON.stringify({
                                                style, font, pos: position, size, entranceAnimation,
                                            }));
                                        } catch { /* ignore */ }
                                        onApplyAll({ position, size, style, font: effectiveFont, remotion: hookConfig });
                                    }}
                                    disabled={running || isProcessing}
                                    className="btn-ghost w-full"
                                    title="Each clip keeps its own hook text; this look also becomes the default for new projects."
                                >
                                    {running && <Loader2 size={16} className="animate-spin text-brass" />}
                                    {running
                                        ? `applying to clip ${bulkProgress.current} of ${bulkProgress.total}…`
                                        : `apply this style to all ${bulkCount} clips`}
                                </button>
                                {running && (
                                    <div className="mt-2 h-1 rounded-full bg-paper3 overflow-hidden">
                                        <div className="h-full bg-brass transition-[width] duration-500"
                                            style={{ width: `${(bulkProgress.current / bulkProgress.total) * 100}%` }} />
                                    </div>
                                )}
                                {finished && bulkProgress.errors > 0 && (
                                    <p className="text-xs text-danger mt-1">{bulkProgress.errors} clip(s) failed.</p>
                                )}
                                <p className="readout normal-case mt-1.5">
                                    Keeps each clip's own text. Also the default for new projects.
                                </p>
                            </div>
                        );
                    })()}
                </div>
            </div>
        </Modal>
    );
}
