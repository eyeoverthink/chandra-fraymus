import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

// convert.js records provenance in the database and writes into data/media: give it its own data folder
// BEFORE anything imports server/db.js, or the test would write into the real store.
let directory, F, G, C, R, P, scene, kit;
const previousDataDir = process.env.CHANDRA_DATA_DIR;
before(async () => {
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'chandra-looks-'));
  process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
  F = await import('../server/media/looks/filters.js');
  G = await import('../server/media/looks/glyph-looks.js');
  C = await import('../server/media/looks/convert.js');
  R = await import('../server/media/looks/recipes.js');
  P = await import('../server/media/make-plan.js');
  scene = await import('../server/media/flat/scene.js');
  kit = await import('../server/media/flat/kit.js');
});
after(async () => {
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR; else process.env.CHANDRA_DATA_DIR = previousDataDir;
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
});

// A test picture with something to find in it: a sky gradient, a dark hill, a bright disc and a red box.
function testPicture(w = 320, h = 180) {
  const img = F.image(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3; let r = 90 + y * 0.4, g = 150 + y * 0.3, b = 230;
    if (y > h * 0.62 + Math.sin(x / 30) * 12) { r = 40; g = 110; b = 50; }
    if ((x - w * 0.75) ** 2 + (y - h * 0.25) ** 2 < (h * 0.12) ** 2) { r = 250; g = 225; b = 120; }
    if (x > w * 0.2 && x < w * 0.35 && y > h * 0.45 && y < h * 0.75) { r = 200; g = 40; b = 40; }
    img.d[i] = r; img.d[i + 1] = g; img.d[i + 2] = b;
  }
  return img;
}
const hash = img => createHash('sha1').update(img.d).digest('hex');
const spread = img => { let s = 0, s2 = 0; const n = img.d.length; for (let i = 0; i < n; i++) { s += img.d[i]; s2 += img.d[i] * img.d[i]; } const m = s / n; return Math.sqrt(s2 / n - m * m); };

test('every look turns a picture into a different, non-blank picture of the right size, the same way every time', () => {
  const src = testPicture();
  assert.ok(C.LOOK_NAMES.length >= 15,`has ${C.LOOK_NAMES.length} looks`);
  for (const look of C.LOOK_NAMES) {
    const ctx = () => ({ seed: 7, frame: 0, state: {}, outW: 640, outH: 360 });
    const a = C.applyLook(look, src, ctx()).img, b = C.applyLook(look, src, ctx()).img;
    const full = C.LOOKS[look].fullSize;
    assert.deepEqual([a.w, a.h], full ? [640, 360] : (C.LOOKS[look].pixel ? [a.w, a.h] : [src.w, src.h]), `${look}: size`);
    assert.equal(a.d.length, a.w * a.h * 3, `${look}: three channels`);
    assert.equal(hash(a), hash(b), `${look}: deterministic`);
    if (!full && a.w === src.w) assert.notEqual(hash(a), hash(src), `${look}: changes the picture`);
    assert.ok(spread(a) > 8, `${look}: not blank (spread ${spread(a).toFixed(1)})`);
    assert.ok(C.LOOKS[look].label && C.LOOKS[look].technique, `${look}: says what it is and how it is made`);
  }
  assert.throws(() => C.applyLook('nope', src), /unknown look/);
});

test('the filters keep their promises: ink finds edges, a palette has k colours, mapping uses only them', () => {
  const src = testPicture();
  const ink = F.inkMask(src, { threshold: 60 });
  const at = (x, y) => ink[y * src.w + x];
  assert.ok(at(Math.round(src.w * 0.2), Math.round(src.h * 0.6)) > 0, 'an ink line on the red box edge');
  assert.equal(at(5, 5), 0, 'no ink in the flat sky corner');
  const pal = F.kmeansPalette(src, 5);
  assert.equal(pal.length, 5);
  const mapped = F.mapToPalette(src, pal).img, seen = new Set();
  for (let i = 0; i < mapped.d.length; i += 3) seen.add(`${mapped.d[i]},${mapped.d[i + 1]},${mapped.d[i + 2]}`);
  assert.ok(seen.size <= 5, `${seen.size} colours after mapping`);
  assert.equal(F.noise2(3, 4, 9), F.noise2(3, 4, 9)); assert.notEqual(F.noise2(3, 4, 9), F.noise2(3, 4, 10));
});

test('glyph looks draw characters and bricks, and the brick palette has a sky', () => {
  const src = testPicture();
  const a = G.ascii(src, { w: 480, h: 270, cols: 60 }), b = G.brick(src, { w: 480, h: 270, studs: 24 });
  assert.deepEqual([a.w, a.h, b.w, b.h], [480, 270, 480, 270]);
  // the top-left of the brick mosaic is the sky: blue must win over grey
  const p = (b.d[(20 * b.w + 20) * 3 + 2]) - (b.d[(20 * b.w + 20) * 3]);
  assert.ok(p > 20, 'sky plate is blue, not grey');
});

