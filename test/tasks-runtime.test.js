import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { installRuntime, apiError } from '../server/runtime.js';
import { localBoundary } from '../server/local-http.js';
import { PORT } from '../server/config.js';

const MODEL = 'task-runtime-fixture:local', OLLAMA = 'http://127.0.0.1:49981';
const INITIAL = Date.UTC(2026, 9, 26, 12), TERMINAL = new Set(['completed','failed','cancelled']);
const completion = (text = 'Fixture complete', calls = []) => ({ done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10,
  message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) } });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });
async function until(predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Isolated task runtime did not reach the expected state');
}
async function fixture(t, chat = () => completion()) {
  const parent = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(parent, { recursive: true });
  const temporaryParent = await fs.realpath(parent), folder = await fs.mkdtemp(path.join(temporaryParent, 'tasks-runtime-')), original = await fs.realpath(folder);
  let runtime, db, server, stamp = INITIAL; const calls = [], chats = [], events = [], controllerCalls = [], executorCalls = [],ocrCalls=[];
  t.after(async () => {
    const result = runtime ? await runtime.close() : { safeToCloseDatabase: true };
    if (server?.listening) await new Promise((resolve, reject) => { server.close(caught => caught ? reject(caught) : resolve()); server.closeAllConnections(); });
    assert.equal(result.safeToCloseDatabase, true, 'Runtime must drain owned callbacks before closing its test database');
    db?.close();
    const target = await fs.realpath(folder);
    assert.equal(target, original); assert.equal(path.dirname(target), temporaryParent); assert.ok(path.basename(target).startsWith('tasks-runtime-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const workspace = path.join(folder, 'workspace'), dataDir = path.join(folder, 'data'); await fs.mkdir(workspace); await fs.mkdir(dataDir);
  db = new DatabaseSync(path.join(folder, 'runtime.sqlite'));
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url); assert.equal(parsed.origin, OLLAMA, 'No request may escape the fake local provider');
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ path: parsed.pathname, body });
    if (parsed.pathname === '/api/tags') return Response.json({ models: [{ name: MODEL, size: 1024 }] });
    if (parsed.pathname === '/api/show') return Response.json({ capabilities: ['completion','tools'] });
    assert.equal(parsed.pathname, '/api/chat'); chats.push(body); return Response.json(await chat(body, chats.length, { stamp }));
  };
  const codeExecutor = { kind: 'docker', health: async () => ({ kind: 'docker', available: false, reason: 'Isolated test has no Docker daemon' }),
    run: async () => { executorCalls.push('run'); assert.fail('No native/container execution is permitted'); } };
  const denied = name => async () => { controllerCalls.push(name); assert.fail('No desktop controller operation is permitted'); };
  const desktopDriver = { health: async () => ({ configured: false, available: false, reason: 'Disabled isolated fixture' }),
    listWindows: denied('listWindows'), openSession: denied('openSession'), observe: denied('observe'), prepare: denied('prepare'), execute: denied('execute'), close: denied('close') };
  const app = express(); app.use(localBoundary); app.use(express.json({ limit: '1mb' }));
  runtime = installRuntime(app, { db, workspace, dataDir, cloud: { enabled: false }, ollamaUrl: OLLAMA, voiceUrl: 'http://127.0.0.1:49982', fetchImpl,
    localOcrProvider:{policyId:'c'.repeat(64),health:async()=>{ocrCalls.push('health');return {available:false,engine:'windows-media-ocr',languages:[]};},recognize:async()=>assert.fail('No OCR recognition is permitted'),close:async()=>({callbacksSettled:true})},
    codeExecutor, desktopDriver, taskClock: () => stamp, broadcast: (...args) => events.push(args), webRequestImpl: async () => assert.fail('No public web request is permitted') });
  app.use(apiError); server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  function request(method, route, body) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, method, path: route,
        headers: { Host: `127.0.0.1:${PORT}`, Connection: 'close', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) } }, incoming => {
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) incoming.destroy(new Error('Oversized isolated fixture response')); else chunks.push(chunk); });
        incoming.on('error', reject); incoming.on('end', () => { try { resolve({ status: incoming.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (caught) { reject(caught); } });
      }); outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Isolated HTTP request timed out'))); outgoing.on('error', reject); outgoing.end(payload);
    });
  }
  const spec = overrides => ({ title: 'HTTP scheduled fixture', goal: 'Return the isolated fixture answer.', model: MODEL,
    schedule: { kind: 'once', at: new Date(stamp + 60000).toISOString() }, budget: { maxTotalTokens: 64000 }, limits: { maxRuns: 1, maxTotalTokens: 64000 }, ...overrides });
  const run = async (id, predicate) => until(async () => { const value = await request('GET', `/api/agent/runs/${id}`); assert.equal(value.status, 200); return predicate(value.json) && value.json; });
  return { runtime, db, workspace, calls, chats, events, controllerCalls, executorCalls,ocrCalls, request, spec, run, now: () => stamp, advance: ms => { stamp += ms; } };
}

