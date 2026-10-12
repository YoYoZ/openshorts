// AutoShortsCut desktop shell: one window, no console windows.
//
// Starts the OpenShorts backend (uvicorn) hidden, serves the built dashboard
// from a local HTTP server that proxies API paths to it, and kills the whole
// backend process tree (jobs, ffmpeg) when the window closes. Folder settings
// live in userData/config.json and reach the backend as environment variables.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

const runtime = require('./runtime');

const DIST = path.join(runtime.SRC, 'dashboard', 'dist');
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const LOG_DIR = path.join(app.getPath('userData'), 'logs');

// Paths the dashboard calls on the backend (everything else is static files).
const API_PREFIXES = ['/api/', '/videos/', '/video/', '/thumbnails', '/gallery', '/health', '/mcp'];

// The dashboard keeps its session, editor drafts and preferences in
// localStorage, which is per origin (port included): a fixed port keeps them
// across restarts. A random one is only the fallback when this one is taken.
const UI_PORT = 47821;

const DEFAULT_CONFIG = runtime.PACKAGED
  ? { outputDir: path.join(runtime.DATA, 'projects'), uploadDir: path.join(runtime.DATA, 'uploads') }
  : { outputDir: path.join(runtime.SRC, 'output'), uploadDir: path.join(runtime.SRC, 'uploads') };

let win = null;
let backend = null;
let backendPort = 0;
let uiPort = 0;
let quitting = false;

// ---- config ----------------------------------------------------------------

function readConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

// ---- backend ---------------------------------------------------------------

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startBackend() {
  const cfg = readConfig();
  fs.mkdirSync(cfg.outputDir, { recursive: true });
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  backendPort = await freePort();
  // Windows calls it "Path": set the existing key, not a second one.
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const withFfmpegOnPath = () => (runtime.ffmpegDir()
    ? { [pathKey]: runtime.ffmpegDir() + path.delimiter + (process.env[pathKey] || '') } : {});
  const log = fs.createWriteStream(path.join(LOG_DIR, 'backend.log'), { flags: 'w' });
  backend = spawn(runtime.pythonPath(), ['-m', 'uvicorn', '--app-dir', runtime.SRC, 'app:app',
    '--host', '127.0.0.1', '--port', String(backendPort)], {
    cwd: runtime.WORK_DIR,
    windowsHide: true,
    env: {
      ...process.env,
      ...runtime.loadEnvFile(),
      // Writable places for an installed app (its own folder may be read-only).
      ...(runtime.PACKAGED ? {
        LOCAL_SETTINGS_PATH: path.join(runtime.DATA, 'local_settings.json'),
        YOUTUBE_AUTH_DIR: path.join(runtime.DATA, 'youtube_auth'),
      } : {}),
      ASR_LOCK_DIR: cfg.outputDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      // UTF-8 for every open() without an encoding (job metadata holds Cyrillic).
      PYTHONUTF8: '1',
      OPENSHORTS_OUTPUT_DIR: cfg.outputDir,
      OPENSHORTS_UPLOAD_DIR: cfg.uploadDir,
      // The bundled ffmpeg/ffprobe come first: every pipeline step calls them by name.
      ...withFfmpegOnPath(),
    },
  });
  backend.stdout.pipe(log);
  backend.stderr.pipe(log);
  const proc = backend;
  backend.on('exit', (code) => {
    if (backend === proc) backend = null;
    if (!quitting && win && code !== null && code !== 0) {
      dialog.showErrorBox('Backend stopped',
        `The processing server exited (code ${code}). See ${path.join(LOG_DIR, 'backend.log')}`);
    }
  });
  await waitForBackend();
}

function waitForBackend(timeoutMs = 90000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port: backendPort, path: '/health/ready', timeout: 2000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (!backend) return reject(new Error('backend exited during startup'));
      if (Date.now() - started > timeoutMs) return reject(new Error('backend did not start in time'));
      setTimeout(probe, 500);
    };
    probe();
  });
}

// Kill uvicorn and everything under it (job processes, ffmpeg).
function stopBackend() {
  return new Promise((resolve) => {
    const proc = backend;
    backend = null;
    if (!proc || proc.exitCode !== null) return resolve();
    execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

// ---- UI server: static dashboard + proxy to the backend ---------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain', '.xml': 'application/xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
};

function proxy(req, res) {
  const upstream = http.request({
    host: '127.0.0.1', port: backendPort, path: req.url, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'backend unavailable' }));
  });
  req.pipe(upstream);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = path.normalize(path.join(DIST, urlPath));
  if (!file.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

function startUiServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (API_PREFIXES.some((p) => req.url.startsWith(p))) return proxy(req, res);
      return serveStatic(req, res);
    });
    const listen = (port) => server.listen(port, '127.0.0.1', () => {
      uiPort = server.address().port;
      resolve();
    });
    server.once('error', () => listen(0));
    listen(UI_PORT);
  });
}

