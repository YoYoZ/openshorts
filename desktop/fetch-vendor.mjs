// Downloads what the installer bundles so the target machine needs nothing
// preinstalled: a portable CPython (python-build-standalone) and static
// ffmpeg/ffprobe builds, for the platform this runs on, into desktop/vendor/.
//
//   node fetch-vendor.mjs
//
// vendor/python/  the interpreter the app builds its environment from
// vendor/ffmpeg/  ffmpeg + ffprobe, put first on the backend's PATH
//
// Versions are pinned; bump them here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const PY_RELEASE = '20260924';
const PY_VERSION = '3.12.14';
const FFMPEG_BTBN = 'ffmpeg-n8.1-latest-{os}-gpl-8.1';   // BtbN/FFmpeg-Builds "latest" tag, 8.1 branch
const FFMPEG_STATIC_MAC = 'b6.1.1';                      // eugeneware/ffmpeg-static (Apple Silicon)

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const vendor = path.join(here, 'vendor');
// Next to vendor/, not in the OS temp dir: on Windows runners that is another
// drive, and the final rename into vendor/ cannot cross drives.
fs.rmSync(path.join(here, '.vendor-tmp'), { recursive: true, force: true });
fs.mkdirSync(path.join(here, '.vendor-tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(here, '.vendor-tmp', 'v-'));
const platform = process.platform;

const PY_TRIPLE = {
    win32: 'x86_64-pc-windows-msvc',
    linux: 'x86_64-unknown-linux-gnu',
    darwin: process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin',
}[platform];

async function download(url, dest) {
    console.log(`↓ ${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
}

// tar (GNU on Linux, bsdtar on Windows/macOS) reads .tar.gz, .tar.xz and .zip.
function extract(archive, into) {
    fs.mkdirSync(into, { recursive: true });
    // On Windows the system bsdtar, not a Git-Bash GNU tar that reads "C:" as a host.
    const tar = platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', archive, '-C', into], { stdio: 'inherit' });
}

function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const hit = findFile(p, name);
            if (hit) return hit;
        } else if (entry.name === name) return p;
    }
    return null;
}

async function python() {
    const name = `cpython-${PY_VERSION}+${PY_RELEASE}-${PY_TRIPLE}-install_only.tar.gz`;
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${encodeURIComponent(name)}`;
    const archive = await download(url, path.join(tmp, 'python.tar.gz'));
    const out = path.join(tmp, 'py');
    extract(archive, out);
    fs.rmSync(path.join(vendor, 'python'), { recursive: true, force: true });
    fs.renameSync(path.join(out, 'python'), path.join(vendor, 'python'));   // the archive's top folder
}

async function ffmpeg() {
    const dest = path.join(vendor, 'ffmpeg');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    if (platform === 'darwin') {
        for (const tool of ['ffmpeg', 'ffprobe']) {
            const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_MAC}/${tool}-darwin-${process.arch}.gz`;
            const gz = await download(url, path.join(tmp, `${tool}.gz`));
            fs.writeFileSync(path.join(dest, tool), zlib.gunzipSync(fs.readFileSync(gz)));
            fs.chmodSync(path.join(dest, tool), 0o755);
        }
        return;
    }
    const base = FFMPEG_BTBN.replace('{os}', platform === 'win32' ? 'win64' : 'linux64');
    const file = base + (platform === 'win32' ? '.zip' : '.tar.xz');
    const archive = await download(`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${file}`,
        path.join(tmp, file));
    const out = path.join(tmp, 'ff');
    extract(archive, out);
    for (const tool of ['ffmpeg', 'ffprobe']) {
        const exe = tool + (platform === 'win32' ? '.exe' : '');
        const src = findFile(out, exe);
        if (!src) throw new Error(`${exe} not found in ${file}`);
        fs.copyFileSync(src, path.join(dest, exe));
        fs.chmodSync(path.join(dest, exe), 0o755);
    }
}

fs.mkdirSync(vendor, { recursive: true });
await python();
await ffmpeg();
fs.rmSync(path.join(here, '.vendor-tmp'), { recursive: true, force: true });
console.log(`vendor ready: ${fs.readdirSync(vendor).join(', ')}`);
