import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentService } from '../server/agent/service.js';
import { hash } from '../server/agent/schema.js';

const ORIGINAL = '\uFEFFexport const value = 1;\r\n', CHANGED = '\uFEFFexport const value = 2;\r\n';
const ORIGIN = 'http://127.0.0.1:49967';
const native = (name, args) => ({ function: { name, arguments: args } });
const reply = calls => ({ done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10,
  message: { role: 'assistant', content: '', tool_calls: calls } });
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Owned edit policy fixture did not reach its expected state');
}

async function fixture(t, { sibling = false, cancelOnReceipt = false, text = ORIGINAL,
  chat, goal = 'Apply the one exact synthetic constant edit.', budget, expectedStatus = 'awaiting_approval' } = {}) {
  const work = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(work, { recursive: true });
  const parent = await fs.realpath(work), folder = await fs.mkdtemp(path.join(parent, 'edit-policy-'));
  const originalFolder = await fs.realpath(folder), target = path.join(folder, 'source.js');
  await fs.writeFile(target, text, 'utf8');
  const db = new DatabaseSync(':memory:'), chats = [], events = []; let agent;
  const args = { path: 'source.js', expectedHash: hash(text), edits: [{ oldText: 'value = 1', newText: 'value = 2' }] };
  agent = createAgentService({ db, workspace: folder, ollamaUrl: ORIGIN,
    onEvent: event => {
      events.push(event);
      if (cancelOnReceipt && event.type === 'workspace_receipt') agent.cancel(event.runId);
    },
    fetchImpl: async (value, request = {}) => {
      const url = new URL(value); assert.equal(url.origin, ORIGIN, 'No real network adapter exists');
      if (url.pathname === '/api/show') return Response.json({ capabilities: ['completion', 'tools'] });
      assert.equal(url.pathname, '/api/chat'); const body = JSON.parse(request.body); chats.push(body);
      if (chat) return Response.json(await chat(body, chats.length, { db, target, agent }));
      if (chats.length === 1) {
        const discovery = body.tools.find(item => item.function.name === 'tools.enable'); assert.ok(discovery);
        assert.ok(discovery.function.parameters.properties.group.enum.includes('coding'));
        return Response.json(reply([native(discovery.function.name, { group: 'coding' })]));
      }
      assert.equal(chats.length, 2, 'An uncertain or cancelled edit must not reach another model turn');
      const edit = body.tools.find(item => item.function.name === 'workspace.edit'); assert.ok(edit);
      return Response.json(reply([native(edit.function.name, args), ...(sibling
        ? [native('workspace.write', { path: 'forbidden-sibling.txt', content: 'Must not be written or approved.', createOnly: true })] : [])]));
    } });
  t.after(async () => {
    const closed = await agent.close({ timeoutMs: 1000 }); assert.equal(closed.callbacksSettled, true); db.close();
    const targetFolder = await fs.realpath(folder);
    assert.equal(targetFolder, originalFolder); assert.equal(path.dirname(targetFolder), parent); assert.ok(path.basename(targetFolder).startsWith('edit-policy-'));
    await fs.rm(targetFolder, { recursive: true, force: true });
  });
  const source = await agent.start({ requestId: 'edit-policy-source', conversationId: 'edit-policy-conversation',
    goal, model: 'edit-policy-fixture:local', ...(budget ? { budget } : {}) });
  const waiting = await until(() => { const run = agent.get(source.id); return (run.approval || ['failed', 'cancelled'].includes(run.status)) && run; });
  assert.equal(waiting.status, expectedStatus, JSON.stringify(waiting.error));
  if (expectedStatus === 'awaiting_approval') assert.equal(waiting.approval.name, 'workspace.edit');
  assert.equal(await fs.readFile(target, 'utf8'), text);
  return { db, agent, folder, target, chats, events, args, source, state: waiting, approval: waiting.approval };
}

