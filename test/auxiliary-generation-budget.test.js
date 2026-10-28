import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuxiliaryBudgetLedger } from '../server/agent/auxiliary-budget.js';

const STAMP = 1000;
function initializeRun(db, budget = {}) {
  db.exec('CREATE TABLE agent_runs(id TEXT PRIMARY KEY,status TEXT,request_json TEXT,usage_json TEXT,deadline_at INTEGER,updated_at INTEGER,output TEXT,error_json TEXT)');
  const limits = { maxTotalTokens: 200, maxInputTokens: 80, maxOutputTokens: 40, ...budget };
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.25, reservedCostUsd: 0.1, costStatus: 'reserved' };
  db.prepare('INSERT INTO agent_runs VALUES(?,?,?,?,?,?,?,?)').run('owner', 'running', JSON.stringify({ budget: limits }), JSON.stringify(usage), STAMP + 1000, STAMP, 'preserved output', null);
}
function fixture(t, budget = {}) {
  const db = new DatabaseSync(':memory:'); initializeRun(db, budget); const notifications = [];
  const ledger = createAuxiliaryBudgetLedger({ db, now: () => STAMP, assertLiveCall: (runId, callId) => {
    assert.equal(runId, 'owner'); assert.ok(callId.startsWith('call-'));
  }, onUsage: (runId, usage) => notifications.push({ runId, usage }) });
  t.after(() => db.close());
  return { db, ledger, notifications,
    embed: estimate => ledger.reserve({ runId: 'owner', callId: 'call-embedding', kind: 'embedding', estimatedInputTokens: estimate }),
    generation: (input = 20, output = 15, extra = {}) => ledger.reserveGeneration({ runId: 'owner', callId: 'call-vision', kind: 'vision', estimatedInputTokens: input, maxOutputTokens: output, ...extra }),
    usage: () => JSON.parse(db.prepare('SELECT usage_json FROM agent_runs').get().usage_json) };
}

test('generation and embedding actuals share aggregates while preserving concurrent chat counters and USD fields', t => {
  const f = fixture(t), embedding = f.embed(10), vision = f.generation();
  assert.equal(Object.isFrozen(vision), true); assert.deepEqual(Object.keys(vision), []); assert.equal(JSON.stringify(vision), '{}');
  assert.equal(f.usage().reservedInputTokens, 30); assert.equal(f.usage().reservedOutputTokens, 15); assert.equal(f.usage().auxiliaryUsageKnown, false);
  f.ledger.settle(embedding, 7);
  const concurrent = { ...f.usage(), inputTokens: 20, outputTokens: 7, totalTokens: 27, costUsd: 0.4, reservedCostUsd: 0.2 };
  f.db.prepare('UPDATE agent_runs SET usage_json=?').run(JSON.stringify(concurrent));
  const settled = f.ledger.settleGeneration(vision, { inputTokens: 18, outputTokens: 6 });
  assert.equal(settled.overBudget, false); assert.equal(settled.usage.inputTokens, 38); assert.equal(settled.usage.outputTokens, 13);
  assert.equal(settled.usage.totalTokens, 51); assert.equal(settled.usage.auxiliaryInputTokens, 25); assert.equal(settled.usage.auxiliaryOutputTokens, 6);
  assert.equal(settled.usage.reservedInputTokens, 0); assert.equal(settled.usage.reservedOutputTokens, 0); assert.equal(settled.usage.auxiliaryUsageKnown, true);
  assert.equal(settled.usage.costUsd, 0.4); assert.equal(settled.usage.reservedCostUsd, 0.2); assert.equal(settled.usage.costStatus, 'reserved');
  const count = f.notifications.length;
  assert.deepEqual(f.ledger.settleGeneration(vision, { inputTokens: 18, outputTokens: 6 }), settled); assert.equal(f.notifications.length, count);
  assert.throws(() => f.ledger.settleGeneration(vision, { inputTokens: 19, outputTokens: 6 }), { code: 'auxiliary_settlement_conflict' });
  assert.throws(() => f.ledger.settleGeneration(vision, { inputTokens: 18, outputTokens: 7 }), { code: 'auxiliary_settlement_conflict' });
  assert.deepEqual(f.ledger.unknown(vision), settled);
});

