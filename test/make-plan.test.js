import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, planCreation, settleKind, describePlan, scriptBudget, scriptMessages, normalizeScript, headline, buildStudioMarkdown, speakerLines, normalizeLine, stillPrompt, extractJson, MAX_SECONDS } from '../server/media/make-plan.js';

test('a sentence is read without the user choosing a category', () => {
  const p = parseRequest('Make a 90 second 8-bit short about a robot who finds a lighthouse');
  assert.equal(p.kind, 'video'); assert.equal(p.style, '8bit'); assert.equal(p.seconds, 90);
  const q = parseRequest('a 2-bit still of a lighthouse in a storm');
  assert.equal(q.kind, 'still'); assert.equal(q.style, '2bit'); assert.equal(q.seconds, null);
  assert.equal(parseRequest('Game Boy animation, two minutes').seconds, 120);
  assert.equal(parseRequest('Game Boy animation, two minutes').style, '2bit');
  assert.equal(parseRequest('half a minute NES skit').seconds, 30);
  assert.equal(parseRequest('pixel art poster, vertical').format, '9:16');
  assert.equal(parseRequest('square 8bit icon').format, '1:1');
  assert.equal(parseRequest('black and white 2bit movie').palette, 'gb-mono');
});

test('fields the sentence does not mention stay null', () => {
  const p = parseRequest('a lighthouse keeper and a curious robot');
  assert.deepEqual([p.kind, p.style, p.seconds, p.format], [null, null, null, null]);
});

test('the plan records where every value came from', () => {
  const plan = planCreation('a 40 second 8-bit short about a robot');
  assert.equal(plan.decided.style.why, 'from your words');
  assert.equal(plan.decided.seconds.value, 40);
  assert.equal(plan.decided.format.why, 'default shape');
  assert.equal(plan.blocked, null);
  const d = planCreation('a robot and a lighthouse');
  assert.equal(d.kind, null);
  assert.equal(d.style, '8bit'); assert.equal(d.decided.style.why, 'default look');
  assert.match(describePlan(d), /to be decided/);
});

test('explicit options win over the sentence', () => {
  const plan = planCreation('an 8-bit short', { style: '2bit', seconds: 20, kind: 'video' });
  assert.equal(plan.style, '2bit'); assert.equal(plan.seconds, 20); assert.equal(plan.palette, 'gb');
  assert.equal(plan.decided.style.why, 'set explicitly');
});

test('length is clamped and the plan says so', () => {
  const plan = planCreation('a ten minute 8-bit movie');
  assert.equal(plan.seconds, MAX_SECONDS);
  assert.ok(plan.notes.some(n => /Length set to/.test(n)));
});

test('a look that is not wired is refused by name, not converted', () => {
  const plan = planCreation('make an explainer video about consent');
  assert.equal(plan.blocked.reason, 'style_not_wired'); assert.equal(plan.blocked.style, 'explainer');
  assert.match(describePlan(plan), /not wired yet/);
  assert.equal(planCreation('an 8-bit cartoon about a cat').blocked, null);          // a wired look was named
  assert.equal(planCreation('x', { style: 'anime' }).blocked.reason, 'style_not_wired');
});

test('settling the kind fixes what follows from it', () => {
  const v = settleKind(planCreation('vertical pixel art of a robot'), 'video', 'test');
  assert.equal(v.kind, 'video'); assert.equal(v.format, '16:9'); assert.equal(v.seconds, 30);
  assert.ok(v.notes.some(n => /16:9/.test(n)));
  const s = settleKind(planCreation('vertical pixel art of a robot'), 'still', 'test');
  assert.equal(s.kind, 'still'); assert.equal(s.format, '9:16'); assert.equal(s.seconds, null);
  const kept = settleKind(planCreation('8-bit video'), 'still');
  assert.equal(kept.kind, 'video');                                                   // an already-known kind is not overturned
});

test('the script budget grows with length and the prompt carries it', () => {
  const a = scriptBudget(20), b = scriptBudget(90);
  assert.ok(b.words > a.words && b.scenes > a.scenes);
  assert.ok(a.scenes >= 2);
  const msgs = scriptMessages(planCreation('a 40 second 8-bit short about a robot'), 'too long');
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].content, /HERO/); assert.match(msgs[1].content, /refused: too long/);
});

const PLAN = settleKind(planCreation('a 30 second 8-bit short about a robot who finds a lighthouse'), 'video');
const GOOD = { title: 'The Last Light', scenes: [
  { speaker: 'robot', say: 'I found a tower with a lamp on top. It still turns.' },
  { speaker: 'hero', say: 'That is a lighthouse. It guides ships home through the dark.' },
  { speaker: 'robot', say: 'No ships have come in forty years. I counted the logbook.' },
  { speaker: 'hero', say: 'Then tonight it can guide us. Keep the lamp lit, friend.' },
] };

