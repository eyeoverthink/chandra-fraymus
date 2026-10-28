import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import * as fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {createAgentService} from '../server/agent/service.js';
import {hash, stableJson} from '../server/agent/schema.js';

const ORIGIN = 'http://127.0.0.1:49968';
const INITIAL = {'a.txt': '\uFEFFalpha A\r\n', 'b.txt': 'alpha B\n', 'c.txt': 'alpha C\r'};
const changed = name => INITIAL[name].replace('alpha', 'ALPHA');
const native = (name, args) => ({id: 'owned-' + name, function: {name, arguments: args}});
const response = calls => ({done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 10,
  message: {role: 'assistant', content: calls ? '' : 'The approved synthetic patch was verified.', ...(calls ? {tool_calls: calls} : {})}});

async function until(predicate) {
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Owned patch integration fixture did not reach its expected state');
}
const terminal = f => until(() => {
  const run = f.agent.get(f.run.id);
  return ['completed', 'failed', 'cancelled'].includes(run.status) && run;
});

async function fixture(t, {sibling = false, budget, onReceipt, onResult, afterPatch} = {}) {
  const work = path.resolve(import.meta.dirname, '../../work');
  await fs.mkdir(work, {recursive: true});
  const parent = await fs.realpath(work), folder = await fs.mkdtemp(path.join(parent, 'patch-integration-'));
  const original = await fs.realpath(folder), db = new DatabaseSync(':memory:'), chats = [], events = [], hookErrors = [];
  await Promise.all(Object.entries(INITIAL).map(([name, text]) => fs.writeFile(path.join(folder, name), text)));
  const args = {files: Object.entries(INITIAL).map(([name, text]) => ({path: name, expectedHash: hash(text), edits: [{oldText: 'alpha', newText: 'ALPHA'}]}))};
  let agent;
  agent = createAgentService({db, workspace: folder, ollamaUrl: ORIGIN,
    onEvent: event => {
      events.push(event);
      if (event.type === 'workspace_receipt' && onReceipt) {
        try {onReceipt(event, {agent, db, folder});} catch (caught) {hookErrors.push(caught);}
      }
      if (event.type === 'tool_result' && onResult) {
        try {onResult(event);} catch (caught) {hookErrors.push(caught);}
      }
    },
    fetchImpl: async (value, request = {}) => {
      const url = new URL(value);
      assert.equal(url.origin, ORIGIN, 'The fixture has no real network adapter');
      if (url.pathname === '/api/show') return Response.json({capabilities: ['completion', 'tools']});
      assert.equal(url.pathname, '/api/chat');
      const body = JSON.parse(request.body); chats.push(body);
      assert.ok(body.tools.some(tool => tool.function.name === 'workspace.patch'), 'The original patch goal must advertise the coding group');
      if (chats.length === 1) return Response.json(response([
        native('workspace.patch', args),
        ...(sibling ? [native('workspace.write', {path: 'forbidden-sibling.txt', content: 'Unapproved sibling must never execute.', createOnly: true})] : []),
      ]));
      assert.equal(chats.length, 2, 'No unbounded model continuation exists');
      assert.ok(afterPatch, 'An incomplete or cancelled patch must not reach another model request');
      afterPatch(body);
      return Response.json(response());
    },
  });
  t.after(async () => {
    const closed = await agent.close({timeoutMs: 1500});
    assert.equal(closed.callbacksSettled, true);
    db.close();
    const checked = await fs.realpath(folder);
    assert.equal(checked, original); assert.equal(path.dirname(checked), parent); assert.ok(path.basename(checked).startsWith('patch-integration-'));
    await fs.rm(checked, {recursive: true, force: true});
  });
  const run = await agent.start({requestId: 'owned-patch-run', conversationId: 'owned-patch-conversation',
    goal: 'Apply this synthetic patch across the three workspace files.', model: 'patch-fixture:local', ...(budget ? {budget} : {})});
  const waiting = await until(() => {
    const value = agent.get(run.id);
    return (value.approval || ['failed', 'cancelled'].includes(value.status)) && value;
  });
  assert.equal(waiting.status, 'awaiting_approval', JSON.stringify(waiting.error));
  assert.equal(waiting.approval.name, 'workspace.patch');
  assert.equal(db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
  for (const [name, text] of Object.entries(INITIAL)) assert.deepEqual(await fs.readFile(path.join(folder, name)), Buffer.from(text));
  return {agent, db, folder, args, chats, events, hookErrors, run, approval: waiting.approval};
}

function approve(f) {return f.agent.approve(f.run.id, {approvalId: f.approval.approvalId, approved: true});}
async function noSibling(f) {
  await assert.rejects(fs.access(path.join(f.folder, 'forbidden-sibling.txt')), {code: 'ENOENT'});
  const approvals = f.db.prepare('SELECT tool_name,status FROM agent_approvals').all();
  assert.deepEqual(approvals.map(row => ({...row})), [{tool_name: 'workspace.patch', status: 'consumed'}]);
  assert.ok(!f.agent.events(f.run.id).some(event => event.type === 'tool_started' && event.data.name === 'workspace.write'));
  assert.equal(f.chats.length, 1);
  assert.deepEqual(f.hookErrors, []);
}

test('one exact full approval authorizes the patch, while tiny model results retain the full independent receipt', async t => {
  let modelReceipt;
  const f = await fixture(t, {budget: {maxToolResultChars: 256}, afterPatch: body => {
    const tool = body.messages.filter(message => message.role === 'tool').at(-1);
    assert.equal(tool.tool_name, 'workspace.patch');
    assert.equal(tool.tool_call_id, 'owned-workspace.patch');
    assert.match(tool.content, /^UNTRUSTED TOOL OUTPUT/);
    const serialized = tool.content.slice(tool.content.indexOf('\n') + 1);
    assert.ok(serialized.length <= 256);
    modelReceipt = JSON.parse(serialized);
    assert.equal(modelReceipt.ok, true); assert.equal(modelReceipt.outcome, 'verified');
    assert.equal(typeof modelReceipt.effectId, 'string');
  }});
  const preview = f.approval.preview;
  assert.equal(preview.kind, 'workspace_patch'); assert.equal(preview.complete, true); assert.equal(preview.atomic, false);
  assert.equal(preview.fileCount, 3); assert.ok(JSON.stringify(preview).length <= 24000);
  assert.deepEqual(f.approval.arguments, f.args);
  for (let i = 0; i < 3; i++) {
    const file = preview.files[i], name = f.args.files[i].path;
    assert.equal(file.path, name); assert.equal(file.expectedHash, hash(INITIAL[name])); assert.equal(file.newHash, hash(changed(name)));
    assert.equal(file.edits[0].oldText, 'alpha'); assert.equal(file.edits[0].newText, 'ALPHA');
  }
  assert.throws(() => f.agent.approve(f.run.id, {approvalId: 'wrong-approval', approved: true}), {code: 'approval_mismatch'});
  assert.equal(f.agent.get(f.run.id).status, 'awaiting_approval');
  approve(f);
  const stopped = await terminal(f); assert.equal(stopped.status, 'completed', JSON.stringify(stopped.error));
  const row = f.db.prepare('SELECT * FROM agent_workspace_patches').get(), receipt = JSON.parse(row.receipt_json);
  assert.equal(row.status, 'verified'); assert.equal(receipt.effectId, modelReceipt.effectId);
  assert.equal(receipt.files.length, 3); assert.equal(receipt.complete, true);
  const result = f.agent.events(f.run.id).find(event => event.type === 'tool_result' && event.data.name === 'workspace.patch');
  assert.deepEqual(result.data.receipt, receipt); assert.equal(result.data.result.effectId, receipt.effectId);
  assert.ok(JSON.stringify(result.data.receipt).length > 256);
  const progress = f.agent.events(f.run.id).filter(event => event.type === 'workspace_receipt');
  assert.deepEqual(progress.map(event => event.data.receipt.counts.verified), [1, 2, 3, 3]);
  assert.equal(new Set(progress.map(event => event.data.receipt.effectId)).size, 1);
  for (const name of Object.keys(INITIAL)) assert.deepEqual(await fs.readFile(path.join(f.folder, name)), Buffer.from(changed(name)));
  assert.throws(() => approve(f), {code: 'approval_mismatch'});
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 1);
  assert.deepEqual(f.hookErrors, []);
});

