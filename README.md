# AutoShortsCut

**Turn a long video into a week of YouTube Shorts, on your own machine.**

Drop in a YouTube link or a video file. AutoShortsCut transcribes it, has an AI
pick the moments worth a Short, cuts and reframes them to 9:16, burns karaoke
captions and a hook, checks every clip against a pre-publish list, and
schedules them on your channel.

It started as a replacement for vidIQ's Shorts feature, which could not do the
things we needed: karaoke (word-by-word) captions, captions that read well in
Ukrainian and other non-English languages, editing a clip after the fact, and
posting straight to our own channel. It is built on
[OpenShorts](https://github.com/mutonby/openshorts) (MIT) and reshaped from a
hosted clipping service into a single-user desktop tool.

- **Local.** Videos, projects, keys and settings stay on your computer. Only the
  AI calls (with your own keys) and the uploads to your channel leave it.
- **Any AI model, with a budget.** Claude, Gemini, Groq, OpenAI, OpenRouter or a
  local server; a strong model for what viewers read, a free one for routine
  checks, and a spending cap per model.
- **Editable in any order.** Trim, reframe, restyle captions or change the hook
  whenever you like; the other layers are rebuilt on top, nothing is lost.
- **Made for Shorts.** Captions and hooks stay clear of YouTube's buttons and
  text, and a checklist catches what would cost reach before you post.

---

## Contents

- [How a project goes](#how-a-project-goes)
- [Install](#install)
- [Set up: AI models and keys](#set-up-ai-models-and-keys)
- [Connect your YouTube channel](#connect-your-youtube-channel)
- [Working with clips](#working-with-clips)
- [What it costs](#what-it-costs)
- [Files, folders and disk space](#files-folders-and-disk-space)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [How it differs from OpenShorts](#how-it-differs-from-openshorts)

---

## How a project goes

1. **New project**: paste a YouTube link or drop a file, choose the layout
   ("Auto" lets the AI decide per video), how many clips, and the hook style.
2. **Processing**, with a progress bar per stage:
   - **download** (yt-dlp; cookies in Settings when YouTube asks for sign-in);
   - **transcribe** with word timings: Groq Whisper (fast, free tier) or
     faster-whisper on your own GPU/CPU, *auto* tries Groq first;
   - **pick moments**: the AI scores the whole transcript and picks the best
     15–60 s clips, each with a title, description and on-screen hook;
   - **layout**: single crop following the speaker, two speakers stacked, or a
     screen recording over the presenter;
   - **render**: several clips at once, on the GPU (NVENC) when there is one,
     with captions and the hook burned in.
3. **Review**: clips come in as a list, best score first. Click one to watch it;
   open it in the **workspace** to fix anything:

   | Step | What you can change |
   |---|---|
   | 1 · Trim | Cut points; drop or add pieces of the source |
   | 2 · Framing | Where the crop looks, per scene |
   | 3 · Subtitles | Words and their timing, font, size, colours, karaoke highlight, position; one style for all clips |
   | 4 · Hook | Text, style, font, size, position, how long it shows; one look for all clips |
   | 5 · Check | The pre-publish checklist |

4. **Mark done** (or reject), then **schedule**: one clip, a selection, or the
   whole batch (one a day, two a day, every other day, weekly) at your time and
   time zone. Clips go to YouTube as private videos with a publish time.

**The checklist** looks at every clip: length (Shorts limit, retention past
60 s), 9:16 at 1080×1920, frame rate and codecs, sound present, loudness
(≈ −14 LUFS) and clipping, silence at the start or end and long pauses, a black
first frame, hook and captions present, captions and hook clear of YouTube's
own UI, title / description / hashtag limits and the characters YouTube
rejects, duplicate titles, and whether it is already on YouTube. Clips with
problems get a badge and their own "needs fixes" filter.

**Around it**: the sidebar shows your projects (with live progress), everything
rendering across projects with desktop notifications, the month's AI spend, the
models in use and the GPU load.

---

## Install

### Desktop app (recommended)

Download the installer for your system from the
[releases page](https://github.com/YoYoZ/openshorts/releases):

| System | File | Notes |
|---|---|---|
| Windows 10/11 | `AutoShortsCut.Setup.x.y.z.exe` | the tested platform |
| Linux (x64) | `AutoShortsCut-x.y.z.AppImage` | built and smoke-tested in CI |
| macOS (Apple Silicon) | `AutoShortsCut-x.y.z-arm64.dmg` | built and smoke-tested in CI; unsigned, so allow it in System Settings → Privacy & Security |

**Nothing else needs to be installed.** Python and ffmpeg ship inside the
installer. The first start needs internet once: it downloads the processing
engine (PyTorch, Whisper and the rest, about 3 GB) into the app's data folder,
showing progress on the splash screen. With an NVIDIA GPU on Windows it fetches
the CUDA build. Later starts take seconds.

You will want:

- about **8 GB** free for that engine, plus room for projects (a 10-clip
  project is about 2 GB after old renders are cleaned up);
- an **NVIDIA GPU** if you can: rendering and local transcription are much
  faster with one, though everything also runs on the CPU;
- at least one **AI key** (see below). A free Groq key alone is enough to start.

### From source

Needs Python 3.10–3.12, Node 20+ and git.

```bash
git clone https://github.com/YoYoZ/openshorts.git
cd openshorts
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # Linux/macOS: .venv/bin/pip
cd dashboard && npm install && npm run build && cd ..
cd desktop && npm install && node fetch-vendor.mjs && npm start
```

`node fetch-vendor.mjs` downloads the same portable Python and ffmpeg the
installer carries (optional when ffmpeg is already on your `PATH`).
`npm start` runs the app straight from the repository.

---

## Set up: AI models and keys

Open **Settings** (bottom of the sidebar). Each section saves on its own.

### API keys

Paste keys for the providers you use: Anthropic (Claude), Google (Gemini),
Groq, OpenAI, OpenRouter, or any OpenAI-compatible server (Ollama, LM Studio,
vLLM…). **Test** checks each one. Keys live only in the local settings file and
are never shown again in full.

### Hard tasks and simple tasks

**Settings → AI models** has two ordered lists. A call tries the models from
the top: one whose budget for its period (day / month / total) is spent is
skipped, and one that fails (error, rate limit, answer in the wrong shape)
hands over to the next.

- **Hard tasks** — picking moments, titles, descriptions, hook text, "rewrite
  with AI", hooks read from the picture, clipping videos without speech.
  This is what viewers read: put your best model here.
- **Simple tasks** — yes/no checks on video frames (which layout, subtitles
  already burned into the source, screen recordings) and auto-edit planning.
  A free model is enough; if every model here fails, the hard list takes over.

Each model has a budget, prices (filled in for known models), an **images**
option (try / yes / text only) and an on/off switch.

**Spot checks** keep the free model honest: when it is unsure (confidence below
a threshold), every N-th call, or both, the same question goes to the hard list
too. That answer is used, and how often the two agreed is shown per task.

What we run:

| List | Models | Cost |
|---|---|---|
| Hard | Claude Sonnet | about 10–15¢ per video |
| Simple | Groq `qwen/qwen3.8-27b` (reads images), then Groq `openai/gpt-oss-120b` (text) | free |

Groq's free tier takes only a few images per request and per minute; the app
packs the frames into grid images and waits out short rate limits instead of
handing the call to a paid model.

### The other sections

- **Transcription** — Groq / local / auto, model, language, and a glossary of
  names and terms the transcriber should spell right.
- **Clips** — shortest and longest clip, how many per video; optional punch-in
  zooms and cutting to whoever is talking (interviews, podcasts).
- **Subtitles, Hook** — the look new clips get automatically.
- **YouTube** — privacy, category, tags, description template (`{description}`,
  `{title}`, `{source_url}`), default posting time, time zone and cadence.
- **Downloads** — YouTube cookies (cookies.txt), for when YouTube blocks
  downloads.
- **Storage** — disk use per project and the old-render cleaner.
- **Folders** — where projects and uploads are kept.

---

## Connect your YouTube channel

This is the one fiddly part, and YouTube leaves no way around it: uploads must
come from an OAuth client registered in a Google Cloud project. It is a
one-time setup of about fifteen minutes.

### 1. Make the Google Cloud client

1. Open <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library** → **YouTube Data API v3** → **Enable**.
3. **OAuth consent screen** (Google Auth Platform): type **External**, any app
   name, your e-mail as contact; under **Audience → Test users** add the Google
   account that owns the channel.
4. **Credentials → Create credentials → OAuth client ID** → type
   **Desktop app** → **Download JSON** (`client_secret_….json`).

### 2. Authorize the channel

With the **installed app** on Windows, use the app's own Python and the script
inside the install folder (start the app once first, so its engine exists):

```bash
"%APPDATA%\AutoShortsCut\python-env\Scripts\python.exe" "%LOCALAPPDATA%\Programs\AutoShortsCut\resources\app-src\youtube_auth.py" path\to\client_secret.json --out "%APPDATA%\AutoShortsCut\youtube_auth"
```

(If you chose another install folder, use that instead of
`%LOCALAPPDATA%\Programs\AutoShortsCut`. On Linux and macOS the token goes to
`~/.config/AutoShortsCut/youtube_auth` and
`~/Library/Application Support/AutoShortsCut/youtube_auth`.)

**From source** it is simply:

```bash
.venv/Scripts/python youtube_auth.py path/to/client_secret.json
```

which writes `./youtube_auth/token.json`.

The browser opens Google's sign-in. Pick the channel's account and allow
access; Google warns that the app is unverified (**Advanced → Go to …**), which
is expected for your own client. Restart AutoShortsCut: the schedule dialog
now shows your channel.

### Good to know

- **Tokens expire after 7 days while the consent screen is in "Testing".**
  Publish it (**Audience → Publish app**) to keep the connection; a personal app
  needs no verification, you just keep seeing the "unverified" warning when
  authorizing.
- **Daily quota**: when the project's YouTube quota runs out mid-batch, the app
  stops cleanly, marks the rest, and the same button continues the next day
  (the quota resets at midnight Pacific time).
- A clip already on YouTube is never uploaded twice.

---

## Working with clips

**The project view** is a list of clips: number, length, title, status (to
edit / done / scheduled with its time / rejected), checklist result and score.
Click a row to watch that clip and see why it was picked, its title and
description (click to edit, or "rewrite with AI"), and its actions. Only that
one clip has a player, so even large projects stay quick.

Filter by status or "needs fixes", sort by score or by order in the video,
select clips for bulk actions (mark done, reject, schedule selected).

**The workspace** (Open in workspace) shows one clip large, with the steps rail
on the left, a **safe-zone overlay** that marks what YouTube's buttons and text
cover, and **before / after** for the last change.

| Key | Action |
|---|---|
| Space / K | Play / pause |
| J / L | Back / forward 2 s |
| ← / → | Previous / next clip |
| 1 2 3 4 5 | Trim, framing, subtitles, hook, checklist |
| O | Mark done |
| S | Safe-zone overlay |
| H | Before / after |
| Esc | Close |

---

## What it costs

Only your AI providers, at their prices. The sidebar shows this month's spend;
Settings shows it per model.

For one source video of about 30 minutes, with the models above:

| Step | Model | Cost |
|---|---|---|
| Transcription | Groq Whisper | free tier |
| Picking moments, titles, hooks | Claude Sonnet | about $0.10–0.15 |
| Layout and burned-in subtitle check | Groq Qwen | free |
| Spot check (every 3rd call) | Claude Sonnet | about $0.02 when it runs |
| Rewrite a title with AI | Claude Sonnet | under $0.01 |

A model whose budget is used up is skipped until its period resets.

---

## Files, folders and disk space

| What | Installed app | From source |
|---|---|---|
| Projects (source, clips, metadata) | Settings → Folders (default: app data `projects`) | `output/` |
| Uploads | Settings → Folders | `uploads/` |
| Settings and keys | app data `local_settings.json` | `local_settings.json` |
| AI spend, spot-check results | app data `llm_spend.json`, `llm_verify.json` | repository root |
| YouTube token | app data `youtube_auth/token.json` | `youtube_auth/token.json` |
| Processing engine | app data `python-env/` | `.venv/` |
| Logs | app data `logs/backend.log` (Settings → Folders → logs) | terminal |

App data is `%APPDATA%\AutoShortsCut` on Windows,
`~/.config/AutoShortsCut` on Linux and
`~/Library/Application Support/AutoShortsCut` on macOS. Keys, tokens,
settings, logs and projects are all kept out of git.

**Old renders.** Every subtitle, hook or trim pass writes a new copy of the
clip. The cleaner (Settings → Storage, on by default) removes the superseded
copies and temp files and keeps each clip's current version, the layers it is
rebuilt from, the source and the metadata, plus anything changed in the last
24 hours so before / after keeps working. It never touches a project that is
rendering.

**Projects are never deleted on their own.** Deleting them by age or total size
is available in Settings → Storage, off by default, and even then never
removes a project with a clip scheduled for later.

---

## Troubleshooting

- **"Sign in to confirm you're not a bot"** when downloading: export YouTube
  cookies (cookies.txt, from a browser signed in to YouTube) into
  Settings → Downloads.
- **Layout is always the single crop**: "Auto" needs a model that reads images
  in the simple (or hard) list.
- **Older clips have captions under YouTube's buttons**: they were rendered
  before the safe-zone change; re-apply subtitles (the checklist flags them).
- **A job looks stuck**: the sidebar shows what is running; the project's
  **logs** show the last step. Closing the app stops all jobs.
- **The first start fails**: it needs internet to download the processing
  engine; start the app again once online. Details are in `backend.log`.
- **Anything else**: Settings → Folders → logs → `backend.log`.

---

## Development

```
app.py                  FastAPI backend: jobs, editing, settings, YouTube, storage
main.py                 the per-video pipeline (one subprocess per job)
llm_backend.py          model lists, budgets, fallbacks, image calls, spot checks
settings_store.py       settings, keys, spend and spot-check ledgers
transcribe_backends.py  Groq / local Whisper
subtitles.py, hooks.py  captions (ASS, karaoke) and hook overlays
recut.py, render_ops.py trims, re-renders and their progress
layout_picker.py        per-video layout choice (and the burned-subtitle check)
shorts_checklist.py     pre-publish checks
render_gc.py            old-render cleanup
youtube_upload.py       uploads and scheduling; youtube_auth.py authorizes a channel
dashboard/              React + Vite UI (Remotion for caption and hook previews)
desktop/                Electron shell: bundles Python and ffmpeg, starts the backend
```

- Dashboard: `cd dashboard && npm run dev` with `VITE_PROXY_TARGET` pointing
  at a running backend; `npm run build`, `npm run lint`.
- Backend alone: `uvicorn app:app --port 8000` from the repository root.
- **Releases**: a push to the `autoshortscut` branch that changes code (or a
  `desktop-v*` tag) builds the Windows, Linux and macOS installers in GitHub
  Actions (`.github/workflows/desktop.yml`). Each build first checks that the
  bundled Python can install the requirements and start the backend, then
  creates a **draft** release to publish by hand.

---

## How it differs from OpenShorts

| | OpenShorts | AutoShortsCut |
|---|---|---|
| Runs as | Docker / hosted web service | Self-contained desktop app for Windows, Linux and macOS |
| AI | Gemini | Any provider; hard and simple lists, budgets, fallbacks, spend tracking, spot checks; frame checks work with any vision model |
| Transcription | Local Whisper | Groq Whisper with local fallback, language and glossary |
| Editing | Each edit stacks on the last | Any order: clean layers rebuilt on every edit |
| Captions | Per-clip size, bottom of the frame | One fitted size per clip, clear of YouTube's UI, Cyrillic-safe fonts, words kept in spoken order |
| Review | Grid of players, download | Clip list with one preview, workspace with shortcuts, filters, bulk actions, inline editing, checklist, safe zone, before / after |
| Publishing | Upload-Post service | Your own YouTube channel, scheduled |
| Progress | Log lines | Progress per stage and per render, queue across projects, notifications |
| Disk | Projects deleted after a retention period | Old renders cleaned up; projects kept |

The hosted-edition code (accounts, billing, Upload-Post, Thumbnail Studio and
other tabs) is still in the repository, switched off and unreachable.

Credit for the original pipeline (moment picking, reframing, layouts, captions
and hooks) goes to the OpenShorts authors.

## License

MIT, like the original project. See [LICENSE](LICENSE).
