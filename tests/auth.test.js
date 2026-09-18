import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-auth-'));
  return new AuthStore(dir);
}

describe('AuthStore', () => {
  it('starts in open mode with no users', () => {
    const a = tempStore();
    assert.equal(a.enabled, false);
  });

  it('first user becomes admin automatically', () => {
    const a = tempStore();
    const u = a.addUser('alice', 'secret1');
    assert.equal(u.role, 'admin');
    assert.equal(a.enabled, true);
  });

  it('second user defaults to admin but can be viewer', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    const bob = a.addUser('bob', 'secret2', 'viewer');
    assert.equal(bob.role, 'viewer');
    const carl = a.addUser('carl', 'secret3');
    assert.equal(carl.role, 'admin');
  });

  it('rejects invalid usernames, short passwords, duplicates', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    assert.throws(() => a.addUser('x', 'secret'), /2-32/);
    assert.throws(() => a.addUser('alice', 'abc'), /at least 4/);
    assert.throws(() => a.addUser('Alice', 'secret2'), /already exists/);
  });

  it('login succeeds and returns a valid session token', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    const r = a.login('alice', 'secret1');
    assert.equal(r.ok, true);
    assert.equal(a.verify(r.token).username, 'alice');
    assert.equal(a.verify(r.token).role, 'admin');
  });

  it('login is case-insensitive on the username', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    assert.equal(a.login('ALICE', 'secret1').ok, true);
  });

  it('wrong password fails and never returns a token', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    const r = a.login('alice', 'wrong');
    assert.equal(r.ok, false);
    assert.equal(r.token, undefined);
  });

  it('locks the account after too many failures', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    for (let i = 0; i < 10; i++) a.login('alice', 'wrong');
    const r = a.login('alice', 'secret1'); // even the correct password is refused
    assert.equal(r.ok, false);
    assert.ok(r.waitSec > 0);
  });

  it('logout invalidates the session', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    const r = a.login('alice', 'secret1');
    assert.equal(a.verify(r.token).username, 'alice');
    a.logout(r.token);
    assert.equal(a.verify(r.token), null);
  });

  it('password change invalidates existing sessions', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    const r = a.login('alice', 'secret1');
    a.changePassword('alice', 'newpass1');
    assert.equal(a.verify(r.token), null);
    assert.equal(a.login('alice', 'newpass1').ok, true);
  });

  it('cannot demote the last admin', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    assert.throws(() => a.setRole('alice', 'viewer'), /last admin/);
  });

  it('removeUser deletes the user and its sessions', () => {
    const a = tempStore();
    a.addUser('alice', 'secret1');
    a.removeUser('alice');
    assert.equal(a.enabled, false);
    assert.throws(() => a.removeUser('alice'), /Unknown user/);
  });
});
