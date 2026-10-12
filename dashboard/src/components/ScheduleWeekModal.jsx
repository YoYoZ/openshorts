import React, { useState, useMemo } from 'react';
import { Loader2, Calendar, CheckCircle, AlertCircle, Video, Instagram, Youtube, ChevronLeft, ChevronRight, Circle, ExternalLink } from 'lucide-react';
import { apiFetch } from '../lib/api';
import Modal from './ui/Modal';
import { ChecksBadge } from './ChecklistModal';
import SegmentedControl from './ui/SegmentedControl';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const TIMEZONES = [
    { value: 'Pacific/Midway', label: '(GMT-11:00) Midway' },
    { value: 'Pacific/Honolulu', label: '(GMT-10:00) Honolulu' },
    { value: 'America/Anchorage', label: '(GMT-09:00) Alaska' },
    { value: 'America/Los_Angeles', label: '(GMT-08:00) Los Angeles' },
    { value: 'America/Denver', label: '(GMT-07:00) Denver' },
    { value: 'America/Mexico_City', label: '(GMT-06:00) Mexico City' },
    { value: 'America/Chicago', label: '(GMT-06:00) Chicago' },
    { value: 'America/New_York', label: '(GMT-05:00) New York' },
    { value: 'America/Bogota', label: '(GMT-05:00) Bogota' },
    { value: 'America/Caracas', label: '(GMT-04:00) Caracas' },
    { value: 'America/Santiago', label: '(GMT-04:00) Santiago' },
    { value: 'America/Argentina/Buenos_Aires', label: '(GMT-03:00) Buenos Aires' },
    { value: 'America/Sao_Paulo', label: '(GMT-03:00) Sao Paulo' },
    { value: 'Atlantic/Azores', label: '(GMT-01:00) Azores' },
    { value: 'UTC', label: '(GMT+00:00) UTC' },
    { value: 'Europe/Kyiv', label: '(GMT+02:00/+03:00) Kyiv' },
    { value: 'Europe/Warsaw', label: '(GMT+01:00/+02:00) Warsaw' },
    { value: 'Europe/London', label: '(GMT+00:00) London' },
    { value: 'Europe/Madrid', label: '(GMT+01:00) Madrid' },
    { value: 'Europe/Paris', label: '(GMT+01:00) Paris' },
    { value: 'Europe/Berlin', label: '(GMT+01:00) Berlin' },
    { value: 'Europe/Rome', label: '(GMT+01:00) Rome' },
    { value: 'Africa/Lagos', label: '(GMT+01:00) Lagos' },
    { value: 'Europe/Istanbul', label: '(GMT+03:00) Istanbul' },
    { value: 'Asia/Dubai', label: '(GMT+04:00) Dubai' },
    { value: 'Asia/Kolkata', label: '(GMT+05:30) India' },
    { value: 'Asia/Bangkok', label: '(GMT+07:00) Bangkok' },
    { value: 'Asia/Shanghai', label: '(GMT+08:00) Shanghai' },
    { value: 'Asia/Tokyo', label: '(GMT+09:00) Tokyo' },
    { value: 'Australia/Sydney', label: '(GMT+10:00) Sydney' },
    { value: 'Pacific/Auckland', label: '(GMT+12:00) Auckland' },
];

// Posting goes through our own YouTube Data API upload (youtube_upload.py);
// TikTok and Instagram are not wired up, so they are shown but disabled.
const PLATFORM_OPTIONS = [
    { value: 'tiktok', label: 'TikTok', icon: <Video size={16} />, disabled: true },
    { value: 'instagram', label: 'Instagram', icon: <Instagram size={16} />, disabled: true },
    { value: 'youtube', label: 'YouTube', icon: <Youtube size={16} /> },
];

const CADENCES = [
    { value: 'twice', label: '2 a day' },
    { value: 'daily', label: '1 a day' },
    { value: 'every2', label: 'every 2 days' },
    { value: 'weekly', label: '1 a week' },
];

function getDayLabel(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const target = new Date(date);
    target.setHours(0, 0, 0, 0);

    if (target.getTime() === today.getTime()) return 'Today';
    if (target.getTime() === tomorrow.getTime()) return 'Tomorrow';
    return DAYS[target.getDay()];
}

function formatDate(date) {
    return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function detectTimezone() {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (TIMEZONES.find(t => t.value === tz)) return tz;
        if (tz === 'Europe/Kiev') return 'Europe/Kyiv';
        return 'UTC';
    } catch {
        return 'UTC';
    }
}

