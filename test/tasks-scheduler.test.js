import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskScheduler } from '../server/tasks/scheduler.js';
import { stableJson } from '../server/agent/schema.js';

const initial = Date.UTC(2026, 9, 26, 12);
const copy = value => JSON.parse(JSON.stringify(value));
const usage = total => ({ inputTokens: total ? total - 1 : 0, outputTokens: total ? 1 : 0, totalTokens: total, costUsd: 0 });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fakeAgent() {
  const runs = new Map(), starts = [], cancellations = []; let serial = 0, busy = false, database;
  const make = input => {
    const row = database?.prepare('SELECT * FROM scheduled_task_occurrences WHERE request_id=?').get(input.requestId);
    return { ...copy(input), id: `run-${++serial}`, status: 'running', usage: usage(0), updatedAt: initial,
      ...(row ? { provenance: { kind: 'scheduled_task', taskId: row.task_id, generation: row.generation, occurrenceId: row.id, scheduledAt: row.scheduled_at, requestHash: row.request_hash } } : {}) };
  };
  const save = run => { runs.set(run.id, run); return copy(run); };
  return { runs, starts, cancellations, make, save, bind(db) { database = db; },
    async start(input) { assert.ok(Object.isFrozen(input)); assert.ok(Object.isFrozen(input.budget)); assert.ok(Object.isFrozen(input.attachments)); starts.push(copy(input)); return save(make(input)); },
    get(id) { return runs.has(id) ? copy(runs.get(id)) : null; },
    getByRequestId(id) { const found = [...runs.values()].find(run => run.requestId === id); return found ? copy(found) : null; },
    cancel(id) { cancellations.push(id); const run = runs.get(id); if (!run) return null; run.status = 'cancelled'; return copy(run); },
    isBusy() { return busy || [...runs.values()].some(run => !['completed','failed','cancelled','interrupted'].includes(run.status)); },
    setBusy(value) { busy = value; },
    finish(id, status = 'completed', tokens = 20, extra = {}) { Object.assign(runs.get(id), { status, usage: usage(tokens), ...extra }); },
  };
}
function fixture(t, options = {}) {
  const db = options.db || new DatabaseSync(':memory:'), agent = options.agent || fakeAgent(); let stamp = initial;
  agent.bind?.(db);
  const scheduler = createTaskScheduler({ db, agent, now: () => stamp, ...options });
  t.after(async () => { await scheduler.close(); if (!options.db) db.close(); });
  const spec = (changes = {}) => ({ title: 'Local scheduled check', goal: 'Read and summarize the local test note.', model: 'local-model:latest',
    schedule: { kind: 'interval', firstAt: new Date(stamp + 60000).toISOString(), everyMinutes: 1 }, budget: { maxTotalTokens: 100 }, limits: { maxRuns: 5, maxTotalTokens: 500 }, ...changes });
  const create = async (changes = {}, requestId = 'create-1') => {
    const preview = scheduler.preview(spec(changes)); return scheduler.create({ ...preview.spec, requestId, expectedFirstRunAt: preview.firstRunAt });
  };
  return { db, agent, scheduler, spec, create, now: () => stamp, advance: ms => { stamp += ms; }, setNow: value => { stamp = value; } };
}

