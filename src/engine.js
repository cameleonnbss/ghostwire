/**
 * GhostWire — moteur VPN.
 * Wrappé autour du binaire wireproxy (WireGuard userspace → proxy SOCKS5/HTTP).
 * Génère les clés, parse les configs .conf, gère le process et l'état.
 *
 * Pourquoi wireproxy ? WireGuard tourne 100% en espace utilisateur : pas de
 * root, pas d'interface tun — donc le même binaire fonctionne sur
 * Android/Termux, Linux, Windows et macOS.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { platformInfo, log, ensureDir, writeFileSafe, sleep } from './util.js';

/* ── Génération de clés WireGuard (Curve25519, encodage base64 wg) ─────── */

/** Pair de clés WireGuard neuves { privateKey, publicKey } en base64. */
export function generateKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  const privJwk = privateKey.export({ format: 'jwk' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  return {
    // En JWK OKP/X25519 : le scalar privé est `d`, la clé publique est `x`.
    privateKey: Buffer.from(privJwk.d, 'base64url').toString('base64'),
    publicKey: Buffer.from(pubJwk.x, 'base64url').toString('base64'),
  };
}

/** Dérive la clé publique WireGuard (base64) d'une clé privée (base64). */
export function publicKeyFromPrivate(privateKeyB64) {
  const rawPriv = Buffer.from(privateKeyB64, 'base64');
  if (rawPriv.length !== 32) throw new Error('Clé privée invalide (32 octets attendus)');
  // Préfixe DER PKCS#8 fixe pour une clé privée X25519.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b656e04220420', 'hex'), rawPriv,
  ]);
  const privKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privKey).export({ type: 'spki', format: 'der' });
  return spki.subarray(12).toString('base64'); // en-tête SPKI x25519 = 12 octets
}

/** Génère une PSK WireGuard (base64, 32 octets). */
export function generatePresharedKey() {
  return crypto.randomBytes(32).toString('base64');
}

/* ── Parsing / génération de configs WireGuard ─────────────────────────── */

const IFACE_ALLOWED = new Set(['privatekey', 'address', 'dns', 'mtu', 'listenport']);
const PEER_ALLOWED = new Set([
  'publickey', 'presharedkey', 'endpoint', 'allowedips', 'persistentkeepalive',
]);

/** Parse un fichier .conf WireGuard en objet structuré. */
export function parseWgConf(text) {
  const conf = { interface: {}, peers: [] };
  let section = null;
  let peer = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const s = line.replace(/[[\]]/g, '').toLowerCase();
      if (s === 'peer') { peer = {}; conf.peers.push(peer); }
      section = s;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (section === 'interface') conf.interface[key] = value;
    else if (section === 'peer' && peer) peer[key] = value;
  }
  return conf;
}

