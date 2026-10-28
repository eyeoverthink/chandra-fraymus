import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createAgentService } from '../server/agent/service.js';
import { createWorkspacePolicy } from '../server/agent/workspace.js';
import { createOllamaProvider } from '../server/agent/provider.js';
import { createOpenAIProvider } from '../server/agent/openai-provider.js';
import { boundedResult, hash } from '../server/agent/schema.js';
import { toolObservation } from '../server/agent/tool-observation.js';
import { encodeRgbaPng } from '../server/transport/rgba.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await delay(5); }
  assert.fail('Timed out waiting for test state');
}
const done = (content = 'Finished.', toolCalls = [], usage = {}) => ({ done: true, done_reason: 'stop', message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, prompt_eval_count: usage.inputTokens ?? 100, eval_count: usage.outputTokens ?? 10 });
const toolCall = (name, args) => ({ function: { name, arguments: args } });
function mockFetch(handler = () => done(), capabilities = ['completion', 'tools']) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const endpoint = new URL(url).pathname;
    if (endpoint === '/api/tags') return Response.json({ models: [{ name: 'test:local', size: 123 }] });
    if (endpoint === '/api/show') return Response.json({ capabilities });
    assert.equal(endpoint, '/api/chat');
    calls.push(body);
    const result = await handler(body, calls.length, options.signal);
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetchImpl, calls };
}
async function fixture(t, handler, options = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'chandra-agent-'));
  const originalFolder = await fs.realpath(folder), temporaryParent = await fs.realpath(os.tmpdir());
  const workspace = path.join(folder, 'workspace'); await fs.mkdir(workspace);
  const db = new DatabaseSync(path.join(folder, 'test.db'));
  const mock = mockFetch(handler, options.modelCapabilities);
  const service = createAgentService({ db, workspace, fetchImpl: mock.fetchImpl, ...options });
  t.after(async () => {
    for (const run of service.list()) if (!['completed', 'failed', 'cancelled'].includes(run.status)) service.cancel(run.id);
    await delay(15); db.close();
    const target = await fs.realpath(folder);
    assert.equal(target, originalFolder); assert.equal(path.dirname(target), temporaryParent); assert.ok(path.basename(target).startsWith('chandra-agent-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const start = request => service.start({ requestId: 'req-1', conversationId: 'conv-1', goal: 'Read the project and answer.', model: 'test:local', ...request });
  const terminal = id => until(() => { const run = service.get(id); return ['completed', 'failed', 'cancelled'].includes(run.status) && run; });
  return { folder, workspace, db, service, start, terminal, ...mock };
}

test('native tool round executes a real scoped read, persists usage and replayable events', async t => {
  const f = await fixture(t, (body, index) => {
    if (index === 1) return done('', [toolCall('workspace.read', { path: 'hello.txt' })]);
    const message = body.messages.at(-1);
    assert.equal(message.role, 'tool'); assert.equal(message.tool_name, 'workspace.read');
    assert.match(message.content, /UNTRUSTED TOOL OUTPUT/); assert.match(message.content, /hello world/);
    return done('The file says hello world.');
  });
  await fs.writeFile(path.join(f.workspace, 'hello.txt'), 'hello world');
  const run = await f.start(); const result = await f.terminal(run.id);
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'The file says hello world.');
  assert.equal(result.usage.totalTokens, 220); assert.equal(result.usage.costUsd, 0);
  const events = f.service.events(run.id);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
  assert.ok(events.some(event => event.type === 'tool_result' && event.data.result.sha256 === hash('hello world')));
  assert.deepEqual(f.service.events(run.id, events.at(-2).sequence), events.slice(-1));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n, 2);
});

test('chat-only models work without tools; unexpected tool invocation fails explicitly', async t => {
  const f = await fixture(t, body => { assert.equal(body.tools, undefined); return done('A normal answer.'); }, { modelCapabilities: ['completion'] });
  assert.equal((await f.terminal((await f.start()).id)).status, 'completed');
  const g = await fixture(t, () => done('', [toolCall('workspace.list', {})]), { modelCapabilities: ['completion'] });
  const result = await g.terminal((await g.start()).id);
  assert.equal(result.error.code, 'model_tools_unsupported');
});

test('idempotency rejects changed input and conversation runs serialize without stale history', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async (body, index) => {
    if (index === 1) await gate;
    if (index === 2) assert.ok(body.messages.some(message => message.role === 'assistant' && message.content === 'First answer.'));
    return done(index === 1 ? 'First answer.' : 'Second answer.');
  });
  const [one, same] = await Promise.all([f.start(), f.start()]);
  assert.equal(one.id, same.id);
  await assert.rejects(f.start({ goal: 'Different input' }), { code: 'idempotency_conflict' });
  const two = await f.start({ requestId: 'req-2', goal: 'Second question' });
  await until(() => f.calls.length === 1); await delay(20);
  assert.equal(f.calls.length, 1); assert.equal(f.service.get(two.id).status, 'queued');
  release();
  assert.equal((await f.terminal(one.id)).status, 'completed');
  assert.equal((await f.terminal(two.id)).status, 'completed');
  const implicit = await f.service.start({ requestId: 'implicit', goal: 'Hi', model: 'test:local' });
  assert.equal((await f.service.start({ requestId: 'implicit', goal: 'Hi', model: 'test:local' })).id, implicit.id);
  await f.terminal(implicit.id);
});

test('approval is exact, persisted, immutable, consumed once, and required before writing', async t => {
  let callbackMutationBlocked = false;
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('workspace.write', { path: 'new.txt', content: 'approved text', createOnly: true })]) : done('Written.'), {
    onEvent: event => { if (event.type === 'approval_required') { try { event.data.arguments.content = 'changed'; } catch { callbackMutationBlocked = true; } } },
  });
  const run = await f.start();
  const pending = await until(() => f.service.get(run.id)?.approval);
  await assert.rejects(fs.readFile(path.join(f.workspace, 'new.txt')), { code: 'ENOENT' });
  assert.throws(() => f.service.approve(run.id, { approvalId: 'wrong', approved: true }), { code: 'approval_mismatch' });
  assert.throws(() => f.service.approve(run.id, { approvalId: pending.approvalId, approved: true, arguments: {} }), { code: 'invalid_approval' });
  assert.ok(callbackMutationBlocked);
  const stored = f.db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(pending.approvalId);
  assert.equal(JSON.parse(stored.args_json).content, 'approved text');
  f.service.approve(run.id, { approvalId: pending.approvalId, approved: true });
  assert.equal((await f.terminal(run.id)).status, 'completed');
  assert.equal(await fs.readFile(path.join(f.workspace, 'new.txt'), 'utf8'), 'approved text');
  assert.equal(f.db.prepare('SELECT status FROM agent_approvals WHERE id=?').get(pending.approvalId).status, 'consumed');
  assert.throws(() => f.service.approve(run.id, { approvalId: pending.approvalId, approved: true }), { code: 'approval_mismatch' });
});

test('tampered persisted approval and changed files cannot authorize different writes', async t => {
  const f = await fixture(t, () => done('', [toolCall('workspace.write', { path: 'new.txt', content: 'approved', createOnly: true })]));
  const run = await f.start(); const pending = await until(() => f.service.get(run.id)?.approval);
  f.db.prepare('UPDATE agent_approvals SET args_json=? WHERE id=?').run(JSON.stringify({ path: 'other.txt', content: 'tampered', createOnly: true }), pending.approvalId);
  f.service.approve(run.id, { approvalId: pending.approvalId, approved: true });
  assert.equal((await f.terminal(run.id)).error.code, 'approval_mismatch');
  await assert.rejects(fs.access(path.join(f.workspace, 'new.txt')), { code: 'ENOENT' });

  const g = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('workspace.write', { path: 'existing.txt', content: 'new', expectedHash: hash('old') })]) : done('Conflict reported.'));
  await fs.writeFile(path.join(g.workspace, 'existing.txt'), 'old');
  const changed = await g.start(); const approval = await until(() => g.service.get(changed.id)?.approval);
  await fs.writeFile(path.join(g.workspace, 'existing.txt'), 'external edit');
  g.service.approve(changed.id, { approvalId: approval.approvalId, approved: true });
  await g.terminal(changed.id);
  assert.equal(await fs.readFile(path.join(g.workspace, 'existing.txt'), 'utf8'), 'external edit');
  assert.ok(g.service.events(changed.id).some(event => event.type === 'tool_result' && event.data.result.code === 'write_conflict'));
});

