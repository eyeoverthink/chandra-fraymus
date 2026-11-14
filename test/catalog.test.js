import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as R from '../server/media/looks/recipes.js';
import * as C from '../server/media/looks/convert.js';
import { image } from '../server/media/looks/filters.js';

const sharp = createRequire(import.meta.url)('sharp');
const NEW = ['pop-silkscreen', 'stencil-graffiti', 'newspaper-strip', 'sprite-16bit', 'hypercube', 'night-story', 'editorial-diagram', 'four-panel', 'yellow-sitcom', 'cgi-feature', 'midcentury-super'];

// a test picture with structure: sky gradient, a dark hill, a bright disc
function scene(w = 320, h = 180) {
  const img = image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y * w + x) * 3, hill = y > h * 0.6 + 20 * Math.sin(x / 30), disc = (x - w * 0.7) ** 2 + (y - h * 0.3) ** 2 < 400;
    const c = disc ? [250, 220, 90] : hill ? [40, 90, 50] : [90 + y, 150 + y * 0.4, 230];
    img.d.set(c, p);
  }
  return img;
}

test('the catalog from Nexus: every new recipe routes by its names and its prompt names nobody', () => {
  for (const id of NEW) assert.ok(R.RECIPES[id], `${id} exists`);
  const cases = {
    'a cat poster, Warhol style': 'pop-silkscreen', 'a Banksy stencil of a kid with a balloon': 'stencil-graffiti', 'a Peanuts style strip about homework': 'newspaper-strip',
    'a SNES platformer level in a forest': 'sprite-16bit', 'a glowing tesseract in space': 'hypercube', 'a bedtime story picture of a sleepy village': 'night-story',
    'a LinkedIn post diagram about remote teams': 'editorial-diagram', 'a reddit comic about a cat and a cucumber': 'four-panel',
    'my family as the Simpsons': 'yellow-sitcom', 'a toaster with feelings, Pixar style': 'cgi-feature', 'a superhero family in The Incredibles style': 'midcentury-super',
    'a pirate ship from The Lego Movie': 'brick',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(R.recipeFor(text), want, text);
  const names = /warhol|banksy|peanuts|schulz|snes|nintendo|sega|genesis|simpsons|groening|springfield|pixar|dreamworks|disney|incredibles|lego|linkedin|reddit|youtube/i;
  for (const [id, r] of Object.entries(R.RECIPES)) {
    assert.ok(!names.test(r.style) && !names.test(r.negative), `${id}: the prompt describes the look, not whose it is`);
    if (r.post) assert.ok(C.LOOKS[r.post], `${id}: finishes with a look that exists (${r.post})`);
  }
});

test('the universes never draw their characters, and ordinary words that are also names are left alone', () => {
  const a = R.cleanSubject('Homer Simpson on the couch, Simpsons style');
  assert.deepEqual(a.replaced, ['homer simpson']); assert.match(a.subject, /an original character on the couch/);
  assert.ok(R.cleanSubject('Buzz Lightyear and Elastigirl at a picnic, Pixar').replaced.length === 2);
  assert.deepEqual(R.cleanSubject('a woody hillside at the Woodstock festival').replaced, []);
  assert.deepEqual(R.cleanSubject('Snoopy on his doghouse').replaced, ['snoopy']);
  // a style name removed from between an article and a preposition (both seen live: "a of a child", "a about a cat")
  assert.equal(R.cleanSubject('a Banksy stencil of a child releasing a heart-shaped balloon').subject, 'a child releasing a heart-shaped balloon');
  assert.equal(R.cleanSubject('a reddit comic about a cat discovering a cucumber').subject, 'a cat discovering a cucumber');
  assert.equal(R.cleanSubject('a cup of tea, Warhol style').subject, 'a cup of tea');   // a real "of" stays
});

test('silkscreen, stencil and newsprint: deterministic, the right size, unlike the source and unlike each other', () => {
  const src = scene();
  const out = {};
  for (const look of ['silkscreen', 'stencil', 'newsprint']) {
    const a = C.applyLook(look, src, { seed: 3, state: {} }).img, b = C.applyLook(look, src, { seed: 3, state: {} }).img;
    assert.deepEqual([a.w, a.h], [src.w, src.h]); assert.deepEqual(a.d, b.d, `${look} is deterministic`);
    let diff = 0; for (let i = 0; i < a.d.length; i++) diff += Math.abs(a.d[i] - src.d[i]);
    assert.ok(diff / a.d.length > 15, `${look} changes the picture (${(diff / a.d.length).toFixed(1)})`);
    out[look] = a;
  }
  const d = (x, y) => { let s = 0; for (let i = 0; i < x.d.length; i++) s += Math.abs(x.d[i] - y.d[i]); return s / x.d.length; };
  assert.ok(d(out.silkscreen, out.stencil) > 15 && d(out.stencil, out.newsprint) > 15 && d(out.silkscreen, out.newsprint) > 15, 'three different looks');
  // the stencil is black, one red and the wall: no blue sky survives
  let blue = 0; for (let p = 0; p < out.stencil.d.length; p += 3) if (out.stencil.d[p + 2] > out.stencil.d[p] + 40) blue++;
  assert.ok(blue / (out.stencil.d.length / 3) < 0.01, `stencil keeps no sky blue (${blue})`);
});

test('16-bit: a 384-pixel grid and at most 48 colours, one palette for a whole video', () => {
  const src = scene(640, 360), state = {};
  const a = C.applyLook('16bit', src, { seed: 7, state }).img;
  assert.deepEqual([a.w, a.h], [384, 216]);
  const colours = new Set(); for (let p = 0; p < a.d.length; p += 3) colours.add((a.d[p] << 16) | (a.d[p + 1] << 8) | a.d[p + 2]);
  assert.ok(colours.size <= 48 && colours.size >= 6, `${colours.size} colours`);
  const pal = state.palette; C.applyLook('16bit', scene(640, 360), { seed: 7, state, frame: 1 });
  assert.equal(state.palette, pal, 'the palette is kept between frames');
});

test('a four-panel story: beats checked before anything is painted', () => {
  const good = { cast: 'a plump grey cat with white paws, a pink nose and a short tail', panels: [
    { scene: 'a grey cat stares at a cucumber on the kitchen floor', caption: 'Something is on the floor.' },
    { scene: 'the grey cat creeps closer to the cucumber, tail low', caption: 'It has not moved.' },
    { scene: 'the grey cat leaps straight up in fright, fur on end', caption: 'It definitely moved.' },
    { scene: 'the grey cat sits proudly on top of the fridge, cucumber far below', caption: 'Higher ground. Always.' }] };
  assert.equal(R.checkPanels(good).ok, true);
  assert.equal(R.checkPanels(good).cast, good.cast);
  // without a description of the character, four panels painted four different cats (seen live): refused
  assert.match(R.checkPanels({ panels: good.panels }).reason, /"cast" has 0 words/);
  assert.match(R.checkPanels({ panels: good.panels.slice(0, 3) }).reason, /3 panels; exactly 4/);
  assert.match(R.checkPanels({ panels: good.panels.map((p, i) => (i === 1 ? { ...p, caption: 'Hm.' } : p)) }).reason, /Panel 2's caption has 1 words/);
  assert.match(R.checkPanels({ panels: good.panels.map(p => ({ ...p, caption: 'The same line.' })) }).reason, /same/);
  assert.match(R.checkPanels({ panels: good.panels.map((p, i) => (i === 0 ? { ...p, scene: 'Snoopy stares at a cucumber on the kitchen floor' } : p)) }).reason, /franchise/);
  assert.match(R.panelMessages('a cat and a cucumber')[0].content, /Exactly 4 panels/);
});

test('the strip lays four panels out 2 x 2 with a caption strip under each', async () => {
  const { composeStrip } = await import('../server/media/looks/index.js');
  const { DATA_DIR } = await import('../server/config.js');
  const tmp = [];
  for (let i = 0; i < 4; i++) { const p = join(DATA_DIR, `panel-test-${i}.png`); await sharp({ create: { width: 1024, height: 704, channels: 3, background: ['#c33', '#3c3', '#33c', '#cc3'][i] } }).png().toFile(p); tmp.push(p); }
  const file = await composeStrip(tmp, ['One.', 'Two.', 'Three.', 'Four.']);
  const path = join(DATA_DIR, 'media', file);
  try {
    const m = await sharp(path).metadata();
    assert.deepEqual([m.width, m.height], [2 * 800 + 3 * 28, 2 * (550 + 92) + 3 * 28]);
    const px = async (x, y) => [...(await sharp(path).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer())];
    assert.ok((await px(28 + 400, 28 + 275))[0] > 150, 'panel 1 is the red picture');
    assert.ok((await px(28 * 2 + 800 + 400, 28 + 275))[1] > 150, 'panel 2 (top right) is the green picture');
  } finally { for (const p of [...tmp, path]) rmSync(p, { force: true }); }
});

test('camera rigs: the far view stays inside the picture, and the two layers move differently', () => {
  for (const name of C.RIG_NAMES) {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const v = C.RIGS[name].at(p), half = 1 / (2 * v.bg.z);
      assert.ok(v.bg.z >= 1, `${name} at ${p}: zoom`);
      assert.ok(v.bg.cx >= half - 1e-9 && v.bg.cx <= 1 - half + 1e-9 && v.bg.cy >= half - 1e-9 && v.bg.cy <= 1 - half + 1e-9, `${name} at ${p}: view inside the picture`);
    }
    assert.ok(C.CAMERA_MOVES[C.RIGS[name].flat], `${name} has a one-layer fallback`);
    const t = [0, 1].map(p => { const v = C.RIGS[name].at(p); return { bgX: v.bg.cx, bgY: v.bg.cy, bgZ: v.bg.z, fgX: 0.5 + v.fg.dx, fgY: 0.5 + v.fg.dy, fgZ: v.fg.z }; });
    assert.equal(C.rigParallax(t).ok, true, `${name} shows depth (${C.rigParallax(t).relative})`);
  }
  // two layers moving as one flat picture show none
  assert.equal(C.rigParallax([{ bgX: 0.5, bgY: 0.5, bgZ: 1, fgX: 0.5, fgY: 0.5, fgZ: 1 }, { bgX: 0.6, bgY: 0.5, bgZ: 1.2, fgX: 0.5 - 0.1 * 1.2, fgY: 0.5, fgZ: 1.2 }]).relative, 0);
});

test('a rig is filmed in two layers from a plate and a cut-out, and in one layer without a subject', async () => {
  const W = 640, H = 360;
  const plateRaw = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = (y * W + x) * 3; plateRaw[p] = (x * 7) % 256; plateRaw[p + 1] = (y * 5) % 256; plateRaw[p + 2] = ((x + y) * 3) % 256; }
  const plate = await sharp(plateRaw, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  const subject = await sharp({ create: { width: 120, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from('<svg width="120" height="160"><ellipse cx="60" cy="80" rx="55" ry="75" fill="#e33"/></svg>') }]).png().toBuffer();
  const files = [];
  try {
    const two = await C.rigFilm({ plate, subject, box: { x: 260, y: 120, w: 120, h: 160 }, size: [W, H], rig: 'bullet-time', seconds: 2, format: '16:9', source: 'test' });
    files.push(two.path);
    assert.equal(two.depth, 'two layers'); assert.equal(two.parallax.ok, true); assert.ok(existsSync(two.path));
    const info = await C.probe(two.path); assert.ok(Math.abs(info.seconds - 2) < 0.2, `${info.seconds} s`);
    const one = await C.rigFilm({ plate, rig: 'crane-up', seconds: 2, format: '16:9', source: 'test' });
    files.push(one.path);
    assert.equal(one.depth, 'one layer');
  } finally { for (const f of files) rmSync(f, { force: true }); }
});