test('construction is inert; preview canonicalizes local budgets and initial dispatch is frozen, reserved and deterministic', async t => {
  const f = fixture(t); assert.equal(f.agent.starts.length, 0); assert.equal(f.scheduler.list().length, 0);
  const job = await f.create({ goal: '  Read and summarize the local test note.  ' }); assert.equal(job.budget.maxDurationMs, 300000); assert.equal(job.budget.maxCostUsd, 0);
  assert.equal(job.goal, 'Read and summarize the local test note.');
  await f.scheduler.tick(); assert.equal(f.agent.starts.length, 0);
  f.advance(60000); await f.scheduler.tick();
  const current = f.scheduler.get(job.id), body = f.agent.starts[0], row = f.db.prepare('SELECT * FROM scheduled_task_occurrences').get();
  assert.equal(current.runsStarted, 1); assert.equal(current.reservedTokens, 100); assert.equal(current.usedTokens, 0);
  assert.equal(body.provider, 'ollama'); assert.equal(body.allowCloud, false); assert.deepEqual(body.attachments, []); assert.equal(body.desktopSessionId, undefined);
  assert.equal(body.conversationId, `task:${job.id}:g1`); assert.equal(body.requestId, `task:${job.id}:g1:${initial + 60000}`);
  assert.deepEqual(JSON.parse(row.request_json), body); assert.equal(row.request_hash, createHash('sha256').update(stableJson(body)).digest('hex'));
  assert.equal(current.currentRunId, current.history[0].runId); assert.equal(current.lastRunId, current.currentRunId);
});

test('mutations are idempotent across races and stale request recovery exposes current state', async t => {
  const f = fixture(t), preview = f.scheduler.preview(f.spec()), input = { ...preview.spec, requestId: 'same-create', expectedFirstRunAt: preview.firstRunAt };
  const [one,two] = await Promise.all([f.scheduler.create(input), f.scheduler.create(copy(input))]);
  assert.equal(one.id, two.id); assert.equal(f.scheduler.list().length, 1);
  await assert.rejects(f.scheduler.create({ ...input, goal: 'changed' }), { code: 'task_request_conflict' });
  const paused = await f.scheduler.pause(one.id, { requestId: 'pause-1', expectedRevision: 1 });
  assert.equal(paused.status, 'paused'); assert.equal(f.scheduler.request('same-create').state, 'created'); assert.equal(f.scheduler.request('same-create').task.status, 'paused');
  assert.equal((await f.scheduler.create(input)).status, 'paused');
  await assert.rejects(f.scheduler.resume(one.id, { requestId: 'bad-revision', expectedRevision: 1 }), { code: 'task_revision_conflict' });
  assert.equal((await f.scheduler.pause(one.id, { requestId: 'pause-1', expectedRevision: 1 })).revision, 2);
});

test('cancel request tombstone wins lost-create races and cannot cancel a later edited task', async t => {
  const f = fixture(t), preview = f.scheduler.preview(f.spec());
  assert.equal((await f.scheduler.cancelRequest('lost-create')).state, 'cancelled');
  await assert.rejects(f.scheduler.create({ ...preview.spec, requestId: 'lost-create', expectedFirstRunAt: preview.firstRunAt }), { code: 'task_request_cancelled' });
  assert.equal(f.scheduler.list().length, 0);
  const job = await f.create({}, 'original');
  const edited = await f.scheduler.update(job.id, { ...preview.spec, title: 'Reviewed new title', requestId: 'edit-1', expectedRevision: 1, expectedFirstRunAt: preview.firstRunAt });
  await assert.rejects(f.scheduler.cancelRequest('original'), { code: 'task_revision_conflict' }); assert.equal(f.scheduler.get(job.id).revision, edited.revision);
  const untouched = await f.create({}, 'untouched'); assert.equal((await f.scheduler.cancelRequest('untouched')).task.status, 'archived');
  assert.equal(f.scheduler.get(untouched.id).revision, 2);
});

test('strict task policy rejects cloud/desktop/custom authority, unaffordable budgets and stale previews', async t => {
  const f = fixture(t);
  for (const change of [{ provider: 'openai' }, { allowCloud: true }, { attachments: ['private'] }, { desktopSessionId: 'grant' }, { approvals: ['inherited'] },
    { model: 'model:cloud' }, { model: 'openai/gpt-cloud' }, { budget: { maxCostUsd: 1 } }, { budget: { maxTotalTokens: 501 } },
    { limits: { maxRuns: 0, maxTotalTokens: 500 } }, { goal: '\ud800' }]) assert.throws(() => f.scheduler.preview(f.spec(change)));
  const p = f.scheduler.preview(f.spec());
  await assert.rejects(f.scheduler.create({ ...p.spec, requestId: 'wrong-preview', expectedFirstRunAt: p.firstRunAt + 1 }), { code: 'task_preview_stale' });
  assert.equal(f.scheduler.list().length, 0);
  assert.throws(() => f.scheduler.preview(f.spec({ schedule: { kind: 'once', at: new Date(initial + 60000).toISOString() } })), { code: 'task_arguments' });
});