test('embedding reservations include outstanding generation output and unknown holds', t => {
  const f = fixture(t, { maxTotalTokens: 60 }), vision = f.generation(10, 20), embedding = f.embed(15);
  assert.equal(f.usage().totalTokens, 15); assert.equal(f.usage().reservedInputTokens, 25); assert.equal(f.usage().reservedOutputTokens, 20);
  assert.throws(() => f.embed(1), { code: 'budget_tokens' }); assert.throws(() => f.generation(1, 1), { code: 'budget_tokens' });
  f.ledger.unknown(vision); f.ledger.notDispatched(embedding);
  assert.equal(f.usage().reservedInputTokens, 10); assert.equal(f.usage().reservedOutputTokens, 20);
  assert.throws(() => f.ledger.notDispatched(vision), { code: 'auxiliary_dispatch_unknown' });
  const settled = f.ledger.settleGeneration(vision, { inputTokens: 0, outputTokens: 0 });
  assert.equal(settled.usage.totalTokens, 15); assert.equal(settled.usage.reservedInputTokens, 0); assert.equal(settled.usage.reservedOutputTokens, 0);
  assert.equal(settled.usage.auxiliaryUsageKnown, true); f.ledger.notDispatched(f.embed(45));
});

test('generation output reservations share the cumulative output cap even with ample total budget', t => {
  const f = fixture(t, { maxTotalTokens: 500, maxOutputTokens: 20 }), first = f.generation(10, 10);
  assert.throws(() => f.generation(1, 6), { code: 'budget_tokens' });
  const second = f.generation(1, 5); assert.equal(f.usage().outputTokens + f.usage().reservedOutputTokens, 20);
  const result = f.ledger.settleGeneration(first, { inputTokens: 8, outputTokens: 12 });
  assert.equal(result.overBudget, true); assert.ok(result.usage.totalTokens + result.usage.reservedInputTokens + result.usage.reservedOutputTokens < 500);
  assert.equal(result.usage.outputTokens, 17); assert.equal(result.usage.reservedOutputTokens, 5);
  assert.throws(() => f.embed(1), { code: 'budget_tokens' });
  const known = f.ledger.settleGeneration(second, { inputTokens: 1, outputTokens: 0 });
  assert.equal(known.usage.outputTokens, 17); assert.equal(known.usage.auxiliaryOutputTokens, 12); assert.equal(known.usage.reservedOutputTokens, 0);
});

test('per-generation input estimates obey maxInput while aggregate auxiliary input may exceed it across calls', t => {
  const f = fixture(t, { maxTotalTokens: 500, maxInputTokens: 20 });
  assert.throws(() => f.generation(21, 1), { code: 'budget_context' });
  const first = f.generation(20, 1); f.ledger.settleGeneration(first, { inputTokens: 20, outputTokens: 0 });
  const second = f.generation(20, 1); const result = f.ledger.settleGeneration(second, { inputTokens: 20, outputTokens: 0 });
  assert.equal(result.usage.auxiliaryInputTokens, 40); assert.equal(result.usage.inputTokens, 50); assert.equal(result.overBudget, false);
});

test('generation settlement preserves actual input/output overages unclamped and prevents new work', t => {
  const f = fixture(t), ticket = f.generation(1, 1);
  const result = f.ledger.settleGeneration(ticket, { inputTokens: 1_000_000_000, outputTokens: 1_000_000_000 });
  assert.equal(result.usage.inputTokens, 1_000_000_010); assert.equal(result.usage.outputTokens, 1_000_000_005);
  assert.equal(result.usage.totalTokens, 2_000_000_015); assert.equal(result.usage.auxiliaryOutputTokens, 1_000_000_000);
  assert.equal(result.overBudget, true); assert.throws(() => f.embed(1), { code: 'budget_tokens' });
});

