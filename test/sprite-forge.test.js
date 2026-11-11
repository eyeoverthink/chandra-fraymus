import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, COLOURS, castName, readLook, forgeSprite, forgeCast, spritePixels } from '../server/media/sprite-forge.js';
import { planCreation, settleKind, normalizeScript, buildStudioMarkdown, speakerLines, normalizeLine, DEFAULT_CAST } from '../server/media/make-plan.js';

test('every template is a 16×16 figure with an outline, a mouth and feet', () => {
  for (const [name, t] of Object.entries(TEMPLATES)) {
    assert.equal(t.rows.length, 16, name);
    assert.ok(t.rows.every(r => r.length === 16 && !/[^.KSHCPAWM]/.test(r)), name);
    const all = t.rows.join('');
    assert.ok(all.includes('M'), `${name} has a mouth`);
    assert.ok(all.includes('K'), `${name} has an outline`);
    assert.ok(t.closed !== 'M' && all.includes(t.closed), `${name}: closed mouth uses a letter the figure has`);
    assert.ok(/[^.]/.test(t.rows[15]), `${name} reaches the ground`);
    const filled = [...all].filter(c => c !== '.').length;
    assert.ok(filled > 90 && filled < 230, `${name} fills a sensible share of the tile (${filled})`);
  }
});

test('names are short single words', () => {
  assert.equal(castName('The Old Baker!'), 'baker');
  assert.equal(castName('Captain  Mara'), 'mara');
  assert.equal(castName('R2-D2 unit'), 'unit');
  assert.equal(castName('', 'x'), 'x');
  assert.equal(castName('Bartholomew-the-magnificent').length <= 12, true);
});

test('what a character is decides the figure', () => {
  const kind = look => readLook(look).template;
  assert.equal(kind('a small orange stray cat'), 'cat');
  assert.equal(kind('a loyal brown dog'), 'dog');
  assert.equal(kind('a wise old owl'), 'bird');
  assert.equal(kind('a shy ghost'), 'ghost');
  assert.equal(kind('a green alien'), 'alien');
  assert.equal(kind('a tall silver robot'), 'robot');
  assert.equal(kind('a small round robot'), 'robot-round');
  assert.equal(kind('an astronaut in a white space suit'), 'astronaut');
  assert.equal(kind('a bald man'), 'human-bald');
  assert.equal(kind('a wizard with a purple hat'), 'human-hat');
  assert.equal(kind('an old man with a grey beard'), 'human-beard');
  assert.equal(kind('a girl with long black hair'), 'human-long');
  assert.equal(kind('a curious kid'), 'human-short');
  assert.equal(readLook('a tired baker').apron, true);
  assert.equal(readLook('', 'robot').kind, 'robot');                       // the name alone is enough
});

test('colours that are said are used on the part they were said about', () => {
  const kid = forgeSprite({ name: 'kid', look: 'a kid in a red shirt and blue pants with blonde hair' });
  assert.equal(kid.colors.C, COLOURS.red); assert.equal(kid.colors.P, COLOURS.blue); assert.equal(kid.colors.H, COLOURS.blonde);
  assert.equal(forgeSprite({ name: 'cat', look: 'a small orange stray cat' }).colors.H, COLOURS.orange);
  assert.equal(forgeSprite({ name: 'bot', look: 'a silver robot with blue lights' }).colors.C, COLOURS.silver);
  assert.equal(forgeSprite({ name: 'bot', look: 'a silver robot with blue lights' }).colors.A, COLOURS.blue);
  const wiz = forgeSprite({ name: 'wizard', look: 'an old wizard with a purple hat and grey beard' });
  assert.equal(wiz.colors.A, COLOURS.purple); assert.equal(wiz.colors.H, COLOURS.grey);
  assert.notEqual(wiz.colors.C, wiz.colors.A);                             // the hat does not vanish into the robe
  const keeper = forgeSprite({ name: 'keeper', look: 'the lighthouse keeper, bearded, navy coat' });
  assert.equal(keeper.colors.C, COLOURS.navy);                             // a coat is clothing, not fur
  assert.equal(forgeSprite({ name: 'ava', look: 'an astronaut with an orange suit' }).colors.A, COLOURS.orange);
  assert.ok(kid.why.some(w => /red main \(said\)/.test(w)));
});