test('one global active occurrence and interactive work defer dispatch; ticks coalesce without duplicate starts', async t => {
  const f = fixture(t), first = await f.create({}, 'first'), second = await f.create({}, 'second');
  f.advance(60000); f.agent.setBusy(true); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 0);
  f.agent.setBusy(false); await Promise.all([f.scheduler.tick(), f.scheduler.tick(), f.scheduler.tick()]); assert.equal(f.agent.starts.length, 1);
  await f.scheduler.tick(); assert.equal(f.agent.starts.length, 1);
  const current = [first,second].map(job => f.scheduler.get(job.id)).find(job => job.currentRunId);
  f.agent.finish(current.currentRunId); await f.scheduler.tick(); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 2);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM scheduled_task_occurrences WHERE status IN ('prepared','dispatching','running','approval_needed','unknown')").get().n, 1);
});

test('downtime coalesces only the latest due interval slot and moves the next slot strictly into the future', async t => {
  const f = fixture(t), job = await f.create(); f.advance(100 * 60000 + 1234); await f.scheduler.tick();
  const current = f.scheduler.get(job.id); assert.equal(current.history[0].scheduledAt, initial + 100 * 60000); assert.ok(current.nextRunAt > f.now());
  f.agent.finish(current.currentRunId); await f.scheduler.tick(); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 1);
  const paused = await f.scheduler.pause(job.id, { requestId: 'pause', expectedRevision: 1 }); f.advance(20 * 60000);
  const resumed = await f.scheduler.resume(job.id, { requestId: 'resume', expectedRevision: paused.revision });
  assert.equal(resumed.generation, 2); assert.equal(resumed.firstRunAt, resumed.nextRunAt); assert.ok(resumed.nextRunAt > f.now());
  await f.scheduler.tick(); assert.equal(f.agent.starts.length, 1);
  f.setNow(resumed.nextRunAt); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 2);
  assert.equal(f.scheduler.get(job.id).history[0].scheduledAt, initial + 121 * 60000);
});

test('resuming paused interval and daily tasks starts the new generation strictly in the future, never at paused missed slots', async t => {
  for (const schedule of [{ kind: 'interval', firstAt: new Date(initial + 60000).toISOString(), everyMinutes: 1 }, { kind: 'daily', time: '12:01', timeZone: 'UTC' }]) {
    const f = fixture(t), job = await f.create({ schedule });
    const paused = await f.scheduler.pause(job.id, { requestId: 'pause-before-slot', expectedRevision: 1 }); f.advance(3 * 86400000 + 10 * 60000);
    const resumed = await f.scheduler.resume(job.id, { requestId: 'resume-future', expectedRevision: paused.revision });
    assert.equal(resumed.generation, 2); assert.ok(resumed.nextRunAt > f.now()); assert.equal(resumed.firstRunAt, resumed.nextRunAt);
    assert.deepEqual(resumed.schedule, job.schedule); assert.equal(resumed.runsStarted, 0); assert.equal(resumed.usedTokens, 0); assert.equal(resumed.reservedTokens, 0);
    await f.scheduler.tick(); assert.equal(f.agent.starts.length, 0);
    f.setNow(resumed.nextRunAt - 1); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 0);
    f.advance(1); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 1); assert.equal(f.scheduler.get(job.id).history[0].scheduledAt, resumed.nextRunAt);
  }
});

