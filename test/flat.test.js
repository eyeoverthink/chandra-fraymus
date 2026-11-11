import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAST, LEAD, FEELINGS, ACTS, CAMERAS, SETTINGS, SETTING_NAMES, FORMATS, LAYOUT, figureSvg, cameraAt } from '../server/media/flat/kit.js';
import { PROPS, PROP_NAMES, findProp, lineNamesProp } from '../server/media/flat/props.js';
import { shotSvg, layoutOf, captionSvg } from '../server/media/flat/scene.js';
import { RULES, SFX_NAMES, FLAT_PACE, flatBudget, flatSeconds, flatMessages, normalizeFlat, labelIsSaid, propsFromLine, direct, titleFitsSubject } from '../server/media/flat/plan.js';
import { RATE, synthSfx, readWav, writeWav, trimSilence, buildSoundtrack, longestSilence, captionTimeline } from '../server/media/flat/audio.js';
import { buildTimeline, renderFlatFilm, checkFilm } from '../server/media/flat/render.js';
import { parseRequest, planCreation, settleKind, describePlan, WIRED_STYLES } from '../server/media/make-plan.js';
import { scriptMessagesFor, normalizeFor, paintsBackdrops } from '../server/media/make-looks.js';

const wellFormed = svg => {
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert.ok(!/NaN|undefined|Infinity/.test(svg), 'no broken numbers in the drawing');
  const open = (svg.match(/<g[ >]/g) || []).length, close = (svg.match(/<\/g>/g) || []).length;
  assert.equal(open, close, 'groups balance');
  for (const m of svg.matchAll(/<[a-zA-Z]+\s[^>]*>/g)) { const names = [...m[0].matchAll(/\s([a-zA-Z:-]+)="/g)].map(x => x[1]); assert.equal(new Set(names).size, names.length, `no attribute twice in ${m[0].slice(0, 60)}`); }
};

test('the kit: every setting, prop, character, feeling and act draws a well-formed picture at any time', () => {
  assert.equal(Object.keys(CAST).length, 6); assert.ok(CAST[LEAD]);
  for (const setting of SETTING_NAMES) for (const t of [0, 0.7, 3.3, 9.1]) wellFormed(shotSvg({ setting, props: [], cast: [{ who: LEAD, feel: 'happy' }], camera: 'push' }, t, { format: '16:9' }));
  for (const p of PROP_NAMES) { assert.ok(['sky', 'ground', 'float'].includes(PROPS[p].where), p); assert.ok(PROPS[p].words.length, `${p} has words`); for (const t of [0, 1.9]) wellFormed(shotSvg({ setting: 'field', props: [p], cast: [] }, t, { format: '9:16' })); }
  for (const who of Object.keys(CAST)) for (const feel of FEELINGS) for (const act of ACTS) wellFormed(`<svg>${figureSvg(who, { x: 500, y: 700, feel, act, t: 1.234 })}</svg>`);
  for (const c of CAMERAS) { const a = cameraAt(c, 0), z = cameraAt(c, 1); assert.ok(a.z >= 1 && z.z >= 1, `${c} never shows beyond the painted edge`); }
  assert.ok(SETTING_NAMES.every(s => SETTINGS[s].glow.length === 4), 'every setting has a light you can see');
});

test('a frame is a pure function of the shot and the time', () => {
  const shot = { setting: 'city', props: ['tower', 'coin'], cast: [{ who: 'baron', feel: 'smug', at: 'left' }, { who: 'nilo', feel: 'curious', at: 'right', act: 'wave' }], camera: 'pan-right', label: 'SOLD' };
  assert.equal(shotSvg(shot, 1.5, { format: '9:16' }), shotSvg(shot, 1.5, { format: '9:16' }));
  assert.notEqual(shotSvg(shot, 1.5, { format: '9:16' }), shotSvg(shot, 1.6, { format: '9:16' }));
  assert.match(shotSvg(shot, 1.5, { format: '16:9' }), /width="1920" height="1080"/);
  assert.match(shotSvg(shot, 1.5, { format: '9:16' }), /width="1080" height="1920"/);
  assert.match(shotSvg(shot, 1.5, { format: '1:1', caption: { words: ['He', 'sold', 'it'], hot: 1 } }), /<tspan fill="#ffe066">sold<\/tspan>/);
  assert.match(shotSvg({ ...shot, label: 'a < b & "c"' }, 2, {}), /a &lt; b &amp; &quot;c&quot;/);       // text is escaped
  assert.equal(captionSvg([], 0, { w: 100, y: 10, size: 20 }), '');
});

test('layout: three characters never share a place, props take the free places, and faces clear the captions in every shape', () => {
  for (const format of Object.keys(FORMATS)) {
    const L = layoutOf({ setting: 'field', props: ['sun', 'tree', 'coin'], cast: [{ who: 'nilo', at: 'center' }, { who: 'bru', at: 'center' }, { who: 'baron', at: 'center' }] }, format);
    assert.equal(new Set(L.cast.map(c => c.at)).size, 3, format);
    const one = layoutOf({ setting: 'field', props: ['tree', 'house'], cast: [{ who: 'nilo', at: 'center' }] }, format);
    assert.ok(one.props.every(p => Math.abs(p.x - one.cast[0].x) > one.w * 0.2), `${format}: props stand beside the character, not on it`);
    const capTop = L.h * LAYOUT[format].caption - L.h * 0.075;
    for (const who of Object.keys(CAST)) assert.ok(layoutOf({ cast: [{ who }] }, format).cast[0].faceBottom < capTop, `${format}: ${who}'s face is above the caption`);
  }
  assert.equal(layoutOf({ props: ['nonsense', 'sun'], cast: [] }).props.length, 1);                      // unknown props are not drawn
});

test('the router: the flat look is named by its style words, is always a film, and keeps the asked shape', () => {
  assert.ok(WIRED_STYLES.includes('flat'));
  for (const s of ['a kurzgesagt style video about black holes', 'a 45 second flat vector animation about the immune system', 'make a vertical cartoon story short about the emu war', 'a motion graphics short on inflation', 'an explainer in a nutshell style about tides'])
    assert.equal(parseRequest(s).style, 'flat', s);
  assert.equal(parseRequest('an 8-bit story short about a knight').style, '8bit');                         // a pixel look named outright still wins
  assert.equal(parseRequest('a cartoon about two friends').style, 'cartoon');
  assert.equal(parseRequest('explain how tides work').style, 'explainer');
  const v = settleKind(planCreation('a vertical flat vector story short about the emu war'), 'video', 'test');
  assert.equal(v.kind, 'video'); assert.equal(v.format, '9:16'); assert.equal(v.notes.length, 0);
  assert.equal(settleKind(planCreation('a square flat animation about bees'), 'video', 't').format, '1:1');
  assert.equal(settleKind(planCreation('a vertical 8-bit short about bees'), 'video', 't').format, '16:9'); // the studio's looks are still 16:9 only
  assert.match(describePlan(v), /one voice/); assert.match(describePlan(v), /flat kit/);
  assert.equal(planCreation('a flat vector still of a rocket', { kind: 'still' }).blocked?.reason, 'still_not_wired');
  assert.equal(paintsBackdrops(v), false);
});

const PLAN = settleKind(planCreation('a 40 second vertical flat vector story short about the great emu war'), 'video', 'test');
const line = (say, extra = {}) => ({ say, setting: 'desert', props: [], cast: [{ who: 'nilo', feel: 'curious', at: 'left', act: 'idle' }], camera: 'push', label: '', sfx: 'none', ...extra });
const GOOD = { title: 'The Emu War', shots: [
  line('It is 1932 in Western Australia and you are a soldier.', { props: ['flag'], label: '1932' }),
  line('Your enemy is around twenty thousand emus eating the wheat.', { props: ['bird', 'wheat'], setting: 'field' }),
  line('You have two machine guns and ten thousand bullets.', { props: ['cannon', 'crate'] }),
  line('It sounds easy, but the birds scatter the moment you fire.', { props: ['bird'], cast: [{ who: 'nilo', feel: 'surprised', at: 'left', act: 'shake' }] }),
  line('You mount a gun on a truck, and the ride is too bumpy to aim.', { props: ['car', 'cannon'] }),
  line('After five weeks your commander claims hundreds of kills.', { props: ['crown', 'clock'], cast: [{ who: 'baron', feel: 'smug', at: 'right', act: 'idle' }] }),
  line('It took about ten bullets for every single bird.', { props: ['crate', 'chart'], setting: 'room' }),
  line('He says emus face machine guns like tanks.', { props: ['bird'], cast: [{ who: 'baron', feel: 'tired', at: 'center', act: 'droop' }] }),
  line('The army is called home in the end.', { props: ['house'], setting: 'sunset' }),
  line('And the emus simply win the war.', { props: ['bird', 'trophy'], cast: [{ who: 'nilo', feel: 'sad', at: 'left', act: 'droop' }] }),
] };

test('a good shot list passes every hard rule and is measured', () => {
  const s = normalizeFor(GOOD, PLAN);
  assert.equal(s.ok, true, s.reason);
  assert.equal(s.shots.length, 10); assert.equal(s.rules.length, RULES.length);
  assert.ok(s.rules.filter(r => r.hard).every(r => r.ok), JSON.stringify(s.rules.filter(r => !r.ok)));
  assert.ok(Math.abs(s.estSeconds - 40) < 8, `${s.estSeconds}`);
  assert.equal(s.shots[0].label, '1932'); assert.equal(s.shots[2].sfx, 'boom');                          // a cannon on screen is heard
  assert.deepEqual(s.cast.sort(), ['baron', 'bru', 'nilo']);                                              // bru was cast as the soldier the first line names
  assert.match(scriptMessagesFor(PLAN)[0].content, /kurzgesagt|flat-vector/i);
  assert.match(scriptMessagesFor(PLAN, 'x')[1].content, /refused: x/);
  for (const name of [...SETTING_NAMES, ...PROP_NAMES, ...Object.keys(CAST), ...FEELINGS]) assert.ok(flatMessages(PLAN)[0].content.includes(name), `the writer is told about ${name}`);
});

test('each hard rule sends a plan back with a reason the writer can act on', () => {
  const vary = fn => { const g = JSON.parse(JSON.stringify(GOOD)); fn(g.shots); return normalizeFlat(g, PLAN); };
  assert.match(vary(s => { s[0].say = 'It is the year nineteen thirty two in the far west of Australia and you are a young soldier.'; }).reason, /Rule 1/);
  assert.match(vary(s => { s[9].say = 'And who do you think wins the war?'; }).reason, /Rule 2/);
  assert.match(vary(s => { s.splice(3); }).reason, /Rule 4|Rule 12/);
  assert.match(vary(s => { s[4].cast = []; s[4].props = []; s[4].say = 'Then things simply go on as they did before.'; }).reason, /Rule 5.*Shot 5 shows nothing/);
  assert.match(vary(s => { for (const x of s) x.cast = [{ who: 'bru', feel: 'happy' }]; }).reason, /Rule 7/);
  // one prop in every shot is not sent back: the art director thins it and shows what the lines say instead
  const thin = vary(s => { for (const x of s) { x.props = ['question']; x.label = ''; } });
  assert.equal(thin.ok, true, thin.reason); assert.ok(thin.fixes.some(f => /"question" was in too many shots/.test(f)));
  assert.ok(thin.shots.filter(x => x.props.includes('question')).length <= 5);
  assert.match(vary(s => { for (const x of s) { x.props = []; x.say = 'Something odd went on there for a while again.'; } s[9].say = 'And then it was simply over for good.'; }).reason, /Rule 8/);
  assert.match(vary(s => { for (const x of s) x.say = 'Too short.'; }).reason, /Rule 3|Rule 12/);
  assert.equal(normalizeFlat('not json', PLAN).ok, false);
  // the last attempt is repaired where it can be, and says what it did
  const forced = normalizeFlat({ shots: GOOD.shots.map(x => ({ ...x, cast: [{ who: 'bru', feel: 'happy' }] })) }, PLAN, { final: true });
  assert.equal(forced.ok, true); assert.ok(forced.fixes.some(f => /nilo added/.test(f)));
  assert.ok(forced.shots.filter(x => x.cast.some(c => c.who === LEAD)).length >= 5);
});

test('what the writer gets wrong is mapped, dropped or filled in — and every change is recorded', () => {
  const s = normalizeFlat({ title: 'X', shots: GOOD.shots.map((x, i) => i === 1 ? { say: x.say, setting: 'a sunny farm', props: ['kangaroo', 'emus'], cast: [{ who: 'someone', feel: 'ecstatic', act: 'moonwalk' }], camera: 'spin', label: '50,000', sfx: 'kaboom' } : i === 2 ? { say: x.say, cast: ['nilo'] } : x) }, PLAN);
  assert.equal(s.ok, true, s.reason);
  const b = s.shots[1];
  assert.equal(b.setting, 'field'); assert.deepEqual(b.props, ['emu']); assert.equal(b.label, '');     // a number the line does not say is not shown
  assert.deepEqual(b.cast[0], { who: 'nilo', feel: 'neutral', at: null, act: 'idle' });
  assert.ok(CAMERAS.includes(b.camera));
  assert.deepEqual(s.shots[2].props, propsFromLine(GOOD.shots[2].say));                                    // no props given: taken from the words
  assert.ok(s.shots[2].props.includes('cannon'));
  for (const re of [/"a sunny farm" read as field/, /not in the kit, left out: kangaroo/, /label "50,000" is not something the line says/, /props chosen from the words/]) assert.ok(s.fixes.some(f => re.test(f)), String(re));
});

test('helpers: labels, prop words, budgets', () => {
  assert.equal(labelIsSaid('20,000', 'Around 20,000 emus.'), true);
  assert.equal(labelIsSaid('986', 'He claims 986 kills.'), true);
  assert.equal(labelIsSaid('986', 'He claims many kills.'), false);
  assert.equal(labelIsSaid('SOLD', 'He sold the tower twice.'), true);
  assert.equal(labelIsSaid('SOLD OUT', 'He sold the tower twice.'), false);
  assert.equal(findProp('Rockets'), 'rocket'); assert.equal(findProp('emu'), 'emu'); assert.equal(findProp('bullet'), 'crate'); assert.equal(findProp('unicorn'), null);
  assert.equal(lineNamesProp('You have two machine guns.', 'cannon'), true);
  assert.equal(lineNamesProp('The gunner slept.', 'cannon'), false);                                      // whole words only
  const b40 = flatBudget(40), b90 = flatBudget(90);
  assert.ok(b40.shots >= 11 && b40.shots <= 15, `${b40.shots} shots for 40 s`); assert.ok(b90.shots > b40.shots && b90.words > b40.words);
  assert.ok(Math.abs(flatSeconds(Array.from({ length: b40.shots }, () => ({ say: Array(Math.round(b40.words / b40.shots)).fill('about').join(' ') }))) - 40) < 4);
});

test('sound: every effect is audible and bounded, WAV round-trips, silence is trimmed, lines are laid out exactly', () => {
  for (const name of SFX_NAMES.slice(1)) { const s = synthSfx(name, 3); assert.ok(s.length > RATE * 0.1, name); let peak = 0; for (const v of s) peak = Math.max(peak, Math.abs(v)); assert.ok(peak > 0.2 && peak < 4 && Number.isFinite(peak), `${name} peak ${peak}`); assert.deepEqual(synthSfx(name, 3), s); }
  assert.equal(synthSfx('none').length, 0);
  const tone = (secs, pad = 0) => { const n = Math.round(secs * RATE), p = Math.round(pad * RATE), out = new Float32Array(n + 2 * p); for (let i = 0; i < n; i++) out[p + i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / RATE); return out; };
  const back = readWav(writeWav(tone(0.5)));
  assert.equal(back.rate, RATE); assert.equal(back.samples.length, Math.round(0.5 * RATE)); assert.ok(Math.abs(back.samples[30] - tone(0.5)[30]) < 1e-3);
  assert.throws(() => readWav(Buffer.from('not a wav file at all, just some text that is long enough')), /not a WAV/);
  const trimmed = trimSilence(tone(1.0, 0.6));
  assert.ok(Math.abs(trimmed.length / RATE - 1.06) < 0.05, `${trimmed.length / RATE}`);                    // 0.6 s of quiet on each side is gone, a breath is kept
  const tr = buildSoundtrack([{ samples: tone(1) }, { samples: tone(2) }, { samples: tone(0.5) }], [null, { samples: synthSfx('pop') }, null], { gap: 0.2, lead: 0.25, tail: 0.45 });
  assert.deepEqual(tr.starts.map(x => +x.toFixed(2)), [0.25, 1.45, 3.65]); assert.deepEqual(tr.ends.map(x => +x.toFixed(2)), [1.25, 3.45, 4.15]);
  assert.ok(Math.abs(tr.seconds - 4.6) < 0.01); assert.ok(Math.abs(tr.longestGap - 0.25) < 0.01);
  let peak = 0; for (const v of tr.mix) peak = Math.max(peak, Math.abs(v)); assert.ok(peak <= 1 && peak > 0.8);
  assert.ok(longestSilence(tr.mix) <= 0.5);
  assert.ok(longestSilence(buildSoundtrack([{ samples: tone(1) }, { samples: tone(1) }], [], { gap: 2.5 }).mix) > 2);   // a hole is found
});

test('captions and cuts: every word is shown once, in order, and each picture arrives just before its line', () => {
  const g = captionTimeline('Around twenty thousand emus eating the wheat.', 2, 5);
  assert.equal(g.map(x => x.words.join(' ')).join(' '), 'Around twenty thousand emus eating the wheat.');
  assert.ok(g.every(x => x.words.length <= 3 && x.words.join(' ').length <= 20));
  assert.equal(g[0].at, 2); assert.ok(Math.abs(g[g.length - 1].until - 5) < 1e-9);
  assert.ok(g.every((x, i) => i === 0 || x.at >= g[i - 1].at)); assert.ok(g.every(x => x.times.length === x.words.length));
  const tl = buildTimeline([{ say: 'One two three.' }, { say: 'Four five.' }, { say: 'Six.' }], { starts: [0.25, 1.45, 3.65], ends: [1.25, 3.45, 4.15], seconds: 4.6 });
  assert.deepEqual(tl.cuts.map(x => +x.toFixed(2)), [0, 1.35, 3.55]);
  assert.ok(tl.spans.every((s, i) => i === 0 || (s.lineStart - s.from >= 0 && s.lineStart - s.from <= 0.25)));
  assert.equal(tl.spans[2].to, 4.6);
});

test('a real film: three shots are rendered, encoded with sound, and pass their measurements; a broken one is caught', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flat-test-'));
  try {
    const voice = (secs, hz) => { const n = Math.round(secs * RATE), out = new Float32Array(n + RATE); for (let i = 0; i < n; i++) out[RATE / 2 + i] = 0.4 * Math.sin(2 * Math.PI * hz * i / RATE) * (0.6 + 0.4 * Math.sin(i / 900)); return out; };
    const shots = normalizeFlat({ shots: [
      { say: 'A rocket leaves the earth at dawn.', setting: 'space', props: ['rocket', 'earth'], cast: [{ who: 'nilo', feel: 'surprised', at: 'left', act: 'hop' }], camera: 'rise', sfx: 'whoosh' },
      { say: 'It costs a fortune in gold.', setting: 'room', props: ['coin'], cast: [{ who: 'baron', feel: 'smug', at: 'right', act: 'idle' }, { who: 'nilo', feel: 'sad', at: 'left', act: 'droop' }], camera: 'push', label: 'GOLD' },
      { say: 'And nobody knows why it worked.', setting: 'night', props: ['question'], cast: [{ who: 'nilo', feel: 'curious', at: 'center', act: 'wave' }], camera: 'pan-left' },
    ] }, { seconds: 8 }, { final: true }).shots;
    const wavs = shots.map((_, i) => { const p = join(dir, `l${i}.wav`); writeFileSync(p, writeWav(voice(1.1 + i * 0.2, 180 + i * 40))); return p; });
    const out = join(dir, 'film.mp4');
    const render = await renderFlatFilm({ shots, lineWavs: wavs, format: '1:1', outPath: out, workDir: dir, fps: 12 });
    assert.ok(existsSync(out)); assert.equal(render.width, 1080); assert.equal(render.frames, Math.ceil(render.seconds * 12));
    assert.ok(render.seconds > 3.5 && render.seconds < 6, `${render.seconds}`);                             // the half second of quiet around each line was trimmed
    const verdict = await checkFilm({ shots, format: '1:1', render });
    assert.equal(verdict.passed, true, JSON.stringify(verdict.checks.filter(c => !c.ok)));
    assert.ok(verdict.checks.length >= 10);
    // the same film with a hole in the sound and a blank shot does not pass
    const bad = await checkFilm({ shots, format: '1:1', render: { ...render, audio: { ...render.audio, longestSilence: 2.4 }, signatures: render.signatures.map((s, i) => i === 1 ? { ...s, mid: new Float32Array(144).fill(40) } : s) } });
    assert.equal(bad.passed, false);
    assert.ok(bad.checks.some(c => !c.ok && /silence/.test(c.name))); assert.ok(bad.checks.some(c => !c.ok && /blank/.test(c.name)));
    await assert.rejects(() => renderFlatFilm({ shots, lineWavs: wavs.slice(0, 2), format: '1:1', outPath: out, workDir: dir }), /2 recorded lines for 3 shots/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The first real films (2026-11-11): the writer put one place, one character and the same prop in fifteen shots in a row.
test('the art director stages what the writer only named, and says what it did', () => {
  const mk = say => ({ say, setting: 'field', props: ['emu'], cast: [{ who: 'nilo', feel: 'curious', at: null, act: 'idle' }], camera: null, label: '', sfx: null });
  const shots = ['In 1932 the emus came for the wheat.', 'The farmers begged the government for help.', 'Soldiers arrived with two machine guns.', 'The birds scattered into the bush.', 'A truck could not keep up with them.',
    'After weeks the commander counted 986 kills.', 'It took ten bullets for every bird.', 'The army went home.', 'And the emus stayed.'].map(mk);
  const fixes = []; direct(shots, fixes);
  assert.ok(shots.filter(s => s.props.includes('emu')).length <= 5, 'no prop in more than half of the shots');
  assert.ok(shots.every(s => s.props.length || s.cast.length), 'nothing is left empty');
  assert.ok(shots[2].props.includes('cannon'), 'machine guns are shown when the line says so');
  assert.ok(new Set(shots.map(s => s.setting)).size >= 2, 'the film has more than one place');
  assert.equal(shots[8].setting, 'sunset');
  assert.ok(shots[2].cast.some(c => c.who === 'bru')); assert.ok(shots[5].cast.some(c => c.who === 'baron'));          // soldiers, the commander
  assert.equal(shots[0].label, '1932'); assert.equal(shots[5].label, '986');                                         // numbers the narrator says are shown
  assert.equal(shots[0].cast[0].act, 'enter-left');
  assert.ok(shots.every(s => s.camera)); for (let i = 2; i < shots.length; i++) assert.ok(!(shots[i].camera === shots[i - 1].camera && shots[i].camera === shots[i - 2].camera));
  assert.equal(shots[2].sfx, 'boom');
  for (const re of [/"emu" was in too many shots/, /bru plays a part/, /move from field to sunset/]) assert.ok(fixes.some(f => re.test(f)), String(re));
  // it is deterministic, and it leaves a varied plan alone
  const again = ['In 1932 the emus came for the wheat.', 'The farmers begged the government for help.'].map(mk); const a = JSON.stringify(direct(again.map(x => JSON.parse(JSON.stringify(x))))); assert.equal(a, JSON.stringify(direct(again)));
  // the compact shape the writer is asked for is read
  const s = normalizeFlat({ title: 'T', shots: [{ say: 'A rocket leaves the earth at dawn.', where: 'space', show: ['rocket', 'earth'], who: ['nilo', 'prof'], feel: 'surprised' }, { say: 'It costs a fortune in gold.', where: 'room', show: 'coin', who: 'baron', feel: 'smug' }] }, { seconds: 8 }, { final: true });
  assert.equal(s.shots[0].setting, 'space'); assert.deepEqual(s.shots[0].props, ['rocket', 'earth']); assert.deepEqual(s.shots[0].cast.map(c => [c.who, c.feel]), [['nilo', 'surprised'], ['prof', 'surprised']]);
  assert.deepEqual(s.shots[1].cast.map(c => c.who), ['baron']); assert.deepEqual(s.shots[1].props, ['coin']);
  assert.ok(!/"camera"|"sfx"|"label"/.test(flatMessages({ request: 'x', seconds: 40 })[0].content.split('Rules:')[0]), 'the writer is not asked for staging');
});

test('a padded ending is sent back, and facts from a source are put in front of the writer', () => {
  const g = JSON.parse(JSON.stringify(GOOD)); g.shots[8].say = 'Stay healthy and stay strong today.'; g.shots[9].say = 'Stay healthy and stay safe today.';
  const r = normalizeFlat(g, PLAN);
  assert.equal(r.ok, false); assert.match(r.reason, /Rule 17.*shots 9 and 10 say nearly the same thing/);
  const kept = normalizeFlat(g, PLAN, { final: true });
  assert.equal(kept.ok, true); assert.equal(kept.shots.length, 9); assert.ok(kept.fixes.some(f => /repeated an earlier line were removed/.test(f)));
  const withFacts = flatMessages({ ...PLAN, facts: { text: 'The Emu War was a military operation in Western Australia in late 1932.', source: 'Wikipedia, "Emu War"' } })[1].content;
  assert.match(withFacts, /FACTS from Wikipedia, "Emu War"/); assert.match(withFacts, /military operation in Western Australia/);
  assert.ok(!/FACTS/.test(flatMessages(PLAN)[1].content));
  // a crowded shot is drawn smaller than a single figure, so three things fit side by side in a vertical frame
  const solo = layoutOf({ cast: [{ who: 'nilo' }] }, '9:16').cast[0].scale, crowd = layoutOf({ props: ['emu'], cast: [{ who: 'nilo' }, { who: 'baron' }] }, '9:16').cast[0].scale;
  assert.ok(crowd < solo * 0.9, `${crowd} vs ${solo}`);
});

test('a source is used only when its title is about the subject', () => {
  assert.equal(titleFitsSubject('Emu War', 'great emu war 1932 in Australia'), true);
  assert.equal(titleFitsSubject('Immune system', 'immune system fights virus'), true);
  assert.equal(titleFitsSubject('HIV/AIDS', 'immune system fights virus'), false);          // the top search hit that derailed a film
  assert.equal(titleFitsSubject('Pig War (1859)', 'the pig war'), true);
  assert.equal(titleFitsSubject('Tide', 'tides work'), true);
  assert.equal(titleFitsSubject('', 'anything'), false);
  assert.equal(titleFitsSubject('Adaptive immune system', 'immune system fights virus'), true);
  assert.equal(titleFitsSubject('Emu', 'the war'), false); assert.equal(titleFitsSubject('World War II', 'the pig war'), false);
  // a slogan repeated with new endings is caught as padding
  const g = JSON.parse(JSON.stringify(GOOD)); g.shots[5].say = 'Your enemy is always watching the wheat.'; g.shots[6].say = 'Your enemy is never far from home.';
  assert.match(normalizeFlat(g, PLAN).reason, /Rule 17.*lines begin "your enemy is"/);
});
