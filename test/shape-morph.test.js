import test from 'node:test';
import assert from 'node:assert/strict';
import { resampleClosed, alignLoops, signedArea, contrastRatio, enforceContrast, morphSvg, easeInOut, MORPH_SECONDS } from '../server/media/flat/morph.js';
import { direct } from '../server/media/flat/plan.js';
import { shotSvg } from '../server/media/flat/scene.js';
import { morphFor } from '../server/media/flat/render.js';
import { PROP_NAMES } from '../server/media/flat/props.js';

const circle = (n, r = 50, start = 0, dir = 1) => Array.from({ length: n }, (_, i) => { const a = start + dir * (i / n) * Math.PI * 2; return [r * Math.cos(a), r * Math.sin(a)]; });

test('resampling spaces points evenly along the outline', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const r = resampleClosed(square, 40);
  assert.equal(r.length, 40);
  const gaps = r.map((p, i) => Math.hypot(r[(i + 1) % 40][0] - p[0], r[(i + 1) % 40][1] - p[1]));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.01, `gaps ${Math.min(...gaps)}..${Math.max(...gaps)}`);
});

test('alignment undoes a reversed direction and a shifted start', () => {
  const a = circle(48), b = circle(48, 50, 1.3, -1);             // same circle, other way round, starting elsewhere
  assert.notEqual(Math.sign(signedArea(a)), Math.sign(signedArea(b)));
  const r = alignLoops(a, b);
  assert.equal(r.reversed, true);
  // the start was moved by 1.3 rad, not a whole number of point steps, so a sub-step residual is left (~0.45 px a point)
  assert.ok(r.cost < r.naiveCost / 1000, `aligned ${r.cost.toFixed(1)} vs naive ${r.naiveCost.toFixed(0)}`);
});

test('WCAG contrast: known ratios, and a shape is lifted until it reads', () => {
  assert.equal(Math.round(contrastRatio('#ffffff', '#000000')), 21);
  const sky = '#151340';
  assert.ok(contrastRatio('#000000', sky) < 3);
  assert.ok(contrastRatio(enforceContrast('#000000', sky), sky) >= 3);
  assert.equal(enforceContrast('#ffffff', sky), '#ffffff', 'a colour that already reads is left alone');
});

test('the art director marks morphs between different featured props, never two cuts in a row', () => {
  const s = (props, setting = 'space') => ({ say: 'x', setting, props, cast: [], camera: 'still' });
  const shots = [s(['cell'], 'micro'), s(['planet']), s(['rocket']), s(['earth']), s(['earth'])];
  const fixes = [];
  direct(shots, fixes);
  assert.deepEqual(shots.map(x => x.morphFrom || null), [null, 'cell', null, 'rocket', null]);
  assert.ok(fixes.some(f => /2 cuts become shape morphs/.test(f)));
  // a prop the setting already draws (the sun in a field) is not what a shot features
  const day = [s(['sun', 'kite'], 'field'), s(['bird'], 'field')];
  direct(day, []);
  assert.equal(day[1].morphFrom, 'kite');
  // the first prop still in the next shot: no morph (it would leave and pop back in beside itself)
  const stays = [s(['rocket']), s(['satellite', 'rocket'])];
  direct(stays, []);
  assert.equal(stays[1].morphFrom, undefined);
});

test('a morph frame draws the travelling outline, then the real prop takes over', async () => {
  const { silhouetteOf } = await import('../server/media/flat/silhouette.js');
  const shots = [{ say: 'a cell', setting: 'micro', props: ['cell'], cast: [], camera: 'still' }, { say: 'a planet', setting: 'space', props: ['planet'], cast: [], camera: 'still' }];
  direct(shots, []);
  const m = morphFor(shots, 1, '16:9', { cell: await silhouetteOf('cell'), planet: await silhouetteOf('planet') });
  assert.ok(m, 'a morph was built');
  const mid = shotSvg(shots[1], MORPH_SECONDS / 2, { format: '16:9', dur: 3, morph: m });
  assert.doesNotMatch(mid, /stroke="#ffcf7a"/, 'the planet itself (its ring) is not drawn mid-morph');
  assert.doesNotMatch(shotSvg(shots[1], 0.02, { format: '16:9', dur: 3, morph: m }), /fill="#000" opacity/, 'no dip to black on a morph cut');
  assert.match(shotSvg(shots[1], MORPH_SECONDS + 0.3, { format: '16:9', dur: 3, morph: m }), /stroke="#ffcf7a"/, 'the planet appears after the morph');
  const start = morphSvg({ from: m.from, to: { ...m.to, x: 900, y: 300, scale: 1 }, p: 0, bg: m.bg }), end = morphSvg({ from: m.from, to: { ...m.to, x: 900, y: 300, scale: 1 }, p: 1, bg: m.bg });
  assert.notEqual(start, end);
  assert.equal(easeInOut(0), 0); assert.equal(easeInOut(1), 1);
});

test('every prop has a measured silhouette', async () => {
  const { silhouetteOf } = await import('../server/media/flat/silhouette.js');
  for (const n of PROP_NAMES) {
    const s = await silhouetteOf(n);
    assert.equal(s.loop.length, 96, n);
    assert.ok(s.area > 400, `${n} outline area ${s.area}`);
    assert.match(s.colour, /^#[0-9a-f]{6}$/);
  }
});
