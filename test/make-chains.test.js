import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { renderTemplate, validateChain, buildsOn, createChainRunner, BUILTIN_CHAINS } from '../server/media/make-chains.js';

const fakeAdapters = (log, overrides = {}) => ({
  write: async (step, r) => { log.push(['write', r.prompt, r.feedback]); return { summary: `A lighthouse keeper named Ada finds a lost robot on the rocks. ${r.prompt.slice(0, 40)}` }; },
  paint: async (step, r) => { log.push(['paint', r.prompt]); return { file: { file: 'pic-1.png', kind: 'image' } }; },
  restyle: async (step, r, ctx) => { log.push(['restyle', ctx.previousFile.file]); return { file: { file: 'pic-2.png', kind: 'image' } }; },
  move: async (step, r, ctx) => { log.push(['move', ctx.previousFile.file]); return { file: { file: 'clip-1.mp4', kind: 'video' } }; },
  motion: async (step, r, ctx) => { log.push(['motion', ctx.previousFile.file, r.prompt]); return { file: { file: 'clip-2.mp4', kind: 'video' } }; },
  avatar: async () => ({ file: { file: 'turn.mp4', kind: 'video' } }),
  make: async (step, r) => { log.push(['make', r.prompt]); return { file: { file: step.as === 'page' ? 'game-slug' : 'film.mp4', kind: step.as === 'page' ? 'page' : 'video' } }; },
  voice: async (step, r) => { log.push(['voice', r.text]); return { file: { file: 'line.wav', kind: 'audio' } }; },
  ...overrides,
});
const runner = (log, overrides, opts) => createChainRunner({ db: new Database(':memory:'), adapters: fakeAdapters(log, overrides), ...opts });

test('templates fill from the chain so far and report what is missing', () => {
  const ctx = { input: 'a robot', previousSummary: 'the story', previousFile: { file: 'a.png', kind: 'image' }, steps: [{ summary: 'one', file: { file: 'f1.png' } }] };
  assert.equal(renderTemplate('{{input}} / {{previous_summary}} / {{previous_file}} / {{step_1}} / {{step_1_file}}', ctx).text, 'a robot / the story / a.png / one / f1.png');
  const r = renderTemplate('{{step_2}} and {{previous_file}}', { steps: [], previousFile: null });
  assert.deepEqual(r.missing.sort(), ['previous_file', 'step_2']);
});

test('a chain is refused before it runs when a step cannot be fed', () => {
  assert.match(validateChain({ steps: [{ kind: 'restyle', look: 'woodblock' }] }).errors.join(), /needs a image.*nothing before it makes one/);
  assert.equal(validateChain({ steps: [{ kind: 'restyle', look: 'woodblock' }] }, { inputFile: { file: 'x.png', kind: 'image' } }).ok, true);
  assert.match(validateChain({ steps: [{ kind: 'write', prompt: '{{step_2}}' }, { kind: 'write', prompt: 'x' }] }).errors.join(), /has not run yet/);
  assert.match(validateChain({ steps: [{ kind: 'paint', prompt: 'x' }, { kind: 'move' }, { kind: 'restyle', look: 'ascii' }] }).errors.join(), /needs a image.*newest file before it is a video/);
  assert.match(validateChain({ steps: [{ kind: 'dance' }] }).errors.join(), /unknown kind/);
  assert.match(validateChain({ steps: Array.from({ length: 9 }, () => ({ kind: 'write', prompt: 'x' })) }).errors.join(), /at most 8/);
  for (const c of BUILTIN_CHAINS) assert.equal(validateChain(c).ok, true, `${c.id}: ${validateChain(c).errors.join('; ')}`);
});

test('buildsOn needs shared content words, not filler', () => {
  const story = 'Ada the lighthouse keeper finds a lost robot on the rocks during a storm.';
  assert.equal(buildsOn(story, 'The robot and Ada climb the lighthouse while the storm breaks.').ok, true);
  assert.equal(buildsOn(story, 'A cat sleeps in the sun on a quiet afternoon.').ok, false);
});

test('each step is handed the previous text and the newest file, in order', async () => {
  const log = [];
  const r = runner(log);
  const run = r.startRun({ chainId: 'topic-to-explainer-pack', input: 'how lighthouses work' });
  await run.done;
  const out = r.getRun(run.id);
  assert.equal(out.status, 'completed', out.error);
  assert.deepEqual(log.map(l => l[0]), ['write', 'paint', 'move', 'voice']);
  assert.match(log[0][1], /how lighthouses work/);
  assert.match(log[1][1], /^flat vector illustration, A lighthouse keeper named Ada/);   // paint got the written text
  assert.equal(log[2][1], 'pic-1.png');                                                    // move got the painted picture
  assert.match(log[3][1], /Ada finds a lost robot/);                                       // voice said step 1
  assert.deepEqual(out.results.map(s => s.file?.file || null), [null, 'pic-1.png', 'clip-1.mp4', 'line.wav']);
  assert.equal(out.results[2].handed.file.file, 'pic-1.png');
});