/** Génère un .conf client complet à partir de paramètres. */
export function buildWgConf({ privateKey, address, dns = '1.1.1.1, 8.8.8.8', mtu = 1420, peer }) {
  const lines = [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${address}`,
    dns ? `DNS = ${dns}` : null,
    `MTU = ${mtu}`,
    '',
    '[Peer]',
    `PublicKey = ${peer.publicKey}`,
    peer.presharedKey ? `PresharedKey = ${peer.presharedKey}` : null,
    peer.endpoint ? `Endpoint = ${peer.endpoint}` : null,
    `AllowedIPs = ${peer.allowedIPs || '0.0.0.0/0'}`,
    peer.keepalive ? `PersistentKeepalive = ${peer.keepalive}` : null,
  ];
  return lines.filter((l) => l !== null).join('\n') + '\n';
}

/* ── Gestion du process wireproxy ──────────────────────────────────────── */

export class TunnelManager {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir    Dossier de données runtime
   * @param {string} opts.wireproxy  Chemin du binaire wireproxy
   * @param {string} opts.wgConf     Chemin du .conf WireGuard
   * @param {number} opts.socksPort  Port du proxy SOCKS5 local
   * @param {number} opts.httpPort   Port du proxy HTTP local
   * @param {string} [opts.auth]     Auth proxy "user:pass" (optionnel)
   */
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || './data';
    this.wireproxyBin = opts.wireproxy || path.join('bin', 'wireproxy');
    this.wgConfPath = opts.wgConf || path.join(this.dataDir, 'tunnel0.conf');
    this.socksPort = opts.socksPort || 1080;
    this.httpPort = opts.httpPort || 8888;
    this.auth = opts.auth || null;
    this.proc = null;
    this.startedAt = null;
    this.status = 'stopped'; // stopped | starting | running | error
    this.lastError = null;
    this.logTail = [];
    this.stats = { bytesIn: 0, bytesOut: 0, reconnects: 0 };
  }

  /** Chemin du fichier de config wireproxy généré. */
  get proxyConfPath() {
    return path.join(this.dataDir, 'wireproxy.conf');
  }

  _tail(line) {
    this.logTail.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (this.logTail.length > 200) this.logTail.shift();
  }

  /**
   * Génère la config wireproxy : sections WireGuard filtrées des options
   * wg-quick non supportées (Table, PreUp/PostUp…), + serveurs proxy locaux.
   */
  buildProxyConf() {
    const wg = fs.readFileSync(this.wgConfPath, 'utf8');
    const lines = [];
    for (const rawLine of wg.split(/\r?\n/)) {
      const t = rawLine.trim();
      if (!t || t.startsWith('#')) continue;
      if (t.startsWith('[')) { lines.push(t); continue; }
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim().toLowerCase();
      const inIface = t.startsWith('[') ? false : linesAtSection(lines).iface;
      const allowed = inIface ? IFACE_ALLOWED : PEER_ALLOWED;
      if (allowed.has(key)) lines.push(t);
    }
    lines.push(
      '',
      '# ── Serveurs proxy locaux exposés par wireproxy (ajouté par GhostWire) ──',
      '[Socks5]',
      `BindAddress = 127.0.0.1:${this.socksPort}`,
    );
    const [user, pass] = this.auth ? this.auth.split(':') : [null, null];
    if (user) lines.push(`Username = ${user}`, `Password = ${pass}`);
    lines.push('[HTTP]', `BindAddress = 127.0.0.1:${this.httpPort}`);
    if (user) lines.push(`Username = ${user}`, `Password = ${pass}`);
    writeFileSafe(this.proxyConfPath, lines.join('\n') + '\n');
    this.parsedConf = parseWgConf(wg);
    return this.proxyConfPath;
  }

  /** Vérifie que le binaire existe et est exécutable. */
  checkBinary() {
    try {
      fs.accessSync(this.wireproxyBin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Démarre le tunnel — se résout quand les proxys écoutent. */
  async start() {
    if (this.proc) throw new Error('Le tunnel tourne déjà');
    if (!fs.existsSync(this.wgConfPath)) {
      this.status = 'error';
      this.lastError = `Config WireGuard introuvable : ${this.wgConfPath}. Importez un .conf ou générez-en un (npx ghostwire genkey).`;
      throw new Error(this.lastError);
    }
    if (!this.checkBinary()) {
      this.status = 'error';
      this.lastError = `Binaire wireproxy introuvable : ${this.wireproxyBin}. Lancez : npx ghostwire setup`;
      throw new Error(this.lastError);
    }
    ensureDir(this.dataDir);
    this.buildProxyConf();
    this.status = 'starting';
    this.lastError = null;
    log.info(`Démarrage du tunnel (SOCKS5 :${this.socksPort}, HTTP :${this.httpPort})…`);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.wireproxyBin, ['-c', this.proxyConfPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let settled = false;
      const fail = (msg) => {
        if (settled) return;
        settled = true;
        this.status = 'error';
        this.lastError = msg;
        log.err(msg);
        reject(new Error(msg));
      };
      const ok = () => {
        if (settled) return;
        settled = true;
        this.status = 'running';
        this.startedAt = Date.now();
        log.ok(`Tunnel opérationnel (SOCKS5 :${this.socksPort}, HTTP :${this.httpPort})`);
        resolve();
      };
      const onLine = (buf) => {
        for (const line of buf.toString().split(/\r?\n/)) {
          if (!line.trim()) continue;
          this._tail(line.trim());
          if (!settled && /fatal|panic|failed to (bind|listen|start)|error while|should be 32 bytes/i.test(line)) {
            fail(line.trim());
          }
        }
      };
      proc.stdout.on('data', onLine);
      proc.stderr.on('data', onLine);
      proc.on('exit', (code) => {
        this._tail(`wireproxy terminé (code ${code})`);
        if (this.proc === proc) this.proc = null;
        if (settled) { this.status = 'stopped'; this.startedAt = null; }
        else fail(`wireproxy a quitté immédiatement (code ${code}) — config invalide ?`);
      });

      // Sonde fiable : le tunnel est prêt quand le port SOCKS5 accepte une
      // connexion TCP (indépendant des messages de log, qui varient selon
      // les versions de wireproxy).
      const t0 = Date.now();
      const probe = async () => {
        while (!settled && Date.now() - t0 < 10_000) {
          if (await portOpen('127.0.0.1', this.socksPort)) { ok(); return; }
          await sleep(250);
        }
        if (!settled) fail(`wireproxy n'écoute pas sur le port SOCKS ${this.socksPort} après 10 s`);
      };
      probe();
    });
  }

  /** Arrête le tunnel. */
  stop() {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      const p = this.proc;
      setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* déjà mort */ } }, 3000).unref();
      this.proc = null;
    }
    this.status = 'stopped';
    this.startedAt = null;
    log.info('Tunnel arrêté');
  }

  /** Redémarre le tunnel. */
  async restart() {
    this.stop();
    // Laisse le temps au port de se libérer.
    await new Promise((r) => setTimeout(r, 500));
    return this.start();
  }

  /** Snapshot d'état pour l'API et l'UI. */
  statusSummary() {
    return {
      status: this.status,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      socksPort: this.socksPort,
      httpPort: this.httpPort,
      wgConf: this.wgConfPath,
      hasConf: fs.existsSync(this.wgConfPath),
      hasBinary: this.checkBinary(),
      lastError: this.lastError,
      stats: this.stats,
      logTail: this.logTail.slice(-30),
      host: platformInfo(),
    };
  }
}

