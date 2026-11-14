import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../server/db.js';
import * as L from '../server/intelligence/card-ledger.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clear = () => db.prepare('DELETE FROM card_ledger').run();

test('who is charged: the store, else the system loop named by the label; the budget only limits agents', () => {
  assert.equal(L.originOf({ origin: 'agent:helix' }, 'x'), 'agent:helix');
  assert.equal(L.originOf(null, 'reflection: deep'), 'system:reflection');
  assert.equal(L.originOf(null, ''), 'system:unlabelled');
  assert.equal(L.cardBudgetDecision('agent:helix', 1900, 1800).ok, false);
  assert.match(L.cardBudgetDecision('agent:helix', 1900, 1800).reason, /helix has used 1900 s/);
  assert.equal(L.cardBudgetDecision('agent:helix', 100, 1800).ok, true);
  assert.equal(L.cardBudgetDecision('api', 99999, 1800).ok, true, 'a person is never refused');
  assert.equal(L.cardBudgetDecision('system:dream', 99999, 1800).ok, true);
});

test('the origin travels through awaits, timers and a job queued for later; inner jobs add their via, the outer origin stays', async () => {
  let queue = Promise.resolve();
  const seen = [];
  await L.withOrigin({ origin: 'agent:helix', run: 'run-1' }, async () => {
    await sleep(5);
    seen.push(L.currentOrigin().origin);
    // a job queued now runs later, after this function returned: it must still be helix's
    queue = queue.then(() => L.withOrigin({ via: 'looks:abc', origin: 'api' }, async () => { await sleep(5); seen.push(JSON.stringify(L.currentOrigin())); }));
  });
  assert.equal(L.currentOrigin(), null, 'nothing leaks outside');
  await queue;
  assert.equal(seen[0], 'agent:helix');
  assert.deepEqual(JSON.parse(seen[1]), { origin: 'agent:helix', via: ['looks:abc'], run: 'run-1' });
});

test('rows are totalled by who, what and where; a job finds its own rows by id or via', async () => {
  clear();
  await L.withOrigin({ origin: 'agent:helix' }, () => L.withOrigin({ via: 'look-1234' }, async () => {
    L.recordCard({ machine: 'home', card: 'gpu', kind: 'motion', seconds: 120, label: 'motion: a cat' });
    L.recordCard({ machine: 'home', card: 'gpu', kind: 'model', seconds: 3, label: 'agent' });
  }));
  L.recordCard({ machine: 'kvm2', card: 'cpu', kind: 'model', seconds: 40, label: 'dream: consolidate' });
  await L.withOrigin({ origin: 'api' }, async () => L.recordCard({ machine: 'this PC', card: 'gpu', kind: 'voice', seconds: 4, label: 'voice: vaughn-one' }));
  const byOrigin = L.cardLedger({ days: 1, by: 'origin' });
  assert.equal(byOrigin.total.gpuSeconds, 127); assert.equal(byOrigin.total.cpuSeconds, 40); assert.equal(byOrigin.total.uses, 4);
  const helix = byOrigin.rows.find(r => r.key === 'agent:helix');
  assert.equal(helix.gpuSeconds, 123); assert.equal(helix.share, +(123 / 127).toFixed(3));
  assert.equal(byOrigin.rows.find(r => r.key === 'system:dream').cpuSeconds, 40);
  assert.equal(L.cardLedger({ days: 1, by: 'kind' }).rows[0].key, 'motion');
  assert.equal(L.cardLedger({ days: 1, by: 'machine' }).rows.find(r => r.key === 'home').uses, 2);
  assert.deepEqual(L.jobCardSeconds('look-1234'), { gpuSeconds: 123, cpuSeconds: 0, uses: 2 });
  assert.equal(L.recordCard({ machine: '', kind: 'x', seconds: 1 }), undefined, 'a bad row is dropped, never thrown');
});

test('the budget counts an agent\'s media card time only, and refuses that agent — not the operator', async () => {
  clear();
  const allowance = L.AGENT_CARD_SECONDS_PER_DAY;
  L.recordCard({ machine: 'home', card: 'gpu', kind: 'model', seconds: allowance * 2, origin: 'agent:ariadne' });   // thinking is not media
  L.recordCard({ machine: 'kvm2', card: 'cpu', kind: 'render', seconds: allowance * 2, origin: 'agent:ariadne' });  // nor CPU time
  assert.equal(L.agentCardSeconds('ariadne'), 0);
  L.recordCard({ machine: 'home', card: 'gpu', kind: 'paint', seconds: allowance - 10, origin: 'agent:ariadne' });
  await L.withOrigin({ origin: 'agent:ariadne' }, async () => L.assertCardBudget());               // still under
  L.recordCard({ machine: 'home', card: 'gpu', kind: 'motion', seconds: 30, origin: 'agent:ariadne' });
  await L.withOrigin({ origin: 'agent:ariadne' }, async () => assert.throws(() => L.assertCardBudget(), e => e.status === 429 && e.code === 'card_budget'));
  await L.withOrigin({ origin: 'api' }, async () => L.assertCardBudget());                         // the operator is never refused
  assert.equal(L.cardBudgets().agents.find(a => a.agent === 'ariadne').left, 0);
});

