import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuxiliaryBudgetLedger } from '../server/agent/auxiliary-budget.js';

const INITIAL = 1000;
function schema(db) {
  db.exec(`CREATE TABLE agent_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,request_json TEXT NOT NULL,
    usage_json TEXT NOT NULL,deadline_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    output TEXT NOT NULL DEFAULT '',error_json TEXT)`);
}
function insertRun(db, id = 'run-one', maximum = 100) {
  const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12, costUsd: 0.5, reservedCostUsd: 0.25,
    costStatus: 'reserved', customReceipt: { source: 'preserved' } };
  db.prepare('INSERT INTO agent_runs(id,status,request_json,usage_json,deadline_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(id, 'running', JSON.stringify({ budget: { maxTotalTokens: maximum } }), JSON.stringify(usage), INITIAL + 1000, INITIAL);
}
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:'); schema(db); insertRun(db, 'run-one', options.maximum ?? 100);
  const notifications = [], liveChecks = []; let stamp = INITIAL, live = true;
  const ledger = createAuxiliaryBudgetLedger({ db, now: () => stamp,
    assertLiveCall: (runId, callId) => { liveChecks.push({ runId, callId }); return live; },
    onUsage: (runId, usage) => { notifications.push({ runId, usage }); options.onUsage?.(runId, usage, db); } });
  t.after(() => db.close());
  return { db, ledger, notifications, liveChecks,
    reserve: (estimate = 20, extra = {}) => ledger.reserve({ runId: 'run-one', callId: 'call-one', estimatedInputTokens: estimate, kind: 'embedding', ...extra }),
    usage: () => JSON.parse(db.prepare('SELECT usage_json FROM agent_runs WHERE id=?').get('run-one').usage_json),
    status: () => db.prepare('SELECT status FROM agent_runs WHERE id=?').get('run-one').status,
    clock: value => { stamp = value; }, live: value => { live = value; } };
}

test('private frozen tickets reserve durable estimates and settle against current chat/USD usage without double charge', t => {
  const f = fixture(t), ticket = f.reserve();
  assert.equal(Object.isFrozen(ticket), true); assert.deepEqual(Object.keys(ticket), []); assert.equal(JSON.stringify(ticket), '{}');
  assert.deepEqual(f.liveChecks, [{ runId: 'run-one', callId: 'call-one' }]);
  assert.equal(f.usage().auxiliaryInputTokens, 0); assert.equal(f.usage().reservedInputTokens, 20); assert.equal(f.usage().totalTokens, 12);
  assert.equal(f.db.prepare('SELECT status FROM agent_auxiliary_inputs').get().status, 'reserved');
  const concurrent = { ...f.usage(), inputTokens: 15, outputTokens: 5, totalTokens: 20, costUsd: 0.8, reservedCostUsd: 0.6 };
  f.db.prepare('UPDATE agent_runs SET usage_json=? WHERE id=?').run(JSON.stringify(concurrent), 'run-one');
  const settled = f.ledger.settle(ticket, 7);
  assert.equal(settled.overBudget, false); assert.equal(settled.usage.inputTokens, 22); assert.equal(settled.usage.outputTokens, 5);
  assert.equal(settled.usage.totalTokens, 27); assert.equal(settled.usage.auxiliaryInputTokens, 7); assert.equal(settled.usage.reservedInputTokens, 0);
  assert.equal(settled.usage.costUsd, 0.8); assert.equal(settled.usage.reservedCostUsd, 0.6);
  assert.equal(settled.usage.costStatus, 'reserved'); assert.deepEqual(settled.usage.customReceipt, { source: 'preserved' });
  const events = f.notifications.length; assert.deepEqual(f.ledger.settle(ticket, 7), settled); assert.equal(f.notifications.length, events);
  assert.throws(() => f.ledger.settle(ticket, 8), { code: 'auxiliary_settlement_conflict' });
  assert.deepEqual(f.ledger.unknown(ticket), settled); assert.equal(f.usage().reservedInputTokens, 0);
  assert.equal(Object.isFrozen(settled.usage), true); assert.equal(Object.isFrozen(settled.usage.customReceipt), true);
});