// ---- window ------------------------------------------------------------------

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`
<html><body style="margin:0;background:#0b0c10;color:#9aa0aa;font:14px system-ui;display:flex;
align-items:center;justify-content:center;height:100vh">starting AutoShortsCut…</body></html>`)}`;

function backendJson(urlPath, method = 'GET') {
  return new Promise((resolve) => {
    if (!backend || !backendPort) return resolve(null);
    const req = http.request({ host: '127.0.0.1', port: backendPort, path: urlPath, method, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function appUrl() {
  return `http://127.0.0.1:${uiPort}/#app`;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1000, minHeight: 650,
    backgroundColor: '#0b0c10',
    title: 'AutoShortsCut',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  Menu.setApplicationMenu(null);
  // Editing needs the room: open maximized (the size above is what
  // un-maximizing returns to).
  win.maximize();
  win.on('page-title-updated', (e) => e.preventDefault());

  // Closing kills the backend and every job under it: ask first, and cancel
  // them properly so they do not come back on the next start.
  let allowClose = false;
  win.on('close', async (e) => {
    if (allowClose) return;
    e.preventDefault();
    const projects = (await backendJson('/api/local/projects')) || [];
    const running = projects.filter((p) => p.status === 'processing' || p.status === 'queued');
    if (running.length) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Keep working', 'Stop and quit'],
        defaultId: 0, cancelId: 0,
        message: `${running.length} job${running.length > 1 ? 's are' : ' is'} still processing`,
        detail: `${running.map((p) => `• ${p.title}`).join('\n')}\n\nQuitting stops them.`,
      });
      if (response === 0) return;
      for (const p of running) await backendJson(`/api/jobs/${p.job_id}/cancel`, 'POST');
    }
    allowClose = true;
    win.close();
  });
  win.loadURL(SPLASH);

  // External links open in the real browser, never in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${uiPort}`)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${uiPort}`)) { e.preventDefault(); shell.openExternal(url); }
  });
  // F5 reloads, F12 opens devtools (debugging), as in a browser.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5') win.webContents.reload();
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });

  try {
    await runtime.ensurePython((text) => {
      const safe = JSON.stringify(String(text).slice(0, 160));
      win.webContents.executeJavaScript(
        "document.body.style.whiteSpace = 'pre-line'; document.body.style.textAlign = 'center';"
        + `document.body.innerText = 'setting up AutoShortsCut (first launch)\\n\\n' + ${safe}`).catch(() => {});
    });
    await startBackend();
    win.loadURL(appUrl());
  } catch (err) {
    dialog.showErrorBox('Could not start', `${err.message}\nLog: ${path.join(LOG_DIR, 'backend.log')}`);
    app.quit();
  }
}

// ---- IPC for the dashboard (preload.js) --------------------------------------

ipcMain.handle('config:get', () => readConfig());

ipcMain.handle('config:choose-folder', async (_e, current) => {
  const result = await dialog.showOpenDialog(win, {
    defaultPath: current, properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Save folders and restart the backend on them, then reload the dashboard.
ipcMain.handle('config:set', async (_e, cfg) => {
  const next = { ...readConfig(), ...cfg };
  writeConfig(next);
  win.loadURL(SPLASH);
  await stopBackend();
  await startBackend();
  win.loadURL(appUrl());
  return next;
});

ipcMain.handle('folder:open-project', (_e, jobId) => {
  if (!/^[0-9a-f-]{36}$/.test(String(jobId))) return false;
  const dir = path.join(readConfig().outputDir, jobId);
  return fs.existsSync(dir) ? shell.openPath(dir).then(() => true) : false;
});

ipcMain.handle('folder:open', (_e, which) => {
  const cfg = readConfig();
  if (which === 'settings') return shell.openPath(runtime.ENV_FILE);
  const dir = which === 'uploads' ? cfg.uploadDir : which === 'logs' ? LOG_DIR : cfg.outputDir;
  return shell.openPath(dir);
});

// ---- lifecycle -------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  // Windows shows toast notifications only for an app with a user model id.
  if (process.platform === 'win32') app.setAppUserModelId('com.autoshortscut.app');
  app.whenReady().then(async () => {
    await startUiServer();
    await createWindow();
  });
  app.on('before-quit', async (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    await stopBackend();
    app.exit(0);
  });
  app.on('window-all-closed', () => app.quit());
}