test('lifetime reservation uses full per-run budget, actual use is monotonic, and overage is never clamped', async t => {
  const f = fixture(t), job = await f.create({ limits: { maxRuns: 10, maxTotalTokens: 250 } });
  f.advance(60000); await f.scheduler.tick(); let run = f.scheduler.get(job.id).currentRunId;
  f.agent.finish(run, 'completed', 80); await f.scheduler.tick(); assert.equal(f.scheduler.get(job.id).usedTokens, 80); assert.equal(f.scheduler.get(job.id).reservedTokens, 0);
  f.advance(60000); await f.scheduler.tick(); run = f.scheduler.get(job.id).currentRunId; f.agent.finish(run, 'completed', 80); await f.scheduler.tick();
  assert.equal(f.scheduler.get(job.id).usedTokens, 160); assert.equal(f.scheduler.get(job.id).status, 'completed');
  f.advance(60000); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 2);
  const g = fixture(t), over = await g.create({ limits: { maxRuns: 5, maxTotalTokens: 100 } }); g.advance(60000); await g.scheduler.tick();
  g.agent.finish(g.scheduler.get(over.id).currentRunId, 'completed', 150); await g.scheduler.tick();
  assert.equal(g.scheduler.get(over.id).usedTokens, 150); assert.equal(g.scheduler.get(over.id).status, 'attention'); assert.equal(g.scheduler.get(over.id).attention.code, 'task_lifetime_overage');
});

test('failed/interrupted/cancelled usage retains unknown reservation across edits and generations', async t => {
  for (const state of ['failed','interrupted','cancelled']) {
    const f = fixture(t), job = await f.create(); f.advance(60000); await f.scheduler.tick();
    f.agent.finish(f.scheduler.get(job.id).currentRunId, state, 20); await f.scheduler.tick();
    const stopped = f.scheduler.get(job.id); assert.equal(stopped.status, 'attention'); assert.equal(stopped.usedTokens, 20); assert.equal(stopped.reservedTokens, 80);
    const preview = f.scheduler.preview(f.spec({ goal: 'New reviewed generation' }));
    const edited = await f.scheduler.update(job.id, { ...preview.spec, requestId: `edit-${state}`, expectedRevision: 1, expectedFirstRunAt: preview.firstRunAt });
    assert.equal(edited.generation, 2); assert.equal(edited.runsStarted, 1); assert.equal(edited.usedTokens, 20); assert.equal(edited.reservedTokens, 80);
    await assert.rejects(f.scheduler.update(job.id, { ...preview.spec, limits: { maxRuns: 5, maxTotalTokens: 99 }, requestId: `erase-${state}`, expectedRevision: 2, expectedFirstRunAt: preview.firstRunAt }));
  }
});

test('approval-needed runs stay in attention without future dispatch or inherited approvals', async t => {
  const f = fixture(t), job = await f.create(); f.advance(60000); await f.scheduler.tick();
  f.agent.finish(f.scheduler.get(job.id).currentRunId, 'awaiting_approval', 10, { pendingApproval: { approvalId: 'approval-1' } }); await f.scheduler.tick();
  let current = f.scheduler.get(job.id); assert.equal(current.status, 'attention'); assert.equal(current.history[0].status, 'approval_needed');
  assert.equal(current.history[0].receipt.approvalId, 'approval-1');
  f.advance(10 * 60000); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 1);
  await assert.rejects(f.scheduler.resume(job.id, { requestId: 'bypass', expectedRevision: 1 }), { code: 'task_active' });
  current = await f.scheduler.pause(job.id, { requestId: 'stop-approval', expectedRevision: 1 });
  assert.equal(current.status, 'paused'); assert.deepEqual(f.agent.cancellations, [current.lastRunId]); assert.equal(current.currentRunId, null); assert.equal(current.reservedTokens, 90);
});

