import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TunnelManager, parseWgConf } from '../src/engine.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gw-mgr-'));
}

function writeConf(dir) {
  const conf = [
    '[Interface]',
    'PrivateKey = AAA=',
    'Address = 10.0.0.2/32',
    'DNS = 1.1.1.1',
    'MTU = 1420',
    '',
    '[Peer]',
    'PublicKey = BBB=',
    'Endpoint = 127.0.0.1:51820',
    'AllowedIPs = 0.0.0.0/0',
    'PersistentKeepalive = 25',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'tunnel0.conf'), conf);
  return conf;
}

describe('TunnelManager', () => {
  it('buildProxyConf garde les lignes wg utiles et ajoute les proxys', () => {
    const dir = tempDir();
    writeConf(dir);
    const m = new TunnelManager({ dataDir: dir, socksPort: 1111, httpPort: 2222 });
    // Binaire absent : on simule sa présence pour passer la validation de start()
    const generated = m.buildProxyConf();
    const out = fs.readFileSync(generated, 'utf8');

    assert.match(out, /PrivateKey = AAA=/);
    assert.match(out, /\[Peer\]/);
    assert.match(out, /\[Socks5\]/);
    assert.match(out, /BindAddress = 127\.0\.0\.1:1111/);
    assert.match(out, /\[HTTP\]/);
    assert.match(out, /BindAddress = 127\.0\.0\.1:2222/);
    // Les clés de section doivent être présentes pour wireproxy
    assert.match(out, /\[Interface\]/);
  });

  it('start() échoue proprement sans config', async () => {
    const dir = tempDir();
    const m = new TunnelManager({ dataDir: dir });
    await assert.rejects(() => m.start(), /Config WireGuard introuvable/);
    assert.equal(m.status, 'error');
  });

  it('start() échoue proprement sans binaire', async () => {
    const dir = tempDir();
    writeConf(dir);
    const m = new TunnelManager({ dataDir: dir, wireproxy: path.join(dir, 'nexistepas') });
    await assert.rejects(() => m.start(), /setup/);
  });

  it('statusSummary expose un état cohérent', () => {
    const dir = tempDir();
    writeConf(dir);
    const m = new TunnelManager({ dataDir: dir });
    const s = m.statusSummary();
    assert.equal(s.status, 'stopped');
    assert.equal(s.hasConf, true);
    assert.equal(s.hasBinary, false);
    assert.equal(s.socksPort, 1080);
    assert.equal(s.httpPort, 8888);
  });

  it('stop() sur un tunnel arrêté ne lève pas', () => {
    const m = new TunnelManager({ dataDir: tempDir() });
    assert.doesNotThrow(() => m.stop());
  });

  it('parseWgConf est exporté et fonctionnel', () => {
    const c = parseWgConf('[Interface]\nPrivateKey = k\n');
    assert.equal(c.interface.privatekey, 'k');
  });
});
