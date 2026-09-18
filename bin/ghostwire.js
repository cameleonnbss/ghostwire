#!/usr/bin/env node
/**
 * GhostWire CLI — host the panel + tunnel anywhere Node runs
 * (Android/Termux, Linux, Windows, macOS).
 *
 *   ghostwire setup              download the wireproxy binary for this OS
 *   ghostwire start              start the web panel + tunnel
 *   ghostwire useradd <u> <p>    create an account (first = admin)
 *   ghostwire passwd <u> <p>     change an account password
 *   ghostwire status             tunnel state as JSON
 *   ghostwire genkey             generate a WireGuard key pair
 *   ghostwire import <file>      import a WireGuard .conf
 *   ghostwire doctor             environment diagnostics
 *   ghostwire release [version]  build local release archives
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platformInfo, log, downloadFile, ensureDir, writeFileSafe } from '../src/util.js';
import { TunnelManager, generateKeyPair, parseWgConf } from '../src/engine.js';
import { AuthStore } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIREPROXY_VERSION = 'v1.1.3';
const WIREPROXY_REPO = 'pufferffish/wireproxy';
const VERSION = '1.1.0';

const HELP = `
GhostWire - self-hosted VPN panel (WireGuard userspace, no root)

Usage:
  ghostwire <command> [options]

Panel & accounts:
  start                Start the web panel (and optionally the tunnel)
  useradd <u> <pass>   Create an account - the first one becomes admin
  passwd <u> <pass>    Change an account password
  status               Print tunnel state as JSON

WireGuard helpers:
  setup                Download the wireproxy binary for this platform
  genkey               Generate a WireGuard key pair
  import <file>        Import a .conf into the panel
  qr                   Export the current config as a QR code (SVG)

Maintenance:
  doctor               Check Node, OS, binary, config, connectivity
  release [version]    Build release archives into dist/
  help                 Show this help

Start options:
  --port <n>           Panel port (default 8080, env GW_PORT)
  --host <addr>        Bind address (default 0.0.0.0, env GW_HOST)
  --data <dir>         Data directory (default ./data)
  --demo               Demo mode: UI without a real tunnel
`;

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

async function setupWireproxy() {
  const { isTermux } = platformInfo();
  if (isTermux) log.warn('Termux detected: if storage is locked, run: termux-setup-storage');
  const asset = wireproxyAsset();
  const url = `https://github.com/${WIREPROXY_REPO}/releases/download/${WIREPROXY_VERSION}/${asset}`;
  const binDir = path.join(ROOT, 'bin');
  const archive = path.join(binDir, asset);
  ensureDir(binDir);
  log.info(`Downloading ${asset} (${WIREPROXY_VERSION})...`);
  await downloadFile(url, archive);
  log.info('Extracting...');
  // Relative paths + cwd: GNU tar on Windows reads "C:\..." as a remote host
  execSync(`tar -xzf "${asset}"`, { cwd: binDir, stdio: 'pipe' });
  fs.rmSync(archive, { force: true });
  const bin = wireproxyBinPath();
  if (!fs.existsSync(bin)) throw new Error(`Archive extracted but binary not found: ${bin}`);
  try { fs.chmodSync(bin, 0o755); } catch { /* some FS ignore chmod (Android) */ }
  log.ok(`wireproxy installed: ${bin}`);
  return bin;
}

