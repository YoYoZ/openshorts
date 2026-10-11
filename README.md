# AutoShortsCut

A local desktop app that turns long videos into YouTube Shorts: it transcribes
the video, lets an AI pick the moments worth a short, cuts and reframes them to
9:16, burns styled karaoke captions and a hook, checks each clip against a
pre-publish list, and schedules them on your own YouTube channel.

Everything runs on your machine. The only things that leave it are the API
calls to the AI providers you configure (with your own keys) and the uploads
to your YouTube channel.

It is a fork of [OpenShorts](https://github.com/mutonby/openshorts) (MIT),
reshaped from a hosted clipping service into a single-user tool. See
[What changed from OpenShorts](#what-changed-from-openshorts).

---

## Contents

- [What it does](#what-it-does)
- [Install](#install)
- [First run: settings](#first-run-settings)
- [Connecting YouTube](#connecting-youtube)
- [Working with clips](#working-with-clips)
- [Costs](#costs)
- [Where things live](#where-things-live)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [What changed from OpenShorts](#what-changed-from-openshorts)

---

## What it does

**Pipeline** (per video, one click):

1. **Download or upload**: a YouTube link (yt-dlp) or a local file.
2. **Transcribe** with word timings: Groq Whisper in the cloud (fast, free
   tier) or faster-whisper locally on your GPU/CPU; *auto* tries Groq first and
   falls back to local.
3. **Pick moments**: the AI model scores the whole transcript and picks the
   best 15–60 s clips (lengths and counts are settings), with a title,
   description and hook for each.
4. **Choose a layout** per video: single crop that follows the speaker, two
   speakers stacked, or a screen recording over the presenter. "Auto" asks a
   vision model; you can force one in the new-project form.
5. **Render** each clip (NVENC when available), burn captions and the hook.

**Editing** (per clip, in any order — every step rebuilds the clip from clean
layers, so a later trim keeps your captions and hook):

| Step | What you can do |
|---|---|
| 1 · trim | Move the cut points, drop or add segments of the source |
| 2 · framing | Fix where the crop looks, per scene |
| 3 · subtitles | Edit words and timings, style (font, size 4–20, colours, karaoke, position), apply one style to all clips |
| 4 · hook | Text, style, font, size, position, duration; apply to all clips |
| 5 · check | Pre-publish checklist (below) |

**Pre-publish checklist** per clip: length (Shorts limit, retention), 9:16 and
1080×1920, frame rate, codecs, sound present, loudness (≈ −14 LUFS), clipping,
silence at the start or end and long pauses, black opening frame, hook and
captions present, captions and hook clear of YouTube's own buttons and text,
title/description/hashtag limits and characters YouTube rejects, duplicate
titles, upload state.

**Managing a batch**: filters (to edit / done / scheduled / published /
rejected / needs fixes), sort by score or video order, bulk select (mark done,
reject, schedule), inline title and description editing with "rewrite with
AI", a full-screen workspace per clip with keyboard shortcuts, a safe-zone
overlay and a before/after toggle.

**Publishing**: uploads straight to your channel through the YouTube Data API
and schedules them (one a day, two a day, every other day, weekly, at your
time and time zone). Clips already uploaded are never uploaded twice.

**Around it**: projects list, live progress per stage (download, transcribe,
pick, render) and per render, a queue of everything running across projects
with desktop notifications, AI spend per month, CPU/GPU load, and a cleaner
for old render files.

---

## Install

### Requirements

- **Windows 10/11**, Linux or macOS. Windows is the tested platform; the Linux
  and macOS builds compile in CI but have not been tried on real machines.
- **Python 3.10, 3.11 or 3.12** installed system-wide (the app builds its own
  environment from it on first start).
- **ffmpeg** on the `PATH` (`ffmpeg -version` must work in a terminal).
- An **NVIDIA GPU** is optional: it speeds up rendering (NVENC) and local
  transcription. Without one everything runs on the CPU, slower.
- About **8 GB** of disk for the Python environment (PyTorch, Whisper, YOLO),
  plus room for projects (a 10-clip project is about 2 GB after cleanup).
- At least one AI API key (see [AI models](#ai-models)). A free Groq key alone
  is enough to start.

### Desktop app

Download the installer for your system from the
[releases page](https://github.com/YoYoZ/openshorts/releases) (`.exe` for
Windows, `.AppImage` for Linux, `.dmg` for macOS) and install it.

The first start takes several minutes: the app creates a Python environment in
its data folder and installs the dependencies, showing progress on the splash
screen. Later starts take seconds.

### From source

```bash
git clone https://github.com/YoYoZ/openshorts.git
cd openshorts
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt     # Linux/macOS: .venv/bin/pip
cd dashboard && npm install && npm run build && cd ..
cd desktop && npm install && npm start
```

`npm start` in `desktop/` runs the same app as the installer, using the
repository's `.venv` and source files directly.

---

## First run: settings

Open **Settings** in the sidebar. Every section saves on its own.

### API keys

Paste the keys for the providers you want: Anthropic (Claude), Google
(Gemini), Groq, OpenAI, OpenRouter, or a custom OpenAI-compatible server
(Ollama, LM Studio, vLLM…). "Test" checks each key. Keys are stored only in
the local settings file and never shown again in full.

### AI models

Two ordered lists. Each call tries the models from top to bottom: one whose
budget for the period (day / month / total) is spent is skipped, and one that
fails (error, rate limit, invalid answer) hands over to the next.

- **Hard tasks** — picking moments, titles, descriptions, hook text, AI
  rewrites, hooks read from the picture, clipping silent videos. This is what
  viewers read, so put your best model here.
- **Simple tasks** — yes/no checks on frames (which layout, burned-in subtitles
  in the source, screen recordings) and auto-edit planning. A free vision
  model is enough. When every model here fails, the hard list takes over.

Each model has a budget, prices (filled in for known models), an **images**
option (try / yes / text only; text-only models are skipped for frame checks)
and an on/off switch.

**Spot checks** (below the lists) re-ask a simple-task answer of the hard list
when the simple model is unsure (confidence below a threshold), every N-th
call, or both. The hard model's answer is used, and how often the two agreed
is shown per task, so you can see whether the cheap model can be trusted.

A setup that works well and costs little:

| List | Models |
|---|---|
| Hard | Claude Sonnet (Anthropic) |
| Simple | Groq `qwen/qwen3.8-27b` (free, reads images), then Groq `openai/gpt-oss-120b` (free, text only) |

Groq's free tier allows a few image checks per minute; the app packs frames
into grid images to fit its limits and waits for its rate limit instead of
falling over to a paid model when the wait is short.

### Other sections

- **Transcription** — Groq / local / auto, model, language, and a glossary of
  names and terms the transcriber should spell right.
- **Clips** — shortest and longest clip, how many per video, optional punch-in
  zooms, cutting to whoever is talking (interviews).
- **Subtitles / Hook** — the look new clips get automatically.
- **YouTube** — privacy, category, tags, description template (`{description}`,
  `{title}`, `{source_url}`), default posting time, time zone and cadence.
- **Downloads** — YouTube cookies, for when YouTube blocks downloads.
- **Storage** — disk use per project and old-render cleanup (see
  [Where things live](#where-things-live)).
- **Folders** (desktop app) — where projects and uploads are stored.

---

## Connecting YouTube

YouTube only accepts uploads from an OAuth client registered in a Google Cloud
project. There is no shortcut around it; this is a one-time setup of about
fifteen minutes.

### 1. Create the Google Cloud project

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type **External**, app name anything, your e-mail as support and
     developer contact.
   - **Audience / Test users**: add the Google account that owns the channel.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Desktop app**, any name.
   - **Download JSON** (the `client_secret_….json` file).

### 2. Authorize the channel

From the repository folder (or any folder with the Python environment):

```bash
.venv/Scripts/python youtube_auth.py path/to/client_secret.json
```

The browser opens Google's sign-in. Choose the channel's account and allow
access (Google warns that the app is unverified: **Advanced → Go to …**, since
it is your own app). The script writes `youtube_auth/token.json`.

For the **installed desktop app**, write the token into the app's data folder
instead:

```bash
python youtube_auth.py client_secret.json --out "%APPDATA%\AutoShortsCut\youtube_auth"
```

(Linux: `~/.config/AutoShortsCut/youtube_auth`, macOS:
`~/Library/Application Support/AutoShortsCut/youtube_auth`.)

Restart the app. **Schedule week** shows the connected channel.

### Good to know

- **Tokens of a project in "Testing" expire after 7 days.** To keep the
  connection, publish the consent screen (**Audience → Publish app**). For a
  personal app that only you use, Google does not require verification; you
  just keep seeing the "unverified" warning when you authorize.
- **Daily quota**: the YouTube API has a daily quota per Google Cloud project.
  When it runs out mid-batch the app stops cleanly, marks the remaining clips,
  and the same button continues the next day (the quota resets at midnight
  Pacific time).
- Scheduled videos are uploaded as **private with a publish time**; YouTube
  makes them public at that time.

---

## Working with clips

1. **New project** → paste a YouTube link or drop a file → pick the layout
   ("Auto" lets the AI choose per video), clip counts and hook style →
   process. Progress shows per stage; you can leave and come back from the
   projects list.
2. Clips appear as they finish rendering, best score first.
3. Go through them: open a clip in the **workspace** (hover the video → the
   expand icon), fix what needs fixing in steps 1–4, check step 5, mark it
   **done** (or reject it).
4. Select the clips to post → **schedule selected** (or **schedule week** for
   all).

### Keyboard shortcuts (workspace)

| Key | Action |
|---|---|
| Space / K | Play / pause |
| J / L | Back / forward 2 s |
| ← / → | Previous / next clip |
| 1 2 3 4 5 | Trim, framing, subtitles, hook, checklist |
| O | Mark done |
| S | Safe-zone overlay (what YouTube's buttons and text cover) |
| H | Before / after the last render |
| Esc | Close the workspace |

---

## Costs

You pay only your AI providers, at their prices; the app shows the spend per
model and the month's total in the sidebar.

Rough figures with the setup above, for one source video of about 30 minutes:

| Step | Model | Cost |
|---|---|---|
| Transcription | Groq Whisper | free tier |
| Picking moments, titles, hooks | Claude Sonnet | ≈ $0.10–0.15 |
| Layout + burned-in subtitle check | Groq Qwen | free |
| Spot check (every 3rd call) | Claude Sonnet | ≈ $0.02 when it runs |
| Rewrite a title with AI | Claude Sonnet | < $0.01 |

Budgets per model stop the spend where you want it: a model whose budget is
used up is skipped until its period resets.

---

## Where things live

| What | Desktop app | From source |
|---|---|---|
| Projects (source, clips, metadata) | Settings → Folders (default: app data `projects`) | `output/` |
| Uploads | Settings → Folders | `uploads/` |
| Settings and keys | app data `local_settings.json` | `local_settings.json` |
| AI spend and spot-check logs | app data `llm_spend.json`, `llm_verify.json` | repo root |
| YouTube token | app data `youtube_auth/token.json` | `youtube_auth/token.json` |
| Logs | app data `logs/backend.log` (Settings → Folders → logs) | terminal |

App data is `%APPDATA%\AutoShortsCut` on Windows. Keys, tokens, settings, logs
and projects are all ignored by git.

**Disk cleanup** (Settings → Storage): every subtitle, hook or trim pass writes
a new copy of the clip. The cleaner removes the superseded copies and temp
files, and keeps each clip's current version, the layers it is rebuilt from,
the source video and metadata, and anything changed in the last 24 hours
(adjustable, so before/after keeps working). It never touches a project that
is rendering. Deleting whole projects by age or total size is available but
**off** by default, and never removes a project with a clip scheduled for
later.

---

## Troubleshooting

- **"Sign in to confirm you're not a bot"** when downloading: export YouTube
  cookies (cookies.txt format, from a browser signed in to YouTube) into
  Settings → Downloads.
- **A job seems stuck**: the queue panel in the sidebar shows what is running;
  the job's log (raw toggle) shows the last step. Closing the app stops all
  jobs.
- **No layout other than single crop**: the layout picker needs a model with
  image support in the simple (or hard) list.
- **Captions under YouTube's buttons on older clips**: clips rendered before the
  safe-zone change keep the old position; re-apply subtitles (the checklist
  flags them).
- **Downloaded clip freezes on one frame in some players**: fixed for new
  renders (NVENC without B-frames); re-render older clips.
- **Backend errors**: Settings → Folders → logs → `backend.log`.

---

## Development

```
app.py                FastAPI backend: jobs, editing endpoints, settings, YouTube, storage
main.py               the per-video pipeline (runs as a subprocess per job)
llm_backend.py        model lists, budgets, fallbacks, image calls, spot checks
settings_store.py     settings, keys, spend and spot-check ledgers
transcribe_backends.py, subtitles.py, hooks.py, recut.py, render_ops.py
shorts_checklist.py   pre-publish checks;  render_gc.py  old-render cleanup
youtube_upload.py     uploads and scheduling;  youtube_auth.py  channel authorization
dashboard/            React + Vite UI (Remotion for previews)
desktop/              Electron shell: starts the backend, serves the UI
```

- Dashboard: `cd dashboard && npm run dev` (set `VITE_PROXY_TARGET` to a
  running backend), `npm run build`, `npm run lint`.
- Backend alone: `uvicorn app:app --port 8000` from the repository root.
- **Releases**: a push to the `autoshortscut` branch that changes code (or a
  `desktop-v*` tag) builds Windows, Linux and macOS installers in GitHub
  Actions (`.github/workflows/desktop.yml`) and creates a **draft** release;
  publish it on GitHub when it is good.

---

## What changed from OpenShorts

| | OpenShorts | AutoShortsCut |
|---|---|---|
| Runs as | Docker / hosted web service | Desktop app (Windows, Linux, macOS installers) |
| AI | Gemini | Any provider; hard and simple lists, budgets, fallbacks, spend tracking, spot checks; all frame checks model-agnostic |
| Transcription | Local Whisper | Groq Whisper with local fallback, language and glossary |
| Editing | Each edit stacks on the last | Order-independent: clean layers rebuilt on every edit |
| Captions | Sized per clip, bottom of frame | One fitted size per clip, clear of YouTube's UI, Cyrillic-safe fonts, word order kept as spoken |
| Workflow | Generate, download | Workspace, shortcuts, filters, bulk actions, inline editing, checklist, safe-zone overlay, before/after |
| Publishing | Upload-Post service | Your own YouTube channel, scheduling with cadences |
| Progress | Log lines | Per-stage and per-render progress bars, queue across projects, notifications |
| Disk | Projects deleted after a retention period | Old renders cleaned; projects kept unless you choose otherwise |

The hosted-edition code (accounts, billing, Upload-Post, Thumbnail Studio and
other tabs) is still in the repository but switched off and unreachable.

Credit for the original pipeline — moment picking, reframing, layouts,
captions and hooks — goes to the OpenShorts authors.

## License

MIT, as the original project. See [LICENSE](LICENSE).
