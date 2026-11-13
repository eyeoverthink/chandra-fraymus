import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let directory, db, bridge, planCreation, normalizeFor;
const previousDataDir = process.env.CHANDRA_DATA_DIR;

const DREAMS = [
  'Some goals result in replies indicating that the agent found nothing or could not act, as seen in the 5 of 14 goals that scored between 0.06 to 0.19. [evidence E1, E4: "goal x status done quality 0.06 reply: no relevant memories were found"]',
  'Hybrid-predictor-v1 consistently scores 0.06 on its goals. [evidence E2, E3: "hybrid-predictor-v1 2 goals quality 0.06 to 0.06 mean 0.06"]',
  "The 'world' memory category frequently returns no results when analyzed, leading to low-quality outcomes. [evidence E5: \"reply: the world category returned no results quality 0.12\"]",
  'There was a significant increase in agent errors over the last hour, as indicated by the error spike alerts showing 69 to 72 agent errors. [evidence E21, E22: "warning alert error_spike: Error spike: 72 agent errors in last hour"]',
];

before(async () => {
  const parent = await fs.realpath(os.tmpdir());
  directory = await fs.mkdtemp(path.join(parent, 'chandra-dream-bridge-'));
  // Set the database location BEFORE importing anything that opens it.
  process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
  ({ db } = await import('../server/db.js'));
  db.exec(`CREATE TABLE IF NOT EXISTS agent_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, category TEXT, key TEXT, value TEXT,
    confidence REAL, source TEXT, access_count INTEGER DEFAULT 0, verified_at INTEGER, created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS creation_jobs (id TEXT PRIMARY KEY, status TEXT, output TEXT, error TEXT)`);
  bridge = await import('../server/intelligence/dream-bridge.js');
  ({ planCreation } = await import('../server/media/make-plan.js'));
  ({ normalizeFor } = await import('../server/media/make-looks.js'));
  const t = Date.now() - 3600_000;
  const ins = db.prepare(`INSERT INTO agent_memories (agent_id, category, key, value, confidence, source, created_at) VALUES ('system', 'dream', ?, ?, 0.7, 'daemon-dream-grounded', ?)`);
  DREAMS.forEach((v, i) => ins.run(`dream:${t + i}:${i}`, v, t + i * 1000));
  // an ungrounded dream and a non-dream memory must never be picked up
  db.prepare(`INSERT INTO agent_memories (agent_id, category, key, value, source, created_at) VALUES ('system', 'dream', 'old', 'Goal-seeking appears to be increasing.', 'daemon-dream', ?)`).run(t);
  db.prepare(`INSERT INTO agent_memories (agent_id, category, key, value, source, created_at) VALUES ('system', 'outcome', 'o', 'An outcome. [evidence E1: "x"]', 'daemon-dream-grounded', ?)`).run(t);
});

after(async () => {
  bridge?.stopDreamBridge();
  try { db.close(); } catch (_) { /* already closed */ }
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR; else process.env.CHANDRA_DATA_DIR = previousDataDir;
  await fs.rm(directory, { recursive: true, force: true }).catch(e => console.error('cleanup:', e.message));
});

test('parseDream separates the lesson, its evidence ids and the quote', () => {
  const d = bridge.parseDream(DREAMS[3]);
  assert.equal(d.lesson, 'There was a significant increase in agent errors over the last hour, as indicated by the error spike alerts showing 69 to 72 agent errors.');
  assert.deepEqual(d.evidence, ['E21', 'E22']);
  assert.equal(d.quote, 'warning alert error_spike: Error spike: 72 agent errors in last hour');
  assert.deepEqual(bridge.parseDream('A lesson with no evidence.'), { lesson: 'A lesson with no evidence.', evidence: [], quote: null });
});

