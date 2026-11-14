import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

// the component is a browser script; run it in Node with a bare global, as the page would
const src = readFileSync(new URL('../server/media/page-kit/terrain.js', import.meta.url), 'utf8');
const g = {}; new Function('globalThis', 'window', src)(g, undefined);
const T = g.ChandraTerrain;

test('the terrain is deterministic and honours the water share', () => {
  const spec = { seed: 11, water: 0.3, rugged: 0.5, island: true, landmarks: [{ name: 'Hill', kind: 'peak', x: 0.3, z: -0.2 }] };
  const a = T.generate(spec), b = T.generate(spec);
  assert.deepEqual(Buffer.from(a.h), Buffer.from(b.h));
  for (const water of [0.15, 0.3, 0.5]) {
    const w = T.generate({ ...spec, water });
    let under = 0; for (const v of w.h) if (v <= w.water * 255) under++;
    assert.ok(Math.abs(under / w.h.length - water) < 0.02, `asked ${water}, got ${(under / w.h.length).toFixed(3)}`);
  }
  // a named peak raises the land where it stands
  const flat = T.generate({ ...spec, landmarks: [] }), N = a.size, at = (w, x, z) => w.h[Math.round((z * 0.42 + 0.5) * N) * N + Math.round((x * 0.42 + 0.5) * N)];
  assert.ok(at(a, 0.3, -0.2) > at(flat, 0.3, -0.2), 'the peak is higher than the same spot without it');
});

test('a world spec is clamped, and a real place gets no invented landmarks', async () => {
  const { checkWorldSpec, nameGrounded, placeOf } = await import('../server/media/world-builder.js');
  const facts = 'The Isle of Skye is the largest island in the Inner Hebrides. The Cuillin hills and the Old Man of Storr are on it; Portree is its main town.';
  const raw = JSON.stringify({ name: 'Skye', elevation: 9, water: -1, sky: ['#123456', 'blue'], palette: { water: '#2255aa', ground: 'green' },
    landmarks: [{ name: 'Old Man of Storr', kind: 'peak', x: 0.2, z: 0.1 }, { name: 'Dunvegan Castle', kind: 'tower', x: -0.4, z: 0.3 }, { name: 'the old harbour', kind: 'dock', x: 0.21, z: 0.12 }] });
  const r = checkWorldSpec(raw, { facts, request: 'a walkable world of the Isle of Skye' });
  assert.equal(r.ok, true);
  assert.equal(r.spec.elevation, 2); assert.equal(r.spec.water, 0);
  assert.deepEqual(r.spec.sky, ['#7fb6ff', '#dfefff']);
  assert.deepEqual(r.spec.landmarks.map(l => l.name), ['Old Man of Storr', 'the old harbour'], 'Dunvegan Castle is not in the facts');
  assert.equal(r.spec.landmarks[1].kind, 'tower');
  assert.ok(Math.hypot(r.spec.landmarks[0].x - r.spec.landmarks[1].x, r.spec.landmarks[0].z - r.spec.landmarks[1].z) >= 0.2, 'two landmarks on one spot are pushed apart');
  assert.equal(nameGrounded('Portree', facts, ''), true);
  assert.equal(nameGrounded('Talisker Distillery', facts, ''), false);
  assert.equal(placeOf('a walkable world of the Isle of Skye'), 'Isle Skye');
  assert.equal(checkWorldSpec('no json here').ok, false);
});

test('a picture becomes a height map: bright is high, dark is low', async () => {
  const sharp = (await import('sharp')).default;
  const { worldFromPicture } = await import('../server/media/world-builder.js');
  const w = 64, h = 64, rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.round((x / (w - 1)) * 255); rgb.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3); }
  const png = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const d = await worldFromPicture(png, { size: 64 });
  const heights = Buffer.from(d.heights, 'base64');
  assert.equal(heights.length, 64 * 64);
  assert.ok(heights[32 * 64 + 60] > heights[32 * 64 + 4] + 150, 'the bright side is high');
  const world = T.generate({ data: d, water: 0 });
  assert.equal(world.size, 64);
});

test('a built world page opens in a real browser, shows land, walks on the ground and flies', async () => {
  const { worldPage, walkCheck, checkWorldSpec } = await import('../server/media/world-builder.js');
  const spec = checkWorldSpec({ name: 'Test Valley', summary: 'Hills and a lake.', seed: 3, water: 0.25, rugged: 0.5, landmarks: [{ name: 'Watch tower', kind: 'tower', x: 0, z: -0.3 }], start: { x: 0, z: 0.5 } }).spec;
  const dir = join(process.env.CHANDRA_DATA_DIR || '.', 'world-test');
  mkdirSync(dir, { recursive: true });
  const html = worldPage(spec);
  writeFileSync(join(dir, 'index.html'), html);
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data:; connect-src 'none'"); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await walkCheck(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.ok(r.landInFirstView >= 0.1 && r.landInFirstView <= 0.85, `land in view ${r.landInFirstView}: neither open sky nor a wall of ground`);
    assert.ok(Math.abs(r.eyeAboveGround - 5.5) < 2);
    assert.ok(r.flewTo > 20);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

after(async () => { const { closeBrowser } = await import('../server/media/page-builder.js'); await closeBrowser(); });