test('successful approved one-off and exhausted runs complete, while recurring work requires explicit future resume', async t => {
  for (const kind of ['once','run-limit','token-limit','recurring']) {
    const f = fixture(t), changes = kind === 'once' ? { schedule: { kind: 'once', at: new Date(initial + 60000).toISOString() }, limits: { maxRuns: 1, maxTotalTokens: 100 } }
      : kind === 'run-limit' ? { limits: { maxRuns: 1, maxTotalTokens: 500 } } : kind === 'token-limit' ? { limits: { maxRuns: 5, maxTotalTokens: 100 } } : {};
    const job = await f.create(changes); f.advance(60000); await f.scheduler.tick(); const runId = f.scheduler.get(job.id).currentRunId;
    f.agent.finish(runId, 'awaiting_approval', 10, { pendingApproval: { approvalId: 'approved-later' } }); await f.scheduler.tick();
    assert.equal(f.scheduler.get(job.id).attention.code, 'task_approval_required');
    f.agent.finish(runId, 'completed', 20, { pendingApproval: null }); await f.scheduler.tick(); const current = f.scheduler.get(job.id);
    assert.equal(current.usedTokens, 20); assert.equal(current.reservedTokens, 0); assert.equal(current.currentRunId, null); assert.equal(current.history[0].status, 'completed');
    if (kind !== 'recurring') { assert.equal(current.status, 'completed'); assert.equal(current.nextRunAt, null); assert.equal(current.attention, null); }
    else { assert.equal(current.status, 'attention'); assert.equal(current.attention.code, 'task_resume_required'); assert.ok(current.nextRunAt > f.now()); }
    f.advance(5 * 60000); await f.scheduler.tick(); assert.equal(f.agent.starts.length, 1);
    if (kind === 'recurring') { const resumed = await f.scheduler.resume(job.id, { requestId: 'explicit-resume', expectedRevision: 1 }); assert.equal(resumed.status, 'active'); assert.ok(resumed.nextRunAt > f.now()); }
  }
});

test('completed approvals cannot erase operator pause/archive or unrelated error attention', async t => {
  for (const state of ['paused','archived','other-attention','overage']) {
    const f = fixture(t), job = await f.create(); f.advance(60000); await f.scheduler.tick(); const runId = f.scheduler.get(job.id).currentRunId;
    f.agent.finish(runId, 'awaiting_approval', 10, { pendingApproval: { approvalId: 'operator-approved' } }); await f.scheduler.tick();
    if (state === 'paused' || state === 'archived') {
      f.agent.cancel = id => f.agent.get(id); // Delayed cancellation: authority stops before the accepted run finishes.
      await f.scheduler[state === 'paused' ? 'pause' : 'archive'](job.id, { requestId: `operator-${state}`, expectedRevision: 1 });
    } else if (state === 'other-attention') f.db.prepare('UPDATE scheduled_tasks SET attention_json=? WHERE id=?').run(JSON.stringify({ code: 'task_recovery_unknown', occurrenceId: job.id }), job.id);
    f.agent.finish(runId, 'completed', state === 'overage' ? 600 : 20, { pendingApproval: null }); await f.scheduler.tick();
    const current = f.scheduler.get(job.id);
    if (state === 'paused' || state === 'archived') assert.equal(current.status, state);
    else { assert.equal(current.status, 'attention'); assert.equal(current.attention.code, state === 'overage' ? 'task_lifetime_overage' : 'task_recovery_unknown'); }
  }
});

