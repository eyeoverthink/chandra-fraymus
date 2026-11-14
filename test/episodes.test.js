import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkOutline, actContext, actBrief, checkActNarration, topicalPick, placeFor, outlineMessages, contentWords } from '../server/media/episode-plan.js';
import { normalizeFlat, flatMessages } from '../server/media/flat/plan.js';

const outlineReply = (over = {}) => JSON.stringify({
  title: 'The Lighthouse Storm', logline: 'Nilo keeps a lighthouse burning through the worst storm of the year.', cast: ['nilo', 'bru'],
  acts: [
    { title: 'The Warning', beat: 'Nilo the lighthouse keeper hears a radio warning that a huge storm is heading for the coast tonight.', where: 'beach' },
    { title: 'Lamp Goes Dark', beat: 'The storm hits and the great lamp fails, so Nilo climbs the tower in the wind to find a broken gear.', where: 'night' },
    { title: 'Bru Brings Tools', beat: 'Bru rows across the harbour with a crate of tools and together they fix the gear by lantern light.', where: 'ocean' },
    { title: 'Light Again', beat: 'The lamp shines again just as a fishing boat appears, and the boat steers safely past the rocks.', where: 'night' },
  ], ...over });

test('a good outline passes; the lead is always in; places come from the kit', () => {
  const r = checkOutline(outlineReply(), { acts: 4 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.outline.acts.length, 4);
  assert.ok(r.outline.cast.includes('nilo'));
  const noLead = checkOutline(outlineReply({ cast: ['bru', 'dot'] }), { acts: 4 });
  assert.equal(noLead.ok, true); assert.ok(noLead.outline.cast[0] === 'nilo'); assert.ok(noLead.fixes.some(f => /lead/.test(f)));
  assert.equal(placeFor('the stormy sea', 'the boat'), 'ocean');                     // read by the setting's own words
  assert.equal(placeFor('beach', 'a radio warning about the coast'), 'mountains');   // not a kit place: read from the beat
});

test('an outline is refused for the wrong count, a thin cast, a short beat or a beat told twice — with the reason', () => {
  assert.match(checkOutline(outlineReply(), { acts: 5 }).reason, /4 acts with a beat; 5 were asked/);
  assert.match(checkOutline(outlineReply({ cast: ['nobody'] }), { acts: 4 }).reason, /at least two/);
  const short = JSON.parse(outlineReply()); short.acts[1].beat = 'The lamp fails.';
  assert.match(checkOutline(short, { acts: 4 }).reason, /Act 2's beat has 3 words/);
  const twice = JSON.parse(outlineReply()); twice.acts[3].beat = twice.acts[2].beat.replace('Bru rows', 'Bru then rows');
  assert.match(checkOutline(twice, { acts: 4 }).reason, /Acts 3 and 4 tell nearly the same beat/);
  assert.equal(checkOutline('not json', { acts: 4 }).ok, false);
  // too many acts: the extras before the last are dropped, so the ending survives
  const many = JSON.parse(outlineReply()); many.acts.splice(3, 0, { title: 'Extra', beat: 'Nilo makes a cup of tea in the tower kitchen while the rain hammers on the round windows.', where: 'city' });
  const cut = checkOutline(many, { acts: 4 });
  assert.equal(cut.ok, true); assert.equal(cut.outline.acts[3].title, 'Light Again');
});

test('each act is handed its beat, how the story stands and what comes next', () => {
  const o = checkOutline(outlineReply(), { acts: 4 }).outline;
  const first = actBrief(actContext(o, 1, []));
  assert.match(first, /act 1 of 4/); assert.match(first, /first act/); assert.match(first, /radio warning/);
  const earlier = [{ shots: [{ say: 'Nilo hears the warning on the radio.' }, { say: 'The sky turns black over the sea.' }] }];
  const ctx2 = actContext(o, 2, earlier);
  assert.equal(ctx2.previously, 'Nilo hears the warning on the radio. The sky turns black over the sea.');
  assert.deepEqual(ctx2.earlierLines, earlier[0].shots.map(s => s.say));
  assert.match(actBrief(ctx2), /do not introduce the characters again/);
  assert.match(actBrief(ctx2), /Stop before the next act/);
  assert.match(actBrief(actContext(o, 4, earlier)), /last act: the last line resolves/);
  assert.match(outlineMessages('a storm at a lighthouse', { acts: 4 })[0].content, /Exactly 4 acts/);
});

test('rule 18: an act must tell its beat and repeat nothing an earlier act said', () => {
  const o = checkOutline(outlineReply(), { acts: 4 }).outline;
  const ctx = actContext(o, 2, [{ shots: [{ say: 'Nilo hears a radio warning about a huge storm.' }] }]);
  const tells = [{ say: 'The storm hits the coast hard.' }, { say: 'The great lamp fails and goes dark.' }, { say: 'Nilo climbs the tower in the wind.' }, { say: 'He finds a broken gear.' }];
  assert.equal(checkActNarration(tells, ctx).ok, true);
  const offBeat = [{ say: 'Nilo bakes a lemon cake.' }, { say: 'He shares it with friends at a party.' }, { say: 'Everyone sings a happy song.' }];
  assert.match(checkActNarration(offBeat, ctx).reason, /does not tell its beat/);
  const repeats = [...tells, { say: 'Nilo hears a radio warning about a huge storm.' }];
  assert.match(checkActNarration(repeats, ctx).reason, /repeats what an earlier act already said/);
  assert.ok(contentWords('storms').has('storm'));
});

test('rule 18 runs inside the real flat checker, and the writer is told about the act', () => {
  const o = checkOutline(outlineReply(), { acts: 4 }).outline;
  const plan = { request: 'Act 2 of 4', seconds: 20, style: 'flat', episode: actContext(o, 2, []) };
  const offBeat = { title: 'x', shots: [
    { say: 'Nilo bakes a big lemon cake today.', where: 'city', show: ['cake'], who: ['nilo'], feel: 'happy' },
    { say: 'He carries the cake to a party.', where: 'city', show: ['cake'], who: ['nilo', 'bru'], feel: 'happy' },
    { say: 'Bru eats the whole cake at once.', where: 'field', show: ['cake'], who: ['bru', 'nilo'], feel: 'surprised' },
    { say: 'Nilo laughs and bakes another one.', where: 'field', show: ['oven'], who: ['nilo'], feel: 'happy' },
    { say: 'The party goes on until the night.', where: 'night', show: ['star'], who: ['nilo'], feel: 'proud' }] };
  const r = normalizeFlat(offBeat, plan);
  assert.equal(r.ok, false); assert.match(r.reason, /Rule 18/);
  assert.equal(normalizeFlat(offBeat, plan, { final: true }).ok, false);   // cannot be repaired without the writer
  assert.ok(!normalizeFlat(offBeat, { ...plan, episode: undefined }).rules.some(x => x.n === 18));   // only for acts
  assert.match(flatMessages(plan)[1].content, /act 2 of 4/);
});

test('a topical premise is a page that can hold a story: not page furniture, reference, stock or how-to; never reused', () => {
  // the first four are real titles the world poller had stored when this was built
  const rows = [{ title: 'Gartner hype cycle - Wikipedia', url: 'w' }, { title: 'Donate Overlay royalty-free images - Shutterstock', url: 's' },
    { title: '18 Easy Ways to Increase Your Attention Span & Improve Focus - wikiHow', url: 'h' }, { title: 'A practical guide to setting confidence thresholds for AI responses', url: 'g' },
    { title: 'Sign in to continue reading this article', url: 'b' }, { title: 'Local volunteers restore a 1920s lighthouse lamp', url: 'c', snippet: 'The lamp shines again.' }];
  assert.equal(topicalPick(rows).url, 'c');
  assert.equal(topicalPick(rows, new Set(['c'])), null);
  // a search result's cut-off title loses its "..." tail (the live premise had "…and in themselves: The ...")
  assert.equal(topicalPick([{ title: 'Human confidence in artificial intelligence and in themselves: The ...', url: 'x' }]).title, 'Human confidence in artificial intelligence and in themselves');
});

test('cards are drawn, and joined clips last the sum of their parts', async () => {
  const { cardPng, assemble, checkEpisode } = await import('../server/media/episode-builder.js');
  const sharp = (await import('node:module')).createRequire(import.meta.url)('sharp');
  const png = cardPng({ label: 'Act 2 of 3', title: 'The Lamp Goes Dark' });
  const meta = await sharp(png).metadata(); assert.deepEqual([meta.width, meta.height], [1920, 1080]);
  const { channels } = await sharp(png).stats(); assert.ok(channels[0].max > 200 && channels[0].min < 60, 'text on a dark card');
  const dir = mkdtempSync(join(tmpdir(), 'chandra-episode-'));
  try {
    const clip = (name, secs, rate) => { const p = join(dir, name); execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=${rate}:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}:sample_rate=24000`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', p]); return p; };
    // two acts in another size, frame rate and sample rate than the episode: normalised before joining
    const acts = [{ n: 1, title: 'One', path: clip('a.mp4', 2, 25) }, { n: 2, title: 'Two', path: clip('b.mp4', 3, 24) }];
    const r = await assemble({ dir, title: 'Test Episode', logline: 'A test.', acts });
    assert.equal(r.parts.length, 5);
    const v = checkEpisode({ measured: r.measured, parts: r.lengths, actsAsked: 2, actsMade: 2 });
    assert.equal(v.ok, true, JSON.stringify(v.checks));
    assert.ok(Math.abs(r.measured.seconds - (3 + 1.6 * 2 + 2 + 3)) < 1.5, `${r.measured.seconds} s`);
    assert.equal(checkEpisode({ measured: r.measured, parts: r.lengths, actsAsked: 3, actsMade: 2 }).ok, false);
    assert.equal(checkEpisode({ measured: { ...r.measured, seconds: r.measured.seconds + 4 }, parts: r.lengths, actsAsked: 2, actsMade: 2 }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
