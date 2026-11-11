import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiJson } from './api';

const DraftContext = createContext(null);
const noop = () => {};
const EMPTY = { data: {}, dirty: {}, setPart: noop };

export function ClipDraftProvider({ jobId, clipIndex, children }) {
    const [data, setData] = useState({ segments: [], cuts: [], overrides: {}, subtitles: null, hook: null, effects: null, sourceUrl: null, geometry: null, duration: 0, words: [] });
    const [dirty, setDirty] = useState({});
    useEffect(() => {
        let alive = true;
        Promise.all([
            apiJson(`/api/clip/${jobId}/${clipIndex}/edl`).catch(() => null),
            apiJson(`/api/clip/${jobId}/${clipIndex}/scenes`).catch(() => null),
        ]).then(([edl, scenes]) => {
            if (!alive) return;
            const segs = edl?.segments || [];
            const duration = edl?.duration || segs.reduce((n, s) => n + (s.end - s.start), 0) || scenes?.duration || 0;
            setData((v) => ({ ...v, segments: segs, sourceUrl: edl?.source?.url || null, words: edl?.words || [], duration,
                cuts: scenes?.saved_cuts || scenes?.auto_cuts || [], overrides: scenes?.saved_overrides || {},
                geometry: scenes ? { cropWidthFraction: scenes.crop_width_fraction, splitBox: scenes.split_box, sourceWidth: scenes.source_width, sourceHeight: scenes.source_height, scenes: scenes.scenes } : null }));
        });
        return () => { alive = false; };
    }, [jobId, clipIndex]);
    const setPart = useCallback((part, value) => {
        setData((v) => ({ ...v, [part]: value }));
        setDirty((v) => ({ ...v, [part]: true }));
    }, []);
    const value = useMemo(() => ({ data, dirty, setPart }), [data, dirty, setPart]);
    return <DraftContext.Provider value={value}>{children}</DraftContext.Provider>;
}

// Tools outside the editor shell keep their existing standalone behavior.
// eslint-disable-next-line react-refresh/only-export-components -- hook shares its provider context
export function useClipDraft() { return useContext(DraftContext) || EMPTY; }