test('an existing unknown edit receipt stops the native batch before a sibling approval or another model call', async t => {
  const f = await fixture(t, { sibling: true });
  const approved = f.db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(f.approval.approvalId);
  // Inject a durable uncertain backend result, rather than simulating a disk
  // failure already covered by the real-filesystem edit tests. Its receipt must
  // make the service stop, and its approval identity must prevent a write retry.
  const receipt = { kind: 'workspace_edit', effectId: 'owned-existing-unknown', path: 'source.js',
    expectedHash: hash(ORIGINAL), newHash: hash(CHANGED), outcome: 'unknown',
    dispatchAttempted: true, verified: false, atomic: false, code: 'edit_interrupted_unknown' };
  f.db.prepare(`INSERT INTO agent_workspace_effects
    (id,run_id,approval_id,args_hash,path,expected_hash,new_hash,status,receipt_json,created_at,updated_at,notified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.effectId, f.source.id, approved.id, approved.args_hash, receipt.path,
    receipt.expectedHash, receipt.newHash, 'unknown', JSON.stringify(receipt), 1, 1, 1);
  f.agent.approve(f.source.id, { approvalId: approved.id, approved: true });
  const stopped = await until(() => { const run = f.agent.get(f.source.id); return ['completed', 'failed', 'cancelled'].includes(run.status) && run; });
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.error.code, 'workspace_edit_unknown');
  assert.equal(f.chats.length, 2); assert.equal(await fs.readFile(f.target, 'utf8'), ORIGINAL);
  await assert.rejects(fs.access(path.join(f.folder, 'forbidden-sibling.txt')), { code: 'ENOENT' });
  const approvals = f.db.prepare('SELECT tool_name,status FROM agent_approvals').all();
  assert.deepEqual(approvals.map(row => ({ ...row })), [{ tool_name: 'workspace.edit', status: 'consumed' }]);
  const events = f.agent.events(f.source.id), result = events.find(event => event.type === 'tool_result' && event.data.name === 'workspace.edit');
  assert.equal(result.data.receipt.outcome, 'unknown'); assert.equal(result.data.receipt.effectId, receipt.effectId);
  assert.ok(!events.some(event => event.type === 'tool_started' && event.data.name === 'workspace.write'));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_effects').get().n, 1);
});

test('source cancellation after a verified commit retains its durable receipt while ordinary tool output is suppressed', async t => {
  const f = await fixture(t, { cancelOnReceipt: true });
  f.agent.approve(f.source.id, { approvalId: f.approval.approvalId, approved: true });
  await until(() => f.agent.get(f.source.id).status === 'cancelled');
  const closed = await f.agent.close({ timeoutMs: 1000 }); assert.equal(closed.callbacksSettled, true);
  assert.equal(await fs.readFile(f.target, 'utf8'), CHANGED); assert.equal(f.chats.length, 2);
  const source = f.agent.get(f.source.id); assert.equal(source.status, 'cancelled');
  const events = f.agent.events(f.source.id), durable = events.find(event => event.type === 'workspace_receipt');
  assert.ok(durable); assert.equal(durable.data.receipt.outcome, 'verified');
  assert.equal(durable.data.receipt.observedHash, hash(CHANGED)); assert.equal(durable.data.receipt.atomic, false);
  assert.ok(events.find(event => event.type === 'cancelled').sequence > durable.sequence);
  assert.ok(!events.some(event => event.type === 'tool_result' && event.data.name === 'workspace.edit'));
  const effect = f.db.prepare('SELECT * FROM agent_workspace_effects').get();
  assert.equal(effect.status, 'verified'); assert.ok(effect.notified_at > 0);
  assert.equal(JSON.parse(effect.receipt_json).effectId, durable.data.receipt.effectId);
});

const AMBIGUOUS_SOURCE = 'export const first = "old";\r\nexport const second = "old";\r\n';
function codingIsInitiallyAvailable(body) {
  const names = new Set(body.tools.map(item => item.function.name));
  for (const name of ['workspace.edit', 'workspace.map', 'workspace.readMany']) assert.ok(names.has(name), `${name} must be advertised from the original coding goal`);
}
function toolData(body) {
  const latest = body.messages.filter(message => message.role === 'tool').at(-1);
  assert.ok(latest); assert.match(latest.content, /^UNTRUSTED TOOL OUTPUT/);
  return JSON.parse(latest.content.slice(latest.content.indexOf('\n') + 1));
}

test('one ambiguous preparation can read more context and propose an exact corrected edit, still requiring approval', async t => {
  let corrected;
  const f = await fixture(t, { text: AMBIGUOUS_SOURCE, goal: 'Refactor the first constant in this code fixture.',
    budget: { maxSteps: 4, maxToolCalls: 3, maxToolResultChars: 1000 },
    chat: async (body, index, { db, target }) => {
      codingIsInitiallyAvailable(body);
      if (index <= 3) {
        assert.equal(db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM agent_workspace_effects').get().n, 0);
        assert.equal(await fs.readFile(target, 'utf8'), AMBIGUOUS_SOURCE);
      }
      if (index === 1) return reply([native('workspace.edit', { path: 'source.js', expectedHash: hash(AMBIGUOUS_SOURCE), edits: [{ oldText: '"old"', newText: '"new"' }] })]);
      if (index === 2) {
        const failure = toolData(body);
        assert.equal(failure.code, 'edit_ambiguous'); assert.equal(failure.retryable, true);
        assert.equal(failure.preparationOnly, true); assert.equal(failure.dispatchAttempted, false);
        return reply([native('workspace.read', { path: 'source.js', preserveLineEndings: true })]);
      }
      if (index === 3) {
        const read = toolData(body); assert.equal(read.content, AMBIGUOUS_SOURCE); assert.equal(read.preserveLineEndings, true);
        const originalLine = read.content.split('\r\n')[0];
        corrected = { path: read.path, expectedHash: read.sha256, edits: [{ oldText: originalLine, newText: originalLine.replace('"old"', '"new"') }] };
        return reply([native('workspace.edit', corrected)]);
      }
      assert.equal(index, 4); assert.equal(toolData(body).receipt.outcome, 'verified');
      return { ...reply([]), message: { role: 'assistant', content: 'Only the exact approved first fragment changed.' } };
    } });
  assert.equal(f.chats.length, 3); assert.equal(f.state.usage.totalTokens, 330);
  assert.deepEqual(f.approval.arguments, corrected); assert.equal(f.approval.preview.edits.length, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n, 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_effects').get().n, 0);
  assert.throws(() => f.agent.approve(f.source.id, { approvalId: 'unrelated', approved: true }), { code: 'approval_mismatch' });
  assert.equal(await fs.readFile(f.target, 'utf8'), AMBIGUOUS_SOURCE);
  f.agent.approve(f.source.id, { approvalId: f.approval.approvalId, approved: true });
  const completed = await until(() => { const run = f.agent.get(f.source.id); return ['completed', 'failed', 'cancelled'].includes(run.status) && run; });
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error)); assert.equal(f.chats.length, 4);
  assert.equal(await fs.readFile(f.target, 'utf8'), 'export const first = "new";\r\nexport const second = "old";\r\n');
  assert.equal(f.db.prepare('SELECT status FROM agent_approvals').get().status, 'consumed');
  const results = f.agent.events(f.source.id).filter(event => event.type === 'tool_result' && event.data.name === 'workspace.edit');
  assert.equal(results.length, 2); assert.equal(results[0].data.result.preparationOnly, true); assert.equal(results[1].data.receipt.outcome, 'verified');
});

test('a second preparation ambiguity terminates the run without an approval or effect', async t => {
  const f = await fixture(t, { text: AMBIGUOUS_SOURCE, goal: 'Patch the first value in this code fixture.', expectedStatus: 'failed',
    budget: { maxSteps: 3, maxToolCalls: 2, maxToolResultChars: 1000 },
    chat: (body, index, { db }) => {
      codingIsInitiallyAvailable(body); assert.ok(index <= 2, 'No third model turn may follow repeated preparation failure');
      assert.equal(db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n, 0);
      if (index === 2) assert.equal(toolData(body).retryable, true);
      return reply([native('workspace.edit', { path: 'source.js', expectedHash: hash(AMBIGUOUS_SOURCE), edits: [{ oldText: '"old"', newText: '"new"' }] })]);
    } });
  assert.equal(f.state.error.code, 'edit_preparation_failed'); assert.equal(f.state.usage.totalTokens, 220); assert.equal(f.chats.length, 2);
  assert.equal(await fs.readFile(f.target, 'utf8'), AMBIGUOUS_SOURCE);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_approvals').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_effects').get().n, 0);
  const events = f.agent.events(f.source.id), failures = events.filter(event => event.type === 'tool_result' && event.data.name === 'workspace.edit');
  assert.equal(failures.length, 2); assert.deepEqual(failures.map(event => event.data.result.retryable), [true, false]);
  assert.ok(failures.every(event => event.data.result.preparationOnly === true && event.data.result.dispatchAttempted === false));
  assert.ok(!events.some(event => event.type === 'approval_required' || event.type === 'workspace_receipt' || event.type === 'tool_started'));
});
