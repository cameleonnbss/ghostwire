/**
 * GhostWire — accounts & sessions.
 * Local user store (scrypt password hashes) + bearer-token sessions.
 * Dependency-free on purpose: a single JSON file under the data dir.
 *
 * Default state: no users -> the panel runs in open mode (local/LAN use).
 * Create the first admin with:  ghostwire useradd admin <password>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileSafe } from './util.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_SESSIONS_PER_USER = 10;
const MAX_FAILED_LOGINS = 10; // per window
const LOCKOUT_WINDOW_MS = 1000 * 60 * 10; // 10 minutes

export class AuthStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this._mtime = { users: 0, sessions: 0 };
    this.reload();
  }

  /** Re-read the JSON files when they changed on disk (external edits, CLI). */
  maybeReload() {
    try {
      const u = fs.statSync(this.file).mtimeMs;
      const s = fs.existsSync(this.sessionsFile) ? fs.statSync(this.sessionsFile).mtimeMs : 0;
      if (u !== this._mtime.users || s !== this._mtime.sessions) this.reload();
    } catch { /* keep in-memory state */ }
  }

  reload() {
    try {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._mtime.users = fs.existsSync(this.file) ? fs.statSync(this.file).mtimeMs : 0;
    } catch {
      this.db = { users: [] };
    }
    try {
      this.sessions = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      this._mtime.sessions = fs.existsSync(this.sessionsFile) ? fs.statSync(this.sessionsFile).mtimeMs : 0;
    } catch {
      this.sessions = {};
    }
    this._lockouts = new Map(); // username -> { count, firstAt }
  }

  _save() {
    writeFileSafe(this.file, JSON.stringify(this.db, null, 2));
  }

  _saveSessions() {
    writeFileSafe(this.sessionsFile, JSON.stringify(this.sessions, null, 2));
  }

  get enabled() {
    this.maybeReload();
    return this.db.users.length > 0;
  }

  /** Hash a password with scrypt (salt embedded, constant-time compare). */
  static hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  static verifyPassword(password, stored) {
    const [scheme, saltHex, hashHex] = String(stored).split(':');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  }

  /**
   * Create a user. The first one becomes admin automatically.
   * Roles: "admin" (full control) or "viewer" (read-only status).
   */
  addUser(username, password, role = 'admin') {
    username = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
      throw new Error('Username must be 2-32 chars: letters, digits, _ . -');
    }
    if (String(password || '').length < 4) {
      throw new Error('Password must be at least 4 characters');
    }
    if (this.db.users.some((u) => u.username === username)) {
      throw new Error(`User "${username}" already exists`);
    }
    if (!this.db.users.length) role = 'admin'; // first user is always admin
    const user = {
      username,
      pass: AuthStore.hashPassword(String(password)),
      role: role === 'viewer' ? 'viewer' : 'admin',
      createdAt: new Date().toISOString(),
    };
    this.db.users.push(user);
    this._save();
    return { username: user.username, role: user.role };
  }

  removeUser(username) {
    const before = this.db.users.length;
    this.db.users = this.db.users.filter((u) => u.username !== String(username).toLowerCase());
    if (this.db.users.length === before) throw new Error(`Unknown user "${username}"`);
    delete this.sessions[String(username).toLowerCase()];
    this._save();
    this._saveSessions();
  }

  listUsers() {
    return this.db.users.map(({ username, role, createdAt }) => ({ username, role, createdAt }));
  }

  setRole(username, role) {
    const u = this.db.users.find((x) => x.username === String(username).toLowerCase());
    if (!u) throw new Error(`Unknown user "${username}"`);
    if (u.role === 'admin' && role !== 'admin' && this.db.users.filter((x) => x.role === 'admin').length <= 1) {
      throw new Error('Cannot demote the last admin');
    }
    u.role = role === 'viewer' ? 'viewer' : 'admin';
    this._save();
  }

  changePassword(username, newPassword) {
    const u = this.db.users.find((x) => x.username === String(username).toLowerCase());
    if (!u) throw new Error(`Unknown user "${username}"`);
    if (String(newPassword || '').length < 4) throw new Error('Password must be at least 4 characters');
    u.pass = AuthStore.hashPassword(String(newPassword));
    this._save();
    for (const [t, s] of Object.entries(this.sessions)) {
      if (s.username === u.username) delete this.sessions[t];
    }
    this._saveSessions();
  }

  /**
   * Authenticate. Returns { ok: true, user } or { ok: false, waitSec }.
   * Applies a sliding-window lockout after too many failures.
   */
  login(username, password) {
    username = String(username || '').trim().toLowerCase();
    const rec = this._lockouts.get(username);
    if (rec && Date.now() - rec.firstAt < LOCKOUT_WINDOW_MS && rec.count >= MAX_FAILED_LOGINS) {
      const waitSec = Math.ceil((LOCKOUT_WINDOW_MS - (Date.now() - rec.firstAt)) / 1000);
      return { ok: false, waitSec };
    }

    const user = this.db.users.find((u) => u.username === username);
    const valid = user && AuthStore.verifyPassword(String(password || ''), user.pass);

    if (valid) {
      this._lockouts.delete(username);
      const token = crypto.randomBytes(32).toString('hex');
      this.sessions[token] = {
        username: user.username,
        role: user.role,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS,
      };
      this._pruneSessions(user.username);
      this._saveSessions();
      return { ok: true, user: { username: user.username, role: user.role }, token, expiresAt: this.sessions[token].expiresAt };
    }

    const cur = (rec && Date.now() - rec.firstAt < LOCKOUT_WINDOW_MS) ? rec : { count: 0, firstAt: Date.now() };
    cur.count++;
    this._lockouts.set(username, cur);
    return { ok: false };
  }

  /** Validate a bearer token. Returns session or null. */
  verify(token) {
    this.maybeReload();
    if (!token) return null;
    const s = this.sessions[String(token)];
    if (!s) return null;
    if (Date.now() > s.expiresAt) {
      delete this.sessions[String(token)];
      this._saveSessions();
      return null;
    }
    return s;
  }

  logout(token) {
    if (token && this.sessions[token]) {
      const { username } = this.sessions[token];
      delete this.sessions[token];
      this._saveSessions();
      return username;
    }
    return null;
  }

  _pruneSessions(username) {
    const list = Object.entries(this.sessions)
      .filter(([, s]) => s.username === username)
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [t] of list.slice(MAX_SESSIONS_PER_USER)) delete this.sessions[t];
  }
}

/** Extract a bearer token from request headers or cookie. */
export function tokenFromRequest(req) {
  const h = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)gw_session=([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}
