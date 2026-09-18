#!/usr/bin/env node
/**
 * GhostWire CLI — héberge le panneau + tunnel partout où Node tourne
 * (Termux/Android, Linux, Windows, macOS).
 *
 *   ghostwire setup            télécharge le binaire wireproxy adapté à l'OS
 *   ghostwire start            démarre panneau + tunnel
 *   ghostwire status           état du tunnel
 *   ghostwire genkey           génère un pair de clés WireGuard
 *   ghostwire import <fichier> importe un .conf WireGuard
 *   ghostwire doctor           diagnostic environnement
 *   ghostwire release [ver]    prépare les archives de release locales
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformInfo, log, downloadFile, ensureDir, writeFileSafe } from '../src/util.js';
import { TunnelManager, generateKeyPair, parseWgConf } from '../src/engine.js';
import { startServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIREPROXY_VERSION = 'v1.1.3';
const WIREPROXY_REPO = 'pufferffish/wireproxy';

const HELP = `
GhostWire — panneau VPN auto-hébergé (WireGuard userspace)

Usage:
  ghostwire <commande> [options]

Commandes:
  setup              Télécharge wireproxy pour votre plateforme (auto-détectée)
  start              Démarre le panneau web + le tunnel
  status             Affiche l'état du tunnel
  genkey             Génère un pair de clés WireGuard (base64 wg)
  import <file>      Importe un fichier .conf WireGuard
  qr                 Exporte la config actuelle en QR code (SVG)
  doctor             Diagnostic : Node, OS, binaire, config, connectivité
  release [version]  Construit les archives de release dans dist/
  help               Affiche cette aide

Options:
  --port <n>         Port du panneau (défaut 8080, ou $GW_PORT)
  --host <addr>      Adresse d'écoute (défaut 0.0.0.0, ou $GW_HOST)
  --token <secret>   Token admin (défaut $GW_TOKEN ; sans lui, pas d'auth)
  --data <dir>       Dossier de données (défaut ./data)
  --demo             Mode démo : UI testable sans tunnel réel
`;

/* ── Aides CLI ─────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else { args[key] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

function wireproxyAsset() {
  const { platform, arch } = platformInfo();
  const goarch = arch === 'x64' ? 'amd64' : arch;
  const plat = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
  return `wireproxy_${plat}_${goarch}.tar.gz`;
}

function wireproxyBinPath() {
  return path.join(ROOT, 'bin', platformInfo().platform === 'win32' ? 'wireproxy.exe' : 'wireproxy');
}

/** Télécharge et installe wireproxy dans bin/. */
async function setupWireproxy() {
  const { isTermux } = platformInfo();
  if (isTermux) {
    log.warn('Termux détecté : si le stockage est verrouillé, lancez d\u2019abord : termux-setup-storage');
  }
  const asset = wireproxyAsset();
  const url = `https://github.com/${WIREPROXY_REPO}/releases/download/${WIREPROXY_VERSION}/${asset}`;
  const binDir = path.join(ROOT, 'bin');
  const archive = path.join(binDir, asset);
  ensureDir(binDir);
  log.info(`Téléchargement de ${asset} (${WIREPROXY_VERSION})…`);
  await downloadFile(url, archive);
  log.info('Extraction…');
  // Chemins relatifs + cwd : GNU tar sur Windows lit "C:\…" comme un hôte distant
  execSync(`tar -xzf "${asset}"`, { cwd: binDir, stdio: 'pipe' });
  fs.rmSync(archive, { force: true });
  const bin = wireproxyBinPath();
  if (!fs.existsSync(bin)) {
    throw new Error(`Archive extraite mais binaire introuvable : ${bin}`);
  }
  try { fs.chmodSync(bin, 0o755); } catch { /* certains FS (Android) ignorent le chmod */ }
  log.ok(`wireproxy installé : ${bin}`);
  return bin;
}

/** Importe un .conf WireGuard dans data/. */
function importConf(file) {
  if (!file || !fs.existsSync(file)) throw new Error(`Fichier introuvable : ${file}`);
  const content = fs.readFileSync(file, 'utf8');
  const parsed = parseWgConf(content); // lève une erreur si structure absente
  if (!parsed.interface.privatekey) throw new Error('Config invalide : [Interface] PrivateKey manquant');
  const dataDir = process.env.GW_DATA_DIR || path.join(ROOT, 'data');
  const dest = path.join(dataDir, 'tunnel0.conf');
  writeFileSafe(dest, content);
  log.ok(`Config importée : ${dest}`);
  return dest;
}

