/* ═══════════════════════════════════════════════════════════════
   WiFi Monitor — app.js
   Pure static client; communicates directly with OpenWrt router
   via LuCI JSON-RPC API (no backend needed).
   ═══════════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────────────────────────
const State = {
  routerBase:  '',   // e.g. http://192.168.1.1
  authToken:   '',
  devices:     [],
  bannedList:  [],   // persisted in localStorage
  searchQuery: '',
  activeTab:   'devices',
  countdown:   10,
  countdownMax: 10,
  timer:       null,
  countdownTimer: null,
  isRefreshing: false,
};

// ─── Selectors ────────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const el = (tag, cls, html='') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

// ─── LocalStorage helpers ─────────────────────────────────────────────────────
function saveBanned() {
  localStorage.setItem('wm_banned', JSON.stringify(State.bannedList));
}
function loadBanned() {
  try { State.bannedList = JSON.parse(localStorage.getItem('wm_banned') || '[]'); } catch(_){}
}
function loadCreds() {
  const c = localStorage.getItem('wm_creds');
  if (c) {
    try {
      const { host, user } = JSON.parse(c);
      $('router-ip').value   = host || '';
      $('router-user').value = user || 'root';
      $('save-creds').checked = true;
    } catch(_){}
  }
}

// ─── LuCI JSON-RPC API ────────────────────────────────────────────────────────
async function luciCall(endpoint, method, params) {
  const url  = `${State.routerBase}/cgi-bin/luci/rpc/${endpoint}`;
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'RPC error');
  return data.result;
}

async function luciLogin(password, username = 'root') {
  const result = await luciCall('auth', 'login', [username, password]);
  if (!result || result === '0000000000000000000000000000000') {
    throw new Error('Login gagal — cek username/password');
  }
  return result; // auth token
}

async function luciExec(command) {
  const result = await luciCall('sys', 'exec', [`${command} 2>/dev/null`], );
  return result || '';
}

// Authenticated sys exec
async function sysExec(cmd) {
  const url  = `${State.routerBase}/cgi-bin/luci/rpc/sys`;
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'exec',
    params: [cmd],
    auth: State.authToken,
  });
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.result || '';
}

// ─── Device Parsing ───────────────────────────────────────────────────────────
function parseDhcpLeases(raw) {
  return (raw || '').trim().split('\n').filter(Boolean).map(line => {
    const p = line.split(/\s+/);
    return p.length >= 4 ? { mac: p[1]?.toLowerCase(), ip: p[2], hostname: p[3] === '*' ? null : p[3] } : null;
  }).filter(Boolean);
}

function parseArpNeigh(raw) {
  return (raw || '').trim().split('\n').filter(Boolean).map(line => {
    const mac = line.match(/lladdr\s+([0-9a-f:]{17})/i)?.[1];
    const ip  = line.match(/^(\S+)/)?.[1];
    return (mac && ip && !line.includes('FAILED')) ? { ip, mac: mac.toLowerCase() } : null;
  }).filter(Boolean);
}

function mergeDeviceData(leases, arp) {
  const map = {};
  for (const d of arp)    map[d.mac] = { ...d, source: 'arp' };
  for (const d of leases) {
    if (!d.mac) continue;
    map[d.mac] = map[d.mac]
      ? { ...map[d.mac], ...d, source: 'dhcp+arp' }
      : { ...d, source: 'dhcp' };
  }
  return Object.values(map);
}

function getDeviceIcon(hostname) {
  if (!hostname) return '📱';
  const h = hostname.toLowerCase();
  if (h.includes('iphone') || h.includes('ipad')) return '🍎';
  if (h.includes('android') || h.includes('pixel') || h.includes('samsung')) return '📱';
  if (h.includes('mac') || h.includes('macbook') || h.includes('imac')) return '💻';
  if (h.includes('windows') || h.includes('pc') || h.includes('desktop')) return '🖥️';
  if (h.includes('laptop') || h.includes('notebook')) return '💻';
  if (h.includes('tv') || h.includes('smart')) return '📺';
  if (h.includes('printer') || h.includes('hp-') || h.includes('canon')) return '🖨️';
  if (h.includes('router') || h.includes('ap-')) return '📡';
  if (h.includes('camera') || h.includes('cam')) return '📷';
  if (h.includes('alexa') || h.includes('echo')) return '🔊';
  return '📱';
}

// ─── Fetch & Refresh ──────────────────────────────────────────────────────────
async function fetchDevices() {
  if (!State.authToken) return;
  if (State.isRefreshing) return;
  State.isRefreshing = true;
  $('refresh-btn').classList.add('spinning');

  try {
    const [leasesRaw, arpRaw] = await Promise.all([
      sysExec('cat /tmp/dhcp.leases'),
      sysExec('ip neigh show || arp -n'),
    ]);

    const leases  = parseDhcpLeases(leasesRaw);
    const arp     = parseArpNeigh(arpRaw);
    State.devices = mergeDeviceData(leases, arp);

    // Filter out router IP itself
    const routerIP = new URL(State.routerBase).hostname;
    State.devices  = State.devices.filter(d => d.ip !== routerIP);

    updateStats();
    renderDevices();
    renderBanned();

    $('stat-refreshed').textContent = new Date().toLocaleTimeString('id-ID');
  } catch (err) {
    showToast('Gagal refresh: ' + err.message, 'error');
    setStatusOffline();
  } finally {
    State.isRefreshing = false;
    $('refresh-btn').classList.remove('spinning');
  }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const bannedMacs = State.bannedList.map(b => b.mac);
  const active = State.devices.filter(d => !bannedMacs.includes(d.mac)).length;
  $('stat-total').textContent   = State.devices.length;
  $('stat-active').textContent  = active;
  $('stat-banned').textContent  = State.bannedList.length;
  $('count-devices').textContent = active;
  $('count-banned').textContent  = State.bannedList.length;
}

// ─── Render Devices ───────────────────────────────────────────────────────────
function renderDevices() {
  const bannedMacs = State.bannedList.map(b => b.mac);
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
    tbody.innerHTML = `<tr><td colspan="6" class="empty-cell"><div class="empty-state"><span class="empty-ico">🔍</span><span>${State.searchQuery ? 'Tidak ada hasil' : 'Tidak ada perangkat ditemukan'}</span></div></td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  for (const dev of list) {
    const isBanned = bannedMacs.includes(dev.mac);
    const icon     = getDeviceIcon(dev.hostname);
    const name     = dev.hostname || 'Unknown';

    const sourceLabel = dev.source === 'dhcp+arp' ? 'combined' : dev.source;
    const sourceText  = dev.source === 'dhcp+arp' ? 'DHCP+ARP' : (dev.source || 'ARP').toUpperCase();

    const tr = el('tr');
    tr.innerHTML = `
      <td>
        <div class="device-cell">
          <div class="device-avatar">${icon}</div>
          <div>
            <div class="device-name">${escHtml(name)}</div>
          </div>
        </div>
      </td>
      <td><span class="mono">${escHtml(dev.ip || '—')}</span></td>
      <td><span class="mono">${escHtml(dev.mac || '—')}</span></td>
      <td><span class="source-badge ${sourceLabel}">${sourceText}</span></td>
      <td>
        <span class="status-cell ${isBanned ? 'banned' : 'online'}">
          <span class="dot"></span>${isBanned ? 'Banned' : 'Online'}
        </span>
      </td>
      <td>
        <div class="action-cell">
          ${!isBanned ? `
            <button class="btn btn-kick" data-action="kick" data-mac="${escHtml(dev.mac)}" data-ip="${escHtml(dev.ip||'')}" data-name="${escHtml(name)}">⚡ Kick</button>
            <button class="btn btn-ban"  data-action="ban"  data-mac="${escHtml(dev.mac)}" data-ip="${escHtml(dev.ip||'')}" data-name="${escHtml(name)}">🚫 Ban</button>
          ` : `
            <button class="btn btn-unban" data-action="unban" data-mac="${escHtml(dev.mac)}" data-name="${escHtml(name)}">✅ Unban</button>
          `}
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Render Banned ────────────────────────────────────────────────────────────
function renderBanned() {
  let list = State.bannedList;
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
    const icon = getDeviceIcon(b.hostname);
    const time = b.bannedAt ? new Date(b.bannedAt).toLocaleString('id-ID') : '—';
    const tr = el('tr');
    tr.innerHTML = `
      <td>
        <div class="device-cell">
          <div class="device-avatar">${icon}</div>
          <div><div class="device-name">${escHtml(b.hostname || 'Unknown')}</div></div>
        </div>
      </td>
      <td><span class="mono">${escHtml(b.ip || '—')}</span></td>
      <td><span class="mono">${escHtml(b.mac || '—')}</span></td>
      <td style="font-size:0.8rem;color:var(--text-3)">${escHtml(time)}</td>
      <td>
        <button class="btn btn-unban" data-action="unban" data-mac="${escHtml(b.mac)}" data-name="${escHtml(b.hostname||'Unknown')}">✅ Unban</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function doKick(mac, ip, name) {
  try {
    // Deauth via hostapd_cli on all wireless interfaces
    await sysExec(`
      for iface in $(iw dev 2>/dev/null | grep Interface | awk '{print $2}'); do
        hostapd_cli -i "$iface" deauthenticate ${mac} 2>/dev/null
      done
    `);
    // Remove ARP entry
    if (ip) await sysExec(`ip neigh del ${ip} dev br-lan 2>/dev/null || true`);
    showToast(`⚡ ${name} berhasil di-kick`, 'success');
    setTimeout(fetchDevices, 1500);
  } catch (err) {
    showToast('Kick gagal: ' + err.message, 'error');
  }
}

async function doBan(mac, ip, name) {
  try {
    // Block via ebtables or iptables
    await sysExec(`
      ebtables -A FORWARD --source ${mac} -j DROP 2>/dev/null ||
      iptables -I FORWARD -m mac --mac-source ${mac} -j DROP 2>/dev/null || true
    `);
    // Kick too
    await sysExec(`
      for iface in $(iw dev 2>/dev/null | grep Interface | awk '{print $2}'); do
        hostapd_cli -i "$iface" deauthenticate ${mac} 2>/dev/null || true
      done
    `);
    // Persist ban in memory + localStorage
    if (!State.bannedList.find(b => b.mac === mac)) {
      State.bannedList.push({ mac, ip: ip || '—', hostname: name, bannedAt: new Date().toISOString() });
      saveBanned();
    }
    showToast(`🚫 ${name} berhasil di-ban`, 'success');
    updateStats();
    renderDevices();
    renderBanned();
  } catch (err) {
    showToast('Ban gagal: ' + err.message, 'error');
  }
}

async function doUnban(mac, name) {
  try {
    await sysExec(`
      ebtables -D FORWARD --source ${mac} -j DROP 2>/dev/null || true
      iptables -D FORWARD -m mac --mac-source ${mac} -j DROP 2>/dev/null || true
    `);
    State.bannedList = State.bannedList.filter(b => b.mac !== mac);
    saveBanned();
    showToast(`✅ ${name} berhasil di-unban`, 'success');
    updateStats();
    renderDevices();
    renderBanned();
  } catch (err) {
    showToast('Unban gagal: ' + err.message, 'error');
  }
}

// ─── Confirm Modal ────────────────────────────────────────────────────────────
function showConfirm({ title, desc, device, iconClass, okLabel, onOk }) {
  const iconHtml = {
    warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    ban:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`,
    check:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  }[iconClass] || '';

  $('confirm-icon').innerHTML = iconHtml;
  $('confirm-icon').className = `modal-icon ${iconClass === 'ban' ? 'ban' : iconClass === 'check' ? '' : 'warning'}`;
  $('confirm-title').textContent = title;
  $('confirm-desc').textContent  = desc;
  $('confirm-ok').textContent    = okLabel || 'Konfirmasi';

  const dv = $('confirm-device');
  dv.innerHTML = device
    ? `<div class="cdl">Perangkat</div><div class="cdv">${escHtml(device.name)}</div>
       <div class="cdl" style="margin-top:.4rem">MAC</div><div class="cdv">${escHtml(device.mac)}</div>
       ${device.ip ? `<div class="cdl" style="margin-top:.4rem">IP</div><div class="cdv">${escHtml(device.ip)}</div>` : ''}`
    : '';

  $('confirm-overlay').classList.add('active');

  const doOk = async () => {
    cleanup();
    await onOk();
  };
  const doCancel = () => { cleanup(); };

  function cleanup() {
    $('confirm-overlay').classList.remove('active');
    $('confirm-ok').removeEventListener('click', doOk);
    $('confirm-cancel').removeEventListener('click', doCancel);
  }

  $('confirm-ok').addEventListener('click', doOk);
  $('confirm-cancel').addEventListener('click', doCancel);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const t = el('div', `toast ${type}`, `<span class="toast-icon">${icons[type]}</span><span>${msg}</span>`);
  $('toasts').appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove());
  }, 3500);
}

// ─── Connection Status ────────────────────────────────────────────────────────
function setStatusOnline() {
  const dot = $('status-dot');
  dot.className = 'status-dot online';
}
function setStatusOffline() {
  const dot = $('status-dot');
  dot.className = 'status-dot offline';
}

// ─── Countdown Timer ──────────────────────────────────────────────────────────
const RING_CIRC = 100; // matches stroke-dasharray

function startCountdown() {
  clearInterval(State.countdownTimer);
  State.countdown = State.countdownMax;
  updateCountdownUI();

  State.countdownTimer = setInterval(() => {
    State.countdown--;
    updateCountdownUI();
    if (State.countdown <= 0) {
      State.countdown = State.countdownMax;
      fetchDevices();
    }
  }, 1000);
}

function updateCountdownUI() {
  const pct    = State.countdown / State.countdownMax;
  const offset = RING_CIRC * (1 - pct);
  $('countdown-ring').style.strokeDashoffset = offset;
  $('countdown-label').textContent = State.countdown;
}

// ─── Setup / Connect ──────────────────────────────────────────────────────────
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip       = $('router-ip').value.trim();
  const user     = $('router-user').value.trim() || 'root';
  const pass     = $('router-pass').value;
  const saveCred = $('save-creds').checked;

  const errEl = $('connect-error');
  errEl.classList.add('hidden');

  const btn = $('connect-btn');
  btn.querySelector('.btn-text').textContent = 'Menghubungkan...';
  btn.querySelector('.spinner').classList.remove('hidden');
  btn.disabled = true;

  try {
    State.routerBase = /^https?:\/\//i.test(ip) ? ip.replace(/\/$/, '') : `http://${ip}`;
    const token = await luciLogin(pass, user);
    State.authToken = token;

    $('router-addr-display').textContent = ip;
    setStatusOnline();

    if (saveCred) {
      localStorage.setItem('wm_creds', JSON.stringify({ host: ip, user }));
    }

    // Show app
    $('setup-overlay').classList.remove('active');
    $('main-app').classList.remove('hidden');

    // Initial fetch + start timer
    await fetchDevices();
    startCountdown();
    showToast('✅ Berhasil terhubung ke router!', 'success');
  } catch (err) {
    errEl.textContent = '❌ ' + (err.message || 'Koneksi gagal. Periksa IP dan password.');
    errEl.classList.remove('hidden');
  } finally {
    btn.querySelector('.btn-text').textContent = 'Hubungkan ke Router';
    btn.querySelector('.spinner').classList.add('hidden');
    btn.disabled = false;
  }
});

// ─── Settings btn ─────────────────────────────────────────────────────────────
$('settings-btn').addEventListener('click', () => {
  clearInterval(State.countdownTimer);
  $('setup-overlay').classList.add('active');
  $('main-app').classList.add('hidden');
});

// ─── Refresh btn ─────────────────────────────────────────────────────────────
$('refresh-btn').addEventListener('click', () => {
  State.countdown = State.countdownMax;
  fetchDevices();
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    State.activeTab = tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `panel-${tab}`));
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────
$('search-input').addEventListener('input', (e) => {
  State.searchQuery = e.target.value;
  renderDevices();
  renderBanned();
});

// ─── Action delegation ────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const { action, mac, ip, name } = btn.dataset;

  if (action === 'kick') {
    showConfirm({
      title: 'Kick Perangkat?',
      desc: 'Perangkat akan terputus dari WiFi sementara. Ia bisa konek lagi secara otomatis.',
      device: { name, mac, ip },
      iconClass: 'warn',
      okLabel: '⚡ Ya, Kick!',
      onOk: () => doKick(mac, ip, name),
    });
  }

  if (action === 'ban') {
    showConfirm({
      title: 'Ban Perangkat?',
      desc: 'Perangkat akan diblokir permanen via firewall router. Tidak bisa konek sampai di-unban.',
      device: { name, mac, ip },
      iconClass: 'ban',
      okLabel: '🚫 Ya, Ban!',
      onOk: () => doBan(mac, ip, name),
    });
  }

  if (action === 'unban') {
    showConfirm({
      title: 'Unban Perangkat?',
      desc: 'Perangkat akan bisa konek kembali ke WiFi.',
      device: { name, mac },
      iconClass: 'check',
      okLabel: '✅ Ya, Unban!',
      onOk: () => doUnban(mac, name),
    });
  }
});

// ─── Password toggle ─────────────────────────────────────────────────────────
$('toggle-pass-btn').addEventListener('click', () => {
  const input = $('router-pass');
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  $('eye-open').style.display   = isPass ? 'none' : '';
  $('eye-closed').style.display = isPass ? '' : 'none';
});

// ─── HTML escape ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadBanned();
loadCreds();