test('pause authority commits before a prepared dispatch and late adapter acceptance is cancelled only for its owned run', async t => {
  let scheduler;
  const f = fixture(t, { onEvent: event => { if (event.type === 'task_occurrence_prepared') void scheduler.pause(event.taskId, { requestId: 'pause-before', expectedRevision: 1 }); } }); scheduler = f.scheduler;
  const job = await f.create(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.agent.starts.length, 0); assert.equal(f.scheduler.get(job.id).status, 'paused'); assert.equal(f.scheduler.get(job.id).reservedTokens, 0);
  const agent = fakeAgent(); let resolveStart;
  agent.start = input => { agent.starts.push(copy(input)); return new Promise(resolve => { resolveStart = () => resolve(agent.save(agent.make(input))); }); };
  const g = fixture(t, { agent }), delayed = await g.create(); g.advance(60000); const pending = g.scheduler.tick(); await flush(); assert.equal(agent.starts.length, 1);
  await g.scheduler.pause(delayed.id, { requestId: 'pause-during', expectedRevision: 1 }); assert.equal(g.scheduler.get(delayed.id).status, 'paused');
  resolveStart(); await pending; assert.equal(agent.cancellations.length, 1); assert.equal(g.scheduler.get(delayed.id).currentRunId, null); assert.equal(g.scheduler.get(delayed.id).status, 'paused');
});

test('close waits for a late start to be cancelled and prevents every later dispatch', async t => {
  const agent = fakeAgent(); let resolveStart;
  agent.start = input => { agent.starts.push(copy(input)); return new Promise(resolve => { resolveStart = () => resolve(agent.save(agent.make(input))); }); };
  const f = fixture(t, { agent }), job = await f.create(); f.advance(60000); const pending = f.scheduler.tick(); await flush();
  const closing = f.scheduler.close(); await flush(); resolveStart(); const receipt = await closing; await pending;
  assert.equal(receipt.cleanupConfirmed, true); assert.equal(receipt.pendingStart, false); assert.equal(agent.cancellations.length, 1);
  assert.equal(f.scheduler.get(job.id).currentRunId, null); f.advance(60000); await f.scheduler.tick(); assert.equal(agent.starts.length, 1);
  await assert.rejects(f.create({}, 'closed-create'), { code: 'task_closed' });
});

test('lost acceptance response attaches deterministic existing run, while missing recovery never repeats an uncertain attempt', async t => {
  const agent = fakeAgent(); agent.start = async input => { agent.starts.push(copy(input)); agent.save(agent.make(input)); throw new Error('lost response'); };
  const f = fixture(t, { agent }), job = await f.create(); f.advance(60000); await f.scheduler.tick(); assert.equal(agent.starts.length, 1); assert.ok(f.scheduler.get(job.id).currentRunId);
  const saved = f.scheduler.get(job.id).history[0]; agent.runs.clear();
  const restarted = createTaskScheduler({ db: f.db, agent, now: f.now });
  await restarted.tick(); await restarted.tick();
  assert.equal(agent.starts.length, 1); assert.equal(restarted.get(job.id).status, 'attention'); assert.equal(restarted.get(job.id).history[0].status, 'unknown');
  assert.equal(restarted.get(job.id).history[0].requestId, saved.requestId); assert.equal(restarted.get(job.id).reservedTokens, 100);
  await restarted.close();
});

test('a delayed stale receipt cannot reopen an occurrence after another reconciler committed terminal state', async t => {
  const f = fixture(t), job = await f.create(); f.advance(60000); await f.scheduler.tick();
  const runId = f.scheduler.get(job.id).currentRunId; f.agent.finish(runId, 'running', 20);
  const original = f.agent.getByRequestId.bind(f.agent); let hold = true, release;
  f.agent.getByRequestId = id => {
    const snapshot = original(id);
    if (hold) { hold = false; return new Promise(resolve => { release = () => resolve(snapshot); }); }
    return snapshot;
  };
  const delayed = f.scheduler.tick(); await flush(); assert.ok(release);
  f.agent.finish(runId, 'completed', 20);
  const other = createTaskScheduler({ db: f.db, agent: f.agent, now: f.now }); await other.tick();
  assert.equal(other.get(job.id).history[0].status, 'completed'); assert.equal(other.get(job.id).reservedTokens, 0);
  release(); await delayed;
  const current = f.scheduler.get(job.id); assert.equal(current.history[0].status, 'completed'); assert.equal(current.currentRunId, null);
  assert.equal(current.reservedTokens, 0); assert.equal(current.usedTokens, 20); assert.equal(f.agent.starts.length, 1);
  await other.close();
});

