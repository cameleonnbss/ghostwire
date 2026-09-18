/**
 * GhostWire — serveur web du panneau.
 * Zéro dépendance : http natif de Node. Sert l'UI statique et une API JSON.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelManager, generateKeyPair, generatePresharedKey, buildWgConf, parseWgConf, speedTest, tcpLatency, publicIp } from './engine.js';
import { log, randomToken } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export function createApp(opts = {}) {
  const manager = opts.manager instanceof TunnelManager
    ? opts.manager
    : new TunnelManager(opts);
  const token = opts.token || process.env.GW_TOKEN || '';
  const startedAt = Date.now();

  /** Vérifie le token admin (comparaison à temps constant). */
  function isAuthed(req) {
    if (!token) return true; // pas de token configuré → pas d'auth (LAN privé)
    const given = req.headers['x-ghostwire-token']
      || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function json(res, code, data) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function readBody(req, limit = 512 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('Corps de requête trop grand');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      /* ── API ─────────────────────────────────────────────────────── */
      if (p.startsWith('/api/')) {
        // Routes publiques (lecture seule légère)
        if (p === '/api/ping') return json(res, 200, { ok: true, name: 'ghostwire' });

        // Routes protégées
        const protectedRoutes = ['POST', 'PUT', 'DELETE'];
        if (protectedRoutes.includes(req.method) && !isAuthed(req)) {
          return json(res, 401, { error: 'Token admin requis (en-tête X-Ghostwire-Token)' });
        }

        switch (true) {
          case p === '/api/status' && req.method === 'GET': {
            const ip = await publicIp();
            return json(res, 200, { ...manager.statusSummary(), publicIp: ip, panelUptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
          }
          case p === '/api/start' && req.method === 'POST': {
            await manager.start();
            return json(res, 200, { ok: true, status: manager.status });
          }
          case p === '/api/stop' && req.method === 'POST': {
            manager.stop();
            return json(res, 200, { ok: true, status: manager.status });
          }
          case p === '/api/restart' && req.method === 'POST': {
            await manager.restart();
            return json(res, 200, { ok: true, status: manager.status });
          }
          case p === '/api/keys' && req.method === 'POST': {
            const kp = generateKeyPair();
            return json(res, 200, { ...kp, presharedKey: generatePresharedKey() });
          }
          case p === '/api/conf/build' && req.method === 'POST': {
            const body = JSON.parse(await readBody(req));
            const conf = buildWgConf(body);
            return json(res, 200, { conf });
          }
          case p === '/api/conf/import' && req.method === 'POST': {
            const { conf } = JSON.parse(await readBody(req));
            const parsed = parseWgConf(conf || '');
            if (!parsed.interface.privatekey) throw new Error('Section [Interface] avec PrivateKey manquante');
            if (!parsed.peers.length) throw new Error('Section [Peer] manquante');
            fs.mkdirSync(manager.dataDir, { recursive: true });
            fs.writeFileSync(manager.wgConfPath, conf, { mode: 0o600 });
            return json(res, 200, { ok: true, saved: manager.wgConfPath, parsed: { ...parsed, interface: { ...parsed.interface, privatekey: '***' } } });
          }
          case p === '/api/conf/current' && req.method === 'GET': {
            if (!fs.existsSync(manager.wgConfPath)) return json(res, 404, { error: 'Aucune config chargée' });
            const raw = fs.readFileSync(manager.wgConfPath, 'utf8');
            const masked = raw.replace(/(?<=PrivateKey\s*=\s*).+/g, '***');
            return json(res, 200, { raw: masked });
          }
          case p === '/api/speedtest' && req.method === 'POST': {
            const r = await speedTest();
            return json(res, 200, r);
          }
          case p === '/api/latency' && req.method === 'POST': {
            const { host = '1.1.1.1', port = 443 } = await readBody(req).then((b) => JSON.parse(b || '{}'));
            return json(res, 200, { host, port, ms: await tcpLatency(host, port) });
          }
          case p === '/api/qr' && req.method === 'GET': {
            const { renderQrSvg } = await import('./qr.js');
            const conf = fs.existsSync(manager.wgConfPath)
              ? fs.readFileSync(manager.wgConfPath, 'utf8')
              : '';
            if (!conf) return json(res, 404, { error: 'Aucune config à encoder' });
            const svg = await renderQrSvg(conf);
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            return res.end(svg);
          }
          default:
            return json(res, 404, { error: `Route inconnue : ${req.method} ${p}` });
        }
      }

      /* ── Fichiers statiques ──────────────────────────────────────── */
      let file = p === '/' ? '/index.html' : p;
      const full = path.normalize(path.join(PUBLIC_DIR, file));
      if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Interdit' });
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return json(res, 404, { error: 'Introuvable' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    } catch (err) {
      log.err(`${req.method} ${p} → ${err.message}`);
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.destroy();
    }
  });

  // Un crash réseau ne doit jamais tuer le panneau.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, manager };
}

/** Démarre le serveur et retourne { server, manager, url }. */
export async function startServer(opts = {}) {
  const host = opts.host || process.env.GW_HOST || '0.0.0.0';
  let port = Number(opts.port || process.env.GW_PORT || 8080);
  const { server, manager } = createApp(opts);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return { server, manager, url, port, host };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  startServer().then(({ url }) => log.ok(`Panneau GhostWire : ${url}`));
}
