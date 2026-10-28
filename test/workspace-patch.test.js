import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspacePolicy } from '../server/agent/workspace.js';
import { createWorkspacePatchTool, recoverWorkspacePatches } from '../server/agent/workspace-patch.js';
import { hash, stableJson } from '../server/agent/schema.js';

const approvalSchema = db => db.exec('CREATE TABLE agent_approvals(id TEXT PRIMARY KEY,run_id TEXT,tool_name TEXT,args_json TEXT,args_hash TEXT,preview_json TEXT,status TEXT)');
async function fixture(t, initial = { 'a.txt': 'alpha A\r\n', 'b.txt': '\uFEFFalpha B\n', 'c.txt': 'alpha C\r' }) {
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'chandra-workspace-patch-'));
  const originalDirectory = await fs.realpath(directory), files = new Set(), directories = new Set(), databases = [];
  const db = new DatabaseSync(':memory:'); databases.push(db); approvalSchema(db);
  const policy = createWorkspacePolicy(directory), receipts = [];
  const write = async (name, content) => {
    const relative = name.replaceAll('\\', '/'), target = path.join(directory, ...relative.split('/'));
    assert.ok(target.startsWith(directory + path.sep));
    let current = path.dirname(relative);
    while (current !== '.') { directories.add(current); current = path.dirname(current); }
    await fs.mkdir(path.dirname(target), { recursive: true }); files.add(relative); await fs.writeFile(target, content);
  };
  for (const [name, content] of Object.entries(initial)) await write(name, content);
  const callback = (runId, receipt) => receipts.push({ runId, receipt });
  const tool = createWorkspacePatchTool({ db, policy, onReceipt: callback });
  const args = (names = Object.keys(initial).slice(0, 2)) => ({ files: names.map(name => ({ path: name, expectedHash: hash(initial[name]), edits: [{ oldText: 'alpha', newText: 'ALPHA' }] })) });
  const context = (value = args(), signal = new AbortController().signal) => ({ args: value, run: { id: 'patch-source' }, signal });
  const approve = (ctx, preview, extra = {}) => {
    const id = randomUUID(), argsJson = stableJson(ctx.args);
    db.prepare('INSERT INTO agent_approvals VALUES(?,?,?,?,?,?,?)').run(id, ctx.run.id, extra.name ?? 'workspace.patch', argsJson,
      extra.argsHash ?? hash('workspace.patch\n' + argsJson), JSON.stringify(preview), extra.status ?? 'consumed');
    return { ...ctx, approvalId: id };
  };
  t.after(async () => {
    for (const database of databases) { try { database.close(); } catch (caught) { assert.equal(caught.code, 'ERR_INVALID_STATE'); } }
    const resolved = await fs.realpath(directory);
    assert.equal(resolved, originalDirectory); assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('chandra-workspace-patch-'));
    // Only exact files/directories created by this fixture are removed.
    for (const name of files) await fs.unlink(path.join(resolved, ...name.split('/'))).catch(caught => { if (caught.code !== 'ENOENT') throw caught; });
    for (const name of [...directories].sort((a, b) => b.length - a.length)) await fs.rmdir(path.join(resolved, ...name.split('/')));
    await fs.rmdir(resolved);
  });
  return { db, policy, directory, files, databases, initial, receipts, tool, args, context, approve, write,
    read: name => fs.readFile(path.join(directory, ...name.split('/'))),
    makeTool: (overrides = {}, onReceipt = callback) => createWorkspacePatchTool({ db, policy: { ...policy, ...overrides }, onReceipt }) };
}