test('frozen request hash, exact budget and server provenance reject forged recovery or dispatch receipts', async t => {
  for (const change of [run => { run.budget.maxTotalTokens++; }, run => { delete run.provenance; }, run => { run.provenance.taskId = 'foreign'; },
    run => { run.provenance.generation++; }, run => { run.provenance.requestHash = '0'.repeat(64); },run=>{run.thinking=false;},run=>{run.thinking='low';}]) {
    const f = fixture(t), job = await f.create(); f.advance(60000); await f.scheduler.tick(); const runId = f.scheduler.get(job.id).currentRunId;
    change(f.agent.runs.get(runId)); await f.scheduler.tick();
    assert.equal(f.scheduler.get(job.id).status, 'attention'); assert.equal(f.scheduler.get(job.id).history[0].status, 'unknown');
    assert.equal(f.agent.starts.length, 1); assert.equal(f.scheduler.get(job.id).reservedTokens, 100);
    assert.equal(f.agent.cancellations.length, 0);
  }
  let db;
  const f = fixture(t, { onEvent: event => { if (event.type === 'task_occurrence_prepared') db.prepare("UPDATE scheduled_task_occurrences SET request_hash=? WHERE id=?").run('0'.repeat(64), event.occurrenceId); } }); db = f.db;
  const job = await f.create(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.agent.starts.length, 0); assert.equal(f.scheduler.get(job.id).status, 'attention'); assert.equal(f.scheduler.get(job.id).reservedTokens, 100);
});

test('interactive work beginning after reservation defers the same occurrence without spending another run slot', async t => {
  let busyAfterReservation = true;
  const f = fixture(t, { onEvent: event => { if (event.type === 'task_occurrence_prepared' && busyAfterReservation) f.agent.setBusy(true); } });
  const job = await f.create(); f.advance(60000); await f.scheduler.tick();
  assert.equal(f.agent.starts.length, 0); const prepared = f.scheduler.get(job.id); assert.equal(prepared.history[0].status, 'prepared'); assert.equal(prepared.runsStarted, 1);
  busyAfterReservation = false; f.agent.setBusy(false); await f.scheduler.tick();
  assert.equal(f.agent.starts.length, 1); assert.equal(f.scheduler.get(job.id).runsStarted, 1); assert.equal(f.scheduler.get(job.id).history[0].id, prepared.history[0].id);
});

test('SQLite reopen recovers a completed or interrupted original run without a second start', async t => {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const dir = await fs.mkdtemp(path.join(work, 'task-scheduler-')), filename = path.join(dir, 'scheduler.sqlite');
  let db = new DatabaseSync(filename); const agent = fakeAgent(); agent.bind(db); let stamp = initial;
  const one = createTaskScheduler({ db, agent, now: () => stamp }), spec = { title: 'Durable once', goal: 'One isolated check', model: 'local-model', schedule: { kind: 'once', at: new Date(stamp + 60000).toISOString() }, budget: { maxTotalTokens: 100 }, limits: { maxRuns: 1, maxTotalTokens: 100 } };
  const preview = one.preview(spec), job = await one.create({ ...preview.spec, requestId: 'durable', expectedFirstRunAt: preview.firstRunAt }); stamp += 60000; await one.tick();
  const runId = one.get(job.id).currentRunId; db.close(); // Simulated process loss, without invoking close/cancel.
  agent.finish(runId, 'failed', 30, { error: { code: 'interrupted', message: 'Agent restarted' } }); db = new DatabaseSync(filename); agent.bind(db);
  const two = createTaskScheduler({ db, agent, now: () => stamp }); await two.tick(); assert.equal(agent.starts.length, 1); assert.equal(two.get(job.id).history[0].status, 'interrupted');
  assert.equal(two.get(job.id).usedTokens, 30); assert.equal(two.get(job.id).reservedTokens, 70); assert.equal(two.get(job.id).status, 'attention');
  await two.close(); db.close(); await fs.unlink(filename); await fs.rmdir(dir);
});

