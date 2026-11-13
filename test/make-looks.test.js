import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, planCreation, settleKind, describePlan, backdropPrompt, backdropNegative, RECIPES, WIRED_STYLES, isVector } from '../server/media/make-plan.js';
import { scriptMessagesFor, normalizeFor, buildMarkdownFor, paintsBackdrops, forgePeople, explainerBudget, DEFAULT_PEOPLE } from '../server/media/make-looks.js';

const plan = (text, o) => { const p = planCreation(text, o); return p.kind && !p.blocked ? settleKind(p, p.kind) : p; };

test('the sentence picks the look, and a pixel look named outright wins', () => {
  assert.equal(parseRequest('a cartoon about two friends who share an umbrella').style, 'cartoon');
  assert.equal(parseRequest('make a comic about a lighthouse keeper').style, 'comic');
  assert.equal(parseRequest('a 45 second explainer video about how tides work').style, 'explainer');
  assert.equal(parseRequest('a video that explains why the sky is blue').style, 'explainer');
  assert.equal(parseRequest('an 8-bit cartoon about a cat').style, '8bit');
  assert.equal(parseRequest('a 2-bit comic about a robot').style, '2bit');
  assert.deepEqual(Object.keys(RECIPES).sort(), WIRED_STYLES.filter(s => !isVector(s)).sort());   // flat and stick are drawn here, not by a studio recipe
  assert.equal(RECIPES.comic, 'comic-strip');
});