test('a real later-file conflict produces partial durable progress and stops the native sibling before approval', async t => {
  let changedExternally = false;
  const f = await fixture(t, {sibling: true, onReceipt: (event, {folder}) => {
    const receipt = event.data.receipt;
    if (!changedExternally && receipt.kind === 'workspace_patch' && receipt.outcome === 'in_progress' && receipt.counts.verified === 1) {
      changedExternally = true;
      // Synthetic non-cooperating editor; the shared queue intentionally cannot lock external actors.
      writeFileSync(path.join(folder, 'b.txt'), 'External work must remain.\n');
    }
  }});
  approve(f);
  const stopped = await terminal(f);
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.error.code, 'workspace_patch_partial');
  assert.equal(changedExternally, true);
  const row = f.db.prepare('SELECT * FROM agent_workspace_patches').get(), receipt = JSON.parse(row.receipt_json);
  assert.equal(row.status, 'partial'); assert.equal(receipt.complete, true);
  assert.deepEqual(receipt.counts, {total: 3, verified: 1, unknown: 0, notDispatched: 2, pending: 0});
  assert.equal(receipt.files[1].code, 'write_conflict'); assert.equal(receipt.files[1].dispatchAttempted, false);
  assert.equal(await fs.readFile(path.join(f.folder, 'a.txt'), 'utf8'), changed('a.txt'));
  assert.equal(await fs.readFile(path.join(f.folder, 'b.txt'), 'utf8'), 'External work must remain.\n');
  assert.equal(await fs.readFile(path.join(f.folder, 'c.txt'), 'utf8'), INITIAL['c.txt']);
  const result = f.agent.events(f.run.id).find(event => event.type === 'tool_result' && event.data.name === 'workspace.patch');
  assert.deepEqual(result.data.receipt, receipt);
  await noSibling(f);
});

