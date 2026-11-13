import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Fixes made on 2026-11-13 after the app's own self-audit: a consumer for synthesized workflows, a guard against
// span rewrites that drop a declaration, the convention scanner leaving timestamps alone, Ouroboros parsing a bare
// object, and work interrupted by a restart closed at boot. The DB parts run in their own data folder.
let directory, db, T, SM, CS, OC, SW;
const previousDataDir = process.env.CHANDRA_DATA_DIR;
before(async () => {
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'chandra-repair-'));
  process.env.CHANDRA_DATA_DIR = path.join(directory, 'data');
  ({ db } = await import('../server/db.js'));
  T = await import('../server/workflow/trials.js');
  SM = await import('../server/intelligence/self-modification.js');
  CS = await import('../server/intelligence/convention-scan.js');
  OC = await import('../server/intelligence/ouroboros-cycle.js');
  SW = await import('../server/intelligence/transient-sweeper.js');
});
after(async () => {
  if (previousDataDir === undefined) delete process.env.CHANDRA_DATA_DIR; else process.env.CHANDRA_DATA_DIR = previousDataDir;
  await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
});

test('workflow steps are classified: thinking and local work is safe, the store, code and the GPU are not', () => {
  assert.equal(T.classifyNodes([{ type: 'llm' }, { type: 'cognition' }, { type: 'web_search' }]).safe, true);
  const shop = T.classifyNodes([{ type: 'llm' }, { type: 'shopify_publish' }, { type: 'code' }]);
  assert.equal(shop.safe, false);
  assert.deepEqual(shop.reasons.sort(), ['code: runs generated code', 'shopify_publish: changes the live store']);
  assert.equal(T.classifyNodes([{ type: 'mystery_node' }]).reasons[0], 'mystery_node: unknown step');
  assert.equal(T.classifyNodes([]).safe, false, 'an empty workflow is not trialable');
  assert.equal(T.classifyNodes([{ type: 'llm' }, { type: 'cognition' }]).signature, T.classifyNodes([{ type: 'cognition' }, { type: 'llm' }, { type: 'llm' }]).signature);
});

test('triage marks every synthesized workflow without running anything', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, nodes TEXT, edges TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS synthesized_workflows (id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT, synthesized_by TEXT, goal TEXT, node_count INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS workflow_runs (id TEXT PRIMARY KEY, workflow_id TEXT, user_id TEXT, status TEXT, input_prompt TEXT, results TEXT, final_image_url TEXT, final_html TEXT, duration_ms INTEGER, created_at INTEGER);`);
  T.migrateTrials();
  const add = (id, types) => {
    db.prepare('INSERT INTO workflows (id, user_id, name, nodes, edges, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, 'local', id, JSON.stringify(types.map((t, i) => ({ id: `n${i}`, type: t }))), '[]', Date.now(), Date.now());
    db.prepare('INSERT INTO synthesized_workflows (workflow_id, synthesized_by, goal, node_count, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'reflection', `goal ${id}`, types.length, Date.now());
  };
  add('a', ['llm', 'cognition']); add('b', ['cognition', 'llm']); add('c', ['llm', 'shopify_publish']); add('d', ['dream']);
  const counts = T.triage();
  assert.deepEqual(counts, { needs_operator: 1, duplicate: 1, queued: 2 });
  const status = Object.fromEntries(db.prepare('SELECT workflow_id, trial_status FROM synthesized_workflows').all().map(r => [r.workflow_id, r.trial_status]));
  assert.deepEqual(status, { a: 'queued', b: 'duplicate', c: 'needs_operator', d: 'queued' });
  assert.match(db.prepare("SELECT trial_reason FROM synthesized_workflows WHERE workflow_id = 'c'").get().trial_reason, /live store/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_runs').get().n, 0, 'triage runs nothing');
  assert.deepEqual(T.triage(), { needs_operator: 0, duplicate: 0, queued: 0 }, 'a second triage changes nothing');
});

test('a span rewrite that drops a declaration it still uses is caught', () => {
  const before = 'const signals = getSignals(id);\nconst predictions = getPredictions(id, 10);\nres.json({ signals, predictions });';
  const broken = 'const predictions = getPredictions(id, Math.min(500, 10));\nres.json({ signals, predictions });';
  assert.deepEqual(SM.droppedDeclarations(before, broken), ['signals']);
  assert.deepEqual(SM.droppedDeclarations(before, before.replace('10', '20')), []);
  assert.deepEqual(SM.droppedDeclarations('const { a, b: renamed } = x; use(a, renamed);', 'use(a, renamed);'), ['a', 'renamed']);
  assert.deepEqual(SM.droppedDeclarations('const tmp = 1; return tmp;', 'return 1;'), [], 'a removed name that is no longer used is fine');
});

test('the convention scanner clamps counts, not times or positions', () => {
  const rule = CS.RULES.find(r => r.id === 'unclamped_query_param');
  assert.equal(rule.test('const limit = parseInt(req.query.limit) || 50;'), true);
  for (const p of ['since', 'until', 'cursor', 'createdAt', 'fromTs', 'before'])
    assert.equal(rule.test(`const v = parseInt(req.query.${p}) || 0;`), false, p);
  assert.equal(rule.test('const n = Math.min(5, parseInt(req.query.n) || 1);'), false, 'already clamped');
});

test('Ouroboros reads an array, an object holding one, or a single bare item', () => {
  assert.equal(OC.parseJSONArray('[{"title":"a"}]').length, 1);
  assert.equal(OC.parseJSONArray('{"proposals":[{"title":"a"},{"title":"b"}]}').length, 2);
  assert.deepEqual(OC.parseJSONArray('{"title":"one","category":"reliability"}'), [{ title: 'one', category: 'reliability' }]);
  assert.equal(OC.parseJSONArray('{"note":"nothing here"}'), null);
});

test('work a dead process left running is closed at boot, work started by this process is not', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS verification_loops (id TEXT PRIMARY KEY, status TEXT, error TEXT, created_at INTEGER, completed_at INTEGER)`);
  db.prepare("INSERT INTO verification_loops (id, status, created_at) VALUES ('old', 'running', ?)").run(Date.now() - 3600_000);
  db.prepare("INSERT INTO verification_loops (id, status, created_at) VALUES ('new', 'running', ?)").run(Date.now() + 60_000);
  const out = SW.sweepOrphansFromPreviousProcess();
  assert.equal(out.verification_loops, 1);
  const s = Object.fromEntries(db.prepare('SELECT id, status FROM verification_loops').all().map(r => [r.id, r.status]));
  assert.deepEqual(s, { old: 'error', new: 'running' });
});