test('sizes are even, never shrink a small picture below its size, and stop at 3x', () => {
  assert.deepEqual(C.sizesFor(1921, 1081), { work: [960, 540], out: [1920, 1080] });
  assert.deepEqual(C.sizesFor(320, 180).out, [960, 540]);
  for (const [w, h] of [[333, 777], [4000, 3001], [17, 9]]) { const s = C.sizesFor(w, h); for (const n of [...s.work, ...s.out]) assert.equal(n % 2, 0, `${w}x${h}`); }
});

test('camera moves always show the picture, never past its edge', () => {
  for (const name of C.CAMERA_MOVE_NAMES) for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const v = C.CAMERA_MOVES[name](p, Math.round(p * 120));
    assert.ok(v.z >= 1, `${name} at ${p}: zoom ${v.z}`);
    const half = 0.5 / v.z;
    assert.ok(v.cx >= half - 1e-9 && v.cx <= 1 - half + 1e-9 && v.cy >= half - 1e-9 && v.cy <= 1 - half + 1e-9, `${name} at ${p}: view inside the picture`);
  }
});

test('style recipes: names route, never reach the prompt, and franchise characters are never drawn', () => {
  const cases = { 'a girl and her cat on a hill, Miyazaki style': 'pastoral-anime', 'a robot boy flying over a city like Astro Boy': 'retro-robot-anime', 'two fighters in Dragon Ball Z style': 'shonen-action', 'a skater, Spider-Verse look': 'comic-hybrid', 'a portrait in the style of Klimt': 'gold-ornament', 'a fox in a Kurzgesagt style': 'flat', 'a ukiyo-e wave': 'woodblock', 'a forest like Over the Garden Wall': 'brunaille', 'a city like Tekkonkinkreet': 'lowpoly-ink', 'a beach, The Red Turtle style': 'charcoal-watercolor', 'a lego castle': 'brick', 'a dog': null };
  for (const [text, want] of Object.entries(cases)) assert.equal(R.recipeFor(text), want, text);
  const names = /miyazaki|ghibli|tezuka|astro ?boy|dragon ?ball|toriyama|spider|arcane|fortiche|klimt|hokusai|hiroshige|samurai jack|kubo|fleischer|garden wall|fantastic planet|plan[eè]te|tekkon|red turtle|bashir|scanner darkly|kurzgesagt|lego|nintendo|game ?boy/i;
  for (const [id, r] of Object.entries(R.RECIPES)) {
    assert.ok(!names.test(r.style) && !names.test(r.negative), `${id}: the prompt describes the look, never whose it is`);
    if (r.post) assert.ok(C.LOOKS[r.post], `${id}: finishes with a look that exists (${r.post})`);
  }
  const g = R.cleanSubject('Goku powering up in Dragon Ball Z style');
  assert.deepEqual(g.replaced, ['goku']); assert.match(g.subject, /an original character powering up$/); assert.ok(!/dragon/i.test(g.subject));
  assert.deepEqual(R.cleanSubject('San Francisco at night, Miyazaki style').replaced, []);
  assert.match(R.cleanSubject('San Francisco at night, Miyazaki style').subject, /^San Francisco at night/);
  assert.match(R.cleanSubject('Spider-Man swinging, spider-verse style').subject, /^an original character swinging/);
  const rp = R.recipePrompt('woodblock', 'a fox');
  assert.match(rp.prompt, /^a fox, Japanese ukiyo-e/); assert.equal(rp.post, 'woodblock');
  assert.throws(() => R.recipePrompt('nope', 'x'), /unknown recipe/);
});

