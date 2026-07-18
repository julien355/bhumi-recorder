// ==UserScript==
// @name         BHUMI Recorder — Perekam Bidang Tanah & Status Hak
// @namespace    https://github.com/mhrdwan/bhumi-recorder
// @version      1.5.0
// @description  Rekam otomatis bidang tanah yang diklik di peta BHUMI, beri PENANDA di peta + rincian per jenis hak (Hak Milik/HGB/dll) & daftar bidang langsung di panel, ekspor GeoJSON & CSV.
// @author       mhrdwan
// @homepageURL  https://github.com/mhrdwan/bhumi-recorder
// @supportURL   https://github.com/mhrdwan/bhumi-recorder/issues
// @updateURL    https://raw.githubusercontent.com/mhrdwan/bhumi-recorder/main/bhumi-recorder.user.js
// @downloadURL  https://raw.githubusercontent.com/mhrdwan/bhumi-recorder/main/bhumi-recorder.user.js
// @match        https://bhumi.atrbpn.go.id/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * Cara kerja singkat:
 * 1. Skrip terpasang SEBELUM aplikasi peta memuat (@run-at document-start) lalu
 *    membungkus window.fetch + XMLHttpRequest supaya bisa "mengintip" data JSON
 *    (GetFeatureInfo) yang diambil peta BHUMI ketika kamu mengeklik sebuah bidang.
 * 2. Sebagai cadangan (kalau hook jaringan tidak jalan karena CSP/isolasi), skrip
 *    juga membaca panel info di layar (DOM scrape) via MutationObserver.
 * 3. Setiap bidang dinormalisasi (Tipe Hak, NIB, Luas, Penggunaan), diberi label
 *    Hak Milik / Hak lain / Tak diketahui, lalu disimpan di localStorage (dedup by NIB).
 * 4. Panel kecil di pojok kanan-bawah menampilkan hitungan + tombol Download.
 *
 * CATATAN: nama field asli belum bisa dipastikan dari luar. Karena itu DEBUG=true
 * di run pertama — buka Console (F12) dan lihat log "[BHUMI-REC]" untuk melihat
 * skema aslinya, lalu beri tahu agar mapping field difinalkan.
 */

