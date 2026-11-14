import test from 'node:test';
import assert from 'node:assert/strict';
import { image } from '../server/media/looks/filters.js';
import { subjectMask, finishMask, borderSpread, fillHole, plateCheck, levelFromPicture, matteClarity, alphaFromMask, morph, MIN_CLARITY, PLAIN_BORDER } from '../server/media/looks/layers.js';
import { validateChain } from '../server/media/make-chains.js';

const W = 160, H = 120;
function paint(fn) { const img = image(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); const i = (y * W + x) * 3; img.d[i] = r; img.d[i + 1] = g; img.d[i + 2] = b; } return img; }
const inBox = (x, y) => x >= 50 && x < 110 && y >= 30 && y < 100;

test('a subject on a plain background is separated, at about its true size', () => {
  const img = paint((x, y) => (inBox(x, y) ? [200, 40, 40] : [235, 235, 238]));
  const m = subjectMask(img, { work: 160 });
  assert.equal(m.ok, true, m.reason);
  const truth = (60 * 70) / (W * H);
  assert.ok(Math.abs(m.share - truth) < 0.02, `share ${m.share} vs ${truth}`);
  // the edge barrier also stops on the background pixel touching the outline: a one-pixel halo at most
  assert.ok(Math.abs(m.box.x - 50) <= 1 && Math.abs(m.box.y - 30) <= 1, JSON.stringify(m.box));
});

test('a drawn outline stops the fill where the subject has the background\'s colour', () => {
  // a white figure on white, with a dark outline: the colour fill alone would walk straight through it
  const img = paint((x, y) => {
    const edge = inBox(x, y) && (x === 50 || x === 109 || y === 30 || y === 99 || x === 51 || x === 108 || y === 31 || y === 98);
    return edge ? [30, 30, 30] : [240, 240, 240];
  });
  const m = subjectMask(img, { work: 160 });
  assert.equal(m.ok, true, m.reason);
  assert.ok(m.share > 0.15, `the white inside should be subject, share ${m.share}`);
  const noEdges = subjectMask(img, { work: 160, edgeStop: 0 });
  assert.ok(noEdges.share > 0.15, 'the inside is still enclosed by the dark outline (hole filling)');
});

test('a busy background is refused instead of guessed', () => {
  const img = paint((x, y) => [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * 7 + y * 41) % 256]);
  assert.ok(borderSpread(img) > PLAIN_BORDER);
  const m = subjectMask(img);
  assert.equal(m.ok, false);
  assert.match(m.reason, /busy/);
});

test('finishMask keeps the largest piece, or the one under a point, and fills enclosed holes', () => {
  const w = 40, h = 30, fg = new Uint8Array(w * h);
  for (let y = 5; y < 25; y++) for (let x = 3; x < 18; x++) fg[y * w + x] = 1;       // big piece
  for (let y = 10; y < 16; y++) for (let x = 28; x < 34; x++) fg[y * w + x] = 1;     // small piece
  for (let y = 12; y < 15; y++) for (let x = 8; x < 11; x++) fg[y * w + x] = 0;      // a hole in the big one
  const big = finishMask(fg, w, h, {});
  assert.equal(big.box.x, 3);
  assert.equal(big.mask[13 * w + 9], 1, 'the enclosed hole is filled');
  const small = finishMask(fg, w, h, { point: [30 / (w - 1), 13 / (h - 1)] });
  assert.equal(small.box.x, 28);
  assert.throws(() => finishMask(new Uint8Array(w * h * 3), w, h), /values for a/);   // the 3-channel bug seen live
});

test('the hole is filled from around it and nothing else moves', () => {
  const img = paint((x, y) => (inBox(x, y) ? [200, 40, 40] : [20 + x, 90, 200 - y]));
  const hole = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hole[y * W + x] = inBox(x, y) ? 1 : 0;
  const plate = fillHole(img, hole);
  for (let i = 0; i < hole.length; i++) if (!hole[i]) assert.equal(plate.d[i * 3], img.d[i * 3]);
  const c = (60 * W + 80) * 3;                      // centre of the hole: no longer red, close to the gradient around it
  assert.ok(plate.d[c] < 150 && plate.d[c + 2] > 100, `filled with ${plate.d[c]},${plate.d[c + 1]},${plate.d[c + 2]}`);
  const check = plateCheck(img, plate, hole);
  assert.equal(check.ok, true, check.reason);
  assert.equal(check.changedOutside, 0);
});

test('plateCheck refuses an untouched subject and a flat patch in a textured scene', () => {
  const textured = paint((x, y) => (((x >> 2) + (y >> 2)) % 2 ? [40, 120, 40] : [200, 210, 120]));
  const hole = new Uint8Array(W * H);
  for (let y = 40; y < 80; y++) for (let x = 60; x < 100; x++) hole[y * W + x] = 1;
  assert.match(plateCheck(textured, textured, hole).reason, /still there/);
  const slab = image(W, H, new Uint8ClampedArray(textured.d));
  for (let i = 0; i < hole.length; i++) if (hole[i]) { slab.d[i * 3] = 70; slab.d[i * 3 + 1] = 40; slab.d[i * 3 + 2] = 20; }
  const r = plateCheck(textured, slab, hole, { w: W, h: H });
  assert.equal(r.ok, false);
  assert.match(r.reason, /flatter than its surroundings/);
});