test('a model-pool call is charged to the agent that made it, for the time of the call itself', async () => {
  clear();
  const { runOnPool } = await import('../server/intelligence/model-pool.js');
  const out = await L.withOrigin({ origin: 'agent:helix' }, () => runOnPool({ label: 'agent: test call', timeoutMs: 5000 }, async () => { await sleep(60); return 'ok'; }));
  assert.equal(out, 'ok');
  const row = db.prepare('SELECT * FROM card_ledger').get();
  assert.equal(row.origin, 'agent:helix'); assert.equal(row.kind, 'model'); assert.equal(row.label, 'agent: test call');
  assert.ok(row.seconds >= 0.05 && row.seconds < 2, `${row.seconds} s`);
  // a failed call is charged too, marked not ok
  await assert.rejects(L.withOrigin({ origin: 'agent:helix' }, () => runOnPool({ label: 'agent: failing' }, async () => { throw new Error('boom'); })));
  assert.equal(db.prepare('SELECT ok FROM card_ledger WHERE label = ?').get('agent: failing').ok, 0);
});

test('the history already recorded is read in once: worker receipts and leases, the agent of a Make job found', () => {
  clear();
  db.exec(`CREATE TABLE IF NOT EXISTS worker_jobs (id TEXT PRIMARY KEY, worker TEXT, kind TEXT, state TEXT, digest TEXT, receipt TEXT, error TEXT, purpose TEXT, seconds REAL, created_at INTEGER, completed_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS gpu_leases (id TEXT PRIMARY KEY, owner TEXT, purpose TEXT, status TEXT, vram_before_mb INTEGER, vram_after_mb INTEGER, unloaded TEXT, release_reason TEXT, acquired_at INTEGER, released_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS creation_jobs (id TEXT PRIMARY KEY, request TEXT, kind TEXT, style TEXT, status TEXT, stage TEXT, progress REAL, plan TEXT, script TEXT, title TEXT, output TEXT, error TEXT, source TEXT, agent_id TEXT, seconds REAL, created_at INTEGER, started_at INTEGER, completed_at INTEGER)`);
  db.prepare('DELETE FROM worker_jobs').run(); db.prepare('DELETE FROM gpu_leases').run();
  db.prepare(`INSERT OR REPLACE INTO creation_jobs (id, request, status, source, agent_id, created_at) VALUES ('make-abc123', 'a film', 'completed', 'agent', 'director', 1)`).run();
  const t = Date.now();
  db.prepare(`INSERT INTO worker_jobs (id, worker, kind, state, receipt, purpose, seconds, created_at, completed_at) VALUES (?, 'home', 'i2v', 'done', ?, 'motion: x', 140, ?, ?)`).run('look-9-i2v', JSON.stringify({ seconds: 123.5 }), t, t);
  db.prepare(`INSERT INTO worker_jobs (id, worker, kind, state, receipt, purpose, seconds, created_at, completed_at) VALUES (?, 'home', 'stills', 'done', ?, 'backdrops', 30, ?, ?)`).run('make-abc123-stills', JSON.stringify({ seconds: 25 }), t, t);
  db.prepare(`INSERT INTO worker_jobs (id, worker, kind, state, purpose, seconds, created_at, completed_at) VALUES ('look-8-matte', 'home', 'matte', 'error', 'matte', 2, ?, ?)`).run(t, t);
  db.prepare(`INSERT INTO gpu_leases (id, owner, purpose, status, acquired_at, released_at) VALUES ('gpu-1', 'studio', 'backdrops for make-abc123 (1)', 'released', ?, ?)`).run(t - 60_000, t);
  assert.equal(L.backfillCardLedger(), 4);
  assert.equal(L.backfillCardLedger(), 0, 'a second run adds nothing');
  const rows = Object.fromEntries(db.prepare('SELECT job, kind, card, seconds, origin, ok FROM card_ledger').all().map(r => [r.job, r]));
  assert.deepEqual([rows['look-9-i2v'].kind, rows['look-9-i2v'].card, rows['look-9-i2v'].seconds], ['motion', 'gpu', 123.5], 'the worker\'s receipt time, not the hub\'s 140 s');
  assert.equal(rows['make-abc123-stills'].origin, 'agent:director');
  assert.deepEqual([rows['look-8-matte'].card, rows['look-8-matte'].ok], ['cpu', 0]);
  assert.deepEqual([rows['gpu-1'].kind, rows['gpu-1'].seconds, rows['gpu-1'].origin], ['lease', 60, 'agent:director']);
});