test('a sprite is deterministic and its parts stay readable', () => {
  const a = forgeSprite({ name: 'mara', look: 'a girl with long black hair and a yellow dress' });
  const b = forgeSprite({ name: 'mara', look: 'a girl with long black hair and a yellow dress' });
  assert.deepEqual(a, b);
  assert.equal(a.colors.H, '#000000'); assert.equal(a.colors.C, COLOURS.yellow);
  for (const look of ['a kid', 'a bald baker in black', 'an astronaut', 'a black cat', 'a robot', 'a ghost', 'a tan woman in a tan dress']) {
    const s = forgeSprite({ name: 'x', look });
    assert.notEqual(s.colors.C, '#000000', `${look}: body is not outline black`);
    if (s.kind === 'human' || s.kind === 'astronaut') { assert.notEqual(s.colors.S, s.colors.C, `${look}: face differs from body`); assert.notEqual(s.colors.S, s.colors.A, `${look}: face differs from accent`); }
    for (const v of Object.values(s.colors)) assert.match(v, /^#[0-9a-f]{6}$/);
  }
});

test('two characters nobody described still look different, and names stay unique', () => {
  const cast = forgeCast([{ name: 'sam', look: 'a person' }, { name: 'sam', look: 'a person' }]);
  assert.notEqual(cast[0].name, cast[1].name);
  assert.notEqual(cast[0].colors.C, cast[1].colors.C);
  const bots = forgeCast([{ name: 'a', look: 'a robot' }, { name: 'b', look: 'a robot' }]);
  assert.notEqual(bots[0].colors.C, bots[1].colors.C);
});

test('the 2-bit look puts each part on its own shade', () => {
  for (const look of ['a kid in a red shirt', 'a small orange cat', 'a silver robot', 'a ghost']) {
    const s = forgeSprite({ name: 'x', look }, { style: '2bit' });
    const shades = new Set(Object.values(s.colors));
    assert.ok(shades.size <= 4, look);
    assert.ok([...shades].every(v => ['#202020', '#606060', '#a0a0a0', '#e0e0e0'].includes(v)), look);
    assert.notEqual(s.colors.K, s.kind === 'ghost' ? s.colors.H : s.colors.C, `${look}: body differs from outline`);
  }
});

test('pixels: the mouth opens only when talking, and transparency is kept', () => {
  const s = forgeSprite({ name: 'kid', look: 'a kid' });
  const shut = spritePixels(s), open = spritePixels(s, { talk: true });
  assert.equal(shut.length, 16 * 16 * 4);
  assert.equal(shut[3], 0);                                                 // top-left corner is empty
  let differ = 0; for (let i = 0; i < shut.length; i += 4) if (shut[i] !== open[i] || shut[i + 1] !== open[i + 1] || shut[i + 2] !== open[i + 2]) differ++;
  assert.equal(differ, [...s.rows.join('')].filter(c => c === 'M').length);
});

// ── the script's own cast ────────────────────────────────────────────────────────────────────────────

const PLAN = settleKind(planCreation('a 30 second 8-bit short where a tired baker teaches a stray cat to guard the bread'), 'video');
const SCRIPT = { title: 'Night Shift', cast: [{ name: 'The Baker', look: 'a tired old baker, bald, white apron' }, { name: 'Cat', look: 'a small orange stray cat' }], scenes: [
  { speaker: 'baker', place: 'a warm bakery kitchen before dawn', say: 'Every night the mice take my best loaves, and I am too old to chase them.' },
  { speaker: 'Cat', place: 'a warm bakery kitchen before dawn', say: 'I could watch the shelves for you, if there is a little milk in it.' },
  { speaker: 'the baker', place: 'a warm bakery kitchen before dawn', say: 'Then sit by the oven where it is warm and keep one eye open.' },
  { speaker: 'cat', place: 'a warm bakery kitchen before dawn', say: 'Not one crumb will go missing while I am on the night shift.' },
] };

test('a script brings its own two characters and every speaker resolves to one of them', () => {
  const s = normalizeScript(SCRIPT, PLAN);
  assert.equal(s.ok, true);
  assert.deepEqual(s.cast.map(c => c.name), ['baker', 'cat']);
  assert.deepEqual(s.scenes.map(x => x.speaker), ['baker', 'cat', 'baker', 'cat']);
  assert.match(buildStudioMarkdown(PLAN, s), /\ncast: baker, cat\n/);
  assert.equal(speakerLines(s).get(normalizeLine(SCRIPT.scenes[1].say)), 'cat');
  const sprites = forgeCast(s.cast);
  assert.deepEqual(sprites.map(x => x.template), ['human-bald+apron', 'cat']);
});

test('a script without a usable cast falls back to the built-in pair and says so', () => {
  const none = normalizeScript({ ...SCRIPT, cast: undefined, scenes: SCRIPT.scenes.map((x, i) => ({ ...x, speaker: i % 2 ? 'robot' : 'hero' })) }, PLAN);
  assert.deepEqual(none.cast, DEFAULT_CAST.map(c => ({ ...c })));
  assert.deepEqual(none.fixes, []);
  const one = normalizeScript({ ...SCRIPT, cast: [{ name: 'baker', look: 'a baker' }] }, PLAN, { final: true });
  assert.deepEqual(one.cast.map(c => c.name), ['hero', 'robot']);
  assert.ok(one.fixes.some(f => /built-in kid and robot/.test(f)));
  const three = normalizeScript({ ...SCRIPT, cast: [...SCRIPT.cast, { name: 'mouse', look: 'a mouse' }] }, PLAN);
  assert.equal(three.cast.length, 2);
  assert.ok(three.fixes.some(f => /more than two characters/.test(f)));
});

test('endings and silent characters are refused with a reason, accepted only as a last resort', () => {
  const question = { ...SCRIPT, scenes: [...SCRIPT.scenes.slice(0, 3), { speaker: 'cat', say: 'But what if the mice are bigger than me, and what then?' }] };
  assert.match(normalizeScript(question, PLAN).reason, /last line is a question/);
  const forced = normalizeScript(question, PLAN, { final: true });
  assert.equal(forced.ok, true); assert.ok(forced.fixes.some(f => /last line is a question/.test(f)));
  const mono = { ...SCRIPT, scenes: SCRIPT.scenes.map(x => ({ ...x, speaker: 'baker' })) };
  assert.match(normalizeScript(mono, PLAN).reason, /Only one character speaks; both baker and cat/);
});

// From the first film made after fraymus-home's reboot (2026-11-11): "a lighthouse keeper and her dog".
test('a keeper is not bearded unless the description says so, and a woman never is by default', () => {
  assert.equal(readLook('tall lighthouse keeper with red hair and a green coat', 'lila').template, 'human-short');
  assert.equal(readLook('the lighthouse keeper, bearded, navy coat', 'keeper').template, 'human-beard');
  assert.equal(readLook('an old woman, keeper of the light', 'ines').template, 'human-long');
  assert.equal(readLook('a grandmother with a white beard', 'oma').template, 'human-beard');      // said outright wins
});

test('the request can say who is a woman when the script forgot to', () => {
  const cast = [{ name: 'lila', look: 'tall lighthouse keeper with red hair and a green coat' }, { name: 'barny', look: 'large black dog with a glowing green collar' }];
  const [keeper] = forgeCast(cast, { request: 'a 25 second 8-bit short about a lighthouse keeper and her dog' });
  assert.equal(keeper.template, 'human-long');
  assert.ok(keeper.why.some(w => /request/.test(w)));
  assert.equal(forgeCast(cast, { request: 'a keeper and his dog' })[0].template, 'human-short');
  // two people: the request cannot tell which one, so nobody is changed
  const two = [{ name: 'a', look: 'a keeper in a coat' }, { name: 'b', look: 'a sailor in blue' }];
  assert.equal(forgeCast(two, { request: 'a keeper and her friend' })[0].template, 'human-short');
});

test('a black dog is black, and a collar is a collar, not its ears', () => {
  const dog = forgeSprite({ name: 'barny', look: 'large black dog with a glowing green collar' });
  assert.equal(dog.colors.H, COLOURS.black);
  assert.notEqual(dog.colors.A, COLOURS.green);                             // ears keep an ear colour
  assert.ok(dog.rows.join('').includes('S'), 'a collar is drawn');
  assert.equal(dog.colors.S, COLOURS.green);
  assert.notEqual(dog.colors.C, COLOURS.black);                             // the chest still reads against the fur
  const plain = forgeSprite({ name: 'rex', look: 'a brown dog' });
  assert.ok(!plain.rows.join('').includes('S'), 'no collar unless one is described');
  const cat = forgeSprite({ name: 'tom', look: 'a black cat with a red collar' });
  assert.equal(cat.colors.H, COLOURS.black); assert.equal(cat.colors.S, COLOURS.red);
});
