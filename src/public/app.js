/* ── GhostWire UI — client logic ───────────────────────────────────────── */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  token: sessionStorage.getItem('gw_token') || null,
  user: null,
  authEnabled: false,
  timer: null,
};

/* ── Helpers ──────────────────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(path, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && path !== '/api/auth/login') {
    showLogin('Session expired — sign in again');
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(body && body.error ? body.error : `HTTP ${res.status}`);
  return body;
}

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtUptime(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

/* ── Views ────────────────────────────────────────────────────────────── */

function showLogin(message) {
  state.token = null;
  sessionStorage.removeItem('gw_token');
  clearInterval(state.timer);
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  const err = $('#login-error');
  if (message) { err.textContent = message; err.hidden = false; }
  else err.hidden = true;
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#user-badge').textContent = state.user ? state.user.username : '';
  $('#btn-users').hidden = !(state.user && state.user.role === 'admin');
  refresh();
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 3000);
}

async function boot() {
  try {
    const st = await fetch('/api/auth/state').then((r) => r.json());
    state.authEnabled = st.authEnabled;
    if (!st.authEnabled) {
      state.user = { username: 'anonymous', role: 'admin' };
      showApp();
      return;
    }
    if (state.token) {
      // Validate the stored token with a lightweight call.
      const me = await api('/api/me');
      state.user = me.user;
      showApp();
      return;
    }
    showLogin();
  } catch {
    showLogin('Panel unreachable — is the server running?');
  }
}

/* ── Login / logout ───────────────────────────────────────────────────── */

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  try {
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value }),
    });
    state.token = r.token;
    state.user = r.user;
    sessionStorage.setItem('gw_token', r.token);
    showApp();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  showLogin();
  $('#login-pass').value = '';
});

$('#btn-user').addEventListener('click', () => {
  $('#user-dropdown').hidden = !$('#user-dropdown').hidden;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.user-menu')) $('#user-dropdown').hidden = true;
});

/* ── Password change ──────────────────────────────────────────────────── */

$('#btn-passwd').addEventListener('click', () => {
  openModal('Change password', `
    <label class="modal-hint">New password (min 4 chars)
      <input id="pw-new" type="password" style="margin-top:0.35rem">
    </label>`, [
    { label: 'Cancel', class: 'btn', close: true },
    {
      label: 'Save', class: 'btn primary',
      onClick: async () => {
        const pw = $('#pw-new').value;
        await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ newPassword: pw }) });
        toast('Password changed');
        closeModal();
      },
    },
  ]);
});

/* ── Accounts admin ───────────────────────────────────────────────────── */

$('#btn-users').addEventListener('click', loadUsers);

async function loadUsers() {
  try {
    const r = await api('/api/auth/users');
    const list = $('#users-list');
    list.innerHTML = '';
    for (const u of r.users) {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.innerHTML = `
        <span class="name">${u.username}</span>
        <span class="role ${u.role}">${u.role}</span>
        <span class="meta">created ${new Date(u.createdAt).toLocaleDateString()}</span>
        <button class="btn mini danger" data-del="${u.username}">Remove</button>`;
      list.appendChild(row);
    }
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const name = b.dataset.del;
      if (name === state.user.username) return toast('You cannot remove your own account');
      confirmModal(`Remove account "${name}"?`, async () => {
        await api('/api/auth/users', { method: 'DELETE', body: JSON.stringify({ username: name }) });
        toast(`Account ${name} removed`);
        loadUsers();
      });
    }));
    $('#users-card').hidden = false;
    $('#users-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (ex) { toast(ex.message, 4200); }
}

$('#btn-add-user').addEventListener('click', () => {
  openModal('Add account', `
    <label class="modal-hint">Username
      <input id="nu-name" style="margin-top:0.35rem" placeholder="alice">
    </label>
    <label class="modal-hint">Password
      <input id="nu-pass" type="password" style="margin-top:0.35rem">
    </label>
    <label class="modal-hint">Role
      <select id="nu-role" style="margin-top:0.35rem;width:100%;background:rgba(0,0,0,.4);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:.45rem">
        <option value="admin">admin (full control)</option>
        <option value="viewer">viewer (read-only)</option>
      </select>
    </label>`, [
    { label: 'Cancel', class: 'btn', close: true },
    {
      label: 'Create', class: 'btn primary',
      onClick: async () => {
        await api('/api/auth/users', {
          method: 'POST',
          body: JSON.stringify({ username: $('#nu-name').value.trim(), password: $('#nu-pass').value, role: $('#nu-role').value }),
        });
        toast('Account created');
        closeModal();
        loadUsers();
      },
    },
  ]);
});

/* ── Status / polling ─────────────────────────────────────────────────── */

async function refresh() {
  try {
    const s = await api('/api/status');
    $('#status-text').textContent = {
      running: 'Tunnel active', starting: 'Starting…', error: 'Error',
      stopped: 'Tunnel stopped',
    }[s.status] || s.status;
    $('#pill').textContent = s.status.toUpperCase();
    $('#pill').className = `pill ${s.status}`;
    $('#orb').className = `orb ${s.status}`;
    $('#uptime').textContent = s.uptimeSec ? `up ${fmtUptime(s.uptimeSec)}` : '';
    $('#ip').textContent = s.publicIp || '—';
    $('#host-info').textContent = `${s.host.platform}/${s.host.arch}${s.host.isTermux ? ' · Termux' : ''}`;
    $('#conf-file').textContent = s.hasConf ? 'loaded' : 'none';
    $('#bin-status').textContent = s.hasBinary ? 'ready' : 'missing (run setup)';
    $('#socks-port').textContent = s.socksPort;
    $('#http-port').textContent = s.httpPort;
    const last = (s.logTail || []).slice(-8).join('\n');
    $('#logs').textContent = last || '— (start the tunnel to see logs)';
    $('#panel-uptime').textContent = `panel up ${fmtUptime(s.panelUptimeSec)}`;
    $('#btn-start').disabled = s.status === 'running' || s.status === 'starting';
    $('#btn-stop').disabled = s.status !== 'running' && s.status !== 'starting';
  } catch (err) {
    if (err.message !== 'Unauthorized') {
      $('#status-text').textContent = 'API unreachable';
      $('#orb').className = 'orb error';
    }
  }
}