test('a cartoon or an explainer is a film; a comic is pages plus a film unless only pages are asked for', () => {
  assert.equal(plan('a cartoon about two friends').kind, 'video');
  assert.equal(plan('explain how tides work').kind, 'video');
  assert.equal(plan('a comic about a lighthouse keeper').kind, 'video');
  assert.equal(plan('a comic about a lighthouse keeper, pages only').kind, 'still');
  assert.equal(plan('a comic poster about a lighthouse keeper').kind, 'still');
  assert.match(describePlan(plan('a comic about a lighthouse keeper')), /comic pages and a film of them/);
  assert.match(describePlan(plan('a comic about a keeper, just the pages')), /comic pages \(/);
  const still = plan('a cartoon still of two friends');
  assert.equal(still.blocked.reason, 'still_not_wired');
  assert.match(describePlan(still), /is a film here/);
  assert.equal(plan('two friends share an umbrella', { style: 'cartoon' }).kind, 'video');       // an explicit look implies the kind too
  assert.equal(plan('a lighthouse keeper', { style: 'comic-strip' }).style, 'comic');
  assert.equal(plan('a cartoon about friends').palette, null);                                    // palettes belong to the pixel looks
  assert.match(describePlan(plan('explain how tides work')), /one voice, painted pictures behind the words/);
  assert.match(describePlan(plan('a cartoon about friends')), /two voices, built-in sets/);
});

test('each look paints its own kind of picture, or none', () => {
  assert.equal(paintsBackdrops(plan('a cartoon about friends')), false);
  assert.equal(paintsBackdrops(plan('a comic about friends')), true);
  assert.equal(paintsBackdrops(plan('explain tides, no backdrops')), false);
  assert.match(backdropPrompt(plan('explain tides'), 'a rocky shore at low tide'), /^a rocky shore at low tide, cinematic wide photograph/);
  assert.match(backdropPrompt(plan('a comic about tides'), 'a rocky shore'), /comic book illustration/);
  assert.match(backdropPrompt(plan('an 8-bit short about tides'), 'a rocky shore'), /pixel art background/);
  assert.ok(!/people/.test(backdropNegative(plan('explain tides'))));                              // a photograph behind an explainer may show people
  assert.match(backdropNegative(plan('an 8-bit short')), /people/);
});

// ── cartoon ──────────────────────────────────────────────────────────────────────────────────────────

const CARTOON = plan('a 30 second cartoon about two friends who share an umbrella in the rain');
const CARTOON_SCRIPT = { title: 'One Umbrella', cast: [{ name: 'Mia', look: 'a girl with red hair in a yellow raincoat' }, { name: 'Theo', look: 'a tall boy in a green jacket, dark skin' }], scenes: [
  { speaker: 'mia', mood: 'sad', set: 'day', say: 'It is pouring and I left my umbrella on the bus this morning.' },
  { speaker: 'theo', mood: 'happy', set: 'day', say: 'Then walk under mine. It is big enough for two if we squeeze.' },
  { speaker: 'mia', mood: 'surprised', set: 'sunset', say: 'Look at that, the rain stopped and we did not even notice.' },
  { speaker: 'theo', mood: 'ecstatic', set: 'dusk', say: 'Keep walking anyway. I like the company more than the weather.' },
] };

test('cartoon: prompt, script check and the studio format', () => {
  const sys = scriptMessagesFor(CARTOON)[0].content;
  assert.match(sys, /speech bubbles/); assert.match(sys, /happy, surprised or sad/); assert.match(sys, /both are people/);
  const s = normalizeFor(CARTOON_SCRIPT, CARTOON);
  assert.equal(s.ok, true);
  assert.deepEqual(s.cast.map(c => c.name), ['mia', 'theo']);
  assert.deepEqual(s.scenes.map(x => x.mood), ['sad', 'happy', 'surprised', undefined]);           // an unknown mood is dropped, not passed on
  assert.deepEqual(s.scenes.map(x => x.set), ['day', 'day', 'sunset', undefined]);
  const md = buildMarkdownFor(CARTOON, s);
  assert.match(md, /^---\ntitle: One Umbrella\nrecipe: cartoon\ncast: mia=#f7c948, theo=#5fc97a\nformat: 16:9\n---\n## title\n# ONE UMBRELLA\ndur: 2\.2\nset: day\n/);
  assert.match(md, /## line03\nspeaker: mia\nmood: surprised\nset: sunset\nsay: Look at that/);
  assert.match(md, /## line04\nspeaker: theo\nmood: happy\nset: sunset\n/);                         // the sky stays until the script changes it
  assert.ok(!md.includes('visual:'));
});

test('cartoon people take their colours from the description and never share a shirt', () => {
  const [mia, theo] = forgePeople(normalizeFor(CARTOON_SCRIPT, CARTOON).cast);
  assert.equal(mia.color, '#f7c948'); assert.equal(mia.hair, '#b5432a');
  assert.equal(theo.color, '#5fc97a'); assert.equal(theo.skin, '#7a4a2a');
  assert.ok(mia.why.some(w => /yellow clothes \(said\)/.test(w)) && theo.why.some(w => /dark skin \(said\)/.test(w)));
  const plain = forgePeople([{ name: 'a', look: 'a person' }, { name: 'b', look: 'a person' }]);
  assert.notEqual(plain[0].color, plain[1].color); assert.notEqual(plain[0].skin, plain[1].skin);
  const same = forgePeople([{ name: 'a', look: 'in a red shirt' }, { name: 'b', look: 'in a red shirt' }]);
  assert.notEqual(same[0].color, same[1].color);
});

test('cartoon and comic draw people only: a script with no cast gets two people, not the pixel pair', () => {
  const s = normalizeFor({ title: 'x', scenes: CARTOON_SCRIPT.scenes.map((x, i) => ({ ...x, speaker: i % 2 ? 'robot' : 'hero' })) }, CARTOON);
  assert.deepEqual(s.cast.map(c => c.name), DEFAULT_PEOPLE.map(c => c.name));
  assert.deepEqual(s.scenes.map(x => x.speaker), ['ava', 'max', 'ava', 'max']);
});

// ── comic ────────────────────────────────────────────────────────────────────────────────────────────

const COMIC = plan('a comic about a lighthouse keeper and her nephew on the night the lamp fails');
const COMIC_SCRIPT = { title: 'Dark Water', cast: [{ name: 'Ines', look: 'an old keeper with grey hair and a navy coat' }, { name: 'Pip', look: 'a boy in a red sweater' }], panels: [
  { speaker: '', place: 'a lighthouse on a black cliff in a storm at night', say: 'The night the lamp failed, the sea had never been louder.' },
  { speaker: 'pip', mood: 'surprised', set: 'night', say: 'Aunt Ines, the light just went out and there is a ship out there!', sfx: 'crack!' },
  { speaker: 'ines', mood: 'sad', set: 'night', say: 'The bulb is gone. Fetch every lantern in the house, quickly now.' },
  { speaker: 'Narrator', place: 'a row of small lanterns glowing in a tall window', say: 'They lit forty lanterns and held them to the glass until dawn.' },
  { speaker: 'pip', mood: 'happy', set: 'day', say: 'She turned! The ship saw us and turned away from the rocks.' },
  { speaker: 'ines', mood: 'happy', set: 'day', say: 'Then tonight the two of us were the lighthouse.' },
] };

test('comic: narration panels carry the painted pictures, dialogue panels carry the people', () => {
  const sys = scriptMessagesFor(COMIC)[0].content;
  assert.match(sys, /narration panel/); assert.match(sys, /"panels"/);
  const s = normalizeFor(COMIC_SCRIPT, COMIC);
  assert.equal(s.ok, true);
  assert.deepEqual(s.scenes.map(x => x.speaker), [null, 'pip', 'ines', null, 'pip', 'ines']);
  assert.deepEqual(s.places, ['a lighthouse on a black cliff in a storm at night', 'a row of small lanterns glowing in a tall window']);
  assert.equal(s.scenes[1].sfx, 'CRACK!');
  const md = buildMarkdownFor(COMIC, s, ['C:/m/cliff.png', 'C:/m/lanterns.png']);
  assert.match(md, /^---\ntitle: Dark Water\nrecipe: comic-strip\ncast: ines=#2f4fa8, pip=#e8483f\npanels_per_page: 4\nformat: 16:9\n---\n## p01\nvisual: C:\/m\/cliff\.png\nset: day\nsay: The night the lamp failed/);
  assert.match(md, /## p02\nspeaker: pip\nmood: surprised\nset: night\nsfx: CRACK!\nsay: /);
  assert.match(md, /## p04\nvisual: C:\/m\/lanterns\.png\nset: night\nsay: They lit forty lanterns/);
  assert.equal((md.match(/^visual:/gm) || []).length, 2);                                          // never on a dialogue panel
  assert.ok(!md.includes('## title'));                                                             // the title is drawn on page one by the recipe
});

test('comic: a script with no narration panel is sent back, and accepted only as a last resort', () => {
  const noNarration = { ...COMIC_SCRIPT, panels: COMIC_SCRIPT.panels.filter(p => p.speaker && p.speaker !== 'Narrator') };
  assert.match(normalizeFor(noNarration, COMIC).reason, /no narration panel/);
  assert.equal(normalizeFor(noNarration, COMIC, { final: true }).ok, true);
});

// ── explainer ────────────────────────────────────────────────────────────────────────────────────────

const EXPLAINER = plan('a 40 second explainer video about why the sea has tides');
const EXPLAINER_SCRIPT = { title: 'Why the Sea Breathes', scenes: [
  { headline: 'The sea moves twice', say: 'Twice a day the sea climbs the shore and slides back again, as if the whole ocean were breathing.', picture: 'a wide rocky shore at low tide under a grey sky' },
  { headline: 'The Moon pulls', say: 'The cause is the Moon. Its gravity tugs on the water facing it and raises a gentle bulge.', picture: 'a full moon over a calm dark ocean' },
  { headline: 'Two bulges, not one', say: 'A second bulge forms on the far side of the Earth, and the planet turns beneath them both.', bullets: ['One bulge faces the Moon', '- + One bulge on the far side', 'x @spins The Earth turns under both'], picture: 'a full moon over a calm dark ocean' },
  { headline: 'So the tide returns', say: 'That is why a beach sees high water twice in a day. The sea is simply following the Moon.', picture: 'a wide rocky shore at low tide under a grey sky' },
] };

test('explainer: one narrator, headlines, bullet points, a picture behind each scene', () => {
  const sys = scriptMessagesFor(EXPLAINER)[0].content;
  assert.match(sys, /One narrator/); assert.match(sys, /Do not invent statistics/);
  const s = normalizeFor(EXPLAINER_SCRIPT, EXPLAINER);
  assert.equal(s.ok, true);
  assert.deepEqual(s.cast.map(c => c.name), ['narrator']);
  assert.ok(s.scenes.every(x => x.speaker === null));
  assert.deepEqual(s.places, ['a wide rocky shore at low tide under a grey sky', 'a full moon over a calm dark ocean']);
  assert.deepEqual(s.scenes.map(x => x.place), [0, 1, 1, 0]);
  assert.deepEqual(s.scenes[2].bullets, ['One bulge faces the Moon', 'One bulge on the far side', 'spins The Earth turns under both']);   // list markers and @ stripped
  assert.deepEqual(s.scenes[0].bullets, []);
  const md = buildMarkdownFor(EXPLAINER, s, ['C:/m/shore.png', 'C:/m/moon.png']);
  assert.match(md, /^---\ntitle: Why the Sea Breathes\nrecipe: explainer\ntheme: teal\ncaptions: true\nformat: 16:9\n---\n## title\nkind: title\n# WHY THE SEA \| BREATHES\ndur: 2\.5\nvisual: C:\/m\/shore\.png\n/);
  assert.match(md, /## s01\nkind: statement\n# THE SEA \| MOVES TWICE\nvisual: C:\/m\/shore\.png\nsay: Twice a day/);
  assert.match(md, /## s03\nkind: bullets\n# TWO BULGES, \| NOT ONE\nvisual: C:\/m\/moon\.png\nsay: A second bulge[^\n]+\n- One bulge faces the Moon\n- One bulge on the far side\n- spins The Earth turns under both\n/);
  assert.ok(!/^- [+x] /m.test(md));                                                                // nothing the studio would read as a tick or a cross
});

test('explainer: length and headlines are checked, with a reason the writer can act on', () => {
  const b = explainerBudget(40);
  assert.ok(b.scenes >= 3 && b.words > 50);
  const short = { scenes: [{ headline: 'Tides', say: 'The sea goes up and down.' }, { headline: 'Moon', say: 'The Moon does it.' }] };
  assert.match(normalizeFor(short, EXPLAINER).reason, /too short/);
  assert.equal(normalizeFor(short, EXPLAINER, { final: true }).ok, true);
  const noHead = { scenes: EXPLAINER_SCRIPT.scenes.map(({ headline, ...rest }) => rest) };
  assert.match(normalizeFor(noHead, EXPLAINER).reason, /no "headline"/);
  const forced = normalizeFor(noHead, EXPLAINER, { final: true });
  assert.equal(forced.ok, true); assert.ok(forced.scenes.every(x => x.headline)); assert.ok(forced.fixes.some(f => /headline taken from the narration/.test(f)));
  assert.equal(normalizeFor('not json', EXPLAINER).ok, false);
  assert.equal(normalizeFor(EXPLAINER_SCRIPT, plan('a warm explainer about fire safety')).theme, 'ember');
});
