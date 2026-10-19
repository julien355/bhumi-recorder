// ==UserScript==
// @name         BHUMI Recorder — Land Parcel & Land Rights Recorder
// @namespace    https://github.com/mhrdwan/bhumi-recorder
// @version      1.7.3
// @description  Automatically record land parcels clicked on the BHUMI map, add map MARKERS, show a breakdown by right type (Hak Milik/HGB/etc.) and a parcel list in the panel, and export GeoJSON, CSV, KML & KMZ.
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
 * How it works:
 * 1. The script runs BEFORE the map application loads (@run-at document-start),
 *    then wraps window.fetch + XMLHttpRequest to inspect the JSON data
 *    (GetFeatureInfo) that the BHUMI map retrieves when you click a parcel.
 * 2. As a fallback (if network hooks fail due to CSP/isolation), the script
 *    also reads the on-screen info panel (DOM scraping) via MutationObserver.
 * 3. Each parcel is normalized (right type, NIB, area, land use), classified as
 *    ownership / other rights / unknown, then saved in localStorage (dedup by NIB).
 * 4. A small panel in the bottom-right corner displays counts + download buttons.
 *
 * NOTE: The actual field names cannot yet be confirmed externally, so debugging
 * is enabled on the first run. Open the Console (F12) and inspect "[BHUMI-REC]"
 * logs to see the actual schema, then report it so field mapping can be finalized.
 */