test('all outstanding and unknown holds gate reservations; actual overage is persisted unclamped', t => {
  const f = fixture(t), first = f.reserve(80);
  assert.throws(() => f.reserve(9, { callId: 'second' }), { code: 'budget_tokens' });
  const second = f.reserve(8, { callId: 'second' }); f.ledger.unknown(first);
  assert.equal(f.usage().reservedInputTokens, 88); assert.equal(f.usage().totalTokens, 12);
  assert.throws(() => f.reserve(1, { callId: 'third' }), { code: 'budget_tokens' });
  const actual = f.ledger.settle(first, 90);
  assert.equal(actual.overBudget, true); assert.equal(actual.usage.totalTokens, 102); assert.equal(actual.usage.inputTokens, 100);
  assert.equal(actual.usage.auxiliaryInputTokens, 90); assert.equal(actual.usage.reservedInputTokens, 8);
  assert.throws(() => f.reserve(1), { code: 'budget_tokens' });
  const last = f.ledger.settle(second, 0); assert.equal(last.overBudget, true); assert.equal(last.usage.totalTokens, 102);
  assert.equal(last.usage.reservedInputTokens, 0); assert.equal(last.usage.auxiliaryInputTokens, 90);
});

test('known non-dispatch can release only its original unambiguous reservation, never an unknown or settled request', t => {
  const f = fixture(t), released = f.reserve();
  const result = f.ledger.notDispatched(released); assert.equal(result.usage.reservedInputTokens, 0);
  assert.equal(result.usage.totalTokens, 12); assert.equal(result.usage.auxiliaryInputTokens, 0);
  assert.deepEqual(f.ledger.notDispatched(released), result); assert.deepEqual(f.ledger.unknown(released), result);
  assert.throws(() => f.ledger.settle(released, 1), { code: 'auxiliary_settlement_conflict' });
  const uncertain = f.reserve(); f.ledger.unknown(uncertain);
  assert.throws(() => f.ledger.notDispatched(uncertain), { code: 'auxiliary_dispatch_unknown' });
  assert.equal(f.usage().reservedInputTokens, 20); const settled = f.ledger.settle(uncertain, 4);
  assert.throws(() => f.ledger.notDispatched(uncertain), { code: 'auxiliary_dispatch_unknown' });
  assert.deepEqual(f.ledger.unknown(uncertain), settled); assert.equal(f.usage().totalTokens, 16);
});

test('late settlement after source cancellation preserves terminal state and latest usage fields', t => {
  const f = fixture(t), ticket = f.reserve(30);
  f.db.prepare("UPDATE agent_runs SET status='cancelled',output='preserved output',error_json=? WHERE id=?")
    .run(JSON.stringify({ code: 'cancelled', message: 'Preserved reason' }), 'run-one');
  f.live(false); f.ledger.unknown(ticket);
  const result = f.ledger.settle(ticket, 11); assert.equal(result.usage.totalTokens, 23); assert.equal(result.usage.reservedInputTokens, 0);
  const row = f.db.prepare('SELECT * FROM agent_runs').get();
  assert.equal(row.status, 'cancelled'); assert.equal(row.output, 'preserved output'); assert.equal(JSON.parse(row.error_json).code, 'cancelled');
  assert.throws(() => f.reserve(), { code: 'run_inactive' }); assert.equal(f.notifications.at(-1).usage.totalTokens, 23);
});

test('reservation requires an active unexpired live call and cannot accept an asynchronous guard', t => {
  const f = fixture(t);
  f.live(false); assert.throws(() => f.reserve(), { code: 'auxiliary_call_inactive' });
  f.live(Promise.resolve(true)); assert.throws(() => f.reserve(), { code: 'auxiliary_call_inactive' });
  f.live(true); f.clock(INITIAL + 1000); assert.throws(() => f.reserve(), { code: 'budget_duration' });
  f.clock(INITIAL);
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    f.db.prepare('UPDATE agent_runs SET status=?').run(status); assert.throws(() => f.reserve(), { code: 'run_inactive' });
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_auxiliary_inputs').get().n, 0); assert.equal(f.notifications.length, 0);
});

test('tickets cannot be serialized, fabricated, transferred across ledgers or applied after durable owner tampering', t => {
  const f = fixture(t), ticket = f.reserve();
  const other = createAuxiliaryBudgetLedger({ db: f.db, now: () => INITIAL, assertLiveCall: () => true });
  for (const fake of [{}, JSON.parse(JSON.stringify(ticket)), null, 'ticket']) assert.throws(() => f.ledger.settle(fake, 2), { code: 'auxiliary_ticket_invalid' });
  assert.throws(() => other.settle(ticket, 2), { code: 'auxiliary_ticket_invalid' });
  assert.equal(f.db.prepare('SELECT status FROM agent_auxiliary_inputs').get().status, 'unknown');
  assert.equal(f.ledger.settle(ticket, 2).usage.totalTokens, 14);
  const next = f.reserve(); f.db.prepare("UPDATE agent_auxiliary_inputs SET call_id='foreign' WHERE status='reserved'").run();
  assert.throws(() => f.ledger.settle(next, 2), { code: 'auxiliary_ticket_invalid' });
});

