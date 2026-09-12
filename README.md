# 📡 WiFi Monitor

Dashboard untuk memantau, kick, dan ban perangkat yang terhubung ke WiFi — berbasis OpenWrt/DD-WRT.

**Demo live di GitHub Pages** → tidak butuh server, langsung jalan di browser!

---

## 🚀 Deploy ke GitHub Pages

1. **Fork / clone repo ini**
2. Pergi ke **Settings → Pages**
3. Source: **Deploy from a branch**, pilih `main` branch, folder `/` (root)
4. Simpan → tunggu beberapa menit
5. Buka `https://<username>.github.io/<repo-name>/`

---

## ⚙️ Konfigurasi Router OpenWrt

### 1. Aktifkan LuCI (biasanya sudah aktif)
```bash
opkg update
opkg install luci
```

### 2. Install plugin rpcd-mod-rpc-sys (untuk fitur exec)
```bash
opkg install rpcd-mod-rpc-sys
/etc/init.d/rpcd restart
```

### 3. Aktifkan CORS di uhttpd (agar browser bisa akses dari GitHub Pages)

Edit `/etc/config/uhttpd`:
```bash
uci set uhttpd.main.cors_allow_origin='*'
uci commit uhttpd
/etc/init.d/uhttpd restart
```

Atau via SSH:
```bash
uci set uhttpd.main.cors_allow_origin='*' && uci commit uhttpd && /etc/init.d/uhttpd restart
```

---

## 🛠️ Cara Pakai

1. Buka website (GitHub Pages atau `index.html` langsung di browser)
2. Masukkan:
   - **IP Router**: biasanya `192.168.1.1`
   - **Username**: `root`
   - **Password**: password router kamu
3. Klik **Hubungkan ke Router**
4. Dashboard akan menampilkan semua perangkat yang terhubung
5. Klik **⚡ Kick** untuk memutus koneksi sementara
6. Klik **🚫 Ban** untuk memblokir permanen via firewall
7. Tab **Daftar Ban** untuk melihat & unban perangkat

---

## 🔧 Fitur

| Fitur | Keterangan |
|-------|------------|
| 📡 Live Monitor | Daftar semua perangkat, auto-refresh 10 detik |
| ⚡ Kick | Putus koneksi sementara via `hostapd_cli deauthenticate` |
| 🚫 Ban | Block MAC address via `ebtables` / `iptables` |
| ✅ Unban | Hapus rule firewall, perangkat bisa konek lagi |
| 🔍 Search | Cari berdasarkan IP, MAC, atau nama perangkat |
| 💾 Simpan Kredensial | Opsional simpan di `localStorage` browser |
| 🌙 Dark Mode | UI premium glassmorphism |

---

## ⚠️ Catatan Penting

- **CORS**: Browser perlu izin dari router untuk akses lintas domain. Aktifkan CORS di uhttpd (lihat di atas), atau buka `index.html` secara lokal (`file://`) untuk bypass CORS.
- **Keamanan**: Jangan gunakan password router yang lemah. Dashboard ini tidak mengenkripsi password saat dikirim (HTTP biasa).
- **Ban list** disimpan di `localStorage` browser — jika kamu buka di browser lain, list ban tidak akan muncul (tapi rule firewall di router tetap aktif).

---

## 📁 Struktur File

```
wifi-monitor/
├── index.html   # UI dashboard
├── style.css    # Styling dark glassmorphism
├── app.js       # Logic + LuCI RPC API client
└── README.md    # Dokumentasi ini
```

---

## 🤝 Lisensi

MIT — bebas digunakan dan dimodifikasi.
