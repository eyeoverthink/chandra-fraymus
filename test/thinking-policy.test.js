import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentService } from '../server/agent/service.js';
import { createTaskScheduler } from '../server/tasks/scheduler.js';
import { hash, stableJson } from '../server/agent/schema.js';

const ORIGIN = 'http://127.0.0.1:49963', MODEL = 'thinking-policy:local';
const DEFAULT_BUDGET = { maxSteps: 8, maxToolCalls: 12, maxInputTokens: 16384, maxOutputTokens: 2048,
  maxTotalTokens: 24000, maxDurationMs: 180000, maxToolResultChars: 12000, maxOutputChars: 32000, maxCostUsd: 0 };
const controls = { values: [false, true, 'false', 'low', 'high'], default: 'low' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const native = (name, args) => ({ function: { name, arguments: args } });
function completion(content = 'Public fixture answer.', { trace, calls = [], input = 40, output = 10 } = {}) {
  return { done: true, done_reason: 'stop', prompt_eval_count: input, eval_count: output,
    message: { role: 'assistant', content, ...(trace !== undefined ? { thinking: trace } : {}), ...(calls.length ? { tool_calls: calls } : {}) } };
}
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Owned thinking policy fixture did not reach its expected state');
}
async function fixture(t, chat = () => completion(), { metadata = () => ({ thinking: controls }) } = {}) {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), folder = await fs.mkdtemp(path.join(parent, 'thinking-policy-'));
  const original = await fs.realpath(folder), db = new DatabaseSync(':memory:'), requests = [], chats = [], releases = [], closers = [];
  let shows = 0;
  const agent = createAgentService({ db, workspace: folder, ollamaUrl: ORIGIN,
    fetchImpl: async (value, options = {}) => {
      const url = new URL(value); assert.equal(url.origin, ORIGIN, 'No live network adapter exists');
      const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path: url.pathname, body });
      if (url.pathname === '/api/show') return Response.json({ capabilities: ['completion', 'tools', 'thinking'], ...metadata(++shows) });
      if (url.pathname === '/api/tags') return Response.json({ models: [{ name: MODEL, size: 1 }] });
      assert.equal(url.pathname, '/api/chat'); chats.push(body); return Response.json(await chat(body, chats.length));
    } });
  t.after(async () => {
    for (const release of releases) release();
    for (const close of closers) await close();
    const result = await agent.close({ timeoutMs: 1000 }); assert.equal(result.callbacksSettled, true); db.close();
    const target = await fs.realpath(folder); assert.equal(target, original); assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('thinking-policy-')); await fs.rmdir(target);
  });
  const start = input => agent.start({ requestId: 'thinking-source', conversationId: 'thinking-conversation',
    goal: 'Answer the synthetic fixture question.', model: MODEL, ...input });
  const terminal = id => until(() => { const run = agent.get(id); return ['completed', 'failed', 'cancelled'].includes(run.status) && run; });
  function publicData(id) {
    const tables = ['agent_runs', 'agent_run_events', 'agent_messages', 'agent_memory', 'agent_approvals', 'agent_workspace_effects'];
    return JSON.stringify({ run: agent.get(id), runs: agent.list(), events: agent.events(id),
      tables: Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name}`).all()])) });
  }
  return { db, agent, requests, chats, releases, closers, start, terminal, publicData, shows: () => shows };
}

test('historical default request shape/hash survives null while false is a distinct persisted override', async t => {
  const f = await fixture(t), input = { requestId: 'historical-default', conversationId: 'historical-conversation',
    goal: 'Return the historical fixture answer.', model: MODEL };
  const historical = { ...input, budget: DEFAULT_BUDGET, attachments: [], provider: 'ollama', allowCloud: false };
  const first = await f.start(input); await f.terminal(first.id);
  const row = f.db.prepare('SELECT input_hash,request_json FROM agent_runs WHERE id=?').get(first.id);
  assert.equal(row.input_hash, hash(stableJson(historical))); assert.deepEqual(JSON.parse(row.request_json), historical);
  assert.equal(Object.hasOwn(f.agent.get(first.id), 'thinking'), false); assert.equal(Object.hasOwn(f.chats[0], 'think'), false);
  assert.equal((await f.start({ ...input, thinking: null })).id, first.id);
  assert.equal((await f.start({ ...input, thinking: undefined })).id, first.id); assert.equal(f.chats.length, 1);
  assert.equal(f.db.prepare('SELECT input_hash FROM agent_runs WHERE id=?').get(first.id).input_hash, row.input_hash);
  await assert.rejects(f.start({ ...input, thinking: false }), { code: 'idempotency_conflict' });
  const disabled = await f.start({ ...input, requestId: 'explicit-false', thinking: false }); await f.terminal(disabled.id);
  assert.equal(f.agent.get(disabled.id).thinking, false); assert.equal(f.agent.list().find(run => run.id === disabled.id).thinking, false);
  assert.equal(JSON.parse(f.db.prepare('SELECT request_json FROM agent_runs WHERE id=?').get(disabled.id).request_json).thinking, false);
  assert.equal(f.chats[1].think, false); assert.equal(typeof f.chats[1].think, 'boolean');
  await assert.rejects(f.start({ ...input, requestId: 'explicit-false', thinking: 'false' }), { code: 'idempotency_conflict' });
  await assert.rejects(f.start({ ...input, requestId: 'explicit-false', thinking: null }), { code: 'idempotency_conflict' });
  assert.equal(f.chats.length, 2);
});

test('explicit cloud overrides fail before any transport or durable run, while null is omitted', async t => {
  const f = await fixture(t);
  for (const thinking of [false, true, 'low']) await assert.rejects(f.start({ provider: 'openai', allowCloud: true,
    model: 'synthetic-cloud', thinking, budget: { maxCostUsd: 1 } }), { code: 'thinking_local_only' });
  await assert.rejects(f.start({ provider: 'openai', allowCloud: true, model: 'synthetic-cloud', thinking: null,
    budget: { maxCostUsd: 1 } }), { code: 'cloud_disabled' });
  assert.equal(f.requests.length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs').get().n, 0);
});

test('private continuation reaches the same local tool loop only and is absent from persisted/public history', async t => {
  const sentinel = 'PRIVATE_LOCAL_CONTINUATION_SENTINEL', answerTrace = 'PRIVATE_ANSWER_ONLY_SENTINEL';
  const f = await fixture(t, (body, index) => {
    if (index === 1) return completion('', { trace: sentinel, calls: [native('memory.remember', { key: 'public-note', value: 'Public fixture note.' })], input: 120, output: 80 });
    if (index === 2) {
      const prior = body.messages.find(message => message.role === 'assistant' && message.tool_calls?.length);
      assert.equal(prior.thinking, sentinel); assert.equal(prior.content, ''); assert.equal(body.think, 'low');
      return completion('Public final answer.', { trace: answerTrace, input: 60, output: 15 });
    }
    assert.equal(index, 3); assert.ok(!JSON.stringify(body.messages).includes(sentinel));
    assert.ok(!body.messages.some(message => Object.hasOwn(message, 'thinking'))); assert.equal(Object.hasOwn(body, 'think'), false);
    return completion('A separate public follow-up.');
  });
  const started = await f.start({ thinking: 'low' }), finished = await f.terminal(started.id);
  assert.equal(finished.status, 'completed'); assert.equal(finished.output, 'Public final answer.');
  assert.deepEqual(finished.usage, { inputTokens: 180, outputTokens: 95, totalTokens: 275, costUsd: 0 });
  const usage = f.agent.events(started.id).filter(event => event.type === 'usage');
  assert.ok(usage[1].data.estimatedInputTokens > usage[0].data.estimatedInputTokens + Buffer.byteLength(sentinel));
  assert.equal(f.db.prepare('SELECT value FROM agent_memory').get().value, 'Public fixture note.');
  assert.ok(!f.publicData(started.id).includes(sentinel)); assert.ok(!f.publicData(started.id).includes(answerTrace));
  const followup = await f.start({ requestId: 'private-does-not-cross-runs', goal: 'A public follow-up.' });
  assert.equal((await f.terminal(followup.id)).status, 'completed'); assert.equal(f.chats.length, 3);
});

test('invalid private tool continuation preserves actual usage and prevents effects or public content', async t => {
  for (const [name, trace] of [['malformed', '\ud800PRIVATE_BAD_TRACE'], ['UTF8 bytes', 'PRIVATE_BYTE_OVERFLOW:' + '界'.repeat(24000)]]) await t.test(name, async t => {
    const f = await fixture(t, () => completion('This public content must not be emitted after a provider failure.',
      { trace, calls: [native('memory.remember', { key: 'must-not-exist', value: 'No effect.' })], input: 100, output: 23 }));
    const started = await f.start({ thinking: 'low' }), failed = await f.terminal(started.id);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'provider_error'); assert.equal(failed.output, '');
    assert.deepEqual(failed.usage, { inputTokens: 100, outputTokens: 23, totalTokens: 123, costUsd: 0 });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_memory').get().n, 0); assert.equal(f.chats.length, 1);
    assert.ok(!f.agent.events(started.id).some(event => ['tool_started', 'approval_required', 'text_delta'].includes(event.type)));
    assert.ok(!f.publicData(started.id).includes('PRIVATE_BAD_TRACE')); assert.ok(!f.publicData(started.id).includes('PRIVATE_BYTE_OVERFLOW'));
  });
});

test('a globally bounded trace exceeding run context stops before any returned tool effect', async t => {
  const trace = 'PRIVATE_RUN_CONTEXT_SENTINEL:' + 'x'.repeat(12000);
  const f = await fixture(t, () => completion('', { trace,
    calls: [native('memory.remember', { key: 'must-not-exist', value: 'No effect.' })], input: 100, output: 1000 }));
  const started = await f.start({ thinking: 'low' }), failed = await f.terminal(started.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'budget_context');
  assert.equal(failed.usage.outputTokens, 1000); assert.equal(f.chats.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_memory').get().n, 0);
  assert.ok(!f.agent.events(started.id).some(event => event.type === 'tool_started' || event.type === 'approval_required'));
  assert.ok(!f.publicData(started.id).includes('PRIVATE_RUN_CONTEXT_SENTINEL'));
});

test('a reasoning choice revoked between tool rounds blocks the second inference despite cached work metadata', async t => {
  const f = await fixture(t, () => completion('', { trace: 'PRIVATE_REVOKED_TRACE', calls: [native('memory.search', { query: 'fixture' })] }),
    { metadata: index => ({ thinking: { values: index <= 2 ? ['low', 'high'] : ['low'], default: 'low' } }) });
  const started = await f.start({ thinking: 'high' }), failed = await f.terminal(started.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'thinking_unsupported');
  assert.equal(f.shows(), 3); assert.equal(f.chats.length, 1); assert.equal(f.chats[0].think, 'high');
  assert.equal(failed.usage.totalTokens, 50); assert.ok(f.agent.events(started.id).some(event => event.type === 'tool_result'));
  assert.ok(!f.publicData(started.id).includes('PRIVATE_REVOKED_TRACE'));
});

test('scheduled default payload/hash stays unchanged and defined reasoning cannot attach to its frozen authority', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, async () => { entered.resolve(); await gate.promise; return completion(); }); f.releases.push(gate.resolve);
  let stamp = Date.UTC(2026, 9, 26, 12), forged = false;
  const lookup = requestId => { const run = f.agent.getByRequestId(requestId); return forged && run ? { ...run, thinking: false } : run; };
  const scheduler = createTaskScheduler({ db: f.db, now: () => stamp, agent: { start: body => f.agent.startScheduled(body),
    get: id => f.agent.get(id), getByRequestId: lookup, cancel: id => f.agent.cancel(id), isBusy: () => f.agent.isBusy() } });
  f.closers.push(() => scheduler.close());
  const preview = scheduler.preview({ title: 'Frozen thinking default', goal: 'Return the synthetic scheduled answer.', model: MODEL,
    schedule: { kind: 'once', at: new Date(stamp + 60000).toISOString() }, limits: { maxRuns: 1, maxTotalTokens: 24000 } });
  const task = await scheduler.create({ ...preview.spec, requestId: 'scheduled-default', expectedFirstRunAt: preview.firstRunAt });
  stamp += 60000; await scheduler.tick(); await entered.promise;
  const row = f.db.prepare('SELECT * FROM scheduled_task_occurrences').get(), frozen = JSON.parse(row.request_json);
  assert.equal(Object.hasOwn(frozen, 'thinking'), false); assert.equal(hash(stableJson(frozen)), row.request_hash);
  const oldShape = { requestId: row.request_id, conversationId: `task:${task.id}:g1`, goal: preview.spec.goal, model: MODEL,
    provider: 'ollama', allowCloud: false, budget: { ...DEFAULT_BUDGET, maxDurationMs: 300000 }, attachments: [] };
  assert.equal(stableJson(frozen), stableJson(oldShape)); assert.equal(row.request_hash, hash(stableJson(oldShape)));
  const run = f.agent.getByRequestId(row.request_id); assert.equal(Object.hasOwn(run, 'thinking'), false);
  assert.equal((await f.agent.startScheduled({ ...frozen, thinking: null })).id, run.id);
  await assert.rejects(async () => f.agent.startScheduled({ ...frozen, thinking: false }), { code: 'scheduled_provenance' });
  forged = true; await scheduler.tick();
  assert.equal(scheduler.get(task.id).status, 'attention'); assert.equal(scheduler.get(task.id).history[0].status, 'unknown');
  assert.equal(f.db.prepare('SELECT request_hash FROM scheduled_task_occurrences').get().request_hash, row.request_hash);
  assert.equal(f.chats.length, 1); gate.resolve(); assert.equal((await f.terminal(run.id)).status, 'completed');
});