/** Vrai si une connexion TCP aboutit sur host:port (300 ms de délai max). */
function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.setTimeout(300, () => { s.destroy(); resolve(false); });
  });
}

/** Petit utilitaire interne : détecte si on est dans la section [Interface]. */
function linesAtSection(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('[')) return { iface: lines[i].toLowerCase() === '[interface]' };
  }
  return { iface: false };
}

/* ── Diagnostics réseau ────────────────────────────────────────────────── */

/** Latence TCP moyenne vers host:port (ms), -1 si injoignable. */
export function tcpLatency(host, port, n = 3) {
  return new Promise((resolve) => {
    const results = [];
    let i = 0;
    const attempt = () => {
      const start = process.hrtime.bigint();
      const socket = net.connect({ host, port });
      const done = (ms) => { socket.destroy(); results.push(ms); next(); };
      socket.once('connect', () => done(Number(process.hrtime.bigint() - start) / 1e6));
      socket.once('error', () => done(-1));
      socket.setTimeout(3000, () => { socket.destroy(); done(-1); });
    };
    const next = () => {
      i++;
      if (i >= n) {
        const ok = results.filter((r) => r >= 0);
        resolve(ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : -1);
      } else attempt();
    };
    attempt();
  });
}

/** Test de débit descendant via speed.cloudflare.com (côté serveur). */
export async function speedTest(bytes = 10 * 1024 * 1024) {
  const url = `https://speed.cloudflare.com/__down?bytes=${bytes}`;
  const start = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Speedtest HTTP ${res.status}`);
  let received = 0;
  for await (const chunk of res.body) received += chunk.length;
  const seconds = Math.max((Date.now() - start) / 1000, 0.001);
  return { bytes: received, seconds: +seconds.toFixed(2), mbps: +((received * 8) / seconds / 1e6).toFixed(1) };
}

/** IP publique telle que vue depuis Internet (via le tunnel si actif). */
export async function publicIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    return json.ip || null;
  } catch {
    return null;
  }
}