test('policy rejects traversal, secret paths, symlink files and junction parents', async t => {
  const f = await fixture(t); const policy = createWorkspacePolicy(f.workspace);
  await fs.writeFile(path.join(f.folder, 'outside.txt'), 'private outside');
  for (const value of ['../outside.txt', '..\\outside.txt', '/etc/passwd', 'C:\\outside.txt', '.env', '.git/config', 'credentials.json', 'private.key', 'api-key.json', '.git-credentials', 'file.txt:stream', 'CON']) {
    await assert.rejects(policy.read(value), { code: 'path_denied' }, value);
  }
  await fs.symlink(f.folder, path.join(f.workspace, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(policy.read('junction/outside.txt'), { code: 'path_denied' });
  await assert.rejects(policy.write({ path: 'junction/new.txt', content: 'no', createOnly: true }), { code: 'path_denied' });
  await fs.link(path.join(f.folder, 'outside.txt'), path.join(f.workspace, 'hardlink.txt'));
  await assert.rejects(policy.read('hardlink.txt'), { code: 'path_denied' });
  if (process.platform !== 'win32') {
    await fs.symlink(path.join(f.folder, 'outside.txt'), path.join(f.workspace, 'link.txt'));
    await assert.rejects(policy.read('link.txt'), { code: 'path_denied' });
  }
});

test('schema errors prevent tool execution, and results are bounded even with escaped data', async t => {
  let executed = false;
  const extra = { name: 'test.echo', description: 'Test echo', parameters: { type: 'object', properties: { value: { type: 'string', maxLength: 10 } }, required: ['value'], additionalProperties: false }, execute: () => { executed = true; return {}; } };
  const f = await fixture(t, () => done('', [toolCall('test.echo', { value: 'fine', unexpected: true })]), { extraTools: [extra] });
  const result = await f.terminal((await f.start()).id);
  assert.equal(result.error.code, 'invalid_arguments'); assert.equal(executed, false);
  assert.equal(f.calls.length, 2); assert.ok(!f.service.events(result.id).some(event => event.type === 'tool_started'));
  assert.deepEqual(f.service.events(result.id).find(event=>event.type==='tool_result').data.arguments,{value:'fine',unexpected:true});
  assert.deepEqual(f.service.events(result.id).filter(event => event.type === 'tool_result').map(event => event.data.result.retryable), [true, false]);
  const bounded = boundedResult({ text: '\u0000"\\'.repeat(2000) }, 256);
  assert.ok(bounded.text.length <= 256); assert.equal(bounded.value.truncated, true);
  assert.throws(() => createAgentService({ db: f.db, workspace: f.workspace, extraTools: [{ ...extra, name: 'bad', parameters: { type: 'object', anyOf: [] } }] }), { code: 'invalid_tool' });
});

test('actual usage limits, preflight context, step/tool limits, and text bounds stop work', async t => {
  const over = await fixture(t, () => done('Must not be displayed', [], { outputTokens: 11 }));
  const exceeded = await over.terminal((await over.start({ budget: { maxOutputTokens: 10 } })).id);
  assert.equal(exceeded.error.code, 'budget_tokens'); assert.equal(exceeded.usage.outputTokens, 11); assert.equal(exceeded.output, '');
  const tiny = await fixture(t);
  const context = await tiny.terminal((await tiny.start({ budget: { maxInputTokens: 1024 } })).id);
  assert.equal(context.error.code, 'budget_context'); assert.equal(tiny.calls.length, 0);
  const step = await fixture(t, () => done('', [toolCall('memory.remember', { key: 'a', value: 'b' })]));
  const final = await step.terminal((await step.start({ budget: { maxSteps: 1 } })).id);
  assert.equal(final.error.code, 'budget_steps'); assert.equal(step.db.prepare('SELECT COUNT(*) AS n FROM agent_memory').get().n, 0);
  const tools = await fixture(t, () => done('', [toolCall('workspace.list', {})]));
  assert.equal((await tools.terminal((await tools.start({ budget: { maxToolCalls: 0 } })).id)).error.code, 'budget_tools');
  const output = await fixture(t, () => done('too much output'));
  assert.equal((await output.terminal((await output.start({ budget: { maxOutputChars: 3 } })).id)).error.code, 'budget_output');
  const total = await fixture(t);
  assert.equal((await total.terminal((await total.start({ budget: { maxTotalTokens: 1 } })).id)).error.code, 'budget_tokens');
  assert.equal(total.calls.length, 0);
});

test('cancellation releases an uncooperative provider and a same-conversation queued run', async t => {
  const f = await fixture(t, (_body, index) => index === 1 ? new Promise(() => {}) : done('Second completes.'));
  const one = await f.start(); const two = await f.start({ requestId: 'req-2' });
  await until(() => f.calls.length === 1);
  f.service.cancel(one.id);
  assert.equal((await f.terminal(one.id)).status, 'cancelled');
  assert.equal((await f.terminal(two.id)).status, 'completed');
  assert.equal(f.service.events(one.id).filter(event => event.type === 'cancelled').length, 1);
});

test('duration includes approval waiting and no write occurs after timeout or rejection', async t => {
  const f = await fixture(t, () => done('', [toolCall('workspace.write', { path: 'new.txt', content: 'no', createOnly: true })]));
  const run = await f.start({ budget: { maxDurationMs: 150 } });
  const approval = await until(() => f.service.get(run.id)?.approval);
  assert.equal((await f.terminal(run.id)).error.code, 'budget_duration');
  assert.throws(() => f.service.approve(run.id, { approvalId: approval.approvalId, approved: true }), { code: 'approval_mismatch' });
  await assert.rejects(fs.access(path.join(f.workspace, 'new.txt')), { code: 'ENOENT' });
  const rejected = await f.start({ requestId: 'rejected', budget: { maxDurationMs: 1000 } });
  const next = await until(() => f.service.get(rejected.id)?.approval);
  f.service.approve(rejected.id, { approvalId: next.approvalId, approved: false });
  assert.equal((await f.terminal(rejected.id)).status, 'cancelled');
});

test('restart invalidates durable pending approvals and does not replay side effects', async t => {
  const f = await fixture(t, () => done('', [toolCall('workspace.write', { path: 'new.txt', content: 'no', createOnly: true })]));
  const run = await f.start(); const approval = await until(() => f.service.get(run.id)?.approval);
  const fresh = createAgentService({ db: f.db, workspace: f.workspace, fetchImpl: f.fetchImpl });
  assert.equal(fresh.get(run.id).status, 'failed'); assert.equal(fresh.get(run.id).error.code, 'interrupted');
  assert.equal(f.db.prepare('SELECT status FROM agent_approvals WHERE id=?').get(approval.approvalId).status, 'invalidated');
  assert.throws(() => fresh.approve(run.id, { approvalId: approval.approvalId, approved: true }), { code: 'approval_mismatch' });
  await assert.rejects(fs.access(path.join(f.workspace, 'new.txt')), { code: 'ENOENT' });
  // Release the first in-memory instance's waiter in this simulated restart, before closing its DB.
  f.service.cancel(run.id);
});

test('attachment resolver supplies real image input only to vision models and labels text untrusted', async t => {
  const image = Buffer.from('fixture-image').toString('base64');
  const f = await fixture(t, body => {
    assert.deepEqual(body.messages.at(-1).images, [image]);
    assert.match(body.messages.at(-1).content, /UNTRUSTED_ATTACHMENT_DATA/);
    return done('An image was supplied.', [], { inputTokens: 4200 });
  }, { modelCapabilities: ['completion', 'vision'], resolveAttachments: async ids => { assert.deepEqual(ids, ['asset-1']); return { images: [image], text: 'extracted reference text' }; } });
  const result = await f.terminal((await f.start({ attachments: ['asset-1'] })).id);
  assert.equal(result.status, 'completed'); assert.equal(result.usage.inputTokens, 4200);
  const row = f.db.prepare('SELECT request_json FROM agent_runs WHERE id=?').get(result.id);
  assert.ok(!row.request_json.includes(image));
  const g = await fixture(t, undefined, { modelCapabilities: ['completion'], resolveAttachments: async () => ({ images: [image] }) });
  assert.equal((await g.terminal((await g.start({ attachments: ['asset-1'] })).id)).error.code, 'model_vision_unsupported');
  const unsupported = await fixture(t);
  await assert.rejects(unsupported.start({ attachments: ['asset-1'] }), { code: 'attachments_unsupported' });
});

test('provider rejects cloud URLs, missing actual usage, incomplete/oversized/malformed data and redirects', async () => {
  for (const url of ['https://api.example.com', 'http://127.0.0.1.evil.test', 'http://user:pass@localhost', 'http://localhost/proxy']) assert.throws(() => createOllamaProvider({ url }), { code: 'invalid_provider' });
  const signal = AbortSignal.timeout(2000);
  const chat = async data => createOllamaProvider({ fetchImpl: async () => Response.json(data) }).chat({ model: 'm', messages: [], maxOutputTokens: 1, maxInputTokens: 100, signal });
  await assert.rejects(chat({ done: true, message: { content: 'x' } }), { code: 'usage_unavailable' });
  await assert.rejects(chat({ ...done(), done: false }), { code: 'provider_incomplete' });
  const big = createOllamaProvider({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(big.listModels(signal), { code: 'provider_response_too_large' });
  const broken = createOllamaProvider({ fetchImpl: async () => new Response('{broken') });
  await assert.rejects(broken.listModels(signal), { code: 'provider_invalid_json' });
  const redirect = createOllamaProvider({ fetchImpl: async () => new Response('', { status: 302 }) });
  await assert.rejects(redirect.listModels(signal), { code: 'provider_http' });
});

test('non-streaming JSON survives split UTF-8 chunks and bounded results have no simulated deltas', async t => {
  const bytes = Buffer.from(JSON.stringify(done('Hello 🌍')));
  const f = await fixture(t, () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } })));
  const run = await f.start(); assert.equal((await f.terminal(run.id)).output, 'Hello 🌍');
  assert.deepEqual(f.service.events(run.id).filter(event => event.type === 'text_delta').map(event => event.data.text), ['Hello 🌍']);
});