test('runtime construction is inert with the full bounded registry and never invokes a native controller', async t => {
  const f = await fixture(t); assert.equal(f.calls.length, 0); assert.equal(f.chats.length, 0); assert.deepEqual(f.runtime.tasks.list(), []);
  assert.deepEqual(f.ocrCalls,[]);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM scheduled_task_occurrences').get().n, 0);
  const caps = await f.request('GET', '/api/agent/capabilities'); assert.equal(caps.status, 200);
  const builtins = new Set(['workspace.list','workspace.read','workspace.search','workspace.write','workspace.edit','workspace.patch','workspace.map','workspace.readMany','code.run','memory.remember','memory.search','tools.enable']);
  assert.equal(caps.json.tools.filter(tool => !builtins.has(tool.name)).length, 39);
  const wireBytes = Buffer.byteLength(JSON.stringify(caps.json.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))));
  assert.ok(wireBytes <= 65536); assert.ok(caps.json.tools.some(tool => tool.name === 'tasks.createOnce')); assert.ok(caps.json.tools.some(tool => tool.name === 'clock.now'));
  assert.equal(caps.json.cloudEnabled, false); assert.equal(caps.json.codeExecution.available, false); assert.equal(f.chats.length, 0);
  assert.deepEqual(f.controllerCalls, []); assert.deepEqual(f.executorCalls, []);assert.deepEqual(f.ocrCalls,['health']); t.diagnostic(`39 extra tools; wire registry ${wireBytes}/65536 bytes; zero constructor provider calls, one explicit OCR availability read`);
});

