/**
 * GhostWire — panel HTTP server.
 * Zero-dependency (node:http). Serves the web UI and the JSON API.
 * When at least one account exists, every route except /api/ping and
 * /api/auth/* requires a session token (Authorization: Bearer or cookie).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TunnelManager, generateKeyPair, generatePresharedKey, buildWgConf, parseWgConf, speedTest, tcpLatency, publicIp } from './engine.js';
import { AuthStore, tokenFromRequest } from './auth.js';
import { log } from './util.js';

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
  const dataDir = manager.dataDir;
  const auth = new AuthStore(dataDir);
  const startedAt = Date.now();

  function json(res, code, data, headers = {}) {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  async function readBody(req, limit = 512 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('Request body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Resolve the current session; null when auth is open or token invalid. */
  function sessionOf(req) {
    if (!auth.enabled) return { username: 'anonymous', role: 'admin' };
    return auth.verify(tokenFromRequest(req));
  }

  function requireRole(req, res, role) {
    const s = sessionOf(req);
    if (!s) {
      json(res, 401, { error: 'Authentication required' });
      return null;
    }
    if (role === 'admin' && s.role !== 'admin') {
      json(res, 403, { error: 'Admin role required' });
      return null;
    }
    return s;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      /* ── Auth & public endpoints ─────────────────────────────────── */
      if (p === '/api/ping') return json(res, 200, { ok: true, name: 'ghostwire', version: '1.1.0' });

      if (p === '/api/auth/state') {
        return json(res, 200, { authEnabled: auth.enabled });
      }

      if (p === '/api/auth/login' && req.method === 'POST') {
        const { username, password } = JSON.parse(await readBody(req));
        if (!auth.enabled) return json(res, 400, { error: 'No accounts configured — run: ghostwire useradd <name> <pass>' });
        const r = auth.login(username, password);
        if (!r.ok) {
          if (r.waitSec) return json(res, 429, { error: `Too many failed attempts. Try again in ${r.waitSec}s.` });
          return json(res, 401, { error: 'Invalid username or password' });
        }
        log.info(`Login: ${r.user.username} (${r.user.role})`);
        return json(res, 200, {
          ok: true,
          token: r.token,
          expiresAt: r.expiresAt,
          user: r.user,
        }, { 'Set-Cookie': `gw_session=${r.token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax` });
      }

      if (p === '/api/auth/logout' && req.method === 'POST') {
        const token = tokenFromRequest(req);
        auth.logout(token);
        return json(res, 200, { ok: true }, { 'Set-Cookie': 'gw_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
      }

      /* ── API (authenticated) ─────────────────────────────────────── */
      if (p.startsWith('/api/')) {
        const isRead = req.method === 'GET';
        const session = requireRole(req, res, isRead ? 'viewer' : 'admin');
        if (!session) return;

        switch (true) {
          case p === '/api/me':
            return json(res, 200, { user: session });

          case p === '/api/auth/users' && req.method === 'GET':
            if (session.role !== 'admin') return json(res, 403, { error: 'Admin role required' });
            return json(res, 200, { users: auth.listUsers(), authEnabled: auth.enabled });

          case p === '/api/auth/users' && req.method === 'POST': {
            if (session.role !== 'admin') return json(res, 403, { error: 'Admin role required' });
            const { username, password, role } = JSON.parse(await readBody(req));
            const u = auth.addUser(username, password, role);
            log.info(`User created: ${u.username} (${u.role}) by ${session.username}`);
            return json(res, 200, { ok: true, user: u });
          }

          case p === '/api/auth/users' && req.method === 'DELETE': {
            if (session.role !== 'admin') return json(res, 403, { error: 'Admin role required' });
            const { username } = JSON.parse(await readBody(req) || '{}');
            auth.removeUser(username);
            return json(res, 200, { ok: true });
          }

          case p === '/api/auth/password' && req.method === 'POST': {
            const { username, newPassword } = JSON.parse(await readBody(req));
            const target = session.role === 'admin' ? (username || session.username) : session.username;
            auth.changePassword(target, newPassword);
            return json(res, 200, { ok: true });
          }

          case p === '/api/status' && req.method === 'GET': {
            const ip = await publicIp();
            return json(res, 200, {
              ...manager.statusSummary(),
              publicIp: ip,
              authEnabled: auth.enabled,
              panelUptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            });
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
            if (!parsed.interface.privatekey) throw new Error('[Interface] PrivateKey is missing');
            if (!parsed.peers.length) throw new Error('[Peer] section is missing');
            fs.mkdirSync(manager.dataDir, { recursive: true });
            fs.writeFileSync(manager.wgConfPath, conf, { mode: 0o600 });
            log.info(`Config imported by ${session.username}`);
            return json(res, 200, { ok: true, saved: manager.wgConfPath, parsed: { ...parsed, interface: { ...parsed.interface, privatekey: '***' } } });
          }
          case p === '/api/conf/current' && req.method === 'GET': {
            if (!fs.existsSync(manager.wgConfPath)) return json(res, 404, { error: 'No config loaded' });
            const raw = fs.readFileSync(manager.wgConfPath, 'utf8');
            const masked = raw.replace(/(?<=PrivateKey\s*=\s*).+/g, '***');
            return json(res, 200, { raw: masked });
          }
          case p === '/api/speedtest' && req.method === 'POST': {
            const r = await speedTest();
            return json(res, 200, r);
          }
          case p === '/api/latency' && req.method === 'POST': {
            const { host = '1.1.1.1', port = 443 } = JSON.parse(await readBody(req) || '{}');
            return json(res, 200, { host, port, ms: await tcpLatency(host, port) });
          }
          case p === '/api/qr' && req.method === 'GET': {
            const { renderQrSvg } = await import('./qr.js');
            const conf = fs.existsSync(manager.wgConfPath)
              ? fs.readFileSync(manager.wgConfPath, 'utf8')
              : '';
            if (!conf) return json(res, 404, { error: 'No config to encode' });
            const svg = await renderQrSvg(conf);
            res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
            return res.end(svg);
          }
          default:
            return json(res, 404, { error: `Unknown route: ${req.method} ${p}` });
        }
      }

      /* ── Static files ────────────────────────────────────────────── */
      let file = p === '/' ? '/index.html' : p;
      const full = path.normalize(path.join(PUBLIC_DIR, file));
      if (!full.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
      if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        return json(res, 404, { error: 'Not found' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    } catch (err) {
      log.err(`${req.method} ${p} -> ${err.message}`);
      if (!res.headersSent) json(res, 400, { error: err.message });
      else res.destroy();
    }
  });

  // A raw network error must never kill the panel.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return { server, manager, auth };
}

/** Start the server; resolves with { server, manager, auth, url }. */
export async function startServer(opts = {}) {
  const host = opts.host || process.env.GW_HOST || '0.0.0.0';
  const port = Number(opts.port || process.env.GW_PORT || 8080);
  const { server, manager, auth } = createApp(opts);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  return { server, manager, auth, url, port, host };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  startServer().then(({ url }) => log.ok(`GhostWire panel: ${url}`));
}
