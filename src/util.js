import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

/** Petit utilitaire : attendre un délai (ms). */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Génère un token hexadécimal aléatoire de `bytes` octets. */
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('hex');

/** Timestamp court pour logs (HH:MM:SS). */
export const ts = () => new Date().toISOString().slice(11, 19);

/** Logger coloré simple (désactivable avec GW_QUIET=1). */
const quiet = process.env.GW_QUIET === '1';
const color = (code, s) => `\x1b[${code}m${s}\x1b[0m`;
export const log = {
  info: (msg) => !quiet && console.log(color(36, `[${ts()}]`) + ' ' + msg),
  ok: (msg) => !quiet && console.log(color(32, `[${ts()}] ✔ ${msg}`)),
  warn: (msg) => !quiet && console.warn(color(33, `[${ts()}] ⚠ ${msg}`)),
  err: (msg) => !quiet && console.error(color(31, `[${ts()}] ✖ ${msg}`)),
};

/** Détecte la plateforme hôte de façon normalisée. */
export function platformInfo() {
  return {
    platform: process.platform, // linux / win32 / darwin
    arch: process.arch, // arm64 / x64 / arm ...
    isTermux: !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux')),
    isAndroid: process.platform === 'linux' && !!process.env.ANDROID_ROOT,
    node: process.version,
  };
}

/**
 * Télécharge un fichier vers un chemin local (suit les redirections GitHub).
 * Retourne le chemin écrit.
 */
export async function downloadFile(url, dest) {
  const maxRedirects = 8;
  let current = url;
  for (let i = 0; i < maxRedirects; i++) {
    const res = await fetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${current}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    return dest;
  }
  throw new Error(`Too many redirects while downloading ${url}`);
}

/** Assure qu'un dossier existe. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Écrit un fichier en s'assurant que le dossier parent existe. */
export function writeFileSafe(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
}

/**
 * Trouve un port TCP libre à partir de `start` (utile quand le port demandé
 * est occupé). Tente une dizaine de ports puis lève une erreur.
 */
export async function findFreePort(start, host = '127.0.0.1') {
  const net = await import('node:net');
  for (let port = start; port < start + 10; port++) {
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, host);
    });
    if (free) return port;
  }
  throw new Error(`No free port found from ${start}`);
}

/** Formate une taille en octets vers une chaîne lisible. */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
