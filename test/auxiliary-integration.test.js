import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentService } from '../server/agent/service.js';
import { createTaskScheduler } from '../server/tasks/scheduler.js';

const ORIGIN = 'http://127.0.0.1:49959', MODEL = 'auxiliary-integration:local';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const native = (name, args = {}) => ({ function: { name, arguments: args } });
const answer = (text = 'Public synthetic answer.', calls = [], input = 100, output = 10) => ({ done: true, done_reason: 'stop',
  prompt_eval_count: input, eval_count: output, message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) } });
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Owned auxiliary integration fixture did not reach its expected state');
}
async function fixture(t, options = {}) {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), directory = await fs.mkdtemp(path.join(parent, 'auxiliary-integration-'));
  const original = await fs.realpath(directory), db = new DatabaseSync(':memory:');
  const state = { db, chats: [], requests: [], events: [], syncErrors: [], releases: [], effects: 0, shows: 0 };
  let agent, scheduler, stamp = Date.UTC(2026, 9, 26, 12);
  const tool = { name: 'fixture.embed', description: 'Synthetic local embedding accounting fixture only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: context => options.tool(context, state) };
  const effect = { name: 'fixture.effect', description: 'Synthetic effect that must obey the run budget.',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => { state.effects++; return { effect: true }; } };
  agent = createAgentService({ db, workspace: directory, ollamaUrl: ORIGIN, extraTools: [tool, effect], cloud: options.cloud,
    onEvent: event => {
      state.events.push(event);
      if (scheduler && ['usage', 'auxiliary_usage'].includes(event.type)) {
        try { scheduler.reconcileUsage(agent.get(event.runId)); } catch (error) { state.syncErrors.push(error); }
      }
    },
    fetchImpl: async (value, request = {}) => {
      const url = new URL(value), body = request.body ? JSON.parse(request.body) : undefined;
      state.requests.push({ path: url.pathname, body, origin: url.origin });
      if (url.origin === 'https://api.openai.com') {
        assert.ok(options.cloudFetch, 'No live cloud transport exists'); return options.cloudFetch(url, body, state);
      }
      assert.equal(url.origin, ORIGIN, 'No live network adapter exists');
      if (url.pathname === '/api/show') {
        state.shows++; await options.show?.(state.shows, state);
        return Response.json({ capabilities: ['completion', 'tools'] });
      }
      assert.equal(url.pathname, '/api/chat'); state.chats.push(body);
      return Response.json(await options.chat(body, state.chats.length, state));
    } });
  if (options.scheduled) scheduler = createTaskScheduler({ db, now: () => stamp, agent: {
    start: body => agent.startScheduled(body), get: id => agent.get(id), getByRequestId: id => agent.getByRequestId(id),
    cancel: id => agent.cancel(id), isBusy: () => agent.isBusy() } });
  t.after(async () => {
    for (const release of state.releases) release();
    if (scheduler) assert.equal((await scheduler.close()).cleanupConfirmed, true);
    assert.equal((await agent.close({ timeoutMs: 1000 })).callbacksSettled, true); db.close();
    const target = await fs.realpath(directory); assert.equal(target, original); assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('auxiliary-integration-')); await fs.rmdir(target);
  });
  return { ...state, state, agent, scheduler, advance: ms => { stamp += ms; }, now: () => stamp,
    start: input => agent.start({ requestId: 'auxiliary-source', conversationId: 'auxiliary-conversation', goal: 'Complete the synthetic local accounting task.', model: MODEL, ...input }),
    terminal: id => until(() => { const run = agent.get(id); return ['completed', 'failed', 'cancelled'].includes(run.status) && run; }) };
}

test('known embedding input survives the next primary response with actual totals and unchanged output accounting', async t => {
  const f = await fixture(t, { tool: ({ auxiliaryInput }) => {
    const ticket = auxiliaryInput.reserve(1000), result = auxiliaryInput.settle(ticket, 500);
    assert.equal(result.overBudget, false); return { indexed: true };
  }, chat: (_body, index) => index === 1 ? answer('', [native('fixture.embed')]) : answer('Known input retained.', [], 120, 20) });
  const run = await f.start(), final = await f.terminal(run.id);
  assert.equal(final.status, 'completed'); assert.equal(final.usage.inputTokens, 720); assert.equal(final.usage.outputTokens, 30);
  assert.equal(final.usage.totalTokens, 750); assert.equal(final.usage.auxiliaryInputTokens, 500);
  assert.equal(final.usage.reservedInputTokens, 0); assert.equal(final.usage.auxiliaryUsageKnown, true); assert.equal(final.usage.costUsd, 0);
  const usages = f.agent.events(run.id).filter(event => ['usage', 'auxiliary_usage'].includes(event.type));
  assert.ok(usages.some(event => event.type === 'auxiliary_usage' && event.data.reservedInputTokens === 1000 && event.data.totalTokens === 110));
  assert.equal(usages.at(-1).data.auxiliaryInputTokens, 500); assert.equal(f.state.chats.length, 2);
});