test('both ticket kinds use the same safe non-dispatch/unknown transitions and cannot cross typed settlement methods', t => {
  const f = fixture(t), vision = f.generation(), embedding = f.embed(10);
  assert.throws(() => f.ledger.settle(vision, 1), { code: 'auxiliary_ticket_invalid' });
  assert.throws(() => f.ledger.settleGeneration(embedding, { inputTokens: 1, outputTokens: 1 }), { code: 'auxiliary_ticket_invalid' });
  const released = f.ledger.notDispatched(vision); assert.equal(released.usage.reservedInputTokens, 10); assert.equal(released.usage.reservedOutputTokens, 0);
  assert.deepEqual(f.ledger.notDispatched(vision), released); assert.deepEqual(f.ledger.unknown(vision), released);
  assert.throws(() => f.ledger.settleGeneration(vision, { inputTokens: 0, outputTokens: 0 }), { code: 'auxiliary_settlement_conflict' });
  f.ledger.notDispatched(embedding); const uncertain = f.generation(); f.ledger.unknown(uncertain);
  assert.throws(() => f.ledger.notDispatched(uncertain), { code: 'auxiliary_dispatch_unknown' });
  const actual = f.ledger.settleGeneration(uncertain, { inputTokens: 3, outputTokens: 2 });
  assert.deepEqual(f.ledger.unknown(uncertain), actual); assert.equal(actual.usage.auxiliaryUsageKnown, true);
});

test('late generation input/output settlement preserves a cancelled source and both prior cost fields', t => {
  const f = fixture(t), ticket = f.generation(20, 10);
  f.db.prepare("UPDATE agent_runs SET status='cancelled',error_json=?").run(JSON.stringify({ code: 'cancelled' }));
  f.ledger.unknown(ticket); const result = f.ledger.settleGeneration(ticket, { inputTokens: 8, outputTokens: 4 });
  assert.equal(result.usage.inputTokens, 18); assert.equal(result.usage.outputTokens, 9); assert.equal(result.usage.totalTokens, 27);
  assert.equal(result.usage.costUsd, 0.25); assert.equal(result.usage.reservedCostUsd, 0.1);
  const row = f.db.prepare('SELECT status,output,error_json FROM agent_runs').get(); assert.equal(row.status, 'cancelled');
  assert.equal(row.output, 'preserved output'); assert.equal(JSON.parse(row.error_json).code, 'cancelled');
  assert.throws(() => f.generation(), { code: 'run_inactive' });
});

test('generation bounds, exact actual fields and opaque ticket ownership fail closed', t => {
  const f = fixture(t);
  for (const number of [0, -1, 1.5, NaN, Infinity, 1_000_000_001]) {
    assert.throws(() => f.generation(number, 1), { code: 'invalid_auxiliary_input' });
    assert.throws(() => f.generation(1, number), { code: 'invalid_auxiliary_input' });
  }
  for (const extra of [{ kind: 'embedding' }, { kind: 'chat' }, { runId: 'owner/other' }, { arbitrary: true }]) assert.throws(() => f.generation(1, 1, extra), { code: 'invalid_auxiliary_input' });
  const ticket = f.generation(1, 1);
  for (const actual of [null, {}, { inputTokens: 1 }, { inputTokens: -1, outputTokens: 0 }, { inputTokens: 0, outputTokens: 1.5 },
    { inputTokens: 0, outputTokens: 1_000_000_001 }, { inputTokens: 0, outputTokens: 0, costUsd: 0 }]) {
    assert.throws(() => f.ledger.settleGeneration(ticket, actual), { code: 'invalid_auxiliary_input' });
  }
  assert.throws(() => f.ledger.settleGeneration(JSON.parse(JSON.stringify(ticket)), { inputTokens: 0, outputTokens: 0 }), { code: 'auxiliary_ticket_invalid' });
  assert.equal(f.usage().reservedOutputTokens, 1); assert.equal(f.usage().auxiliaryInputTokens, 0);
});

