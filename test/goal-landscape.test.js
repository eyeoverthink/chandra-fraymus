// 2026-11-13: 78 % of a week's autonomous goals were about the system's own memory category labels. Goals now come
// from measured problems and Vaughn's projects, and each must cite one and say how it will be checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { checkObjective, sameJob, realProblems, loadProjects, DEFAULT_PROJECTS } from '../server/intelligence/goal-landscape.js';
import { createStreamingTools } from '../server/streaming/tools.js';
import { needsApproval } from '../server/fleet/tool-select.js';

const problems = [{ id: 'P1', kind: 'run_failure', text: 'x', check: 'y' }];
const projects = [{ id: 'stream', name: 'Live stream' }];
const categories = ['world', 'dream', 'neurogenesis_seed', 'outcome', 'fossil', 'dream_duplicate'];
const ctx = { problems, projects, categories };

test('the goals from the pasted report are refused, a concrete grounded goal is kept', () => {
  for (const objective of [
    "Develop a cross-domain evolutionary model that unifies 'world', 'dream', 'neurogenesis_seed', and 'outcome' by integrating verified fossil data",
    "Quantify the causal influence of 'dream_duplicate' and 'perspective_dream' on 'neurogenesis_seed' and 'outcome'",
    "Reconstruct the evolutionary origin of 'world' by integrating low-confidence 'world' data with verified 'fossil' insights",
  ]) assert.equal(checkObjective({ objective, grounded_in: 'P1', done_when: 'a test passes' }, ctx).ok, false, objective);
  const good = checkObjective({ objective: "Find why runs fail with model 'llama3.2:3b' not found on srv1 and prepare the fix", grounded_in: 'P1', done_when: 'the error does not recur in 24 h' }, ctx);
  assert.equal(good.ok, true, good.reason);
  assert.match(checkObjective({ objective: 'Improve the overlay rendering of minted emotes on stream', grounded_in: 'P9', done_when: 'x passes' }, ctx).reason, /not a listed problem or project/);
  assert.match(checkObjective({ objective: 'Improve the overlay rendering of minted emotes on stream', grounded_in: 'stream' }, ctx).reason, /no way to check/);
});

test('the same job in other words counts as a duplicate; a different job does not', () => {
  assert.equal(sameJob("Investigate the failed agent runs related to the 'llama3.2:3b' model not being found",
    "Investigate and resolve the failed agent run related to the 'llama3.2:3b' model not being found on srv1 (Done when: x)"), true);
  assert.equal(sameJob('Fix the code change failure in server/intelligence/research-scout.js:293',
    'Generate a new emote from a stream moment and verify it is displayed on the OBS overlay'), false);
});

test('real problems leave out restarts and cancellations, and cite capability weaknesses from the gauge', () => {
  const db = new Database(':memory:');
  const now = Date.now();
  db.exec(`CREATE TABLE runs (status TEXT, error TEXT, updated_at INTEGER);
    CREATE TABLE capability_runs (status TEXT, strategy_mode TEXT, by_family TEXT, completed_at INTEGER);`);
  const r = db.prepare('INSERT INTO runs VALUES (?, ?, ?)');
  for (let i = 0; i < 5; i++) r.run('error', 'interrupted by restart', now - 1000);
  r.run('error', "no machine could answer (local: model 'llama3.2:3b' not found)", now - 1000);
  db.prepare(`INSERT INTO capability_runs VALUES ('completed', 'auto', ?, ?)`).run(JSON.stringify({ logic: { n: 10, correct: 4 }, code: { n: 10, correct: 10 } }), now);
  const p = realProblems(db, { now });
  assert.deepEqual(p.map(x => x.kind), ['run_failure', 'capability']);
  assert.match(p[0].text, /llama3\.2:3b/);
  assert.match(p[1].text, /logic problems solved 40 %/);
  assert.equal(p[0].id, 'P1');
  db.close();
});

test('the project list starts from the defaults when no file exists yet', () => {
  assert.deepEqual(loadProjects().map(p => p.id), DEFAULT_PROJECTS.map(p => p.id));
});

test('a simulated donation asks for approval only while an OBS overlay would show it to viewers', () => {
  const bridge = { clients: new Set(), broadcastArtifact() {} };
  const tool = createStreamingTools({ obsBridge: bridge, db: new Database(':memory:') }).find(t => t.name === 'streaming.simulate_donation');
  assert.equal(needsApproval(tool, { donor_name: 'x', amount: 1 }), false, 'no overlay: agents test freely');
  bridge.clients.add({});
  assert.equal(needsApproval(tool, { donor_name: 'x', amount: 1 }), true, 'overlay connected: viewers would see it');
});
