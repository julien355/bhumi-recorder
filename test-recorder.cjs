const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const script = fs.readFileSync(__dirname + '/bhumi-recorder.user.js', 'utf8');
const converterScript = fs.readFileSync(__dirname + '/converter.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const converterContext = { module: { exports: {} }, TextEncoder };
vm.runInNewContext(converterScript, converterContext);
const converter = converterContext.module.exports;

// Run the complete userscript with a small browser stub, including panel creation
// and the actual download click handlers. No network calls or real parcel data.
function recorder(features, options = {}) {
  const downloads = [], alerts = [], writes = [], blobs = new Map();
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.events = {}; this.textContent = ''; }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, handler) { this.events[name] = handler; }
    querySelector(selector) { return this.all().find(e => '#' + e.id === selector); }
    all() { return this.children.flatMap(e => [e, ...e.all()]); }
    set innerHTML(value) { this.children = []; }
    click() {
      if (this.disabled) return;
      if (this.tagName === 'A') downloads.push({ filename: this.download, blob: blobs.get(this.href) });
      this.events.click?.();
    }
  }
  const document = {
    body: new Element('body'), documentElement: new Element('html'),
    createElement: tag => new Element(tag), addEventListener() {}, querySelectorAll: () => []
  };
  const store = Object.fromEntries(features.map(f => ['nib:' + f.properties.nib, f]));
  const stored = JSON.stringify(store);
  const localStorage = {
    getItem: key => key === 'bhumi_recorder_v1' ? stored : key === 'bhumi_recorder_cfg_v1' ? '{"recording":true,"debug":false}' : null,
    setItem: (...args) => writes.push(args)
  };
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = XMLHttpRequest.prototype.send = () => {};
  const window = {};
  const timers = [];
  if (options.Map) window.maplibregl = { Map: options.Map };
  const context = vm.createContext({
    window, document, localStorage, XMLHttpRequest, TextEncoder, Blob, console,
    MutationObserver: class { observe() {} },
    setTimeout(fn) { timers.push(fn); return timers.length; }, setInterval() {}, clearInterval() {},
    alert: message => alerts.push(message),
    URL: { createObjectURL: blob => { const url = 'blob:' + blobs.size; blobs.set(url, blob); return url; }, revokeObjectURL() {} }
  });
  vm.runInContext(script, context);
  return {
    button: format => document.documentElement.all().find(e => e.tagName === 'BUTTON' && e.textContent.endsWith(' ' + format)),
    status: () => document.documentElement.all().find(e => e.role === 'status').textContent,
    downloads, alerts, writes, api: window.__BHUMI_REC__,
    parse: vm.runInContext('JSON.parse', context),
    flush: () => { for (const fn of timers.splice(0)) fn(); },
    map: options.Map ? new window.maplibregl.Map() : null
  };
}

const polygon = { type: 'Polygon', coordinates: [
  [[116,-8],[117,-8],[117,-7],[116,-7]],
  [[116.2,-7.8],[116.4,-7.8],[116.4,-7.6],[116.2,-7.6]]
] };
const geometries = [
  { type: 'Point', coordinates: [116,-8,30] },
  { type: 'MultiPoint', coordinates: [[116,-8],[117,-7]] },
  { type: 'LineString', coordinates: [[116,-8],[117,-7]] },
  { type: 'MultiLineString', coordinates: [[[116,-8],[117,-7]]] },
  polygon, { type: 'MultiPolygon', coordinates: [polygon.coordinates] },
  { type: 'GeometryCollection', geometries: [polygon, { type: 'Point', coordinates: [116,-8] }] },
  null, { type: 'Point', coordinates: [400,900] },
  { type: 'Polygon', coordinates: [[[1,1],[1,1],[1,1]]] }
];
const features = geometries.map((geometry, i) => ({
  type: 'Feature', geometry,
  properties: { nib: '00' + i + '<&"', tipe_hak: 'Hak Milik', kategori: 'Hak Milik', is_hak_milik: true,
    penggunaan: 'Été 🌴 <test>\u0001', luas: '100', raw: { note: 'A & B' } }
}));