test('legacy embedding table and counters survive adding generation accounting without schema replacement', t => {
  const db = new DatabaseSync(':memory:'); initializeRun(db, { maxTotalTokens: 500 });
  db.exec(`CREATE TABLE agent_auxiliary_inputs(id TEXT PRIMARY KEY,run_id TEXT,call_id TEXT,kind TEXT,estimated_input_tokens INTEGER,
    actual_input_tokens INTEGER,status TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO agent_auxiliary_inputs VALUES('legacy-known','owner','call-old','embedding',8,3,'settled',1,1);
    INSERT INTO agent_auxiliary_inputs VALUES('legacy-pending','owner','call-old','embedding',11,NULL,'reserved',1,1);`);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_auxiliary_inputs'").get().sql;
  db.prepare('UPDATE agent_runs SET usage_json=?').run(JSON.stringify({ inputTokens: 13, outputTokens: 5, totalTokens: 18,
    auxiliaryInputTokens: 3, reservedInputTokens: 11, auxiliaryUsageKnown: false, costUsd: 0.25 }));
  const ledger = createAuxiliaryBudgetLedger({ db, now: () => STAMP, assertLiveCall: () => true }); t.after(() => db.close());
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='agent_auxiliary_inputs'").get().sql, sql);
  const ticket = ledger.reserveGeneration({ runId: 'owner', callId: 'call-new', estimatedInputTokens: 10, maxOutputTokens: 8, kind: 'vision' });
  const result = ledger.settleGeneration(ticket, { inputTokens: 7, outputTokens: 4 });
  assert.equal(result.usage.inputTokens, 20); assert.equal(result.usage.outputTokens, 9); assert.equal(result.usage.totalTokens, 29);
  assert.equal(result.usage.auxiliaryInputTokens, 10); assert.equal(result.usage.auxiliaryOutputTokens, 4); assert.equal(result.usage.reservedInputTokens, 11);
  assert.equal(result.usage.auxiliaryUsageKnown, false); assert.equal(db.prepare('SELECT count(*) AS n FROM agent_auxiliary_inputs').get().n, 2);
  assert.equal(db.prepare("SELECT actual_input_tokens FROM agent_auxiliary_inputs WHERE id='legacy-known'").get().actual_input_tokens, 3);
  assert.equal(db.prepare("SELECT status FROM agent_auxiliary_inputs WHERE id='legacy-pending'").get().status, 'unknown');
});

test('SQLite reopen retains both unknown input and output holds with one combined recovery notification', async t => {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), directory = await fs.mkdtemp(path.join(parent, 'auxiliary-generation-'));
  const original = await fs.realpath(directory), filename = path.join(directory, 'ledger.sqlite'); let db;
  try {
    db = new DatabaseSync(filename); initializeRun(db);
    const before = createAuxiliaryBudgetLedger({ db, now: () => STAMP, assertLiveCall: () => true });
    before.reserve({ runId: 'owner', callId: 'call-embedding', estimatedInputTokens: 10, kind: 'embedding' });
    before.reserveGeneration({ runId: 'owner', callId: 'call-vision', estimatedInputTokens: 20, maxOutputTokens: 15, kind: 'vision' }); db.close();
    db = new DatabaseSync(filename); const events = [];
    createAuxiliaryBudgetLedger({ db, now: () => STAMP + 1, assertLiveCall: () => true, onUsage: (runId, usage) => events.push({ runId, usage }) });
    const usage = JSON.parse(db.prepare('SELECT usage_json FROM agent_runs').get().usage_json);
    assert.equal(usage.totalTokens, 15); assert.equal(usage.reservedInputTokens, 30); assert.equal(usage.reservedOutputTokens, 15);
    assert.equal(usage.auxiliaryUsageKnown, false); assert.equal(events.length, 1);
    assert.equal(db.prepare('SELECT status FROM agent_auxiliary_inputs').get().status, 'unknown');
    assert.equal(db.prepare('SELECT status FROM agent_auxiliary_generations').get().status, 'unknown');
  } finally {
    db?.close(); const target = await fs.realpath(directory); assert.equal(target, original); assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('auxiliary-generation-')); await fs.rm(target, { recursive: true, force: true });
  }
});

