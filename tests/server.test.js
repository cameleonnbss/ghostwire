import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// Serveur en mode test : token fixe, dataDir temporaire.
process.env.GW_TOKEN = 'test-token-123';
process.env.GW_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));

const { createApp } = await import('../src/server.js');

/** Petit client HTTP de test. */
function req(port, method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { 'X-Ghostwire-Token': token } : {}),
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

describe('API GhostWire', () => {
  let server;
  let port;

  before(async () => {
    const app = createApp({ token: process.env.GW_TOKEN, dataDir: process.env.GW_DATA_DIR });
    server = app.server;
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(() => new Promise((r) => server.close(r)));

  it('GET /api/ping répond ok', async () => {
    const res = await req(port, 'GET', '/api/ping');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  it('GET /api/status sans token fonctionne (lecture seule)', async () => {
    const res = await req(port, 'GET', '/api/status');
    assert.equal(res.status, 200);
    assert.ok('status' in res.json);
    assert.ok('socksPort' in res.json);
  });

  it('POST /api/keys sans token → 401', async () => {
    const res = await req(port, 'POST', '/api/keys');
    assert.equal(res.status, 401);
  });

  it('POST /api/keys avec token → clés valides', async () => {
    const res = await req(port, 'POST', '/api/keys', { token: 'test-token-123' });
    assert.equal(res.status, 200);
    assert.equal(res.json.privateKey.length, 44);
    assert.equal(res.json.publicKey.length, 44);
    assert.equal(Buffer.from(res.json.presharedKey, 'base64').length, 32);
  });

  it('POST /api/conf/import + GET /api/conf/current (clé masquée)', async () => {
    const conf = '[Interface]\nPrivateKey = SECRET=\nAddress = 10.1.1.2/32\n\n[Peer]\nPublicKey = PUB=\nEndpoint = h:1\nAllowedIPs = 0.0.0.0/0\n';
    const imp = await req(port, 'POST', '/api/conf/import', { body: { conf }, token: 'test-token-123' });
    assert.equal(imp.status, 200);

    const cur = await req(port, 'GET', '/api/conf/current');
    assert.equal(cur.status, 200);
    assert.ok(cur.json.raw.includes('***'), 'la clé privée doit être masquée');
    assert.ok(!cur.json.raw.includes('SECRET='), 'la clé privée ne doit jamais fuir');
  });

  it('POST /api/conf/import avec config invalide → 400', async () => {
    const res = await req(port, 'POST', '/api/conf/import', {
      body: { conf: '[Peer]\nPublicKey = x\n' }, token: 'test-token-123',
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/conf/build génère une config', async () => {
    const res = await req(port, 'POST', '/api/conf/build', {
      body: { privateKey: 'P=', address: '10.0.0.9/32', peer: { publicKey: 'S=' } },
      token: 'test-token-123',
    });
    assert.equal(res.status, 200);
    assert.match(res.json.conf, /PrivateKey = P=/);
  });

  it('POST /api/start sans config → 400 avec message clair', async () => {
    const res = await req(port, 'POST', '/api/start', { token: 'test-token-123' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Config WireGuard introuvable|setup/);
  });

  it('les fichiers statiques sont servis', async () => {
    const res = await req(port, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<html/);
  });

  it('path traversal bloqué', async () => {
    const res = await req(port, 'GET', '/..%2f..%2fpackage.json');
    assert.ok([403, 404].includes(res.status));
  });
});
