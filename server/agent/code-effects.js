import { randomUUID } from 'node:crypto';
import { AgentError, fail, stableJson } from './schema.js';
import { requireDurableEffectJournal } from './effect-durability.js';
import { dockerResourceIdentity } from '../sandbox/resource-identity.js';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const identityKeys = ['runId', 'callId', 'engine', 'language', 'argsHash'];
const receiptKeys = ['kind', 'effectId', 'executionId', 'engine', 'language', 'complete', 'outcome', 'dispatchAttempted', 'codeMayHaveRun', 'isolationVerified', 'termination', 'cleanup', 'proof', 'exitCode', 'errorCode', 'cleanupReconciliation'];
const forbidden = /^(?:__proto__|prototype|constructor|code|source|script|stdout|stderr|output|env|environment|password|token|secret|credentials|args|argv|arguments|command|commandLine)$/i;
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function transaction(db, callback) {
  if (typeof db.transaction === 'function') return db.transaction(callback).immediate();
  db.exec('BEGIN IMMEDIATE');
  try { const value = callback(); db.exec('COMMIT'); return value; }
  catch (caught) { db.exec('ROLLBACK'); throw caught; }
}
function validIdentity(input) {
  if (!plain(input) || Object.keys(input).length !== identityKeys.length || !identityKeys.every(key => Object.hasOwn(input, key))
    || !id(input.runId) || !id(input.callId) || input.engine !== 'docker' || !['javascript', 'python'].includes(input.language) || !digest(input.argsHash))
    fail('code_effect_arguments', 'Exact run/call, Docker engine, language and SHA-256 argument identity are required');
}
function metadata(value, depth = 0) {
  if (depth > 6) fail('code_effect_receipt', 'Code proof metadata is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15) return value;
  if (typeof value === 'string' && value.length <= 1024 && Buffer.byteLength(value) <= 4096 && value.isWellFormed() && !value.includes('\0')) return value;
  if (Array.isArray(value) && value.length <= 32) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail('code_effect_receipt', 'Code proof arrays must be dense');
    return value.map(item => metadata(item, depth + 1));
  }
  if (plain(value) && Object.keys(value).length <= 32) return Object.fromEntries(Object.keys(value).map(key => {
    if (!/^[a-zA-Z][a-zA-Z0-9_:-]{0,63}$/.test(key) || forbidden.test(key)) fail('code_effect_receipt', 'Code/source/output/environment fields are not independent proof metadata');
    return [key, metadata(value[key], depth + 1)];
  }));
  fail('code_effect_receipt', 'Code proof must contain bounded plain JSON metadata');
}
function resource(row) {
  if (!row.has_resource) return null;
  try {
    const value = dockerResourceIdentity(JSON.parse(row.resource_json), row.id);
    if (stableJson(value) !== row.resource_json || row.status === 'prepared') throw new Error('Invalid binding');
    return value;
  } catch { fail('code_effect_corrupt', 'Stored Docker resource identity is invalid or unbound'); }
}
function absenceProof(input, binding) {
  const keys = ['confirmed', 'endpoint', 'daemonId', 'name', 'containerId', 'checks', 'observedAt'];
  if (!plain(input) || Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key))
    || input.confirmed !== true || input.checks !== 2 || !Number.isSafeInteger(input.observedAt) || input.observedAt < 0
    || !['endpoint', 'daemonId', 'name', 'containerId'].every(key => input[key] === binding[key]))
    fail('code_reconciliation_proof', 'Two conclusive absence rounds must match the exact witnessed Docker identity');
  return freeze(Object.fromEntries(keys.map(key => [key, input[key]])));
}
function canonical(input, row) {
  if (!plain(input) || Object.keys(input).some(key => !receiptKeys.includes(key))
    || !['finished', 'not_started', 'unknown'].includes(input.outcome)
    || !['dispatchAttempted', 'codeMayHaveRun', 'isolationVerified'].every(key => typeof input[key] === 'boolean')
    || typeof input.termination !== 'string' || !/^[a-zA-Z0-9_:-]{1,64}$/.test(input.termination)
    || !plain(input.cleanup) || typeof input.cleanup.confirmed !== 'boolean'
    || Object.hasOwn(input, 'proof') && !plain(input.proof)) fail('code_effect_receipt', 'A bounded, explicit code lifecycle receipt and cleanup proof are required');
  for (const [key, expected] of [['kind', 'code_execution'], ['effectId', row.id], ['executionId', row.id], ['engine', row.engine], ['language', row.language], ['complete', true]])
    if (Object.hasOwn(input, key) && input[key] !== expected) fail('code_effect_identity', 'Code receipt identity differs from its original execution ticket');
  if (input.dispatchAttempted !== Boolean(row.dispatch_attempted) || input.codeMayHaveRun && !input.dispatchAttempted
    || input.outcome === 'not_started' && input.codeMayHaveRun || input.outcome === 'finished' && !input.codeMayHaveRun)
    fail('code_effect_receipt', 'Code lifecycle dispatch/submission facts are inconsistent');
  if (!row.dispatch_attempted && (input.outcome !== 'not_started' || input.isolationVerified || !input.cleanup.confirmed))
    fail('code_effect_receipt', 'An execution without dispatch intent can only be conclusively not started');
  if (Object.hasOwn(input, 'exitCode') && input.exitCode !== null && (!Number.isSafeInteger(input.exitCode) || input.exitCode < -2147483648 || input.exitCode > 4294967295))
    fail('code_effect_receipt', 'Code exit status is invalid');
  if (Object.hasOwn(input, 'errorCode') && (typeof input.errorCode !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(input.errorCode)))
    fail('code_effect_receipt', 'Code error status must be a bounded identifier');
  if (Object.hasOwn(input, 'cleanupReconciliation')) {
    const audit = input.cleanupReconciliation, binding = resource(row);
    if (!binding?.containerId || !plain(audit) || audit.method !== 'observed_absence' || !Number.isSafeInteger(audit.previousReceiptVersion)
      || audit.previousReceiptVersion < 1 || Object.keys(audit).length !== 9 || input.outcome !== 'unknown'
      || stableJson(input.cleanup) !== stableJson({ confirmed: true, verifiedAbsent: true, name: binding.name, containerId: binding.containerId, reconciled: true }))
      fail('code_effect_receipt', 'Reconciled cleanup must preserve unknown execution with an exact resource audit');
    const { method, previousReceiptVersion, ...proof } = audit; absenceProof(proof, binding);
  }
  const receipt = { kind: 'code_execution', effectId: row.id, engine: row.engine, language: row.language, complete: true,
    outcome: input.cleanup.confirmed ? input.outcome : 'unknown', dispatchAttempted: input.dispatchAttempted,
    codeMayHaveRun: input.codeMayHaveRun, isolationVerified: input.isolationVerified, termination: input.termination,
    cleanup: metadata(input.cleanup), ...(Object.hasOwn(input, 'proof') ? { proof: metadata(input.proof) } : {}),
    ...(Object.hasOwn(input, 'exitCode') ? { exitCode: input.exitCode } : {}), ...(Object.hasOwn(input, 'errorCode') ? { errorCode: input.errorCode } : {}),
    ...(Object.hasOwn(input, 'cleanupReconciliation') ? { cleanupReconciliation: metadata(input.cleanupReconciliation) } : {}) };
  if (Buffer.byteLength(stableJson(receipt)) > 16384) fail('code_effect_receipt', 'Independent code receipt exceeds 16 KiB');
  return freeze(receipt);
}