test('approved batch preserves BOM/CRLF/raw bytes and publishes verified progress plus one terminal aggregate', async t => {
  const f = await fixture(t, { 'a.txt': '\uFEFFalpha😀\r\nline A\r', 'b.txt': 'alpha B\nline B\r\n' }), ctx = f.context();
  const preview = await f.tool.prepare(ctx);
  assert.equal(preview.kind, 'workspace_patch'); assert.equal(preview.complete, true); assert.equal(preview.atomic, false); assert.equal(preview.fileCount, 2);
  assert.equal(preview.files[0].utf8Bom, true); assert.deepEqual(preview.files[0].lineEndings, { lf: 0, crlf: 1, cr: 1 });
  assert.ok(JSON.stringify(preview).length <= 24000);
  const result = await f.tool.execute(f.approve(ctx, preview));
  assert.equal(result.ok, true); assert.equal(result.outcome, 'verified'); assert.equal(result.receipt.complete, true);
  for (const [name, original] of Object.entries(f.initial)) {
    const bytes = Buffer.from(original.replace('alpha', 'ALPHA'));
    assert.deepEqual(await f.read(name), bytes);
    const receipt = result.files.find(file => file.path === name);
    assert.equal(receipt.observedHash, hash(bytes)); assert.equal(receipt.observedBytes, bytes.length);
    assert.equal(receipt.bytesBefore, Buffer.byteLength(original)); assert.equal(receipt.bytesAfter, bytes.length); assert.equal(receipt.editCount, 1);
  }
  assert.equal(f.receipts.length, 3); assert.equal(new Set(f.receipts.map(item => item.receipt.effectId)).size, 1);
  assert.deepEqual(f.receipts[0].receipt.counts, { total: 2, verified: 1, unknown: 0, notDispatched: 0, pending: 1 });
  assert.equal(f.receipts[0].receipt.files[1].outcome, 'pending'); assert.equal(f.receipts[0].receipt.complete, false);
  assert.equal(f.receipts.at(-1).receipt.outcome, 'verified'); assert.equal(f.receipts.at(-1).receipt.complete, true);
  assert.equal(f.db.prepare('SELECT status FROM agent_workspace_patches').get().status, 'verified');
});