test('private task HTTP APIs use flat tasks, current-state request recovery, tombstones and revision checks without dispatch', async t => {
  const f = await fixture(t), preview = await f.request('POST', '/api/tasks/preview', f.spec()); assert.equal(preview.status, 200); assert.equal(preview.json.firstRunAt, INITIAL + 60000);
  const input = { ...preview.json.spec, requestId: 'http-task-create', expectedFirstRunAt: preview.json.firstRunAt };
  const created = await f.request('POST', '/api/tasks', input); assert.equal(created.status, 201); assert.equal(created.json.status, 'active'); assert.equal(typeof created.json.id, 'string'); assert.equal(created.json.task, undefined);
  const taskId = created.json.id, recovered = await f.request('GET', '/api/task-requests/http-task-create'); assert.equal(recovered.json.state, 'created'); assert.equal(recovered.json.task.id, taskId);
  assert.equal((await f.request('POST', '/api/tasks', input)).json.id, taskId); assert.equal((await f.request('GET', '/api/tasks')).json.tasks.length, 1);
  const badPreview = await f.request('POST', '/api/tasks', { ...input, requestId: 'wrong-time', expectedFirstRunAt: preview.json.firstRunAt + 1 }); assert.equal(badPreview.status, 400); assert.equal(badPreview.json.code, 'task_preview_stale');
  const paused = await f.request('POST', `/api/tasks/${taskId}/pause`, { requestId: 'http-task-pause', expectedRevision: 1 }); assert.equal(paused.json.status, 'paused'); assert.equal(paused.json.revision, 2);
  assert.equal((await f.request('GET', '/api/task-requests/http-task-create')).json.task.status, 'paused');
  const stale = await f.request('POST', `/api/tasks/${taskId}/resume`, { requestId: 'stale-resume', expectedRevision: 1 }); assert.equal(stale.status, 400); assert.equal(stale.json.code, 'task_revision_conflict');
  const resumed = await f.request('POST', `/api/tasks/${taskId}/resume`, { requestId: 'http-task-resume', expectedRevision: 2 }); assert.equal(resumed.json.status, 'active'); assert.equal(resumed.json.generation, 2); assert.ok(resumed.json.nextRunAt > f.now());
  const changedPreview = await f.request('POST', '/api/tasks/preview', f.spec({ goal: 'A freshly reviewed isolated goal.' }));
  const updated = await f.request('POST', `/api/tasks/${taskId}/update`, { ...changedPreview.json.spec, requestId: 'http-task-update', expectedRevision: 3, expectedFirstRunAt: changedPreview.json.firstRunAt });
  assert.equal(updated.status, 200); assert.equal(updated.json.revision, 4); assert.equal(updated.json.generation, 3); assert.equal(updated.json.task, undefined);
  const archived = await f.request('POST', `/api/tasks/${taskId}/archive`, { requestId: 'http-task-archive', expectedRevision: 4 }); assert.equal(archived.json.status, 'archived');
  assert.equal((await f.request('POST', `/api/tasks/${taskId}/resume`, { requestId: 'archive-resume', expectedRevision: 5 })).json.code, 'task_state');
  const tombstone = await f.request('POST', '/api/task-requests/lost-create/cancel', {}); assert.equal(tombstone.status, 200); assert.equal(tombstone.json.state, 'cancelled');
  const lost = await f.request('POST', '/api/tasks', { ...input, requestId: 'lost-create' }); assert.equal(lost.status, 400); assert.equal(lost.json.code, 'task_request_cancelled');
  assert.equal((await f.request('GET', '/api/task-requests/lost-create')).json.state, 'cancelled'); assert.equal((await f.request('GET', '/api/tasks')).json.tasks.length, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.chats.length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM scheduled_task_occurrences').get().n, 0);
});

test('clock.now uses the server-injected task clock and creates no scheduled authority', async t => {
  const f = await fixture(t, body => body.messages.some(message => message.role === 'tool') ? completion('Clock observed.') : completion('', [call('clock-fixture', 'clock.now', {})]));
  const response = await f.request('POST', '/api/agent/runs', { requestId: 'clock-run', conversationId: 'clock-conversation', goal: 'Read the server clock.', model: MODEL }); assert.equal(response.status, 201);
  const done = await f.run(response.json.id, run => TERMINAL.has(run.status)); assert.equal(done.status, 'completed');
  const events = await f.request('GET', `/api/agent/runs/${done.id}/events`), result = events.json.events.find(event => event.type === 'tool_result' && event.data.name === 'clock.now');
  assert.equal(result.data.result.epochMs, INITIAL); assert.equal(result.data.result.utc, new Date(INITIAL).toISOString()); assert.deepEqual(f.runtime.tasks.list(), []);
});

test('scheduled creation and its later workspace effect require two separate exact native approvals', async t => {
  const filename = 'scheduled-approval-proof.txt', content = 'Only the second exact approval permits this fixture write.';
  const createArgs = { title: 'Two independent approvals', goal: `Create ${filename} with the exact approved fixture content.`, model: MODEL, at: new Date(INITIAL + 60000).toISOString(),
    budget: { maxInputTokens: 16384, maxTotalTokens: 64000, maxOutputTokens: 512, maxSteps: 4 }, limits: { maxRuns: 1, maxTotalTokens: 64000 } };
  const f = await fixture(t, body => {
    const goal = body.messages.filter(message => message.role === 'user').at(-1).content, hasResult = body.messages.some(message => message.role === 'tool');
    if (goal.includes('Schedule one local fixture write')) return hasResult ? completion('The task was created after approval.') : completion('', [call('create-once-fixture', 'tasks.createOnce', createArgs)]);
    assert.equal(goal, createArgs.goal); return hasResult ? completion('The separate approved file effect is verified.') : completion('', [call('write-fixture', 'workspace.write', { path: filename, content, createOnly: true })]);
  });
  const started = await f.request('POST', '/api/agent/runs', { requestId: 'interactive-create-task', conversationId: 'interactive-task-conversation', goal: 'Schedule one local fixture write with its exact reviewed limits.', model: MODEL,
    budget: { maxInputTokens: 32768, maxTotalTokens: 200000, maxOutputTokens: 512, maxSteps: 4 } }); assert.equal(started.status, 201);
  const first = await f.run(started.json.id, run => run.status === 'awaiting_approval' || TERMINAL.has(run.status)); assert.equal(first.status, 'awaiting_approval', JSON.stringify(first.error));
  assert.equal(first.pendingApproval.name, 'tasks.createOnce'); assert.equal(first.pendingApproval.preview.kind, 'task_change'); assert.equal(f.runtime.tasks.list().length, 0);
  const wrong = await f.request('POST', `/api/agent/runs/${first.id}/approve`, { approvalId: 'wrong-first-approval', approved: true }); assert.equal(wrong.json.code, 'approval_mismatch'); assert.equal(f.runtime.tasks.list().length, 0);
  assert.equal((await f.request('POST', `/api/agent/runs/${first.id}/approve`, { approvalId: first.pendingApproval.approvalId, approved: true })).status, 200);
  assert.equal((await f.run(first.id, run => TERMINAL.has(run.status))).status, 'completed');
  const listed = await f.request('GET', '/api/tasks'); assert.equal(listed.json.tasks.length, 1); const task = listed.json.tasks[0];
  assert.equal(task.goal, createArgs.goal); assert.equal(task.currentRunId, null); assert.equal(task.runsStarted, 0);
  const sourceRun = (await f.request('GET', `/api/agent/runs/${first.id}`)).json; assert.equal(sourceRun.privateContextLocalOnly, true);
  const firstEvents = (await f.request('GET', `/api/agent/runs/${first.id}/events`)).json.events;
  assert.ok(firstEvents.some(event => event.type === 'task_receipt' && event.data.receipt.taskId === task.id));
  const target = path.join(f.workspace, filename); await assert.rejects(fs.access(target), { code: 'ENOENT' });
  f.advance(60000); await f.runtime.tasks.tick();
  const scheduledId = f.runtime.tasks.get(task.id).currentRunId; assert.ok(scheduledId);
  const second = await f.run(scheduledId, run => run.status === 'awaiting_approval' || TERMINAL.has(run.status)); assert.equal(second.status, 'awaiting_approval', JSON.stringify(second.error));
  assert.equal(second.pendingApproval.name, 'workspace.write'); assert.notEqual(second.pendingApproval.approvalId, first.pendingApproval.approvalId); assert.equal(second.provenance.kind, 'scheduled_task');
  assert.equal(second.provenance.taskId, task.id); assert.equal(second.provider, 'ollama'); assert.equal(second.allowCloud, false); assert.equal(second.privateContextLocalOnly, true);
  assert.deepEqual(second.attachments, []); assert.equal(second.desktopSessionId, undefined); await f.runtime.tasks.tick();
  assert.equal(f.runtime.tasks.get(task.id).status, 'attention'); assert.equal(f.runtime.tasks.get(task.id).history[0].receipt.approvalId, second.pendingApproval.approvalId); await assert.rejects(fs.access(target), { code: 'ENOENT' });
  const reuse = await f.request('POST', `/api/agent/runs/${second.id}/approve`, { approvalId: first.pendingApproval.approvalId, approved: true }); assert.equal(reuse.json.code, 'approval_mismatch'); await assert.rejects(fs.access(target), { code: 'ENOENT' });
  assert.equal((await f.request('POST', `/api/agent/runs/${second.id}/approve`, { approvalId: second.pendingApproval.approvalId, approved: true })).status, 200);
  assert.equal((await f.run(second.id, run => TERMINAL.has(run.status))).status, 'completed'); assert.equal(await fs.readFile(target, 'utf8'), content);
  await f.runtime.tasks.tick(); assert.equal(f.runtime.tasks.get(task.id).status, 'completed'); assert.equal(f.runtime.tasks.get(task.id).attention, null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_approvals WHERE status=?').get('consumed').n, 2);
  assert.deepEqual(f.controllerCalls, []); assert.deepEqual(f.executorCalls, []);
});
