/* ── GhostWire UI — logique client ─────────────────────────────────────── */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  status: 'unknown',
  timer: null,
};

/* ── Helpers ──────────────────────────────────────────────────────────── */

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('gw_token');
  if (token) headers['X-Ghostwire-Token'] = token;
  const res = await fetch(path, { ...opts, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
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

/* ── Statut / polling ─────────────────────────────────────────────────── */

async function refresh() {
  try {
    const s = await api('/api/status');
    state.status = s.status;
    $('#status-text').textContent = {
      running: 'Tunnel actif', starting: 'Démarrage…', error: 'Erreur',
      stopped: 'Tunnel arrêté', unknown: 'Inconnu',
    }[s.status] || s.status;
    $('#pill').textContent = s.status.toUpperCase();
    $('#pill').className = `pill ${s.status}`;
    $('#orb').className = `orb ${s.status}`;
    $('#uptime').textContent = s.uptimeSec ? `en ligne depuis ${fmtUptime(s.uptimeSec)}` : '';
    $('#ip').textContent = s.publicIp || '—';
    $('#host-info').textContent = `${s.host.platform}/${s.host.arch}${s.host.isTermux ? ' · Termux' : ''}`;
    $('#conf-file').textContent = s.hasConf ? 'chargée ✓' : 'aucune';
    $('#bin-status').textContent = s.hasBinary ? 'prêt ✓' : 'absent (setup requis)';
    $('#proxy-socks code b').textContent = s.socksPort;
    $('#proxy-http code b').textContent = s.httpPort;
    const last = (s.logTail || []).slice(-8).join('\n');
    $('#logs').textContent = last || '— (démarrez le tunnel pour voir les logs)';
    $('#panel-uptime').textContent = `panneau en ligne depuis ${fmtUptime(s.panelUptimeSec)}`;
    $('#btn-start').disabled = s.status === 'running' || s.status === 'starting';
    $('#btn-stop').disabled = s.status !== 'running' && s.status !== 'starting';
  } catch (err) {
    $('#status-text').textContent = 'API injoignable';
    $('#orb').className = 'orb error';
  }
}

/* ── Actions tunnel ───────────────────────────────────────────────────── */

async function tunnelAction(path, okMsg) {
  try {
    await api(path, { method: 'POST' });
    toast(okMsg);
  } catch (err) {
    toast(`✖ ${err.message}`, 4200);
  }
  refresh();
}

/* ── Outils ───────────────────────────────────────────────────────────── */

function showToolOutput() {
  const el = $('#tool-output');
  el.hidden = false;
  el.textContent = '…';
  return el;
}

async function speedtest() {
  const el = showToolOutput();
  try {
    const r = await api('/api/speedtest', { method: 'POST' });
    el.textContent = `Débit descendant : ${r.mbps} Mb/s\n(${(r.bytes / 1e6).toFixed(1)} Mo en ${r.seconds}s)`;
  } catch (err) { el.textContent = `✖ ${err.message}`; }
}

async function latency() {
  const el = showToolOutput();
  try {
    const r = await api('/api/latency', {
      method: 'POST', body: JSON.stringify({ host: '1.1.1.1', port: 443 }),
    });
    el.textContent = r.ms >= 0 ? `Latence 1.1.1.1:443 → ${r.ms} ms` : '✖ Hôte injoignable';
  } catch (err) { el.textContent = `✖ ${err.message}`; }
}

async function showQr() {
  try {
    const svg = await api('/api/qr');
    $('#modal-title').textContent = 'Scanner avec l\u2019app WireGuard';
    $('#modal-body').innerHTML = svg;
    $('#modal').hidden = false;
  } catch (err) { toast(`✖ ${err.message}`, 4200); }
}

/* ── Onglets config ───────────────────────────────────────────────────── */

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

async function importConf() {
  const conf = $('#conf-input').value.trim();
  if (!conf) return toast('Collez d\u2019abord une config');
  try {
    await api('/api/conf/import', { method: 'POST', body: JSON.stringify({ conf }) });
    toast('✔ Config enregistrée');
    refresh();
  } catch (err) { toast(`✖ ${err.message}`, 4200); }
}

async function generateConfig() {
  try {
    const kp = await api('/api/keys', { method: 'POST' });
    const endpoint = $('#gen-endpoint').value.trim() || 'vpn.exemple.com:51820';
    const address = $('#gen-address').value.trim() || '10.66.66.2/32';
    const allowed = $('#gen-allowed').value.trim() || '0.0.0.0/0';
    const { conf } = await api('/api/conf/build', {
      method: 'POST',
      body: JSON.stringify({
        privateKey: kp.privateKey, address,
        peer: { publicKey: 'COLLEZ_ICI_LA_PUBKEY_DU_SERVEUR', endpoint, allowedIPs: allowed, keepalive: 25 },
      }),
    });
    $('#conf-input').value = conf;
    switchTab('import');
    toast('✔ Clés générées — collez la PublicKey du serveur puis enregistrez');
    console.log('PresharedKey :', kp.presharedKey);
  } catch (err) { toast(`✖ ${err.message}`, 4200); }
}

async function loadCurrentConf() {
  const el = $('#conf-current');
  try {
    const r = await api('/api/conf/current');
    el.textContent = r.raw;
  } catch (err) { el.textContent = err.message; }
}

/* ── Branchements ─────────────────────────────────────────────────────── */

$('#btn-start').addEventListener('click', () => tunnelAction('/api/start', 'Démarrage…'));
$('#btn-stop').addEventListener('click', () => tunnelAction('/api/stop', 'Tunnel arrêté'));
$('#btn-restart').addEventListener('click', () => tunnelAction('/api/restart', 'Redémarrage…'));
$('#btn-speed').addEventListener('click', speedtest);
$('#btn-latency').addEventListener('click', latency);
$('#btn-qr').addEventListener('click', showQr);
$('#btn-import').addEventListener('click', importConf);
$('#btn-genkey').addEventListener('click', generateConfig);
$('#btn-refresh-conf').addEventListener('click', loadCurrentConf);

$('#conf-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) $('#conf-input').value = await file.text();
});

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  switchTab(t.dataset.tab);
  if (t.dataset.tab === 'current') loadCurrentConf();
}));

$$('[data-copy]').forEach((b) => b.addEventListener('click', () => {
  navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copié ✓'));
}));

$('#btn-settings').addEventListener('click', () => {
  const cur = localStorage.getItem('gw_token') || '';
  const t = prompt('Token admin (laisser vide si aucun) :', cur);
  if (t !== null) {
    localStorage.setItem('gw_token', t);
    toast('Token enregistré — reconnecté');
    refresh();
  }
});

$('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });

/* ── Démarrage ────────────────────────────────────────────────────────── */

refresh();
state.timer = setInterval(refresh, 3000);
