import React, { useEffect, useState } from 'react';
import { Mic } from 'lucide-react';
import { apiFetch } from '../lib/api';

// Where speech is transcribed for new jobs (/api/local/settings, stored on the
// server so every job picks it up): Groq's hosted whisper, the local GPU
// model, or Groq with the local model as fallback.
const MODES = [
    { value: 'auto', label: 'auto', hint: 'Groq first, local whisper if it fails' },
    { value: 'groq', label: 'groq only', hint: 'hosted whisper-large-v3, fails the job if Groq is down' },
    { value: 'whisper', label: 'local only', hint: 'your GPU, no audio leaves the machine' },
];

export default function TranscriptionSettings() {
    const [settings, setSettings] = useState(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        apiFetch('/api/local/settings')
            .then((r) => (r.ok ? r.json() : null))
            .then(setSettings)
            .catch(() => {});
    }, []);

    const choose = async (value) => {
        setSaving(true);
        try {
            const res = await apiFetch('/api/local/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transcribe_backend: value }),
            });
            if (res.ok) setSettings(await res.json());
        } finally {
            setSaving(false);
        }
    };

    if (!settings) return null;
    const needsKey = !settings.groq_key_set && settings.transcribe_backend !== 'whisper';

    return (
        <div className="card p-5 mb-6">
            <div className="flex items-center gap-2 mb-1">
                <Mic size={16} className="text-brass" />
                <h2 className="text-sm font-medium text-ink lowercase">transcription</h2>
            </div>
            <p className="text-xs text-muted mb-4">Applies to new jobs.</p>
            <div className="grid grid-cols-3 gap-2">
                {MODES.map((m) => {
                    const active = settings.transcribe_backend === m.value;
                    return (
                        <button
                            key={m.value}
                            type="button"
                            disabled={saving}
                            onClick={() => choose(m.value)}
                            className={`rounded-input border px-3 py-2.5 text-left transition-colors ${active ? 'border-brass bg-brass/5' : 'border-rule hover:border-rule2'}`}
                        >
                            <span className={`block text-sm lowercase ${active ? 'text-ink' : 'text-ink2'}`}>{m.label}</span>
                            <span className="block readout normal-case mt-1 leading-snug">{m.hint}</span>
                        </button>
                    );
                })}
            </div>
            <p className={`text-xs mt-3 ${needsKey ? 'text-warn' : 'text-muted'}`}>
                {settings.groq_key_set
                    ? 'Groq key found in .env.'
                    : 'No GROQ_API_KEY in .env, so jobs transcribe locally. Add the key and restart the server to use Groq.'}
            </p>
        </div>
    );
}
