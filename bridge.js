/**
 * WiFi Monitor — Local SSH Bridge
 * ─────────────────────────────────────────────────────────────
 * Jalankan di Windows: node bridge.js
 * Lalu buka dashboard GitHub Pages dan hubungkan ke:
 *   Bridge URL: http://localhost:3000
 * ─────────────────────────────────────────────────────────────
 */

const express = require('express');
const cors    = require('cors');
const { NodeSSH } = require('node-ssh');

const app  = express();
const PORT = 3000;

// Izinkan akses dari semua origin (GitHub Pages, file://, localhost)
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── State ──────────────────────────────────────────────────────────────────
let sshCfg = { host: '', username: 'root', password: '' };
let connected = false;
let bannedDevices = []; // { mac, ip, hostname, bannedAt }

// ─── SSH Helper ─────────────────────────────────────────────────────────────
async function ssh(command) {
  const client = new NodeSSH();
  await client.connect({
    host:         sshCfg.host,
    username:     sshCfg.username,
    password:     sshCfg.password,
    tryKeyboard:  true,
    readyTimeout: 8000,
  });
  const result = await client.execCommand(command);
  client.dispose();
  return result.stdout || '';
}

// ─── Parsers ─────────────────────────────────────────────────────────────────
function parseDhcpLeases(raw) {
  return (raw || '').trim().split('\n').filter(Boolean).map(line => {
    const p = line.split(/\s+/);
    return p.length >= 4 ? { mac: p[1]?.toLowerCase(), ip: p[2], hostname: p[3] === '*' ? null : p[3] } : null;
  }).filter(d => d && d.mac);
}

function parseArp(raw) {
  return (raw || '').trim().split('\n').filter(Boolean).map(line => {
    const mac = line.match(/([0-9a-f]{2}[:\-]){5}[0-9a-f]{2}/i)?.[0];
    const ip  = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/)?.[1]
             || line.match(/^(\d+\.\d+\.\d+\.\d+)/)?.[1];
    return (mac && ip) ? { mac: mac.toLowerCase(), ip } : null;
  }).filter(Boolean);
}

function mergeDevices(leases, arp) {
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

// ─── POST /api/config ── Simpan SSH config & test koneksi ───────────────────
app.post('/api/config', async (req, res) => {
  const { host, username, password } = req.body;
  if (!host || !username || !password)
    return res.status(400).json({ error: 'host, username, dan password wajib diisi.' });

  sshCfg = { host, username, password };
  try {
    await ssh('echo ok');
    connected = true;
    console.log(`✅ Terhubung ke router: ${host}`);
    res.json({ success: true, message: 'Koneksi SSH berhasil!' });
  } catch (err) {
    connected = false;
    console.error(`❌ SSH gagal: ${err.message}`);
    res.status(500).json({ error: 'Koneksi SSH gagal: ' + err.message });
  }
});

// ─── GET /api/config ── Status koneksi ──────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ connected, host: sshCfg.host, username: sshCfg.username });
});

// ─── GET /api/devices ── Daftar perangkat ───────────────────────────────────
app.get('/api/devices', async (_req, res) => {
  if (!connected)
    return res.status(503).json({ error: 'Belum terhubung ke router.' });

  try {
    const [leasesRaw, arpRaw] = await Promise.all([
      ssh('cat /tmp/dhcp.leases 2>/dev/null || echo ""'),
      ssh('arp -n 2>/dev/null || ip neigh show 2>/dev/null || echo ""'),
    ]);

    const leases  = parseDhcpLeases(leasesRaw);
    const arp     = parseArp(arpRaw);
    let   devices = mergeDevices(leases, arp);

    // Tandai yang sudah dibanned
    const bannedMacs = bannedDevices.map(b => b.mac);
    devices = devices
      .filter(d => d.ip !== sshCfg.host)
      .map(d => ({ ...d, banned: bannedMacs.includes(d.mac) }));

    res.json({ devices });
  } catch (err) {
    connected = false;
    res.status(500).json({ error: 'Gagal ambil data: ' + err.message });
  }
});