test('auxiliary settlement while primary inference is pending is merged instead of overwritten', async t => {
  const auxiliaryGate = deferred(), primaryGate = deferred(), primaryEntered = deferred(); let settled;
  const f = await fixture(t, { tool: context => {
    const ticket = context.auxiliaryInput.reserve(1000);
    context.auxiliaryInput.track(auxiliaryGate.promise.then(() => { settled = context.auxiliaryInput.settle(ticket, 37); }));
    return { progress: true };
  }, chat: async (_body, index) => {
    if (index === 1) return answer('', [native('fixture.embed')]);
    primaryEntered.resolve(); await primaryGate.promise; return answer('Both inputs retained.', [], 80, 20);
  } });
  f.state.releases.push(auxiliaryGate.resolve, primaryGate.resolve);
  const run = await f.start(); await primaryEntered.promise;
  assert.equal(f.agent.get(run.id).usage.reservedInputTokens, 1000);
  auxiliaryGate.resolve(); await until(() => settled);
  assert.equal(settled.usage.totalTokens, 147); primaryGate.resolve();
  const final = await f.terminal(run.id); assert.equal(final.status, 'completed');
  assert.equal(final.usage.inputTokens, 217); assert.equal(final.usage.outputTokens, 30); assert.equal(final.usage.totalTokens, 247);
  assert.equal(final.usage.auxiliaryInputTokens, 37); assert.equal(final.usage.reservedInputTokens, 0);
});