test('approval-gated code runs actual Node code with bounded output and a deadline', async t => {
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('code.run', { language: 'javascript', code: 'console.log(6 * 7)', timeoutMs: 1000 })]) : done('42'));
  const run = await f.start(); const pending = await until(() => f.service.get(run.id)?.approval);
  assert.match(pending.preview.warning, /No OS sandbox/);
  assert.ok(!f.service.events(run.id).some(event => event.type === 'tool_started'));
  f.service.approve(run.id, { approvalId: pending.approvalId, approved: true });
  assert.equal((await f.terminal(run.id)).status, 'completed');
  assert.ok(f.service.events(run.id).some(event => event.type === 'tool_result' && event.data.result.stdout.trim() === '42' && event.data.result.sandboxed === false));
  const g = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('code.run', { language: 'javascript', code: 'while(true) {}', timeoutMs: 100 })]) : done('The code timed out.'));
  const timed = await g.start(); const approval = await until(() => g.service.get(timed.id)?.approval);
  g.service.approve(timed.id, { approvalId: approval.approvalId, approved: true });
  await g.terminal(timed.id);
  assert.ok(g.service.events(timed.id).some(event => event.type === 'tool_result' && event.data.result.code === 'code_timeout'));
});

test('conversation memory is scoped and model inventory never implies nonexistent capabilities', async t => {
  const f = await fixture(t, (body, index) => {
    if (index === 1) return done('', [toolCall('memory.remember', { key: 'note', value: 'private to first conversation' })]);
    if (index === 3) return done('', [toolCall('memory.search', { query: '' })]);
    if (index === 4) assert.match(body.messages.at(-1).content, /"notes":\[\]/);
    return done('Done.');
  });
  await f.terminal((await f.start()).id);
  await f.terminal((await f.start({ requestId: 'req-other', conversationId: 'other' })).id);
  const caps = await f.service.capabilities();
  assert.equal(caps.localOnly, true); assert.equal(caps.cloudEnabled, false); assert.equal(caps.models[0].name, 'test:local'); assert.equal(caps.models[0].vision, false);
  assert.equal(caps.models[0].tools, true);
});

test('inventory inspection has concurrency three and shares its cache across callers', async t => {
  let active = 0, maximum = 0, tags = 0, inspected = 0;
  const f = await fixture(t, undefined, { fetchImpl: async (url, options) => {
    if (new URL(url).pathname === '/api/tags') {
      tags++; return Response.json({ models: Array.from({ length: 7 }, (_, i) => ({ name: `model-${i}` })) });
    }
    assert.equal(new URL(url).pathname, '/api/show');
    active++; inspected++; maximum = Math.max(maximum, active);
    await delay(15); active--;
    const model = JSON.parse(options.body).model;
    return Response.json({ capabilities: ['completion', ...(model === 'model-0' ? ['vision', 'tools'] : [])] });
  } });
  const [one, two] = await Promise.all([f.service.capabilities(), f.service.capabilities()]);
  assert.equal(tags, 1); assert.equal(inspected, 7); assert.equal(maximum, 3);
  assert.equal(one.models[0].vision, true); assert.equal(two.models[1].tools, false);
  await f.service.capabilities(); assert.equal(tags, 1);
  assert.equal(one.limits.maxAttachments, 4); assert.equal(one.limits.maxImageBytes, 4194304);
});

test('recent conversation context includes the latest turns and current request', async t => {
  const f = await fixture(t, body => {
    assert.equal(body.messages.at(-1).content, 'The current question.');
    assert.ok(body.messages.some(message => message.content === 'answer-15'));
    assert.ok(!body.messages.some(message => message.content === 'answer-0'));
    return done('Current answer.');
  });
  const add = f.db.prepare('INSERT INTO agent_messages(conversation_id,run_id,role,content,created_at) VALUES (?,?,?,?,?)');
  for (let i = 0; i < 16; i++) {
    add.run('conv-1', 'historical', 'user', `question-${i}`, Date.now());
    add.run('conv-1', 'historical', 'assistant', `answer-${i}`, Date.now());
  }
  assert.equal((await f.terminal((await f.start({ goal: 'The current question.', budget: { maxInputTokens: 16384 } })).id)).status, 'completed');
});

test('cumulative usage is enforced across tool rounds and actual overage is recorded', async t => {
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('workspace.list', {})], { inputTokens: 100, outputTokens: 6 }) : done('Not shown.', [], { inputTokens: 100, outputTokens: 6 }));
  const run = await f.start({ budget: { maxOutputTokens: 10 } });
  const result = await f.terminal(run.id);
  assert.equal(result.error.code, 'budget_tokens'); assert.equal(result.usage.outputTokens, 12); assert.equal(result.usage.inputTokens, 200);
  assert.equal(result.output, ''); assert.equal(f.calls[1].options.num_predict, 4);
});

test('queued cancellation does not call the provider and code output limit is real', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async () => { await gate; return done('Done.'); });
  const one = await f.start(); await until(() => f.calls.length === 1);
  const two = await f.start({ requestId: 'req-queued' }); f.service.cancel(two.id);
  release(); await f.terminal(one.id); await delay(20);
  assert.equal(f.calls.length, 1); assert.equal(f.service.get(two.id).status, 'cancelled');
  const g = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('code.run', { language: 'javascript', code: 'process.stdout.write("x".repeat(100000))', timeoutMs: 1000 })]) : done('Output bounded.'));
  const run = await g.start(); const pending = await until(() => g.service.get(run.id)?.approval);
  g.service.approve(run.id, { approvalId: pending.approvalId, approved: true });
  await g.terminal(run.id);
  assert.ok(g.service.events(run.id).some(event => event.type === 'tool_result' && event.data.result.code === 'code_output_limit'));
});

test('local-only service rejects cloud model names before any provider request', async t => {
  let requests = 0;
  const f = await fixture(t, undefined, { fetchImpl: async () => { requests++; throw new Error('must not call'); } });
  for (const model of ['gpt-oss:120b-cloud', 'qwen:cloud', 'CLOUD/model', 'team/model-cloud:latest']) {
    await assert.rejects(f.start({ requestId: `blocked-${requests}`, model }), { code: 'local_cloud_blocked' });
  }
  assert.equal(requests, 0);
});

test('inventory preserves remote metadata and cloud aliases fail direct inspect/chat without inference', async t => {
  let inference = 0;
  const fetchImpl = async (url, options) => {
    const endpoint = new URL(url).pathname;
    if (endpoint === '/api/tags') return Response.json({ models: [
      { name: 'local:latest' }, { name: 'hidden-alias', remote_host: 'https://ollama.com', remote_model: 'remote' }, { name: 'large:cloud' }, { name: 'show-only-alias' },
    ] });
    if (endpoint === '/api/show') {
      const name = JSON.parse(options.body).model;
      return Response.json({ capabilities: ['completion', 'tools'], ...(name === 'hidden-alias' || name === 'show-only-alias' ? { remote_host: 'https://ollama.com', remote_model: 'remote' } : {}) });
    }
    inference++; return Response.json(done());
  };
  const provider = createOllamaProvider({ fetchImpl });
  const signal = AbortSignal.timeout(2000);
  const inventory = await provider.listModels(signal);
  assert.equal(inventory[1].remote_host, 'https://ollama.com'); assert.equal(inventory[1].allowed, false); assert.equal(inventory[2].cloud, true);
  for (const model of ['hidden-alias', 'show-only-alias', 'model:cloud']) {
    await assert.rejects(provider.inspectModel(model, signal), { code: 'local_cloud_blocked' });
    await assert.rejects(provider.chat({ model, messages: [], tools: [], maxInputTokens: 1024, maxOutputTokens: 5, signal }), { code: 'local_cloud_blocked' });
  }
  assert.equal(inference, 0);
  const f = await fixture(t, undefined, { fetchImpl });
  const caps = await f.service.capabilities();
  assert.equal(caps.models.find(model => model.name === 'show-only-alias').allowed, false);
  const run = await f.start({ model: 'show-only-alias' });
  assert.equal((await f.terminal(run.id)).error.code, 'local_cloud_blocked');
  assert.equal(inference, 0);
});

test('fresh inference inspection catches aliases retargeted after service metadata caching', async t => {
  let inspections = 0, inference = 0;
  const f = await fixture(t, undefined, { fetchImpl: async (url) => {
    if (new URL(url).pathname === '/api/show') {
      inspections++; return Response.json({ capabilities: ['completion'], ...(inspections > 1 ? { remote_model: 'paid-remote' } : {}) });
    }
    inference++; return Response.json(done());
  } });
  const result = await f.terminal((await f.start()).id);
  assert.equal(result.error.code, 'local_cloud_blocked'); assert.equal(inference, 0);
});

