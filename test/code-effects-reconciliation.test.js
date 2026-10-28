import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCodeEffectStore } from '../server/agent/code-effects.js';
import { hash, stableJson } from '../server/agent/schema.js';

const CID = 'a'.repeat(64), IMAGE = 'sha256:' + 'b'.repeat(64);
const input = extra => ({ runId: 'owner', callId: 'owned-call', engine: 'docker', language: 'python', argsHash: hash('not-stored-source'), ...extra });
const binding = ticket => ({ version: 1, engine: 'docker', executionId: ticket.executionId, endpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
  daemonId: 'owned-daemon-id', name: 'fraymus-code-' + ticket.executionId, image: IMAGE });
const uncertain = () => ({ outcome: 'unknown', dispatchAttempted: true, codeMayHaveRun: true, isolationVerified: false,
  termination: 'interrupted_unknown', cleanup: { confirmed: false }, proof: { originalFact: 'retained' }, exitCode: null, errorCode: 'interrupted' });
const finished = () => ({ outcome: 'finished', dispatchAttempted: true, codeMayHaveRun: true, isolationVerified: true,
  termination: 'exit', cleanup: { confirmed: true, removed: true }, exitCode: 0 });
const proof = resource => ({ confirmed: true, endpoint: resource.endpoint, daemonId: resource.daemonId, name: resource.name,
  containerId: resource.containerId, checks: 2, observedAt: Date.now() });
function initialize(db) {
  db.exec('CREATE TABLE agent_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,deadline_at INTEGER NOT NULL,usage_json TEXT NOT NULL)');
  db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?)').run('owner', 'running', Date.now() + 60000, '{"totalTokens":12}');
}
function fixture(t, onReceipt) {
  const db = new DatabaseSync(':memory:'); initialize(db); const events = [];
  const store = createCodeEffectStore({ db, onReceipt: onReceipt ?? ((runId, receipt) => events.push({ runId, receipt })) });
  t.after(() => db.close());
  const ticket = store.begin(input()), plan = binding(ticket);
  const ready = ({ witness = true, resource = true, terminal = true } = {}) => {
    store.dispatch(ticket);
    if (resource) store.recordResource(ticket, plan);
    if (resource && witness) store.recordResource(ticket, { ...plan, containerId: CID });
    store.settle(ticket, uncertain());
    if (terminal) db.prepare("UPDATE agent_runs SET status='failed'").run();
    return store.get(ticket.executionId);
  };
  return { db, store, ticket, plan, ready, events, row: () => db.prepare('SELECT * FROM agent_code_effects').get() };
}

test('resource binding is silent, FULL, canonical, immutable and upgrades only once to an exact running witness', t => {
  const f = fixture(t);
  assert.equal(f.store.get(f.ticket.executionId).resource, null);
  assert.throws(() => f.store.recordResource(f.ticket, f.plan), { code: 'code_resource_state' }); f.store.dispatch(f.ticket);
  assert.throws(() => f.store.recordResource(f.ticket, { ...f.plan, containerId: CID }), { code: 'code_resource_conflict' });
  const planned = f.store.recordResource(f.ticket, f.plan);
  assert.deepEqual(planned.resource, f.plan); assert.equal(f.row().resource_json, stableJson(f.plan)); assert.equal(Object.isFrozen(planned.resource), true);
  assert.deepEqual(f.store.recordResource(f.ticket, f.plan), planned); assert.equal(f.events.length, 0);
  for (const changed of [{ ...f.plan, daemonId: 'different' }, { ...f.plan, image: 'sha256:' + 'c'.repeat(64) }])
    assert.throws(() => f.store.recordResource(f.ticket, changed), { code: 'code_resource_conflict' });
  const witnessed = { ...f.plan, containerId: CID }; f.store.recordResource(f.ticket, witnessed);
  assert.deepEqual(f.store.recordResource(f.ticket, witnessed).resource, witnessed);
  assert.throws(() => f.store.recordResource(f.ticket, f.plan), { code: 'code_resource_conflict' });
  assert.throws(() => f.store.recordResource(f.ticket, { ...witnessed, containerId: 'd'.repeat(64) }), { code: 'code_resource_conflict' });
  f.store.settle(f.ticket, uncertain()); assert.throws(() => f.store.recordResource(f.ticket, witnessed), { code: 'code_resource_state' });
});