test('late auxiliary settlement after cancellation is tracked and never revives terminal state', async t => {
  const gate = deferred(), entered = deferred(); let settled, context;
  const f = await fixture(t, { tool: async value => {
    context = value; const ticket = context.auxiliaryInput.reserve(500);
    const pending = context.auxiliaryInput.track(gate.promise.then(() => { settled = context.auxiliaryInput.settle(ticket, 17); }));
    entered.resolve(); await pending; return { done: true };
  }, chat: () => answer('', [native('fixture.embed')]) });
  f.state.releases.push(gate.resolve); const run = await f.start(); await entered.promise; f.agent.cancel(run.id);
  assert.equal((await f.agent.close({ timeoutMs: 20 })).callbacksSettled, false);
  assert.equal(f.agent.get(run.id).usage.reservedInputTokens, 500); gate.resolve();
  assert.equal((await f.agent.close({ timeoutMs: 1000 })).callbacksSettled, true);
  assert.equal(settled.usage.totalTokens, 127); const final = f.agent.get(run.id);
  assert.equal(final.status, 'cancelled'); assert.equal(final.error.code, 'cancelled');
  assert.equal(final.usage.auxiliaryInputTokens, 17); assert.equal(final.usage.reservedInputTokens, 0);
  assert.throws(() => context.auxiliaryInput.reserve(1), { code: 'run_inactive' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_auxiliary_inputs').get().n, 1);
  const events = f.agent.events(run.id), cancelled = events.find(event => event.type === 'cancelled');
  assert.ok(events.some(event => event.type === 'auxiliary_usage' && event.sequence > cancelled.sequence && event.data.auxiliaryInputTokens === 17));
  assert.ok(!events.some(event => event.type === 'tool_result')); assert.equal(f.state.chats.length, 1);
});

test('unknown holds block another inference and actual overage blocks later sibling effects', async t => {
  await t.test('outstanding hold consumes inference headroom without becoming actual tokens', async t => {
    const f = await fixture(t, { tool: ({ auxiliaryInput }) => { auxiliaryInput.reserve(auxiliaryInput.remaining()); return { progress: true }; },
      chat: () => answer('', [native('fixture.embed')]) });
    const run = await f.start(), final = await f.terminal(run.id);
    assert.equal(final.error.code, 'budget_tokens'); assert.equal(final.usage.totalTokens, 110);
    assert.equal(final.usage.auxiliaryInputTokens, 0); assert.equal(final.usage.reservedInputTokens, 23890);
    assert.equal(final.usage.auxiliaryUsageKnown, false); assert.equal(f.state.chats.length, 1);
  });
  await t.test('unclamped actual overage prevents the next already-proposed effect', async t => {
    const f = await fixture(t, { tool: ({ auxiliaryInput }) => {
      const remaining = auxiliaryInput.remaining(), ticket = auxiliaryInput.reserve(remaining);
      assert.equal(auxiliaryInput.settle(ticket, remaining + 1).overBudget, true); return { ignoredOverage: true };
    }, chat: () => answer('', [native('fixture.embed'), native('fixture.effect')]) });
    const run = await f.start(), final = await f.terminal(run.id);
    assert.equal(final.error.code, 'budget_tokens'); assert.equal(final.usage.totalTokens, 24001);
    assert.equal(f.state.effects, 0); assert.equal(f.state.chats.length, 1);
    assert.ok(!f.agent.events(run.id).some(event => event.type === 'tool_started' && event.data.name === 'fixture.effect'));
  });
});

test('fresh local pre-dispatch guard observes a late settle during show and refuses stale inference allowance', async t => {
  const gate = deferred(), showGate = deferred(), showEntered = deferred(); let settled;
  const f = await fixture(t, { tool: context => {
    const ticket = context.auxiliaryInput.reserve(1000);
    context.auxiliaryInput.track(gate.promise.then(() => { settled = context.auxiliaryInput.settle(ticket, 23000); }));
    return { progress: true };
  }, show: async index => { if (index === 3) { showEntered.resolve(); await showGate.promise; } },
  chat: (_body, index) => { assert.equal(index, 1, 'No second inference may use the stale allowance'); return answer('', [native('fixture.embed')]); } });
  f.state.releases.push(gate.resolve, showGate.resolve); const run = await f.start(); await showEntered.promise;
  gate.resolve(); await until(() => settled); assert.equal(settled.overBudget, false);
  assert.equal(settled.usage.totalTokens, 23110); showGate.resolve();
  const final = await f.terminal(run.id); assert.equal(final.error.code, 'budget_tokens');
  assert.equal(final.usage.totalTokens, 23110); assert.equal(f.state.chats.length, 1); assert.equal(f.state.shows, 3);
});

test('terminal scheduled unknown hold is reconciled by a late zero settlement without changing actual total or replaying', async t => {
  const gate = deferred(); let settled;
  const f = await fixture(t, { scheduled: true, tool: context => {
    const ticket = context.auxiliaryInput.reserve(500);
    context.auxiliaryInput.track(gate.promise.then(() => { settled = context.auxiliaryInput.settle(ticket, 0); }));
    return { progress: true };
  }, chat: (_body, index) => index === 1 ? answer('', [native('fixture.embed')]) : answer('Completed with an unresolved auxiliary receipt.') });
  f.state.releases.push(gate.resolve);
  const preview = f.scheduler.preview({ title: 'Late receipt fixture', goal: 'Run the synthetic local accounting fixture.', model: MODEL,
    schedule: { kind: 'once', at: new Date(f.now() + 60000).toISOString() }, limits: { maxRuns: 1, maxTotalTokens: 24000 } });
  const task = await f.scheduler.create({ ...preview.spec, requestId: 'late-accounting-task', expectedFirstRunAt: preview.firstRunAt });
  f.advance(60000); await f.scheduler.tick(); const runId = f.scheduler.get(task.id).lastRunId;
  const completed = await f.terminal(runId); assert.equal(completed.status, 'completed'); assert.equal(completed.usage.totalTokens, 220);
  await f.scheduler.tick(); const before = f.scheduler.get(task.id);
  assert.equal(before.status, 'attention'); assert.equal(before.attention.code, 'task_usage_uncertain');
  assert.equal(before.history[0].status, 'completed'); assert.equal(before.reservedTokens, 23780); assert.equal(before.usedTokens, 220);
  gate.resolve(); await until(() => settled); const after = f.scheduler.get(task.id);
  assert.equal(settled.usage.totalTokens, 220); assert.equal(settled.usage.auxiliaryUsageKnown, true);
  assert.equal(after.status, 'completed'); assert.equal(after.attention, null); assert.equal(after.reservedTokens, 0);
  assert.equal(after.usedTokens, 220); assert.equal(after.runsStarted, 1); assert.equal(after.currentRunId, null);
  assert.equal(f.agent.get(runId).status, 'completed'); assert.equal(f.state.chats.length, 2); assert.deepEqual(f.state.syncErrors, []);
});

test('terminal scheduled output-only hold releases on late same-total settlement without replay',async t=>{
  const gate=deferred();let settled;
  const f=await fixture(t,{scheduled:true,tool:context=>{
    const ticket=context.auxiliaryInput.reserveGeneration(500,256);context.auxiliaryInput.partialGeneration(ticket,{inputTokens:0});
    context.auxiliaryInput.track(gate.promise.then(()=>{settled=context.auxiliaryInput.settleGeneration(ticket,{inputTokens:0,outputTokens:0});}));return {progress:true};
  },chat:(_body,index)=>index===1?answer('',[native('fixture.embed')]):answer('Completed with pending output usage.')});
  f.state.releases.push(gate.resolve);
  const preview=f.scheduler.preview({title:'Late output receipt',goal:'Run the synthetic accounting fixture.',model:MODEL,schedule:{kind:'once',at:new Date(f.now()+60000).toISOString()},limits:{maxRuns:1,maxTotalTokens:24000}});
  const task=await f.scheduler.create({...preview.spec,requestId:'late-output-task',expectedFirstRunAt:preview.firstRunAt});f.advance(60000);await f.scheduler.tick();
  const runId=f.scheduler.get(task.id).lastRunId,completed=await f.terminal(runId);assert.equal(completed.usage.reservedInputTokens,0);assert.equal(completed.usage.reservedOutputTokens,256);assert.equal(completed.usage.totalTokens,220);
  await f.scheduler.tick();assert.equal(f.scheduler.get(task.id).attention.code,'task_usage_uncertain');assert.equal(f.scheduler.get(task.id).reservedTokens,23780);
  gate.resolve();await until(()=>settled);const after=f.scheduler.get(task.id);assert.equal(after.status,'completed');assert.equal(after.reservedTokens,0);assert.equal(after.usedTokens,220);assert.equal(after.runsStarted,1);
  assert.equal(f.agent.get(runId).status,'completed');assert.equal(f.agent.get(runId).usage.reservedOutputTokens,0);assert.equal(f.state.chats.length,2);assert.deepEqual(f.state.syncErrors,[]);
});

test('local embedding input survives cloud cost reservation and response updates without adding USD cost', async t => {
  let responses = 0, settled; const gate = deferred();
  const f = await fixture(t, { cloud: { enabled: true, apiKey: 'synthetic-test-key-never-transmitted', maxRunCostUsd: 1,
    models: { 'fixture-cloud': { inputUsdPerMillion: 1, outputUsdPerMillion: 2, tools: true } } },
  tool: ({ auxiliaryInput }, state) => {
    const ticket = auxiliaryInput.reserve(1000); state.releases.push(gate.resolve);
    auxiliaryInput.track(gate.promise.then(() => { settled = auxiliaryInput.settle(ticket, 500); }));
    return { progress: true };
  },
  chat: () => assert.fail('Cloud run must not use the local chat transport'),
  cloudFetch: async (url, body, state) => {
    if (url.pathname === '/v1/responses/input_tokens') {
      if (responses === 1) {
        const before = JSON.parse(state.db.prepare('SELECT usage_json FROM agent_runs').get().usage_json);
        assert.equal(before.reservedInputTokens, 1000); gate.resolve(); await until(() => settled);
        assert.equal(settled.usage.auxiliaryInputTokens, 500);
      }
      return Response.json({ input_tokens: 100 });
    }
    assert.equal(url.pathname, '/v1/responses'); responses++;
    if (responses === 1) {
      const alias = body.tools.find(tool => tool.description.startsWith('fixture.embed:')); assert.ok(alias);
      return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 10 },
        output: [{ type: 'function_call', id: 'synthetic-function', call_id: 'synthetic-call', name: alias.name, arguments: '{}' }] });
    }
    assert.equal(responses, 2);
    const reservation = state.events.filter(event => event.type === 'status' && event.data.reservation).at(-1);
    assert.equal(reservation.data.reservation.inputTokens, 100);
    const pendingCost = JSON.parse(state.db.prepare('SELECT usage_json FROM agent_runs').get().usage_json);
    assert.equal(pendingCost.auxiliaryInputTokens, 500); assert.equal(pendingCost.reservedInputTokens, 0);
    assert.equal(pendingCost.costStatus, 'reserved'); assert.ok(pendingCost.reservedCostUsd > 0);
    assert.ok(Math.abs(pendingCost.costUsd - 0.00012) < 1e-12);
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 10 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Cloud answer after local embeddings.' }] }] });
  } });
  const run = await f.start({ provider: 'openai', allowCloud: true, model: 'fixture-cloud', budget: { maxCostUsd: 1 } });
  const final = await f.terminal(run.id); assert.equal(final.status, 'completed', JSON.stringify(final.error));
  assert.equal(final.usage.inputTokens, 700); assert.equal(final.usage.outputTokens, 20); assert.equal(final.usage.totalTokens, 720);
  assert.equal(final.usage.auxiliaryInputTokens, 500); assert.equal(final.usage.reservedInputTokens, 0);
  assert.ok(Math.abs(final.usage.costUsd - 0.00024) < 1e-12); assert.equal(final.usage.reservedCostUsd, undefined);
  assert.equal(responses, 2); assert.equal(f.state.chats.length, 0);
});