const cloudConfig = (overrides = {}) => ({ enabled: true, apiKey: 'mock-key-no-live-use', maxRunCostUsd: 0.25, models: { 'priced-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 2, tools: true, vision: false } }, ...overrides });
const cloudRequest = (overrides = {}) => ({ provider: 'openai', allowCloud: true, model: 'priced-model', budget: { maxCostUsd: 0.01, maxOutputTokens: 100 }, ...overrides });
const cloudDone = (text, usage = { input_tokens: 100, output_tokens: 10 }) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage });

test('cloud is disabled by default and requires opt-in, known pricing, allowlist and a positive capped budget', async t => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error('must not call network'); };
  const disabled = await fixture(t, undefined, { fetchImpl });
  await assert.rejects(disabled.start(cloudRequest()), { code: 'cloud_disabled' });
  const configured = await fixture(t, undefined, { fetchImpl, cloud: cloudConfig() });
  await assert.rejects(configured.start(cloudRequest({ allowCloud: false })), { code: 'cloud_opt_in_required' });
  await assert.rejects(configured.start(cloudRequest({ budget: { maxCostUsd: 0 } })), { code: 'cloud_budget' });
  await assert.rejects(configured.start(cloudRequest({ budget: { maxCostUsd: 0.26 } })), { code: 'cloud_budget' });
  await assert.rejects(configured.start(cloudRequest({ model: 'unpriced-model' })), { code: 'cloud_model_not_allowed' });
  const unknown = await fixture(t, undefined, { fetchImpl, cloud: cloudConfig({ models: { 'priced-model': { inputUsdPerMillion: 1 } } }) });
  await assert.rejects(unknown.start(cloudRequest()), { code: 'cloud_disabled' });
  assert.equal(requests, 0);
  const provider = createOpenAIProvider({ config: cloudConfig(), fetchImpl });
  await assert.rejects(provider.chat({ model: 'priced-model', messages: [], signal: AbortSignal.timeout(1000) }), { code: 'cloud_opt_in_required' });
});

test('Responses tool loop preserves call IDs/reasoning, persists pre-call reservations and records actual cost', async t => {
  let generations = 0, counts = 0;
  const reservations = [];
  const f = await fixture(t, undefined, { cloud: cloudConfig(), fetchImpl: async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.openai.com');
    const body = JSON.parse(options.body);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer mock-key-no-live-use');
    if (url.endsWith('/input_tokens')) {
      counts++;
      if (counts === 2) {
        assert.ok(body.input.some(item => item.type === 'reasoning' && item.encrypted_content === 'encrypted-fixture'));
        assert.ok(body.input.some(item => item.type === 'function_call_output' && item.call_id === 'provider-call-1' && item.output.includes('hello from file')));
      }
      return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
    }
    assert.ok(reservations.length >= generations + 1, 'reservation must persist before generation');
    assert.equal(body.store, false); assert.equal(body.truncation, 'disabled'); assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.max_output_tokens, generations === 0 ? 100 : 80); assert.deepEqual(body.include, ['reasoning.encrypted_content']);
    assert.ok(body.tools.every(tool => !tool.name.includes('.') && tool.strict === false));
    generations++;
    if (generations === 1) return Response.json({ status: 'completed', output: [
      { type: 'reasoning', id: 'rs-fixture', encrypted_content: 'encrypted-fixture', summary: [] },
      { type: 'function_call', call_id: 'provider-call-1', name: body.tools.find(tool => tool.description.startsWith('workspace.read:')).name, arguments: JSON.stringify({ path: 'hello.txt' }) },
    ], usage: { input_tokens: 100, output_tokens: 20 } });
    return Response.json(cloudDone('The file says hello from file.'));
  }, onEvent: event => { if (event.data.reservation) reservations.push(event); } });
  await fs.writeFile(path.join(f.workspace, 'hello.txt'), 'hello from file');
  const result = await f.terminal((await f.start(cloudRequest())).id);
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(result.provider, 'openai'); assert.equal(result.allowCloud, true);
  assert.equal(generations, 2); assert.equal(counts, 2); assert.equal(result.usage.inputTokens, 200); assert.equal(result.usage.outputTokens, 30);
  assert.ok(Math.abs(result.usage.costUsd - 0.00026) < 1e-12); assert.equal(result.usage.reservedCostUsd, undefined);
  assert.ok(reservations.every(event => event.data.reservation.reservedCostUsd <= 0.01));
});

test('cloud affordability and exact input count prevent generation before budget overrun', async t => {
  let generated = 0;
  const f = await fixture(t, undefined, { cloud: cloudConfig(), fetchImpl: async url => {
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 1000 });
    generated++; return Response.json(cloudDone('must not generate'));
  } });
  const tooCheap = await f.terminal((await f.start(cloudRequest({ budget: { maxCostUsd: 0.000001 } }))).id);
  assert.equal(tooCheap.error.code, 'cloud_budget'); assert.equal(generated, 0);
  const g = await fixture(t, undefined, { cloud: cloudConfig(), fetchImpl: async url => {
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 9000 });
    generated++; return Response.json(cloudDone('must not generate'));
  } });
  assert.equal((await g.terminal((await g.start(cloudRequest({ budget: { maxCostUsd: 0.01, maxInputTokens: 8192 } }))).id)).error.code, 'budget_context'); assert.equal(generated, 0);
});

test('cloud transport failure retains durable uncertain reservation and never retries', async t => {
  let generated = 0;
  const f = await fixture(t, undefined, { cloud: cloudConfig(), fetchImpl: async url => {
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
    generated++; throw new Error('Authorization: SECRET_MUST_NOT_APPEAR');
  } });
  const result = await f.terminal((await f.start(cloudRequest())).id);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'cloud_transport'); assert.equal(generated, 1);
  assert.ok(result.usage.reservedCostUsd > 0); assert.equal(result.usage.costStatus, 'uncertain'); assert.equal(result.usage.costUsd, 0);
  assert.ok(!JSON.stringify(f.service.events(result.id)).includes('SECRET_MUST_NOT_APPEAR'));
});

test('cloud capabilities expose only configured rates/permissions and missing usage remains uncertain', async t => {
  let generated = 0;
  const f = await fixture(t, undefined, { cloud: cloudConfig(), fetchImpl: async url => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [] });
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
    generated++; return Response.json({ status: 'completed', output: [] });
  } });
  const caps = await f.service.capabilities(); const model = caps.models.find(entry => entry.provider === 'openai');
  assert.equal(caps.cloudEnabled, true); assert.equal(caps.localOnly, false); assert.equal(caps.cloud.maxRunCostUsd, 0.25);
  assert.equal(model.allowed, true); assert.equal(model.cloud, true); assert.equal(model.rates.inputUsdPerMillion, 1);
  assert.ok(!JSON.stringify(caps).includes('mock-key'));
  const result = await f.terminal((await f.start(cloudRequest())).id);
  assert.equal(result.error.code, 'usage_unavailable'); assert.equal(result.usage.costStatus, 'uncertain'); assert.equal(generated, 1);
});

test('attachment resolver receives remaining text bytes without truncating the goal', async t => {
  let allowance;
  const f = await fixture(t, body => { assert.match(body.messages.at(-1).content, /^Original goal/); return done('Read the excerpt.'); }, { resolveAttachments: async (_ids, options) => { allowance = options.maxTextBytes; return { text: 'metadata/excerpt' }; } });
  const result = await f.terminal((await f.start({ goal: 'Original goal', attachments: ['a'] })).id);
  assert.equal(result.status, 'completed'); assert.ok(Number.isInteger(allowance) && allowance >= 0 && allowance <= 24000);
});

test('large attachment previews reserve context for multiple native retrieval results', async t => {
  let allowance;
  const f = await fixture(t, (_body, index) => index <= 2 ? done('', [toolCall('reference.chunk', {})]) : done('Read both chunks.'), {
    resolveAttachments: async (_ids, options) => { allowance = options.maxTextBytes; return { text: 'p'.repeat(allowance) }; },
    extraTools: [{ name: 'reference.chunk', description: 'Return a bounded reference chunk', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => ({ text: 'e'.repeat(1800) }) }],
  });
  const result = await f.terminal((await f.start({ attachments: ['large-reference'], budget: { maxInputTokens: 16384, maxTotalTokens: 64000 } })).id);
  assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 3); assert.ok(allowance < 8192);
  assert.equal(f.service.events(result.id).filter(event => event.type === 'tool_result').length, 2);
});

test('unsupported and unavailable inventory models are explicitly disallowed for selection', async t => {
  const f = await fixture(t, undefined, { fetchImpl: async (url, options) => {
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'chat-model' }, { name: 'embedding-only' }, { name: 'missing-alias' }] });
    const model = JSON.parse(options.body).model;
    if (model === 'embedding-only') return Response.json({ capabilities: ['embedding'] });
    if (model === 'missing-alias') return Response.json({ error: 'Model is not available' });
    return Response.json({ capabilities: ['completion'] });
  } });
  const caps = await f.service.capabilities();
  assert.equal(caps.models.find(model => model.name === 'chat-model').allowed, true);
  for (const name of ['embedding-only', 'missing-alias']) {
    const model = caps.models.find(entry => entry.name === name);
    assert.equal(model.allowed, false); assert.equal(typeof model.blockedReason, 'string'); assert.equal(typeof model.capabilityError, 'string');
  }
});