test('resource metadata rejects remote endpoints, cross-ticket identities, extra fields and noncanonical stored corruption', t => {
  const f = fixture(t); f.store.dispatch(f.ticket);
  for (const invalid of [{ ...f.plan, executionId: randomUUID() }, { ...f.plan, name: 'other-resource' }, { ...f.plan, version: 2 },
    { ...f.plan, endpoint: 'tcp://example.com:2375' }, { ...f.plan, image: 'python:latest' }, { ...f.plan, label: 'unbound' }])
    assert.throws(() => f.store.recordResource(f.ticket, invalid));
  assert.equal(f.row().resource_json, null); f.store.recordResource(f.ticket, f.plan);
  const saved = f.row().resource_json;
  for (const invalid of ['invalid JSON', 'x'.repeat(5000), stableJson({ ...f.plan, executionId: randomUUID() }), JSON.stringify(Object.fromEntries(Object.entries(f.plan).reverse()))]) {
    f.db.prepare('UPDATE agent_code_effects SET resource_json=?').run(invalid);
    assert.throws(() => f.store.get(f.ticket.executionId), { code: 'code_effect_corrupt' });
    f.db.prepare('UPDATE agent_code_effects SET resource_json=?').run(saved);
  }
});

test('resource journal refuses NORMAL and silently ignored resource writes before publishing a witness', t => {
  const f = fixture(t); f.store.dispatch(f.ticket); f.db.exec('PRAGMA synchronous=NORMAL');
  assert.throws(() => f.store.recordResource(f.ticket, f.plan), { code: 'workspace_journal_not_durable' }); assert.equal(f.row().resource_json, null);
  f.db.exec('PRAGMA synchronous=FULL');
  f.db.exec('CREATE TRIGGER ignore_owned_resource BEFORE UPDATE OF resource_json ON agent_code_effects BEGIN SELECT RAISE(IGNORE); END');
  assert.throws(() => f.store.recordResource(f.ticket, f.plan), { code: 'code_effect_write' }); assert.equal(f.row().resource_json, null);
  f.db.exec('DROP TRIGGER ignore_owned_resource'); f.store.recordResource(f.ticket, f.plan);
  assert.equal(f.events.length, 0);
});

test('legacy nullable migration preserves existing rows and leaves old unwitnessed executions quarantined', t => {
  const db = new DatabaseSync(':memory:'); initialize(db); t.after(() => db.close());
  db.exec(`CREATE TABLE agent_code_effects(id TEXT PRIMARY KEY,run_id TEXT,call_id TEXT,engine TEXT,language TEXT,args_hash TEXT,status TEXT,
    dispatch_attempted INTEGER DEFAULT 0,receipt_json TEXT,receipt_version INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER,notified_at INTEGER,UNIQUE(run_id,call_id))`);
  const id = randomUUID();
  db.prepare("INSERT INTO agent_code_effects(id,run_id,call_id,engine,language,args_hash,status,dispatch_attempted,created_at,updated_at) VALUES(?,'owner','legacy','docker','python',?,'dispatching',1,1,1)")
    .run(id, input().argsHash);
  const store = createCodeEffectStore({ db }); assert.equal(store.get(id).resource, null); store.recover();
  assert.equal(store.get(id).receipt.outcome, 'unknown'); assert.equal(store.quarantined('docker').length, 1);
  assert.ok(db.prepare('PRAGMA table_info(agent_code_effects)').all().some(column => column.name === 'resource_json'));
});

