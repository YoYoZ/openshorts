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

// A system Python 3.10-3.12 to build the environment from.
function findBasePython() {
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

function run(cmd, args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    const feed = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => onLine && onLine(l));
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

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
    throw new Error('Python 3.10-3.12 was not found. Install Python 3.12 from python.org '
      + '(on Windows tick "Add to PATH" or use the py launcher) and start the app again.');
  }
  onStatus('creating the Python environment…');
  if (!fs.existsSync(pythonPath())) await run(base[0], [...base[1], '-m', 'venv', ENV_DIR]);
  const py = pythonPath();
  await run(py, ['-m', 'pip', 'install', '--upgrade', 'pip'], (l) => onStatus(`pip: ${l}`));
  if (IS_WIN && hasNvidia()) {
    onStatus('installing PyTorch with CUDA (about 3 GB, one time)…');
    await run(py, ['-m', 'pip', 'install', 'torch==2.11.0', 'torchvision==0.26.0',
      '--index-url', 'https://download.pytorch.org/whl/cu128'], (l) => onStatus(`torch: ${l}`));
  }
  onStatus('installing the processing engine (one time)…');
  const extra = IS_WIN && hasNvidia() ? ['nvidia-cublas-cu12<13', 'nvidia-cudnn-cu12>=9,<10'] : [];
  await run(py, ['-m', 'pip', 'install', '-r', path.join(SRC, 'requirements.txt'), ...extra],
    (l) => onStatus(`pip: ${l.slice(0, 120)}`));
  fs.writeFileSync(marker, wanted);
}

module.exports = {
  PACKAGED, SRC, DATA, ENV_FILE, WORK_DIR,
  pythonPath, loadEnvFile, ensurePython,
};
