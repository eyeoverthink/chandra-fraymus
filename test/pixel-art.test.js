import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PALETTES, STYLES, hexRgb, resolvePalette, nativeSize, quantize, distinctColours, pixelateBuffer } from '../server/media/pixel-art.js';

const gradient = (w, h) => {
  const b = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 3; b[i] = Math.round((x / (w - 1)) * 255); b[i + 1] = Math.round((y / (h - 1)) * 255); b[i + 2] = 128; }
  return b;
};
const key = (r, g, b) => (r << 16) | (g << 8) | b;

test('palettes and sizes', () => {
  assert.deepEqual(hexRgb('#0f380f'), [15, 56, 15]);
  assert.throws(() => hexRgb('green'));
  assert.equal(resolvePalette('gb').colours.length, 4);
  assert.equal(resolvePalette('nes').colours.length, 28);
  assert.equal(resolvePalette('nope', 'gb').name, 'gb');
  assert.equal(resolvePalette(['#000000', '#ffffff']).name, 'custom');
  assert.throws(() => resolvePalette(['#000000']));
  assert.deepEqual(nativeSize('2bit'), { w: 240, h: 135, scale: 8 });
  assert.deepEqual(nativeSize('8bit', '9:16'), { w: 180, h: 320, scale: 6 });
  assert.deepEqual(nativeSize('8bit', '1:1'), { w: 180, h: 180, scale: 6 });
  for (const s of Object.values(STYLES)) assert.equal(s.native[0] * s.scale, 1920);
});

test('quantize emits only palette colours', () => {
  const w = 64, h = 36, src = gradient(w, h);
  for (const name of ['gb', 'nes']) {
    const pal = resolvePalette(name).colours;
    const allowed = new Set(pal.map(c => key(...c)));
    const out = quantize(src, w, h, pal);
    assert.equal(out.length, src.length);
    for (let i = 0; i < out.length; i += 3) assert.ok(allowed.has(key(out[i], out[i + 1], out[i + 2])), `${name}: colour outside the palette`);
    assert.ok(distinctColours(out) <= pal.length);
    assert.ok(distinctColours(out) >= 3, `${name}: a gradient should use several colours`);
  }
  assert.throws(() => quantize(Buffer.alloc(10), 4, 4, resolvePalette('gb').colours));
});

test('a four-shade palette is a luminance ramp: black is darkest, white is lightest', () => {
  const pal = resolvePalette('gb').colours;
  const px = quantize(Buffer.from([0, 0, 0, 255, 255, 255]), 2, 1, pal, { dither: false });
  assert.deepEqual([...px.subarray(0, 3)], hexRgb(PALETTES.gb[0]));
  assert.deepEqual([...px.subarray(3, 6)], hexRgb(PALETTES.gb[3]));
});

test('a large palette maps to the nearest colour', () => {
  const pal = resolvePalette('nes').colours;
  const px = quantize(Buffer.from([250, 250, 250, 2, 2, 250]), 2, 1, pal, { dither: false });
  assert.deepEqual([...px.subarray(0, 3)], [252, 252, 252]);
  assert.deepEqual([...px.subarray(3, 6)], [0, 0, 252]);
});

test('dithering is ordered: the same input gives the same output, and it differs from no dither', () => {
  const w = 32, h = 32, src = gradient(w, h), pal = resolvePalette('gb').colours;
  const a = quantize(src, w, h, pal), b = quantize(src, w, h, pal), flat = quantize(src, w, h, pal, { dither: false });
  assert.ok(a.equals(b));
  assert.ok(!a.equals(flat));
});

test('an image becomes a 1080p pixel-art PNG in whole-number blocks', async () => {
  const input = await sharp(gradient(640, 360), { raw: { width: 640, height: 360, channels: 3 } }).png().toBuffer();
  const r = await pixelateBuffer(input, { style: '2bit' });
  assert.deepEqual([r.width, r.height, r.scale, r.palette], [1920, 1080, 8, 'gb']);
  assert.ok(r.colours <= 4 && r.colours >= 2);
  const { data, info } = await sharp(r.png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height], [1920, 1080]);
  assert.ok(distinctColours(data) <= 4);
  // every 8×8 block is one colour: compare each block's corners
  for (let by = 0; by < 135; by += 13) for (let bx = 0; bx < 240; bx += 17) {
    const at = (x, y) => { const i = (y * 1920 + x) * 3; return key(data[i], data[i + 1], data[i + 2]); };
    assert.equal(at(bx * 8, by * 8), at(bx * 8 + 7, by * 8 + 7));
  }
  const v = await pixelateBuffer(input, { style: '8bit', format: '9:16' });
  assert.deepEqual([v.width, v.height, v.native.w, v.native.h], [1080, 1920, 180, 320]);
  assert.ok(v.colours <= 28);
  await assert.rejects(() => pixelateBuffer(input, { style: 'vhs' }));
});