/** Independent lifecycle evidence only: never stores code or executes/cleans an
 * engine. Root validates native proof before passing it here. onReceipt(runId,
 * receipt) must synchronously persist an event; async callbacks stay unacked. */
export function createCodeEffectStore({ db, onReceipt = () => {} } = {}) {
  if (!db?.exec || !db?.prepare || typeof onReceipt !== 'function') fail('code_effect_configuration', 'A synchronous database and receipt callback are required');
  const tickets = new WeakMap(), originals = new Map(), runtimeUncertain = new Set();
  db.exec(`CREATE TABLE IF NOT EXISTS agent_code_effects (
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL,call_id TEXT NOT NULL,engine TEXT NOT NULL CHECK(engine='docker'),
    language TEXT NOT NULL CHECK(language IN ('javascript','python')),args_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('prepared','dispatching','settled','unknown')),
    dispatch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempted IN (0,1)),
    receipt_json TEXT,receipt_version INTEGER NOT NULL DEFAULT 0,resource_json TEXT,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,notified_at INTEGER,
    UNIQUE(run_id,call_id)
  ); CREATE INDEX IF NOT EXISTS agent_code_effects_engine ON agent_code_effects(engine,status)`);
  if (!db.prepare('PRAGMA table_info(agent_code_effects)').all().some(column => column.name === 'resource_json')) db.exec('ALTER TABLE agent_code_effects ADD COLUMN resource_json TEXT');
  const raw = executionId => db.prepare(`SELECT id,run_id,call_id,engine,language,args_hash,status,dispatch_attempted,
    receipt_json IS NOT NULL AS has_receipt,CASE WHEN length(CAST(receipt_json AS BLOB))<=16384 THEN receipt_json ELSE NULL END AS receipt_json,
    resource_json IS NOT NULL AS has_resource,CASE WHEN length(CAST(resource_json AS BLOB))<=4096 THEN resource_json ELSE NULL END AS resource_json,
    receipt_version,created_at,updated_at,notified_at FROM agent_code_effects WHERE id=?`).get(executionId);
  function read(executionId) {
    if (!id(executionId)) fail('code_effect_arguments', 'A bounded execution ID is required');
    const row = raw(executionId); if (!row) return null;
    const identity = { runId: row.run_id, callId: row.call_id, engine: row.engine, language: row.language, argsHash: row.args_hash };
    try { validIdentity(identity); } catch { fail('code_effect_corrupt', 'Stored code identity is invalid'); }
    if (!['prepared', 'dispatching', 'settled', 'unknown'].includes(row.status) || ![0, 1].includes(row.dispatch_attempted)
      || row.status === 'prepared' && row.dispatch_attempted || row.status === 'dispatching' && !row.dispatch_attempted
      || !Number.isSafeInteger(row.receipt_version) || row.receipt_version < 0 || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at))
      fail('code_effect_corrupt', 'Stored code lifecycle state is invalid');
    const binding = resource(row);
    if (['prepared', 'dispatching'].includes(row.status)) {
      if (row.has_receipt || row.receipt_version !== 0) fail('code_effect_corrupt', 'Nonterminal code lifecycle has a terminal receipt');
      return { row, identity, resource: binding, receipt: null };
    }
    let receipt;
    try { const supplied = JSON.parse(row.receipt_json); receipt = canonical(supplied, row); }
    catch { fail('code_effect_corrupt', 'Stored code receipt is invalid or inconsistent'); }
    if (row.receipt_version < 1 || stableJson(receipt) !== row.receipt_json || (row.status === 'settled') !== (receipt.outcome !== 'unknown'))
      fail('code_effect_corrupt', 'Stored code status differs from its canonical receipt');
    if (receipt.cleanupReconciliation && receipt.cleanupReconciliation.previousReceiptVersion !== row.receipt_version - 1)
      fail('code_effect_corrupt', 'Cleanup reconciliation does not match its prior receipt version');
    return { row, identity, resource: binding, receipt };
  }
  function publicRecord(value) {
    if (!value) return null;
    const { row, identity, receipt } = value;
    return freeze({ executionId: row.id, ...identity, status: row.status, resource: value.resource, receipt, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  const get = executionId => publicRecord(read(executionId));
  function live(runId) {
    const owner = db.prepare('SELECT status,deadline_at FROM agent_runs WHERE id=?').get(runId);
    if (!owner || owner.status !== 'running' || !Number.isSafeInteger(owner.deadline_at) || owner.deadline_at <= Date.now())
      fail('code_effect_inactive', 'Code execution requires its active, unexpired running owner');
  }
  function quarantined(engine) {
    if (engine !== 'docker') fail('code_effect_arguments', 'The code effect engine must be Docker');
    const blocked = new Map(db.prepare("SELECT id FROM agent_code_effects WHERE engine=? AND status='unknown' ORDER BY created_at,id").all(engine)
      .map(item => read(item.id)).filter(value => !value.receipt.cleanup.confirmed).map(value => [value.row.id, value]));
    for (const executionId of runtimeUncertain) {
      const value = read(executionId);
      if (value && value.row.engine === engine) blocked.set(executionId, value);
    }
    return [...blocked.values()].map(publicRecord);
  }
  function checked(ticket) {
    const expected = tickets.get(ticket);
    if (!expected) fail('code_effect_ticket', 'Only the original execution ticket from this store may change lifecycle state');
    const value = read(expected.executionId);
    if (!value || stableJson(value.identity) !== expected.identityJson) fail('code_effect_identity', 'Stored execution no longer matches its original ticket');
    return value;
  }
  function notify(row) {
    try {
      const returned = onReceipt(row.run_id, freeze(JSON.parse(row.receipt_json)));
      if (returned && typeof returned.then === 'function') { Promise.resolve(returned).catch(() => {}); return; }
      db.prepare('UPDATE agent_code_effects SET notified_at=? WHERE id=? AND receipt_version=? AND receipt_json=?')
        .run(Date.now(), row.id, row.receipt_version, row.receipt_json);
    } catch { /* Retry only the independently durable latest receipt. */ }
  }
  function save(row, receipt) {
    const json = stableJson(receipt), status = receipt.outcome === 'unknown' ? 'unknown' : 'settled';
    const changed = db.prepare('UPDATE agent_code_effects SET status=?,receipt_json=?,receipt_version=receipt_version+1,notified_at=NULL,updated_at=? WHERE id=?')
      .run(status, json, Date.now(), row.id);
    if (Number(changed.changes) !== 1) fail('code_effect_write', 'Code lifecycle settlement was not committed to its exact row');
    const stored = read(row.id);
    if (stored.row.receipt_json !== json || stored.row.receipt_version !== row.receipt_version + 1) fail('code_effect_write', 'Stored code receipt differs from the committed settlement');
    return { row: stored.row, receipt };
  }
  function begin(input) {
    validIdentity(input);
    return transaction(db, () => {
      live(input.runId); requireDurableEffectJournal(db);
      if (quarantined(input.engine).length) fail('code_engine_quarantined', 'Unconfirmed prior cleanup blocks new execution on this engine');
      const previous = db.prepare('SELECT id FROM agent_code_effects WHERE run_id=? AND call_id=?').get(input.runId, input.callId);
      if (previous) {
        const value = read(previous.id);
        if (stableJson(value.identity) !== stableJson(input)) fail('code_effect_identity', 'The call already has a different code argument or engine identity');
        const ticket = originals.get(previous.id);
        if (!ticket) fail('code_effect_exists', 'This execution belongs to an earlier store instance and cannot be reissued');
        return ticket;
      }
      const executionId = randomUUID(), stamp = Date.now();
      const inserted = db.prepare("INSERT INTO agent_code_effects(id,run_id,call_id,engine,language,args_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'prepared',?,?)")
        .run(executionId, input.runId, input.callId, input.engine, input.language, input.argsHash, stamp, stamp);
      if (Number(inserted.changes) !== 1 || !read(executionId)) fail('code_effect_write', 'Code execution preparation was not committed');
      const ticket = Object.freeze(Object.defineProperty({}, 'executionId', { value: executionId, enumerable: false, writable: false }));
      tickets.set(ticket, { executionId, identityJson: stableJson(input) }); originals.set(executionId, ticket); return ticket;
    });
  }
  function dispatch(ticket) {
    return transaction(db, () => {
      const value = checked(ticket);
      if (value.row.status !== 'prepared') fail('code_effect_already_dispatched', 'Code dispatch intent can only be committed once');
      live(value.row.run_id); requireDurableEffectJournal(db);
      if (quarantined(value.row.engine).length) fail('code_engine_quarantined', 'Unconfirmed prior cleanup blocks this engine dispatch');
      const changed = db.prepare("UPDATE agent_code_effects SET status='dispatching',dispatch_attempted=1,updated_at=? WHERE id=? AND status='prepared'").run(Date.now(), value.row.id);
      if (Number(changed.changes) !== 1) fail('code_effect_write', 'Code dispatch intent was not committed');
      if (read(value.row.id).row.status !== 'dispatching') fail('code_effect_write', 'Stored code dispatch intent is inconsistent');
      return get(value.row.id);
    });
  }
  function recordResource(ticket, supplied) {
    return transaction(db, () => {
      const value = checked(ticket);
      if (value.row.status !== 'dispatching') fail('code_resource_state', 'Only an original dispatching execution may bind a Docker resource');
      requireDurableEffectJournal(db);
      const binding = dockerResourceIdentity(supplied, value.row.id), json = stableJson(binding), previous = value.resource;
      if (Buffer.byteLength(json) > 4096) fail('code_resource_invalid', 'Docker resource binding exceeds its metadata limit');
      if (!previous && binding.containerId) fail('code_resource_conflict', 'The exact resource must be bound durably before a running witness is recorded');
      if (previous) {
        const { containerId: oldId, ...oldBase } = previous, { containerId: newId, ...newBase } = binding;
        if (stableJson(oldBase) !== stableJson(newBase) || oldId && oldId !== newId) fail('code_resource_conflict', 'Docker binding and witnessed ID are immutable');
        if (json === value.row.resource_json) return publicRecord(value);
      }
      const changed = db.prepare("UPDATE agent_code_effects SET resource_json=?,updated_at=? WHERE id=? AND status='dispatching' AND resource_json IS ?")
        .run(json, Date.now(), value.row.id, value.row.resource_json);
      if (Number(changed.changes) !== 1) fail('code_effect_write', 'Docker resource identity was not committed');
      const stored = read(value.row.id);
      if (stored.row.resource_json !== json) fail('code_effect_write', 'Stored Docker resource identity differs from its exact binding');
      return publicRecord(stored);
    });
  }
  function terminalOwner(runId) {
    const owner = db.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId);
    if (!owner || !['completed', 'failed', 'cancelled'].includes(owner.status)) fail('code_reconciliation_inactive', 'Operator cleanup reconciliation requires a terminal source run');
  }
  async function reconcileCleanup(executionId, observe) {
    if (typeof observe !== 'function') fail('code_reconciliation_arguments', 'A trusted bounded resource observer is required');
    const original = read(executionId);
    if (!original || original.row.status !== 'unknown' || original.receipt.cleanup.confirmed || !original.resource?.containerId)
      fail('code_reconciliation_unavailable', 'Only unknown cleanup with a historically witnessed exact container ID may be reconciled');
    terminalOwner(original.row.run_id); requireDurableEffectJournal(db);
    const startedAt = Date.now(), controller = new AbortController(); let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { const failure = new AgentError('code_reconciliation_timeout', 'Operator resource observation exceeded its deadline'); controller.abort(failure); reject(failure); }, 15000);
    });
    let observed;
    try { observed = await Promise.race([Promise.resolve().then(() => observe(original.resource, Object.freeze({ signal: controller.signal }))), timeout]); }
    finally { clearTimeout(timer); }
    const proof = absenceProof(observed, original.resource);
    if (proof.observedAt < startedAt || proof.observedAt > Date.now()) fail('code_reconciliation_proof', 'Operator absence proof is stale or has a future timestamp');
    const publication = transaction(db, () => {
      const current = read(executionId);
      requireDurableEffectJournal(db);
      if (!current || current.row.status !== 'unknown' || current.receipt.cleanup.confirmed
        || stableJson(current.identity) !== stableJson(original.identity) || current.row.receipt_version !== original.row.receipt_version
        || current.row.receipt_json !== original.row.receipt_json || current.row.resource_json !== original.row.resource_json)
        fail('code_reconciliation_conflict', 'Code receipt or resource identity changed during operator observation');
      terminalOwner(current.row.run_id);
      const receipt = canonical({ ...current.receipt,
        cleanup: { confirmed: true, verifiedAbsent: true, name: current.resource.name, containerId: current.resource.containerId, reconciled: true },
        cleanupReconciliation: { method: 'observed_absence', previousReceiptVersion: current.row.receipt_version, ...proof } }, current.row);
      return save(current.row, receipt);
    });
    runtimeUncertain.delete(executionId); notify(publication.row); return publication.receipt;
  }
  function settle(ticket, supplied) {
    let publication;
    try {
      publication = transaction(db, () => {
        const value = checked(ticket), receipt = canonical(supplied, value.row), json = stableJson(receipt);
        if (value.row.receipt_json === json) return { receipt: value.receipt, changed: false };
        if (value.row.status === 'settled' || value.row.status === 'unknown' && value.receipt.cleanup.confirmed)
          fail('code_effect_conflict', 'The terminal code lifecycle already has a different outcome');
        if (value.row.status === 'unknown' && !receipt.cleanup.confirmed) fail('code_effect_conflict', 'Only conclusive late cleanup may replace an unknown receipt');
        return { ...save(value.row, receipt), changed: true };
      });
    } catch (caught) {
      const original = tickets.get(ticket);
      if (original) {
        const row = raw(original.executionId);
        if (row?.status === 'dispatching') runtimeUncertain.add(row.id);
        else if (row?.status === 'unknown') {
          try { if (!read(row.id).receipt.cleanup.confirmed) runtimeUncertain.add(row.id); }
          catch { runtimeUncertain.add(row.id); }
        }
      }
      throw caught;
    }
    if (publication.receipt.cleanup.confirmed) runtimeUncertain.delete(publication.receipt.effectId);
    if (publication.changed) notify(publication.row);
    return publication.receipt;
  }
  function recover() {
    const publications = transaction(db, () => db.prepare("SELECT id FROM agent_code_effects WHERE status IN ('prepared','dispatching') ORDER BY created_at,id").all().map(item => {
      const value = read(item.id), attempted = Boolean(value.row.dispatch_attempted);
      const receipt = canonical({ outcome: attempted ? 'unknown' : 'not_started', dispatchAttempted: attempted, codeMayHaveRun: attempted,
        isolationVerified: false, termination: attempted ? 'interrupted_unknown' : 'interrupted_before_dispatch', cleanup: { confirmed: !attempted }, proof: { recovered: true } }, value.row);
      return save(value.row, receipt);
    }));
    const recovered = new Set(publications.map(value => value.row.id));
    for (const value of publications) notify(value.row);
    for (const row of db.prepare('SELECT id FROM agent_code_effects WHERE receipt_json IS NOT NULL AND notified_at IS NULL').all())
      if (!recovered.has(row.id)) { const value = read(row.id); notify(value.row); }
    return publications.map(value => get(value.row.id));
  }
  return Object.freeze({ begin, dispatch, recordResource, settle, get, quarantined, recover, reconcileCleanup });
}
