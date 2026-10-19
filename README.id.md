<div align="center">

# 🗺️ BHUMI Recorder

**Perekam bidang tanah & status Hak Milik dari peta [BHUMI ATR/BPN](https://bhumi.atrbpn.go.id/peta) — langsung di browser, tanpa server.**

Klik bidang tanah seperti biasa, dan alat ini otomatis **mencatat**, **menandai di peta**, **menghitung per jenis hak**, lalu **mengekspor** ke GeoJSON & CSV.

[![Pasang](https://img.shields.io/badge/⬇_Pasang-1--klik-1a9850)](https://raw.githubusercontent.com/mhrdwan/bhumi-recorder/main/bhumi-recorder.user.js)
![Versi](https://img.shields.io/badge/versi-1.5.0-0a7d3c)
![Lisensi](https://img.shields.io/badge/lisensi-MIT-0a5a7d)
![Userscript](https://img.shields.io/badge/Tampermonkey-userscript-0a7d3c)
![Privasi](https://img.shields.io/badge/privasi-tanpa%20server%20·%20tanpa%20tracking-9e9e9e)

<img src="docs/panel-preview.png" alt="Panel BHUMI Recorder di atas peta BHUMI dengan penanda bidang berwarna" width="820">

</div>

---

## ✨ Untuk apa ini?

BHUMI (portal resmi Kementerian ATR/BPN) menampilkan **bidang tanah terdaftar** beserta **jenis haknya** — tapi datanya cuma muncul sesaat saat kamu klik satu bidang, tidak bisa dikumpulkan atau dihitung. **BHUMI Recorder** menjembatani itu:

- **Menghitung tanah** — tahu persis ada berapa **Hak Milik**, **Hak Guna Bangunan**, **Hak Pakai**, dll. di area yang kamu jelajahi, otomatis terurut dari terbanyak.
- **Memetakan cepat** — tiap bidang yang kamu klik diberi **titik penanda berwarna** menempel di peta BHUMI (🟢 Hak Milik · 🟠 hak lain · ⚪️ belum ketahuan), jadi kelihatan mana yang sudah kamu survei.
- **Menyimpan hasil** — ekspor **GeoJSON** (untuk peta) dan **CSV** (untuk Excel/Sheets), lengkap dengan NIB, jenis hak, luas, penggunaan, koordinat, dan kata pencarian.
- **Menampilkan ulang** — buka `viewer.html` (offline, tanpa internet) untuk melihat kembali semua bidang tersimpan di peta.

Cocok untuk riset lahan pribadi, survei awal calon lokasi, atau sekadar memetakan status hak di sekitar sebuah area — **kamu tetap menjelajah manual**, alat ini hanya mencatat di belakang layar.

---

## 🧩 Fitur utama

| | Fitur |
|---|---|
| 📍 | **Penanda di peta BHUMI** — titik berwarna sesuai status hak, ikut geser & zoom, menempel di bidang yang sama |
| 🧮 | **Rincian per jenis hak** — hitungan Hak Milik / HGB / Hak Pakai / dll. langsung di panel |
| 🗂️ | **Daftar bidang** — semua NIB + jenisnya; klik satu baris untuk **terbang ke titiknya** di peta |
| 🔁 | **Anti-duplikat** — klik ulang bidang yang sama tidak bikin titik dobel (dedup berdasarkan NIB) |
| 🚫 | **Abaikan tanah kosong** — hanya klik yang menghasilkan NIB yang dihitung |
| 🔎 | **Rekam kata pencarian** — istilah yang kamu cari ikut tersimpan per bidang |
| ⬇️ | **Ekspor GeoJSON & CSV** — sekali klik dari panel |
| 🖥️ | **Penampil offline** — `viewer.html` menampilkan hasil tanpa perlu server atau internet |
| 🔒 | **100% lokal** — data disimpan di `localStorage` browser; tak ada data yang dikirim ke mana pun |

---

## 🖼️ Tampilan

**Panel perekam** (muncul di pojok kanan-bawah situs BHUMI):

<img src="docs/panel-preview.png" alt="Panel extension BHUMI Recorder" width="760">

**Penampil lokal `viewer.html`** (seret file `.geojson` hasil rekaman ke sini):

<img src="docs/viewer-preview.png" alt="Penampil peta viewer.html" width="760">

> Gambar di atas adalah ilustrasi UI yang setia dengan tampilan asli. Data pada gambar hanya contoh.

---

## ⚠️ Baca dulu — 3 batasan penting

1. **Nama pemilik TIDAK ada.** BHUMI sengaja menyembunyikannya demi privasi (UU PDP). Kamu hanya bisa tahu **jenis hak**-nya (Hak Milik / HGB / Hak Pakai / dll), **bukan siapa** pemiliknya.
2. **Hanya bidang terdaftar & sudah di-plotting** yang punya data. Tanah yang belum terdaftar / belum dipetakan tidak akan muncul datanya.
3. **Bukan kepastian hukum.** BHUMI = informasi spasial. Kalau mau beli tanah, tetap verifikasi resmi lewat **SKPT / kantor BPN / PPAT**. Jangan mengambil keputusan hukum hanya dari sini.

---

## 🔧 Pemasangan (sekali saja)

> ### ⚡ Pasang cepat (1 klik)
> Sudah punya Tampermonkey? Klik link ini — Tampermonkey akan otomatis menawarkan **Install**:
> **→ [Pasang bhumi-recorder.user.js](https://raw.githubusercontent.com/mhrdwan/bhumi-recorder/main/bhumi-recorder.user.js)**
> Setelah terpasang, skrip akan **update otomatis** setiap ada versi baru.

Belum punya Tampermonkey, atau mau pasang manual? Ikuti langkah di bawah.

### 1. Pasang ekstensi Tampermonkey

Buka **Chrome** (atau Edge/Firefox/Brave) → pasang dari toko ekstensi resmi:

- Chrome/Edge/Brave: [Chrome Web Store — Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- Firefox: [Add-ons — Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)

### 2. Tambahkan skrip perekam

1. Klik ikon **Tampermonkey** → **Create a new script…**
2. **Hapus** semua teks contoh.
3. Buka [`bhumi-recorder.user.js`](bhumi-recorder.user.js), **salin seluruh isinya**, tempel ke editor.
4. **File → Save** (`Cmd/Ctrl+S`). Selesai — skrip aktif otomatis di `bhumi.atrbpn.go.id`.

> **Alternatif:** seret file `bhumi-recorder.user.js` langsung ke tab browser; Tampermonkey biasanya menawarkan tombol **Install** otomatis.

---

## 🚀 Cara pakai

1. Buka **https://bhumi.atrbpn.go.id/peta**
2. Aktifkan layer bidang: menu **Tambah Data → Bidang Tanah**, lalu **setujui disclaimer** ("Saya setuju").
3. Panel hijau **"BHUMI Recorder"** muncul di pojok kanan-bawah. (Kalau tidak muncul, refresh halaman.)
4. **Klik sebuah bidang tanah** → info NIB/Tipe Hak/Luas muncul, angka di panel **bertambah**, dan **titik penanda berwarna** menempel di bidang itu.
5. Mau memetakan area? **Cari lokasi** (kolom pencarian NIB/HAK) lalu **klik bidang-bidang** yang kamu mau — semuanya terekam otomatis.
6. Klik **⬇︎ GeoJSON** dan **⬇︎ CSV** untuk menyimpan hasil (masuk ke folder **Downloads**).

Panel juga menampilkan **rincian per jenis hak**, **daftar bidang** (klik untuk terbang ke titiknya), dan tombol **🔍 Lihat semua titik**, plus **Jeda/Lanjut**, **Debug: ON/OFF**, dan **Hapus**.

### Run pertama: mode Debug

Karena struktur data BHUMI bisa berubah, skrip mulai dengan **Debug: ON**. Saat pertama mengeklik bidang, buka **Console** (F12) dan cari baris hijau `[BHUMI-REC] …`. Kalau angka tak bertambah atau label terlihat aneh, salin log itu — supaya pemetaan field bisa difinalkan. Setelah yakin data benar, matikan **Debug: OFF**.

---

## 👀 Melihat hasil di peta

**Cara A — penampil lokal (offline):** buka [`viewer.html`](viewer.html) (klik dua kali), lalu **seret** file `bhumi-bidang.geojson` ke dalamnya. Bidang tampil berwarna sesuai status hak; klik untuk lihat detail. Centang **"Tampilkan label NIB"** untuk menampilkan nomor bidang.

**Cara B — tanpa file apa pun:** buka [geojson.io](https://geojson.io), seret `bhumi-bidang.geojson` ke sana.

**Buka tabelnya (Excel):** `bhumi-bidang.csv` bisa dibuka di Excel / Numbers / Google Sheets.

---

## 🗃️ Format data hasil ekspor

Setiap bidang di GeoJSON/CSV memuat kolom berikut:

| Kolom | Arti |
|-------|------|
| `nib` | Nomor Identifikasi Bidang |
| `tipe_hak` | Jenis hak persis (mis. `Hak Milik`, `Hak Guna Bangunan`) |
| `kategori` | `Hak Milik` / `Hak lain` / `Tidak diketahui` |
| `is_hak_milik` | `true` / `false` |
| `penggunaan` | Penggunaan tanah (bila tersedia) |
| `luas` | Luas (bila tersedia) |
| `lon`, `lat` | Koordinat centroid (EPSG:4326) |
| `search_term` | Kata pencarian saat bidang ini direkam |
| `source` | Asal data (`peta` / `panel` / `url`) |
| `recorded_at` | Waktu perekaman (ISO 8601) |

---

## ⚙️ Cara kerja (untuk kontributor)

Seluruh logika ada di satu file, [`bhumi-recorder.user.js`](bhumi-recorder.user.js), tanpa dependensi eksternal:

1. **Intip jaringan** — dijalankan `@run-at document-start`, membungkus `window.fetch` + `XMLHttpRequest` untuk membaca respons JSON (GetFeatureInfo / `rating_layer`) yang diambil peta saat kamu klik bidang. Sebagian data bahkan diambil langsung dari **query URL** karena lebih andal.
2. **Koordinat klik** — didengarkan dari `map.on('click')` MapLibre (paling andal), dengan cadangan membaca body request `getPersil`.
3. **Jembatan peta** — instance MapLibre GL BHUMI ditemukan lewat dua strategi: mem-*patch* global `maplibregl`/`mapboxgl`, atau menelusuri **React fiber** untuk objek yang berperilaku seperti peta — lalu memasang layer penanda titik di atasnya.
4. **Cadangan tahan-CSP** — bila hook jaringan diblokir, panel info di layar dibaca via `MutationObserver` (DOM scrape).
5. **Normalisasi & klasifikasi** — field mentah dipetakan (Tipe Hak/NIB/Luas/Penggunaan) dan diklasifikasikan Hak Milik / Hak lain / Tak diketahui.
6. **Penyimpanan** — hasil disimpan di `localStorage` (same-origin), dedup berdasarkan NIB; tanah kosong dibuang otomatis.

**API konsol** untuk debugging manual (ketik di Console):

```js
__BHUMI_REC__.count()      // { total, milik, lain, unknown }
__BHUMI_REC__.breakdown()  // Breakdown by right type
__BHUMI_REC__.geojson()    // GeoJSON string
__BHUMI_REC__.cleanup()    // Clean up: remove vacant land entries and merge duplicates
__BHUMI_REC__.clear()      // Delete all recorded data
```

---

## 🧭 Etika & penggunaan wajar

- Alat ini hanya merekam saat **kamu** menjelajah manual — **jangan** dipakai untuk klik/crawl otomatis massal. Perlakukan server pemerintah dengan wajar.
- Data untuk **keperluan pribadi**. Jangan menyebarluaskan data secara massal.
- Skrip berjalan **di dalam** situs BHUMI (same-origin) dan **tidak menembus proteksi apa pun** — ia hanya mencatat data yang memang sudah kamu lihat di layar.

---

## 🛠️ Kalau bermasalah

| Gejala | Solusi |
|--------|--------|
| Panel tidak muncul | Refresh; pastikan Tampermonkey aktif & skrip ada; cek alamat memang `bhumi.atrbpn.go.id`. |
| Klik bidang, angka tak naik | Pastikan layer **Bidang Tanah** aktif + disclaimer disetujui. Buka Console (F12), cek log `[BHUMI-REC]`, kirim log-nya. |
| Angka naik tapi label "Tidak diketahui" | Nama field tipe hak beda dari perkiraan — kirim satu log `[BHUMI-REC] tangkap …`. |
| GeoJSON terbuka tapi peta kosong | Data mungkin terekam via panel (tanpa koordinat). Atributnya tetap ada di CSV. |
| Panel bilang "Menyiapkan penanda peta…" terus | Skrip belum menempel ke peta BHUMI. Penanda **selalu** tetap tampil di `viewer.html`. |
| Tombol download tak jalan | Cek izin pop-up/unduh browser; coba lagi. |

---

## 📁 Struktur folder

```
bhumi-recorder/
├── bhumi-recorder.user.js   # recorder script (installed in Tampermonkey)
├── viewer.html              # local map viewer (offline)
├── docs/
│   ├── panel-preview.png    # panel UI illustration
│   └── viewer-preview.png   # viewer UI illustration
└── README.md
```

---

## 🤝 Kontribusi

Kontribusi sangat diterima! Karena BHUMI kadang mengubah struktur datanya, bantuan paling berharga adalah:

- **Log `[BHUMI-REC]`** dari Console saat field terlihat aneh — bantu finalisasi pemetaan field.
- Perbaikan deteksi instance peta / penanganan versi peta baru.
- Perbaikan `viewer.html` (label, filter, ekspor).

Alur: fork → buat branch → uji manual di `bhumi.atrbpn.go.id` (sertakan langkah reproduksi) → buka Pull Request. Ikuti gaya kode yang ada (vanilla JS, tanpa dependensi, komentar berbahasa Inggris).

Ada bug atau usul fitur? Buka **[Issue](https://github.com/mhrdwan/bhumi-recorder/issues)**.

---

## 📄 Lisensi

Dirilis di bawah [Lisensi MIT](LICENSE) © [mhrdwan](https://github.com/mhrdwan) — bebas dipakai, diubah, dan disebarkan.

---

<div align="center">

*Sumber data: Kementerian ATR/BPN — BHUMI. Basemap penampil: OpenStreetMap.*
**Alat ini tidak berafiliasi dengan ATR/BPN.**

</div>