test('lost-ticket reconciliation confirms only cleanup and preserves the unknown execution, termination, isolation and proof', async t => {
  const f = fixture(t), before = f.ready();
  const restarted = createCodeEffectStore({ db: f.db, onReceipt: (runId, receipt) => f.events.push({ runId, receipt }) });
  assert.throws(() => restarted.settle(f.ticket, finished()), { code: 'code_effect_ticket' });
  let observed = false;
  const receipt = await restarted.reconcileCleanup(f.ticket.executionId, (resource, { signal }) => {
    observed = true; assert.equal(Object.isFrozen(resource), true); assert.equal(signal.aborted, false);
    assert.deepEqual(resource, before.resource); assert.throws(() => { resource.containerId = 'bad'; }, TypeError); return proof(resource);
  });
  assert.equal(observed, true); assert.equal(receipt.outcome, 'unknown'); assert.equal(receipt.complete, true);
  for (const key of ['effectId', 'engine', 'language', 'dispatchAttempted', 'codeMayHaveRun', 'isolationVerified', 'termination', 'proof', 'exitCode', 'errorCode'])
    assert.deepEqual(receipt[key], before.receipt[key], key + ' is preserved');
  assert.deepEqual(receipt.cleanup, { confirmed: true, verifiedAbsent: true, name: before.resource.name, containerId: CID, reconciled: true });
  assert.equal(receipt.cleanup.removed, undefined); assert.equal(receipt.cleanupReconciliation.checks, 2);
  assert.equal(receipt.cleanupReconciliation.previousReceiptVersion, 1); assert.equal(receipt.cleanupReconciliation.method, 'observed_absence');
  assert.equal(restarted.quarantined('docker').length, 0); assert.equal(restarted.get(f.ticket.executionId).status, 'unknown');
  assert.equal(f.db.prepare('SELECT status FROM agent_runs').get().status, 'failed'); assert.equal(f.db.prepare('SELECT usage_json FROM agent_runs').get().usage_json, '{"totalTokens":12}');
  assert.equal(f.row().receipt_version, 2); assert.equal(f.events.length, 2); assert.equal(Object.isFrozen(receipt.cleanupReconciliation), true);
});

test('conclusive operator observation also clears the same store runtime quarantine left by a failed settlement', async t => {
  const f = fixture(t); f.store.dispatch(f.ticket); f.store.recordResource(f.ticket, f.plan); f.store.recordResource(f.ticket, { ...f.plan, containerId: CID });
  assert.throws(() => f.store.settle(f.ticket, { ...finished(), stdout: 'invalid independent payload' }), { code: 'code_effect_receipt' });
  assert.equal(f.store.quarantined('docker').length, 1); f.db.prepare("UPDATE agent_runs SET status='cancelled'").run(); f.store.recover();
  assert.equal(f.store.quarantined('docker').length, 1);
  const receipt = await f.store.reconcileCleanup(f.ticket.executionId, resource => proof(resource));
  assert.equal(receipt.outcome, 'unknown'); assert.equal(receipt.cleanup.confirmed, true); assert.equal(f.store.quarantined('docker').length, 0);
});

test('missing witnesses, active source runs and already-conclusive outcomes never invoke the observer', async t => {
  for (const options of [{ resource: false }, { witness: false }, { terminal: false }]) {
    const f = fixture(t); f.ready(options); let calls = 0;
    await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, () => { calls++; return {}; }), caught => ['code_reconciliation_unavailable', 'code_reconciliation_inactive'].includes(caught.code));
    assert.equal(calls, 0); assert.equal(f.store.quarantined('docker').length, 1);
  }
  const f = fixture(t); f.ready(); await f.store.reconcileCleanup(f.ticket.executionId, resource => proof(resource));
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, () => assert.fail('Already clean must not observe')), { code: 'code_reconciliation_unavailable' });
});