async function main() {
  // BHUMI parses decrypted getPersil JSON after Response.json() has returned.
  // Exercise that application path, not private recorder functions.
  const captured = recorder([]);
  const decoded = geometry => JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { nib: 'PLOT-1', tipehak: 'Hak Milik' }, geometry }
  ] });
  const selected = { type: 'Polygon', coordinates: [
    [[116,-8],[116.4,-8],[116.3,-7.6],[116.1,-7.8],[116,-8]],
    [[116.15,-7.9],[116.2,-7.9],[116.2,-7.85],[116.15,-7.9]]
  ] };
  captured.parse(decoded({ type: 'Point', coordinates: [116.2,-7.9] }));
  captured.parse(decoded(selected));
  assert.deepEqual(JSON.parse(captured.api.geojson()).features[0].geometry, selected,
    'Decoded irregular parcel replaces a point, retaining holes and vertices');
  captured.parse(decoded({ type: 'Point', coordinates: [116.2,-7.9] }));
  captured.parse(decoded({ type: 'Polygon', coordinates: [[[1,1],[1,1],[1,1]]] }));
  assert.deepEqual(JSON.parse(captured.api.geojson()).features[0].geometry, selected,
    'Later attribute/point/invalid polygon responses cannot downgrade a boundary');
  assert.equal(captured.api.count().total, 1);
  captured.flush();
  captured.button('KML').click();
  captured.button('KMZ').click();
  const capturedKml = await captured.downloads[0].blob.text();
  assert.match(capturedKml, /<Polygon>/);
  assert.match(capturedKml, /<innerBoundaryIs>/);
  assert.match(capturedKml, /116.3,-7.6,0/);
  assert.ok(!capturedKml.includes('<Point>'));
  assert.equal(converter.parse(captured.api.csv(), 'parcels.csv').totals.polygons, 1,
    'CSV retains polygon geometry for conversion too');
  assert.equal(captured.parse('{"value":2}', (key, value) => key === 'value' ? value * 3 : value).value, 6);
  assert.throws(() => captured.parse('{bad json'), /JSON/);
  const writeCount = captured.writes.length;
  captured.parse(captured.api.geojson());
  captured.parse(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { name: 'other layer' }, geometry: selected }
  ] }));
  assert.equal(captured.writes.length, writeCount, 'Own exports and unrelated layers are ignored');

  const legacy = recorder([{ type: 'Feature', properties: { nib: 'PLOT-1', penggunaan: 'Kebun', source: 'peta' },
    geometry: { type: 'Polygon', coordinates: [[[116,-8],[117,-8],[117,-7],[116,-7],[116,-8]]] } }]);
  legacy.parse(decoded(selected));
  assert.deepEqual(JSON.parse(legacy.api.geojson()).features[0].geometry, selected,
    'New parcel vertices replace an older box-shaped polygon on re-selection');
  assert.equal(JSON.parse(legacy.api.geojson()).features[0].properties.penggunaan, 'Kebun');
  const multi = { type: 'MultiPolygon', coordinates: [selected.coordinates, [
    [[116.6,-8],[116.8,-8],[116.7,-7.9],[116.6,-8]]
  ]] };
  legacy.parse(decoded(multi));
  assert.deepEqual(JSON.parse(legacy.api.geojson()).features[0].geometry, multi);
  assert.equal(legacy.api.count().total, 1, 'Repeated selection upgrades the existing saved NIB');

  const envelope = recorder([]);
  envelope.parse(decoded({ type: 'Point', coordinates: [116.2,-7.9] }));
  envelope.parse(decoded({ type: 'Polygon', coordinates: [[[116,-8],[117,-8],[117,-7],[116,-7],[116,-8]]] }));
  const bounded = JSON.parse(envelope.api.geojson()).features[0];
  assert.equal(bounded.geometry.type, 'Point', 'Decoded envelope cannot bypass main envelope protection');
  assert.deepEqual(bounded.properties.bbox, [116,-8,117,-7]);
  const wrongArea = recorder([{ type: 'Feature', properties: { nib: 'PLOT-1', luas: '50', source: 'peta' },
    geometry: { type: 'Point', coordinates: [116.2,-7.9] } }]);
  wrongArea.parse(decoded(selected));
  assert.equal(JSON.parse(wrongArea.api.geojson()).features[0].geometry.type, 'Point',
    'Decoded GeoJSON cannot bypass recorded-area validation');

  class MapStub {
    constructor() { this.sources = {}; this.events = {}; }
    on(name, ...args) { (this.events[name] ||= []).push(args.at(-1)); }
    emit(name, event) { for (const fn of this.events[name] || []) fn(event); }
    getSource(id) { return this.sources[id]; }
    isStyleLoaded() { return false; }
    once() {}
  }
  const highlight = recorder([], { Map: MapStub });
  highlight.map.sources.highlight = { type: 'geojson', serialize: () => ({ data: JSON.parse(decoded(selected)) }) };
  highlight.map.emit('sourcedata', { sourceId: 'highlight' });
  assert.deepEqual(JSON.parse(highlight.api.geojson()).features[0].geometry, selected);
  const asyncHighlight = recorder([], { Map: MapStub });
  asyncHighlight.map.sources.highlight = { type: 'geojson', getData: async () => JSON.parse(decoded(selected)) };
  asyncHighlight.map.emit('sourcedata', { sourceId: 'highlight' });
  await new Promise(setImmediate);
  assert.equal(asyncHighlight.api.count().total, 1);
  const stale = recorder([], { Map: MapStub });
  let resolveHighlight;
  stale.map.sources.highlight = { type: 'geojson', getData: () => new Promise(resolve => { resolveHighlight = resolve; }) };
  stale.map.emit('sourcedata', { sourceId: 'highlight' });
  stale.api.clear();
  resolveHighlight(JSON.parse(decoded(selected)));
  await new Promise(setImmediate);
  assert.equal(stale.api.count().total, 0, 'A delayed source read cannot restore cleared records');
  const raster = recorder([], { Map: MapStub });
  raster.map.sources.highlight = { type: 'raster', serialize: () => ({ data: JSON.parse(decoded(selected)) }) };
  raster.map.emit('sourcedata', { sourceId: 'highlight' });
  assert.equal(raster.api.count().total, 0, 'Raster image extents must not become parcel boxes');

  const app = recorder(features);
  const before = app.api.geojson();
  app.button('KML').click();
  app.button('KMZ').click();
  assert.equal(app.downloads.length, 2);
  assert.equal(app.downloads[0].filename, 'bhumi-bidang.kml');
  assert.equal(app.downloads[0].blob.type, 'application/vnd.google-earth.kml+xml;charset=utf-8');
  assert.equal(app.downloads[1].filename, 'bhumi-bidang.kmz');
  assert.equal(app.downloads[1].blob.type, 'application/vnd.google-earth.kmz');
  assert.match(app.status(), /7\/10 bidang/);
  assert.match(app.status(), /Dilewati: 3/);
  const kml = await app.downloads[0].blob.text();
  const expected = converter.kml(converter.parse(before, 'parcels.geojson'), 'BHUMI - Bidang Tanah', 'nib');
  assert.equal(kml, expected, 'Recorder preserves all geometry and attributes like the offline converter');
  assert.match(kml, /00[0-9]&lt;&amp;&quot;/);
  assert.match(kml, /Été 🌴 &lt;test&gt;/);
  assert.ok(!kml.includes('\u0001'));
  assert.equal((kml.match(/<Placemark>/g) || []).length, 7);
  assert.equal((kml.match(/<innerBoundaryIs>/g) || []).length, 3);
  const kmz = Buffer.from(await app.downloads[1].blob.arrayBuffer());
  assert.equal(kmz.readUInt32LE(0), 0x04034b50);
  assert.equal(kmz.readUInt16LE(8), 0, 'KMZ uses ZIP STORE');
  assert.equal(kmz.subarray(30, 37).toString(), 'doc.kml');
  const size = kmz.readUInt32LE(18);
  assert.equal(kmz.subarray(37, 37 + size).toString(), kml, 'ZIP entry contains the same UTF-8 KML');
  assert.equal(kmz.readUInt32LE(37 + size), 0x02014b50);
  assert.equal(kmz.readUInt32LE(kmz.length - 22), 0x06054b50);
  assert.deepEqual(kmz, Buffer.from(converter.kmz(kml)));
  assert.equal(app.api.geojson(), before, 'Exports do not change saved parcels');
  assert.equal(app.writes.length, 0);
  assert.deepEqual(app.alerts, []);

  const points = recorder([features[0]]);
  points.button('KML').click();
  assert.match(points.status(), /Titik bukan batas bidang/);
  const invalid = recorder([features[7], features[8]]);
  invalid.button('KML').click();
  invalid.button('KMZ').click();
  assert.equal(invalid.downloads.length, 0);
  assert.match(invalid.status(), /Tidak ada geometri/);
  const empty = recorder([]);
  assert.ok(empty.button('KML').disabled);
  assert.ok(empty.button('KMZ').disabled);
  for (const format of ['GeoJSON', 'CSV']) app.button(format).click();
  assert.equal(app.downloads[2].filename, 'bhumi-bidang.geojson');
  assert.equal(await app.downloads[2].blob.text(), before);
  assert.equal(app.downloads[3].filename, 'bhumi-bidang.csv');
  assert.deepEqual(Buffer.from(await app.downloads[3].blob.arrayBuffer()), Buffer.from('\ufeff' + app.api.csv()));
  console.log('Passed: decoded parcel capture, point/box upgrades, holes/multipolygons, GeoJSON highlights, raster exclusion, CSV geometry, recorder buttons, KML/KMZ downloads, UTF-8/XML escaping and unchanged export storage.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
