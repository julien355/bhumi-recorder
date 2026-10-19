const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(__dirname+'/converter.html','utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context={module:{exports:{}},TextEncoder};vm.runInNewContext(script,context);const c=context.module.exports;
const polygon={type:'Polygon',coordinates:[[[116,-8],[117,-8],[117,-7],[116,-7]],[[116.2,-7.8],[116.4,-7.8],[116.4,-7.6],[116.2,-7.6]]]};
const feature=g=>({type:'Feature',properties:{nib:'A<&"',note:'Indon�sie ??'},geometry:g});
const r=c.parse(JSON.stringify({type:'FeatureCollection',features:[feature(polygon),feature({type:'MultiPolygon',coordinates:[polygon.coordinates]}),feature({type:'Point',coordinates:[116,-8]}),feature(null),feature({type:'Point',coordinates:[400,900]})]}),'a.geojson');
assert.equal(r.valid.length,3);assert.equal(r.errors.length,2);assert.equal(r.totals.polygons,2);assert.equal(r.totals.points,1);
const kml=c.kml(r,'Parcels & test','nib');assert.equal((kml.match(/innerBoundaryIs>/g)||[]).length,4);assert.ok(kml.includes('A&lt;&amp;&quot;'));assert.ok(!kml.includes('NaN'));
fs.writeFileSync(__dirname+'/test-output.kml',kml);fs.writeFileSync(__dirname+'/test-output.kmz',c.kmz(kml));
for(const delimiter of [',',';','\t']){
 const text='\ufeffnib'+delimiter+'lon'+delimiter+'lat'+delimiter+'note\r\nX'+delimiter+'116.2'+delimiter+'-8.8'+delimiter+'"hello, world\nsecond ""line"""\r\nY'+delimiter+''+delimiter+'-8'+delimiter+'missing';
 const parsed=c.parse(text,'a.csv');assert.equal(parsed.valid.length,1);assert.equal(parsed.errors.length,1);assert.equal(parsed.valid[0].properties.note,'hello, world\nsecond "line"');
}
const quoted=JSON.stringify(polygon).replace(/"/g,'""');assert.equal(c.parse('nib,geometry\nP,"'+quoted+'"','a.csv').totals.polygons,1);
assert.throws(()=>c.parse('lon,lat,lat\n1,2,3','a.csv'));assert.throws(()=>c.parse('{"type":"FeatureCollection","crs":{},"features":[]}','a.json'));
assert.equal(c.parse(JSON.stringify(feature({type:'LineString',coordinates:[[1,2],[3,4]]})),'line.json').totals.lines,1);
assert.equal(c.parse(JSON.stringify(feature({type:'Polygon',coordinates:[[[1,1],[1,1],[1,1]]]})),'bad.json').errors.length,1);
console.log('Passed: geometry, polygon holes, XML escaping, CSV quoting/delimiters/BOM, invalid records and KMZ generation.');