(function () {
  'use strict';

  // Prevent duplicate initialization (the SPA may execute the script again).
  if (window.__BHUMI_REC_ACTIVE__) return;
  window.__BHUMI_REC_ACTIVE__ = true;

  // =====================================================================
  // Configuration
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
  // Storage (localStorage, same-origin)
  // =====================================================================
  function loadJson(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; }
    catch (e) { return fallback; }
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { log('gagal simpan', key, e); }
  }

  // Polygon-capture state (see "Polygon capture" section).
  var lastClick = null;      // { lonlat:[lon,lat], point:[x,y], ts } — latest map click
  var clickSeq = 0;          // increments on every map click
  var polyDoneSeq = 0;       // clickSeq for which a polygon was already attached
  var envelopeCand = null;   // { bbox, ts } — envelope seen before its record existed
  var clickCands = [];       // [{ geom, src, nib, ts }] — polygons seen since the last click
  var lastTouched = null;    // { key, ts } — record created/updated most recently
  var scanUntil = 0;         // JSON.parse hook scans results until this timestamp
  var lastProbe = null;
  var payloadLog = [];       // last decrypted JSON payloads parsed right after a click (for diagnosis)

  var store = loadJson(STORE_KEY, {});      // { dedupKey: feature }
  var searches = loadJson(SEARCH_KEY, []);  // [{ q, ts }]
  var lastSearch = searches.length ? searches[searches.length - 1].q : '';

  function persist() { saveJson(STORE_KEY, store); }

  // Clean up stored data (runs once at startup):
  //  - remove entries without NIB (vacant land / unregistered parcels),
  //  - merge entries with the same NIB that may have been recorded twice (e.g.
  //    using coordinate/timestamp keys before NIB became mandatory).
  // This repairs old data without requiring a manual clear.
  function cleanupStore() {
    var next = {}, changed = false, dropped = 0, merged = 0;
    Object.keys(store).forEach(function (k) {
      var f = store[k];
      var nib = (f && f.properties) ? String(f.properties.nib || '').trim() : '';
      if (!nib) { changed = true; dropped++; return; }      // vacant land → discard
      var nk = 'nib:' + nib;
      if (next[nk]) { next[nk] = mergeFeatures(next[nk], f); changed = true; merged++; }
      else { next[nk] = f; if (nk !== k) changed = true; }
    });
    if (changed) { store = next; persist(); log('rapikan data: buang ' + dropped + ' tanpa-NIB, gabung ' + merged + ' dobel'); }
    return { dropped: dropped, merged: merged };
  }

  // =====================================================================
  // Field normalization + ownership classification
  // =====================================================================
  // Field-name patterns to match (case-insensitive). Order = priority.
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

  // Return { kategori, warna, is_hak_milik } from a right-type string.
  function classifyHak(tipeHak) {
    var v = (tipeHak || '').toLowerCase();
    if (/hak\s*milik|(^|[^a-z])hm([^a-z]|$)/.test(v)) {
      return { kategori: 'Hak Milik', warna: '#1a9850', is_hak_milik: true };
    }
    if (v.trim() === '') {
      return { kategori: 'Tidak diketahui', warna: '#9e9e9e', is_hak_milik: false };
    }
    // Other registered rights (building, cultivation, use, management, endowment, etc.)
    return { kategori: 'Hak lain', warna: '#e6a010', is_hak_milik: false };
  }

  // Collect all [x,y] coordinate pairs from any geometry.
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
    return [sx / pts.length, sy / pts.length]; // [lon, lat] (assuming EPSG:4326)
  }

  function normalize(rawProps, geometry, source) {
    var tipe = pick(rawProps, FIELD_PATTERNS.tipe_hak);
    var cls = classifyHak(tipe);
    // No geometry? Use the latest click coordinates (from the getPersil request) if still recent.
    var geomSource = geometry ? source : '';
    if (!geometry && pendingCoord && (Date.now() - pendingCoord.ts) < 8000) {
      geometry = { type: 'Point', coordinates: pendingCoord.lonlat };
      geomSource = 'click';
      pendingCoord = null; // use once to avoid assigning them to another parcel
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
        geom_source: geomSource,
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
    // NIB is REQUIRED. Clicks returning no NIB = vacant land / unregistered parcels
    // → do not count them or create repeated points in the same area without a NIB.
    // This requirement ensures dedup keys ALWAYS use NIB, so repeated clicks on
    // the same parcel produce one merged entry rather than a new point.
    return !!(p.nib && String(p.nib).trim());
  }

  // Recording entry point.
  function record(rawProps, geometry, source) {
    if (!cfg.recording) return;
    // Preserve main's envelope and area checks on the newly added capture paths.
    var boundaryBox = null;
    if (isPolygon(geometry) && /^(peta-json|peta-highlight)$/.test(source)) {
      geometry = fixGeom(geometry);
      if (geometry && geometryRank(geometry) !== 3) geometry = null;
      if (geometry && isEnvelope(geometry)) {
        boundaryBox = bboxOf(geometry);
        geometry = null;
      }
      if (geometry) {
        var saved = store['nib:' + pick(rawProps, FIELD_PATTERNS.nib)];
        var area = luasOf({ luas: pick(rawProps, FIELD_PATTERNS.luas) || (saved && saved.properties.luas) });
        var ratio = area ? geoAreaM2(geometry) / area : null;
        if (area && (ratio < AREA_MIN || ratio > AREA_MAX)) geometry = null;
      }
    }
    var feature;
    try { feature = normalize(rawProps, geometry, source); } catch (e) { log('normalize gagal', e); return; }
    if (!meaningful(feature)) { log('dilewati (tak ada atribut relevan)', source, rawProps); return; }
    if (boundaryBox) feature.properties.bbox = boundaryBox;

    var key = dedupKey(feature);
    var existed = !!store[key];
    if (existed) feature = mergeFeatures(store[key], feature); // merge old+new; prefer a nonempty right type

    store[key] = feature;

    // Limit the store size.
    var keys = Object.keys(store);
    if (keys.length > MAX_ITEMS) delete store[keys[0]];

    // Flag parcels that have ALREADY been recorded so the user recognizes a repeat visit.
    if (existed) lastRepeat = { nib: feature.properties.nib, kategori: feature.properties.kategori, ts: Date.now() };

    lastTouched = { key: key, ts: Date.now() };
    if (envelopeCand && lastClick && envelopeCand.ts >= lastClick.ts) { feature.properties.bbox = envelopeCand.bbox; envelopeCand = null; }
    applyPolygon(); // attach a polygon captured for this click, if any
    persist();
    schedulePins(); // update markers on the BHUMI map
    log('REKAM', source, feature.properties.kategori, feature.properties.nib || '(tanpa NIB)', feature.properties.tipe_hak, feature);
    schedulePanel();
  }

  // Merge two features with the same NIB: retain nonempty values + available geometry,
  // then recalculate the rights classification. This lets an unknown entry be
  // updated when right-type data arrives (e.g. from a rating_layer URL).
  function isPolygon(g) { return !!g && (g.type === 'Polygon' || g.type === 'MultiPolygon'); }
  function mergeFeatures(oldF, newF) {
    var op = oldF.properties, np = newF.properties;
    function prefer(a, b) { return (a != null && String(a).trim() !== '') ? a : b; }
    var tipe = prefer(np.tipe_hak, op.tipe_hak);
    var cls = classifyHak(tipe);
    // A URL/DOM record often arrives before the decoded parcel polygon.
    // Upgrade points to boundaries, but never downgrade a saved boundary.
    var useNew = !!newF.geometry && geometryRank(newF.geometry) >= geometryRank(oldF.geometry);
    var geom = useNew ? newF.geometry : (oldF.geometry || newF.geometry);
    var geomSource = useNew ? np.geom_source : prefer(op.geom_source, np.geom_source);
    var areaRatio = useNew ? np.poly_area_ratio : prefer(op.poly_area_ratio, np.poly_area_ratio);
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
        geom_source: geomSource || '',
        poly_area_ratio: areaRatio == null ? '' : areaRatio,
        bbox: np.bbox || op.bbox,
        recorded_at: np.recorded_at,
        raw: Object.assign({}, op.raw, np.raw)
      }
    };
  }

  function geometryRank(geometry) {
    if (!geometry) return 0;
    var result = EarthExport.prepare([{ geometry: geometry }]);
    if (!result.valid.length) return 0;
    return result.totals.polygons ? 3 : result.totals.lines ? 2 : 1;
  }

  // BHUMI decodes getPersil responses and then calls JSON.parse in the app.
  // Observe that already-decoded GeoJSON; do not decrypt responses or issue
  // requests. The original parse result (including reviver behavior) is intact.
  // Only parcel features with a NIB are accepted, excluding our own saved data.
  function ingestDecodedFeatures(data, source) {
    if (!data || typeof data !== 'object') return;
    var list = data.type === 'Feature' ? [data] : data.features;
    if (!Array.isArray(list)) return;
    list.forEach(function (f) {
      var p = f && (f.properties || f.attributes);
      if (!p || !pick(p, FIELD_PATTERNS.nib) || (p.recorded_at && p.source)) return;
      record(p, f.geometry || null, source);
    });
  }

  // Accept any JSON payload and extract its features.
  function ingestJson(url, data, source) {
    if (!data) return;
    log('tangkap', source, url, data);
    try {
      if (Array.isArray(data.features)) {
        data.features.forEach(function (ft) { record(ft.properties || ft.attributes || {}, ft.geometry, source); });
      } else if (Array.isArray(data.results)) { // ArcGIS identify format
        data.results.forEach(function (r) { record(r.attributes || {}, r.geometry || null, source); });
      } else if (data.type === 'Feature') {
        record(data.properties || {}, data.geometry, source);
      } else if (Array.isArray(data)) {
        data.forEach(function (r) { if (r && typeof r === 'object') record(r.properties || r.attributes || r, r.geometry || null, source); });
      }
    } catch (e) { log('ingest gagal', e); }
  }

  // Some BHUMI endpoints put parcel info in the URL QUERY, e.g.:
  //   /api/rating_layer?layer=persil&nib=07297&luas=511&tipehak=Hak+Guna+Bangunan&...
  // Read directly from the URL — much more reliable than the often-encrypted body.
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
      // Only record data clearly related to a parcel (with NIB or right type).
      if (params.tipehak || params.tipe_hak || params.nib || params.NIB) record(params, null, source || 'url');
    } catch (e) { log('parse url gagal', e); }
  }

  function looksLikeParcelUrl(u) {
    return /getfeatureinfo|getfeature\b|\bidentify\b|featureinfo|geoserver|mapproxy|\/mprx\/|arcgis|persil|bidang|info_format|f=json|f=geojson|tipehak|rating_layer|getpersil|expapi/i.test(u || '');
  }

  // =====================================================================
  // Click coordinates (for mapping)
  // -------------------------------------------------------------------
  // BHUMI may encrypt parcel responses. On a click, however, the application
  // sends point coordinates to /expapi/getPersil. Try reading those coordinates
  // from the request body, then attach them as Point geometry to the parcel
  // recorded shortly afterward.
  // =====================================================================
  var pendingCoord = null; // { lonlat:[lon,lat], ts }

  function setPendingCoord(lonlat, src) {
    pendingCoord = { lonlat: lonlat, ts: Date.now() };
    log('koordinat klik:', lonlat, src || '');
  }

  // Ensure [lon, lat] order and plausible coordinates for Indonesia.
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
    // 1) Try JSON (recursively search for latitude/longitude-like keys).
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
    // 2) Fallback: look for a "lon:..,lat:.." pattern in any text.
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
    // The body may be inside a Request object (fetch(new Request(...))).
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
  // Network hook: fetch
  // =====================================================================
  try {
    var _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function (input, init) {
        var promise = _fetch.apply(this, arguments);
        try {
          var url = (input && input.url) ? input.url : String(input || '');
          if (/getpersil/i.test(url)) { scanUntil = Date.now() + 6000; sniffCoordFromRequest(input, init); } // read click coordinates
          if (looksLikeParcelUrl(url)) {
            ingestUrlParams(url, 'peta'); // read tipehak/nib/luas from the URL query
            promise.then(function (res) {
              try { if (cfg.debug && /getpersil/i.test(url)) logRawResponse(url, res.clone().text()); } catch (e) {}
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
  // Network hook: XMLHttpRequest
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
      try { if (/getpersil/i.test(self.__bhumiUrl || '')) { scanUntil = Date.now() + 6000; if (cfg.debug) log('req getPersil (xhr body):', body); handleCoordBody(body); } } catch (e) {}
      try {
        if (looksLikeParcelUrl(self.__bhumiUrl)) {
          ingestUrlParams(self.__bhumiUrl, 'peta'); // read tipehak/nib/luas from the URL query
          self.addEventListener('load', function () {
            try {
              var txt = self.responseText;
              if (cfg.debug && /getpersil/i.test(self.__bhumiUrl || '')) logRawResponse(self.__bhumiUrl, txt);
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
  // Map bridge — place MARKERS for recorded parcels ON the BHUMI map
  // ---------------------------------------------------------------------
  // BHUMI uses MapLibre GL (via react-map-gl). Once we obtain its map instance,
  // we can place colored point markers (based on right status) directly on
  // the map. The points follow map panning/zooming, making previously clicked
  // parcels visible while staying attached to the same parcels, just like
  // the boundary lines in BHUMI.
  //
  // Another benefit: once the instance is available, listen for map clicks
  // (map.on('click')) to obtain reliable CLICK coordinates — much more
  // reliable than inspecting the often-encrypted getPersil body.
  // =====================================================================
  var PIN_SRC = 'bhumi_rec_pins';
  var PIN_HALO = 'bhumi_rec_pins_halo';
  var PIN_DOT = 'bhumi_rec_pins_dot';
  var mapInst = null;
  var lastRepeat = null; // { nib, kategori, ts } — parcel that was just clicked again

  function mapConnected() { return !!mapInst; }

  // Build point markers from the centroid (lon/lat) of each parcel with coordinates.
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
      // Show a small popup when a marker is clicked (if a MapLibre global is available).
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

  // Fly to a parcel on the BHUMI map (used by the panel list).
  function flyToFeature(f) {
    var p = f && f.properties;
    if (!mapInst || !p || p.lon === '' || p.lat === '' || !isFinite(Number(p.lon)) || !isFinite(Number(p.lat))) return;
    try {
      if (typeof mapInst.flyTo === 'function') mapInst.flyTo({ center: [Number(p.lon), Number(p.lat)], zoom: 18 });
    } catch (e) {}
  }

  // Zoom the map to show ALL markers at once ("show all here").
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
          try {
            if (e && e.lngLat) {
              setPendingCoord([e.lngLat.lng, e.lngLat.lat], 'peta-klik');
              lastClick = { lonlat: [e.lngLat.lng, e.lngLat.lat], point: e.point ? [e.point.x, e.point.y] : null, ts: Date.now() };
              clickSeq++;
              clickCands = [];
              scanUntil = Math.max(scanUntil, Date.now() + 6000);
              scheduleMapCapture();
            }
          } catch (er) {}
          captureHighlight();
        });
        m.on('sourcedata', function (e) {
          if (e && e.sourceId === 'highlight') captureHighlight();
        });
      }
    } catch (e) {}
    try {
      if (m.isStyleLoaded && m.isStyleLoaded()) ensurePinLayers();
      else if (typeof m.once === 'function') m.once('load', ensurePinLayers);
      else ensurePinLayers();
      // Basemap changes (e.g. switching satellite imagery) remove sources/layers; add them again.
      if (typeof m.on === 'function') m.on('styledata', function () {
        try { if (!m.getSource(PIN_SRC)) ensurePinLayers(); } catch (e) {}
      });
    } catch (e) { log('bind style gagal', e); }
    schedulePanel();
  }

  // Read original GeoJSON rather than queryRenderedFeatures: rendered geometry
  // can be clipped to tiles. Ignore raster sources, bbox and recorder markers.
  // Requiring the feature's own NIB prevents attaching another layer's highlight
  // to whichever parcel happened to be clicked most recently.
  var highlightRead = 0;
  function captureHighlight() {
    if (!cfg.recording || !mapInst) return;
    try {
      var s = mapInst.getSource('highlight');
      if (!s || s.type !== 'geojson') return;
      var read = ++highlightRead;
      function accept(data) {
        if (read !== highlightRead || !cfg.recording || mapInst.getSource('highlight') !== s) return;
        ingestDecodedFeatures(data, 'peta-highlight');
      }
      if (typeof s.getData === 'function') {
        Promise.resolve(s.getData()).then(accept).catch(function () {});
      } else {
        var data = s.serialize ? s.serialize().data : s._data;
        if (data && typeof data === 'object') accept(data);
      }
    } catch (e) { log('baca highlight gagal', e); }
  }

  // --- Strategy 1: intercept global maplibregl/mapboxgl libraries if available ---
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

  // --- Strategy 2: traverse React fibers to find the map instance ---
  // (react-map-gl bundles maplibre privately, so it is often unavailable on
  //  window; look for an object that "behaves like a MapLibre map".)
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
          if (b === 2) { // hook chain: memoizedState.next
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
  // Polygon capture
  // ---------------------------------------------------------------------
  // BHUMI draws the selected parcel as a polygon, so the boundary exists in
  // the browser even though the getPersil body is not plain GeoJSON. We look
  // for it in three places after every map click, and attach the first
  // polygon that CONTAINS the click point to the record that click created:
  //   1. the plaintext JSON the app parses right after the getPersil call
  //      (JSON.parse hook, active only for a few seconds after a click),
  //   2. GeoJSON sources already on the map (e.g. a selection/highlight layer),
  //   3. map.queryRenderedFeatures() at the click point (vector-tile polygons).
  // Use __BHUMI_REC__.probe() (or Debug ON) to see which one delivers.
  // =====================================================================
  function mapPos(pt) {
    var x = pt[0], y = pt[1];
    if (Math.abs(x) > 180 || Math.abs(y) > 90) { // EPSG:3857 metres → degrees
      var R = 6378137;
      x = x / R * 180 / Math.PI;
      y = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
    }
    return normalizeLonLat(x, y); // also fixes swapped lat/lon; null when implausible
  }
  function mapCoords(a) {
    if (!Array.isArray(a)) return null;
    if (typeof a[0] === 'number') return mapPos(a);
    var out = [];
    for (var i = 0; i < a.length; i++) { var r = mapCoords(a[i]); if (!r) return null; out.push(r); }
    return out;
  }
  function fixGeom(g) {
    if (!isPolygon(g) || !Array.isArray(g.coordinates)) return null;
    var c = mapCoords(g.coordinates);
    return c ? { type: g.type, coordinates: c } : null;
  }

  function ringHas(ring, x, y) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function polyHas(rings, x, y) {
    if (!rings.length || !ringHas(rings[0], x, y)) return false;
    for (var i = 1; i < rings.length; i++) if (ringHas(rings[i], x, y)) return false; // inside a hole
    return true;
  }
  function geomHas(g, x, y) {
    if (g.type === 'Polygon') return polyHas(g.coordinates, x, y);
    return g.coordinates.some(function (p) { return polyHas(p, x, y); });
  }
  function geomArea(g) { // rough planar area of the outer rings (only used to rank candidates)
    var polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates, a = 0;
    polys.forEach(function (rings) {
      var r = rings[0], s = 0;
      for (var i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1];
      a += Math.abs(s / 2);
    });
    return a;
  }
  function vertexCount(g) { return collectCoords(g).length; }

  // Minimal WKT reader (POLYGON / MULTIPOLYGON) for payloads that carry a "geom" string.
  function parseWKT(t) {
    var m = /^\s*(?:SRID=\d+;)?\s*(MULTIPOLYGON|POLYGON)\s*(?:Z\s*)?\(([\s\S]*)\)\s*$/i.exec(t);
    if (!m) return null;
    function ring(str) {
      return str.split(',').map(function (p) { var n = p.trim().split(/\s+/).map(parseFloat); return [n[0], n[1]]; });
    }
    function poly(str) { // "(x y,x y),(x y,x y)"
      return str.split(/\)\s*,\s*\(/).map(function (r) { return ring(r.replace(/[()]/g, '')); });
    }
    try {
      if (/^MULTI/i.test(m[1])) {
        var parts = m[2].split(/\)\s*\)\s*,\s*\(\s*\(/).map(function (p) { return poly(p.replace(/^\s*\(\s*\(|\)\s*\)\s*$/g, '')); });
        return { type: 'MultiPolygon', coordinates: parts };
      }
      return { type: 'Polygon', coordinates: poly(m[2].replace(/^\s*\(|\)\s*$/g, '')) };
    } catch (e) { return null; }
  }

  // Collect polygon candidates from any JSON-ish value: [{ geom, via, props }]
  function polysIn(o, via, out, budget) {
    out = out || []; budget = budget || { n: 0 };
    (function walk(v, props, depth) {
      if (v == null || depth > 8 || budget.n++ > 20000) return;
      if (typeof v === 'string') {
        var t = v.trim();
        if (/^(SRID=\d+;)?\s*(MULTI)?POLYGON/i.test(t)) { var w = parseWKT(t); if (w) out.push({ geom: w, via: via + ':wkt', props: props }); }
        else if (t.charAt(0) === '{' && t.indexOf('"coordinates"') > 0 && t.length < 2e6) {
          try { walk((_parse || JSON.parse)(t), props, depth + 1); } catch (e) {}
        }
        return;
      }
      if (typeof v !== 'object') return;
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) walk(v[i], props, depth + 1); return; }
      if ((v.type === 'Polygon' || v.type === 'MultiPolygon') && Array.isArray(v.coordinates)) {
        out.push({ geom: v, via: via, props: props }); return;
      }
      var p = (v.properties && typeof v.properties === 'object') ? v.properties : (v.attributes && typeof v.attributes === 'object' ? v.attributes : props);
      Object.keys(v).forEach(function (k) { walk(v[k], k === 'properties' || k === 'attributes' ? props : p, depth + 1); });
    })(o, null, 0);
    return out;
  }

  function nibOf(props) { return props ? pick(props, FIELD_PATTERNS.nib) : ''; }

  // Approximate polygon area in m² (local equirectangular projection; good enough for parcels).
  function geoAreaM2(g) {
    var pts = collectCoords(g);
    if (!pts.length) return 0;
    var lat0 = 0, lon0 = 0;
    pts.forEach(function (p) { lon0 += p[0]; lat0 += p[1]; });
    lon0 /= pts.length; lat0 /= pts.length;
    var kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110574;
    function ringArea(r) {
      var s = 0;
      for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
        s += ((r[j][0] - lon0) * kx) * ((r[i][1] - lat0) * ky) - ((r[i][0] - lon0) * kx) * ((r[j][1] - lat0) * ky);
      }
      return Math.abs(s / 2);
    }
    var polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates, a = 0;
    polys.forEach(function (rings) {
      rings.forEach(function (r, i) { a += (i ? -1 : 1) * ringArea(r); });
    });
    return a;
  }
  function luasOf(props) {
    var n = parseFloat(String((props && props.luas) || '').replace(/\./g, '').replace(',', '.'));
    return isFinite(n) && n > 0 ? n : 0;
  }
  // The recorded area (luas, m²) is the best test that a polygon IS the parcel and not a
  // zone, map sheet or bbox rectangle that merely contains the click.
  var AREA_MIN = 0.75, AREA_MAX = 1.3;

  // BHUMI also returns the parcel ENVELOPE (an axis-aligned rectangle). It is not the boundary:
  // keep it as a `bbox` property, never as the polygon.
  function isEnvelope(g) {
    if (g.type !== 'Polygon' || g.coordinates.length !== 1) return false;
    var r = g.coordinates[0];
    if (r.length === 5 && r[0][0] === r[4][0] && r[0][1] === r[4][1]) r = r.slice(0, 4);
    if (r.length !== 4) return false;
    var eps = 1e-9;
    for (var i = 0; i < 4; i++) {
      var a = r[i], b = r[(i + 1) % 4];
      if (Math.abs(a[0] - b[0]) > eps && Math.abs(a[1] - b[1]) > eps) return false;
    }
    return true;
  }
  function bboxOf(g) {
    var pts = collectCoords(g), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); });
    return [x0, y0, x1, y1].map(function (v) { return Math.round(v * 1e7) / 1e7; });
  }

  // Keep valid polygons that contain the last click: [{ geom, via, nib }]
  function acceptable(cands) {
    var click = lastClick && lastClick.lonlat, out = [];
    cands.forEach(function (c) {
      var g = fixGeom(c.geom);
      if (!g) { log('poligon ditolak (koordinat tak wajar)', c.via, JSON.stringify(collectCoords(c.geom).slice(0, 2))); return; }
      if (click && !geomHas(g, click[0], click[1])) { log('poligon ditolak (tak memuat titik klik)', c.via, vertexCount(g) + ' titik'); return; }
      out.push({ geom: g, via: c.via, nib: nibOf(c.props), envelope: isEnvelope(g) });
    });
    return out;
  }

  function offerPolygons(cands, src) {
    var ok = acceptable(cands);
    var real = 0;
    ok.forEach(function (c) {
      log('kandidat poligon', src + ':' + c.via, vertexCount(c.geom) + ' titik', Math.round(geoAreaM2(c.geom)) + ' m²', c.envelope ? '(persegi pembatas / bbox, bukan batas bidang)' : '');
      if (c.envelope) { // remember the envelope on the record, but do not use it as the boundary
        var rec = lastTouched && store[lastTouched.key];
        if (rec && (!lastClick || lastTouched.ts >= lastClick.ts)) { rec.properties.bbox = bboxOf(c.geom); persist(); }
        else envelopeCand = { bbox: bboxOf(c.geom), ts: Date.now() };
        return;
      }
      real++;
      clickCands.push({ geom: c.geom, src: src + (c.via ? ':' + c.via : ''), nib: c.nib, ts: Date.now() });
    });
    if (real) applyPolygon();
    return real > 0;
  }

  // Attach the best polygon seen for the latest click to the record that click created/updated.
  function applyPolygon() {
    if (!clickCands.length || !lastTouched) return;
    if (lastClick && lastTouched.ts < lastClick.ts) return; // record belongs to an earlier click
    var f = store[lastTouched.key];
    if (!f) return;
    var luas = luasOf(f.properties), nib = f.properties.nib || '';
    var scored = clickCands.map(function (c) {
      var area = geoAreaM2(c.geom), ratio = luas ? area / luas : null;
      return { c: c, area: area, ratio: ratio, err: ratio ? Math.abs(Math.log(ratio)) : null, nibMatch: !!(c.nib && c.nib === nib) };
    });
    var ok = luas ? scored.filter(function (x) { return x.ratio >= AREA_MIN && x.ratio <= AREA_MAX; }) : scored;
    if (!ok.length) { log('poligon ditolak: luas tak cocok dengan', luas + ' m²', scored.map(function (x) { return Math.round(x.area) + ' m² @' + x.c.src; })); return; }
    ok.sort(function (a, b) {
      if (a.nibMatch !== b.nibMatch) return a.nibMatch ? -1 : 1;
      return luas ? a.err - b.err : a.area - b.area;
    });
    var best = ok[0];
    if (isPolygon(f.geometry)) { // only replace an existing boundary with a clearly better area match
      var ex = luas ? Math.abs(Math.log(geoAreaM2(f.geometry) / luas)) : 0;
      if (!(luas && best.err < ex - 0.05)) { polyDoneSeq = clickSeq; return; }
    }
    var cen = centroidOf(best.c.geom);
    f.geometry = best.c.geom;
    f.properties.geom_source = best.c.src;
    f.properties.poly_area_ratio = best.ratio ? Math.round(best.ratio * 1000) / 1000 : '';
    if (cen) { f.properties.lon = cen[0]; f.properties.lat = cen[1]; }
    persist(); schedulePins(); schedulePanel();
    polyDoneSeq = clickSeq;
    log('POLIGON terpasang', nib, best.c.src, vertexCount(best.c.geom) + ' titik', Math.round(best.area) + ' m²', luas ? 'rasio luas ' + best.ratio.toFixed(2) : '');
  }

  // Compact structure summary of a parsed payload (debug aid; strings are truncated).
  function shapeOf(v, d) {
    if (v == null || typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v.slice(0, 40)) + (v.length > 40 ? '…(' + v.length + ')' : '') : String(v);
    if (d <= 0) return Array.isArray(v) ? '[…' + v.length + ']' : '{…}';
    if (Array.isArray(v)) return '[' + v.length + '×' + (v.length ? shapeOf(v[0], d - 1) : '') + ']';
    return '{' + Object.keys(v).slice(0, 14).map(function (k) { return k + ':' + shapeOf(v[k], d - 1); }).join(', ') + '}';
  }

  // JSON.parse hook: the app decrypts getPersil and parses the plaintext; look inside it.
  var inScan = false;
  try {
    var _parse = JSON.parse;
    JSON.parse = function () {
      var r = _parse.apply(this, arguments);
      if (!inScan && cfg.recording && r && typeof r === 'object' &&
          (r.type === 'Feature' || Array.isArray(r.features))) {
        inScan = true;
        try { ingestDecodedFeatures(r, 'peta-json'); }
        catch (e) { log('baca GeoJSON aplikasi gagal', e); }
        finally { inScan = false; }
      }
      if (!inScan && Date.now() < scanUntil && r && typeof r === 'object') {
        inScan = true;
        try {
          var txt0 = typeof arguments[0] === 'string' ? arguments[0] : '';
          if (txt0.length > 30) { payloadLog.push({ t: new Date().toISOString(), chars: txt0.length, json: txt0.slice(0, 30000) }); if (payloadLog.length > 15) payloadLog.shift(); }
          var cands = polysIn(r, 'json');
          if (cfg.debug) log('JSON.parse (' + String(arguments[0] == null ? '' : arguments[0]).length + ' kar) bentuk:', shapeOf(r, 4).slice(0, 700));
          if (cands.length) { log('JSON.parse berisi ' + cands.length + ' poligon'); offerPolygons(cands, 'json'); }
        } catch (e) {}
        inScan = false;
      }
      return r;
    };
  } catch (e) { log('gagal hook JSON.parse', e); }

  function logRawResponse(url, p) {
    Promise.resolve(p).then(function (t) {
      t = String(t == null ? '' : t);
      log('res getPersil:', t.length + ' karakter', t.slice(0, 200));
    }).catch(function () {});
  }

  // Polygon candidates from the map itself: GeoJSON sources + features rendered at the click point.
  function mapCandidates() {
    var m = mapInst, out = [];
    if (!m) return out;
    try {
      var st = m.getStyle && m.getStyle();
      Object.keys((st && st.sources) || {}).forEach(function (id) {
        if (id === PIN_SRC) return;
        try {
          var s = m.getSource(id);
          if (!s || s.type !== 'geojson') return;
          var d = s._data;
          if (!d && typeof s.serialize === 'function') d = s.serialize().data;
          if (d && typeof d === 'object') polysIn(d, 'source:' + id, out);
        } catch (e) {}
      });
    } catch (e) {}
    try {
      if (lastClick && lastClick.point && typeof m.queryRenderedFeatures === 'function') {
        m.queryRenderedFeatures(lastClick.point).forEach(function (f) {
          var lid = f.layer && f.layer.id;
          if (lid === PIN_DOT || lid === PIN_HALO) return;
          var g = f.geometry;
          if (isPolygon(g)) out.push({ geom: g, via: 'layer:' + lid, props: f.properties });
        });
      }
    } catch (e) {}
    return out;
  }

  function scheduleMapCapture() {
    var seq = clickSeq;
    [400, 1000, 2000, 4000].forEach(function (ms) {
      setTimeout(function () {
        if (seq !== clickSeq || polyDoneSeq === seq || !mapInst) return;
        offerPolygons(mapCandidates(), 'map');
      }, ms);
    });
    if (cfg.debug) setTimeout(function () { if (seq === clickSeq) probe(); }, 1500);
  }

  // Diagnostic report: what does the map hold around the last click? Run from the Console
  // (select a parcel first): __BHUMI_REC__.probe()
  function probe() {
    var m = mapInst, rep = { click: lastClick, sources: [], layers: [], rendered: [], candidates: [] };
    if (!m) { log('probe: peta belum terhubung'); return rep; }
    try {
      var st = m.getStyle();
      Object.keys(st.sources || {}).forEach(function (id) {
        var s = st.sources[id] || {}, live = null, n = null;
        try { live = m.getSource(id); } catch (e) {}
        try {
          var d = live && (live._data || (live.serialize && live.serialize().data));
          if (d && typeof d === 'object') n = polysIn(d, id).length;
        } catch (e) {}
        rep.sources.push({ id: id, type: s.type, url: s.url || (s.tiles && s.tiles[0]) || '', polygons: n });
      });
      (st.layers || []).forEach(function (l) {
        rep.layers.push({ id: l.id, type: l.type, source: l.source, sourceLayer: l['source-layer'] || '' });
      });
    } catch (e) { rep.error = String(e); }
    try {
      if (lastClick && lastClick.point) {
        m.queryRenderedFeatures(lastClick.point).forEach(function (f) {
          rep.rendered.push({
            layer: f.layer && f.layer.id, source: f.source, sourceLayer: f.sourceLayer,
            geom: f.geometry && f.geometry.type, vertices: f.geometry ? vertexCount(f.geometry) : 0,
            props: Object.keys(f.properties || {}).slice(0, 12)
          });
        });
      }
    } catch (e) { rep.renderedError = String(e); }
    mapCandidates().forEach(function (c) {
      var g = fixGeom(c.geom);
      rep.candidates.push({ via: c.via, nib: nibOf(c.props), valid: !!g, containsClick: !!(g && lastClick && geomHas(g, lastClick.lonlat[0], lastClick.lonlat[1])), vertices: g ? vertexCount(g) : 0 });
    });
    lastProbe = rep;
    log('PROBE (salin hasil ini): ', JSON.stringify(rep));
    return rep;
  }

  // =====================================================================
  // Fallback: read the DOM info panel (MutationObserver) — works under CSP
  // =====================================================================
  var PANEL_LABELS = {
    tipe_hak: /tipe\s*hak|jenis\s*hak/i,
    nib: /\bnib\b/i,
    luas: /\bluas\b/i,
    penggunaan: /penggunaan/i
  };

  function scrapeText(text) {
    if (!text || text.length > 4000) return; // info panels are usually short
    if (!PANEL_LABELS.tipe_hak.test(text) && !PANEL_LABELS.nib.test(text)) return;
    var props = {};
    grab(text, PANEL_LABELS.tipe_hak, 'tipe_hak', props);
    grab(text, PANEL_LABELS.nib, 'nib', props);
    grab(text, PANEL_LABELS.luas, 'luas', props);
    grab(text, PANEL_LABELS.penggunaan, 'penggunaan', props);
    if (Object.keys(props).length) record(props, null, 'panel');
  }
  function grab(text, labelRe, key, out) {
    // Match "Label : value" or "Label\n value".
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
  // Record search terms
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
  // Export
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
    var cols = ['nib', 'tipe_hak', 'kategori', 'is_hak_milik', 'penggunaan', 'luas', 'lon', 'lat', 'search_term', 'source', 'recorded_at', 'geometry'];
    var rows = [cols.join(',')];
    features().forEach(function (f) {
      var p = f.properties;
      rows.push(cols.map(function (c) { return csvCell(c === 'geometry' ? JSON.stringify(f.geometry) : p[c]); }).join(','));
    });
    return rows.join('\r\n');
  }

  // Serialization core from converter.html; test-recorder.cjs checks both exporters agree.
  // Embedded to keep this userscript self-contained (no @require or network dependency).
  var EarthExport = (function () {
    const xml = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
    function position(p){
      if(!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>90)throw Error('Invalid WGS 84 coordinate. Expected [longitude, latitude].');
      return [p[0],p[1]];
    }
    const coords=a=>a.map(p=>p.join(',')+',0').join(' ');
    function line(c){if(!Array.isArray(c)||c.length<2)throw Error('Line needs at least two positions.');return c.map(position);}
    function ring(c,outer){
      if(!Array.isArray(c)||c.length<3)throw Error('Polygon ring needs three distinct vertices.');
      let r=c.map(position);
      if(r[0][0]!==r.at(-1)[0]||r[0][1]!==r.at(-1)[1])r.push([...r[0]]);
      if(new Set(r.slice(0,-1).map(p=>p.join(','))).size<3)throw Error('Polygon ring needs three distinct vertices.');
      const area=r.slice(0,-1).reduce((s,p,i)=>s+p[0]*r[i+1][1]-r[i+1][0]*p[1],0);
      if(area===0)throw Error('Polygon ring has zero signed area.');
      if((area>0)!==outer)r=r.reverse();return r;
    }
    function geometry(g,counts){
      if(!g||typeof g!=='object')throw Error('Missing geometry.');
      const c=g.coordinates;
      switch(g.type){
        case 'Point': counts.points++;return '<Point><altitudeMode>clampToGround</altitudeMode><coordinates>'+coords([position(c)])+'</coordinates></Point>';
        case 'LineString': counts.lines++;return '<LineString><tessellate>1</tessellate><coordinates>'+coords(line(c))+'</coordinates></LineString>';
        case 'Polygon': {
          if(!Array.isArray(c)||!c.length)throw Error('Polygon has no rings.');counts.polygons++;
          return '<Polygon><tessellate>1</tessellate>'+c.map((r,i)=>{const tag=i?'innerBoundaryIs':'outerBoundaryIs';return '<'+tag+'><LinearRing><coordinates>'+coords(ring(r,i===0))+'</coordinates></LinearRing></'+tag+'>';}).join('')+'</Polygon>';
        }
        case 'MultiPoint':case 'MultiLineString':case 'MultiPolygon': {
          if(!Array.isArray(c)||!c.length)throw Error('Empty multi-geometry.');
          const types={MultiPoint:'Point',MultiLineString:'LineString',MultiPolygon:'Polygon'};
          return '<MultiGeometry>'+c.map(x=>geometry({type:types[g.type],coordinates:x},counts)).join('')+'</MultiGeometry>';
        }
        case 'GeometryCollection':if(!Array.isArray(g.geometries)||!g.geometries.length)throw Error('Empty geometry collection.');return '<MultiGeometry>'+g.geometries.map(x=>geometry(x,counts)).join('')+'</MultiGeometry>';
        default:throw Error('Unsupported geometry type: '+g.type);
      }
    }
    const value=v=>v!==null&&typeof v==='object'?JSON.stringify(v):String(v??'');
    function kml(result,title,nameField){
      const marks=result.valid.map((f,i)=>{
        const p=f.properties,name=(nameField?p[nameField]:(p.nib||p.name||f.id))||'Parcel '+(i+1);
        const data=Object.entries(p).map(([k,v])=>'<Data name="'+xml(k)+'"><value>'+xml(value(v))+'</value></Data>').join('');
        return '<Placemark><name>'+xml(name)+'</name><styleUrl>#parcel</styleUrl><ExtendedData>'+data+'</ExtendedData>'+f.kml+'</Placemark>';
      }).join('\n');
      return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'+xml(title)+'</name><Style id="parcel"><LineStyle><color>ff40b980</color><width>2</width></LineStyle><PolyStyle><color>4040b980</color><fill>1</fill><outline>1</outline></PolyStyle></Style>\n'+marks+'\n</Document></kml>';
    }
    function crc32(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
    // ZIP STORE format: a standards-compliant KMZ without external compression libraries.
    function kmz(text){
      const enc=new TextEncoder(),data=enc.encode(text),name=enc.encode('doc.kml'),crc=crc32(data);
      if(data.length>0xffffffff-200)throw Error('File exceeds classic ZIP limits.');
      const local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);
      lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(12,33,true);lv.setUint32(14,crc,true);lv.setUint32(18,data.length,true);lv.setUint32(22,data.length,true);lv.setUint16(26,name.length,true);local.set(name,30);
      const central=new Uint8Array(46+name.length),cv=new DataView(central.buffer);
      cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,data.length,true);cv.setUint32(24,data.length,true);cv.setUint16(28,name.length,true);central.set(name,46);
      const end=new Uint8Array(22),ev=new DataView(end.buffer);
      ev.setUint32(0,0x06054b50,true);ev.setUint16(8,1,true);ev.setUint16(10,1,true);ev.setUint32(12,central.length,true);ev.setUint32(16,local.length+data.length,true);
      const out=new Uint8Array(local.length+data.length+central.length+end.length);let offset=0;for(const part of [local,data,central,end]){out.set(part,offset);offset+=part.length;}return out;
    }
    function prepare(features) {
      const valid=[],errors=[],totals={points:0,lines:0,polygons:0};
      features.forEach((f,i)=>{try{
        const count={points:0,lines:0,polygons:0},shape=geometry(f.geometry,count);
        for(const k of Object.keys(count))totals[k]+=count[k];
        valid.push({kml:shape,properties:f.properties||{},id:f.id});
      }catch(e){errors.push('Record '+(i+1)+': '+e.message);}});
      return {valid,errors,totals,total:features.length};
    }
    return {prepare,kml,kmz};
  })();

  function exportEarth(format, status) {
    try {
      var result = EarthExport.prepare(features());
      var summary = result.valid.length + '/' + result.total + ' bidang dengan geometri; ' +
        result.totals.points + ' titik, ' + result.totals.polygons + ' poligon, ' + result.totals.lines + ' garis.';
      if (!result.totals.polygons && result.valid.length) summary += ' Titik bukan batas bidang.';
      if (result.errors.length) summary += ' Dilewati: ' + result.errors.length + ' (geometri kosong/tidak valid).';
      status.textContent = format.toUpperCase() + ': ' + summary;
      if (!result.valid.length) {
        status.textContent += ' Tidak ada geometri yang dapat diekspor.';
        return;
      }
      var text = EarthExport.kml(result, 'BHUMI - Bidang Tanah', 'nib');
      download('bhumi-bidang.' + format, format === 'kmz' ? EarthExport.kmz(text) : text,
        format === 'kmz' ? 'application/vnd.google-earth.kmz' : 'application/vnd.google-earth.kml+xml;charset=utf-8');
    } catch (e) {
      status.textContent = 'Gagal mengekspor ' + format.toUpperCase() + ': ' + e.message;
    }
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

  // Breakdown by exact right TYPE (ownership, building rights, use rights, etc.),
  // ordered by count, highest first. Shows how many parcels have each right type.
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

    // Attach to <html>, NOT <body> — the BHUMI SPA replaces <body> contents on mount,
    // which would also remove a panel attached inside the body.
    document.documentElement.appendChild(panel);
  }

  function renderPanel() {
    if (!document.documentElement) return;
    if (!panel) buildPanel();
    var body = panel.querySelector('#bhumi-rec-body');
    if (!body) return;
    var c = counts();
    body.innerHTML = '';

    // Recording status
    var recRow = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:10px');
    var dot = el('span', 'width:10px;height:10px;border-radius:50%;background:' + (cfg.recording ? '#e11' : '#999') +
      (cfg.recording ? ';box-shadow:0 0 0 4px rgba(238,17,17,.18)' : ''));
    recRow.appendChild(dot);
    recRow.appendChild(el('span', 'flex:1;font-weight:600', cfg.recording ? 'Sedang merekam' : 'Jeda'));
    var toggle = el('span', 'cursor:pointer;color:#0a7d3c;font-weight:600;font-size:12px', cfg.recording ? 'Jeda' : 'Lanjut');
    toggle.addEventListener('click', function () { cfg.recording = !cfg.recording; saveJson(CFG_KEY, cfg); renderPanel(); });
    recRow.appendChild(toggle);
    body.appendChild(recRow);

    // Map marker status
    var mp = mapConnected();
    body.appendChild(el('div',
      'font-size:11px;margin-bottom:10px;padding:6px 8px;border-radius:8px;' +
      (mp ? 'background:#eaf7ee;color:#0a7d3c' : 'background:#f3f4f6;color:#777'),
      mp ? '📍 Penanda AKTIF di peta — bidang yang sudah direkam ditandai titik berwarna.'
         : '📍 Menyiapkan penanda peta… (kalau tak muncul, semua titik tetap ada di viewer.html)'));

    // "Show all points" button (when the map is connected and coordinates exist)
    if (mp && pinFC().features.length) {
      var seeAll = btn('🔍 Lihat semua titik di peta', 'background:#0a7d3c');
      seeAll.style.width = '100%'; seeAll.style.marginBottom = '10px';
      seeAll.addEventListener('click', fitAllPins);
      body.appendChild(seeAll);
    }

    // Was a PREVIOUSLY recorded parcel just clicked again?
    if (lastRepeat && (Date.now() - lastRepeat.ts) < 6000) {
      body.appendChild(el('div',
        'font-size:11px;margin-bottom:10px;padding:6px 8px;border-radius:8px;background:#eef3ff;color:#1c4dab',
        '✓ Sudah pernah direkam: ' + (lastRepeat.nib || '(tanpa NIB)') + ' — ' + lastRepeat.kategori));
    }

    // Large total count
    var big = el('div', 'font:800 28px system-ui;line-height:1', String(c.total));
    body.appendChild(big);
    body.appendChild(el('div', 'color:#666;font-size:11px;margin-bottom:10px',
      'bidang terekam · ' + features().filter(function (f) { return isPolygon(f.geometry); }).length + ' dengan poligon'));

    if (c.total) {
      var boundaryCount = features().filter(function (f) { return geometryRank(f.geometry) === 3; }).length;
      body.appendChild(el('div', 'font-size:11px;margin-bottom:10px;color:#555',
        'Batas poligon: ' + boundaryCount + ' / ' + c.total + ' bidang'));
      if (boundaryCount < c.total) {
        body.appendChild(el('div', 'font-size:10px;margin-bottom:10px;color:#7a5b00',
          'Sebagian batas belum tertangkap. Klik ulang bidang setelah pembaruan. Sorotan berupa gambar WMS tidak menyediakan koordinat poligon.'));
      }
    }

    // Category breakdown
    var grid = el('div', 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;text-align:center');
    grid.appendChild(chip('Hak Milik', c.milik, '#1a9850'));
    grid.appendChild(chip('Hak lain', c.lain, '#e6a010'));
    grid.appendChild(chip('? / kosong', c.unknown, '#9e9e9e'));
    body.appendChild(grid);

    // Breakdown by right TYPE (ownership, building rights, use rights, etc.)
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

    // Parcel list (expand/collapse) — click an entry to fly to its point on the map
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

    // Hint when no data is recorded
    if (c.total === 0) {
      body.appendChild(el('div', 'background:#fff6e5;border:1px solid #ffe0a3;border-radius:8px;padding:8px;font-size:11px;color:#7a5b00;margin-bottom:10px',
        'Belum ada data. Aktifkan layer "Bidang Tanah", setujui disclaimer, lalu klik satu bidang. Buka Console (F12) untuk memeriksa log [BHUMI-REC].'));
    }

    // Latest search
    if (lastSearch) {
      body.appendChild(el('div', 'font-size:11px;color:#555;margin-bottom:10px', '🔎 Pencarian terakhir: ' + lastSearch));
    }

    // Buttons
    var row1 = el('div', 'display:flex;gap:6px;margin-bottom:6px');
    var gj = btn('⬇︎ GeoJSON'); gj.style.flex = '1';
    gj.addEventListener('click', function () { download('bhumi-bidang.geojson', toGeoJSON(), 'application/geo+json'); });
    var cv = btn('⬇︎ CSV', 'background:#0a5a7d'); cv.style.flex = '1';
    cv.addEventListener('click', function () { download('bhumi-bidang.csv', '﻿' + toCSV(), 'text/csv;charset=utf-8'); });
    row1.appendChild(gj); row1.appendChild(cv);
    body.appendChild(row1);

    // Google Earth: export directly without opening converter.html.
    var earthRow = el('div', 'display:flex;gap:6px;margin-bottom:6px');
    var earthStatus = el('div', 'font-size:10px;color:#666;margin-bottom:6px');
    earthStatus.setAttribute('role', 'status');
    earthStatus.setAttribute('aria-live', 'polite');
    ['kml', 'kmz'].forEach(function (format) {
      var button = btn('⬇︎ ' + format.toUpperCase(), 'background:#73529b;flex:1');
      button.disabled = c.total === 0;
      if (button.disabled) { button.style.opacity = '.5'; button.style.cursor = 'default'; }
      button.addEventListener('click', function () { exportEarth(format, earthStatus); });
      earthRow.appendChild(button);
    });
    body.appendChild(earthRow);
    body.appendChild(earthStatus);

    var row2 = el('div', 'display:flex;gap:6px');
    var dbg = btn(cfg.debug ? 'Debug: ON' : 'Debug: OFF', 'background:#555;flex:1');
    dbg.addEventListener('click', function () { cfg.debug = !cfg.debug; saveJson(CFG_KEY, cfg); renderPanel(); });
    var clr = btn('Hapus', 'background:#b33;flex:1');
    clr.addEventListener('click', function () {
      if (confirm('Hapus semua ' + c.total + ' bidang terekam?')) {
        highlightRead++; store = {}; searches = []; lastSearch = ''; lastRepeat = null; persist(); saveJson(SEARCH_KEY, searches); renderPins(); renderPanel();
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

  // Small API for manual debugging from the Console.
  window.__BHUMI_REC__ = {
    dump: function () { console.log(store); return store; },
    geojson: toGeoJSON,
    csv: toCSV,
    count: counts,
    breakdown: breakdownByType,
    cleanup: function () { var r = cleanupStore(); renderPins(); renderPanel(); return r; },
    mapConnected: mapConnected,
    map: function () { return mapInst; },
    probe: probe,
    lastProbe: function () { return lastProbe; },
    payloads: function () { return payloadLog; },
    clear: function () { highlightRead++; store = {}; lastRepeat = null; persist(); renderPins(); renderPanel(); }
  };

  // =====================================================================
  // Initialize when the DOM is ready
  // =====================================================================
  function whenReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }
  startObserver();
  cleanupStore();  // clean up old data: remove vacant land entries and merge duplicates
  initMapBridge(); // try adding markers to the BHUMI map
  whenReady(function () { renderPanel(); });
  // Watchdog: reattach the panel if the SPA removes it from the DOM.
  setInterval(function () {
    try { if (panel && !panel.isConnected) document.documentElement.appendChild(panel); } catch (e) {}
  }, 1000);
  log('siap. recording=' + cfg.recording + ' debug=' + cfg.debug);
})();