test('a level: open sky, solid ground, platform tops marked', () => {
  const img = paint((x, y) => (y > 90 || (y > 60 && y < 70 && x > 40 && x < 100) ? [80, 60, 40] : [120, 180, 240]));
  const lvl = levelFromPicture(img, { cols: 16, rows: 12 });
  assert.equal(lvl.tiles.length, 12);
  assert.match(lvl.tiles[0], /^\.+$/);
  assert.match(lvl.tiles[11], /[#=]{16}/);
  assert.ok(lvl.tiles.some((row, y) => y > 3 && y < 9 && row.includes('=')), lvl.tiles.join('\n'));
});

test('matte clarity tells a decided matte from a haze', () => {
  const decided = Uint8Array.from({ length: 1000 }, (_, i) => (i < 300 ? 255 : 0));
  const haze = Uint8Array.from({ length: 1000 }, (_, i) => 60 + (i % 120));
  assert.ok(matteClarity(decided) >= MIN_CLARITY);
  assert.ok(matteClarity(haze) < MIN_CLARITY);
});

test('soft alpha keeps the subject opaque and the background clear', () => {
  const w = 20, h = 20, m = new Uint8Array(w * h);
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) m[y * w + x] = 1;
  const a = alphaFromMask(m, w, h, 80, 80);
  assert.equal(a[40 * 80 + 40], 255);
  assert.equal(a[2 * 80 + 2], 0);
  assert.equal(morph(m, w, h, 2)[3 * w + 5], 1);
});

test('a layers step in a chain needs a picture before it', () => {
  assert.match(validateChain({ steps: [{ kind: 'layers' }] }).errors.join(), /needs a image/);
  assert.equal(validateChain({ steps: [{ kind: 'paint', prompt: 'x' }, { kind: 'layers', keep: 'subject' }, { kind: 'move' }] }).ok, true);
});

test('a figure painted back into the hole is caught; a background that continues is not', async () => {
  const { silhouetteScore, boxHole, SILHOUETTE_MAX } = await import('../server/media/looks/layers.js');
  const subject = new Uint8Array(W * H), hole = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { subject[y * W + x] = inBox(x, y) ? 1 : 0; hole[y * W + x] = x >= 44 && x < 116 && y >= 24 && y < 106 ? 1 : 0; }
  const mist = paint(() => [200, 205, 210]);
  const ghost = paint((x, y) => (inBox(x, y) ? [30, 30, 35] : [200, 205, 210]));   // a dark figure in the subject's shape
  assert.equal(silhouetteScore(mist, subject, hole).ok, true);
  const g = silhouetteScore(ghost, subject, hole);
  assert.equal(g.ok, false);
  assert.ok(g.score > SILHOUETTE_MAX);
  const box = boxHole(subject, W, H, 4);
  assert.equal(box[(30 - 4) * W + (50 - 4)], 1);
  assert.equal(box[(30 - 5) * W + 80], 0);
});

test('restyling a cutout keeps it transparent', async () => {
  const sharp = (await import('sharp')).default;
  const { convertImage } = await import('../server/media/looks/convert.js');
  const w = 64, h = 64, rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, inside = x > 16 && x < 48 && y > 16 && y < 48; rgba[i] = 200; rgba[i + 1] = 60; rgba[i + 2] = 40; rgba[i + 3] = inside ? 255 : 0; }
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  for (const look of ['8bit', 'woodblock']) {
    const r = await convertImage(png, { look, source: 'test' });
    const { data, info } = await sharp(r.path).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4, `${look} kept an alpha channel`);
    assert.equal(data[3], 0, `${look}: a corner is transparent`);
    const c = ((info.height >> 1) * info.width + (info.width >> 1)) * 4;
    assert.equal(data[c + 3], 255, `${look}: the middle is opaque`);
  }
});

test('the inpaint input keeps the prefilled colour under the transparent hole', async () => {
  const sharp = (await import('sharp')).default;
  const { inpaintInput } = await import('../server/media/looks/index.js');
  const pre = paint(() => [220, 30, 30]);
  const hole = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hole[y * W + x] = inBox(x, y) ? 1 : 0;
  const png = await inpaintInput(pre, hole, 320, 256);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const i = ((128 * 320) + 160) * 4;                       // the middle of the hole
  assert.equal(data[i + 3], 0, 'transparent where the model repaints');
  assert.ok(data[i] > 200 && data[i + 1] < 60, `the colour under it is the prefill, not black: ${data[i]},${data[i + 1]},${data[i + 2]}`);
});