test('known schema-invalid calls receive bounded feedback and a real corrected read can succeed', async t => {
  const f = await fixture(t, (body, index) => {
    if (index === 1) return done('', [{ id: 'invalid-native-call', function: { name: 'workspace.read', arguments: { path: 'hello.txt', startLine: '1' } } }]);
    if (index === 2) {
      const feedback = body.messages.at(-1);
      assert.equal(feedback.tool_call_id, 'invalid-native-call'); assert.match(feedback.content, /invalid_arguments/); assert.match(feedback.content, /expectedSchema/);
      assert.equal(body.messages.at(-2).tool_calls[0].function.arguments.startLine, '1', 'service must not coerce the original call');
      return done('', [{ id: 'corrected-native-call', function: { name: 'workspace.read', arguments: { path: 'hello.txt', startLine: 1 } } }]);
    }
    assert.equal(body.messages.at(-1).tool_call_id, 'corrected-native-call'); assert.match(body.messages.at(-1).content, /actual fixture data/);
    return done('The corrected read returned actual fixture data.');
  });
  await fs.writeFile(path.join(f.workspace, 'hello.txt'), 'actual fixture data');
  const result = await f.terminal((await f.start({ budget: { maxInputTokens: 16384 } })).id);
  assert.equal(result.status, 'completed'); assert.equal(result.usage.totalTokens, 330);
  const events = f.service.events(result.id);
  assert.equal(events.filter(event => event.type === 'tool_started').length, 1);
  assert.equal(events.filter(event => event.type === 'tool_result' && event.data.result.retryable).length, 1);
});

test('mixed invalid rounds perform no valid sibling side effects or approvals', async t => {
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [
    toolCall('memory.remember', { key: 'should-not-exist', value: 'must not be saved' }),
    toolCall('workspace.write', { path: 'must-not-exist.txt', content: 'must not be written', createOnly: true }),
    toolCall('workspace.read', { path: 'hello.txt', startLine: '1' }),
  ]) : done('The invalid round performed no actions.'));
  const result = await f.terminal((await f.start({ budget: { maxInputTokens: 16384 } })).id);
  assert.equal(result.status, 'completed'); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_memory').get().n, 0);
  await assert.rejects(fs.access(path.join(f.workspace, 'must-not-exist.txt')), { code: 'ENOENT' });
  const events = f.service.events(result.id);
  assert.ok(!events.some(event => ['approval_required', 'tool_started'].includes(event.type)));
  const failures = events.filter(event => event.type === 'tool_result').map(event => event.data.result);
  assert.equal(failures.length, 3); assert.ok(failures.every(result => result.failure && result.retryable));
  assert.deepEqual(failures.map(result => result.code), ['round_validation_failed', 'round_validation_failed', 'invalid_arguments']);
});

test('schema feedback consumes attempted call budget; malformed and unknown tools remain fatal', async t => {
  const f = await fixture(t, (_body, index) => done('', [toolCall('workspace.read', { path: 'hello.txt', startLine: index === 1 ? '1' : 1 })]));
  const result = await f.terminal((await f.start({ budget: { maxToolCalls: 1, maxInputTokens: 16384 } })).id);
  assert.equal(result.error.code, 'budget_tools'); assert.ok(!f.service.events(result.id).some(event => event.type === 'tool_started'));
  for (const call of [toolCall('unknown.tool', {}), toolCall('workspace.list', '{bad json'), toolCall('workspace.list', [])]) {
    const g = await fixture(t, () => done('', [call]));
    const failed = await g.terminal((await g.start()).id);
    assert.equal(g.calls.length, 1); assert.ok(['unknown_tool', 'invalid_tool_call'].includes(failed.error.code));
    assert.ok(!g.service.events(failed.id).some(event => event.type === 'tool_result'));
  }
});

test('cloud persisted assistant history uses valid easy-input strings; count and generation share supported fields', async t => {
  let generations = 0;
  const f = await fixture(t, undefined, { cloud: cloudConfig(), fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.parallel_tool_calls, false);
    if (generations === 1) {
      const previous = body.input.find(message => message.role === 'assistant');
      assert.equal(previous.content, 'First cloud answer.'); assert.equal(previous.phase, 'final_answer');
    }
    if (url.endsWith('/input_tokens')) {
      assert.deepEqual(Object.keys(body).sort(), ['input', 'instructions', 'model', 'parallel_tool_calls', 'tools']);
      return Response.json({ input_tokens: 100 });
    }
    generations++; return Response.json(cloudDone(generations === 1 ? 'First cloud answer.' : 'Second cloud answer.'));
  } });
  assert.equal((await f.terminal((await f.start(cloudRequest())).id)).status, 'completed');
  assert.equal((await f.terminal((await f.start(cloudRequest({ requestId: 'second-cloud-turn' }))).id)).status, 'completed');
  assert.equal(generations, 2);
});

test('minimum result budget preserves structured validation failure and retryability', async t => {
  const f = await fixture(t, () => done('', [toolCall('workspace.write', { path: 'x.txt', content: 'no', createOnly: 'true' })]));
  const result = await f.terminal((await f.start({ budget: { maxToolResultChars: 256, maxInputTokens: 16384 } })).id);
  const feedback = f.service.events(result.id).filter(event => event.type === 'tool_result').map(event => event.data.result);
  assert.equal(result.error.code, 'invalid_arguments'); assert.equal(feedback.length, 2);
  assert.deepEqual(feedback.map(value => value.retryable), [true, false]); assert.ok(feedback.every(value => value.failure && value.ok === false && JSON.stringify(value).length <= 256));
  assert.ok(!f.service.events(result.id).some(event => event.type === 'approval_required'));
});

const dockerHealth = (extra = {}) => ({ available: true, kind: 'docker', engine: 'docker', isolation: 'docker-linux', languages: ['javascript', 'python'], images: { javascript: 'sha256:fixture-js', python: 'sha256:fixture-python' }, engineVersion: 'fixture-engine', limits: { timeoutMs: 15000, maxOutputBytes: 32768, memoryBytes: 268435456, pids: 64, maxConcurrent: 1 }, ...extra });
const dockerReceipt = (extra = {}) => ({ ok: true, exitCode: 0, stdout: '42\n', stderr: '', sandboxed: true, engine: 'docker', isolation: 'docker-linux', network: false, hostMounts: false, image: 'sha256:fixture-js', language: 'javascript', limits: dockerHealth().limits, termination: 'exit', cleanup: { removed: true,verifiedAbsent:true,name: 'generated-fixture-container' }, ...extra });

test('only exact server-owned Docker executors may bypass host-code approval', async t => {
  const f = await fixture(t);
  for (const codeExecutor of [null, {}, { kind: 'host', health() {}, run() {} }, { kind: 'Docker', health() {}, run() {} }, { kind: 'docker', run() {} }, { kind: 'docker', health() {} }]) assert.throws(() => createAgentService({ db: f.db, workspace: f.workspace, codeExecutor }), { code: 'invalid_code_executor' });
  await assert.rejects(f.start({ engine: 'docker' }), { code: 'invalid_request' });
  const caps = await f.service.capabilities();
  assert.equal(caps.codeExecution.mode, 'host'); assert.equal(caps.codeExecution.approvalRequired, true); assert.equal(caps.sandboxed, false);
  assert.equal(caps.tools.find(tool => tool.name === 'code.run').approvalRequired, true);
});

test('verified Docker code runs unattended and durable receipts retain historical isolation facts', async t => {
  let calls = 0;
  const f = await fixture(t, (body, index) => {
    assert.match(body.messages[0].content, /may invoke it unattended/);
    assert.match(body.messages[0].content, /Workspace writes always require human approval/);
    if (index === 1) return done('', [toolCall('code.run', { language: 'javascript', code: 'console.log(6 * 7)', timeoutMs: 1000 })]);
    assert.match(body.messages.at(-1).content, /"sandboxed":true/);
    return done('The sandbox returned 42.');
  }, { codeExecutor: { kind: 'docker', health: async () => dockerHealth(), run: async (args, { signal }) => { calls++; assert.equal(args.code, 'console.log(6 * 7)'); assert.ok(signal instanceof AbortSignal); return dockerReceipt(); } } });
  const caps = await f.service.capabilities();
  assert.equal(caps.sandboxed, true); assert.equal(caps.codeExecution.sandboxedConfigured, true); assert.equal(caps.codeExecution.available, true); assert.equal(caps.codeExecution.approvalRequired, false);
  const tool = caps.tools.find(tool => tool.name === 'code.run'); assert.equal(tool.execution.mode, 'docker'); assert.equal(tool.approvalRequired, false);
  assert.equal(caps.tools.find(tool => tool.name === 'workspace.write').execution.approvalRequired, true);
  const result = await f.terminal((await f.start()).id); assert.equal(result.status, 'completed'); assert.equal(calls, 1);
  const events = f.service.events(result.id); assert.ok(!events.some(event => event.type === 'approval_required'));
  const receipt = events.find(event => event.type === 'tool_result').data;
  assert.equal(receipt.result.sandboxed, true); assert.equal(receipt.execution.mode, 'docker'); assert.ok(receipt.execution.checkedAt > 0);
  assert.equal(receipt.receipt.network, false); assert.equal(receipt.receipt.hostMounts, false); assert.equal(receipt.receipt.cleanup.removed, true); assert.equal(receipt.receipt.termination, 'exit');
});