function withDataDir(args) {
  const dataDir = args.data || process.env.GW_DATA_DIR || path.join(ROOT, 'data');
  ensureDir(dataDir);
  process.env.GW_DATA_DIR = dataDir;
  return dataDir;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';

  if (cmd === 'help' || args.h || args.help) { console.log(HELP); return; }

  if (cmd === 'setup') { await setupWireproxy(); return; }

  if (cmd === 'genkey') {
    const kp = generateKeyPair();
    console.log(`PrivateKey = ${kp.privateKey}`);
    console.log(`PublicKey  = ${kp.publicKey}`);
    return;
  }

  if (cmd === 'useradd' || cmd === 'passwd') {
    const dataDir = withDataDir(args);
    const [username, password] = args._.slice(1);
    if (!username || !password) throw new Error(`Usage: ghostwire ${cmd} <username> <password>`);
    const auth = new AuthStore(dataDir);
    if (cmd === 'useradd') {
      const u = auth.addUser(username, password, args.role);
      log.ok(`User created: ${u.username} (${u.role})`);
    } else {
      auth.changePassword(username, password);
      log.ok(`Password updated for ${String(username).toLowerCase()}`);
    }
    return;
  }

  if (cmd === 'import') {
    const dataDir = withDataDir(args);
    const file = args._[1];
    if (!file || !fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    const content = fs.readFileSync(file, 'utf8');
    const parsed = parseWgConf(content);
    if (!parsed.interface.privatekey) throw new Error('Invalid config: [Interface] PrivateKey missing');
    const dest = path.join(dataDir, 'tunnel0.conf');
    writeFileSafe(dest, content);
    log.ok(`Config imported: ${dest}`);
    return;
  }

  if (cmd === 'qr') {
    const dataDir = withDataDir(args);
    const { renderQrSvg } = await import('../src/qr.js');
    const confPath = path.join(dataDir, 'tunnel0.conf');
    if (!fs.existsSync(confPath)) throw new Error('No config yet - import a .conf first');
    const svg = await renderQrSvg(fs.readFileSync(confPath, 'utf8'));
    const out = path.join(dataDir, 'config-qr.svg');
    fs.writeFileSync(out, svg);
    log.ok(`QR code written: ${out}`);
    return;
  }

  if (cmd === 'doctor') {
    const info = platformInfo();
    log.info(`Node ${info.node} - ${info.platform}/${info.arch}${info.isTermux ? ' (Termux)' : ''}`);
    const bin = wireproxyBinPath();
    const conf = path.join(withDataDir(args), 'tunnel0.conf');
    log.info(`wireproxy : ${fs.existsSync(bin) ? 'OK (installed)' : 'MISSING - run: ghostwire setup'}`);
    log.info(`config    : ${fs.existsSync(conf) ? 'OK (present)' : 'MISSING - ghostwire import <file.conf>'}`);
    const auth = new AuthStore(withDataDir(args));
    log.info(`accounts  : ${auth.enabled ? auth.listUsers().length + ' user(s)' : 'none (panel is open-mode)'}`);
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
      const { ip } = await res.json();
      log.ok(`Internet  : OK (public IP ${ip})`);
    } catch {
      log.err('Internet  : unreachable');
    }
    return;
  }

  if (cmd === 'status') {
    const dataDir = withDataDir(args);
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
    await buildRelease(args._[1] || VERSION);
    return;
  }

  if (cmd === 'start') {
    const dataDir = withDataDir(args);
    const info = platformInfo();
    log.info(`GhostWire v${VERSION} - Node ${info.node} - ${info.platform}/${info.arch}${info.isTermux ? ' (Termux)' : ''}`);
    if (args.demo) log.warn('DEMO MODE: no real tunnel, UI only.');

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
    const { url } = await startServerIfLoaded({ host, port, manager, args });

    log.ok(`Panel      : ${url}  (LAN: http://<host-ip>:${port})`);
    log.info(`SOCKS5     : 127.0.0.1:${manager.socksPort} (once the tunnel is started)`);
    const auth = new AuthStore(dataDir);
    log.info(`Accounts   : ${auth.enabled ? `${auth.listUsers().length} user(s) - login required` : 'none - anyone on the network can use the panel'}`);
    log.info('Press Ctrl+C to quit.');

    if (!args.demo && fs.existsSync(path.join(dataDir, 'autostart'))) {
      manager.start().catch((e) => log.err(`Autostart: ${e.message}`));
    }

    const shutdown = () => { manager.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  console.log(HELP);
  process.exitCode = 1;
}

async function startServerIfLoaded(opts) {
  const mod = await import('../src/server.js');
  return mod.startServer(opts);
}

main().catch((err) => {
  log.err(err.message);
  process.exit(1);
});