async function tunnelAction(path, okMsg) {
  try {
    await api(path, { method: 'POST' });
    toast(okMsg);
  } catch (err) {
    toast(`Failed: ${err.message}`, 4200);
  }
  refresh();
}

/* ── Tools ────────────────────────────────────────────────────────────── */

function showToolOutput() {
  const el = $('#tool-output');
  el.hidden = false;
  el.textContent = '…';
  return el;
}

$('#btn-speed').addEventListener('click', async () => {
  const el = showToolOutput();
  try {
    const r = await api('/api/speedtest', { method: 'POST' });
    el.textContent = `Download speed: ${r.mbps} Mbit/s\n(${(r.bytes / 1e6).toFixed(1)} MB in ${r.seconds}s)`;
  } catch (err) { el.textContent = `Failed: ${err.message}`; }
});

$('#btn-latency').addEventListener('click', async () => {
  const el = showToolOutput();
  try {
    const r = await api('/api/latency', { method: 'POST', body: JSON.stringify({ host: '1.1.1.1', port: 443 }) });
    el.textContent = r.ms >= 0 ? `Latency 1.1.1.1:443 -> ${r.ms} ms` : 'Host unreachable';
  } catch (err) { el.textContent = `Failed: ${err.message}`; }
});

$('#btn-qr').addEventListener('click', async () => {
  try {
    const svg = await api('/api/qr');
    openModal('Scan with the WireGuard app', svg, [{ label: 'Close', class: 'btn', close: true }]);
  } catch (err) { toast(`Failed: ${err.message}`, 4200); }
});

/* ── Config tabs ──────────────────────────────────────────────────────── */

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  switchTab(t.dataset.tab);
  if (t.dataset.tab === 'current') loadCurrentConf();
}));

$('#btn-import').addEventListener('click', async () => {
  const conf = $('#conf-input').value.trim();
  if (!conf) return toast('Paste a config first');
  try {
    await api('/api/conf/import', { method: 'POST', body: JSON.stringify({ conf }) });
    toast('Config saved');
    refresh();
  } catch (err) { toast(`Failed: ${err.message}`, 4200); }
});

$('#btn-genkey').addEventListener('click', async () => {
  try {
    const kp = await api('/api/keys', { method: 'POST' });
    const endpoint = $('#gen-endpoint').value.trim() || 'vpn.example.com:51820';
    const address = $('#gen-address').value.trim() || '10.66.66.2/32';
    const allowed = $('#gen-allowed').value.trim() || '0.0.0.0/0';
    const { conf } = await api('/api/conf/build', {
      method: 'POST',
      body: JSON.stringify({
        privateKey: kp.privateKey, address,
        peer: { publicKey: 'PASTE_SERVER_PUBLIC_KEY_HERE', endpoint, allowedIPs: allowed, keepalive: 25 },
      }),
    });
    $('#conf-input').value = conf;
    switchTab('import');
    toast('Keys generated — paste the server public key, then save');
    console.log('PresharedKey:', kp.presharedKey);
  } catch (err) { toast(`Failed: ${err.message}`, 4200); }
});

async function loadCurrentConf() {
  const el = $('#conf-current');
  try {
    const r = await api('/api/conf/current');
    el.textContent = r.raw;
  } catch (err) { el.textContent = err.message; }
}

$('#btn-refresh-conf').addEventListener('click', loadCurrentConf);

$('#conf-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) $('#conf-input').value = await file.text();
});

$$('[data-copy]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.copyPort;
  const port = key === 'socks' ? $('#socks-port').textContent : $('#http-port').textContent;
  navigator.clipboard.writeText(`127.0.0.1:${port}`).then(() => toast('Copied'));
}));

$('#btn-start').addEventListener('click', () => tunnelAction('/api/start', 'Starting…'));
$('#btn-stop').addEventListener('click', () => tunnelAction('/api/stop', 'Tunnel stopped'));
$('#btn-restart').addEventListener('click', () => tunnelAction('/api/restart', 'Restarting…'));

/* ── Modal helpers ────────────────────────────────────────────────────── */

function openModal(title, bodyHtml, actions = []) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  const wrap = $('#modal-actions');
  wrap.innerHTML = '';
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.className = a.class || 'btn';
    btn.textContent = a.label;
    btn.addEventListener('click', async () => {
      try {
        if (a.onClick) await a.onClick();
        else if (a.close) closeModal();
      } catch (err) { toast(`Failed: ${err.message}`, 4200); }
    });
    wrap.appendChild(btn);
  }
  $('#modal').hidden = false;
}

function closeModal() { $('#modal').hidden = true; }

function confirmModal(message, onYes) {
  openModal('Confirm', `<p class="modal-hint">${message}</p>`, [
    { label: 'Cancel', class: 'btn', close: true },
    { label: 'Yes, do it', class: 'btn danger', onClick: onYes },
  ]);
}

$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ── Boot ─────────────────────────────────────────────────────────────── */

boot();