test('splitLesson keeps every word in order, adds none, and never ends a line on a function word', () => {
  for (const raw of DREAMS) {
    const { lesson } = bridge.parseDream(raw);
    const lines = bridge.splitLesson(lesson);
    const norm = s => s.replace(/[.,;:]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
    assert.deepEqual(norm(lines.join(' ')), norm(lesson), 'the lines are the lesson, word for word');
    for (const l of lines) {
      const n = l.split(' ').length;
      assert.ok(n >= 3 && n <= 18, `flat rule 3 (3-18 words): "${l}"`);
      assert.doesNotMatch(l, /\b(or|and|that|the|of|to|between)\.?$/i, `no dangling ending: "${l}"`);
    }
    assert.match(lines[0], /^[A-Z']/, 'the first line starts the sentence');
    assert.match(lines.at(-1), /[.!?]$/, 'the last line ends it');
    lines.slice(0, -1).forEach(l => assert.doesNotMatch(l, /\.$/, `a mid-sentence line gets no full stop: "${l}"`));
  }
});

test('reel shots carry the dreams in order and the flat checker accepts them without cutting a lesson', () => {
  const lessons = DREAMS.map((v, i) => ({ id: i + 1, ...bridge.parseDream(v) }));
  const shots = bridge.reelShots(lessons);
  assert.equal(shots[0].say, 'Here is what I learned about myself today.');
  assert.equal(shots.at(-1).say, 'Each of these came from what really happened.');
  assert.ok(shots.every(s => s.who.includes('nilo')), 'the lead is in every shot');
  assert.ok(shots.slice(1, -1).every(s => s.who.length === 2), 'each lesson has a second cast member');
  assert.equal(new Set(shots.slice(1, -1).map(s => s.where)).size, lessons.length, 'each lesson has its own setting');
  assert.equal(bridge.feelingOf('agent errors spiked'), 'sad');
  assert.equal(bridge.feelingOf('quality improved'), 'proud');
  assert.equal(bridge.feelingOf('the queue held'), 'curious');

  const seconds = bridge.reelSeconds(shots);
  const plan = planCreation('a flat vector reel of what Chandra learned about itself today', { style: 'flat', kind: 'video', format: '16:9', seconds });
  const r = normalizeFor({ title: 'What I learned', shots }, plan, { final: true });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.shots.length, shots.length, 'no shot was cut to fit the length');
  assert.ok(!r.fixes.some(f => /cut before the ending|rule \d+ not met/.test(f)), `no rule missed: ${r.fixes.join(' | ')}`);
  // the numbers the narration speaks are the dreams' own
  const said = r.shots.map(s => s.say).join(' ');
  for (const n of ['0.06', '0.19', '69', '72']) assert.ok(said.includes(n), `${n} is spoken`);
});

test('relatedModules offers the files a lesson names, never generic ones', () => {
  const files = ['server/intelligence/world-pollers.js', 'server/intelligence/memory-search.js', 'server/fleet/runtime.js', 'server/intelligence/ollama-scheduler.js', 'server/intelligence/narrator.js', 'server/fleet/tools.js'];
  assert.deepEqual(bridge.relatedModules("The 'world' memory category frequently returns no results", files), ['server/intelligence/memory-search.js', 'server/intelligence/world-pollers.js']);
  assert.deepEqual(bridge.relatedModules('the narrator dropped lines while the scheduler queue was full', files), ['server/intelligence/narrator.js', 'server/intelligence/ollama-scheduler.js']);
  assert.deepEqual(bridge.relatedModules('agent tools at runtime', files), [], 'routes / tools / runtime / agent are too generic to point at a file');
});

test('a code answer must name a function the target file declares', async () => {
  const { declaredNames, namedFunctions, functionsByModule } = await import('../server/intelligence/research-scout.js');
  const src = `export function collectInterests(a) {}\nconst pollOnce = async () => {};\nclass P {\n  scanTrends(x) {\n    if (x) {}\n  }\n}\nfunction* gen() {}`;
  const names = declaredNames(src);
  for (const n of ['collectInterests', 'pollOnce', 'scanTrends', 'gen']) assert.ok(names.has(n), n);
  assert.ok(!names.has('if'), 'control words are not functions');
  assert.deepEqual(namedFunctions("Add a timeout to 'pollOnce' so a slow feed cannot stall the cycle", src), ['pollOnce']);
  assert.deepEqual(namedFunctions("Add a validation step in the 'processNeurogenesisSeed' function", src), [], 'the real failure: a function that does not exist');
  // reads real files from the repository — a missing fs import would make this empty and refuse every code answer
  const fns = functionsByModule(['server/intelligence/dream-bridge.js']);
  assert.ok(fns['server/intelligence/dream-bridge.js'].includes('splitLesson'), 'functions are read from disk');
});

test('enqueueDreams files each grounded dream once, as a research item the paper scout leaves alone', () => {
  const a = bridge.enqueueDreams();
  assert.equal(a.dreams, DREAMS.length);
  assert.equal(a.added, DREAMS.length);
  assert.equal(bridge.enqueueDreams().added, 0, 'a second pass adds nothing');
  const rows = db.prepare("SELECT * FROM research_items WHERE source = 'dream' ORDER BY published_at").all();
  assert.equal(rows.length, DREAMS.length);
  assert.ok(rows.every(r => r.status === 'dream_new' && r.relevance === bridge.DREAM_RELEVANCE));
  assert.match(rows[3].abstract, /Evidence \(E21, E22\): "warning alert error_spike/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM research_items WHERE source = 'dream' AND title LIKE 'Goal-seeking%'").get().n, 0, 'an ungrounded dream is not filed');
});

test('makeDreamReel hands the shot list to Make, records it, and settles it from the job', async () => {
  let asked = null;
  const fake = async opts => { asked = opts; return { accepted: true, id: 'job_test_1' }; };
  const made = await bridge.makeDreamReel({ force: true, createFromRequest: fake });
  assert.equal(made.made, true, made.reason);
  assert.equal(asked.style, 'flat');
  assert.equal(asked.source, 'dream-reel');
  assert.ok(asked.seconds >= 15 && asked.seconds <= 180);
  assert.equal(asked.scenes[0].say, 'Here is what I learned about myself today.');
  assert.equal(made.lessons, DREAMS.length);

  const again = await bridge.makeDreamReel({ createFromRequest: fake });
  assert.equal(again.made, false, 'not twice within the gap');
  const reused = await bridge.makeDreamReel({ force: true, createFromRequest: fake });
  assert.equal(reused.made, false, 'a lesson is not put in two reels');

  db.prepare("INSERT INTO creation_jobs (id, status, output) VALUES ('job_test_1', 'completed', ?)").run(JSON.stringify({ file: 'reel.mp4', seconds: 41.2 }));
  assert.equal(bridge.settleReels(), 1);
  const reel = db.prepare('SELECT * FROM dream_reels WHERE id = ?').get(made.reelId);
  assert.equal(reel.status, 'done');
  assert.equal(reel.file, 'reel.mp4');
  assert.equal(reel.seconds, 41.2);

  const refused = await (async () => { db.prepare('DELETE FROM dream_reels').run(); return bridge.makeDreamReel({ force: true, createFromRequest: async () => ({ accepted: false, reason: 'flat rule 4' }) }); })();
  assert.equal(refused.made, false);
  assert.equal(db.prepare('SELECT status, error FROM dream_reels WHERE id = ?').get(refused.reelId).error, 'flat rule 4');
});

test('status reports items, proposals and reels', () => {
  const s = bridge.dreamBridgeStatus();
  assert.equal(s.keptDreams, DREAMS.length);
  assert.equal(s.items.dream_new, DREAMS.length);
  assert.ok(Array.isArray(s.reels));
});
