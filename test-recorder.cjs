const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const script = fs.readFileSync(__dirname + '/bhumi-recorder.user.js', 'utf8');
const converterScript = fs.readFileSync(__dirname + '/converter.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
const converterContext = { module: { exports: {} }, TextEncoder };
vm.runInNewContext(converterScript, converterContext);
const converter = converterContext.module.exports;

// Run the complete userscript with a small browser stub, including panel creation
// and the actual download click handlers. No network calls or parcel mutations.
function recorder(features) {
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
  vm.runInNewContext(script, {
    window, document, localStorage, XMLHttpRequest, TextEncoder, Blob, console,
    MutationObserver: class { observe() {} },
    setTimeout() {}, setInterval() {}, clearInterval() {},
    alert: message => alerts.push(message),
    URL: { createObjectURL: blob => { const url = 'blob:' + blobs.size; blobs.set(url, blob); return url; }, revokeObjectURL() {} }
  });
  return {
    button: format => document.documentElement.all().find(e => e.tagName === 'BUTTON' && e.textContent.endsWith(' ' + format)),
    status: () => document.documentElement.all().find(e => e.role === 'status').textContent,
    downloads, alerts, writes, api: window.__BHUMI_REC__
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
  console.log('Passed: recorder buttons, KML/KMZ downloads, all geometry types, holes, UTF-8/XML escaping, invalid/empty records, unchanged storage and existing exports.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