// ─── POST /api/kick ── Kick device ──────────────────────────────────────────
app.post('/api/kick', async (req, res) => {
  const { mac, ip } = req.body;
  if (!mac) return res.status(400).json({ error: 'MAC address diperlukan.' });

  try {
    // Deauth via hostapd_cli di semua interface wireless
    await ssh(`
      for iface in $(iw dev 2>/dev/null | grep Interface | awk '{print $2}'); do
        hostapd_cli -i "$iface" deauthenticate ${mac} 2>/dev/null || true
      done
    `);
    if (ip) await ssh(`ip neigh del ${ip} dev br-lan 2>/dev/null || true`);
    console.log(`⚡ Kicked: ${mac}`);
    res.json({ success: true, message: `Device ${mac} berhasil di-kick.` });
  } catch (err) {
    res.status(500).json({ error: 'Kick gagal: ' + err.message });
  }
});

// ─── POST /api/ban ── Ban device ────────────────────────────────────────────
app.post('/api/ban', async (req, res) => {
  const { mac, ip, hostname } = req.body;
  if (!mac) return res.status(400).json({ error: 'MAC address diperlukan.' });

  const macLower = mac.toLowerCase();
  if (bannedDevices.find(b => b.mac === macLower))
    return res.json({ success: true, message: 'Sudah di-ban sebelumnya.' });

  try {
    // Block MAC via ebtables (lebih efektif) atau iptables
    await ssh(`
      ebtables -A FORWARD --source ${mac} -j DROP 2>/dev/null || \
      iptables -I FORWARD -m mac --mac-source ${mac} -j DROP 2>/dev/null || true
    `);
    // Kick juga sekalian
    await ssh(`
      for iface in $(iw dev 2>/dev/null | grep Interface | awk '{print $2}'); do
        hostapd_cli -i "$iface" deauthenticate ${mac} 2>/dev/null || true
      done
    `);

    bannedDevices.push({
      mac: macLower, ip: ip || '—',
      hostname: hostname || 'Unknown',
      bannedAt: new Date().toISOString(),
    });
    console.log(`🚫 Banned: ${mac} (${hostname || 'Unknown'})`);
    res.json({ success: true, message: `Device ${mac} berhasil di-ban.` });
  } catch (err) {
    res.status(500).json({ error: 'Ban gagal: ' + err.message });
  }
});

// ─── DELETE /api/ban ── Unban device ────────────────────────────────────────
app.delete('/api/ban', async (req, res) => {
  const { mac } = req.body;
  if (!mac) return res.status(400).json({ error: 'MAC address diperlukan.' });

  try {
    await ssh(`
      ebtables -D FORWARD --source ${mac} -j DROP 2>/dev/null || true
      iptables -D FORWARD -m mac --mac-source ${mac} -j DROP 2>/dev/null || true
    `);
    bannedDevices = bannedDevices.filter(b => b.mac !== mac.toLowerCase());
    console.log(`✅ Unbanned: ${mac}`);
    res.json({ success: true, message: `Device ${mac} berhasil di-unban.` });
  } catch (err) {
    res.status(500).json({ error: 'Unban gagal: ' + err.message });
  }
});

// ─── GET /api/banned ── Daftar ban ──────────────────────────────────────────
app.get('/api/banned', (_req, res) => {
  res.json({ banned: bannedDevices });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║      WiFi Monitor — Local SSH Bridge         ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  Bridge URL : http://localhost:${PORT}`);
  console.log(`  Status     : Menunggu koneksi dari dashboard...`);
  console.log('');
  console.log('  Buka dashboard GitHub Pages, lalu isi:');
  console.log(`    Bridge URL  : http://localhost:${PORT}`);
  console.log('    Router IP   : 192.168.1.1 (atau IP router kamu)');
  console.log('    Username    : root');
  console.log('    Password    : (password router)');
  console.log('');
  console.log('  Tekan Ctrl+C untuk berhenti.');
  console.log('');
});