test('strict absence proof rejects one check, daemon/name/id changes, extra fields and stale/future timestamps without clearing quarantine', async t => {
  const f = fixture(t); f.ready();
  const changes = [{ confirmed: false }, { checks: 1 }, { checks: 3 }, { daemonId: 'other-daemon' }, { endpoint: 'npipe:////./pipe/docker_engine' },
    { name: 'other-name' }, { containerId: 'f'.repeat(64) }, { removed: true }, { observedAt: 0 }, { observedAt: 1.5 }, { observedAt: Number.MAX_SAFE_INTEGER }];
  for (const changed of changes) {
    await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, resource => ({ ...proof(resource), ...changed })), { code: 'code_reconciliation_proof' });
    assert.equal(f.store.quarantined('docker').length, 1); assert.equal(f.row().receipt_version, 1); assert.equal(f.events.length, 1);
  }
});

test('source revival or receipt changes during observation invalidate the exact operator snapshot', async t => {
  const f = fixture(t); f.ready();
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, resource => {
    f.db.prepare("UPDATE agent_runs SET status='running'").run(); return proof(resource);
  }), { code: 'code_reconciliation_inactive' });
  assert.equal(f.store.quarantined('docker').length, 1); f.db.prepare("UPDATE agent_runs SET status='cancelled'").run();
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, resource => { f.store.settle(f.ticket, finished()); return proof(resource); }), { code: 'code_reconciliation_conflict' });
  assert.equal(f.store.get(f.ticket.executionId).receipt.outcome, 'finished'); assert.equal(f.events.length, 2);
});

test('two concurrent observations cannot overwrite the first conclusive receipt or emit duplicate reconciliation', async t => {
  const f = fixture(t); f.ready(); let one, two;
  const first = f.store.reconcileCleanup(f.ticket.executionId, resource => new Promise(resolve => { one = () => resolve(proof(resource)); }));
  const second = f.store.reconcileCleanup(f.ticket.executionId, resource => new Promise(resolve => { two = () => resolve(proof(resource)); }));
  await Promise.resolve(); one(); const receipt = await first; two();
  await assert.rejects(second, { code: 'code_reconciliation_conflict' });
  assert.equal(receipt.outcome, 'unknown'); assert.equal(f.row().receipt_version, 2); assert.equal(f.events.length, 2);
});

test('FULL is checked before observation and again immediately before the reconciliation commit', async t => {
  const f = fixture(t); f.ready(); f.db.exec('PRAGMA synchronous=NORMAL');
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, () => assert.fail('Unsafe journal must not observe')), { code: 'workspace_journal_not_durable' });
  f.db.exec('PRAGMA synchronous=FULL');
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, resource => { f.db.exec('PRAGMA synchronous=NORMAL'); return proof(resource); }), { code: 'workspace_journal_not_durable' });
  assert.equal(f.store.quarantined('docker').length, 1); assert.equal(f.row().receipt_version, 1);
});

test('observer failure or timeout never schedules a late database write, and timeout aborts the trusted observer', async t => {
  const f = fixture(t); f.ready();
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, () => { throw new Error('Owned probe failure'); }), /Owned probe failure/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let finish, observerSignal;
  const operation = f.store.reconcileCleanup(f.ticket.executionId, (resource, { signal }) => { observerSignal = signal; return new Promise(resolve => { finish = () => resolve(proof(resource)); }); });
  await Promise.resolve(); t.mock.timers.tick(15001);
  await assert.rejects(operation, { code: 'code_reconciliation_timeout' }); assert.equal(observerSignal.aborted, true);
  finish(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.row().receipt_version, 1); assert.equal(f.store.quarantined('docker').length, 1); assert.equal(f.events.length, 1);
});