export default function ScheduleWeekModal({ isOpen, onClose, clips, jobId, onScheduled = null, checks = {} }) {
    const [time, setTime] = useState('18:00');
    const [time2, setTime2] = useState('12:00');     // second slot for 2/day
    const [cadence, setCadence] = useState('daily');
    const [timezone, setTimezone] = useState(detectTimezone);
    const [startOffset, setStartOffset] = useState(1);
    const [yt, setYt] = useState(null);   // {connected, channel, accounts} from /api/youtube/status
    const [account, setAccount] = useState(null);   // which channel these clips go to
    const ytSettings = React.useRef({});

    // Slot for the i-th clip: day offset from the start day and the time.
    const schedule = useMemo(() => {
        if (!clips) return [];
        const [early, late] = [time, time2].sort();
        return clips.map((clip, i) => {
            let dayStep = i;
            let slotTime = time;
            if (cadence === 'twice') { dayStep = Math.floor(i / 2); slotTime = i % 2 === 0 ? early : late; }
            else if (cadence === 'every2') dayStep = i * 2;
            else if (cadence === 'weekly') dayStep = i * 7;
            const date = new Date();
            date.setDate(date.getDate() + startOffset + dayStep);
            date.setHours(0, 0, 0, 0);
            // A subset (bulk "schedule selected") carries each clip's real index.
            return { clip, index: i, clipIndex: clip._index ?? i, date, time: slotTime };
        });
    }, [clips, startOffset, cadence, time, time2]);

    const [scheduling, setScheduling] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, results: [] });
    const [done, setDone] = useState(false);

    // Reset state and check the YouTube connection when the modal opens.
    const prevOpen = React.useRef(false);
    React.useEffect(() => {
        if (isOpen && !prevOpen.current) {
            setScheduling(false);
            setDone(false);
            setProgress({ current: 0, total: 0, results: [] });
            setYt(null);
            setAccount(null);
            // The channel: the one this project already posts to, else the
            // default; its post time, timezone and cadence come from
            // Settings → YouTube (that channel's own values first).
            Promise.all([
                apiFetch('/api/settings').then((r) => r.json()).catch(() => ({})),
                apiFetch('/api/youtube/status').then((r) => r.json())
                    .catch(() => ({ connected: false, error: 'backend unreachable' })),
                jobId ? apiFetch(`/api/youtube/project/${jobId}`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
                    : Promise.resolve({}),
            ]).then(([s, status, proj]) => {
                ytSettings.current = s?.youtube || {};
                setYt(status);
                const ok = (status.accounts || []).filter((a) => !a.error).map((a) => a.account);
                const first = ok.includes(proj?.account) ? proj.account : (status.default_account || ok[0] || null);
                setAccount(first);
            });
        }
        prevOpen.current = isOpen;
    }, [isOpen, jobId]);

    // The chosen channel's post time, timezone and cadence (its own values
    // first, the shared ones otherwise).
    React.useEffect(() => {
        if (!account) return;
        const base = ytSettings.current || {};
        const own = (base.channels || {})[account] || {};
        const pick = (k) => (own[k] !== undefined && own[k] !== null && own[k] !== '' ? own[k] : base[k]);
        if (pick('default_time')) setTime(pick('default_time'));
        if (pick('timezone')) setTimezone(pick('timezone'));
        if (pick('cadence')) setCadence(pick('cadence'));
    }, [account]);

    if (!isOpen) return null;

    const selectedPlatforms = ['youtube'];
    const channelsOk = (yt?.accounts || []).filter((a) => !a.error);
    const chosen = channelsOk.find((a) => a.account === account) || yt?.channel;
    const canPost = !!yt?.connected;

    // One clip a day, uploaded in order. Clips already on YouTube are skipped
    // server-side; the daily API quota, when hit, stops the run cleanly and
    // the rest can be scheduled tomorrow with the same button.
    const handleScheduleAll = async () => {
        if (!canPost) return;
        setScheduling(true);
        setDone(false);
        const total = schedule.length;
        setProgress({ current: 0, total, results: [] });

        const results = [];
        let quotaHit = false;
        for (let i = 0; i < schedule.length; i++) {
            const { clipIndex, date, time: slotTime } = schedule[i];
            if (quotaHit) {
                results.push({ index: i, success: false, error: 'daily quota reached', quota: true });
                setProgress({ current: i + 1, total, results: [...results] });
                continue;
            }
            const pad = (n) => String(n).padStart(2, '0');
            const scheduledLocal = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${slotTime}`;
            try {
                const res = await apiFetch('/api/youtube/upload', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ job_id: jobId, clip_index: clipIndex, scheduled_local: scheduledLocal, timezone, account }),
                });
                const body = await res.json().catch(() => ({}));
                if (res.status === 429) {
                    quotaHit = true;
                    results.push({ index: i, success: false, error: 'daily quota reached', quota: true });
                } else if (!res.ok) {
                    results.push({ index: i, success: false, error: body.detail || `HTTP ${res.status}` });
                } else {
                    results.push({ index: i, success: true, skipped: !!body.skipped, url: body.url, publishAt: body.publish_at });
                }
            } catch (e) {
                results.push({ index: i, success: false, error: e.message });
            }
            setProgress({ current: i + 1, total, results: [...results] });
        }

        setDone(true);
        onScheduled?.();
        setScheduling(false);
    };

    const successCount = progress.results.filter(r => r.success).length;
    const failCount = progress.results.filter(r => !r.success).length;

    const footer = (
        <div className="flex flex-col sm:flex-row gap-3">
            <button
                onClick={onClose}
                disabled={scheduling}
                className="btn-ghost flex-1"
            >
                {done ? 'close' : 'cancel'}
            </button>
            {!done ? (
                <button
                    onClick={handleScheduleAll}
                    disabled={scheduling || !canPost || selectedPlatforms.length === 0}
                    className="btn-primary flex-1"
                >
                    {scheduling ? (
                        <>
                            <Loader2 size={16} className="animate-spin" />
                            scheduling...
                        </>
                    ) : (
                        <>
                            <Calendar size={16} />
                            schedule {clips?.length || 0} clips
                        </>
                    )}
                </button>
            ) : (
                <a
                    href="https://studio.youtube.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary flex-1 no-underline"
                >
                    <ExternalLink size={16} />
                    open YouTube Studio
                </a>
            )}
        </div>
    );

    return (
        <Modal
            isOpen={isOpen}
            onClose={scheduling ? undefined : onClose}
            eyebrow="PUBLISH · WEEK"
            title="schedule week"
            size="md"
            footer={footer}
        >
            <p className="readout mb-4">{clips?.length || 0} CLIPS · {CADENCES.find((c) => c.value === cadence)?.label.toUpperCase()}</p>

            <div className="mb-5">
                <label className="eyebrow block mb-2">how often</label>
                <SegmentedControl
                    options={CADENCES.map((c) => ({ ...c, disabled: scheduling }))}
                    value={cadence}
                    onChange={setCadence}
                    size="sm"
                />
            </div>

            {yt && !yt.connected && (
                <div className="mb-4 p-3 bg-warn/10 text-warn text-xs rounded-input flex items-start gap-2">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <div>YouTube is not connected: {yt.error || 'no token in openshorts/youtube_auth'}.</div>
                </div>
            )}
            {yt?.connected && (
                <div className="mb-4 space-y-2">
                    {channelsOk.length > 1 && (
                        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="channel">
                            {channelsOk.map((a) => (
                                <button key={a.account} type="button" role="radio" aria-checked={a.account === account}
                                    onClick={() => setAccount(a.account)} disabled={scheduling}
                                    className={`px-3 py-2 rounded-input border text-sm text-left ${a.account === account ? 'border-brass bg-paper3 text-ink' : 'border-rule2 text-ink2 hover:border-muted'}`}>
                                    {a.title}{a.handle && <span className="block text-[11px] text-muted">{a.handle}</span>}
                                </button>
                            ))}
                        </div>
                    )}
                    <p className="text-xs text-muted">
                        Posting to <span className="text-ink2">{chosen?.title}</span>
                        {chosen?.handle ? ` (${chosen.handle})` : ''}. Each clip uploads now as private
                        and goes public at its time.
                    </p>
                </div>
            )}

            {/* Time + Timezone */}
            <div className="mb-5 grid grid-cols-2 gap-3">
                <div>
                    <label className="eyebrow block mb-2">{cadence === 'twice' ? 'times' : 'time'}</label>
                    <div className="flex gap-2">
                        <input
                            type="time"
                            value={time}
                            onChange={(e) => setTime(e.target.value)}
                            disabled={scheduling}
                            className="input-field [color-scheme:dark]"
                        />
                        {cadence === 'twice' && (
                            <input
                                type="time"
                                value={time2}
                                onChange={(e) => setTime2(e.target.value)}
                                disabled={scheduling}
                                className="input-field [color-scheme:dark]"
                            />
                        )}
                    </div>
                </div>
                <div>
                    <label className="eyebrow block mb-2">timezone</label>
                    <select
                        value={timezone}
                        onChange={(e) => setTimezone(e.target.value)}
                        disabled={scheduling}
                        className="input-field appearance-none cursor-pointer"
                    >
                        {!TIMEZONES.some((t) => t.value === timezone) && <option value={timezone}>{timezone}</option>}
                        {TIMEZONES.map(tz => (
                            <option key={tz.value} value={tz.value}>{tz.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Start day offset */}
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
                <span className="eyebrow">start from</span>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setStartOffset(Math.max(1, startOffset - 1))}
                        disabled={startOffset <= 1 || scheduling}
                        className="btn-quiet px-2 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <ChevronLeft size={16} />
                    </button>
                    <span className="readout text-ink2 min-w-[110px] text-center">
                        {(() => {
                            const d = new Date();
                            d.setDate(d.getDate() + startOffset);
                            return `${getDayLabel(d)} · ${formatDate(d)}`;
                        })()}
                    </span>
                    <button
                        onClick={() => setStartOffset(startOffset + 1)}
                        disabled={scheduling}
                        className="btn-quiet px-2 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <ChevronRight size={16} />
                    </button>
                </div>
            </div>

            {(() => {
                // Checklist results from the clip cards: say so before posting
                // anything that has blockers or warnings.
                const blocked = schedule.filter(({ clipIndex }) => checks?.[clipIndex]?.fail).length;
                const warned = schedule.filter(({ clipIndex }) => !checks?.[clipIndex]?.fail && checks?.[clipIndex]?.warn).length;
                if (!blocked && !warned) return null;
                return (
                    <p className={`mb-3 px-3 py-2 rounded-input text-xs border ${blocked ? 'border-danger/50 text-danger' : 'border-warn/40 text-warn'}`}>
                        {blocked ? `${blocked} clip${blocked > 1 ? 's' : ''} fail the checklist (✕). ` : ''}
                        {warned ? `${warned} with things to improve (!). ` : ''}
                        Open a clip's “check” step to see what.
                    </p>
                );
            })()}

            {/* Calendar list */}
            <div className="mb-5 border-y border-rule divide-y divide-rule">
                {schedule.map(({ clip, index, clipIndex, date, time: slotTime }) => (
                    <div key={index} className="flex items-center gap-3 py-2.5">
                        <div className="w-24 shrink-0">
                            <span className="readout">{getDayLabel(date)} · {formatDate(date)}</span>
                        </div>

                        <div className="flex-1 min-w-0">
                            <div className="text-xs text-ink truncate">
                                <ChecksBadge summary={checks?.[clipIndex]} className="mr-1.5" />
                                {clip.video_title_for_youtube_short || 'Viral Short'}
                            </div>
                            <div className="readout mt-0.5 truncate">
                                {slotTime} · {TIMEZONES.find(t => t.value === timezone)?.label || timezone}
                                {progress.results[index]?.skipped && ' · already on YouTube'}
                                {progress.results[index]?.error && ` · ${progress.results[index].error}`}
                            </div>
                        </div>

                        <div className="shrink-0">
                            {progress.results[index]?.success === true && (
                                <a href={progress.results[index].url} target="_blank" rel="noopener noreferrer"
                                    title={progress.results[index].skipped ? 'already on YouTube' : 'open on YouTube'}>
                                    <CheckCircle size={16} className={progress.results[index].skipped ? 'text-muted' : 'text-ok'} />
                                </a>
                            )}
                            {progress.results[index]?.success === false && (
                                <span title={progress.results[index].error}>
                                    <AlertCircle size={16} className={progress.results[index].quota ? 'text-warn' : 'text-danger'} />
                                </span>
                            )}
                            {scheduling && progress.current === index && (
                                <Loader2 size={16} className="text-brass animate-spin" />
                            )}
                            {!scheduling && progress.results[index] === undefined && (
                                <Circle size={16} className="text-muted" />
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Platforms */}
            <div className="mb-5">
                <label className="eyebrow block mb-2">platforms</label>
                <SegmentedControl
                    multi
                    options={PLATFORM_OPTIONS.map(opt => ({ ...opt, disabled: opt.disabled || scheduling }))}
                    value={selectedPlatforms}
                    onChange={() => {}}
                />
                <p className="readout normal-case mt-2">TikTok and Instagram aren't connected yet.</p>
            </div>

            {/* A whole week of tiktok posts is a whole week of silent drafts:
                this modal writes no captions of its own either (it sends the
                clip's generated title/description), and tiktok keeps none of
                them on a draft. Say it before the button, not after. */}
            {!scheduling && !done && (
                <p className="text-xs text-muted mb-4">
                    If YouTube's daily API quota runs out mid-way, the rest are left unscheduled; press the
                    button again tomorrow, and clips already on YouTube are skipped.
                </p>
            )}

            {/* Progress bar */}
            {(scheduling || done) && (
                <div className="mb-1">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-muted lowercase">{scheduling ? 'scheduling...' : 'complete'}</span>
                        <span className="readout">{progress.current}/{progress.total}</span>
                    </div>
                    <div className="w-full h-1.5 bg-paper3 rounded-full overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all duration-500 ${done && failCount === 0 ? 'bg-ok' : done && failCount > 0 ? 'bg-danger' : 'bg-brass'}`}
                            style={{ width: `${(progress.current / progress.total) * 100}%` }}
                        />
                    </div>
                    {done && (
                        <div className="mt-3 text-xs text-center lowercase">
                            {failCount === 0 ? (
                                <span className="text-ok">all clips scheduled</span>
                            ) : (
                                <span className="text-danger">{successCount} scheduled, {failCount} not scheduled (hover the icons)</span>
                            )}
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
}
