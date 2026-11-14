import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const src = readFileSync(new URL('../server/media/page-kit/platformer.js', import.meta.url), 'utf8');
const g = {}; new Function('globalThis', 'window', src)(g, undefined);
const K = g.ChandraPlatformer;

test('the jump numbers come from the physics', () => {
  const { PHYS, REACH } = K;
  const up = PHYS.jump ** 2 / (2 * PHYS.gravity) / PHYS.tile, across = PHYS.run * (2 * PHYS.jump / PHYS.gravity) / PHYS.tile;
  assert.ok(REACH.up < up && REACH.up >= up - 1.4, `up ${REACH.up} of ${up.toFixed(2)}`);
  assert.ok(REACH.across < across && REACH.across >= across - 1.6, `across ${REACH.across} of ${across.toFixed(2)}`);
});

test('generated levels are deterministic and always winnable, with a start, a goal and coins', () => {
  assert.deepEqual(K.level.generate({ seed: 5 }), K.level.generate({ seed: 5 }));
  for (let seed = 1; seed <= 40; seed++) for (const difficulty of [1, 2, 3]) {
    const t = K.level.generate({ seed, difficulty });
    const r = K.level.reachable(t);
    assert.ok(r.maxCol >= t[0].length - 3, `seed ${seed} difficulty ${difficulty}: reaches column ${r.maxCol} of ${t[0].length}`);
    assert.equal(t.join('').split('S').length - 1, 1); assert.equal(t.join('').split('G').length - 1, 1);
  }
});

test('the search refuses what the jumps cannot do, and makePlayable repairs it', () => {
  const wall = ['..........', '..........', '..........', '.....#####', '.....#####', '.....#####', '.....#####', '##########'];
  // a five-tile wall cannot be climbed with a three-tile jump
  assert.ok(K.level.reachable(wall).maxCol < 5);
  const fixed = K.level.makePlayable(wall);
  assert.equal(fixed.reachable, true, fixed.fixes.join('; '));
  assert.ok(fixed.fixes.length > 0);
  const pit = ['............', '............', '............', '###.......##', '###.......##'];   // a seven-tile pit: too wide
  assert.ok(K.level.reachable(pit).maxCol < 10);
  assert.equal(K.level.makePlayable(pit).reachable, true);
});

test('a picture becomes a level: sky open, ground solid, and winnable', async () => {
  const { image } = await import('../server/media/looks/filters.js');
  const { levelFromImage } = await import('../server/media/game-builder.js');
  const W = 320, H = 140, img = image(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const ground = y > 100 - 30 * Math.sin(x / 40) * (x > 120 && x < 200 ? 1 : 0.3); const i = (y * W + x) * 3; img.d.set(ground ? [70, 120, 50] : [130, 190, 240], i); }
  const l = levelFromImage(img, { cols: 40, rows: 12 });
  assert.equal(l.reachable, true);
  assert.match(l.tiles[0], /^[.o]+$/);
  assert.ok(l.tiles.join('').includes('G'));
});

test('a game page opens in a real browser and plays: it jumps, lands and runs', async () => {
  const { gamePage, playCheck, checkGameSpec } = await import('../server/media/game-builder.js');
  const s = checkGameSpec({ name: 'Test Run', seed: 3, difficulty: 1 }).spec;
  const html = gamePage({ ...s, tiles: K.level.generate({ seed: 3, difficulty: 1 }) });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data:; connect-src 'none'"); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const r = await playCheck(url);
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.ok(r.jumped >= 1 && r.landed && r.ran >= 3);
    // the same play on a CPU slowed 6x (few frames a second): the full suite once failed this by timing the
    // check with the wall clock while the game, clamped per frame, ran slower than real time
    const slow = await playCheck(url, { cpuThrottle: 6 });
    assert.equal(slow.ok, true, 'throttled: ' + slow.problems.join('; '));
  } finally { server.close(); }
});

test('a cramped level read from a picture plays like the search says (held jumps climb a two-tile step)', async () => {
  // the first live picture game (a misty forest): the start is a pocket under a ceiling with a step at column 6. The
  // search called it winnable; a play check that tapped jump and sampled between ~10 fps frames called it broken
  const tiles = [
    '######...######.....#####...............................######..',
    '#####....#....o.....o####=.............o.==.............#####...',
    '###...o.....===....==####.............==................#####...',
    '###...==....###....##.................oo=====...........#####...',
    '###S.o##.==..#.....##......=..........==####.===.=......#####...',
    '###=.=#...........=#.................=.###.#=###=#.............G',
    '####.#..............=..............o.#=###=#######=...........==',
    '####=#=............................==#########o####...........##',
    '######oo...........................########..#=####....=##==#==#',
    '######====.o..===.................=#.######=o#####.o..=#########',
    '##########====###=..................=#######=#####====##########',
    '##################====..............############################',
    '######################=======.........##########################',
    '#############################=========##########################'];
  assert.ok(K.level.reachable(tiles).maxCol >= tiles[0].length - 3);
  const { gamePage, playCheck, checkGameSpec } = await import('../server/media/game-builder.js');
  const html = gamePage({ ...checkGameSpec({ name: 'Cramped', seed: 1, difficulty: 1 }).spec, tiles });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await playCheck(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(r.ok, true, r.problems.join('; '));
    assert.ok(r.ran > 6, `ran ${r.ran} tiles: the step at column 6 was not climbed`);
  } finally { server.close(); }
});

after(async () => { const { closeBrowser } = await import('../server/media/page-builder.js'); await closeBrowser(); });