test('an existing unknown approval receipt is returned without replay and prevents every sibling effect', async t => {
  const f = await fixture(t, {sibling: true}), approved = f.db.prepare('SELECT * FROM agent_approvals WHERE id=?').get(f.approval.approvalId);
  const effectId = 'owned-existing-unknown-patch', preview = JSON.parse(approved.preview_json), stamp = Date.now();
  const statuses = ['verified', 'unknown', 'not_dispatched'];
  await fs.writeFile(path.join(f.folder, 'a.txt'), changed('a.txt'));
  await fs.writeFile(path.join(f.folder, 'b.txt'), 'uncertain owned bytes\n');
  const files = preview.files.map((file, ordinal) => ({path: file.path, expectedHash: file.expectedHash, newHash: file.newHash,
    bytesBefore: file.bytesBefore, bytesAfter: file.bytesAfter, editCount: file.edits.length,
    status: statuses[ordinal], outcome: statuses[ordinal], dispatchAttempted: ordinal < 2, verified: ordinal === 0,
    ...(ordinal === 0 ? {observedHash: file.newHash, observedBytes: file.bytesAfter} : {}),
    ...(ordinal === 1 ? {observedHash: hash('uncertain owned bytes\n'), observedBytes: Buffer.byteLength('uncertain owned bytes\n'), code: 'patch_write_unknown'} : {}),
  }));
  const receipt = {kind: 'workspace_patch', effectId, status: 'unknown', outcome: 'unknown', complete: true, atomic: false, verified: false,
    dispatchAttempted: true, counts: {total: 3, verified: 1, unknown: 1, notDispatched: 1, pending: 0}, files, code: 'patch_write_unknown'};
  f.db.prepare(`INSERT INTO agent_workspace_patches(id,run_id,approval_id,args_hash,preview_json,file_count,status,stop_code,receipt_json,created_at,updated_at,notified_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(effectId, f.run.id, approved.id, approved.args_hash, stableJson(preview), 3, 'unknown', 'patch_write_unknown', JSON.stringify(receipt), stamp, stamp, stamp);
  const insert = f.db.prepare(`INSERT INTO agent_workspace_patch_files(patch_id,ordinal,path,expected_hash,new_hash,bytes_before,bytes_after,edit_count,status,dispatch_attempted,observed_hash,observed_bytes,code,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  files.forEach((file, ordinal) => insert.run(effectId, ordinal, file.path, file.expectedHash, file.newHash, file.bytesBefore, file.bytesAfter,
    file.editCount, file.status, file.dispatchAttempted ? 1 : 0, file.observedHash ?? null, file.observedBytes ?? null, file.code ?? null, stamp));
  approve(f);
  const stopped = await terminal(f); assert.equal(stopped.status, 'failed'); assert.equal(stopped.error.code, 'workspace_patch_unknown');
  const result = f.agent.events(f.run.id).find(event => event.type === 'tool_result' && event.data.name === 'workspace.patch');
  assert.deepEqual(result.data.receipt, receipt);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 1);
  assert.equal(await fs.readFile(path.join(f.folder, 'b.txt'), 'utf8'), 'uncertain owned bytes\n');
  assert.equal(await fs.readFile(path.join(f.folder, 'c.txt'), 'utf8'), INITIAL['c.txt']);
  await noSibling(f);
});

test('cancellation after progress preserves a later terminal receipt and does not dispatch remaining files', async t => {
  let cancelled = false;
  const f = await fixture(t, {sibling: true, onReceipt: (event, {agent}) => {
    const receipt = event.data.receipt;
    if (!cancelled && receipt.kind === 'workspace_patch' && receipt.outcome === 'in_progress' && receipt.counts.verified === 1) {
      cancelled = true; agent.cancel(event.runId);
    }
  }});
  approve(f);
  const stopped = await terminal(f); assert.equal(stopped.status, 'cancelled');
  const closed = await f.agent.close({timeoutMs: 1500}); assert.equal(closed.callbacksSettled, true);
  assert.equal(cancelled, true);
  const row = f.db.prepare('SELECT * FROM agent_workspace_patches').get(), receipt = JSON.parse(row.receipt_json);
  assert.equal(row.status, 'partial'); assert.equal(receipt.complete, true); assert.equal(receipt.code, 'cancelled');
  assert.deepEqual(receipt.counts, {total: 3, verified: 1, unknown: 0, notDispatched: 2, pending: 0});
  const events = f.agent.events(f.run.id), cancellation = events.find(event => event.type === 'cancelled');
  const progress = events.filter(event => event.type === 'workspace_receipt');
  assert.equal(progress.length, 2); assert.equal(progress[0].data.receipt.outcome, 'in_progress');
  assert.equal(progress[1].data.receipt.outcome, 'partial'); assert.deepEqual(progress[1].data.receipt, receipt);
  assert.ok(progress[1].sequence > cancellation.sequence);
  assert.equal(f.agent.get(f.run.id).status, 'cancelled');
  assert.ok(!events.some(event => event.type === 'tool_result' && event.data.name === 'workspace.patch'));
  assert.equal(await fs.readFile(path.join(f.folder, 'a.txt'), 'utf8'), changed('a.txt'));
  assert.equal(await fs.readFile(path.join(f.folder, 'b.txt'), 'utf8'), INITIAL['b.txt']);
  assert.equal(await fs.readFile(path.join(f.folder, 'c.txt'), 'utf8'), INITIAL['c.txt']);
  await noSibling(f);
});

test('a database failure publishing post-write progress leaves independent uncertainty and stops siblings even without a tool receipt', async t => {
  const f = await fixture(t, {sibling: true});
  f.db.exec(`CREATE TRIGGER owned_fail_patch_publication BEFORE UPDATE OF receipt_json ON agent_workspace_patches
    WHEN NEW.receipt_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'owned synthetic publication failure'); END`);
  approve(f);
  const stopped = await terminal(f); assert.equal(stopped.status, 'failed'); assert.equal(stopped.error.code, 'workspace_patch_unknown');
  const row = f.db.prepare('SELECT * FROM agent_workspace_patches').get();
  assert.equal(row.status, 'in_progress'); assert.equal(row.receipt_json, null);
  const children = f.db.prepare('SELECT status,dispatch_attempted FROM agent_workspace_patch_files ORDER BY ordinal').all();
  assert.deepEqual(children.map(child => ({...child})), [
    {status: 'verified', dispatch_attempted: 1}, {status: 'prepared', dispatch_attempted: 0}, {status: 'prepared', dispatch_attempted: 0},
  ]);
  assert.equal(await fs.readFile(path.join(f.folder, 'a.txt'), 'utf8'), changed('a.txt'));
  assert.equal(await fs.readFile(path.join(f.folder, 'b.txt'), 'utf8'), INITIAL['b.txt']);
  assert.equal(await fs.readFile(path.join(f.folder, 'c.txt'), 'utf8'), INITIAL['c.txt']);
  assert.ok(!f.agent.events(f.run.id).some(event => event.type === 'tool_result' && event.data.name === 'workspace.patch'));
  await noSibling(f);
});

test('a tool-result event observer cannot turn a partial patch into authority for a sibling', async t => {
  let external = false, observerAttempted = false;
  const f = await fixture(t, {sibling: true,
    onReceipt: (event, {folder}) => {
      if (!external && event.data.receipt.outcome === 'in_progress') {
        external = true; writeFileSync(path.join(folder, 'b.txt'), 'Owned external change\n');
      }
    },
    onResult: event => {
      if (event.data.name !== 'workspace.patch') return;
      observerAttempted = true;
      // Notification consumers have no authority to change the journal or the
      // service's control-flow decision. Cloning and freezing are both valid.
      try {event.data.receipt.outcome = 'verified';}
      catch (caught) {assert.equal(caught.name, 'TypeError');}
    },
  });
  approve(f);
  const stopped = await until(() => {
    const run = f.agent.get(f.run.id);
    return (['completed', 'failed', 'cancelled'].includes(run.status)
      || run.approval?.name === 'workspace.write') && run;
  });
  assert.equal(observerAttempted, true);
  assert.equal(stopped.status, 'failed'); assert.equal(stopped.error.code, 'workspace_patch_partial');
  assert.equal(f.db.prepare('SELECT status FROM agent_workspace_patches').get().status, 'partial');
  const saved = f.agent.events(f.run.id).find(event => event.type === 'tool_result' && event.data.name === 'workspace.patch');
  assert.equal(saved.data.receipt.outcome, 'partial');
  await noSibling(f);
});
