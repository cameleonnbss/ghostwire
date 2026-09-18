import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Test server: temp data dir, empty accounts (open mode by default).
process.env.GW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));

const { createApp } = await import('../src/server.js');
const { AuthStore } = await import('../src/auth.js');

/** Minimal HTTP test client. */
function req(port, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, text: buf }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('GhostWire API', () => {
  let server;
  let port;
  let adminToken;

  before(async () => {
    // Create the admin account BEFORE createApp so the server sees it.
    const auth = new AuthStore(process.env.GW_DATA_DIR);
    auth.addUser('admin', 'adminpass1');
    const r = auth.login('admin', 'adminpass1');
    adminToken = r.token;

    const app = createApp({ dataDir: process.env.GW_DATA_DIR });
    server = app.server;
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    port = server.address().port;
  });

  after(() => new Promise((r) => server.close(r)));

  it('GET /api/ping répond ok', async () => {
    const res = await req(port, 'GET', '/api/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  it('GET /api/status without a session -> 401 (auth is enabled)', async () => {
    const res = await req(port, 'GET', '/api/status');
    assert.equal(res.status, 401);
  });

  it('POST /api/keys without a session -> 401 (auth enabled)', async () => {
    const res = await req(port, 'POST', '/api/keys');
    assert.equal(res.status, 401);
  });

  it('POST /api/keys with an admin session -> valid keys', async () => {
    const res = await req(port, 'POST', '/api/keys', { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.privateKey.length, 44);
    assert.equal(res.json.publicKey.length, 44);
    assert.equal(Buffer.from(res.json.presharedKey, 'base64').length, 32);
  });

  it('POST /api/conf/import then GET /api/conf/current masks the private key', async () => {
    const conf = '[Interface]\nPrivateKey = SECRET=\nAddress = 10.1.1.2/32\n\n[Peer]\nPublicKey = PUB=\nEndpoint = h:1\nAllowedIPs = 0.0.0.0/0\n';
    const imp = await req(port, 'POST', '/api/conf/import', { body: { conf }, token: adminToken });
    assert.equal(imp.status, 200);

    const cur = await req(port, 'GET', '/api/conf/current', { token: adminToken });
    assert.equal(cur.status, 200);
    assert.ok(cur.json.raw.includes('***'), 'the private key must be masked');
    assert.ok(!cur.json.raw.includes('SECRET='), 'the private key must never leak');
  });

  it('POST /api/conf/import with an invalid config -> 400', async () => {
    const res = await req(port, 'POST', '/api/conf/import', {
      body: { conf: '[Peer]\nPublicKey = x\n' }, token: adminToken,
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/conf/build generates a config', async () => {
    const res = await req(port, 'POST', '/api/conf/build', {
      body: { privateKey: 'P=', address: '10.0.0.9/32', peer: { publicKey: 'S=' } },
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.match(res.json.conf, /PrivateKey = P=/);
  });

  it('POST /api/start without a config -> 400 with a clear message', async () => {
    // Use a fresh data dir so no conf exists.
    const res = await req(port, 'POST', '/api/start', { token: adminToken });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /config not found|setup/i);
  });

  it('static files are served', async () => {
    const res = await req(port, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<html/);
  });

  it('path traversal is blocked', async () => {
    const res = await req(port, 'GET', '/..%2f..%2fpackage.json');
    assert.ok([403, 404].includes(res.status));
  });

  it('GET /api/auth/state reports authEnabled=true once users exist', async () => {
    const res = await req(port, 'GET', '/api/auth/state');
    assert.equal(res.status, 200);
    assert.equal(res.json.authEnabled, true);
  });

  it('login with wrong password -> 401; then correct -> token', async () => {
    const bad = await req(port, 'POST', '/api/auth/login', {
      body: { username: 'admin', password: 'nope' },
    });
    assert.equal(bad.status, 401);

    const good = await req(port, 'POST', '/api/auth/login', {
      body: { username: 'admin', password: 'adminpass1' },
    });
    assert.equal(good.status, 200);
    assert.ok(good.json.token);
    assert.equal(good.json.user.role, 'admin');
  });

  it('viewer role can read status but not start the tunnel', async () => {
    // Create a viewer directly in the store.
    const auth = new AuthStore(process.env.GW_DATA_DIR);
    auth.addUser('bob', 'bobpass12', 'viewer');
    const login = await req(port, 'POST', '/api/auth/login', {
      body: { username: 'bob', password: 'bobpass12' },
    });
    const t = login.json.token;

    const status = await req(port, 'GET', '/api/status', { token: t });
    assert.equal(status.status, 200);

    const start = await req(port, 'POST', '/api/start', { token: t });
    assert.equal(start.status, 403);

    const users = await req(port, 'GET', '/api/auth/users', { token: t });
    assert.equal(users.status, 403);
  });

  it('admin can create and list accounts via the API', async () => {
    const created = await req(port, 'POST', '/api/auth/users', {
      body: { username: 'carol', password: 'carolpass', role: 'viewer' },
      token: adminToken,
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.user.role, 'viewer');

    const list = await req(port, 'GET', '/api/auth/users', { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.json.users.some((u) => u.username === 'carol'));
    assert.ok(!list.json.users.some((u) => u.pass), 'password hashes must not leak');
  });
});