test('known input above its original estimate is charged immediately while only missing output stays reserved', t => {
  const f = fixture(t, { maxTotalTokens: 10000, maxInputTokens: 6000 }), ticket = f.generation(5000, 15);
  const partial = f.ledger.partialGeneration(ticket, { inputTokens: 10000 });
  assert.equal(partial.overBudget, true); assert.equal(partial.usage.inputTokens, 10010); assert.equal(partial.usage.outputTokens, 5);
  assert.equal(partial.usage.totalTokens, 10015); assert.equal(partial.usage.auxiliaryInputTokens, 10000);
  assert.equal(partial.usage.reservedInputTokens, 0); assert.equal(partial.usage.reservedOutputTokens, 15); assert.equal(partial.usage.auxiliaryUsageKnown, false);
  const row = f.db.prepare('SELECT * FROM agent_auxiliary_generations').get();
  assert.equal(row.status, 'unknown'); assert.equal(row.actual_input_tokens, 10000); assert.equal(row.actual_output_tokens, null);
  const count = f.notifications.length;
  assert.deepEqual(f.ledger.partialGeneration(ticket, { inputTokens: 10000 }), partial); assert.equal(f.notifications.length, count);
  assert.deepEqual(f.ledger.unknown(ticket), partial); assert.throws(() => f.ledger.notDispatched(ticket), { code: 'auxiliary_dispatch_unknown' });
  assert.throws(() => f.embed(1), { code: 'budget_tokens' });
  assert.throws(() => f.ledger.settleGeneration(ticket, { inputTokens: 9999, outputTokens: 3 }), { code: 'auxiliary_settlement_conflict' });
  const final = f.ledger.settleGeneration(ticket, { inputTokens: 10000, outputTokens: 3 });
  assert.equal(final.usage.inputTokens, 10010); assert.equal(final.usage.outputTokens, 8); assert.equal(final.usage.totalTokens, 10018);
  assert.equal(final.usage.reservedOutputTokens, 0); assert.equal(final.overBudget, true);
});

test('output-only actuals release only the output hold and the last compatible partial closes the request', t => {
  const f = fixture(t), ticket = f.generation(20, 15);
  const partial = f.ledger.partialGeneration(ticket, { outputTokens: 9 });
  assert.equal(partial.usage.inputTokens, 10); assert.equal(partial.usage.outputTokens, 14); assert.equal(partial.usage.totalTokens, 24);
  assert.equal(partial.usage.auxiliaryInputTokens, 0); assert.equal(partial.usage.auxiliaryOutputTokens, 9);
  assert.equal(partial.usage.reservedInputTokens, 20); assert.equal(partial.usage.reservedOutputTokens, 0);
  assert.deepEqual(f.ledger.unknown(ticket), partial);
  assert.throws(() => f.ledger.settleGeneration(ticket, { inputTokens: 12, outputTokens: 8 }), { code: 'auxiliary_settlement_conflict' });
  const final = f.ledger.partialGeneration(ticket, { inputTokens: 12 });
  assert.equal(final.usage.inputTokens, 22); assert.equal(final.usage.outputTokens, 14); assert.equal(final.usage.totalTokens, 36);
  assert.equal(final.usage.auxiliaryInputTokens, 12); assert.equal(final.usage.auxiliaryOutputTokens, 9); assert.equal(final.usage.auxiliaryUsageKnown, true);
  assert.equal(f.db.prepare('SELECT status FROM agent_auxiliary_generations').get().status, 'settled');
  assert.deepEqual(f.ledger.settleGeneration(ticket, { inputTokens: 12, outputTokens: 9 }), final);
});

test('known zero dimensions are distinct from missing counts and mixed embedding holds remain intact', t => {
  const f = fixture(t), embedding = f.embed(10), ticket = f.generation();
  const input = f.ledger.partialGeneration(ticket, { inputTokens: 0 });
  assert.equal(input.usage.totalTokens, 15); assert.equal(input.usage.reservedInputTokens, 10); assert.equal(input.usage.reservedOutputTokens, 15);
  assert.equal(f.db.prepare('SELECT actual_input_tokens FROM agent_auxiliary_generations').get().actual_input_tokens, 0);
  const both = f.ledger.partialGeneration(ticket, { outputTokens: 0 });
  assert.equal(both.usage.totalTokens, 15); assert.equal(both.usage.reservedInputTokens, 10); assert.equal(both.usage.reservedOutputTokens, 0);
  assert.equal(both.usage.auxiliaryUsageKnown, false);
  const final = f.ledger.settle(embedding, 0); assert.equal(final.usage.totalTokens, 15); assert.equal(final.usage.auxiliaryUsageKnown, true);
});