test('one-off completion and archive cannot silently rearm, and paused past one-offs cannot resume', async t => {
  const f = fixture(t), once = { schedule: { kind: 'once', at: new Date(initial + 60000).toISOString() }, limits: { maxRuns: 1, maxTotalTokens: 100 } };
  const job = await f.create(once); f.advance(60000); await f.scheduler.tick(); f.agent.finish(f.scheduler.get(job.id).currentRunId); await f.scheduler.tick();
  assert.equal(f.scheduler.get(job.id).status, 'completed'); await assert.rejects(f.scheduler.resume(job.id, { requestId: 'no-rearm', expectedRevision: 1 }), { code: 'task_state' });
  const preview = f.scheduler.preview(f.spec()); await assert.rejects(f.scheduler.update(job.id, { ...preview.spec, requestId: 'no-edit-rearm', expectedRevision: 1, expectedFirstRunAt: preview.firstRunAt }), { code: 'task_state' });
  const future = await f.create({ ...once, schedule: { kind: 'once', at: new Date(f.now() + 60000).toISOString() } }, 'paused-once');
  await f.scheduler.pause(future.id, { requestId: 'pause-once', expectedRevision: 1 }); f.advance(120000);
  await assert.rejects(f.scheduler.resume(future.id, { requestId: 'resume-past', expectedRevision: 2 }), { code: 'task_schedule' });
  const archived = await f.scheduler.archive(future.id, { requestId: 'archive', expectedRevision: 2 });
  await assert.rejects(f.scheduler.resume(future.id, { requestId: 'resume-archive', expectedRevision: archived.revision }), { code: 'task_state' });
});

test('active task capacity is bounded and archive preserves lifetime rows', async t => {
  const f = fixture(t); for (let i = 0; i < 32; i++) await f.create({}, `capacity-${i}`);
  await assert.rejects(f.create({}, 'capacity-over'), { code: 'task_limit' });
  const job = f.scheduler.list()[0]; await f.scheduler.archive(job.id, { requestId: 'free-slot', expectedRevision: 1 }); await f.create({}, 'capacity-new');
  assert.equal(f.scheduler.list().length, 33); assert.equal(f.scheduler.list().filter(item => item.status !== 'archived').length, 32);
});

test('history returns only the latest twenty receipts while lifetime counters keep all work', async t => {
  const f = fixture(t), job = await f.create({ limits: { maxRuns: 30, maxTotalTokens: 3000 } });
  for (let i = 0; i < 22; i++) { f.advance(60000); await f.scheduler.tick(); f.agent.finish(f.scheduler.get(job.id).currentRunId, 'completed', 1); await f.scheduler.tick(); }
  const current = f.scheduler.get(job.id); assert.equal(current.history.length, 20); assert.equal(current.runsStarted, 22); assert.equal(current.usedTokens, 22);
  assert.equal(current.history[0].scheduledAt, initial + 22 * 60000); assert.equal(current.history.at(-1).scheduledAt, initial + 3 * 60000);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scheduled_task_occurrences').get().n, 22);
});

test('the lifetime task-row ceiling cannot be evaded by repeatedly archiving tasks', async t => {
  const f = fixture(t);
  for (let i = 0; i < 256; i++) { const job = await f.create({}, `lifetime-${i}`); await f.scheduler.archive(job.id, { requestId: `archive-${i}`, expectedRevision: 1 }); }
  await assert.rejects(f.create({}, 'lifetime-over'), { code: 'task_limit' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM scheduled_tasks').get().n, 256); assert.equal(f.agent.starts.length, 0);
});
