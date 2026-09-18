import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateKeyPair,
  publicKeyFromPrivate,
  generatePresharedKey,
  parseWgConf,
  buildWgConf,
} from '../src/engine.js';

describe('clés WireGuard', () => {
  it('génère un pair de clés base64 de 44 caractères', () => {
    const kp = generateKeyPair();
    assert.equal(kp.privateKey.length, 44);
    assert.equal(kp.publicKey.length, 44);
    assert.match(kp.privateKey, /^[A-Za-z0-9+/]+={0,2}$/);
    assert.match(kp.publicKey, /^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('génère des clés différentes à chaque appel', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    assert.notEqual(a.privateKey, b.privateKey);
  });

  it('dérive la clé publique cohérente d\'une clé privée', () => {
    // Vecteur : clé privée hexadécimale 32 octets → base64 format wg
    const privHex = '98f7f2842741084c4d3b85b7bb2d4f26fa0a1880f6109770a6e93fd0a38d0c4d';
    const privB64 = Buffer.from(privHex, 'hex').toString('base64');
    const pub = publicKeyFromPrivate(privB64);
    assert.equal(pub.length, 44);
    assert.match(pub, /^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('cohérence generateKeyPair ↔ publicKeyFromPrivate', () => {
    const kp = generateKeyPair();
    assert.equal(publicKeyFromPrivate(kp.privateKey), kp.publicKey);
  });

  it('accepte le padding base64 avec ou sans "="', () => {
    const kp = generateKeyPair();
    const stripped = kp.privateKey.replace(/=+$/, '');
    const pub1 = publicKeyFromPrivate(kp.privateKey);
    const pub2 = publicKeyFromPrivate(stripped);
    assert.equal(pub1, pub2);
  });

  it('rejette une clé privée de mauvaise taille', () => {
    assert.throws(() => publicKeyFromPrivate('aGVsbG8='), /32 octets/);
  });

  it('génère une PSK de 32 octets', () => {
    const psk = generatePresharedKey();
    assert.equal(Buffer.from(psk, 'base64').length, 32);
  });
});

describe('parsing .conf WireGuard', () => {
  const sample = `[Interface]
PrivateKey = ABCdef123=
Address = 10.66.66.2/32
DNS = 1.1.1.1
MTU = 1420

# un commentaire
[Peer]
PublicKey = XYZ987=
PresharedKey = pskpskpsk=
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
`;

  it('parse les sections Interface et Peer', () => {
    const c = parseWgConf(sample);
    assert.equal(c.interface.privatekey, 'ABCdef123=');
    assert.equal(c.interface.address, '10.66.66.2/32');
    assert.equal(c.interface.dns, '1.1.1.1');
    assert.equal(c.interface.mtu, '1420');
    assert.equal(c.peers.length, 1);
    assert.equal(c.peers[0].publickey, 'XYZ987=');
    assert.equal(c.peers[0].endpoint, 'vpn.example.com:51820');
    assert.equal(c.peers[0].persistentkeepalive, '25');
  });

  it('ignore les commentaires et lignes vides', () => {
    const c = parseWgConf('# rien\n\n[Interface]\nPrivateKey = k\n');
    assert.deepEqual(c.peers, []);
    assert.equal(c.interface.privatekey, 'k');
  });

  it('gère les retours à la ligne Windows', () => {
    const c = parseWgConf('[Interface]\r\nPrivateKey = k\r\n\r\n[Peer]\r\nPublicKey = p\r\n');
    assert.equal(c.interface.privatekey, 'k');
    assert.equal(c.peers[0].publickey, 'p');
  });

  it('ne confond pas les clés de même nom entre sections', () => {
    const c = parseWgConf('[Interface]\nPrivateKey = priv\n[Peer]\nPublicKey = pub\n');
    assert.equal(c.interface.privatekey, 'priv');
    assert.equal(c.peers[0].publickey, 'pub');
  });
});

describe('génération .conf WireGuard', () => {
  it('produit une config complète avec PSK et keepalive', () => {
    const conf = buildWgConf({
      privateKey: 'PRIV=',
      address: '10.0.0.2/32',
      peer: { publicKey: 'PUB=', presharedKey: 'PSK=', endpoint: 'h:1', allowedIPs: '0.0.0.0/0', keepalive: 25 },
    });
    assert.match(conf, /^\[Interface\]/m);
    assert.match(conf, /PrivateKey = PRIV=/);
    assert.match(conf, /Address = 10\.0\.0\.2\/32/);
    assert.match(conf, /PresharedKey = PSK=/);
    assert.match(conf, /PersistentKeepalive = 25/);
    assert.ok(conf.endsWith('\n'));
  });

  it('omet les champs optionnels absents', () => {
    const conf = buildWgConf({
      privateKey: 'P=', address: '10.0.0.2/32', dns: '',
      peer: { publicKey: 'S=' },
    });
    assert.ok(!conf.includes('DNS'));
    assert.ok(!conf.includes('PresharedKey'));
    assert.ok(!conf.includes('PersistentKeepalive'));
    assert.match(conf, /AllowedIPs = 0\.0\.0\.0\/0/); // valeur par défaut
  });

  it('roundtrip : build → parse retrouve les valeurs', () => {
    const conf = buildWgConf({
      privateKey: 'PRIVKEY=', address: '10.9.0.2/24', mtu: 1380,
      peer: { publicKey: 'PUBKEY=', endpoint: 'e:2', allowedIPs: '0.0.0.0/0' },
    });
    const c = parseWgConf(conf);
    assert.equal(c.interface.privatekey, 'PRIVKEY=');
    assert.equal(c.interface.address, '10.9.0.2/24');
    assert.equal(c.interface.mtu, '1380');
    assert.equal(c.peers[0].endpoint, 'e:2');
  });
});