test('all plans and full combined preview must fit before any journal stage or write', async t => {
  const f = await fixture(t), args = f.args(); args.files[1].edits[0].oldText = 'missing literal';
  await assert.rejects(f.tool.prepare(f.context(args)), { code: 'edit_not_found' });
  const large = await fixture(t, { 'a.txt': '\\'.repeat(4000), 'b.txt': 'z'.repeat(6000) });
  const ctx = large.context({ files: [{ path: 'a.txt', expectedHash: hash(large.initial['a.txt']), edits: [{ oldText: large.initial['a.txt'], newText: 'a'.repeat(4000) }] },
    { path: 'b.txt', expectedHash: hash(large.initial['b.txt']), edits: [{ oldText: large.initial['b.txt'], newText: 'b'.repeat(6000) }] }] });
  await assert.rejects(large.tool.prepare(ctx), { code: 'patch_preview_too_large' });
  for (const fixture of [f, large]) {
    assert.equal(fixture.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
    for (const [name, original] of Object.entries(fixture.initial)) assert.equal((await fixture.read(name)).toString(), original);
  }
});

test('staging all child intents is one SQLite transaction, never a partially staged writable batch', async t => {
  const f = await fixture(t), ctx = f.context(), approved = f.approve(ctx, await f.tool.prepare(ctx));
  f.db.exec("CREATE TRIGGER fail_second_child BEFORE INSERT ON agent_workspace_patch_files WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'owned staging failure'); END");
  await assert.rejects(f.tool.execute(approved), /owned staging failure/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patch_files').get().n, 0);
  for (const [name, value] of Object.entries(f.initial)) assert.equal((await f.read(name)).toString(), value);
});

test('SQLite synchronous NORMAL rejects a new patch before staging any journal row or changing source bytes', async t => {
  const f = await fixture(t); let writes = 0;
  const tool = f.makeTool({ write: async (...args) => { writes++; return f.policy.write(...args); } });
  const ctx = f.context(), approved = f.approve(ctx, await tool.prepare(ctx));
  f.db.exec('PRAGMA synchronous=NORMAL'); assert.equal(f.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  await assert.rejects(tool.execute(approved), { code: 'workspace_journal_not_durable' });
  assert.equal(writes, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patch_files').get().n, 0);
  for (const [name, value] of Object.entries(f.initial)) assert.equal((await f.read(name)).toString(), value);
});

test('a journal downgrade after verified progress blocks the next dispatch and read-only terminal replay remains available', async t => {
  const f = await fixture(t); let writes = 0;
  const tool = f.makeTool({ write: async (...args) => { writes++; return f.policy.write(...args); } }, (_runId, receipt) => {
    if (receipt.outcome === 'in_progress' && receipt.counts.verified === 1) f.db.exec('PRAGMA synchronous=NORMAL');
  });
  const ctx = f.context(), approved = f.approve(ctx, await tool.prepare(ctx)), result = await tool.execute(approved);
  assert.equal(result.outcome, 'partial'); assert.equal(result.files[0].verified, true);
  assert.equal(result.files[1].dispatchAttempted, false); assert.equal(result.files[1].code, 'workspace_journal_not_durable');
  assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt']); assert.equal(writes, 2, 'second call reaches preflight but never dispatches');
  assert.equal(f.db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.deepEqual(await tool.execute(approved), result); assert.equal(writes, 2);
});

test('canonical file identities reject duplicate exact, separator and Windows case aliases', async t => {
  const f = await fixture(t, { 'nested/source.txt': 'alpha nested', 'other.txt': 'alpha other' });
  for (const second of ['nested/source.txt', 'nested\\source.txt', ...(process.platform === 'win32' ? ['NESTED/SOURCE.TXT'] : [])]) {
    const entry = { path: 'nested/source.txt', expectedHash: hash('alpha nested'), edits: [{ oldText: 'alpha', newText: 'ALPHA' }] };
    await assert.rejects(f.tool.prepare(f.context({ files: [entry, { ...entry, path: second }] })), { code: 'patch_duplicate_file' });
  }
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
});

test('stale files and tampered consumed approvals/previews cannot start a batch', async t => {
  const f = await fixture(t), ctx = f.context(), preview = await f.tool.prepare(ctx);
  for (const extra of [{ status: 'approved' }, { name: 'workspace.edit' }, { argsHash: hash('wrong arguments') }])
    await assert.rejects(f.tool.execute(f.approve(ctx, preview, extra)), { code: 'approval_mismatch' });
  for (const altered of [{ ...preview, complete: false }, { ...preview, truncated: true }, { ...preview, files: preview.files.map((file, i) => i ? { ...file, newHash: hash('forged') } : file) }])
    await assert.rejects(f.tool.execute(f.approve(ctx, altered)), { code: 'approval_mismatch' });
  const approved = f.approve(ctx, preview); await f.write('b.txt', 'External work remains.');
  await assert.rejects(f.tool.execute(approved), { code: 'write_conflict' });
  assert.equal((await f.read('a.txt')).toString(), f.initial['a.txt']); assert.equal((await f.read('b.txt')).toString(), 'External work remains.');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
});

test('only 2–8 existing files with exact hashes and literal-edit schemas may be prepared', async t => {
  const f = await fixture(t), entry = f.args().files[0];
  for (const files of [[], [entry], Array.from({ length: 9 }, () => entry), [{ ...entry, expectedHash: undefined }, f.args().files[1]],
    [{ ...entry, edits: [{ oldText: 'alpha', newText: 'bad\0text' }] }, f.args().files[1]]])
    await assert.rejects(f.tool.prepare(f.context({ files })), caught => ['invalid_arguments', 'invalid_text'].includes(caught.code));
  const missing = f.args(); missing.files[1].path = 'missing.txt'; await assert.rejects(f.tool.prepare(f.context(missing)), { code: 'ENOENT' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 0);
});

test('a stale later file after staging yields known partial effect and stops every untouched sibling', async t => {
  const f = await fixture(t); let writes = 0;
  const tool = f.makeTool({ write: async (args, options) => {
    if (++writes === 2) await f.write('b.txt', 'External update');
    return f.policy.write(args, options);
  } });
  const ctx = f.context(f.args(['a.txt', 'b.txt', 'c.txt'])), approved = f.approve(ctx, await tool.prepare(ctx)), result = await tool.execute(approved);
  assert.equal(result.outcome, 'partial'); assert.equal(result.receipt.complete, true);
  assert.deepEqual(result.receipt.counts, { total: 3, verified: 1, unknown: 0, notDispatched: 2, pending: 0 });
  assert.equal(result.files[1].code, 'write_conflict'); assert.equal(result.files[1].dispatchAttempted, false);
  assert.equal((await f.read('c.txt')).toString(), f.initial['c.txt']); assert.equal((await f.read('b.txt')).toString(), 'External update');
  assert.equal(writes, 2); assert.deepEqual(await tool.execute(approved), result); assert.equal(writes, 2);
});

for (const failure of ['write_error', 'readback_mismatch', 'readback_error']) test(`${failure} after dispatch is unknown, retains available evidence and stops siblings`, async t => {
  const f = await fixture(t); let writes = 0, failedReadbacks = 0;
  const tool = f.makeTool({
    write: async (args, options) => {
      writes++;
      if (writes === 2 && failure === 'write_error') { options.beforeDispatch(); await f.write('b.txt', 'partial bytes'); throw new Error('Owned simulated fsync error'); }
      const value = await f.policy.write(args, options);
      if (writes === 2 && failure === 'readback_mismatch') await f.write('b.txt', 'external after-write bytes');
      return value;
    },
    read: async name => { if (name === 'b.txt' && writes === 2 && failure === 'readback_error') { failedReadbacks++; throw new Error('Owned failed readback'); } return f.policy.read(name); },
  });
  const ctx = f.context(f.args(['a.txt', 'b.txt', 'c.txt'])), approved = f.approve(ctx, await tool.prepare(ctx)), result = await tool.execute(approved);
  assert.equal(result.outcome, 'unknown'); assert.equal(result.ok, false); assert.equal(writes, 2);
  assert.deepEqual(result.receipt.counts, { total: 3, verified: 1, unknown: 1, notDispatched: 1, pending: 0 });
  assert.equal(result.files[1].dispatchAttempted, true);
  if (failure === 'readback_error') { assert.equal(failedReadbacks, 1); assert.equal(result.files[1].observedHash, undefined); }
  else assert.equal(result.files[1].observedHash, hash(await f.read('b.txt')));
  assert.equal((await f.read('c.txt')).toString(), f.initial['c.txt']);
  assert.deepEqual(await tool.execute(approved), result); assert.equal(writes, 2);
});

for (const stopAfter of [1, 2]) test(`cancellation after file${stopAfter} finishes readback and truthfully reports remaining authority`, async t => {
  const f = await fixture(t), controller = new AbortController(); let writes = 0, readbacksAfterCancellation = 0;
  const tool = f.makeTool({ write: async (...args) => { const result = await f.policy.write(...args); if (++writes === stopAfter) controller.abort(); return result; },
    read: async name => { if (controller.signal.aborted) readbacksAfterCancellation++; return f.policy.read(name); } });
  const ctx = f.context(f.args(), controller.signal), approved = f.approve(ctx, await tool.prepare(ctx)), result = await tool.execute(approved);
  assert.equal(readbacksAfterCancellation, 1); assert.equal(result.outcome, stopAfter === 1 ? 'partial' : 'verified');
  assert.equal(result.receipt.counts.verified, stopAfter); assert.equal(writes, stopAfter);
  assert.deepEqual(await tool.execute(approved), result, 'terminal replay is a receipt read even with the original cancelled signal');
});

test('cancellation after staging but before first dispatch reports no write and all children not dispatched', async t => {
  const f = await fixture(t), controller = new AbortController(); let writes = 0;
  const tool = f.makeTool({ identity: async name => { const key = await f.policy.identity(name); if (f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n) controller.abort(); return key; },
    write: async (...args) => { writes++; return f.policy.write(...args); } });
  const ctx = f.context(f.args(), controller.signal), result = await tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  assert.equal(result.outcome, 'not_dispatched'); assert.equal(result.receipt.dispatchAttempted, false); assert.equal(writes, 0);
  assert.deepEqual(result.receipt.counts, { total: 2, verified: 0, unknown: 0, notDispatched: 2, pending: 0 });
});

test('cancellation immediately after dispatch intent still finishes that write/readback and stops the next file', async t => {
  const f = await fixture(t), controller = new AbortController(); let writes = 0;
  const tool = f.makeTool({ write: async (args, options) => {
    writes++;
    return f.policy.write(args, { ...options, beforeDispatch: () => { options.beforeDispatch(); controller.abort(); } });
  } });
  const ctx = f.context(f.args(), controller.signal), result = await tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  assert.equal(result.outcome, 'partial'); assert.equal(writes, 1); assert.equal(result.files[0].verified, true);
  assert.equal(result.files[0].observedHash, hash(await f.read('a.txt'))); assert.equal(result.files[1].dispatchAttempted, false);
  assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt']);
});

test('a pre-dispatch conflict on the first staged file reports no patch writes and preserves external work', async t => {
  const f = await fixture(t); let writes = 0;
  const tool = f.makeTool({ write: async (args, options) => { writes++; await f.write('a.txt', 'External source survived'); return f.policy.write(args, options); } });
  const ctx = f.context(), result = await tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  assert.equal(result.outcome, 'not_dispatched'); assert.equal(result.receipt.dispatchAttempted, false); assert.equal(writes, 1);
  assert.equal(result.files[0].code, 'write_conflict'); assert.equal((await f.read('a.txt')).toString(), 'External source survived');
  assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt']);
});

test('one approval cannot run twice even after progress was published, and terminal replay returns only the saved receipt', async t => {
  const f = await fixture(t); let release, entered = false, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = f.makeTool({ write: async (...args) => { writes++; if (writes === 2) { entered = true; await gate; } return f.policy.write(...args); } });
  const ctx = f.context(), approved = f.approve(ctx, await tool.prepare(ctx)), pending = tool.execute(approved);
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  const staged = f.db.prepare('SELECT status,receipt_json FROM agent_workspace_patches').get();
  assert.equal(staged.status, 'in_progress'); assert.equal(JSON.parse(staged.receipt_json).counts.verified, 1);
  await assert.rejects(tool.execute(approved), { code: 'patch_in_progress' }); release();
  const first = await pending, second = await tool.execute(approved);
  assert.deepEqual(first, second); assert.equal(writes, 2); assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 1);
});

test('post-staging caller argument mutation cannot change the frozen approved bytes or paths', async t => {
  const f = await fixture(t); let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = f.makeTool({ write: async (...args) => { if (!entered) { entered = true; await gate; } return f.policy.write(...args); } });
  const ctx = f.context(), pending = tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  ctx.args.files[1].path = 'c.txt'; ctx.args.files[1].expectedHash = hash(f.initial['c.txt']); ctx.args.files[1].edits[0].newText = 'UNAPPROVED';
  release(); const result = await pending;
  assert.equal(result.outcome, 'verified'); assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt'].replace('alpha', 'ALPHA'));
  assert.equal((await f.read('c.txt')).toString(), f.initial['c.txt']);
});

test('terminal replay validates stored receipt/counts/status and actual child readback evidence without replaying writes', async t => {
  const f = await fixture(t); let writes = 0;
  const tool = f.makeTool({ write: async (...args) => { writes++; return f.policy.write(...args); } });
  const ctx = f.context(), approved = f.approve(ctx, await tool.prepare(ctx)), result = await tool.execute(approved);
  const row = f.db.prepare('SELECT * FROM agent_workspace_patches').get(), child = f.db.prepare('SELECT * FROM agent_workspace_patch_files WHERE ordinal=0').get();
  const mutations = [
    () => f.db.prepare('UPDATE agent_workspace_patches SET receipt_json=?').run(JSON.stringify({ ...result.receipt, outcome: 'unknown' })),
    () => f.db.prepare('UPDATE agent_workspace_patches SET receipt_json=?').run(JSON.stringify({ ...result.receipt, counts: { ...result.receipt.counts, verified: 0 } })),
    () => f.db.prepare("UPDATE agent_workspace_patches SET status='unknown'").run(),
    () => f.db.prepare('UPDATE agent_workspace_patch_files SET observed_hash=? WHERE ordinal=0').run(hash('false verified bytes')),
    () => f.db.prepare('UPDATE agent_workspace_patch_files SET observed_bytes=0 WHERE ordinal=0').run(),
    () => f.db.prepare('UPDATE agent_workspace_patch_files SET dispatch_attempted=0 WHERE ordinal=0').run(),
    () => f.db.prepare("UPDATE agent_workspace_patch_files SET status='unknown' WHERE ordinal=0").run(),
  ];
  for (const mutate of mutations) {
    mutate(); await assert.rejects(tool.execute(approved), { code: 'patch_journal_corrupt' }); assert.equal(writes, 2);
    f.db.prepare('UPDATE agent_workspace_patches SET status=?,receipt_json=?').run(row.status, row.receipt_json);
    f.db.prepare('UPDATE agent_workspace_patch_files SET status=?,dispatch_attempted=?,observed_hash=?,observed_bytes=? WHERE ordinal=0')
      .run(child.status, child.dispatch_attempted, child.observed_hash, child.observed_bytes);
  }
  f.db.prepare('UPDATE agent_workspace_patches SET receipt_json=?,notified_at=NULL').run(JSON.stringify({ ...result.receipt, verified: false }));
  assert.throws(() => recoverWorkspacePatches(f.db, () => assert.fail('Corrupt receipt must not be published')), { code: 'patch_journal_corrupt' });
  assert.equal(writes, 2);
});

test('the all-file lease keeps competing cooperative writers out until readback and terminal publication', async t => {
  const f = await fixture(t), other = createWorkspacePolicy(f.directory); let release, entered = false, competingSettled = false;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = f.makeTool({ write: async (...args) => { if (!entered) { entered = true; await gate; } return f.policy.write(...args); } });
  const ctx = f.context(), pending = tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  const competing = other.write({ path: 'b.txt', expectedHash: hash(f.initial['b.txt']), content: 'competing' }).finally(() => { competingSettled = true; });
  const observed = competing.catch(caught => caught);
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(competingSettled, false);
  release(); assert.equal((await pending).outcome, 'verified'); assert.equal((await observed).code, 'write_conflict');
  assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt'].replace('alpha', 'ALPHA'));
});

test('a second exact approval revalidates all files after waiting for the first batch lease', async t => {
  const f = await fixture(t); let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = f.makeTool({ write: async (...args) => { if (!entered) { entered = true; await gate; } return f.policy.write(...args); } });
  const ctx = f.context(), preview = await tool.prepare(ctx), firstApproval = f.approve(ctx, preview), secondApproval = f.approve(ctx, preview);
  const first = tool.execute(firstApproval); while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  const second = tool.execute(secondApproval); const rejection = assert.rejects(second, { code: 'write_conflict' });
  release(); assert.equal((await first).outcome, 'verified'); await rejection;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_workspace_patches').get().n, 1);
});

function seed(db, preview, statuses, id = randomUUID()) {
  const stamp = Date.now();
  db.prepare("INSERT INTO agent_workspace_patches(id,run_id,approval_id,args_hash,preview_json,file_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'in_progress',?,?)")
    .run(id, 'interrupted-source', id, hash('owned interrupted approval'), stableJson(preview), statuses.length, stamp, stamp);
  const insert = db.prepare('INSERT INTO agent_workspace_patch_files(patch_id,ordinal,path,expected_hash,new_hash,bytes_before,bytes_after,edit_count,status,dispatch_attempted,observed_hash,observed_bytes,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  statuses.forEach((status, ordinal) => {
    const file = preview.files[ordinal];
    insert.run(id, ordinal, file.path, file.expectedHash, file.newHash, file.bytesBefore, file.bytesAfter, file.edits.length, status,
      ['dispatching', 'verified', 'unknown'].includes(status) ? 1 : 0, status === 'verified' ? file.newHash : null, status === 'verified' ? file.bytesAfter : null, stamp);
  });
  return id;
}

test('restart recovery never writes: prepared becomes not dispatched, dispatching unknown, and verified children survive', async t => {
  const f = await fixture(t), preview = await f.tool.prepare(f.context(f.args(['a.txt', 'b.txt', 'c.txt']))), before = await Promise.all(Object.keys(f.initial).map(f.read));
  const cases = [[['prepared', 'prepared'], 'not_dispatched'], [['verified', 'prepared', 'prepared'], 'partial'],
    [['verified', 'dispatching', 'prepared'], 'unknown'], [['verified', 'verified'], 'verified']];
  const ids = cases.map(([statuses]) => seed(f.db, { ...preview, fileCount: statuses.length, files: preview.files.slice(0, statuses.length) }, statuses));
  const recovered = []; recoverWorkspacePatches(f.db, (runId, receipt) => { assert.equal(runId, 'interrupted-source'); recovered.push(receipt); });
  for (let i = 0; i < ids.length; i++) {
    const value = recovered.find(receipt => receipt.effectId === ids[i]); assert.equal(value.outcome, cases[i][1]); assert.equal(value.complete, true);
    assert.equal(value.counts.pending, 0); assert.ok(value.files.every(file => !['prepared', 'dispatching'].includes(file.status)));
  }
  assert.deepEqual(await Promise.all(Object.keys(f.initial).map(f.read)), before);
  recoverWorkspacePatches(f.db, () => assert.fail('Acknowledged terminal receipts must not replay'));
});

test('durable SQLite reopen publishes latest unknown receipt without access to workspace policy', async t => {
  const f = await fixture(t), preview = await f.tool.prepare(f.context()), dbPath = path.join(f.directory, 'journal.sqlite'); f.files.add('journal.sqlite');
  const first = new DatabaseSync(dbPath); createWorkspacePatchTool({ db: first, policy: f.policy });
  const id = seed(first, preview, ['verified', 'dispatching']); first.close();
  const reopened = new DatabaseSync(dbPath); f.databases.push(reopened); const seen = [];
  recoverWorkspacePatches(reopened, (_runId, receipt) => seen.push(receipt));
  assert.equal(seen.length, 1); assert.equal(seen[0].effectId, id); assert.equal(seen[0].outcome, 'unknown');
  assert.equal(seen[0].files[0].status, 'verified'); assert.equal(seen[0].files[1].status, 'unknown');
  assert.equal((await f.read('a.txt')).toString(), f.initial['a.txt']);
});

test('observers cannot mutate persisted/returned receipts and only missing latest acknowledgement is retried', async t => {
  const f = await fixture(t); let attempts = 0;
  const tool = f.makeTool({ write: async (args, options) => { options.beforeDispatch(); await f.write(args.path, 'uncertain bytes'); throw new Error('Owned write failure'); } }, (_runId, receipt) => {
    attempts++; assert.equal(Object.isFrozen(receipt.files[0]), true); assert.throws(() => { receipt.outcome = 'verified'; }, TypeError); throw new Error('Owned observer failure');
  });
  const ctx = f.context(), result = await tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  assert.equal(result.outcome, 'unknown'); assert.equal(attempts, 1); assert.equal(f.db.prepare('SELECT notified_at FROM agent_workspace_patches').get().notified_at, null);
  assert.equal(JSON.parse(f.db.prepare('SELECT receipt_json FROM agent_workspace_patches').get().receipt_json).outcome, 'unknown');
  const recovered = []; recoverWorkspacePatches(f.db, (_runId, receipt) => recovered.push(receipt));
  assert.equal(recovered.length, 1); assert.equal(recovered[0].effectId, result.effectId); assert.equal(recovered[0].outcome, 'unknown');
  recoverWorkspacePatches(f.db, () => assert.fail('Only the missing acknowledgement is retried'));
});

test('async observer promises do not produce an untracked database acknowledgement or hide their rejection', async t => {
  const f = await fixture(t), tool = f.makeTool({}, async () => { throw new Error('Owned async observer rejection'); }), ctx = f.context();
  const result = await tool.execute(f.approve(ctx, await tool.prepare(ctx))); assert.equal(result.outcome, 'verified');
  await Promise.resolve(); assert.equal(f.db.prepare('SELECT notified_at FROM agent_workspace_patches').get().notified_at, null);
  const seen = []; recoverWorkspacePatches(f.db, (_runId, receipt) => seen.push(receipt));
  assert.equal(seen.length, 1); assert.equal(seen[0].outcome, 'verified');
});

test('recovery during a pending dispatch prevents late work from dispatching or reopening the terminal journal', async t => {
  const f = await fixture(t); let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = f.makeTool({ write: async (...args) => { entered = true; await gate; return f.policy.write(...args); } });
  const ctx = f.context(), pending = tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  recoverWorkspacePatches(f.db, () => {}); release();
  const result = await pending; assert.equal(result.outcome, 'not_dispatched');
  assert.equal((await f.read('a.txt')).toString(), f.initial['a.txt']); assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt']);
  assert.equal(f.db.prepare('SELECT status FROM agent_workspace_patches').get().status, 'not_dispatched');
});

test('recovery after dispatch intent preserves unknown even if the in-flight write later completes exact readback', async t => {
  const f = await fixture(t); let release, entered = false, writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const tool = f.makeTool({ write: async (args, options) => {
    writes++; options.beforeDispatch(); entered = true; await gate; await f.write(args.path, args.content);
  } });
  const ctx = f.context(), pending = tool.execute(f.approve(ctx, await tool.prepare(ctx)));
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  recoverWorkspacePatches(f.db, () => {}); release();
  const result = await pending;
  assert.equal(result.outcome, 'unknown'); assert.equal(writes, 1); assert.equal(result.files[0].dispatchAttempted, true);
  assert.equal((await f.read('a.txt')).toString(), f.initial['a.txt'].replace('alpha', 'ALPHA'));
  assert.equal((await f.read('b.txt')).toString(), f.initial['b.txt']); assert.equal(f.db.prepare('SELECT status FROM agent_workspace_patches').get().status, 'unknown');
});
