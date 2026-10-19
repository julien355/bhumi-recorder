const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = fs.readFileSync(__dirname + '/bhumi-recorder.user.js', 'utf8');

// Browser + MapLibre stub; timers are queued and flushed by the test.
function setup({ stored = {}, layers = [], sources = {} } = {}) {
  const timers = [];
  class El { constructor() { this.children = []; this.style = {}; } appendChild(c) { this.children.push(c); return c; }
    setAttribute() {} addEventListener() {} querySelector() { return null; } set innerHTML(v) {} }
  const document = { body: new El(), documentElement: new El(), createElement: () => new El(), addEventListener() {}, querySelectorAll: () => [] };
  const writes = {};
  const localStorage = { getItem: k => k === 'bhumi_recorder_v1' ? JSON.stringify(stored) : k === 'bhumi_recorder_cfg_v1' ? '{"recording":true,"debug":false}' : null,
    setItem: (k, v) => { writes[k] = v; } };
  const handlers = {};
  const map = {
    addSource() {}, getSource: id => sources[id] || null, getLayer: () => null, addLayer() {}, isStyleLoaded: () => true, once() {},
    on(ev, a, b) { if (typeof a === 'function') handlers[ev] = a; }, getCanvas() {}, project() {},
    getStyle: () => ({ sources: Object.fromEntries(Object.keys(sources).map(k => [k, { type: 'geojson' }])), layers: [] }),
    queryRenderedFeatures: () => layers
  };
  const window = {};
  function XMLHttpRequest() {} XMLHttpRequest.prototype.open = XMLHttpRequest.prototype.send = () => {};
  window.fetch = () => Promise.resolve({ headers: { get: () => '' }, clone() { return this; }, text: () => Promise.resolve('') });
  const ctx = { window, document, localStorage, XMLHttpRequest, console, MutationObserver: class { observe() {} },
    setTimeout: (fn, ms) => { timers.push(fn); }, setInterval() {}, clearInterval() {}, Promise, alert() {} };
  ctx.window.fetch = window.fetch;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  window.maplibregl = { Map: function () { return map; } };
  new window.maplibregl.Map();
  const flush = () => { while (timers.length) timers.shift()(); };
  const click = (lng, lat) => handlers.click({ lngLat: { lng, lat }, point: { x: 10, y: 10 } });
  const parcelFetch = nib => window.fetch('https://bhumi.atrbpn.go.id/api/rating_layer?layer=persil&nib=' + nib + '&luas=6930&tipehak=Hak+Guna+Bangunan');
  return { window, api: window.__BHUMI_REC__, click, flush, parcelFetch, ctx, writes };
}
const square = (x, y, d) => ({ type: 'Polygon', coordinates: [[[x - d, y - d], [x + d, y - d], [x + d, y + d], [x - d, y + d], [x - d, y - d]]] });
const feat = (g, props = {}) => ({ type: 'Feature', geometry: g, properties: props, layer: { id: 'x' } });
const geomOf = (api, nib) => JSON.parse(api.geojson()).features.find(f => f.properties.nib === nib);

// 1. Click → polygon from rendered features (smallest containing, ignoring non-containing) replaces the click point.
{
  const zone = feat(square(116.17, -8.88, 0.05)), parcel = feat(square(116.1672, -8.8795, 0.0005)), far = feat(square(116.2, -8.9, 0.0005));
  parcel.layer.id = 'bidang'; zone.layer.id = 'zona'; far.layer.id = 'bidang';
  const t = setup({ layers: [zone, far, parcel] });
  t.click(116.167192, -8.879492);
  t.parcelFetch('02655');
  assert.equal(geomOf(t.api, '02655').geometry.type, 'Point', 'before capture only the click point exists');
  t.flush();
  const f = geomOf(t.api, '02655');
  assert.equal(f.geometry.type, 'Polygon');
  assert.equal(f.geometry.coordinates[0].length, 5);
  assert.equal(f.properties.geom_source, 'map:layer:bidang');
  assert.ok(Math.abs(f.properties.lon - 116.1672) < 0.001);
}
// 2. A stored Point is upgraded on re-click; an existing polygon is never overwritten.
{
  const stored = { 'nib:02655': { type: 'Feature', geometry: { type: 'Point', coordinates: [116.167192, -8.879492] },
    properties: { nib: '02655', tipe_hak: 'Hak Guna Bangunan', kategori: 'Hak lain', warna: '#e6a010', lon: 116.167192, lat: -8.879492, source: 'peta', raw: {} } } };
  const t = setup({ stored, layers: [feat(square(116.1672, -8.8795, 0.0005))] });
  t.click(116.167192, -8.879492); t.parcelFetch('02655'); t.flush();
  assert.equal(geomOf(t.api, '02655').geometry.type, 'Polygon');
  const first = JSON.stringify(geomOf(t.api, '02655').geometry);
  t.click(116.167192, -8.879492); t.parcelFetch('02655'); t.flush();
  assert.equal(JSON.stringify(geomOf(t.api, '02655').geometry), first);
}
// 3. GeoJSON source (selection highlight) is used, including EPSG:3857 coordinates.
{
  const R = 6378137, mx = lon => lon * Math.PI / 180 * R, my = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
  const ring = [[116.1667, -8.8800], [116.1677, -8.8800], [116.1677, -8.8790], [116.1667, -8.8790], [116.1667, -8.8800]].map(([x, y]) => [mx(x), my(y)]);
  const src = { type: 'geojson', _data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] } };
  const t = setup({ sources: { selected: src } });
  t.click(116.167192, -8.879492); t.parcelFetch('09999'); t.flush();
  const f = geomOf(t.api, '09999');
  assert.equal(f.geometry.type, 'Polygon');
  assert.ok(Math.abs(f.geometry.coordinates[0][0][0] - 116.1667) < 1e-6, 'reprojected to lon/lat');
  assert.equal(f.properties.geom_source, 'map:source:selected');
}
// 4. Plaintext parsed by the app right after getPersil (GeoJSON string and WKT) is captured via JSON.parse.
for (const payload of [
  JSON.stringify({ data: { geometry: square(116.1672, -8.8795, 0.0005) } }),
  JSON.stringify({ result: [{ nib: '07777', geom: 'POLYGON((116.1667 -8.8800,116.1677 -8.8800,116.1677 -8.8790,116.1667 -8.8790,116.1667 -8.8800))' }] })
]) {
  const t = setup();
  t.window.fetch('https://bhumi.atrbpn.go.id/expapi/getPersil', { method: 'POST', body: '{}' });
  t.click(116.167192, -8.879492);
  t.parcelFetch('07777');
  vm.runInContext('JSON', t.ctx).parse(payload);
  const f = geomOf(t.api, '07777');
  assert.equal(f.geometry.type, 'Polygon');
  assert.match(f.properties.geom_source, /^json/);
}
// 5. A polygon that does not contain the click is ignored; a stale click never steals a polygon.
{
  const t = setup({ layers: [feat(square(116.3, -8.5, 0.0005))] });
  t.click(116.167192, -8.879492); t.parcelFetch('01111'); t.flush();
  assert.equal(geomOf(t.api, '01111').geometry.type, 'Point');
}
console.log('Passed: polygon capture from rendered features, GeoJSON sources (3857), JSON.parse/WKT, click-containment, point→polygon upgrade, no overwrite.');