test('Docker readiness is refreshed outside inventory cache and unavailable execution never calls any runner', async t => {
  let ready = true, calls = 0;
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('code.run', { language: 'javascript', code: 'throw new Error("must not run")' })]) : done('Docker is unavailable.'), { codeExecutor: { kind: 'docker', health: async () => dockerHealth({ available: ready, reason: ready ? undefined : 'Docker engine stopped', authorization: 'SECRET_FIELD', environment: { SECRET: 'secret' } }), run: async () => { calls++; return dockerReceipt(); } } });
  const initial = await f.service.capabilities(); assert.equal(initial.sandboxed, true);
  ready = false;
  const current = await f.service.capabilities(); assert.equal(current.sandboxed, false); assert.equal(current.codeExecution.sandboxedConfigured, true); assert.equal(current.codeExecution.available, false);
  assert.ok(!JSON.stringify(current).includes('SECRET_FIELD')); assert.ok(!JSON.stringify(current).includes('environment'));
  const run = await f.start(); await f.terminal(run.id); assert.equal(calls, 0);
  const receipt = f.service.events(run.id).find(event => event.type === 'tool_result').data;
  assert.equal(receipt.result.code, 'sandbox_unavailable'); assert.equal(receipt.result.sandboxed, false); assert.equal(receipt.execution.mode, 'docker');
  assert.ok(!f.service.events(run.id).some(event => event.type === 'approval_required'));
});

test('Docker exceptions and invalid receipts are explicit failures without host fallback', async t => {
  for (const run of [async () => { throw Object.assign(new Error('Docker launch failed'), { code: 'docker_launch' }); }, async () => dockerReceipt({ sandboxed: false }), async () => dockerReceipt({ network: true }), async () => dockerReceipt({ hostMounts: true }), async () => dockerReceipt({ cleanup: { removed: false } })]) {
    const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('code.run', { language: 'javascript', code: 'console.log(42)' })]) : done('Execution did not succeed.'), { codeExecutor: { kind: 'docker', health: async () => dockerHealth(), run } });
    const result = await f.terminal((await f.start()).id);
    const receipt = f.service.events(result.id).find(event => event.type === 'tool_result').data;
    assert.equal(receipt.result.ok, false); assert.equal(receipt.result.sandboxed, false); assert.equal(receipt.result.engine, 'docker');
    assert.ok(['docker_launch', 'sandbox_receipt_invalid'].includes(receipt.result.code)); assert.ok(!f.service.events(result.id).some(event => event.type === 'approval_required'));
  }
});

test('bounded Docker output preserves verified isolation metadata outside the truncated text', async t => {
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('code.run', { language: 'javascript', code: 'print lots of text' })]) : done('The sandbox output was bounded.'), { codeExecutor: { kind: 'docker', health: async () => dockerHealth(), run: async () => dockerReceipt({ stdout: 'x'.repeat(32768), termination: 'output_limit' }) } });
  const result = await f.terminal((await f.start({ budget: { maxToolResultChars: 256 } })).id);
  const receipt = f.service.events(result.id).find(event => event.type === 'tool_result').data;
  assert.equal(receipt.result.sandboxed, true); assert.equal(receipt.result.truncated, true); assert.ok(JSON.stringify(receipt.result).length <= 256);
  assert.equal(receipt.receipt.termination, 'output_limit'); assert.equal(receipt.receipt.cleanup.removed, true); assert.equal(receipt.execution.network, false);
});

test('Docker health exceptions do not expose arbitrary exception text or claim sandbox readiness', async t => {
  const f = await fixture(t, undefined, { codeExecutor: { kind: 'docker', health: async () => { throw new Error('Authorization: DO_NOT_LEAK'); }, run: async () => dockerReceipt() } });
  const caps = await f.service.capabilities();
  assert.equal(caps.codeExecution.available, false); assert.equal(caps.sandboxed, false); assert.ok(!JSON.stringify(caps).includes('DO_NOT_LEAK'));
  const wrong = await fixture(t, undefined, { codeExecutor: { kind: 'docker', health: async () => dockerHealth({ isolation: 'host' }), run: async () => dockerReceipt() } });
  assert.equal((await wrong.service.capabilities()).codeExecution.available, false);
});

const emptyToolSchema = () => ({ type: 'object', properties: {}, additionalProperties: false });
function groupedTools() {
  return [
    { name: 'custom.always', description: 'An ungrouped helper.', parameters: emptyToolSchema(), execute: async () => ({ ok: true }) },
    ...['web', 'documents', 'transport'].map(group => ({ name: `${group}.fixture`, group, description: `A ${group} fixture helper.`, parameters: emptyToolSchema(), execute: async () => ({ group, fixture: true }) })),
  ];
}
const advertisedNames = body => (body.tools || []).map(tool => tool.function.name);

test('tool groups reduce initial schemas while capabilities retain the full annotated registry', async t => {
  const f = await fixture(t, body => {
    const names = advertisedNames(body);
    assert.ok(names.includes('workspace.read')); assert.ok(names.includes('custom.always')); assert.ok(names.includes('tools.enable'));
    assert.ok(!names.includes('web.fixture')); assert.ok(!names.includes('documents.fixture')); assert.ok(!names.includes('transport.fixture'));
    assert.match(body.messages[0].content, /tools.enable/); assert.match(body.messages[0].content, /exact source URL and returned line references/);
    return done('A plain project answer.');
  }, { extraTools: groupedTools() });
  const run = await f.start({ goal: 'Explain this project.' }); assert.equal((await f.terminal(run.id)).status, 'completed');
  const caps = await f.service.capabilities();
  assert.equal(caps.tools.length, 16); assert.equal(f.calls[0].tools.length, 9); assert.equal(caps.toolDiscovery.enabled, true);
  assert.equal(caps.tools.find(tool => tool.name === 'web.fixture').group, 'web'); assert.equal(caps.tools.find(tool => tool.name === 'custom.always').group, null);
  assert.deepEqual(caps.tools.find(tool => tool.name === 'tools.enable').parameters.properties.group.enum, ['coding','documents', 'transport', 'web']);
  assert.deepEqual(caps.toolDiscovery.groups.find(group => group.name === 'documents').tools, ['documents.fixture']);
  const fullWire = caps.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  assert.ok(Buffer.byteLength(JSON.stringify(f.calls[0].tools)) < Buffer.byteLength(JSON.stringify(fullWire)));
  const baseline = await fixture(t);
  const baselineCaps=await baseline.service.capabilities();
  assert.deepEqual(baselineCaps.toolDiscovery.groups.map(group=>group.name),['coding']);
  assert.deepEqual(baselineCaps.toolDiscovery.groups[0].tools.sort(),['workspace.edit','workspace.map','workspace.patch','workspace.readMany']);
});

test('original goal URLs/web terms and transport terms enable only their registered groups', async t => {
  for (const [goal, group] of [['Summarize https://example.test/article.', 'web'], ['Research the history of this feature.', 'web'], ['Inspect the RGBA XYZW packet spectrum.', 'transport']]) {
    const f = await fixture(t, body => {
      const names = advertisedNames(body); assert.ok(names.includes(`${group}.fixture`));
      for (const other of ['web', 'transport', 'documents'].filter(value => value !== group)) assert.ok(!names.includes(`${other}.fixture`));
      return done('Fixture complete.');
    }, { extraTools: groupedTools() });
    assert.equal((await f.terminal((await f.start({ goal })).id)).status, 'completed');
  }
});

test('attachments initially enable documents and excerpt allowance excludes inactive group schemas', async t => {
  let allowance;
  const extra = groupedTools();
  const web = extra.find(tool => tool.group === 'web');
  web.parameters = { type: 'object', properties: { unused: { type: 'string', description: 'Large optional research schema detail. '.repeat(500) } }, additionalProperties: false };
  const f = await fixture(t, body => {
    const names = advertisedNames(body); assert.ok(names.includes('documents.fixture')); assert.ok(!names.includes('web.fixture'));
    return done('The excerpt was supplied.');
  }, { extraTools: extra, resolveAttachments: async (_ids, options) => { allowance = options.maxTextBytes; return { text: 'Untrusted excerpt mentions web research, https://example.test and RGBA transport.' }; } });
  const result = await f.terminal((await f.start({ goal: 'Explain the attached source.', attachments: ['asset-1'], budget: { maxInputTokens: 16384 } })).id);
  assert.equal(result.status, 'completed'); assert.ok(allowance > 1000, 'inactive web schemas must not consume the initial excerpt allowance');
});

test('tools.enable appends definitions for the next model round without schema duplication or cross-run state', async t => {
  let firstNames;
  const f = await fixture(t, (body, index) => {
    const names = advertisedNames(body);
    if (index === 1) { firstNames = names; assert.ok(!names.includes('web.fixture')); return done('', [toolCall('tools.enable', { group: 'web' })]); }
    if (index === 2) {
      assert.deepEqual(names.slice(0, firstNames.length), firstNames); assert.ok(names.includes('web.fixture'));
      const feedback = body.messages.at(-1).content;
      assert.match(feedback, /"tools":\["web.fixture"\]/); assert.ok(!feedback.includes('parameters'));
      return done('', [toolCall('web.fixture', {})]);
    }
    if (index === 3) { assert.match(body.messages.at(-1).content, /"fixture":true/); return done('The web fixture completed.'); }
    assert.ok(!names.includes('web.fixture'), 'activation must be scoped to the original run');
    return done('The next ordinary run has its initial definitions.');
  }, { extraTools: groupedTools() });
  const one = await f.start({ goal: 'Use a suitable helper.', budget: { maxInputTokens: 16384 } });
  assert.equal((await f.terminal(one.id)).status, 'completed'); assert.equal(f.service.get(one.id).usage.totalTokens, 330);
  const two = await f.start({ requestId: 'req-2', goal: 'Explain this project.' }); assert.equal((await f.terminal(two.id)).status, 'completed');
  assert.equal(f.service.events(one.id).find(event => event.type === 'tool_result' && event.data.name === 'tools.enable').data.result.enabled, true);
});

