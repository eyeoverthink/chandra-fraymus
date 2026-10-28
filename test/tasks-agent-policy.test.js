import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { installRuntime } from '../server/runtime.js';
import { createAgentService } from '../server/agent/service.js';

const MODEL = 'task-policy-fixture:local', OLLAMA = 'http://127.0.0.1:49971';
const INITIAL = Date.UTC(2026, 9, 26, 12), TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const call = (name, args) => ({ function: { name, arguments: args } });
const done = (content = 'Synthetic fixture complete.', calls = []) => ({ done: true, done_reason: 'stop',
  prompt_eval_count: 100, eval_count: 10, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) } });
const cloud = { enabled: true, apiKey: 'synthetic-test-key-never-transmitted', maxRunCostUsd: 1,
  models: { 'fixture-cloud': { inputUsdPerMillion: 1, outputUsdPerMillion: 1, tools: true } } };
const fakeBroker = () => ({ session: () => ({ state: 'active' }), claim: () => {}, releaseRun: () => {} });
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Isolated policy fixture did not reach the expected state');
}

// No server is bound and fetch is always replaced; only an owned scratch folder
// and in-memory SQLite are used. Full-runtime cases include its real registry.
async function fixture(t, chat = () => done(), options = {}) {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), folder = await fs.mkdtemp(path.join(parent, 'tasks-policy-'));
  const original = await fs.realpath(folder), db = new DatabaseSync(':memory:');
  const workspace = path.join(folder, 'workspace'), dataDir = path.join(folder, 'data');
  await fs.mkdir(workspace); await fs.mkdir(dataDir);
  const chats = [], providerCalls = [], releases = []; let stamp = INITIAL, runtime, agent;
  const fetchImpl = async (value, request = {}) => {
    const url = new URL(value), body = request.body ? JSON.parse(request.body) : undefined;
    providerCalls.push({ origin: url.origin, path: url.pathname });
    if (url.origin === 'https://api.openai.com') {
      assert.ok(options.cloudFetch, 'A cloud transport call was not expected; no real fetch exists');
      return options.cloudFetch(url, body, request);
    }
    assert.equal(url.origin, OLLAMA, 'A request escaped the fake provider');
    if (url.pathname === '/api/show') return Response.json({ capabilities: ['completion', 'tools'] });
    if (url.pathname === '/api/tags') return Response.json({ models: [{ name: MODEL, size: 1 }] });
    assert.equal(url.pathname, '/api/chat'); chats.push(body);
    return Response.json(await chat(body, chats.length));
  };
  if (options.raw) {
    agent = createAgentService({ db, workspace, ollamaUrl: OLLAMA, fetchImpl, ...options.raw });
  } else {
    runtime = installRuntime(express(), { db, workspace, dataDir, ollamaUrl: OLLAMA, fetchImpl,
      cloud: { enabled: false }, desktopDriver: null, taskClock: () => stamp, broadcast: () => {},
      codeExecutor: { kind: 'docker', health: async () => ({ available: false }),
        run: async () => assert.fail('No native/container execution is permitted') },
      webRequestImpl: async () => assert.fail('No public web request is permitted') });
    agent = runtime.agent;
  }
  t.after(async () => {
    for (const release of releases) release();
    const result = runtime ? await runtime.close() : await agent.close({ timeoutMs: 1000 });
    assert.equal(runtime ? result.safeToCloseDatabase : result.callbacksSettled, true, 'Owned callbacks must settle before DB close');
    db.close();
    const target = await fs.realpath(folder);
    assert.equal(target, original); assert.equal(path.dirname(target), parent); assert.ok(path.basename(target).startsWith('tasks-policy-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { db, runtime, agent, chats, providerCalls, releases, advance: ms => { stamp += ms; },
    terminal: id => until(() => { const run = agent.get(id); return TERMINAL.has(run.status) && run; }),
    start: input => agent.start({ requestId: 'fixture-request', conversationId: 'fixture-conversation', goal: 'Synthetic fixture goal.', model: MODEL, ...input }) };
}

test('default-budget scheduling discovers only the advertised creation kind before asking for exact approval', async t => {
  const variants = {
    once: { suffix: 'Once', at: new Date(INITIAL + 60000).toISOString() },
    interval: { suffix: 'Interval', everyMinutes: 5, firstAt: new Date(INITIAL + 60000).toISOString() },
    daily: { suffix: 'Daily', time: '13:00', timeZone: 'UTC' },
    weekly: { suffix: 'Weekly', time: '13:00', timeZone: 'UTC', weekdays: [1, 3, 5] },
  };
  for (const [kind, { suffix, ...schedule }] of Object.entries(variants)) await t.test(kind, async t => {
    const args = { title: `Discovered ${kind} fixture`, goal: 'Return one synthetic local answer.', model: MODEL,
      limits: { maxRuns: kind === 'once' ? 1 : 2, maxTotalTokens: 48000 }, ...schedule };
    const f = await fixture(t, (body, index) => {
      const definitions = body.tools.map(item => item.function);
      if (index === 1) {
        assert.ok(!definitions.some(item => /^tasks\.(?:create|update)/.test(item.name)), 'Hidden creation names must not be guessed');
        const discovery = definitions.find(item => item.name === 'tools.enable'); assert.ok(discovery);
        const group = discovery.parameters.properties.group.enum.find(value => value === `tasks-${kind}`); assert.ok(group);
        return done('', [call(discovery.name, { group })]);
      }
      if (index === 2) {
        const creation = definitions.filter(item => item.name.startsWith('tasks.create'));
        assert.deepEqual(creation.map(item => item.name), [`tasks.create${suffix}`]);
        assert.ok(!definitions.some(item => item.name.startsWith('tasks.update')));
        return done('', [call(creation[0].name, args)]);
      }
      assert.equal(index, 3); return done('The exact approved task was saved.');
    });
    const started = await f.start({ goal: `Schedule one local ${kind} fixture.` });
    const waiting = await until(() => { const run = f.agent.get(started.id); return (run.approval || TERMINAL.has(run.status)) && run; });
    assert.equal(waiting.status, 'awaiting_approval', JSON.stringify(waiting.error));
    assert.equal(waiting.budget.maxInputTokens, 16384); assert.equal(f.chats.length, 2);
    assert.equal(waiting.approval.name, `tasks.create${suffix}`); assert.equal(waiting.approval.preview.spec.goal, args.goal);
    assert.deepEqual(waiting.approval.arguments, args); assert.equal(waiting.approval.preview.truncated, undefined);
    assert.equal(waiting.privateContextLocalOnly, true); assert.equal(f.runtime.tasks.list().length, 0);
    assert.throws(() => f.agent.approve(started.id, { approvalId: 'unrelated-approval', approved: true }), { code: 'approval_mismatch' });
    assert.equal(f.runtime.tasks.list().length, 0);
    f.agent.approve(started.id, { approvalId: waiting.approval.approvalId, approved: true });
    assert.equal((await f.terminal(started.id)).status, 'completed');
    assert.equal(f.runtime.tasks.list().length, 1); assert.equal(f.chats.length, 3);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM scheduled_task_occurrences').get().n, 0);
    assert.equal(f.db.prepare('SELECT status FROM agent_approvals').get().status, 'consumed');
  });
});

test('scheduled runs cannot load a split mutation group or bypass it with a guessed creation name', async t => {
  const args = { title: 'Forbidden recursive task', goal: 'Never create this task.', model: MODEL,
    at: new Date(INITIAL + 120000).toISOString(), limits: { maxRuns: 1, maxTotalTokens: 24000 } };
  const f = await fixture(t, (body, index) => {
    assert.ok(!body.tools.some(item => /^tasks\.(?:create|update|pause|resume|archive)/.test(item.function.name)));
    if (index === 1) return done('', [call('tools.enable', { group: 'tasks-once' })]);
    assert.equal(index, 2); return done('', [call('tasks.createOnce', args)]);
  });
  const preview = f.runtime.tasks.preview({ title: 'Authorized outer task', goal: 'Read the scheduled task list locally.', model: MODEL,
    schedule: { kind: 'once', at: new Date(INITIAL + 60000).toISOString() }, limits: { maxRuns: 1, maxTotalTokens: 24000 } });
  const task = await f.runtime.tasks.create({ ...preview.spec, requestId: 'outer-task', expectedFirstRunAt: preview.firstRunAt });
  f.advance(60000); await f.runtime.tasks.tick(); const id = f.runtime.tasks.get(task.id).currentRunId;
  const stopped = await f.terminal(id); assert.equal(stopped.error.code, 'scheduled_tool_denied');
  const events = f.agent.events(id), result = events.find(event => event.type === 'tool_result');
  assert.equal(result.data.name, 'tools.enable'); assert.equal(result.data.result.code, 'scheduled_tool_denied');
  assert.ok(!events.some(event => event.type === 'approval_required' || event.type === 'tool_started' && event.data.name.startsWith('tasks.')));
  assert.equal(f.runtime.tasks.list().length, 1); assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n, 0);
});

test('a cloud run queued before later private desktop taint cannot transmit when its turn begins', async t => {
  const entered = deferred(), gate = deferred();
  const f = await fixture(t, async (_body, index) => { if (index === 1) { entered.resolve(); await gate.promise; } return done(); },
    { raw: { cloud, desktopBroker: fakeBroker() }, cloudFetch: async () => assert.fail('Queued private run must never reach cloud transport') });
  f.releases.push(gate.resolve);
  const first = await f.start({ requestId: 'public-first' }); await entered.promise;
  const queued = await f.start({ requestId: 'cloud-queued', provider: 'openai', allowCloud: true, model: 'fixture-cloud', budget: { maxCostUsd: 1 } });
  assert.equal(queued.status, 'queued');
  const privateRun = await f.start({ requestId: 'private-later', desktopSessionId: 'synthetic-grant' });
  assert.equal(f.agent.get(queued.id).privateContextLocalOnly, true); gate.resolve();
  assert.equal((await f.terminal(first.id)).status, 'completed');
  assert.equal((await f.terminal(queued.id)).error.code, 'private_conversation_local_only');
  assert.equal((await f.terminal(privateRun.id)).status, 'completed');
  assert.equal(f.providerCalls.filter(value => value.origin === 'https://api.openai.com').length, 0);
});

test('private taint during the cloud input-count await blocks the later inference request', async t => {
  const entered = deferred(), gate = deferred(); let inferenceCalls = 0;
  const f = await fixture(t, () => done(), { raw: { cloud, desktopBroker: fakeBroker() }, cloudFetch: async url => {
    if (url.pathname === '/v1/responses/input_tokens') { entered.resolve(); await gate.promise; return Response.json({ input_tokens: 100 }); }
    inferenceCalls++; assert.fail('No cloud inference may follow private taint');
  } });
  f.releases.push(gate.resolve);
  const started = await f.start({ provider: 'openai', allowCloud: true, model: 'fixture-cloud', budget: { maxCostUsd: 1 } });
  await entered.promise;
  const local = await f.start({ requestId: 'taint-during-count', desktopSessionId: 'synthetic-grant' }); gate.resolve();
  assert.equal((await f.terminal(started.id)).error.code, 'private_conversation_local_only');
  assert.equal((await f.terminal(local.id)).status, 'completed'); assert.equal(inferenceCalls, 0);
  assert.deepEqual(f.providerCalls.filter(value => value.origin === 'https://api.openai.com').map(value => value.path), ['/v1/responses/input_tokens']);
});

for (const phase of ['prepare', 'resolver']) test(`shutdown does not report DB-safe callbacks while a cancelled ${phase} is still pending`, async t => {
  const entered = deferred(), gate = deferred(); let finished = false, executed = 0, db;
  const delayed = async () => { entered.resolve(); await gate.promise; db.prepare('SELECT 1 AS n').get(); finished = true; return phase === 'resolver' ? { text: 'Synthetic attachment excerpt.' } : {}; };
  const raw = phase === 'prepare' ? { extraTools: [{ name: 'fixture.propose', description: 'Synthetic approval preview only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, approvalRequired: true,
    prepare: delayed, execute: () => { executed++; return {}; } }] } : { resolveAttachments: delayed };
  const f = await fixture(t, () => done('', [call('fixture.propose', {})]), { raw }); db = f.db; f.releases.push(gate.resolve);
  const started = await f.start(phase === 'resolver' ? { attachments: ['synthetic-asset'] } : {}); await entered.promise;
  const pending = await f.agent.close({ timeoutMs: 20 });
  assert.equal(pending.callbacksSettled, false); assert.ok(pending.pendingCalls > 0); assert.equal(finished, false);
  assert.equal(f.agent.get(started.id).status, 'cancelled'); gate.resolve();
  const closed = await f.agent.close({ timeoutMs: 1000 }); assert.equal(closed.callbacksSettled, true);
  assert.equal(finished, true); assert.equal(executed, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n, 0);
  if (phase === 'resolver') assert.equal(f.chats.length, 0);
});