test('a written step that ignores what it was handed is rewritten once, then fails the run', async () => {
  const log = [];
  let calls = 0;
  const ignoring = { write: async (step, r) => { calls++; log.push(['write', r.prompt, r.feedback]); return { summary: calls === 1 ? 'Ada the lighthouse keeper finds a lost robot during the storm.' : 'Bananas are yellow and grow in warm countries.' }; } };
  const r = runner(log, ignoring);
  const steps = [{ kind: 'write', prompt: 'story about {{input}}' }, { kind: 'write', prompt: 'Continue this: {{previous_summary}}' }];
  const run = r.startRun({ steps, input: 'a lighthouse' });
  await run.done;
  const out = r.getRun(run.id);
  assert.equal(out.status, 'error');
  assert.match(out.error, /step 2 did not build on what it was handed/);
  assert.equal(calls, 3);                                   // step 1, step 2, step 2 again with feedback
  assert.match(log[2][2], /ignored the material/);
});

test('a rewrite that does build on it passes', async () => {
  let calls = 0;
  const r = runner([], { write: async () => { calls++; return { summary: calls === 2 ? 'Something unrelated about bananas.' : 'Ada the lighthouse keeper and the lost robot fix the lamp before the storm.' }; } });
  const run = r.startRun({ steps: [{ kind: 'write', prompt: '{{input}}' }, { kind: 'write', prompt: 'Next scene after: {{previous_summary}}' }], input: 'Ada the lighthouse keeper finds a lost robot' });
  await run.done;
  const out = r.getRun(run.id);
  assert.equal(out.status, 'completed', out.error);
  assert.equal(out.results[1].continuity.ok, true);
});

test('a step that fails stops the chain and says where', async () => {
  const r = runner([], { move: async () => { throw new Error('the card is busy'); } });
  const run = r.startRun({ chainId: 'topic-to-explainer-pack', input: 'tides' });
  await run.done;
  const out = r.getRun(run.id);
  assert.equal(out.status, 'error');
  assert.equal(out.results.length, 3);
  assert.equal(out.results[2].status, 'error');
  assert.match(out.results[2].error, /card is busy/);
});

test('saved chains: validated, listed, deleted; built-ins are protected; boot closes open runs', async () => {
  const db = new Database(':memory:');
  const r = createChainRunner({ db, adapters: fakeAdapters([]) });
  assert.throws(() => r.saveChain({ name: 'bad', steps: [{ kind: 'paint' }] }), /"prompt" is required/);
  const saved = r.saveChain({ name: 'Restyle and move', steps: [{ kind: 'restyle', look: 'woodblock' }, { kind: 'move', move: 'orbit' }] });  // starts from a given picture
  assert.ok(r.listChains().some(c => c.id === saved.id));
  assert.throws(() => r.startRun({ chainId: saved.id }), /needs a image/);
  const ok = r.startRun({ chainId: saved.id, inputFile: { file: 'mine.png', kind: 'image' } });
  await ok.done;
  assert.equal(r.getRun(ok.id).status, 'completed');
  assert.equal(r.deleteChain('story-to-short').deleted, false);
  assert.equal(r.deleteChain(saved.id).deleted, true);
  db.prepare(`INSERT INTO make_chain_runs (id, status, steps, results, created_at) VALUES ('x', 'running', '[]', '[]', 1)`).run();
  assert.equal(r.recoverAtBoot('interrupted by restart'), 1);
  assert.equal(r.getRun('x').status, 'error');
});

test('a chain that starts from words refuses to run without them', () => {
  const r = runner([]);
  assert.throws(() => r.startRun({ chainId: 'story-to-short', input: '' }), /give an input/);
});

test('a voice step does not read stage directions aloud', async () => {
  const { spokenText } = await import('../server/media/make-chains.js');
  const said = spokenText("Have you ever wondered why the sky is blue? It's about sunlight.\nPICTURE: A vibrant blue sky with clouds.");
  assert.equal(said, "Have you ever wondered why the sky is blue? It's about sunlight.");
  assert.equal(spokenText('SFX: wind howls\nThe keeper climbs the stairs.'), 'The keeper climbs the stairs.');
  assert.equal(spokenText('NASA launched it in 1977.'), 'NASA launched it in 1977.');   // an acronym in a sentence is kept
});
