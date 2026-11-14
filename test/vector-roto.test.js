import test from 'node:test';
import assert from 'node:assert/strict';
import { image } from '../server/media/looks/filters.js';
import { canny, traceEdges, rdp, smoothPath, contours, labelMap, mergeSmall, vectorize, vectorFidelity, VECTOR_STYLE_NAMES } from '../server/media/looks/vector.js';
import { validateChain } from '../server/media/make-chains.js';

const W = 120, H = 90;
const paint = fn => { const img = image(W, H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const [r, g, b] = fn(x, y); const i = (y * W + x) * 3; img.d[i] = r; img.d[i + 1] = g; img.d[i + 2] = b; } return img; };
const square = (x, y) => x >= 30 && x < 90 && y >= 20 && y < 70;

test('Canny gives one thin line per edge, not the two sides a gradient threshold marks', () => {
  const img = paint((x, y) => (square(x, y) ? [30, 30, 30] : [230, 230, 230]));
  const { edges } = canny(img, { blur: 1 });
  // across the left side of the square (x = 30) on a middle row, the edge is one or two pixels wide, never a band
  let run = 0;
  for (let x = 20; x < 40; x++) run += edges[45 * W + x];
  assert.ok(run >= 1 && run <= 2, `edge width on a row: ${run}`);
  const lines = traceEdges(edges, W, H, { minLength: 8 });
  const longest = Math.max(...lines.map(l => l.length));
  assert.ok(longest > 150, `the square's outline traced as long chains (longest ${longest})`);
});

test('RDP keeps corners and drops collinear points; the path is valid SVG path data', () => {
  const pts = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1], [4, 2], [4, 3]];
  const s = rdp(pts, 0.5);
  assert.deepEqual(s, [[0, 0], [4, 0], [4, 3]]);
  assert.match(smoothPath(s), /^M0 0Q4 0 4 1\.5L4 3$/);
  assert.match(smoothPath(s, 1, true), /Z$/);
});

test('marching squares: a square is one loop of its own area, a ring is two loops', () => {
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = square(x, y) ? 1 : 0;
  const loops = contours(mask, W, H);
  assert.equal(loops.length, 1);
  const area = l => Math.abs(l.reduce((a, [x1, y1], i) => { const [x2, y2] = l[(i + 1) % l.length]; return a + x1 * y2 - x2 * y1; }, 0) / 2);
  assert.ok(Math.abs(area(loops[0]) - 60 * 50) < 60 * 50 * 0.05, `area ${area(loops[0])}`);
  for (let y = 35; y < 55; y++) for (let x = 50; x < 70; x++) mask[y * W + x] = 0;     // punch a hole
  assert.equal(contours(mask, W, H).length, 2);
});

test('speckle is cleaned: single pixels and tiny islands join their surroundings', () => {
  const img = paint((x, y) => ((x * 7 + y * 13) % 97 === 0 ? [250, 0, 0] : square(x, y) ? [0, 0, 250] : [250, 250, 250]));
  const pal = [[250, 250, 250], [0, 0, 250], [250, 0, 0]];
  const lab = mergeSmall(labelMap(img, pal, 2), W, H, 6);
  assert.equal(lab.filter(v => v === 2).length, 0, 'the red specks are gone');
  assert.ok(lab.filter(v => v === 1).length > 2500, 'the blue square stays');
});

test('every style makes a parseable SVG with no scripts; filled styles keep the colours', async () => {
  const { renderSvg } = await import('../server/media/looks/vector-render.js');
  const img = paint((x, y) => (square(x, y) ? [200, 60, 40] : y > 75 ? [40, 90, 60] : [120, 170, 230]));
  for (const style of VECTOR_STYLE_NAMES) {
    const v = vectorize(img, { style, outW: 240, outH: 180 });
    assert.doesNotMatch(v.svg, /<script|on\w+=/i, `${style}: no script`);
    const r = await renderSvg(v.svg);
    assert.equal(r.w, 240, `${style} rendered at its output size`);
    assert.ok(v.stats.lines > 0, `${style} drew lines`);
    const f = vectorFidelity(img, (await import('../server/media/looks/vector.js')).resize(r.img, W, H));
    if (style === 'cutout' || style === 'comic') assert.ok(f.colourError < 30, `${style} colour error ${f.colourError}`);
  }
});

test('a clip keeps one palette: the first frame\'s colours are reused', () => {
  const a = paint((x, y) => (square(x, y) ? [200, 60, 40] : [120, 170, 230]));
  const b = paint((x, y) => (square(x - 4, y) ? [205, 65, 45] : [118, 168, 228]));
  const v1 = vectorize(a, { style: 'cutout' });
  const v2 = vectorize(b, { style: 'cutout', palette: v1.palette });
  assert.deepEqual(v2.palette, v1.palette);
  const fills = svg => [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(fills(v2.svg))], [...new Set(fills(v1.svg))]);
});

test('a vector step in a chain needs a picture', () => {
  assert.match(validateChain({ steps: [{ kind: 'vector' }] }).errors.join(), /needs a image/);
  assert.equal(validateChain({ steps: [{ kind: 'paint', prompt: 'x' }, { kind: 'vector', style: 'ink' }] }).ok, true);
});