test('counts and kinds are strictly bounded while actual billion-token overage remains truthful', t => {
  const f = fixture(t);
  for (const estimate of [0, -1, 1.5, NaN, Infinity, 1_000_000_001]) assert.throws(() => f.reserve(estimate), { code: 'invalid_auxiliary_input' });
  for (const extra of [{ kind: 'chat' }, { runId: 'invalid/id' }, { callId: '' }, { modelArgument: true }]) assert.throws(() => f.reserve(1, extra), { code: 'invalid_auxiliary_input' });
  const ticket = f.reserve(1);
  for (const actual of [-1, 1.5, NaN, Infinity, 1_000_000_001]) assert.throws(() => f.ledger.settle(ticket, actual), { code: 'invalid_auxiliary_input' });
  assert.equal(f.usage().reservedInputTokens, 1);
  const result = f.ledger.settle(ticket, 1_000_000_000); assert.equal(result.usage.auxiliaryInputTokens, 1_000_000_000);
  assert.equal(result.usage.totalTokens, 1_000_000_012); assert.equal(result.overBudget, true);
});

test('usage observers run after durable commit and cannot undo settlement or mutate its snapshot', t => {
  const observations = [];
  const f = fixture(t, { onUsage: (_runId, usage, db) => {
    const saved = JSON.parse(db.prepare('SELECT usage_json FROM agent_runs').get().usage_json);
    let outsideTransaction = false;
    try { db.exec('BEGIN IMMEDIATE'); outsideTransaction = true; db.exec('ROLLBACK'); } catch {}
    observations.push({ saved, snapshot: usage, frozen: Object.isFrozen(usage), outsideTransaction });
    throw new Error('Owned observer failure');
  } });
  const ticket = f.reserve(); assert.equal(f.usage().reservedInputTokens, 20);
  assert.equal(f.ledger.settle(ticket, 4).usage.totalTokens, 16);
  assert.equal(f.usage().auxiliaryInputTokens, 4); assert.equal(f.db.prepare('SELECT status FROM agent_auxiliary_inputs').get().status, 'settled');
  assert.equal(observations.length, 2);
  for (const observation of observations) {
    assert.deepEqual(observation.saved, observation.snapshot); assert.equal(observation.frozen, true); assert.equal(observation.outsideTransaction, true);
  }
});

test('reservations and actual deltas stay isolated between distinct owner runs', t => {
  const f = fixture(t); insertRun(f.db, 'run-two', 50);
  const first = f.reserve(40), second = f.reserve(38, { runId: 'run-two', callId: 'other-call' });
  assert.equal(f.usage().reservedInputTokens, 40);
  assert.equal(JSON.parse(f.db.prepare('SELECT usage_json FROM agent_runs WHERE id=?').get('run-two').usage_json).reservedInputTokens, 38);
  f.ledger.settle(first, 10);
  const ownerTwo = f.ledger.settle(second, 6);
  assert.equal(f.usage().totalTokens, 22); assert.equal(f.usage().auxiliaryInputTokens, 10);
  assert.equal(ownerTwo.usage.totalTokens, 18); assert.equal(ownerTwo.usage.auxiliaryInputTokens, 6); assert.equal(ownerTwo.usage.reservedInputTokens, 0);
});

test('reopening SQLite marks previous reservations unknown without refunding their token holds', async t => {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), directory = await fs.mkdtemp(path.join(parent, 'auxiliary-ledger-'));
  const original = await fs.realpath(directory), filename = path.join(directory, 'ledger.sqlite'); let db;
  try {
    db = new DatabaseSync(filename); schema(db); insertRun(db);
    const before = createAuxiliaryBudgetLedger({ db, now: () => INITIAL, assertLiveCall: () => {} });
    before.reserve({ runId: 'run-one', callId: 'call-one', estimatedInputTokens: 20, kind: 'embedding' }); db.close();
    db = new DatabaseSync(filename); const notifications = [];
    createAuxiliaryBudgetLedger({ db, now: () => INITIAL + 1, assertLiveCall: () => true, onUsage: (runId, usage) => notifications.push({ runId, usage }) });
    assert.equal(db.prepare('SELECT status FROM agent_auxiliary_inputs').get().status, 'unknown');
    const usage = JSON.parse(db.prepare('SELECT usage_json FROM agent_runs').get().usage_json);
    assert.equal(usage.reservedInputTokens, 20); assert.equal(usage.totalTokens, 12); assert.equal(usage.auxiliaryInputTokens, 0);
    assert.equal(notifications.length, 1); assert.equal(notifications[0].runId, 'run-one'); assert.equal(notifications[0].usage.reservedInputTokens, 20);
  } finally {
    db?.close(); const target = await fs.realpath(directory); assert.equal(target, original); assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('auxiliary-ledger-')); await fs.rm(target, { recursive: true, force: true });
  }
});