(function () {
  'use strict';

  // Hindari inisialisasi ganda (SPA bisa mengeksekusi ulang).
  if (window.__BHUMI_REC_ACTIVE__) return;
  window.__BHUMI_REC_ACTIVE__ = true;

  // =====================================================================
  // Konfigurasi
  // =====================================================================
  var STORE_KEY = 'bhumi_recorder_v1';
  var SEARCH_KEY = 'bhumi_recorder_searches_v1';
  var CFG_KEY = 'bhumi_recorder_cfg_v1';
  var MAX_ITEMS = 5000;

  var cfg = loadJson(CFG_KEY, { recording: true, debug: true });
  function log() {
    if (cfg.debug && window.console) {
      var a = ['%c[BHUMI-REC]', 'color:#0a7d3c;font-weight:bold'];
      console.log.apply(console, a.concat([].slice.call(arguments)));
    }
  }

  // =====================================================================
  // Penyimpanan (localStorage, same-origin)
  // =====================================================================
  function loadJson(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { log('gagal simpan', key, e); }
  }

  var store = loadJson(STORE_KEY, {});      // { dedupKey: feature }
  var searches = loadJson(SEARCH_KEY, []);  // [{ q, ts }]
  var lastSearch = searches.length ? searches[searches.length - 1].q : '';

  function persist() { saveJson(STORE_KEY, store); }

  // Rapikan data yang sudah tersimpan (dijalankan sekali saat mulai):
  //  - buang entri tanpa NIB (tanah kosong / bukan bidang terdaftar),
  //  - satukan entri ber-NIB sama yang mungkin dulu terekam dobel (mis. dulu
  //    berkunci koordinat/timestamp sebelum syarat NIB ada).
  // Ini memperbaiki data lama tanpa perlu "Hapus" manual.
  function cleanupStore() {
    var next = {}, changed = false, dropped = 0, merged = 0;
    Object.keys(store).forEach(function (k) {
      var f = store[k];
      var nib = (f && f.properties) ? String(f.properties.nib || '').trim() : '';
      if (!nib) { changed = true; dropped++; return; }      // tanah kosong → buang
      var nk = 'nib:' + nib;
      if (next[nk]) { next[nk] = mergeFeatures(next[nk], f); changed = true; merged++; }
      else { next[nk] = f; if (nk !== k) changed = true; }
    });
    if (changed) { store = next; persist(); log('rapikan data: buang ' + dropped + ' tanpa-NIB, gabung ' + merged + ' dobel'); }
    return { dropped: dropped, merged: merged };
  }

  // =====================================================================
  // Normalisasi field + klasifikasi Hak Milik
  // =====================================================================
  // Pola nama-field yang dicari (case-insensitive). Urutan = prioritas.
  var FIELD_PATTERNS = {
    tipe_hak: [/tipe.?hak/i, /jenis.?hak/i, /nama.?hak/i, /status.?hak/i, /^hak$/i, /haktext/i],
    nib: [/^nib$/i, /nomor.?identifikasi.?bidang/i, /\bnib\b/i, /nibel/i],
    luas: [/luas.?tertulis/i, /luas.?peta/i, /\bluas\b/i, /area/i, /shape.?area/i],
    penggunaan: [/penggunaan/i, /guna.?tanah/i, /^guna$/i, /landuse/i]
  };

  function pick(props, patterns) {
    if (!props) return '';
    var keys = Object.keys(props);
    for (var p = 0; p < patterns.length; p++) {
      for (var k = 0; k < keys.length; k++) {
        if (patterns[p].test(keys[k])) {
          var val = props[keys[k]];
          if (val != null && String(val).trim() !== '') return String(val).trim();
        }
      }
    }
    return '';
  }

  // Kembalikan { kategori, warna, is_hak_milik } dari string tipe hak.
  function classifyHak(tipeHak) {
    var v = (tipeHak || '').toLowerCase();
    if (/hak\s*milik|(^|[^a-z])hm([^a-z]|$)/.test(v)) {
      return { kategori: 'Hak Milik', warna: '#1a9850', is_hak_milik: true };
    }
    if (v.trim() === '') {
      return { kategori: 'Tidak diketahui', warna: '#9e9e9e', is_hak_milik: false };
    }
    // Hak lain yang terdaftar (HGB, HGU, Hak Pakai, HPL, Wakaf, dll.)
    return { kategori: 'Hak lain', warna: '#e6a010', is_hak_milik: false };
  }

  // Kumpulkan semua pasangan koordinat [x,y] dari geometry apa pun.
  function collectCoords(geom, out) {
    out = out || [];
    if (!geom) return out;
    var c = geom.coordinates != null ? geom.coordinates : geom;
    (function walk(a) {
      if (!Array.isArray(a)) return;
      if (a.length >= 2 && typeof a[0] === 'number' && typeof a[1] === 'number') {
        out.push([a[0], a[1]]);
      } else {
        for (var i = 0; i < a.length; i++) walk(a[i]);
      }
    })(c);
    return out;
  }

  function centroidOf(geom) {
    var pts = collectCoords(geom);
    if (!pts.length) return null;
    var sx = 0, sy = 0;
    for (var i = 0; i < pts.length; i++) { sx += pts[i][0]; sy += pts[i][1]; }
    return [sx / pts.length, sy / pts.length]; // [lon, lat] (asumsi EPSG:4326)
  }

  function normalize(rawProps, geometry, source) {
    var tipe = pick(rawProps, FIELD_PATTERNS.tipe_hak);
    var cls = classifyHak(tipe);
    // Tak ada geometri? Pakai koordinat klik terakhir (dari request getPersil) bila masih segar.
    if (!geometry && pendingCoord && (Date.now() - pendingCoord.ts) < 8000) {
      geometry = { type: 'Point', coordinates: pendingCoord.lonlat };
      pendingCoord = null; // pakai sekali agar tak salah tempel ke bidang lain
    }
    var cen = centroidOf(geometry);
    return {
      type: 'Feature',
      geometry: geometry || (cen ? { type: 'Point', coordinates: cen } : null),
      properties: {
        nib: pick(rawProps, FIELD_PATTERNS.nib),
        tipe_hak: tipe,
        kategori: cls.kategori,
        is_hak_milik: cls.is_hak_milik,
        warna: cls.warna,
        penggunaan: pick(rawProps, FIELD_PATTERNS.penggunaan),
        luas: pick(rawProps, FIELD_PATTERNS.luas),
        lon: cen ? cen[0] : '',
        lat: cen ? cen[1] : '',
        search_term: lastSearch,
        source: source,
        recorded_at: new Date().toISOString(),
        raw: rawProps || {}
      }
    };
  }

  function dedupKey(feature) {
    var p = feature.properties;
    if (p.nib) return 'nib:' + p.nib;
    if (p.lat && p.lon) return 'geo:' + Number(p.lat).toFixed(6) + ',' + Number(p.lon).toFixed(6);
    return 'ts:' + Date.now() + ':' + Math.floor(performance.now());
  }

  function meaningful(feature) {
    var p = feature.properties;
    // WAJIB punya NIB. Klik yang tak menghasilkan NIB = tanah kosong / bukan bidang
    // terdaftar → jangan dihitung, dan (karena tak ada NIB) jangan sampai membuat
    // titik baru berulang di wilayah yang sama. Dengan syarat ini, kunci dedup SELALU
    // memakai NIB, jadi klik ulang bidang yang sama = 1 entri (digabung), bukan titik baru.
    return !!(p.nib && String(p.nib).trim());
  }

  // Titik masuk perekaman.
  function record(rawProps, geometry, source) {
    if (!cfg.recording) return;
    var feature;
    try { feature = normalize(rawProps, geometry, source); } catch (e) { log('normalize gagal', e); return; }
    if (!meaningful(feature)) { log('dilewati (tak ada atribut relevan)', source, rawProps); return; }

    var key = dedupKey(feature);
    var existed = !!store[key];
    if (existed) feature = mergeFeatures(store[key], feature); // gabung lama+baru; tipe hak yang terisi menang

    store[key] = feature;

    // Batasi ukuran store.
    var keys = Object.keys(store);
    if (keys.length > MAX_ITEMS) delete store[keys[0]];

    // Tandai kalau bidang ini SUDAH pernah direkam (biar user tahu "pernah di sini").
    if (existed) lastRepeat = { nib: feature.properties.nib, kategori: feature.properties.kategori, ts: Date.now() };

    persist();
    schedulePins(); // perbarui penanda di peta BHUMI
    log('REKAM', source, feature.properties.kategori, feature.properties.nib || '(tanpa NIB)', feature.properties.tipe_hak, feature);
    schedulePanel();
  }

  // Gabungkan dua fitur ber-NIB sama: pertahankan nilai yang terisi + geometri bila ada,
  // lalu hitung ulang klasifikasi hak. Inilah yang membuat entri "Tidak diketahui" bisa
  // ter-upgrade begitu datang data yang memuat tipe hak (mis. dari URL rating_layer).
  function mergeFeatures(oldF, newF) {
    var op = oldF.properties, np = newF.properties;
    function prefer(a, b) { return (a != null && String(a).trim() !== '') ? a : b; }
    var tipe = prefer(np.tipe_hak, op.tipe_hak);
    var cls = classifyHak(tipe);
    var geom = oldF.geometry || newF.geometry;
    var cen = centroidOf(geom);
    var src = op.source === np.source ? op.source
      : (String(op.source || '').split('+').indexOf(np.source) >= 0 ? op.source : (op.source + '+' + np.source));
    return {
      type: 'Feature', geometry: geom,
      properties: {
        nib: prefer(np.nib, op.nib),
        tipe_hak: tipe,
        kategori: cls.kategori, is_hak_milik: cls.is_hak_milik, warna: cls.warna,
        penggunaan: prefer(np.penggunaan, op.penggunaan),
        luas: prefer(np.luas, op.luas),
        lon: cen ? cen[0] : prefer(np.lon, op.lon),
        lat: cen ? cen[1] : prefer(np.lat, op.lat),
        search_term: prefer(np.search_term, op.search_term),
        source: src,
        recorded_at: np.recorded_at,
        raw: Object.assign({}, op.raw, np.raw)
      }
    };
  }

  // Terima payload JSON apa pun, ekstrak fitur-fiturnya.
  function ingestJson(url, data, source) {
    if (!data) return;
    log('tangkap', source, url, data);
    try {
      if (Array.isArray(data.features)) {
        data.features.forEach(function (ft) { record(ft.properties || ft.attributes || {}, ft.geometry, source); });
      } else if (Array.isArray(data.results)) { // format ArcGIS identify
        data.results.forEach(function (r) { record(r.attributes || {}, r.geometry || null, source); });
      } else if (data.type === 'Feature') {
        record(data.properties || {}, data.geometry, source);
      } else if (Array.isArray(data)) {
        data.forEach(function (r) { if (r && typeof r === 'object') record(r.properties || r.attributes || r, r.geometry || null, source); });
      }
    } catch (e) { log('ingest gagal', e); }
  }

  // Sebagian endpoint BHUMI menaruh info bidang di QUERY URL, mis.:
  //   /api/rating_layer?layer=persil&nib=07297&luas=511&tipehak=Hak+Guna+Bangunan&...
  // Ambil langsung dari URL — jauh lebih andal daripada body yang sering terenkripsi.
  function ingestUrlParams(url, source) {
    try {
      var qi = url.indexOf('?');
      if (qi < 0) return;
      var params = {};
      url.slice(qi + 1).split('&').forEach(function (pair) {
        var idx = pair.indexOf('=');
        if (idx < 0) return;
        var k, v;
        try { k = decodeURIComponent(pair.slice(0, idx)); } catch (e) { k = pair.slice(0, idx); }
        try { v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' ')); } catch (e) { v = pair.slice(idx + 1); }
        if (!/^(undefined|null)?$/i.test(v)) params[k] = v;
      });
      // hanya rekam bila jelas soal bidang (punya nib atau tipe hak)
      if (params.tipehak || params.tipe_hak || params.nib || params.NIB) record(params, null, source || 'url');
    } catch (e) { log('parse url gagal', e); }
  }

  function looksLikeParcelUrl(u) {
    return /getfeatureinfo|getfeature\b|\bidentify\b|featureinfo|geoserver|mapproxy|\/mprx\/|arcgis|persil|bidang|info_format|f=json|f=geojson|tipehak|rating_layer|getpersil|expapi/i.test(u || '');
  }

  // =====================================================================
  // Koordinat titik klik (untuk pemetaan)
  // -------------------------------------------------------------------
  // Bentuk poligon bidang dienkripsi BHUMI. Tapi saat mengeklik, aplikasi
  // mengirim koordinat titik ke /expapi/getPersil. Kita coba baca koordinat
  // itu dari body request-nya, lalu tempelkan sebagai geometri Point ke bidang
  // yang direkam beberapa saat setelahnya.
  // =====================================================================
  var pendingCoord = null; // { lonlat:[lon,lat], ts }

  function setPendingCoord(lonlat, src) {
    pendingCoord = { lonlat: lonlat, ts: Date.now() };
    log('koordinat klik:', lonlat, src || '');
  }

  // Pastikan urutan [lon, lat] & masuk akal untuk wilayah Indonesia.
  function normalizeLonLat(a, b) {
    var lonOk = function (x) { return x > 90 && x < 145; };
    var latOk = function (y) { return y > -12 && y < 9; };
    if (lonOk(a) && latOk(b)) return [a, b];
    if (lonOk(b) && latOk(a)) return [b, a];
    return null;
  }

  function tryCoordFromText(text) {
    if (!text || typeof text !== 'string') return null;
    var lat = null, lon = null;
    // 1) coba sebagai JSON (rekursif cari key lat/lon-ish)
    try {
      (function scan(o) {
        if (!o || typeof o !== 'object') return;
        Object.keys(o).forEach(function (k) {
          var v = o[k];
          if (v && typeof v === 'object') { scan(v); return; }
          var num = (typeof v === 'number') ? v
            : (/^-?\d+(\.\d+)?$/.test(String(v)) ? parseFloat(v) : null);
          if (num == null) return;
          if (/(^|_)(lat|latitude|y)$/i.test(k)) lat = num;
          else if (/(^|_)(lon|lng|long|longitude|x)$/i.test(k)) lon = num;
        });
      })(JSON.parse(text));
    } catch (e) {}
    // 2) fallback: cari pola "lon:..,lat:.." di teks apa pun
    if (lat == null || lon == null) {
      var mLon = text.match(/["']?(?:lon|lng|long|longitude|x)["']?\s*[:=]\s*(-?\d+\.\d+)/i);
      var mLat = text.match(/["']?(?:lat|latitude|y)["']?\s*[:=]\s*(-?\d+\.\d+)/i);
      if (mLon) lon = parseFloat(mLon[1]);
      if (mLat) lat = parseFloat(mLat[1]);
    }
    return (lat != null && lon != null) ? normalizeLonLat(lon, lat) : null;
  }

  function handleCoordBody(body) {
    if (body == null) return;
    var s = (typeof body === 'string') ? body : null;
    if (s == null) { try { s = JSON.stringify(body); } catch (e) {} }
    var c = tryCoordFromText(s);
    if (c) setPendingCoord(c);
  }

  function sniffCoordFromRequest(input, init) {
    var body = init && init.body;
    if (body != null) {
      if (cfg.debug) log('req getPersil body:', body);
      handleCoordBody(body);
      return;
    }
    // body bisa berada di dalam objek Request (fetch(new Request(...)))
    if (input && typeof input.clone === 'function') {
      try {
        input.clone().text().then(function (t) {
          if (cfg.debug) log('req getPersil body (Request):', t);
          handleCoordBody(t);
        }).catch(function () {});
      } catch (e) {}
    } else if (cfg.debug) {
      log('req getPersil: (tanpa body terbaca — kemungkinan GET)');
    }
  }

  // =====================================================================
  // Hook jaringan: fetch
  // =====================================================================
  try {
    var _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function (input, init) {
        var promise = _fetch.apply(this, arguments);
        try {
          var url = (input && input.url) ? input.url : String(input || '');
          if (/getpersil/i.test(url)) sniffCoordFromRequest(input, init); // ambil koordinat klik
          if (looksLikeParcelUrl(url)) {
            ingestUrlParams(url, 'peta'); // ambil tipehak/nib/luas dari query URL
            promise.then(function (res) {
              try {
                var ct = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
                if (/json/i.test(ct)) {
                  res.clone().json().then(function (d) { ingestJson(url, d, 'peta'); }).catch(function () {});
                }
              } catch (e) {}
            }).catch(function () {});
          }
        } catch (e) {}
        return promise;
      };
      log('fetch di-hook');
    }
  } catch (e) { log('gagal hook fetch', e); }

  // =====================================================================
  // Hook jaringan: XMLHttpRequest
  // =====================================================================
  try {
    var _open = XMLHttpRequest.prototype.open;
    var _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__bhumiUrl = url;
      return _open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var self = this;
      try { if (/getpersil/i.test(self.__bhumiUrl || '')) { if (cfg.debug) log('req getPersil (xhr body):', body); handleCoordBody(body); } } catch (e) {}
      try {
        if (looksLikeParcelUrl(self.__bhumiUrl)) {
          ingestUrlParams(self.__bhumiUrl, 'peta'); // ambil tipehak/nib/luas dari query URL
          self.addEventListener('load', function () {
            try {
              var txt = self.responseText;
              if (!txt) return;
              var ct = (self.getResponseHeader && self.getResponseHeader('content-type')) || '';
              if (/json/i.test(ct) || /^\s*[\[{]/.test(txt)) {
                ingestJson(self.__bhumiUrl, JSON.parse(txt), 'peta');
              }
            } catch (e) {}
          });
        }
      } catch (e) {}
      return _send.apply(this, arguments);
    };
    log('XHR di-hook');
  } catch (e) { log('gagal hook XHR', e); }

  // =====================================================================
  // Jembatan Peta — taruh PENANDA bidang yang sudah direkam DI peta BHUMI
  // ---------------------------------------------------------------------
  // BHUMI memakai MapLibre GL (lewat react-map-gl). Kalau kita berhasil
  // memperoleh instance peta-nya, kita bisa menaruh titik penanda berwarna
  // (sesuai status hak) tepat di atas peta. Titik itu ikut bergeser saat
  // peta digeser/di-zoom, jadi "keliatan yang sudah pernah dititik" —
  // menempel pada bidang yang sama seperti garis di BHUMI.
  //
  // Bonus penting: begitu instance didapat, kita dengarkan klik peta
  // (map.on('click')) untuk memperoleh koordinat KLIK yang andal — jauh
  // lebih pasti daripada mengintip body getPersil yang kerap terenkripsi.
  // =====================================================================
  var PIN_SRC = 'bhumi_rec_pins';
  var PIN_HALO = 'bhumi_rec_pins_halo';
  var PIN_DOT = 'bhumi_rec_pins_dot';
  var mapInst = null;
  var lastRepeat = null; // { nib, kategori, ts } — bidang yang barusan diulang kliknya

  function mapConnected() { return !!mapInst; }

  // Titik penanda dibangun dari centroid (lon/lat) tiap bidang yang punya koordinat.
  function pinFC() {
    var fs = features().filter(function (f) {
      var p = f && f.properties;
      return p && p.lon !== '' && p.lon != null && p.lat !== '' && p.lat != null &&
        isFinite(Number(p.lon)) && isFinite(Number(p.lat));
    }).map(function (f) {
      var p = f.properties;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [Number(p.lon), Number(p.lat)] },
        properties: { nib: p.nib || '', kategori: p.kategori || 'Tidak diketahui', warna: p.warna || '#9e9e9e', tipe_hak: p.tipe_hak || '' }
      };
    });
    return { type: 'FeatureCollection', features: fs };
  }

  function ensurePinLayers() {
    var m = mapInst;
    if (!m || typeof m.addSource !== 'function') return;
    try {
      if (!m.getSource(PIN_SRC)) m.addSource(PIN_SRC, { type: 'geojson', data: pinFC() });
      if (!m.getLayer(PIN_HALO)) {
        m.addLayer({ id: PIN_HALO, type: 'circle', source: PIN_SRC,
          paint: { 'circle-radius': 12, 'circle-color': ['get', 'warna'], 'circle-opacity': 0.22 } });
      }
      if (!m.getLayer(PIN_DOT)) {
        m.addLayer({ id: PIN_DOT, type: 'circle', source: PIN_SRC,
          paint: { 'circle-radius': 6, 'circle-color': ['get', 'warna'], 'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff' } });
      }
      // Popup kecil saat penanda diklik (kalau MapLibre global tersedia).
      try {
        if (!m.__bhumiPinClick && typeof m.on === 'function') {
          m.__bhumiPinClick = true;
          m.on('click', PIN_DOT, function (e) {
            try {
              var p = (e.features && e.features[0] && e.features[0].properties) || {};
              var lib = window.maplibregl || window.mapboxgl;
              if (lib && lib.Popup) {
                new lib.Popup({ closeButton: true })
                  .setLngLat(e.lngLat)
                  .setHTML('<b>' + (p.kategori || '') + '</b><br>NIB: ' + (p.nib || '-') + '<br>' + (p.tipe_hak || ''))
                  .addTo(m);
              }
            } catch (er) {}
          });
        }
      } catch (er) {}
      renderPins();
      log('penanda peta terpasang');
    } catch (e) { log('pasang layer penanda gagal', e); }
  }

  function renderPins() {
    var m = mapInst;
    if (!m) return;
    try { var s = m.getSource(PIN_SRC); if (s && s.setData) s.setData(pinFC()); } catch (e) {}
  }

  // Terbang ke satu bidang di peta BHUMI (dipakai dari daftar di panel).
  function flyToFeature(f) {
    var p = f && f.properties;
    if (!mapInst || !p || p.lon === '' || p.lat === '' || !isFinite(Number(p.lon)) || !isFinite(Number(p.lat))) return;
    try {
      if (typeof mapInst.flyTo === 'function') mapInst.flyTo({ center: [Number(p.lon), Number(p.lat)], zoom: 18 });
    } catch (e) {}
  }

  // Zoom peta agar SEMUA penanda terlihat sekaligus ("lihat semua di sini").
  function fitAllPins() {
    if (!mapInst) return;
    var fs = pinFC().features;
    if (!fs.length) return;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    fs.forEach(function (f) {
      var c = f.geometry.coordinates;
      if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
    });
    try {
      if (minX === maxX && minY === maxY) {
        if (typeof mapInst.flyTo === 'function') mapInst.flyTo({ center: [minX, minY], zoom: 17 });
      } else if (typeof mapInst.fitBounds === 'function') {
        mapInst.fitBounds([[minX, minY], [maxX, maxY]], { padding: 60, maxZoom: 18 });
      }
    } catch (e) {}
  }

  var pinTimer = null;
  function schedulePins() {
    if (!mapInst || pinTimer) return;
    pinTimer = setTimeout(function () { pinTimer = null; renderPins(); }, 150);
  }

  function bindMap(m) {
    if (mapInst || !m) return;
    mapInst = m;
    log('peta BHUMI terhubung ✓');
    try {
      if (typeof m.on === 'function') {
        m.on('click', function (e) {
          try { if (e && e.lngLat) setPendingCoord([e.lngLat.lng, e.lngLat.lat], 'peta-klik'); } catch (er) {}
        });
      }
    } catch (e) {}
    try {
      if (m.isStyleLoaded && m.isStyleLoaded()) ensurePinLayers();
      else if (typeof m.once === 'function') m.once('load', ensurePinLayers);
      else ensurePinLayers();
      // Basemap bisa berganti (mis. ganti citra satelit) → sumber/layer hilang, pasang ulang.
      if (typeof m.on === 'function') m.on('styledata', function () {
        try { if (!m.getSource(PIN_SRC)) ensurePinLayers(); } catch (e) {}
      });
    } catch (e) { log('bind style gagal', e); }
    schedulePanel();
  }

  // --- Strategi 1: cegat pustaka global maplibregl/mapboxgl bila ada ---
  function patchMapLib(lib) {
    if (!lib || typeof lib.Map !== 'function' || lib.__bhumiPatched) return;
    var Orig = lib.Map;
    function Wrapped() {
      var args = [].slice.call(arguments);
      var inst = new (Function.prototype.bind.apply(Orig, [null].concat(args)))();
      try { bindMap(inst); } catch (e) {}
      return inst;
    }
    Wrapped.prototype = Orig.prototype;
    try { Object.keys(Orig).forEach(function (k) { try { Wrapped[k] = Orig[k]; } catch (e) {} }); } catch (e) {}
    try { lib.Map = Wrapped; lib.__bhumiPatched = true; log('pustaka peta di-patch'); } catch (e) {}
  }
  function trapMapGlobal(name) {
    try {
      var cur = window[name];
      if (cur) { patchMapLib(cur); return; }
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return cur; },
        set: function (v) { cur = v; try { patchMapLib(v); } catch (e) {} }
      });
    } catch (e) {}
  }

  // --- Strategi 2: telusuri React fiber untuk menemukan instance peta ---
  // (react-map-gl mem-bundle maplibre secara privat, jadi seringkali tidak
  //  ada di window; kita cari objek yang "berperilaku seperti peta MapLibre".)
  function looksLikeMap(o) {
    return o && typeof o === 'object' &&
      typeof o.addSource === 'function' && typeof o.getCanvas === 'function' &&
      typeof o.project === 'function' && typeof o.on === 'function';
  }
  function fiberOf(node) {
    if (!node) return null;
    for (var k in node) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return node[k];
    }
    return null;
  }
  function scanFiberForMap(root) {
    var seen = (typeof Set === 'function') ? new Set() : null;
    var queue = [root], steps = 0;
    while (queue.length && steps < 5000) {
      steps++;
      var fib = queue.shift();
      if (!fib) continue;
      if (seen) { if (seen.has(fib)) continue; seen.add(fib); }
      var buckets = [fib.stateNode, fib.memoizedProps, fib.memoizedState];
      for (var b = 0; b < buckets.length; b++) {
        var obj = buckets[b];
        if (looksLikeMap(obj)) return obj;
        if (obj && typeof obj === 'object') {
          try {
            if (looksLikeMap(obj.current)) return obj.current;
            if (looksLikeMap(obj._map)) return obj._map;
            if (typeof obj.getMap === 'function') { var mm = obj.getMap(); if (looksLikeMap(mm)) return mm; }
          } catch (e) {}
          if (b === 2) { // rantai hook: memoizedState.next
            var hook = obj, hops = 0;
            while (hook && hops < 80) {
              try {
                var ms = hook.memoizedState;
                if (looksLikeMap(ms)) return ms;
                if (ms && typeof ms === 'object') {
                  if (looksLikeMap(ms.current)) return ms.current;
                  if (looksLikeMap(ms._map)) return ms._map;
                }
              } catch (e) {}
              hook = hook.next; hops++;
            }
          }
        }
      }
      if (fib.child) queue.push(fib.child);
      if (fib.sibling) queue.push(fib.sibling);
    }
    return null;
  }
  function findMapViaFiber() {
    if (!document.querySelectorAll) return null;
    var nodes = document.querySelectorAll('.maplibregl-map, .mapboxgl-map, canvas.maplibregl-canvas, canvas.mapboxgl-canvas');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var start = (n.closest && (n.classList && (n.classList.contains('maplibregl-canvas') || n.classList.contains('mapboxgl-canvas'))))
        ? (n.closest('.maplibregl-map, .mapboxgl-map') || n) : n;
      var fib = fiberOf(start) || fiberOf(n);
      if (!fib) continue;
      var top = fib, up = 0;
      while (top.return && up < 40) { top = top.return; up++; }
      var found = scanFiberForMap(top);
      if (found) return found;
    }
    return null;
  }

  function initMapBridge() {
    trapMapGlobal('maplibregl');
    trapMapGlobal('mapboxgl');
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (mapInst) { clearInterval(iv); return; }
      try { var m = findMapViaFiber(); if (m) { bindMap(m); clearInterval(iv); return; } } catch (e) {}
      if (tries > 80) { clearInterval(iv); log('peta tak terdeteksi — penanda tetap tersedia di viewer.html'); }
    }, 750);
  }

  // =====================================================================
  // Cadangan: baca panel info di DOM (MutationObserver) — tahan-CSP
  // =====================================================================
  var PANEL_LABELS = {
    tipe_hak: /tipe\s*hak|jenis\s*hak/i,
    nib: /\bnib\b/i,
    luas: /\bluas\b/i,
    penggunaan: /penggunaan/i
  };

  function scrapeText(text) {
    if (!text || text.length > 4000) return; // panel info umumnya pendek
    if (!PANEL_LABELS.tipe_hak.test(text) && !PANEL_LABELS.nib.test(text)) return;
    var props = {};
    grab(text, PANEL_LABELS.tipe_hak, 'tipe_hak', props);
    grab(text, PANEL_LABELS.nib, 'nib', props);
    grab(text, PANEL_LABELS.luas, 'luas', props);
    grab(text, PANEL_LABELS.penggunaan, 'penggunaan', props);
    if (Object.keys(props).length) record(props, null, 'panel');
  }
  function grab(text, labelRe, key, out) {
    // Cari "Label : nilai" atau "Label\n nilai"
    var re = new RegExp(labelRe.source + '\\s*[:\\-]?\\s*([^\\n\\r|]{1,80})', 'i');
    var m = text.match(re);
    if (m && m[1]) {
      var val = m[1].trim().replace(/\s{2,}/g, ' ');
      if (val && !PANEL_LABELS.tipe_hak.test(val + ' x')) out[key] = val;
    }
  }

  var scrapeTimer = null;
  function startObserver() {
    try {
      var mo = new MutationObserver(function (muts) {
        if (scrapeTimer) return;
        scrapeTimer = setTimeout(function () {
          scrapeTimer = null;
          for (var i = 0; i < muts.length; i++) {
            var added = muts[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var n = added[j];
              if (n.nodeType === 1) {
                var t = (n.innerText || n.textContent || '');
                if (PANEL_LABELS.tipe_hak.test(t) || PANEL_LABELS.nib.test(t)) scrapeText(t);
              }
            }
          }
        }, 250);
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      log('observer DOM aktif');
    } catch (e) { log('observer gagal', e); }
  }

  // =====================================================================
  // Rekam kata kunci pencarian
  // =====================================================================
  function isTextInput(el) {
    return el && el.tagName === 'INPUT' &&
      /^(text|search|)$/i.test(el.type || '') &&
      (el.value || '').trim().length > 0;
  }
  function addSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    if (searches.length && searches[searches.length - 1].q === q) return;
    searches.push({ q: q, ts: new Date().toISOString() });
    if (searches.length > 500) searches.shift();
    lastSearch = q;
    saveJson(SEARCH_KEY, searches);
    log('CARI', q);
    schedulePanel();
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && isTextInput(e.target)) addSearch(e.target.value);
  }, true);
  document.addEventListener('change', function (e) {
    if (isTextInput(e.target)) addSearch(e.target.value);
  }, true);

  // =====================================================================
  // Ekspor
  // =====================================================================
  function features() { return Object.keys(store).map(function (k) { return store[k]; }); }

  function toGeoJSON() {
    return JSON.stringify({ type: 'FeatureCollection', features: features() }, null, 2);
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    return '"' + v.replace(/"/g, '""') + '"';
  }
  function toCSV() {
    var cols = ['nib', 'tipe_hak', 'kategori', 'is_hak_milik', 'penggunaan', 'luas', 'lon', 'lat', 'search_term', 'source', 'recorded_at'];
    var rows = [cols.join(',')];
    features().forEach(function (f) {
      var p = f.properties;
      rows.push(cols.map(function (c) { return csvCell(p[c]); }).join(','));
    });
    return rows.join('\r\n');
  }

  function download(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
    } catch (e) { alert('Gagal mengunduh: ' + e); }
  }

  // =====================================================================
  // Panel UI
  // =====================================================================
  var panel, panelTimer;
  function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setTimeout(function () { panelTimer = null; renderPanel(); }, 120);
  }

  function counts() {
    var c = { total: 0, milik: 0, lain: 0, unknown: 0 };
    features().forEach(function (f) {
      c.total++;
      if (f.properties.is_hak_milik) c.milik++;
      else if (f.properties.kategori === 'Hak lain') c.lain++;
      else c.unknown++;
    });
    return c;
  }

  // Rincian per JENIS hak persis (Hak Milik, Hak Guna Bangunan, Hak Pakai, dll.),
  // urut dari yang terbanyak. Menjawab "ada berapa hak milik, HGB, dst.".
  function breakdownByType() {
    var m = {};
    features().forEach(function (f) {
      var t = (f.properties.tipe_hak || '').trim() || 'Tidak diketahui';
      if (!m[t]) m[t] = { tipe: t, count: 0, warna: f.properties.warna || '#9e9e9e' };
      m[t].count++;
    });
    return Object.keys(m).map(function (k) { return m[k]; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }
  function btn(label, css) {
    return el('button', 'cursor:pointer;border:0;border-radius:8px;padding:7px 10px;font:600 12px system-ui;color:#fff;' + (css || 'background:#0a7d3c'), label);
  }

  function buildPanel() {
    panel = el('div', [
      'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:290px',
      'background:#ffffff;color:#1b1b1b;border:1px solid #d9d9d9;border-radius:14px',
      'box-shadow:0 10px 30px rgba(0,0,0,.22);font:13px/1.4 system-ui,-apple-system,sans-serif',
      'overflow:hidden'
    ].join(';'));

    var head = el('div', 'display:flex;align-items:center;gap:8px;padding:10px 12px;background:#0a7d3c;color:#fff');
    head.appendChild(el('span', 'font-size:15px', '🗺️'));
    head.appendChild(el('strong', 'flex:1;font-size:13px', 'BHUMI Recorder'));
    var min = el('span', 'cursor:pointer;opacity:.85;font-size:16px', '–');
    head.appendChild(min);
    panel.appendChild(head);

    var body = el('div', 'padding:12px');
    body.id = 'bhumi-rec-body';
    panel.appendChild(body);

    min.addEventListener('click', function () {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
      min.textContent = body.style.display === 'none' ? '+' : '–';
    });

    // Tempel ke <html>, BUKAN <body> — SPA BHUMI mengganti isi <body> saat mount
    // sehingga panel di dalam body akan ikut terhapus.
    document.documentElement.appendChild(panel);
  }

  function renderPanel() {
    if (!document.documentElement) return;
    if (!panel) buildPanel();
    var body = panel.querySelector('#bhumi-rec-body');
    if (!body) return;
    var c = counts();
    body.innerHTML = '';

    // Status merekam
    var recRow = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:10px');
    var dot = el('span', 'width:10px;height:10px;border-radius:50%;background:' + (cfg.recording ? '#e11' : '#999') +
      (cfg.recording ? ';box-shadow:0 0 0 4px rgba(238,17,17,.18)' : ''));
    recRow.appendChild(dot);
    recRow.appendChild(el('span', 'flex:1;font-weight:600', cfg.recording ? 'Sedang merekam' : 'Jeda'));
    var toggle = el('span', 'cursor:pointer;color:#0a7d3c;font-weight:600;font-size:12px', cfg.recording ? 'Jeda' : 'Lanjut');
    toggle.addEventListener('click', function () { cfg.recording = !cfg.recording; saveJson(CFG_KEY, cfg); renderPanel(); });
    recRow.appendChild(toggle);
    body.appendChild(recRow);

    // Status penanda di peta
    var mp = mapConnected();
    body.appendChild(el('div',
      'font-size:11px;margin-bottom:10px;padding:6px 8px;border-radius:8px;' +
      (mp ? 'background:#eaf7ee;color:#0a7d3c' : 'background:#f3f4f6;color:#777'),
      mp ? '📍 Penanda AKTIF di peta — bidang yang sudah direkam ditandai titik berwarna.'
         : '📍 Menyiapkan penanda peta… (kalau tak muncul, semua titik tetap ada di viewer.html)'));

    // Tombol "lihat semua titik" (kalau peta terhubung & ada koordinat)
    if (mp && pinFC().features.length) {
      var seeAll = btn('🔍 Lihat semua titik di peta', 'background:#0a7d3c');
      seeAll.style.width = '100%'; seeAll.style.marginBottom = '10px';
      seeAll.addEventListener('click', fitAllPins);
      body.appendChild(seeAll);
    }

    // Baru saja klik bidang yang PERNAH direkam?
    if (lastRepeat && (Date.now() - lastRepeat.ts) < 6000) {
      body.appendChild(el('div',
        'font-size:11px;margin-bottom:10px;padding:6px 8px;border-radius:8px;background:#eef3ff;color:#1c4dab',
        '✓ Sudah pernah direkam: ' + (lastRepeat.nib || '(tanpa NIB)') + ' — ' + lastRepeat.kategori));
    }

    // Angka besar
    var big = el('div', 'font:800 28px system-ui;line-height:1', String(c.total));
    body.appendChild(big);
    body.appendChild(el('div', 'color:#666;font-size:11px;margin-bottom:10px', 'bidang terekam'));

    // Rincian kategori
    var grid = el('div', 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;text-align:center');
    grid.appendChild(chip('Hak Milik', c.milik, '#1a9850'));
    grid.appendChild(chip('Hak lain', c.lain, '#e6a010'));
    grid.appendChild(chip('? / kosong', c.unknown, '#9e9e9e'));
    body.appendChild(grid);

    // Rincian per JENIS hak (Hak Milik, HGB, Hak Pakai, dll.)
    var bd = breakdownByType();
    if (bd.length) {
      body.appendChild(el('div', 'font-size:10px;color:#888;margin-bottom:4px', 'Rincian per jenis hak'));
      var bdWrap = el('div', 'border:1px solid #eee;border-radius:8px;overflow:hidden;margin-bottom:10px');
      bd.forEach(function (row, i) {
        var r = el('div', 'display:flex;align-items:center;gap:8px;padding:5px 9px;' + (i ? 'border-top:1px solid #f2f2f2' : ''));
        r.appendChild(el('span', 'width:9px;height:9px;border-radius:50%;flex:none;background:' + row.warna));
        r.appendChild(el('span', 'flex:1;font-size:11px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', row.tipe));
        r.appendChild(el('span', 'font:800 12px system-ui;color:#222', String(row.count)));
        bdWrap.appendChild(r);
      });
      body.appendChild(bdWrap);
    }

    // Daftar bidang (buka/tutup) — klik salah satu untuk terbang ke titiknya di peta
    if (c.total) {
      var listBtn = el('div', 'cursor:pointer;color:#0a7d3c;font-weight:600;font-size:11px;margin-bottom:6px',
        (cfg.listOpen ? '▾ ' : '▸ ') + 'Daftar bidang (' + c.total + ')');
      body.appendChild(listBtn);
      var listBox = el('div', 'max-height:150px;overflow:auto;border:1px solid #eee;border-radius:8px;margin-bottom:10px;display:' + (cfg.listOpen ? 'block' : 'none'));
      features().slice().reverse().forEach(function (f, i) {
        var p = f.properties;
        var can = mp && p.lon !== '' && p.lat !== '' && isFinite(Number(p.lon));
        var row = el('div', 'display:flex;align-items:center;gap:6px;padding:5px 8px;' + (i ? 'border-top:1px solid #f4f4f4;' : '') + (can ? 'cursor:pointer' : ''));
        row.appendChild(el('span', 'width:8px;height:8px;border-radius:50%;flex:none;background:' + (p.warna || '#9e9e9e')));
        row.appendChild(el('span', 'flex:1;font-size:11px;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
          (p.nib || '(tanpa NIB)') + ' · ' + (p.tipe_hak || '—')));
        if (can) { row.title = 'Klik untuk sorot di peta'; row.appendChild(el('span', 'font-size:11px;flex:none', '📍')); row.addEventListener('click', function () { flyToFeature(f); }); }
        listBox.appendChild(row);
      });
      body.appendChild(listBox);
      listBtn.addEventListener('click', function () { cfg.listOpen = !cfg.listOpen; saveJson(CFG_KEY, cfg); renderPanel(); });
    }

    // Hint kalau kosong
    if (c.total === 0) {
      body.appendChild(el('div', 'background:#fff6e5;border:1px solid #ffe0a3;border-radius:8px;padding:8px;font-size:11px;color:#7a5b00;margin-bottom:10px',
        'Belum ada data. Aktifkan layer "Bidang Tanah", setujui disclaimer, lalu klik satu bidang. Buka Console (F12) untuk memeriksa log [BHUMI-REC].'));
    }

    // Pencarian terakhir
    if (lastSearch) {
      body.appendChild(el('div', 'font-size:11px;color:#555;margin-bottom:10px', '🔎 Pencarian terakhir: ' + lastSearch));
    }

    // Tombol
    var row1 = el('div', 'display:flex;gap:6px;margin-bottom:6px');
    var gj = btn('⬇︎ GeoJSON'); gj.style.flex = '1';
    gj.addEventListener('click', function () { download('bhumi-bidang.geojson', toGeoJSON(), 'application/geo+json'); });
    var cv = btn('⬇︎ CSV', 'background:#0a5a7d'); cv.style.flex = '1';
    cv.addEventListener('click', function () { download('bhumi-bidang.csv', '﻿' + toCSV(), 'text/csv;charset=utf-8'); });
    row1.appendChild(gj); row1.appendChild(cv);
    body.appendChild(row1);

    var row2 = el('div', 'display:flex;gap:6px');
    var dbg = btn(cfg.debug ? 'Debug: ON' : 'Debug: OFF', 'background:#555;flex:1');
    dbg.addEventListener('click', function () { cfg.debug = !cfg.debug; saveJson(CFG_KEY, cfg); renderPanel(); });
    var clr = btn('Hapus', 'background:#b33;flex:1');
    clr.addEventListener('click', function () {
      if (confirm('Hapus semua ' + c.total + ' bidang terekam?')) {
        store = {}; searches = []; lastSearch = ''; lastRepeat = null; persist(); saveJson(SEARCH_KEY, searches); renderPins(); renderPanel();
      }
    });
    row2.appendChild(dbg); row2.appendChild(clr);
    body.appendChild(row2);

    body.appendChild(el('div', 'font-size:10px;color:#999;margin-top:8px;text-align:center',
      'Data BHUMI ATR/BPN • tanpa nama pemilik • hanya bidang terdaftar'));
  }

  function chip(label, n, color) {
    var w = el('div', 'background:' + hexA(color, .1) + ';border-radius:8px;padding:6px 2px');
    w.appendChild(el('div', 'font:800 16px system-ui;color:' + color, String(n)));
    w.appendChild(el('div', 'font-size:9px;color:#555', label));
    return w;
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // API kecil untuk debugging manual dari Console.
  window.__BHUMI_REC__ = {
    dump: function () { console.log(store); return store; },
    geojson: toGeoJSON,
    csv: toCSV,
    count: counts,
    breakdown: breakdownByType,
    cleanup: function () { var r = cleanupStore(); renderPins(); renderPanel(); return r; },
    mapConnected: mapConnected,
    clear: function () { store = {}; lastRepeat = null; persist(); renderPins(); renderPanel(); }
  };

  // =====================================================================
  // Inisialisasi setelah DOM siap
  // =====================================================================
  function whenReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  startObserver();
  cleanupStore();  // rapikan data lama: buang tanah kosong & gabung dobel
  initMapBridge(); // coba pasang penanda di peta BHUMI
  whenReady(function () { renderPanel(); });
  // Penjaga: pasang ulang panel bila SPA sempat melepasnya dari DOM.
  setInterval(function () {
    try { if (panel && !panel.isConnected) document.documentElement.appendChild(panel); } catch (e) {}
  }, 1000);
  log('siap. recording=' + cfg.recording + ' debug=' + cfg.debug);
})();