/** Diagnostic environnement. */
async function doctor() {
  const info = platformInfo();
  log.info(`Node ${info.node} · ${info.platform}/${info.arch}${info.isTermux ? ' (Termux)' : ''}`);
  const bin = wireproxyBinPath();
  const conf = path.join(process.env.GW_DATA_DIR || path.join(ROOT, 'data'), 'tunnel0.conf');
  log.info(`wireproxy : ${fs.existsSync(bin) ? '✔ présent' : '✖ absent — lancez : ghostwire setup'}`);
  log.info(`config    : ${fs.existsSync(conf) ? '✔ présente' : '✖ absente — ghostwire import <fichier.conf>'}`);
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const { ip } = await res.json();
    log.ok(`Internet  : OK (IP publique ${ip})`);
  } catch {
    log.err('Internet  : injoignable');
  }
}

/* ── Commandes ─────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  const dataDir = args.data || process.env.GW_DATA_DIR || path.join(ROOT, 'data');
  ensureDir(dataDir);
  process.env.GW_DATA_DIR = dataDir;

  if (cmd === 'help' || args.h || args.help) { console.log(HELP); return; }

  if (cmd === 'setup') { await setupWireproxy(); return; }

  if (cmd === 'genkey') {
    const kp = generateKeyPair();
    console.log(`PrivateKey = ${kp.privateKey}`);
    console.log(`PublicKey  = ${kp.publicKey}`);
    return;
  }

  if (cmd === 'import') { importConf(args._[1]); return; }

  if (cmd === 'qr') {
    const { renderQrSvg } = await import('../src/qr.js');
    const confPath = path.join(dataDir, 'tunnel0.conf');
    if (!fs.existsSync(confPath)) throw new Error('Aucune config : importez un .conf d\u2019abord');
    const svg = await renderQrSvg(fs.readFileSync(confPath, 'utf8'));
    const out = path.join(dataDir, 'config-qr.svg');
    fs.writeFileSync(out, svg);
    log.ok(`QR code écrit : ${out}`);
    return;
  }

  if (cmd === 'doctor') { await doctor(); return; }

  if (cmd === 'status') {
    const m = new TunnelManager({
      dataDir,
      wireproxy: wireproxyBinPath(),
      wgConf: path.join(dataDir, 'tunnel0.conf'),
    });
    console.log(JSON.stringify(m.statusSummary(), null, 2));
    return;
  }

  if (cmd === 'release') {
    const { buildRelease } = await import('../scripts/release.js');
    await buildRelease(args._[1] || 'dev');
    return;
  }

  if (cmd === 'start') {
    const info = platformInfo();
    log.info(`GhostWire — Node ${info.node} · ${info.platform}/${info.arch}${info.isTermux ? ' (Termux)' : ''}`);
    if (args.demo) log.warn('MODE DÉMO : pas de tunnel réel, UI testable.');

    const manager = new TunnelManager({
      dataDir,
      wireproxy: wireproxyBinPath(),
      wgConf: path.join(dataDir, 'tunnel0.conf'),
      socksPort: Number(args['socks-port'] || process.env.GW_SOCKS_PORT || 1080),
      httpPort: Number(args['http-port'] || process.env.GW_HTTP_PORT || 8888),
      auth: process.env.GW_PROXY_AUTH || null,
    });

    const host = args.host || process.env.GW_HOST || '0.0.0.0';
    const port = Number(args.port || process.env.GW_PORT || 8080);
    const { url } = await startServer({ host, port, manager, token: args.token || process.env.GW_TOKEN || '' });

    log.ok(`Panneau      : ${url}  (réseau : http://<IP-locale>:${port})`);
    log.info(`SOCKS5 proxy : 127.0.0.1:${manager.socksPort} (une fois le tunnel démarré)`);
    log.info('Ctrl+C pour quitter.');

    if (!args.demo && fs.existsSync(path.join(dataDir, 'autostart'))) {
      manager.start().catch((e) => log.err(`Autostart : ${e.message}`));
    }

    const shutdown = () => { manager.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

main().catch((err) => {
  log.err(err.message);
  process.exit(1);
});
