import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTaskScheduler } from '../server/tasks/scheduler.js';
import { createTaskTools } from '../server/tasks/tools.js';
import { hash, stableJson } from '../server/agent/schema.js';

const INITIAL = Date.parse('2026-10-26T12:00:00Z');
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE agent_approvals(id TEXT PRIMARY KEY,run_id TEXT,tool_name TEXT,args_json TEXT,args_hash TEXT,preview_json TEXT,status TEXT)`);
  let stamp = INITIAL;
  const scheduler = createTaskScheduler({ db, now: () => stamp, agent: {
    start: () => assert.fail('Tool tests must never dispatch an occurrence'),
    get: () => null, getByRequestId: () => null, cancel: () => null, isBusy: () => false,
  } });
  const receipts = [], tools = createTaskTools({ scheduler, db, now: () => stamp, onReceipt: (runId, receipt) => receipts.push({runId, receipt}) });
  const tool = name => tools.find(value => value.name === name);
  const context = (args, extra = {}) => ({ args, run: { id: 'interactive-source', provider: 'ollama', allowCloud: false }, signal: new AbortController().signal, ...extra });
  function approve(name, ctx, preview, status = 'consumed') {
    const approvalId = 'approval-' + String(receipts.length) + '-' + db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n;
    const args = stableJson(ctx.args);
    db.prepare('INSERT INTO agent_approvals VALUES(?,?,?,?,?,?,?)').run(approvalId, ctx.run.id, name, args, hash(name + '\n' + args), JSON.stringify(preview), status);
    return { ...ctx, approvalId };
  }
  const args = overrides => ({ title: 'A bounded local task', goal: 'Read a local fixture file.', model: 'test:local', at: new Date(INITIAL + 60000).toISOString(), limits: {maxRuns: 1, maxTotalTokens: 24000}, ...overrides });
  t.after(async () => { const closed = await scheduler.close(); assert.equal(closed.cleanupConfirmed, true); db.close(); });
  return {db, scheduler, tools, tool, context, approve, args, receipts, advance: ms => { stamp += ms; }};
}

test('task creation uses its complete approved preview and rejects missing, changed or unconsumed authority', async t => {
  const f = fixture(t), name = 'tasks.createOnce', tool = f.tool(name), ctx = f.context(f.args()), preview = await tool.prepare(ctx);
  assert.equal(preview.spec.goal, ctx.args.goal); assert.equal(preview.firstRunAt, INITIAL + 60000); assert.equal(preview.spec.budget.maxCostUsd, 0);
  assert.match(preview.warning, /no approval is inherited/i); assert.deepEqual(f.scheduler.list(), []);
  await assert.rejects(tool.execute({...ctx, approvalId: 'missing'}), {code: 'approval_mismatch'});
  const pending = f.approve(name, ctx, preview, 'pending');
  await assert.rejects(tool.execute(pending), {code: 'approval_mismatch'});
  const allowed = f.approve(name, ctx, preview);
  await assert.rejects(tool.execute({...allowed, args: {...ctx.args, goal: 'An unapproved replacement goal.'}}), {code: 'approval_mismatch'});
  const result = await tool.execute(allowed);
  assert.equal(result.task.id, f.scheduler.list()[0].id); assert.equal(f.scheduler.list()[0].goal, ctx.args.goal);
  assert.equal(result.receipt.operation, 'create'); assert.equal(f.receipts.length, 1);
  assert.equal((await tool.execute(allowed)).task.id, result.task.id); assert.equal(f.scheduler.list().length, 1, 'same approved operation remains idempotent');
});

test('a stale approved calendar preview cannot silently change the first occurrence', async t => {
  const f = fixture(t), name = 'tasks.createDaily', tool = f.tool(name);
  const {at, ...args} = f.args({time: '12:01', timeZone: 'UTC', limits: {maxRuns: 2, maxTotalTokens: 48000}});
  const ctx = f.context(args), preview = await tool.prepare(ctx); assert.equal(preview.firstRunAt, INITIAL + 60000);
  const allowed = f.approve(name, ctx, preview); f.advance(120000);
  await assert.rejects(tool.execute(allowed), {code: 'task_preview_stale'});
  assert.deepEqual(f.scheduler.list(), []); assert.deepEqual(f.receipts, []);
});

test('task tools reject cloud and scheduled mutation before inspecting private task data', async t => {
  const f = fixture(t), create = f.tool('tasks.createOnce'), list = f.tool('tasks.list');
  const cloud = f.context({}, {run: {id: 'cloud-source', provider: 'openai', allowCloud: true}});
  await assert.rejects(list.execute(cloud), {code: 'tasks_local_only'});
  assert.throws(() => create.prepare({...cloud, args: f.args()}), {code: 'tasks_local_only'});
  const scheduled = f.context(f.args(), {run: {id: 'scheduled-source', provider: 'ollama', allowCloud: false, provenance: {kind: 'scheduled_task'}}});
  assert.throws(() => create.prepare(scheduled), {code: 'scheduled_tool_denied'});
  assert.deepEqual((await list.execute({...scheduled, args: {}})).tasks, []);
  assert.equal(list.scheduledReadOnly, true); assert.equal(create.scheduledReadOnly, undefined);
});

test('private task reads paginate goals and preserve bounded recent receipts', async t => {
  const f = fixture(t), value = {title: 'Untrusted title', goal: '0123456789'.repeat(1000), model: 'test:local', schedule: {kind: 'once', at: new Date(INITIAL + 60000).toISOString()}, limits: {maxRuns: 1, maxTotalTokens: 24000}};
  const preview = f.scheduler.preview(value), task = await f.scheduler.create({...value, requestId: 'read-task', expectedFirstRunAt: preview.firstRunAt});
  const listed = await f.tool('tasks.list').execute(f.context({maxTasks: 1}));
  assert.equal(listed.tasks[0].id, task.id); assert.equal(listed.tasks[0].goal, undefined); assert.equal(listed.nextOffset, null);
  const result = await f.tool('tasks.read').execute(f.context({id: task.id, goalOffset: 12, maxChars: 123}));
  assert.equal(result.task.goal, value.goal.slice(12, 135)); assert.equal(result.task.nextGoalOffset, 135); assert.equal(result.task.goalChars, 10000);
  await assert.rejects(f.tool('tasks.read').execute(f.context({id: task.id, goalOffset: 10001})), {code: 'task_arguments'});
});

test('task mutations retain a committed receipt when cancellation arrives after commit', async t => {
  const f = fixture(t), name = 'tasks.createOnce', controller = new AbortController(), ctx = f.context(f.args(), {signal: controller.signal});
  const tools = createTaskTools({scheduler: {...f.scheduler, create: async input => { const result = await f.scheduler.create(input); controller.abort(); return result; }}, db: f.db, onReceipt: (id, receipt) => f.receipts.push({id, receipt}), now: () => INITIAL});
  const tool = tools.find(value => value.name === name), preview = await tool.prepare(ctx), result = await tool.execute(f.approve(name, ctx, preview));
  assert.equal(controller.signal.aborted, true); assert.equal(f.scheduler.get(result.task.id).status, 'active');
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0].receipt.taskId, result.task.id);
});

test('chat approval fails before presenting a truncated task and discovery groups stay narrow', async t => {
  const f = fixture(t), ctx = f.context(f.args({goal: '\\'.repeat(20000)}));
  assert.throws(() => f.tool('tasks.createOnce').prepare(ctx), {code: 'task_preview_too_large'});
  assert.equal(f.tool('tasks.createOnce').group, 'tasks-once'); assert.equal(f.tool('tasks.updateWeekly').group, 'tasks-update-weekly');
  assert.deepEqual(f.tools.filter(value => value.group === 'tasks').map(value => value.name).sort(), ['tasks.archive','tasks.list','tasks.pause','tasks.read','tasks.resume']);
  const now = await f.tool('clock.now').execute({}); assert.equal(now.epochMs, INITIAL); assert.equal(now.utc, new Date(INITIAL).toISOString());
});