test('newly discovered actions retain exact approvals and hidden definitions remain registered', async t => {
  let executed = 0;
  const extra = { name: 'web.approvedAction', group: 'web', description: 'A fixture action requiring exact approval.', approvalRequired: true, parameters: emptyToolSchema(), execute: async () => { executed++; return { ok: true }; } };
  const f = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('tools.enable', { group: 'web' })]) : index === 2 ? done('', [toolCall('web.approvedAction', {})]) : done('Approved action completed.'), { extraTools: [extra] });
  const run = await f.start({ goal: 'Use a suitable helper.', budget: { maxInputTokens: 16384 } });
  const pending = await until(() => f.service.get(run.id)?.approval); assert.equal(pending.name, extra.name); assert.equal(executed, 0);
  f.service.approve(run.id, { approvalId: pending.approvalId, approved: true }); assert.equal((await f.terminal(run.id)).status, 'completed'); assert.equal(executed, 1);
  const direct = await fixture(t, (body, index) => index === 1 ? (assert.ok(!advertisedNames(body).includes('web.fixture')), done('', [toolCall('web.fixture', {})])) : done('Registered hidden helper returned.'), { extraTools: groupedTools() });
  assert.equal((await direct.terminal((await direct.start({ goal: 'Use a suitable helper.' })).id)).status, 'completed');
});

test('invalid groups never execute discovery and discovery/builtin names cannot be overridden', async t => {
  const f = await fixture(t, body => {
    assert.ok(!advertisedNames(body).includes('web.fixture'));
    return done('', [toolCall('tools.enable', { group: 'nonexistent' })]);
  }, { extraTools: groupedTools() });
  const result = await f.terminal((await f.start({ goal: 'Use a suitable helper.', budget: { maxInputTokens: 16384 } })).id);
  assert.equal(result.error.code, 'invalid_arguments'); assert.equal(f.calls.length, 2);
  assert.ok(!f.service.events(result.id).some(event => event.type === 'tool_started'));
  const descriptor = { description: 'Reserved fixture.', parameters: emptyToolSchema(), execute: async () => ({}) };
  for (const name of ['tools.enable', 'workspace.read']) assert.throws(() => createAgentService({ db: f.db, workspace: f.workspace, extraTools: [{ ...descriptor, name }] }), { code: 'invalid_tool' });
  assert.throws(() => createAgentService({ db: f.db, workspace: f.workspace, extraTools: [{ ...descriptor, name: 'custom.badGroup', group: 'Bad group' }] }), { code: 'invalid_tool' });
});

test('group activation does not increase context or attempted-call budgets', async t => {
  const extra = { name: 'web.largeSchema', group: 'web', description: 'Large optional fixture schema.', parameters: { type: 'object', properties: { unused: { type: 'string', description: 'bounded-schema '.repeat(900) } }, additionalProperties: false }, execute: async () => assert.fail('should not execute') };
  const f = await fixture(t, () => done('', [toolCall('tools.enable', { group: 'web' })]), { extraTools: [extra] });
  const result = await f.terminal((await f.start({ goal: 'Use a suitable helper.' })).id);
  assert.equal(result.error.code, 'budget_context'); assert.equal(f.calls.length, 1); assert.equal(result.usage.totalTokens, 110);
  const limited = await fixture(t, (_body, index) => index === 1 ? done('', [toolCall('tools.enable', { group: 'web' })]) : done('', [toolCall('web.fixture', {})]), { extraTools: groupedTools() });
  const exhausted = await limited.terminal((await limited.start({ goal: 'Use a suitable helper.', budget: { maxToolCalls: 1, maxInputTokens: 16384 } })).id);
  assert.equal(exhausted.error.code, 'budget_tools');
});

test('cloud discovery keeps native aliases stable as grouped definitions append', async t => {
  let generation = 0, enableAlias;
  const f = await fixture(t, undefined, { cloud: cloudConfig(), extraTools: groupedTools(), fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
    generation++;
    const discovery = body.tools.find(tool => tool.description.startsWith('tools.enable:'));
    if (generation === 1) { enableAlias = discovery.name; return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'enable-native', name: enableAlias, arguments: JSON.stringify({ group: 'web' }) }], usage: { input_tokens: 100, output_tokens: 10 } }); }
    assert.equal(discovery.name, enableAlias);
    assert.ok(body.input.some(item => item.type === 'function_call' && item.call_id === 'enable-native' && item.name === enableAlias));
    if (generation === 2) return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'web-native', name: body.tools.find(tool => tool.description.startsWith('web.fixture:')).name, arguments: '{}' }], usage: { input_tokens: 100, output_tokens: 10 } });
    return Response.json(cloudDone('The discovered fixture returned.'));
  } });
  const result = await f.terminal((await f.start(cloudRequest({ goal: 'Use a suitable helper.', budget: { maxCostUsd: 0.01, maxOutputTokens: 100, maxInputTokens: 16384 } }))).id);
  assert.equal(result.status, 'completed'); assert.equal(generation, 3);
});

test('repeated discovery is idempotent without duplicate tool definitions', async t => {
  const f = await fixture(t, (body, index) => {
    if (index <= 2) return done('', [toolCall('tools.enable', { group: 'web' })]);
    const names = advertisedNames(body); assert.equal(names.filter(name => name === 'web.fixture').length, 1); assert.equal(new Set(names).size, names.length);
    assert.match(body.messages.at(-1).content, /"alreadyEnabled":true/);
    return done('The group remains enabled exactly once.');
  }, { extraTools: groupedTools() });
  const result = await f.terminal((await f.start({ goal: 'Use a suitable helper.', budget: { maxInputTokens: 16384 } })).id);
  assert.equal(result.status, 'completed'); assert.equal(result.usage.totalTokens, 330);
});

test('default context capacity is 16k and an explicit lower capacity changes no other run budget', async t => {
  const f = await fixture(t, () => done('A bounded answer.'));
  const standard = await f.start({ goal: 'Explain this workspace.' });
  assert.equal((await f.terminal(standard.id)).status, 'completed');
  const lower = await f.start({ requestId: 'lower-context', goal: 'Explain this workspace.', budget: { maxInputTokens: 8192 } });
  assert.equal((await f.terminal(lower.id)).status, 'completed');
  assert.equal(f.calls[0].options.num_ctx, 16384); assert.equal(f.calls[1].options.num_ctx, 8192);
  assert.equal(f.calls[0].options.num_predict, f.calls[1].options.num_predict);
  assert.deepEqual(lower.budget, { ...standard.budget, maxInputTokens: 8192 });
  assert.equal((await f.service.capabilities()).defaultBudget.maxInputTokens, 16384);
});

test('prior completed history is pruned again as current tool evidence grows without losing the goal or native calls', async t => {
  const priorQuestions = ['Prior question one: ' + 'A'.repeat(1700), 'Prior question two: ' + 'C'.repeat(1700)];
  const priorAnswers = ['Prior answer one: ' + 'B'.repeat(1700), 'Prior answer two: ' + 'D'.repeat(1700)];
  const goal = 'Read one.txt, two.txt and three.txt and summarize the three current evidence markers.';
  const contents = ['CURRENT_ONE:' + '1'.repeat(2400), 'CURRENT_TWO:' + '2'.repeat(2400), 'CURRENT_THREE:' + '3'.repeat(2400)];
  const paths = ['one.txt', 'two.txt', 'three.txt'];
  const f = await fixture(t, (body, index) => {
    if (index <= 2) return done(priorAnswers[index - 1], [], { inputTokens: 450, outputTokens: 500 });
    const completedTools = index - 3;
    assert.ok(body.messages.some(message => message.role === 'user' && message.content === goal));
    const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls || []);
    const results = body.messages.filter(message => message.role === 'tool');
    assert.deepEqual(calls.map(call => call.id), Array.from({ length: completedTools }, (_, i) => `current-read-${i + 1}`));
    assert.deepEqual(results.map(message => message.tool_call_id), calls.map(call => call.id));
    results.forEach((message, i) => assert.ok(message.content.includes(contents[i]), 'every current result remains complete'));
    if (index === 3 || index === 4) {
      assert.ok(body.messages.some(message => message.content === priorQuestions[0]));
      assert.ok(body.messages.some(message => message.content === priorAnswers[1]));
    }
    if (index === 5) {
      assert.ok(!body.messages.some(message => message.content === priorQuestions[0] || message.content === priorAnswers[0]));
      assert.ok(body.messages.some(message => message.content === priorQuestions[1]));
    }
    if (index === 6) {
      assert.ok(!body.messages.some(message => priorQuestions.includes(message.content) || priorAnswers.includes(message.content)));
      return done('The current evidence contains CURRENT_ONE, CURRENT_TWO and CURRENT_THREE.');
    }
    return done('', [{ id: `current-read-${completedTools + 1}`, function: { name: 'workspace.read', arguments: { path: paths[completedTools] } } }]);
  });
  for (let i = 0; i < paths.length; i++) await fs.writeFile(path.join(f.workspace, paths[i]), contents[i]);
  for (let i = 0; i < priorQuestions.length; i++) assert.equal((await f.terminal((await f.start({ requestId: `prior-${i}`, goal: priorQuestions[i] })).id)).status, 'completed');
  const run = await f.start({ requestId: 'current-with-evidence', goal });
  const result = await f.terminal(run.id);
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.match(result.output, /CURRENT_THREE/);
  assert.equal(result.usage.totalTokens, 440); assert.equal(result.usage.costUsd, 0);
  const compactions = f.service.events(run.id).filter(event => event.type === 'context_compacted');
  assert.equal(compactions.length, 2);
  assert.deepEqual(compactions.map(event => event.data.removedHistoryMessages), [2, 2]);
  assert.deepEqual(compactions.map(event => event.data.remainingHistoryMessages), [2, 0]);
  assert.deepEqual(compactions.map(event => event.data.totalRemovedHistoryMessages), [2, 4]);
  assert.ok(compactions.every(event => event.data.preservedCurrentGoal && event.data.preservedCurrentToolContext && event.data.preservedNativeCallIds && event.data.estimatedInputTokensBefore > 16384 && event.data.estimatedInputTokensAfter <= 16384));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE conversation_id=?').get('conv-1').n, 6, 'compaction must not delete stored conversation history');
});