test("a real person's face is only converted with consent", async () => {
  const png = await sharp(Buffer.from(testPicture().d), { raw: { width: 320, height: 180, channels: 3 } }).png().toBuffer();
  await assert.rejects(C.convertImage(png, { look: 'comic-hybrid', realFace: true }), e => e.code === 'consent_required');
  await assert.rejects(C.animateStill(png, { move: 'push-in', realFace: true, consent: 'yes' }), e => e.code === 'consent_required');
  const ok = await C.convertImage(png, { look: 'woodblock', realFace: true, consent: true, source: 'test' });
  const meta = await sharp(ok.path).metadata();
  assert.deepEqual([meta.width, meta.height], [960, 540]);
  assert.ok(ok.path.startsWith(path.join(directory, 'data', 'media')), 'saved in the data folder');
  assert.equal(C.shelfFile(ok.file), ok.path);
  assert.throws(() => C.shelfFile('../secret.txt'), /bare file name/);
  assert.throws(() => C.shelfFile('nothing-here.png'), e => e.status === 404);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
test('a still becomes a film with a camera move and a look', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const png = await sharp(Buffer.from(testPicture(640, 360).d), { raw: { width: 640, height: 360, channels: 3 } }).png().toBuffer();
  const film = await C.animateStill(png, { move: 'crash-zoom', seconds: 2, look: 'comic-hybrid', format: '1:1', source: 'test' });
  assert.ok(existsSync(film.path));
  const info = await C.probe(film.path);
  assert.deepEqual([info.w, info.h], [1080, 1080]);
  assert.ok(Math.abs(info.seconds - 2) < 0.2, `duration ${info.seconds}`);
  assert.equal(film.frames, 24, 'held on twos: 48 frames shown, 24 drawn');
  await assert.rejects(C.animateStill(png, { move: 'barrel-roll' }), /unknown camera move/);
});

test('motion clips: a still clip is told apart from a moving one', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = path.join(directory, 'motion');
  await fs.mkdir(dir, { recursive: true });
  const make = (name, src) => { const out = path.join(dir, name); const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-pix_fmt', 'yuv420p', out], { windowsHide: true }); assert.equal(r.status, 0, String(r.stderr)); return out; };
  const still = await C.measureMotion(make('still.mp4', 'color=c=0x336699:s=320x180:d=2:r=24'));
  const moving = await C.measureMotion(make('moving.mp4', 'testsrc2=s=320x180:d=2:r=24'));
  assert.ok(still.overall < 0.5 && still.frames >= 40, `a still clip scores ~0 (${still.overall})`);
  assert.ok(moving.overall > C.MOTION_MIN, `a moving clip scores above ${C.MOTION_MIN} (${moving.overall})`);
  const png = await C.coverPng(await sharp({ create: { width: 400, height: 300, channels: 3, background: '#808080' } }).png().toBuffer(), 960, 544);
  assert.deepEqual([(await sharp(png).metadata()).width, (await sharp(png).metadata()).height], [960, 544]);
  await assert.rejects(C.coverPng(png, 960, 544, { realFace: true }), e => e.code === 'consent_required');
});

test('the worker builds a valid Wan 2.2 job: 4n+1 frames, sizes in 32s, the native graph', t => {
  const python = process.env.PYTHON || 'python';
  if (spawnSync(python, ['-I', '-c', 'print(1)'], { encoding: 'utf8' }).status !== 0) { t.skip('python is not available'); return; }
  const code = `import sys, json; sys.path.insert(0, 'scripts/worker'); import chandra_worker as w
out = []
for spec in [{"prompt": "hair moves", "seconds": 3, "width": 960, "height": 544}, {"prompt": "x", "seconds": 99, "width": 5000, "height": 10}, {"prompt": "x", "seconds": 0.1}]:
    c = w.clean_i2v(spec, "job1"); out.append(c)
try:
    w.clean_i2v({"prompt": "  "}, "j"); out.append("no error")
except ValueError: out.append("refused")
g = w.wan_workflow("in.png", out[0]); out.append(sorted(n["class_type"] for n in g.values()))
print(json.dumps(out))`;
  const r = spawnSync(python, ['-I', '-c', code], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  const [a, b, c, refused, classes] = JSON.parse(r.stdout.trim().split('\n').pop());
  for (const x of [a, b, c]) { assert.equal((x.frames - 1) % 4, 0, `${x.frames} frames is 4n+1`); assert.equal(x.width % 32, 0); assert.equal(x.height % 32, 0); }
  assert.equal(a.frames, 73); assert.deepEqual([a.width, a.height], [960, 544]);
  assert.ok(b.frames <= 121 && b.width <= 1280 && b.height >= 256, 'clamped to 5 s and the model\'s sizes');
  assert.ok(c.frames >= 5);
  assert.equal(refused, 'refused');
  for (const n of ['UNETLoader', 'CLIPLoader', 'VAELoader', 'ModelSamplingSD3', 'Wan22ImageToVideoLatent', 'KSampler', 'VAEDecode', 'SaveImage']) assert.ok(classes.includes(n), n);
});

test('stick figures: routed by the sentence, drawn as a film, arms visible when they cheer', () => {
  for (const s of ['a 20 second stick figure story about a lost kite', 'a stick-figure animation about saving money', 'stickman fights a cloud', 'an xkcd style short on time zones'])
    assert.equal(P.parseRequest(s).style, 'stick', s);
  assert.equal(P.parseRequest('a stickler for rules, kurzgesagt style').style, 'flat');
  assert.ok(P.isVector('stick') && P.isVector('flat') && !P.isVector('8bit'));
  assert.equal(P.planCreation('a stick figure still of a cat', { kind: 'still' }).blocked?.reason, 'still_not_wired');
  const shot = { setting: 'field', props: [], cast: [{ who: 'nilo', feel: 'happy', act: 'cheer' }], camera: 'still' };
  const stick = scene.shotSvg(shot, 1, { format: '16:9', figures: 'stick' }), flat = scene.shotSvg(shot, 1, { format: '16:9' });
  assert.notEqual(stick, flat);
  assert.ok(!/NaN|undefined/.test(stick));
  // a raised hand must end outside the head circle (head centre 0,50 radius 50, shoulder at y 134, arm 78 long)
  const svg = kit.stickFigureSvg('nilo', { x: 0, y: 0, act: 'cheer', t: 0 });
  const hands = [...svg.matchAll(/<path d="M0,134 L(-?[\d.]+),(-?[\d.]+)"/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(hands.length, 2);
  for (const [x, y] of hands) { assert.ok(y < 134, 'arm raised'); assert.ok(Math.hypot(x, y - 50) > 52, `hand at ${x},${y} is outside the head`); }
});