test('resource/reconciliation corruption cannot forge a different witness or bypass canonical history validation', async t => {
  const f = fixture(t); f.ready(); await f.store.reconcileCleanup(f.ticket.executionId, resource => proof(resource));
  const row = f.row(), receipt = JSON.parse(row.receipt_json), originalResource = row.resource_json;
  for (const mutate of [
    () => f.db.prepare('UPDATE agent_code_effects SET resource_json=?').run(stableJson({ ...f.plan, containerId: 'e'.repeat(64) })),
    () => f.db.prepare('UPDATE agent_code_effects SET receipt_json=?').run(stableJson({ ...receipt, cleanupReconciliation: { ...receipt.cleanupReconciliation, previousReceiptVersion: 9 } })),
    () => f.db.prepare('UPDATE agent_code_effects SET receipt_json=?').run(stableJson({ ...receipt, cleanup: { ...receipt.cleanup, removed: true } })),
  ]) {
    mutate(); assert.throws(() => f.store.get(f.ticket.executionId), { code: 'code_effect_corrupt' });
    f.db.prepare('UPDATE agent_code_effects SET resource_json=?,receipt_json=?').run(originalResource, row.receipt_json);
  }
});

test('reconciliation write/observer failures retain canonical audit and retry only missing notification', async t => {
  const f = fixture(t); f.ready();
  f.db.exec("CREATE TRIGGER ignore_owned_reconcile BEFORE UPDATE OF receipt_json ON agent_code_effects BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(f.store.reconcileCleanup(f.ticket.executionId, resource => proof(resource)), { code: 'code_effect_write' });
  assert.equal(f.store.quarantined('docker').length, 1); f.db.exec('DROP TRIGGER ignore_owned_reconcile');
  const restarted = createCodeEffectStore({ db: f.db, onReceipt: (_runId, receipt) => { assert.throws(() => { receipt.cleanup.confirmed = false; }, TypeError); throw new Error('Owned ack failure'); } });
  const receipt = await restarted.reconcileCleanup(f.ticket.executionId, resource => proof(resource));
  assert.equal(receipt.cleanup.confirmed, true); assert.equal(f.row().notified_at, null);
  const seen = [], recovery = createCodeEffectStore({ db: f.db, onReceipt: (_runId, value) => seen.push(value) });
  recovery.recover(); assert.equal(seen.length, 1); assert.deepEqual(seen[0], receipt); recovery.recover(); assert.equal(seen.length, 1);
});

test('a witnessed identity survives actual SQLite reopen and permits observed cleanup without minting a lost execution ticket', async t => {
  const parent = await fs.realpath(os.tmpdir()), folder = await fs.mkdtemp(path.join(parent, 'chandra-reconcile-')), original = await fs.realpath(folder), file = path.join(folder, 'journal.sqlite');
  let db = new DatabaseSync(file);
  t.after(async () => { db.close(); const actual = await fs.realpath(folder); assert.equal(actual, original); assert.equal(path.dirname(actual), parent); assert.ok(path.basename(actual).startsWith('chandra-reconcile-'));
    for (const suffix of ['', '-wal', '-shm', '-journal']) await fs.unlink(file + suffix).catch(caught => { if (caught.code !== 'ENOENT') throw caught; }); await fs.rmdir(actual); });
  initialize(db); const first = createCodeEffectStore({ db }), ticket = first.begin(input()), plan = binding(ticket);
  first.dispatch(ticket); first.recordResource(ticket, plan); first.recordResource(ticket, { ...plan, containerId: CID });
  db.prepare("UPDATE agent_runs SET status='cancelled'").run(); db.close(); db = new DatabaseSync(file);
  const restarted = createCodeEffectStore({ db }); restarted.recover();
  assert.equal(restarted.get(ticket.executionId).resource.containerId, CID); assert.equal(restarted.quarantined('docker').length, 1);
  const receipt = await restarted.reconcileCleanup(ticket.executionId, resource => proof(resource));
  assert.equal(receipt.outcome, 'unknown'); assert.equal(receipt.codeMayHaveRun, true); assert.equal(receipt.cleanup.confirmed, true);
  assert.equal(restarted.quarantined('docker').length, 0); assert.equal(db.prepare('SELECT status FROM agent_runs').get().status, 'cancelled');
});