test('a good script passes and is measured', () => {
  const s = normalizeScript(JSON.stringify(GOOD), PLAN);
  assert.equal(s.ok, true); assert.equal(s.scenes.length, 4); assert.equal(s.title, 'The Last Light');
  assert.ok(s.words > 30 && s.estSeconds > 10);
  assert.deepEqual(s.fixes, []);
});

test('model habits are cleaned: stage directions, speaker prefixes, smart quotes, unknown speakers', () => {
  const s = normalizeScript({ title: '“Beacon”: a tale', scenes: [
    { speaker: 'Narrator', say: 'HERO: (looking up) What’s that light — up there?' },
    { speaker: 'the bot', say: '[beeps] It is a lighthouse, *whirr* built long ago.' },
    { speaker: 'robot', say: 'ok' },
    'A bare string line also counts as dialogue here.',
  ] }, PLAN, { final: true });
  assert.equal(s.ok, true);
  assert.equal(s.scenes[0].say, "What's that light - up there?");
  assert.equal(s.scenes[0].speaker, 'hero');
  assert.equal(s.scenes[1].speaker, 'robot');
  assert.equal(s.scenes[1].say, 'It is a lighthouse, built long ago.');
  assert.equal(s.scenes.length, 3);                                                    // the two-letter line is dropped
  assert.ok(!/[^\x20-\x7E]/.test(s.title + s.scenes.map(x => x.say).join('')));
  assert.ok(s.fixes.length >= 2);
});

test('unusable replies are refused with a reason the model can act on', () => {
  assert.equal(normalizeScript('I cannot do that.', PLAN).ok, false);
  assert.match(normalizeScript('{"scenes":[{"speaker":"hero","say":"Only one line here."}]}', PLAN).reason, /Fewer than two/);
  const long = { scenes: Array.from({ length: 8 }, (_, i) => ({ speaker: i % 2 ? 'robot' : 'hero', say: 'This line has quite a lot of words in it so that the whole script runs far too long for the time.' })) };
  assert.match(normalizeScript(long, PLAN).reason, /too long/);
  const forced = normalizeScript(long, PLAN, { final: true });
  assert.equal(forced.ok, true); assert.ok(forced.fixes.some(f => /cut lines/.test(f)));
  assert.equal(forced.scenes[forced.scenes.length - 1].say, long.scenes[7].say);       // the ending survives the cut
  const short = { scenes: [{ speaker: 'hero', say: 'Hello there.' }, { speaker: 'robot', say: 'Hello back.' }] };
  assert.match(normalizeScript(short, PLAN).reason, /too short/);
  assert.equal(normalizeScript(short, PLAN, { final: true }).ok, true);
});

test('an over-long line is cut at a sentence end', () => {
  const say = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty. ' + Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
  const s = normalizeScript({ scenes: [{ speaker: 'hero', say }, { speaker: 'robot', say: 'A second line so the script has two speakers in it.' }] }, PLAN, { final: true });
  assert.ok(s.scenes[0].say.split(' ').length <= 34);
  assert.ok(s.scenes[0].say.endsWith('twenty.'));
});

test('the script is rendered in the studio format', () => {
  const s = normalizeScript(GOOD, PLAN);
  const md = buildStudioMarkdown(PLAN, s);
  assert.match(md, /^---\ntitle: The Last Light\nrecipe: 8bit\ncast: hero, robot\npalette: nes\nformat: 16:9\n---\n## title\n# THE LAST \| LIGHT\nsub: PRESS START\ndur: 2\.5\n/);
  assert.equal((md.match(/^## line\d\d$/gm) || []).length, 4);
  assert.match(md, /## line01\nspeaker: robot\nsay: I found a tower/);
  assert.equal(headline('Beacon'), 'BEACON');
  assert.equal(headline('Lighthouse Keeper'), 'LIGHTHOUSE | KEEPER');
});

test('spoken lines map back to their speaker', () => {
  const lines = speakerLines(normalizeScript(GOOD, PLAN));
  assert.equal(lines.get(normalizeLine('  That is a LIGHTHOUSE. It guides ships home   through the dark. ')), 'hero');
  assert.equal(lines.get(normalizeLine(GOOD.scenes[2].say)), 'robot');
  assert.equal(lines.get('something never written'), undefined);
});

test('helpers', () => {
  assert.deepEqual(extractJson('noise {"a": 1} trailing'), { a: 1 });
  assert.equal(extractJson('nothing'), null);
  const p = stillPrompt(settleKind(planCreation('make a 2-bit still of a lighthouse in a storm'), 'still'));
  assert.match(p, /lighthouse in a storm/); assert.match(p, /Game Boy/); assert.ok(!/^make/i.test(p));
});
