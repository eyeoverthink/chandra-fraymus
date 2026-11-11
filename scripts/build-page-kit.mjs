// Build the compact land outlines the page kit's globe uses.
//
//   node scripts/build-page-kit.mjs <path to ne_110m_land.geojson>
//
// Source: Natural Earth, 1:110m physical "land" (public domain — naturalearthdata.com), fetched from the
// maintainer's repository: github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_land.geojson
// Output: server/media/page-kit/world-land-110m.json — every polygon as rings of [lon×10, lat×10, …] integers
// (0.1° is finer than the 1:110m data itself), about a third of the size of the GeoJSON.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) { console.error('usage: node scripts/build-page-kit.mjs <ne_110m_land.geojson>'); process.exit(1); }
const raw = readFileSync(src);
const geo = JSON.parse(raw.toString('utf8'));
const polygons = [];
let points = 0;
for (const f of geo.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    const rings = [];
    for (const ring of poly) {
      const flat = [];
      let px = null, py = null;
      for (const [lon, lat] of ring) {
        const x = Math.round(lon * 10), y = Math.round(lat * 10);
        if (x === px && y === py) continue;            // rounding can merge neighbours
        flat.push(x, y); px = x; py = y; points++;
      }
      if (flat.length >= 6) rings.push(flat);
    }
    if (rings.length) polygons.push(rings);
  }
}
const out = {
  name: 'world-land-110m',
  source: 'Natural Earth 1:110m land (public domain), naturalearthdata.com',
  sourceFile: 'ne_110m_land.geojson', sourceSha256: createHash('sha256').update(raw).digest('hex'),
  units: 'tenths of a degree: [lon, lat, lon, lat, …] per ring', polygons,
};
const dest = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'media', 'page-kit', 'world-land-110m.json');
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, JSON.stringify(out));
console.log(`${polygons.length} polygons, ${points} points -> ${dest} (${Buffer.byteLength(JSON.stringify(out))} bytes)`);
