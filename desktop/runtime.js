// Where the backend lives and which Python runs it, in both modes:
//
//   dev (npm start in desktop/): the repo itself, its .venv and its .env.
//   packaged (electron-builder): the backend source ships in
//     resources/app-src; the first launch creates a Python environment in the
//     app's data folder from a system Python 3.10-3.12 and installs
//     requirements.txt into it; keys live in <data>/.env.

const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PACKAGED = app.isPackaged;
const IS_WIN = process.platform === 'win32';
const SRC = PACKAGED ? path.join(process.resourcesPath, 'app-src') : path.resolve(__dirname, '..');
const DATA = app.getPath('userData');
const ENV_DIR = PACKAGED ? path.join(DATA, 'python-env') : path.join(SRC, '.venv');
const ENV_FILE = PACKAGED ? path.join(DATA, '.env') : path.join(SRC, '.env');
// Writable working directory for the backend (model caches, lock files).
const WORK_DIR = PACKAGED ? path.join(DATA, 'work') : SRC;

const ENV_TEMPLATE = `# AutoShortsCut settings. Restart the app after editing.

# Clip selection: Claude through Anthropic's OpenAI-compatible endpoint.
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_MODEL=claude-sonnet-5-5
LLM_API_KEY=
LLM_SCORE_BATCH=8

# Transcription: auto = Groq first, local whisper on failure | groq | whisper
TRANSCRIBE_BACKEND=auto
GROQ_API_KEY=
WHISPER_MODEL=large-v3
WHISPER_DEVICE=cuda
WHISPER_COMPUTE=float16

FFMPEG_ENCODER=auto
RATE_LIMIT_ENABLED=0
MAX_CONCURRENT_JOBS=1
AUTO_RETRY_LIMIT=0
JOB_RETENTION_SECONDS=2592000
`;

function venvPython(dir) {
  return IS_WIN ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}

function pythonPath() {
  return venvPython(ENV_DIR);
}

// KEY=VALUE lines of the settings file (packaged mode passes them to the
// backend; in dev the backend reads the repo's .env itself).
function loadEnvFile() {
  if (!PACKAGED) return {};
  if (!fs.existsSync(ENV_FILE)) {
    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    fs.writeFileSync(ENV_FILE, ENV_TEMPLATE);
  }
  const out = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function requirementsHash() {
  const file = path.join(SRC, 'requirements.txt');
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

// Portable Python and ffmpeg shipped inside the installer (fetch-vendor.mjs);
// in dev, desktop/vendor when it has been fetched.
const VENDOR = PACKAGED ? path.join(process.resourcesPath, 'vendor') : path.join(__dirname, 'vendor');

function bundledPython() {
  const p = IS_WIN ? path.join(VENDOR, 'python', 'python.exe') : path.join(VENDOR, 'python', 'bin', 'python3');
  return fs.existsSync(p) ? p : null;
}

// Folder with the bundled ffmpeg/ffprobe, or null (then the system ones are used).
function ffmpegDir() {
  const dir = path.join(VENDOR, 'ffmpeg');
  return fs.existsSync(path.join(dir, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')) ? dir : null;
}

// The Python to build the environment from: the bundled one, else a system
// Python 3.10-3.12.
function findBasePython() {
  const bundled = bundledPython();
  if (bundled) return [bundled, []];
  const candidates = IS_WIN
    ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.10']], ['python', []]]
    : [['python3.12', []], ['python3.11', []], ['python3.10', []], ['python3', []]];
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, [...args, '-c', 'import sys;print("%d.%d" % sys.version_info[:2])'],
      { encoding: 'utf8', windowsHide: true });
    const v = (r.stdout || '').trim();
    if (r.status === 0 && ['3.10', '3.11', '3.12'].includes(v)) return [cmd, args];
  }
  return null;
}

// First-launch setup writes everything it runs to this file: the splash only
// has room for one line, and a failed or slow install needs the whole story.
const SETUP_LOG = path.join(DATA, 'logs', 'setup.log');
function setupLog(line) {
  try {
    fs.mkdirSync(path.dirname(SETUP_LOG), { recursive: true });
    fs.appendFileSync(SETUP_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch { /* logging must never stop the install */ }
}

function run(cmd, args, onLine) {
  setupLog(`$ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const feed = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => {
      if (!/^Progress \d+ of \d+/.test(l)) setupLog(l);   // per-chunk progress would flood the log
      if (onLine) onLine(l);
    });
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => { setupLog(`failed to start: ${e.message}`); reject(e); });
    p.on('exit', (code) => {
      setupLog(`exit ${code}`);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code}. Full log: ${SETUP_LOG}`));
    });
  });
}