test('current tool results still fail context budget after all prior history is removed instead of being silently truncated', async t => {
  const current = 'FULL_CURRENT_EVIDENCE:' + 'x'.repeat(20000);
  const goal = 'Read the current oversized evidence file.';
  const f = await fixture(t, (_body, index) => index === 1 ? done('Earlier completed answer. ' + 'h'.repeat(1000)) : done('', [{ id: 'oversized-current-read', function: { name: 'workspace.read', arguments: { path: 'current.txt' } } }]));
  assert.equal((await f.terminal((await f.start({ requestId: 'prior-completed', goal: 'Earlier question.' })).id)).status, 'completed');
  await fs.writeFile(path.join(f.workspace, 'current.txt'), current);
  const run = await f.start({ requestId: 'current-too-large', goal, budget: { maxToolResultChars: 32000 } });
  const result = await f.terminal(run.id);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'budget_context'); assert.equal(f.calls.length, 2);
  const events = f.service.events(run.id), evidence = events.find(event => event.type === 'tool_result');
  assert.equal(evidence.data.result.content, current); assert.equal(evidence.data.result.truncated, undefined);
  const compaction = events.find(event => event.type === 'context_compacted');
  assert.equal(compaction.data.removedHistoryMessages, 2); assert.equal(compaction.data.remainingHistoryMessages, 0);
  assert.ok(compaction.data.estimatedInputTokensAfter > result.budget.maxInputTokens);
  assert.ok(compaction.data.preservedCurrentGoal && compaction.data.preservedCurrentToolContext && compaction.data.preservedNativeCallIds);
  assert.equal(result.budget.maxInputTokens, 16384); assert.equal(result.usage.costUsd, 0);
  assert.ok(!events.some(event => event.type === 'completed'));
});

const desktopTestBroker = () => ({ session: () => ({ state:'active' }), claim: () => {}, releaseRun: () => {} });
const desktopFrameTool = () => ({ name:'desktop.observe',group:'desktop',description:'Observe a synthetic test frame.',
  parameters:{type:'object',properties:{},additionalProperties:false},execute:({run})=>{
    const frame=encodeRgbaPng(Buffer.from('synthetic frame'),{width:8});
    const snapshotId=crypto.randomUUID();
    return toolObservation({snapshotId,untrusted:true},[{bytes:frame.png,mimeType:'image/png',width:frame.width,height:frame.height,
      runId:run.id,sessionId:run.desktopSessionId,snapshotId,scope:'desktop-window'}]);
  }});

test('desktop-enabled conversations remain local-only after revocation and service restart',async t=>{
  const broker=desktopTestBroker(),f=await fixture(t,()=>done('Synthetic private desktop result.'),{desktopBroker:broker});
  const started=await f.start({desktopSessionId:'test-desktop-grant'});assert.equal((await f.terminal(started.id)).status,'completed');
  assert.equal(f.db.prepare('SELECT reason FROM agent_local_conversations WHERE conversation_id=?').get('conv-1').reason,'desktop');
  await assert.rejects(f.start({requestId:'cloud-later',provider:'openai',allowCloud:true}),{code:'private_conversation_local_only'});
  const restarted=createAgentService({db:f.db,workspace:f.workspace,fetchImpl:f.fetchImpl,desktopBroker:broker});
  await assert.rejects(restarted.start({requestId:'cloud-restart',conversationId:'conv-1',goal:'Continue.',model:'priced',provider:'openai',allowCloud:true}),{code:'private_conversation_local_only'});
  assert.equal(f.calls.length,1);
  await assert.rejects(f.start({requestId:'cloud-session',provider:'openai',allowCloud:true,desktopSessionId:'test-desktop-grant'}),{code:'desktop_local_only'});
});

test('unverified tool image transport stays disabled even for an advertised local vision model',async t=>{
  const f=await fixture(t,(_body,index)=>index===1?done('',[toolCall('desktop.observe',{})]):done('Image input is unavailable.'),
    {desktopBroker:desktopTestBroker(),extraTools:[desktopFrameTool()],modelCapabilities:['completion','tools','vision']});
  const started=await f.start({desktopSessionId:'test-desktop-grant'}),result=await f.terminal(started.id);
  assert.equal(result.status,'completed');assert.equal(f.calls.length,2);
  assert.ok(!f.calls[1].messages.some(message=>message.images?.length));
  const events=f.service.events(started.id);assert.equal(events.find(e=>e.type==='tool_result').data.result.code,'observation_transport_unverified');
  assert.ok(!events.some(e=>e.type==='tool_observation'));
});

test('explicit image adapter contract retains native call IDs and supersedes only old frame bytes',async t=>{
  const f=await fixture(t,(body,index)=>{
    if(index<3)return done('',[toolCall('desktop.observe',{})]);
    const frames=body.messages.filter(message=>message.images?.length);
    assert.equal(frames.length,1);assert.equal(frames[0].role,'user');assert.match(frames[0].content,/UNTRUSTED_TOOL_OBSERVATION/);
    assert.ok(body.messages.some(message=>/older frame was superseded/.test(message.content)));
    assert.equal(body.messages.filter(message=>message.role==='tool'&&message.tool_call_id).length,2);
    return done('Adapter serialization verified with a fake model only.');
  },{desktopBroker:desktopTestBroker(),extraTools:[desktopFrameTool()],modelCapabilities:['completion','tools','vision'],toolImageTransport:'user-data-companion'});
  const started=await f.start({desktopSessionId:'test-desktop-grant',budget:{maxInputTokens:32768,maxTotalTokens:100000}}),result=await f.terminal(started.id);
  assert.equal(result.status,'completed');const events=f.service.events(started.id);
  assert.equal(events.filter(e=>e.type==='tool_observation').length,2);assert.equal(events.filter(e=>e.type==='image_context_compacted').length,1);
  const base64=f.calls.at(-1).messages.find(message=>message.images?.length).images[0];
  assert.ok(!JSON.stringify(events).includes(base64));assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM agent_messages').all()).includes(base64));
});

test('fresh image budget prevents a later action in the same model batch',async t=>{
  const f=await fixture(t,()=>done('',[toolCall('desktop.observe',{}),toolCall('workspace.write',{path:'must-not-exist.txt',content:'forbidden',createOnly:true})]),
    {desktopBroker:desktopTestBroker(),extraTools:[desktopFrameTool()],modelCapabilities:['completion','tools','vision'],toolImageTransport:'user-data-companion'});
  const started=await f.start({desktopSessionId:'test-desktop-grant',budget:{maxInputTokens:8192}}),result=await f.terminal(started.id);
  assert.equal(result.status,'failed');assert.equal(result.error.code,'budget_context');assert.equal(f.calls.length,1);
  assert.ok(!f.service.events(started.id).some(e=>e.type==='approval_required'));await assert.rejects(fs.stat(path.join(f.workspace,'must-not-exist.txt')));
});

test('desktop action receipts remain outside text truncation',async t=>{
  const expected={actionId:'synthetic-action',status:'input_dispatched',effectObserved:null,isolation:'none'};
  const tool={name:'desktop.act',group:'desktop',description:'Fake dispatch for receipt serialization test.',preserveReceipt:true,approvalRequired:true,
    parameters:{type:'object',properties:{},additionalProperties:false},execute:()=>({huge:'x'.repeat(20000),receipt:expected})};
  const f=await fixture(t,(_body,index)=>index===1?done('',[toolCall('desktop.act',{})]):done('Input dispatched; effect unknown.'),{desktopBroker:desktopTestBroker(),extraTools:[tool]});
  const started=await f.start({desktopSessionId:'test-desktop-grant',budget:{maxToolResultChars:256}});
  const pending=await until(()=>{const r=f.service.get(started.id);return r.approval&&r;});
  f.service.approve(started.id,{approvalId:pending.approval.approvalId,approved:true});assert.equal((await f.terminal(started.id)).status,'completed');
  const event=f.service.events(started.id).find(e=>e.type==='tool_result');assert.equal(event.data.result.truncated,true);assert.deepEqual(event.data.receipt,expected);
});
