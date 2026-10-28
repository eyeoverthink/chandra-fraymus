import { randomUUID } from 'node:crypto';
import { assertSchema, fail, hash, stableJson } from './schema.js';
import { planLiteralEdits, WORKSPACE_EDIT_PARAMETERS } from './workspace-edit.js';
import { requireDurableEffectJournal } from './effect-durability.js';

export const WORKSPACE_PATCH_PARAMETERS = { type: 'object', properties: {
  files: { type: 'array', minItems: 2, maxItems: 8, items: WORKSPACE_EDIT_PARAMETERS },
}, required: ['files'], additionalProperties: false };
const TERMINAL = new Set(['verified', 'partial', 'unknown', 'not_dispatched']);
const CHILDREN = new Set(['prepared', 'dispatching', 'verified', 'unknown', 'not_dispatched']);
const safeCode = (value, fallback) => /^(?:write_conflict|path_changed|path_denied|file_too_large|cancelled|binary_file|workspace_journal_not_durable)$/.test(value ?? '') ? value : fallback;
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function transaction(db, work) {
  if (typeof db.transaction === 'function') return db.transaction(work).immediate();
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (caught) { db.exec('ROLLBACK'); throw caught; }
}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_workspace_patches (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,approval_id TEXT NOT NULL UNIQUE,args_hash TEXT NOT NULL,
    preview_json TEXT NOT NULL,file_count INTEGER NOT NULL CHECK(file_count BETWEEN 2 AND 8),
    status TEXT NOT NULL CHECK(status IN ('in_progress','recovering','verified','partial','unknown','not_dispatched')),
    stop_code TEXT,receipt_json TEXT,receipt_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,notified_at INTEGER
  ); CREATE TABLE IF NOT EXISTS agent_workspace_patch_files (
    patch_id TEXT NOT NULL,ordinal INTEGER NOT NULL,path TEXT NOT NULL,expected_hash TEXT NOT NULL,new_hash TEXT NOT NULL,
    bytes_before INTEGER NOT NULL,bytes_after INTEGER NOT NULL,edit_count INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','verified','unknown','not_dispatched')),
    dispatch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempted IN (0,1)),
    observed_hash TEXT,observed_bytes INTEGER,code TEXT,updated_at INTEGER NOT NULL,
    PRIMARY KEY(patch_id,ordinal),FOREIGN KEY(patch_id) REFERENCES agent_workspace_patches(id)
  )`);
}
const parent = (db, id) => db.prepare('SELECT * FROM agent_workspace_patches WHERE id=?').get(id);
function children(db, row) {
  const files = db.prepare('SELECT * FROM agent_workspace_patch_files WHERE patch_id=? ORDER BY ordinal').all(row.id);
  const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!integer(row.file_count, 8) || row.file_count < 2 || files.length !== row.file_count || files.some((file, i) => {
    if (file.ordinal !== i || !CHILDREN.has(file.status) || !digest(file.expected_hash) || !digest(file.new_hash)
      || typeof file.path !== 'string' || !file.path || file.path.length > 1024 || !file.path.isWellFormed() || file.path.includes('\0')
      || !integer(file.bytes_before, 262144) || !integer(file.bytes_after, 262144) || !integer(file.edit_count, 8) || file.edit_count < 1
      || ![0, 1].includes(file.dispatch_attempted) || !(file.observed_hash === null || digest(file.observed_hash))
      || !(file.observed_bytes === null || integer(file.observed_bytes, 262144)) || (file.observed_hash === null) !== (file.observed_bytes === null)) return true;
    if (file.status === 'verified') return file.dispatch_attempted !== 1 || file.observed_hash !== file.new_hash || file.observed_bytes !== file.bytes_after || file.code !== null;
    if (['unknown', 'dispatching'].includes(file.status) && file.dispatch_attempted !== 1) return true;
    if (['prepared', 'not_dispatched'].includes(file.status) && file.dispatch_attempted !== 0) return true;
    return file.status !== 'unknown' && (file.observed_hash !== null || file.observed_bytes !== null);
  })) fail('patch_journal_corrupt', 'Patch journal children or their dispatch/readback evidence are incomplete or invalid');
  return files;
}
function aggregate(db, row, terminal) {
  const rows = children(db, row), counts = { total: rows.length, verified: 0, unknown: 0, notDispatched: 0, pending: 0 };
  const files = rows.map(file => {
    if (file.status === 'verified') counts.verified++;
    else if (file.status === 'unknown' || file.status === 'dispatching') counts.unknown++;
    else if (file.status === 'not_dispatched') counts.notDispatched++;
    else counts.pending++;
    return { path: file.path, expectedHash: file.expected_hash, newHash: file.new_hash,
      bytesBefore: file.bytes_before, bytesAfter: file.bytes_after, editCount: file.edit_count,
      status: file.status, outcome: file.status === 'prepared' ? 'pending' : file.status === 'dispatching' ? 'unknown' : file.status,
      dispatchAttempted: Boolean(file.dispatch_attempted), verified: file.status === 'verified',
      ...(file.observed_hash !== null ? { observedHash: file.observed_hash } : {}),
      ...(file.observed_bytes !== null ? { observedBytes: file.observed_bytes } : {}), ...(file.code ? { code: file.code } : {}) };
  });
  if (terminal && counts.pending) fail('patch_journal_corrupt', 'A terminal patch cannot contain pending files');
  const outcome = !terminal ? 'in_progress' : counts.unknown ? 'unknown' : counts.verified === counts.total ? 'verified' : counts.verified ? 'partial' : 'not_dispatched';
  return { kind: 'workspace_patch', effectId: row.id, status: outcome, outcome, complete: terminal, atomic: false, verified: outcome === 'verified',
    dispatchAttempted: files.some(file => file.dispatchAttempted), counts, files, ...(row.stop_code ? { code: row.stop_code } : {}) };
}
function result(receipt) {
  return { ok: receipt.outcome === 'verified', effectId: receipt.effectId, outcome: receipt.outcome, files: receipt.files,
    ...(receipt.code ? { code: receipt.code } : {}), receipt };
}
function terminalReceipt(db, row) {
  const derived = aggregate(db, row, true);
  let stored;
  try { stored = JSON.parse(row.receipt_json); } catch { fail('patch_journal_corrupt', 'Terminal patch receipt is invalid'); }
  if (row.status !== derived.outcome || stableJson(stored) !== stableJson(derived)) fail('patch_journal_corrupt', 'Terminal patch receipt/status differs from its journal evidence');
  return derived;
}
function acknowledge(db, row, onReceipt) {
  try {
    const returned = onReceipt(row.run_id, freeze(JSON.parse(row.receipt_json)));
    // The callback acknowledges a synchronous durable event, like workspace.edit.
    if (returned && typeof returned.then === 'function') { Promise.resolve(returned).catch(() => {}); return; }
    db.prepare('UPDATE agent_workspace_patches SET notified_at=? WHERE id=? AND receipt_version=? AND receipt_json=?')
      .run(Date.now(), row.id, row.receipt_version, row.receipt_json);
  } catch { /* The independent latest receipt remains pending for restart. */ }
}
function publish(db, id, terminal, onReceipt) {
  const publication = transaction(db, () => {
    const row = parent(db, id);
    if (TERMINAL.has(row.status)) { terminalReceipt(db, row); return { row, changed: false }; }
    const receipt = aggregate(db, row, terminal), serialized = JSON.stringify(receipt);
    db.prepare('UPDATE agent_workspace_patches SET status=?,receipt_json=?,receipt_version=receipt_version+1,updated_at=?,notified_at=NULL WHERE id=?')
      .run(receipt.outcome, serialized, Date.now(), id);
    return { row: parent(db, id), changed: true };
  });
  if (publication.changed) acknowledge(db, publication.row, onReceipt);
  return result(JSON.parse(publication.row.receipt_json));
}
function stopPending(db, id, code) {
  db.prepare("UPDATE agent_workspace_patch_files SET status='not_dispatched',code=?,updated_at=? WHERE patch_id=? AND status='prepared'")
    .run(code, Date.now(), id);
}

/** Recovery reports durable uncertainty; it never opens or writes a target file.
 * onReceipt must synchronously persist its acknowledgement. Only the latest
 * aggregate is retried; receipt consumers replace progress by the same effectId. */
export function recoverWorkspacePatches(db, onReceipt = () => {}) {
  initialize(db);
  const interrupted = transaction(db, () => {
    const rows = db.prepare("SELECT * FROM agent_workspace_patches WHERE status IN ('in_progress','recovering')").all();
    for (const row of rows) {
      children(db, row);
      db.prepare("UPDATE agent_workspace_patches SET status='recovering',stop_code=COALESCE(stop_code,'patch_interrupted'),updated_at=? WHERE id=?").run(Date.now(), row.id);
      db.prepare("UPDATE agent_workspace_patch_files SET status='unknown',dispatch_attempted=1,code='patch_interrupted_unknown',updated_at=? WHERE patch_id=? AND status='dispatching'").run(Date.now(), row.id);
      stopPending(db, row.id, 'patch_interrupted_before_dispatch');
    }
    return rows.map(row => row.id);
  });
  for (const id of interrupted) publish(db, id, true, onReceipt);
  const recovered = new Set(interrupted);
  for (const row of db.prepare('SELECT * FROM agent_workspace_patches WHERE receipt_json IS NOT NULL AND notified_at IS NULL').all())
    if (!recovered.has(row.id)) { if (TERMINAL.has(row.status)) terminalReceipt(db, row); acknowledge(db, row, onReceipt); }
}

export function createWorkspacePatchTool({ db, policy, onReceipt = () => {} }) {
  if (!policy || !['read', 'write', 'identity', 'withWriteLocks'].every(name => typeof policy[name] === 'function') || typeof onReceipt !== 'function')
    fail('patch_configuration', 'A scoped workspace policy with canonical identities/write leases and a receipt callback is required');
  initialize(db);
  async function plan(args, signal) {
    assertSchema(args, WORKSPACE_PATCH_PARAMETERS);
    const planned = [], seen = new Set();
    for (const file of args.files) {
      signal.throwIfAborted();
      const key = await policy.identity(file.path);
      signal.throwIfAborted();
      if (typeof key !== 'string' || !key || seen.has(key)) fail('patch_duplicate_file', 'Each patch entry must identify a distinct existing canonical file');
      seen.add(key);
      const entry = planLiteralEdits(await policy.read(file.path), file);
      signal.throwIfAborted();
      planned.push({ ...entry, key });
    }
    const preview = { kind: 'workspace_patch', complete: true, atomic: false, fileCount: planned.length, files: planned.map(file => file.preview),
      warning: 'All files are approved together, then written sequentially. This is not an all-or-nothing filesystem transaction. No automatic rollback or retry occurs. External-writer preconditions are best effort. Cancellation cannot undo dispatched writes.' };
    if (JSON.stringify(preview).length > 24000) fail('patch_preview_too_large', 'The full combined patch exceeds the approval limit; use fewer or smaller literal replacements');
    return { planned, preview };
  }
  function authorized(context) {
    const { args, run, approvalId } = context;
    assertSchema(args, WORKSPACE_PATCH_PARAMETERS);
    const argsJson = stableJson(args), argsHash = hash('workspace.patch\n' + argsJson);
    const approval = db.prepare('SELECT * FROM agent_approvals WHERE id=? AND run_id=?').get(approvalId, run.id);
    if (!approval || approval.status !== 'consumed' || approval.tool_name !== 'workspace.patch' || approval.args_json !== argsJson || approval.args_hash !== argsHash)
      fail('approval_mismatch', 'Workspace patch requires its exact consumed approval');
    let preview;
    try { preview = JSON.parse(approval.preview_json); } catch { fail('approval_mismatch', 'Patch preview is invalid'); }
    if (!preview || preview.kind !== 'workspace_patch' || preview.complete !== true || preview.atomic !== false || preview.truncated
      || preview.fileCount !== args.files.length || !Array.isArray(preview.files) || preview.files.length !== args.files.length || JSON.stringify(preview).length > 24000)
      fail('approval_mismatch', 'The full combined patch preview was not approved');
    return { argsJson, argsHash, args: freeze(JSON.parse(argsJson)), preview };
  }
  function existing(context, authorization) {
    const row = db.prepare('SELECT * FROM agent_workspace_patches WHERE approval_id=?').get(context.approvalId);
    if (!row) return null;
    if (row.run_id !== context.run.id || row.args_hash !== authorization.argsHash || row.preview_json !== stableJson(authorization.preview))
      fail('approval_mismatch', 'Patch journal identity differs from its consumed approval');
    const files = children(db, row);
    for (let i = 0; i < files.length; i++) {
      const file = files[i], approved = authorization.preview.files[i];
      if (file.path !== approved.path || file.expected_hash !== approved.expectedHash || file.new_hash !== approved.newHash
        || file.bytes_before !== approved.bytesBefore || file.bytes_after !== approved.bytesAfter || file.edit_count !== approved.edits.length)
        fail('patch_journal_corrupt', 'Patch journal metadata differs from its exact approved files');
    }
    if (!TERMINAL.has(row.status)) fail('patch_in_progress', 'This approved patch is already running; it cannot be dispatched again');
    return result(terminalReceipt(db, row));
  }
  function finish(id, code) {
    transaction(db, () => {
      const row = parent(db, id);
      if (TERMINAL.has(row.status)) return;
      stopPending(db, id, code ?? 'patch_stopped');
      if (code) db.prepare('UPDATE agent_workspace_patches SET stop_code=? WHERE id=?').run(code, id);
    });
    return publish(db, id, true, onReceipt);
  }
  return { name: 'workspace.patch', group: 'coding', approvalRequired: true, preserveReceipt: true,
    description: 'Propose exact SHA-256-bound unique literal edits across 2–8 existing files. Use files:[{path,expectedHash,edits:[{oldText,newText}]}]. All full hunks require one exact approval. Untouched UTF-8 bytes/BOM/line endings are preserved. Writes are sequential, not all-or-nothing; verified progress and partial/unknown outcomes are durable. Never automatically roll back or retry unknown/partial effects.',
    parameters: WORKSPACE_PATCH_PARAMETERS,
    prepare: async ({ args, signal }) => (await plan(args, signal)).preview,
    execute: async context => {
      let authorization = authorized(context), previous = existing(context, authorization);
      if (previous) return previous;
      context.signal.throwIfAborted();
      return policy.withWriteLocks(authorization.args.files.map(file => file.path), { signal: context.signal }, async lease => {
        authorization = authorized(context); previous = existing(context, authorization);
        if (previous) return previous;
        const { planned, preview } = await plan(authorization.args, context.signal);
        if (stableJson(preview) !== stableJson(authorization.preview)) fail('approval_mismatch', 'Recomputed combined patch differs from its exact approved preview');
        context.signal.throwIfAborted();
        const staged = transaction(db, () => {
          const concurrent = existing(context, authorization);
          if (concurrent) return { previous: concurrent };
          requireDurableEffectJournal(db);
          const id = randomUUID(), stamp = Date.now();
          db.prepare("INSERT INTO agent_workspace_patches(id,run_id,approval_id,args_hash,preview_json,file_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'in_progress',?,?)")
            .run(id, context.run.id, context.approvalId, authorization.argsHash, stableJson(preview), planned.length, stamp, stamp);
          const insert = db.prepare("INSERT INTO agent_workspace_patch_files(patch_id,ordinal,path,expected_hash,new_hash,bytes_before,bytes_after,edit_count,status,updated_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?)");
          planned.forEach((file, ordinal) => insert.run(id, ordinal, file.preview.path, file.preview.expectedHash, file.preview.newHash,
            file.preview.bytesBefore, file.preview.bytesAfter, file.preview.edits.length, stamp));
          return { id };
        });
        if (staged.previous) return staged.previous;
        const { id } = staged;
        for (let ordinal = 0; ordinal < planned.length; ordinal++) {
          if (context.signal.aborted) return finish(id, 'cancelled');
          const file = planned[ordinal], args = authorization.args.files[ordinal];
          let attempted = false, writeError, observed, readError;
          try {
            if (await policy.identity(args.path) !== file.key) fail('path_changed', 'Patch target identity changed');
            context.signal.throwIfAborted();
            await policy.write({ path: args.path, expectedHash: args.expectedHash, content: file.content }, { signal: context.signal, lease, beforeDispatch: () => {
              context.signal.throwIfAborted();
              requireDurableEffectJournal(db);
              const changed = db.prepare("UPDATE agent_workspace_patch_files SET status='dispatching',dispatch_attempted=1,updated_at=? WHERE patch_id=? AND ordinal=? AND status='prepared' AND EXISTS(SELECT 1 FROM agent_workspace_patches WHERE id=? AND status='in_progress')")
                .run(Date.now(), id, ordinal, id);
              if (Number(changed.changes) !== 1) fail('patch_in_progress', 'Patch journal no longer owns this dispatch');
              attempted = true;
            } });
            if (!attempted) writeError = { code: 'patch_dispatch_unverified' };
          } catch (caught) { writeError = caught; }
          // Do not pass a cancelled signal: any started write must still be read
          // back, journaled and published. Cleanup cannot roll back target effects.
          if (attempted || writeError?.code === 'patch_dispatch_unverified') {
            try { observed = await policy.read(args.path); } catch (caught) { readError = caught; }
          }
          const verified = attempted && !writeError && !readError && observed?.sha256 === file.preview.newHash && observed.bytes === file.preview.bytesAfter;
          const unknown = attempted || writeError?.code === 'patch_dispatch_unverified';
          const status = verified ? 'verified' : unknown ? 'unknown' : 'not_dispatched';
          const code = verified ? null : unknown ? writeError ? 'patch_write_unknown' : readError ? 'patch_readback_failed' : 'patch_readback_mismatch'
            : context.signal.aborted ? 'cancelled' : safeCode(writeError?.code, 'patch_not_dispatched');
          const updated = db.prepare("UPDATE agent_workspace_patch_files SET status=?,dispatch_attempted=CASE WHEN ? THEN 1 ELSE dispatch_attempted END,observed_hash=?,observed_bytes=?,code=?,updated_at=? WHERE patch_id=? AND ordinal=? AND status IN ('prepared','dispatching') AND EXISTS(SELECT 1 FROM agent_workspace_patches WHERE id=? AND status='in_progress')")
            .run(status, unknown ? 1 : 0, observed?.sha256 ?? null, observed?.bytes ?? null, code, Date.now(), id, ordinal, id);
          if (Number(updated.changes) !== 1) {
            const current = parent(db, id);
            if (TERMINAL.has(current.status) && current.receipt_json) return result(terminalReceipt(db, current));
            fail('patch_in_progress', 'Patch journal was recovered while the write was settling; no sibling may dispatch');
          }
          if (!verified) return finish(id, code);
          publish(db, id, false, onReceipt);
        }
        return finish(id);
      });
    } };
}