// pip prints no progress without a terminal, so a 700 MB wheel looked like a
// hang. "--progress-bar raw" (pip 24.1+, pip is upgraded first) prints
// "Progress <done> of <total>" lines instead; turn them into MB and percent.
function pipReporter(onStatus, label) {
  const started = Date.now();
  let current = '';
  let last = 0;
  return (l) => {
    const m = /^Progress (\d+) of (\d+)/.exec(l);
    if (m) {
      const now = Date.now();
      if (now - last < 400) return;
      last = now;
      const done = Number(m[1]) / 1e6, total = Number(m[2]) / 1e6;
      const secs = Math.round((now - started) / 1000);
      onStatus(`${label}: ${current}\n${done.toFixed(0)} of ${total.toFixed(0)} MB (${Math.round((done / total) * 100)}%) · ${secs}s`);
      return;
    }
    const d = /^\s*Downloading (\S+)/.exec(l);
    if (d) current = d[1].split('/').pop();
    onStatus(`${label}: ${l.slice(0, 120)}`);
  };
}
const PIP_NET = ['--progress-bar', 'raw', '--retries', '10', '--timeout', '60'];

function hasNvidia() {
  return spawnSync('nvidia-smi', ['-L'], { windowsHide: true }).status === 0;
}

// Packaged mode: make sure the Python environment exists and matches
// requirements.txt. onStatus(text) reports progress for the splash screen.
async function ensurePython(onStatus) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  if (!PACKAGED) return;
  const marker = path.join(ENV_DIR, '.requirements-hash');
  const wanted = requirementsHash();
  if (fs.existsSync(pythonPath()) && fs.existsSync(marker)
      && fs.readFileSync(marker, 'utf8').trim() === wanted) return;

  const base = findBasePython();
  if (!base) {
    throw new Error('No Python found: this build is missing its bundled Python, and no '
      + 'Python 3.10-3.12 is installed. Reinstall AutoShortsCut, or install Python 3.12.');
  }
  setupLog(`setup started: ${process.platform}, base python ${base.join(' ')}`);
  const status = (text) => onStatus(`${text}\n\nlog: ${SETUP_LOG}`);
  status('creating the Python environment…');
  if (!fs.existsSync(pythonPath())) await run(base[0], [...base[1], '-m', 'venv', ENV_DIR]);
  const py = pythonPath();
  await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '--retries', '10', '--timeout', '60'],
    (l) => status(`pip: ${l.slice(0, 120)}`));
  if (IS_WIN && hasNvidia()) {
    status('installing PyTorch with CUDA (about 3 GB, one time)…');
    await run(py, ['-m', 'pip', 'install', 'torch==2.11.0', 'torchvision==0.26.0', ...PIP_NET,
      '--index-url', 'https://download.pytorch.org/whl/cu128'], pipReporter(status, 'PyTorch'));
  }
  status('installing the processing engine (one time)…');
  const extra = IS_WIN && hasNvidia() ? ['nvidia-cublas-cu12<13', 'nvidia-cudnn-cu12>=9,<10'] : [];
  await run(py, ['-m', 'pip', 'install', '-r', path.join(SRC, 'requirements.txt'), ...extra, ...PIP_NET],
    pipReporter(status, 'engine'));
  fs.writeFileSync(marker, wanted);
  setupLog('setup finished');
}

module.exports = {
  PACKAGED, SRC, DATA, ENV_FILE, WORK_DIR, SETUP_LOG,
  pythonPath, loadEnvFile, ensurePython, ffmpegDir,
};