test('partial knowledge can arrive after cancellation without erasing prior counts or terminal state', t => {
  const f = fixture(t), ticket = f.generation(20, 15);
  f.db.prepare("UPDATE agent_runs SET status='cancelled',error_json=?").run(JSON.stringify({ code: 'cancelled' }));
  const input = f.ledger.partialGeneration(ticket, { inputTokens: 7 });
  assert.equal(input.usage.totalTokens, 22); assert.equal(input.usage.reservedOutputTokens, 15); assert.equal(input.usage.reservedInputTokens, 0);
  assert.deepEqual(f.ledger.unknown(ticket), input);
  assert.throws(() => f.ledger.partialGeneration(ticket, { inputTokens: 8 }), { code: 'auxiliary_settlement_conflict' });
  const final = f.ledger.settleGeneration(ticket, { inputTokens: 7, outputTokens: 4 });
  assert.equal(final.usage.inputTokens, 17); assert.equal(final.usage.outputTokens, 9); assert.equal(final.usage.totalTokens, 26);
  const row = f.db.prepare('SELECT status,output,error_json FROM agent_runs').get();
  assert.equal(row.status, 'cancelled'); assert.equal(row.output, 'preserved output'); assert.equal(JSON.parse(row.error_json).code, 'cancelled');
});

test('partial usage is exact, bounded and cannot contradict an already settled or non-dispatched outcome', t => {
  const f = fixture(t), ticket = f.generation();
  for (const actual of [undefined, null, [], {}, { arbitrary: 1 }, { inputTokens: undefined }, { inputTokens: -1 },
    { outputTokens: 1.5 }, { outputTokens: 1_000_000_001 }, { inputTokens: 1, outputTokens: 2, costUsd: 0 }]) {
    assert.throws(() => f.ledger.partialGeneration(ticket, actual), { code: 'invalid_auxiliary_input' });
  }
  assert.throws(() => f.ledger.partialGeneration(f.embed(1), { inputTokens: 1 }), { code: 'auxiliary_ticket_invalid' });
  const final = f.ledger.partialGeneration(ticket, { inputTokens: 3, outputTokens: 2 });
  assert.equal(final.usage.auxiliaryInputTokens, 3); assert.equal(final.usage.auxiliaryOutputTokens, 2);
  assert.deepEqual(f.ledger.partialGeneration(ticket, { outputTokens: 2 }), final);
  assert.throws(() => f.ledger.partialGeneration(ticket, { outputTokens: 3 }), { code: 'auxiliary_settlement_conflict' });
  const released = f.generation(); f.ledger.notDispatched(released);
  assert.throws(() => f.ledger.partialGeneration(released, { inputTokens: 0 }), { code: 'auxiliary_settlement_conflict' });
});

test('reopened SQLite preserves partial actuals with only missing generation and legacy embedding dimensions held', async t => {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), directory = await fs.mkdtemp(path.join(parent, 'auxiliary-partial-'));
  const original = await fs.realpath(directory), filename = path.join(directory, 'ledger.sqlite'); let db;
  try {
    db = new DatabaseSync(filename); initializeRun(db);
    const before = createAuxiliaryBudgetLedger({ db, now: () => STAMP, assertLiveCall: () => true });
    before.reserve({ runId: 'owner', callId: 'call-embedding', estimatedInputTokens: 10, kind: 'embedding' });
    const ticket = before.reserveGeneration({ runId: 'owner', callId: 'call-vision', estimatedInputTokens: 20, maxOutputTokens: 15, kind: 'vision' });
    before.partialGeneration(ticket, { inputTokens: 8 }); db.close(); db = new DatabaseSync(filename);
    createAuxiliaryBudgetLedger({ db, now: () => STAMP + 1, assertLiveCall: () => true });
    const usage = JSON.parse(db.prepare('SELECT usage_json FROM agent_runs').get().usage_json), generation = db.prepare('SELECT * FROM agent_auxiliary_generations').get();
    assert.equal(usage.inputTokens, 18); assert.equal(usage.outputTokens, 5); assert.equal(usage.totalTokens, 23);
    assert.equal(usage.auxiliaryInputTokens, 8); assert.equal(usage.auxiliaryOutputTokens, 0);
    assert.equal(usage.reservedInputTokens, 10); assert.equal(usage.reservedOutputTokens, 15); assert.equal(usage.auxiliaryUsageKnown, false);
    assert.equal(generation.status, 'unknown'); assert.equal(generation.actual_input_tokens, 8); assert.equal(generation.actual_output_tokens, null);
    assert.equal(db.prepare('SELECT status FROM agent_auxiliary_inputs').get().status, 'unknown');
  } finally {
    db?.close(); const target = await fs.realpath(directory); assert.equal(target, original); assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('auxiliary-partial-')); await fs.rm(target, { recursive: true, force: true });
  }
});
