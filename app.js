/* ═══════════════════════════════════════════════════════════════
   WiFi Monitor — app.js (v2 — Bridge Mode)
   Semua request ke bridge lokal (localhost:3000),
   bukan langsung ke router. Bridge yang handle SSH.
   ═══════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  bridgeUrl:    'http://localhost:3000',
  routerIp:     '',
  searchQuery:  '',
  activeTab:    'devices',
  devices:      [],
  banned:       [],
  countdown:    10,
  countdownMax: 10,
  countdownTmr: null,
  isRefreshing: false,
};

const $  = (id) => document.getElementById(id);
const mk = (tag, cls, html = '') => {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

// ─── API helpers ──────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${State.bridgeUrl}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── LocalStorage ─────────────────────────────────────────────────────────────
function saveConfig() {
  localStorage.setItem('wm_cfg', JSON.stringify({
    bridgeUrl: State.bridgeUrl,
    routerIp:  State.routerIp,
  }));
}
function loadConfig() {
  try {
    const c = JSON.parse(localStorage.getItem('wm_cfg') || '{}');
    if (c.bridgeUrl) { State.bridgeUrl = c.bridgeUrl; $('bridge-url').value = c.bridgeUrl; }
    if (c.routerIp)  { State.routerIp  = c.routerIp;  $('router-ip').value  = c.routerIp; }
  } catch(_){}
}
function loadSavedCreds() {
  try {
    const c = JSON.parse(localStorage.getItem('wm_creds') || '{}');
    if (c.bridge) $('bridge-url').value   = c.bridge;
    if (c.host)   $('router-ip').value    = c.host;
    if (c.user)   $('router-user').value  = c.user;
    if (c.bridge || c.host) $('save-creds').checked = true;
  } catch(_){}
}

// ─── Connect / Setup ──────────────────────────────────────────────────────────
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const bridge   = $('bridge-url').value.trim().replace(/\/$/, '');
  const host     = $('router-ip').value.trim();
  const username = $('router-user').value.trim() || 'root';
  const password = $('router-pass').value;
  const save     = $('save-creds').checked;

  const errEl = $('connect-error');
  errEl.classList.add('hidden');

  const btn = $('connect-btn');
  btn.querySelector('.btn-text').textContent = 'Menghubungkan...';
  btn.querySelector('.spinner').classList.remove('hidden');
  btn.disabled = true;

  try {
    State.bridgeUrl = bridge;

    // Test bridge reachability first
    try {
      await fetch(`${bridge}/api/config`);
    } catch(_) {
      throw new Error('Bridge tidak bisa dijangkau. Pastikan start.bat sudah dijalankan di PC kamu!');
    }

    // Send SSH config to bridge
    const result = await api('POST', '/api/config', { host, username, password });
    if (!result.success) throw new Error(result.error || 'Koneksi gagal');

    State.routerIp = host;
    $('router-addr-display').textContent = host;
    setStatus('online');

    if (save) {
      localStorage.setItem('wm_creds', JSON.stringify({ bridge, host, user: username }));
    }

    // Load initial banned list from bridge
    const bannedData = await api('GET', '/api/banned');
    State.banned = bannedData.banned || [];

    $('setup-overlay').classList.remove('active');
    $('main-app').classList.remove('hidden');

    await fetchDevices();
    startCountdown();
    showToast('✅ Berhasil terhubung ke router!', 'success');
  } catch (err) {
    errEl.textContent = '❌ ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.querySelector('.btn-text').textContent = 'Hubungkan';
    btn.querySelector('.spinner').classList.add('hidden');
    btn.disabled = false;
  }
});

// ─── Fetch devices ────────────────────────────────────────────────────────────
async function fetchDevices() {
  if (State.isRefreshing) return;
  State.isRefreshing = true;
  $('refresh-btn').classList.add('spinning');

  try {
    const [devData, banData] = await Promise.all([
      api('GET', '/api/devices'),
      api('GET', '/api/banned'),
    ]);

    State.devices = devData.devices || [];
    State.banned  = banData.banned  || [];

    updateStats();
    renderDevices();
    renderBanned();
    $('stat-refreshed').textContent = new Date().toLocaleTimeString('id-ID');
  } catch (err) {
    showToast('Refresh gagal: ' + err.message, 'error');
    setStatus('offline');
  } finally {
    State.isRefreshing = false;
    $('refresh-btn').classList.remove('spinning');
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const bannedMacs = State.banned.map(b => b.mac);
  const active = State.devices.filter(d => !bannedMacs.includes(d.mac)).length;
  $('stat-total').textContent    = State.devices.length;
  $('stat-active').textContent   = active;
  $('stat-banned').textContent   = State.banned.length;
  $('count-devices').textContent = active;
  $('count-banned').textContent  = State.banned.length;
}

// ─── Render devices ───────────────────────────────────────────────────────────
function renderDevices() {
  const bannedMacs = State.banned.map(b => b.mac);
  let list = State.devices;
  if (State.searchQuery) {
    const q = State.searchQuery.toLowerCase();
    list = list.filter(d =>
      (d.ip       || '').toLowerCase().includes(q) ||
      (d.mac      || '').toLowerCase().includes(q) ||
      (d.hostname || '').toLowerCase().includes(q)
    );
  }

  const tbody = $('devices-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell"><div class="empty-state"><span class="empty-ico">${State.searchQuery ? '🔍' : '📡'}</span><span>${State.searchQuery ? 'Tidak ada hasil' : 'Tidak ada perangkat ditemukan'}</span></div></td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  for (const dev of list) {
    const isBanned = bannedMacs.includes(dev.mac);
    const icon  = deviceIcon(dev.hostname);
    const name  = dev.hostname || 'Unknown';
    const srcCls = dev.source === 'dhcp+arp' ? 'combined' : (dev.source || 'arp');
    const srcTxt = dev.source === 'dhcp+arp' ? 'DHCP+ARP' : (dev.source || 'ARP').toUpperCase();

    const tr = mk('tr');
    tr.innerHTML = `
      <td><div class="device-cell">
        <div class="device-avatar">${icon}</div>
        <div><div class="device-name">${esc(name)}</div></div>
      </div></td>
      <td><span class="mono">${esc(dev.ip || '—')}</span></td>
      <td><span class="mono">${esc(dev.mac || '—')}</span></td>
      <td><span class="source-badge ${srcCls}">${srcTxt}</span></td>
      <td><span class="status-cell ${isBanned ? 'banned' : 'online'}"><span class="dot"></span>${isBanned ? 'Banned' : 'Online'}</span></td>
      <td><div class="action-cell">
        ${!isBanned
          ? `<button class="btn btn-kick" data-action="kick" data-mac="${esc(dev.mac)}" data-ip="${esc(dev.ip||'')}" data-name="${esc(name)}">⚡ Kick</button>
             <button class="btn btn-ban"  data-action="ban"  data-mac="${esc(dev.mac)}" data-ip="${esc(dev.ip||'')}" data-name="${esc(name)}">🚫 Ban</button>`
          : `<button class="btn btn-unban" data-action="unban" data-mac="${esc(dev.mac)}" data-name="${esc(name)}">✅ Unban</button>`
        }
      </div></td>`;
    tbody.appendChild(tr);
  }
}

// ─── Render banned ────────────────────────────────────────────────────────────
function renderBanned() {
  let list = State.banned;
  if (State.searchQuery && State.activeTab === 'banned') {
    const q = State.searchQuery.toLowerCase();
    list = list.filter(b =>
      (b.ip       || '').toLowerCase().includes(q) ||
      (b.mac      || '').toLowerCase().includes(q) ||
      (b.hostname || '').toLowerCase().includes(q)
    );
  }

  const tbody = $('banned-tbody');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-cell"><div class="empty-state"><span class="empty-ico">✅</span><span>Tidak ada perangkat yang di-ban</span></div></td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  for (const b of list) {
    const icon = deviceIcon(b.hostname);
    const time = b.bannedAt ? new Date(b.bannedAt).toLocaleString('id-ID') : '—';
    const tr = mk('tr');
    tr.innerHTML = `
      <td><div class="device-cell">
        <div class="device-avatar">${icon}</div>
        <div><div class="device-name">${esc(b.hostname || 'Unknown')}</div></div>
      </div></td>
      <td><span class="mono">${esc(b.ip || '—')}</span></td>
      <td><span class="mono">${esc(b.mac || '—')}</span></td>
      <td style="font-size:.8rem;color:var(--text-3)">${esc(time)}</td>
      <td><button class="btn btn-unban" data-action="unban" data-mac="${esc(b.mac)}" data-name="${esc(b.hostname||'Unknown')}">✅ Unban</button></td>`;
    tbody.appendChild(tr);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function doKick(mac, ip, name) {
  try {
    await api('POST', '/api/kick', { mac, ip });
    showToast(`⚡ ${name} berhasil di-kick`, 'success');
    setTimeout(fetchDevices, 1500);
  } catch (err) {
    showToast('Kick gagal: ' + err.message, 'error');
  }
}

async function doBan(mac, ip, name) {
  try {
    await api('POST', '/api/ban', { mac, ip, hostname: name });
    showToast(`🚫 ${name} berhasil di-ban`, 'success');
    await fetchDevices();
  } catch (err) {
    showToast('Ban gagal: ' + err.message, 'error');
  }
}

async function doUnban(mac, name) {
  try {
    await api('DELETE', '/api/ban', { mac });
    showToast(`✅ ${name} berhasil di-unban`, 'success');
    await fetchDevices();
  } catch (err) {
    showToast('Unban gagal: ' + err.message, 'error');
  }
}

// ─── Confirm Modal ────────────────────────────────────────────────────────────
const ICONS = {
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  ban:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
  ok:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function showConfirm({ title, desc, device, type, okLabel, onOk }) {
  $('confirm-icon').innerHTML  = ICONS[type] || '';
  $('confirm-icon').className  = `modal-icon ${type === 'ban' ? 'ban' : type === 'ok' ? '' : 'warning'}`;
  $('confirm-title').textContent = title;
  $('confirm-desc').textContent  = desc;
  $('confirm-ok').textContent    = okLabel || 'Konfirmasi';

  const dv = $('confirm-device');
  dv.innerHTML = device
    ? `<div class="cdl">Perangkat</div><div class="cdv">${esc(device.name)}</div>
       <div class="cdl" style="margin-top:.4rem">MAC</div><div class="cdv">${esc(device.mac)}</div>
       ${device.ip ? `<div class="cdl" style="margin-top:.4rem">IP</div><div class="cdv">${esc(device.ip)}</div>` : ''}`
    : '';

  $('confirm-overlay').classList.add('active');

  const cleanup = () => {
    $('confirm-overlay').classList.remove('active');
    $('confirm-ok').removeEventListener('click', doOk);
    $('confirm-cancel').removeEventListener('click', cleanup);
  };
  const doOk = async () => { cleanup(); await onOk(); };

  $('confirm-ok').addEventListener('click', doOk);
  $('confirm-cancel').addEventListener('click', cleanup);
}

// ─── Countdown ring ───────────────────────────────────────────────────────────
function startCountdown() {
  clearInterval(State.countdownTmr);
  State.countdown = State.countdownMax;
  tickCountdown();
  State.countdownTmr = setInterval(() => {
    State.countdown--;
    tickCountdown();
    if (State.countdown <= 0) { State.countdown = State.countdownMax; fetchDevices(); }
  }, 1000);
}

function tickCountdown() {
  const pct = State.countdown / State.countdownMax;
  $('countdown-ring').style.strokeDashoffset = 100 * (1 - pct);
  $('countdown-label').textContent = State.countdown;
}

// ─── Status dot ───────────────────────────────────────────────────────────────
function setStatus(s) {
  $('status-dot').className = `status-dot ${s}`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const t = mk('div', `toast ${type}`, `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span>${msg}</span>`);
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, 3500);
}

// ─── Device icon ─────────────────────────────────────────────────────────────
function deviceIcon(h) {
  if (!h) return '📱';
  h = h.toLowerCase();
  if (h.includes('iphone') || h.includes('ipad'))  return '🍎';
  if (h.includes('android') || h.includes('samsung') || h.includes('pixel')) return '📱';
  if (h.includes('mac') || h.includes('macbook'))   return '💻';
  if (h.includes('windows') || h.includes('desktop')) return '🖥️';
  if (h.includes('laptop') || h.includes('notebook')) return '💻';
  if (h.includes('tv') || h.includes('smart'))      return '📺';
  if (h.includes('printer'))                        return '🖨️';
  if (h.includes('camera') || h.includes('cam'))    return '📷';
  if (h.includes('alexa') || h.includes('echo'))    return '🔊';
  return '📱';
}

// ─── HTML escape ─────────────────────────────────────────────────────────────
const EHTML = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
const esc = (s) => String(s||'').replace(/[&<>"']/g, c => EHTML[c]);

// ─── Event wiring ─────────────────────────────────────────────────────────────
$('settings-btn').addEventListener('click', () => {
  clearInterval(State.countdownTmr);
  $('setup-overlay').classList.add('active');
  $('main-app').classList.add('hidden');
});

$('refresh-btn').addEventListener('click', () => {
  State.countdown = State.countdownMax;
  fetchDevices();
});

document.querySelectorAll('.tab').forEach(btn =>
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    State.activeTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
    renderBanned();
  })
);

$('search-input').addEventListener('input', e => {
  State.searchQuery = e.target.value;
  renderDevices();
  renderBanned();
});

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, mac, ip, name } = btn.dataset;

  if (action === 'kick') showConfirm({ title: 'Kick Perangkat?', desc: 'Perangkat akan terputus sementara. Bisa konek lagi secara otomatis.', device: { name, mac, ip }, type: 'warn', okLabel: '⚡ Kick!', onOk: () => doKick(mac, ip, name) });
  if (action === 'ban')  showConfirm({ title: 'Ban Perangkat?',  desc: 'Perangkat diblokir permanen via firewall. Tidak bisa konek sampai di-unban.', device: { name, mac, ip }, type: 'ban',  okLabel: '🚫 Ban!',  onOk: () => doBan(mac, ip, name) });
  if (action === 'unban')showConfirm({ title: 'Unban Perangkat?',desc: 'Perangkat akan bisa konek kembali.', device: { name, mac }, type: 'ok', okLabel: '✅ Unban!', onOk: () => doUnban(mac, name) });
});

$('toggle-pass-btn').addEventListener('click', () => {
  const inp = $('router-pass');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  $('eye-open').style.display   = show ? 'none' : '';
  $('eye-closed').style.display = show ? '' : 'none';
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSavedCreds();
