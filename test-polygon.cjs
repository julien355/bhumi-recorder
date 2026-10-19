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
// Non-rectangular parcel (~6930 m² at lat -8.88): a diamond; plain squares/rectangles are treated as envelopes.
const diamond = (x, y, d = 5.34e-4) => ({ type: 'Polygon', coordinates: [[[x - d, y], [x, y - d], [x + d, y], [x, y + d], [x - d, y]]] });
const feat = (g, props = {}) => ({ type: 'Feature', geometry: g, properties: props, layer: { id: 'x' } });
const geomOf = (api, nib) => JSON.parse(api.geojson()).features.find(f => f.properties.nib === nib);

// 1. Click → polygon from rendered features (smallest containing, ignoring non-containing) replaces the click point.
{
  const zone = feat(square(116.17, -8.88, 0.05)), parcel = feat(diamond(116.1672, -8.8795)), far = feat(square(116.2, -8.9, 0.0005));
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
  const t = setup({ stored, layers: [feat(diamond(116.1672, -8.8795))] });
  t.click(116.167192, -8.879492); t.parcelFetch('02655'); t.flush();
  assert.equal(geomOf(t.api, '02655').geometry.type, 'Polygon');
  const first = JSON.stringify(geomOf(t.api, '02655').geometry);
  t.click(116.167192, -8.879492); t.parcelFetch('02655'); t.flush();
  assert.equal(JSON.stringify(geomOf(t.api, '02655').geometry), first);
}
// 3. GeoJSON source (selection highlight) is used, including EPSG:3857 coordinates.
{
  const R = 6378137, mx = lon => lon * Math.PI / 180 * R, my = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R;
  const ring = [[116.16667, -8.8795], [116.1672, -8.880034], [116.167734, -8.8795], [116.1672, -8.878966], [116.16667, -8.8795]].map(([x, y]) => [mx(x), my(y)]);
  const src = { type: 'geojson', _data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] } };
  const t = setup({ sources: { selected: src } });
  t.click(116.167192, -8.879492); t.parcelFetch('09999'); t.flush();
  const f = geomOf(t.api, '09999');
  assert.equal(f.geometry.type, 'Polygon');
  assert.ok(Math.abs(f.geometry.coordinates[0][0][0] - 116.16667) < 1e-6, 'reprojected to lon/lat');
  assert.equal(f.properties.geom_source, 'map:source:selected');
}
// 4. Plaintext parsed by the app right after getPersil (GeoJSON string and WKT) is captured via JSON.parse.
for (const payload of [
  JSON.stringify({ data: { geometry: diamond(116.1672, -8.8795) } }),
  JSON.stringify({ result: [{ nib: '07777', geom: 'POLYGON((116.16667 -8.8795,116.1672 -8.880034,116.167734 -8.8795,116.1672 -8.878966,116.16667 -8.8795))' }] })
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
// 6. Area check: a rectangle that contains the click but is not parcel-sized is rejected; the right one wins,
//    and a previously stored wrong polygon is replaced when a better match arrives.
{
  const big = feat(square(116.1672, -8.8795, 0.002)); big.layer.id = 'index';
  const right = feat(diamond(116.1672, -8.8795)); right.layer.id = 'bidang';
  const t = setup({ layers: [big] });
  t.click(116.167192, -8.879492); t.parcelFetch('05555'); t.flush();
  assert.equal(geomOf(t.api, '05555').geometry.type, 'Point', 'wrong-size polygon is not attached');
  const stored = { 'nib:05555': { type: 'Feature', geometry: big.geometry, properties: { nib: '05555', tipe_hak: 'Hak Milik', kategori: 'Hak Milik', is_hak_milik: true,
    warna: '#1a9850', luas: '6930', lon: 116.1672, lat: -8.8795, source: 'peta', raw: {} } } };
  const t2 = setup({ stored, layers: [big, right] });
  t2.click(116.167192, -8.879492); t2.parcelFetch('05555'); t2.flush();
  const f = geomOf(t2.api, '05555');
  assert.equal(f.properties.geom_source, 'map:layer:bidang');
  assert.ok(Math.abs(f.properties.poly_area_ratio - 1) < 0.1, 'area ratio recorded: ' + f.properties.poly_area_ratio);
}
// 7. The envelope (axis-aligned rectangle ≈ 1.5× the parcel) is NOT used as the boundary: only stored as bbox.
{
  const env = square(116.1672, -8.8795, 0.00046); // ~1.5x of 6930 m²
  const payload = JSON.stringify({ geometry: env });
  const t = setup();
  t.window.fetch('https://bhumi.atrbpn.go.id/expapi/getPersil', { method: 'POST', body: '{}' });
  t.click(116.167192, -8.879492); t.parcelFetch('04444');
  vm.runInContext('JSON', t.ctx).parse(payload);
  const f = geomOf(t.api, '04444');
  assert.equal(f.geometry.type, 'Point', 'envelope is not a boundary');
  assert.deepEqual(f.properties.bbox, [116.1672 - 0.00046, -8.8795 - 0.00046, 116.1672 + 0.00046, -8.8795 + 0.00046].map(v => Math.round(v * 1e7) / 1e7));
  // envelope first, real polygon later (same click) → polygon wins and bbox is kept
  const t2 = setup({ layers: [feat(diamond(116.1672, -8.8795))] });
  t2.window.fetch('https://bhumi.atrbpn.go.id/expapi/getPersil', { method: 'POST', body: '{}' });
  t2.click(116.167192, -8.879492); t2.parcelFetch('04445');
  vm.runInContext('JSON', t2.ctx).parse(payload);
  t2.flush();
  const g = geomOf(t2.api, '04445');
  assert.equal(g.geometry.type, 'Polygon');
  assert.equal(g.geometry.coordinates[0].length, 5);
  assert.ok(g.properties.bbox && g.properties.bbox.length === 4);
  assert.equal(t2.api.payloads().length, 1, 'payloads kept for diagnosis');
}
console.log('Passed: polygon capture from rendered features, GeoJSON sources (3857), JSON.parse/WKT, click-containment, point→polygon upgrade, no overwrite, luas/area check, envelope (bbox) handling.');
