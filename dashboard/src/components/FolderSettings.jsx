import React, { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';

// Desktop app only (window.desktop from the Electron preload): where projects
// and uploads are stored. Saving restarts the backend on the new folders.
const FIELDS = [
    { key: 'outputDir', label: 'projects', hint: 'source videos, clips and project data', open: 'output' },
    { key: 'uploadDir', label: 'uploads', hint: 'files you upload before processing', open: 'uploads' },
];

export default function FolderSettings() {
    const desktop = typeof window !== 'undefined' ? window.desktop : undefined;
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!desktop) return;
        desktop.getConfig().then((cfg) => { setSaved(cfg); setDraft(cfg); });
    }, [desktop]);

    if (!desktop || !draft) return null;
    const changed = FIELDS.some((f) => draft[f.key] !== saved[f.key]);

    const pick = async (key) => {
        const dir = await desktop.chooseFolder(draft[key]);
        if (dir) setDraft((d) => ({ ...d, [key]: dir }));
    };

    const save = async () => {
        setSaving(true);
        // The shell restarts the backend and reloads this page.
        await desktop.setConfig({ outputDir: draft.outputDir, uploadDir: draft.uploadDir });
    };

    return (
        <div className="card p-5 mb-6">
            <div className="flex items-center gap-2 mb-1">
                <FolderOpen size={16} className="text-brass" />
                <h2 className="text-sm font-medium text-ink lowercase">folders</h2>
            </div>
            <p className="text-xs text-muted mb-4">
                Existing projects stay where they are; move them yourself if you change the projects folder.
            </p>
            <div className="space-y-3">
                {FIELDS.map((f) => (
                    <div key={f.key}>
                        <div className="flex items-baseline justify-between mb-1">
                            <span className="text-sm text-ink2 lowercase">{f.label}</span>
                            <span className="readout normal-case">{f.hint}</span>
                        </div>
                        <div className="flex gap-2">
                            <input readOnly value={draft[f.key]} className="input-field flex-1 text-xs font-mono" title={draft[f.key]} />
                            <button type="button" onClick={() => pick(f.key)} className="btn-ghost px-3 text-xs">change…</button>
                            <button type="button" onClick={() => desktop.openFolder(f.open)} className="btn-ghost px-3 text-xs" title="open in Explorer">open</button>
                        </div>
                    </div>
                ))}
            </div>
            <div className="flex items-center gap-3 mt-4">
                <button type="button" onClick={save} disabled={!changed || saving} className="btn-primary px-4 py-2 text-sm disabled:opacity-40">
                    {saving ? 'restarting…' : 'save and restart'}
                </button>
                <button type="button" onClick={() => desktop.openFolder('logs')} className="text-xs text-muted hover:text-ink2 lowercase">
                    open logs
                </button>
            </div>
        </div>
    );
}
