import { randomUUID, createHash } from 'node:crypto';
import { normalizeSchedule, nextOccurrence, previewSchedule } from './schedule.js';
import { normalizeAgentBudget, DEFAULT_TASK_BUDGET } from '../agent/budget.js';
import { assertLocalModel } from '../agent/provider.js';
import { stableJson } from '../agent/schema.js';

const ACTIVE = ['prepared','dispatching','running','approval_needed','unknown'];
const TERMINAL = new Set(['completed','failed','cancelled','interrupted']);
const SPEC_KEYS = ['title','goal','model','schedule','budget','limits'];
const clone = value => JSON.parse(JSON.stringify(value));
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const error = (code, message) => Object.assign(new Error(message), { code });
const fail = (code, message) => { throw error(code, message); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
function canonical(value, depth = 0) {
  if (depth > 16) fail('task_arguments', 'Task input is too deeply nested');
  if (value === null || ['string','boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 100) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object' && Object.keys(value).length <= 100) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  fail('task_arguments', 'Task input must contain bounded JSON values');
}
const serialized = value => stableJson(canonical(value));
const digest = value => createHash('sha256').update(value).digest('hex');
function transaction(db, work) {
  if (typeof db.transaction === 'function') return db.transaction(work).immediate();
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (caught) { db.exec('ROLLBACK'); throw caught; }
}

/** Local-only durable dispatch. The server adapter must enforce scheduled provenance/tool policy. */
export function createTaskScheduler({ db, agent, now = Date.now, onEvent = () => {}, autoStart = false } = {}) {
  if (!db?.prepare || !db?.exec || !agent || ['start','get','getByRequestId','cancel','isBusy'].some(key => typeof agent[key] !== 'function') || typeof now !== 'function' || typeof onEvent !== 'function' || typeof autoStart !== 'boolean') fail('task_configuration', 'A SQLite database and complete local agent adapter are required');
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
      spec_json TEXT NOT NULL, first_run_at INTEGER NOT NULL, next_run_at INTEGER,
      runs_started INTEGER NOT NULL DEFAULT 0, used_tokens INTEGER NOT NULL DEFAULT 0, reserved_tokens INTEGER NOT NULL DEFAULT 0,
      active_occurrence_id TEXT, attention_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_task_occurrences (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, generation INTEGER NOT NULL, scheduled_at INTEGER NOT NULL,
      request_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL, run_id TEXT, reservation INTEGER NOT NULL, reserved_tokens INTEGER NOT NULL,
      accounted_tokens INTEGER NOT NULL DEFAULT 0, usage_json TEXT NOT NULL DEFAULT '{}', receipt_json TEXT, error_json TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
      UNIQUE(task_id,generation,scheduled_at)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_one_active_occurrence ON scheduled_task_occurrences((1))
      WHERE status IN ('prepared','dispatching','running','approval_needed','unknown');
    CREATE INDEX IF NOT EXISTS scheduled_task_history ON scheduled_task_occurrences(task_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS scheduled_task_requests (
      request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, task_id TEXT, input_hash TEXT,
      state TEXT NOT NULL, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  let closed = false, timer, ticking;
  const inFlightStarts = new Map();
  const time = () => { const value = now(); if (!integer(value, 0, 8640000000000000 - 1)) fail('task_clock', 'Scheduler clock is invalid'); return value; };
  const taskRow = id => db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(id);
  const occurrenceRow = id => db.prepare('SELECT * FROM scheduled_task_occurrences WHERE id=?').get(id);
  const activeOccurrence = () => db.prepare("SELECT * FROM scheduled_task_occurrences WHERE status IN ('prepared','dispatching','running','approval_needed','unknown') ORDER BY created_at,id LIMIT 1").get();
  function event(type, taskId, occurrenceId, data = {}) {
    try { onEvent(freeze(clone({ type, taskId, occurrenceId, data, createdAt: time() }))); } catch { /* Observers do not own scheduler authority. */ }
  }
  function occurrence(row) {
    return { id: row.id, taskId: row.task_id, generation: row.generation, scheduledAt: row.scheduled_at, requestId: row.request_id,
      status: row.status, runId: row.run_id, reservation: row.reservation, reservedTokens: row.reserved_tokens, accountedTokens: row.accounted_tokens,
      usage: JSON.parse(row.usage_json), receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, error: row.error_json ? JSON.parse(row.error_json) : null,
      cancelRequested: row.cancel_requested === 1, createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at };
  }
  function get(id) {
    const row = taskRow(id); if (!row) return null;
    const history = db.prepare('SELECT * FROM scheduled_task_occurrences WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(id).map(occurrence);
    const current = row.active_occurrence_id ? occurrenceRow(row.active_occurrence_id) : null;
    const last = db.prepare('SELECT run_id FROM scheduled_task_occurrences WHERE task_id=? AND run_id IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 1').get(id);
    return { id: row.id, revision: row.revision, generation: row.generation, status: row.status, ...JSON.parse(row.spec_json),
      firstRunAt: row.first_run_at, nextRunAt: row.next_run_at, runsStarted: row.runs_started, usedTokens: row.used_tokens, reservedTokens: row.reserved_tokens,
      currentRunId: current && ACTIVE.includes(current.status) ? current.run_id : null, lastRunId: last?.run_id || null, activeOccurrenceId: row.active_occurrence_id,
      attention: row.attention_json ? JSON.parse(row.attention_json) : null, localOnly: true, requiresAppRunning: true, createdAt: row.created_at, updatedAt: row.updated_at, history };
  }
  const list = () => db.prepare('SELECT id FROM scheduled_tasks ORDER BY created_at DESC,id DESC').all().map(row => get(row.id));
  function request(requestId) {
    if (!identifier(requestId)) fail('task_arguments', 'A short requestId is required');
    const row = db.prepare('SELECT * FROM scheduled_task_requests WHERE request_id=?').get(requestId);
    return row ? { requestId, state: row.state, operation: row.operation, ...(row.task_id ? { taskId: row.task_id, task: get(row.task_id) } : {}), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  function normalizeSpec(value, stamp) {
    if (!exact(value, SPEC_KEYS)) fail('task_arguments', 'Only title, goal, exact local model, schedule, budget and lifetime limits are accepted');
    if (typeof value.title !== 'string' || !value.title.isWellFormed() || !value.title.trim() || value.title.trim().length > 120 || /[\x00-\x1f\x7f]/.test(value.title)) fail('task_arguments', 'Task title must contain 1–120 printable characters');
    if (typeof value.goal !== 'string' || !value.goal.isWellFormed() || !value.goal.trim() || value.goal.length > 20000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.goal)) fail('task_arguments', 'Task goal must contain 1–20000 characters');
    if (typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(value.model)) fail('task_arguments', 'An exact local Ollama model is required');
    assertLocalModel(value.model);
    if (value.budget?.maxCostUsd !== undefined && value.budget.maxCostUsd !== 0) fail('task_local_only', 'Scheduled tasks cannot spend cloud funds');
    const budget = normalizeAgentBudget(value.budget, { localOnly: true, defaults: DEFAULT_TASK_BUDGET });
    if (budget.maxCostUsd !== 0) fail('task_local_only', 'Scheduled tasks require a zero-dollar local budget');
    const schedule = normalizeSchedule(value.schedule, { now: stamp, requireFuture: true });
    if (!exact(value.limits, ['maxRuns','maxTotalTokens']) || !integer(value.limits.maxRuns, 1, 1000) || !integer(value.limits.maxTotalTokens, 1, 1000000)) fail('task_arguments', 'Lifetime limits require maxRuns 1–1000 and maxTotalTokens 1–1000000');
    if (schedule.kind === 'once' && value.limits.maxRuns !== 1) fail('task_arguments', 'A one-off task must have maxRuns 1');
    if (budget.maxTotalTokens > value.limits.maxTotalTokens) fail('task_budget', 'Lifetime tokens must fit the full per-run token reservation');
    return { title: value.title.trim(), goal: value.goal.trim(), model: value.model, schedule, budget, limits: clone(value.limits) };
  }
  function preview(spec) {
    const stamp = time(), normalized = normalizeSpec(spec, stamp), nextRuns = previewSchedule(normalized.schedule, stamp, 3);
    if (!nextRuns.length) fail('task_schedule', 'Schedule has no future occurrence');
    return { spec: normalized, firstRunAt: nextRuns[0], nextRuns, localOnly: true, requiresAppRunning: true };
  }
  function ensureOpen() { if (closed) fail('task_closed', 'The scheduler is closed'); }
  function mutation(operation, id, input, keys, apply) {
    ensureOpen();
    if (!exact(input, keys) || !identifier(input.requestId)) fail('task_arguments', 'Mutation requires a short requestId and exact supported fields');
    const inputHash = digest(serialized({ operation, id: id ?? null, input }));
    let changed = false;
    const taskId = transaction(db, () => {
      const old = db.prepare('SELECT * FROM scheduled_task_requests WHERE request_id=?').get(input.requestId);
      if (old) {
        if (old.state === 'cancelled') fail('task_request_cancelled', 'This request was cancelled and cannot create or modify a task');
        if (old.input_hash !== inputHash) fail('task_request_conflict', 'requestId was already used with different input');
        return old.task_id;
      }
      const resultId = apply(time()); changed = true;
      db.prepare('INSERT INTO scheduled_task_requests(request_id,operation,task_id,input_hash,state,result_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(input.requestId, operation, resultId, inputHash, operation === 'create' ? 'created' : 'applied', JSON.stringify(get(resultId)), time(), time());
      return resultId;
    });
    if (changed) event(`task_${operation}`, taskId, undefined, { revision: get(taskId).revision, status: get(taskId).status });
    return get(taskId);
  }
  const requireRevision = (id, revision) => {
    const row = taskRow(id); if (!row) fail('task_not_found', 'Scheduled task does not exist');
    if (!integer(revision, 1, Number.MAX_SAFE_INTEGER) || row.revision !== revision) fail('task_revision_conflict', 'Task changed; review its current revision');
    return row;
  };
  function expectedFirst(spec, stamp, expected) {
    const first = nextOccurrence(spec.schedule, stamp);
    if (!integer(expected, 0, 8640000000000000 - 1) || expected !== first) fail('task_preview_stale', 'First occurrence changed; review a fresh schedule preview');
    return first;
  }
  async function create(input) {
    return mutation('create', null, input, ['requestId','expectedFirstRunAt',...SPEC_KEYS], stamp => {
      const spec = normalizeSpec(Object.fromEntries(SPEC_KEYS.filter(key => input[key] !== undefined).map(key => [key,input[key]])), stamp);
      const first = expectedFirst(spec, stamp, input.expectedFirstRunAt);
      if (db.prepare('SELECT count(*) AS n FROM scheduled_tasks').get().n >= 256 || db.prepare("SELECT count(*) AS n FROM scheduled_tasks WHERE status!='archived'").get().n >= 32) fail('task_limit', 'Scheduled task capacity is full');
      const id = randomUUID(); db.prepare('INSERT INTO scheduled_tasks(id,revision,generation,status,spec_json,first_run_at,next_run_at,created_at,updated_at) VALUES (?,1,1,?,?,?,?,?,?)').run(id, 'active', JSON.stringify(spec), first, first, stamp, stamp); return id;
    });
  }
  async function update(id, input) {
    const result = mutation('update', id, input, ['requestId','expectedRevision','expectedFirstRunAt',...SPEC_KEYS], stamp => {
      const row = requireRevision(id, input.expectedRevision);
      if (['completed','archived'].includes(row.status)) fail('task_state', 'Completed or archived tasks cannot be rearmed by editing');
      const spec = normalizeSpec(Object.fromEntries(SPEC_KEYS.filter(key => input[key] !== undefined).map(key => [key,input[key]])), stamp), first = expectedFirst(spec, stamp, input.expectedFirstRunAt);
      if (spec.limits.maxRuns < row.runs_started || spec.limits.maxTotalTokens < row.used_tokens + row.reserved_tokens) fail('task_budget', 'Edited lifetime limits cannot erase spent or reserved work');
      db.prepare("UPDATE scheduled_tasks SET revision=revision+1,generation=generation+1,status='active',spec_json=?,first_run_at=?,next_run_at=?,attention_json=NULL,updated_at=? WHERE id=?").run(JSON.stringify(spec), first, first, stamp, id);
      if (row.active_occurrence_id) db.prepare('UPDATE scheduled_task_occurrences SET cancel_requested=1,updated_at=? WHERE id=?').run(stamp, row.active_occurrence_id);
      return id;
    });
    await cancelOwned(id); return get(result.id);
  }
  async function stateChange(operation, id, input) {
    const result = mutation(operation, id, input, ['requestId','expectedRevision'], stamp => {
      const row = requireRevision(id, input.expectedRevision);
      if (operation === 'resume') {
        if (!['paused','attention'].includes(row.status)) fail('task_state', 'Only paused or attention tasks can resume');
        if (row.active_occurrence_id) fail('task_active', 'The current occurrence must finish or be cancelled before resuming');
        const spec = JSON.parse(row.spec_json);
        if (spec.schedule.kind === 'once' && nextOccurrence(spec.schedule, stamp) === null) fail('task_schedule', 'A past one-off task cannot resume');
        if (row.runs_started >= spec.limits.maxRuns || row.used_tokens + row.reserved_tokens + spec.budget.maxTotalTokens > spec.limits.maxTotalTokens) fail('task_budget', 'Lifetime budget is exhausted');
        const first = nextOccurrence(spec.schedule, stamp);
        db.prepare("UPDATE scheduled_tasks SET revision=revision+1,generation=generation+1,status='active',first_run_at=?,next_run_at=?,attention_json=NULL,updated_at=? WHERE id=?").run(first, first, stamp, id);
      } else {
        if (row.status === 'archived' || row.status === 'completed' && operation !== 'archive') fail('task_state', 'This task cannot change to the requested state');
        db.prepare('UPDATE scheduled_tasks SET revision=revision+1,status=?,updated_at=? WHERE id=?').run(operation === 'pause' ? 'paused' : 'archived', stamp, id);
        if (row.active_occurrence_id) db.prepare('UPDATE scheduled_task_occurrences SET cancel_requested=1,updated_at=? WHERE id=?').run(stamp, row.active_occurrence_id);
      }
      return id;
    });
    if (operation !== 'resume') await cancelOwned(id);
    return get(result.id);
  }
  async function cancelRequest(requestId) {
    ensureOpen(); if (!identifier(requestId)) fail('task_arguments', 'A short requestId is required');
    let taskId, changed = false;
    transaction(db, () => {
      const old = db.prepare('SELECT * FROM scheduled_task_requests WHERE request_id=?').get(requestId), stamp = time();
      if (!old) { db.prepare("INSERT INTO scheduled_task_requests(request_id,operation,state,created_at,updated_at) VALUES (?,'create','cancelled',?,?)").run(requestId, stamp, stamp); changed = true; return; }
      if (old.state === 'cancelled') { taskId = old.task_id; return; }
      const row = taskRow(old.task_id);
      if (old.operation !== 'create' || !row || row.revision !== 1 || row.generation !== 1) fail('task_revision_conflict', 'Only the original unedited creation can be cancelled by requestId');
      taskId = row.id; db.prepare("UPDATE scheduled_tasks SET status='archived',revision=revision+1,updated_at=? WHERE id=?").run(stamp, row.id);
      if (row.active_occurrence_id) db.prepare('UPDATE scheduled_task_occurrences SET cancel_requested=1,updated_at=? WHERE id=?').run(stamp, row.active_occurrence_id);
      db.prepare("UPDATE scheduled_task_requests SET state='cancelled',updated_at=? WHERE request_id=?").run(stamp, requestId);
      changed = true;
    });
    if (taskId) { if (changed) event('task_request_cancelled', taskId); await cancelOwned(taskId); }
    return request(requestId);
  }
  function attention(occurrenceId, code, message) {
    transaction(db, () => {
      const row = occurrenceRow(occurrenceId); if (!row || TERMINAL.has(row.status)) return;
      db.prepare("UPDATE scheduled_task_occurrences SET status='unknown',error_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ code, message }), time(), row.id);
      db.prepare("UPDATE scheduled_tasks SET status=CASE WHEN status IN ('paused','archived') THEN status ELSE 'attention' END,attention_json=?,updated_at=? WHERE id=?").run(JSON.stringify({ code, message, occurrenceId }), time(), row.task_id);
    });
    const row = occurrenceRow(occurrenceId); if (row) event('task_attention', row.task_id, row.id, { code });
  }
  function ownedRun(row, run) {
    const body = frozenBody(row), id = run?.id || run?.runId;
    const provenance = run?.provenance;
    if (!identifier(id) || run.requestId !== row.request_id || run.conversationId !== body.conversationId || run.model !== body.model || run.goal !== body.goal
      || (run.provider ?? 'ollama') !== 'ollama' || run.allowCloud === true || run.desktopSessionId || run.attachments?.length || run.thinking!==undefined ||run.imageMode!==undefined
      || serialized(run.budget) !== serialized(body.budget)
      || !exact(provenance, ['kind','taskId','generation','occurrenceId','scheduledAt','requestHash']) || provenance.kind !== 'scheduled_task'
      || provenance.taskId !== row.task_id || provenance.generation !== row.generation || provenance.occurrenceId !== row.id || provenance.scheduledAt !== row.scheduled_at || provenance.requestHash !== row.request_hash) fail('task_run_mismatch', 'Agent receipt does not match the frozen local occurrence');
    return id;
  }
  function frozenBody(row) {
    const body = JSON.parse(row.request_json);
    if (digest(stableJson(body)) !== row.request_hash || !exact(body, ['requestId','conversationId','goal','model','provider','allowCloud','budget','attachments'])
      || body.requestId !== row.request_id || body.requestId !== `task:${row.task_id}:g${row.generation}:${row.scheduled_at}`
      || body.conversationId !== `task:${row.task_id}:g${row.generation}` || body.provider !== 'ollama' || body.allowCloud !== false || body.budget?.maxCostUsd !== 0
      || !Array.isArray(body.attachments) || body.attachments.length || body.budget.maxTotalTokens !== row.reservation) fail('task_request_corrupt', 'Persisted scheduled request integrity failed; no dispatch is permitted');
    assertLocalModel(body.model); return freeze(body);
  }
  async function lookup(row) {
    const found = await agent.getByRequestId(row.request_id);
    if (found) { ownedRun(row, found); if (row.run_id && (found.id || found.runId) !== row.run_id) fail('task_run_mismatch', 'Agent request/run identity changed'); return found; }
    if (row.run_id) { const byId = await agent.get(row.run_id); if (byId) { ownedRun(row, byId); return byId; } }
    return null;
  }
  function accept(rowId, run) {
    const row = occurrenceRow(rowId), id = ownedRun(row, run);
    if (!['queued','running','awaiting_approval','completed','failed','cancelled','interrupted'].includes(run.status)) fail('task_run_mismatch', 'Agent receipt status is unsupported');
    const state = run.status === 'awaiting_approval' ? 'approval_needed' : run.status === 'failed' && run.error?.code === 'interrupted' ? 'interrupted' : run.status === 'queued' ? 'running' : run.status;
    // A delayed lookup cannot resurrect a durable terminal occurrence, including
    // when another scheduler/reconciler completed cancellation while it awaited.
    if (TERMINAL.has(row.status) && state !== row.status) return row;
    const usage = run.usage;
    if (!usage || !integer(usage.totalTokens, 0, Number.MAX_SAFE_INTEGER) || !integer(usage.inputTokens, 0, Number.MAX_SAFE_INTEGER) || !integer(usage.outputTokens, 0, Number.MAX_SAFE_INTEGER)
      || usage.totalTokens !== usage.inputTokens + usage.outputTokens || usage.totalTokens < row.accounted_tokens || usage.costUsd !== 0
      || !integer(usage.reservedInputTokens??0,0,Number.MAX_SAFE_INTEGER)||!integer(usage.reservedOutputTokens??0,0,Number.MAX_SAFE_INTEGER)||usage.auxiliaryUsageKnown!==undefined&&typeof usage.auxiliaryUsageKnown!=='boolean'
      || usage.auxiliaryUsageKnown===true&&((usage.reservedInputTokens??0)+(usage.reservedOutputTokens??0)>0)) fail('task_usage_unknown', 'Agent usage must be actual, monotonic, local and complete');
    const accountingKnown=(usage.reservedInputTokens??0)===0&&(usage.reservedOutputTokens??0)===0&&usage.auxiliaryUsageKnown!==false;
    const terminal = TERMINAL.has(run.status), stamp = time();
    const approvalId = run.pendingApproval?.approvalId || run.approval?.approvalId;
    const receipt = { runId: id, status: run.status, usage: clone(usage), ...(run.error ? { error: { code: String(run.error.code || 'agent_failed').slice(0, 80), message: String(run.error.message || 'Agent run failed').slice(0, 500) } } : {}),
      ...(identifier(approvalId) ? { approvalId } : {}), updatedAt: run.updatedAt ?? stamp };
    const applied = transaction(db, () => {
      const current = occurrenceRow(rowId), task = taskRow(current.task_id), spec = JSON.parse(task.spec_json);
      // Recheck after acquiring the write lock too: another SQLite connection
      // may have committed a newer receipt after the pre-transaction read.
      if (TERMINAL.has(current.status) && state !== current.status || usage.totalTokens < current.accounted_tokens
        || TERMINAL.has(current.status) && usage.totalTokens === current.accounted_tokens&&stableJson(usage)===stableJson(JSON.parse(current.usage_json))) return false;
      // Failure/cancellation can hide an in-flight provider response. Keep its
      // unreported worst-case reservation instead of pretending usage zero.
      const remaining = terminal && state === 'completed'&&accountingKnown ? 0 : Math.max(0, current.reservation - usage.totalTokens), delta = usage.totalTokens - current.accounted_tokens;
      db.prepare('UPDATE scheduled_task_occurrences SET status=?,run_id=?,reserved_tokens=?,accounted_tokens=?,usage_json=?,receipt_json=?,updated_at=?,finished_at=? WHERE id=?')
        .run(state, id, remaining, usage.totalTokens, JSON.stringify(usage), JSON.stringify(receipt), stamp, terminal ? stamp : null, rowId);
      db.prepare('UPDATE scheduled_tasks SET used_tokens=used_tokens+?,reserved_tokens=reserved_tokens+?,active_occurrence_id=?,updated_at=? WHERE id=?')
        .run(delta, remaining - current.reserved_tokens, task.active_occurrence_id === current.id ? terminal ? null : current.id : task.active_occurrence_id, stamp, task.id);
      const overage = task.used_tokens + delta > spec.limits.maxTotalTokens;
      const stopped = ['paused','archived'].includes(task.status), intentionallyCancelled = current.cancel_requested === 1 && (stopped || current.generation !== task.generation || closed);
      const priorAttention = task.attention_json ? JSON.parse(task.attention_json) : null;
      const approvalCompleted = task.status === 'attention' && ['task_approval_required','task_usage_uncertain'].includes(priorAttention?.code) && priorAttention.occurrenceId === current.id && state === 'completed'&&accountingKnown;
      const exhausted = task.runs_started >= spec.limits.maxRuns || task.next_run_at === null
        || task.used_tokens + delta + task.reserved_tokens + remaining - current.reserved_tokens + spec.budget.maxTotalTokens > spec.limits.maxTotalTokens;
      if (!stopped && (overage || state === 'approval_needed' || terminal&&!accountingKnown||terminal && state !== 'completed' && !intentionallyCancelled)) {
        const code = overage ? 'task_lifetime_overage' : state === 'approval_needed' ? 'task_approval_required' : !accountingKnown?'task_usage_uncertain':'task_run_failed';
        db.prepare("UPDATE scheduled_tasks SET status='attention',attention_json=? WHERE id=?").run(JSON.stringify({ code, occurrenceId: current.id, runId: id }), task.id);
      } else if (!stopped && approvalCompleted) {
        if (exhausted) db.prepare("UPDATE scheduled_tasks SET status='completed',next_run_at=NULL,attention_json=NULL WHERE id=?").run(task.id);
        else db.prepare("UPDATE scheduled_tasks SET status='attention',attention_json=? WHERE id=?").run(JSON.stringify({ code: 'task_resume_required', message: 'This run completed; resume future occurrences explicitly.', occurrenceId: current.id, runId: id }), task.id);
      } else if (!stopped && task.status === 'active' && terminal && exhausted) {
        db.prepare("UPDATE scheduled_tasks SET status='completed',next_run_at=NULL,attention_json=NULL WHERE id=?").run(task.id);
      }
      return true;
    });
    if (applied) event(`task_occurrence_${state}`, row.task_id, rowId, { runId: id, usedTokens: usage.totalTokens });
    return occurrenceRow(rowId);
  }
  function cancelPrepared(row, knownNotDispatched = false) {
    transaction(db, () => {
      const fresh = occurrenceRow(row.id); if (fresh.status !== 'prepared' && !(knownNotDispatched && fresh.status === 'dispatching')) return;
      db.prepare("UPDATE scheduled_task_occurrences SET status='cancelled',reserved_tokens=0,cancel_requested=1,updated_at=?,finished_at=? WHERE id=?").run(time(), time(), row.id);
      db.prepare('UPDATE scheduled_tasks SET reserved_tokens=reserved_tokens-?,active_occurrence_id=NULL,updated_at=? WHERE id=?').run(fresh.reserved_tokens, time(), fresh.task_id);
    });
  }
  async function cancelOwned(taskId) {
    const task = taskRow(taskId), row = task?.active_occurrence_id ? occurrenceRow(task.active_occurrence_id) : null;
    if (!row || !row.cancel_requested) return;
    if (row.status === 'prepared') { cancelPrepared(row); return; }
    try {
      const run = await lookup(row);
      if (!run) { if (!inFlightStarts.has(row.id)) attention(row.id, 'task_dispatch_unknown', 'An attempted occurrence has no confirmed agent receipt; it will never be resubmitted'); return; }
      const id = ownedRun(row, run);
      if (!TERMINAL.has(run.status)) { const cancelled = await agent.cancel(id); accept(row.id, cancelled || await lookup(occurrenceRow(row.id)) || run); }
      else accept(row.id, run);
    } catch { attention(row.id, 'task_cancel_unknown', 'Owned run cancellation could not be confirmed'); }
  }
  function latestDue(schedule, due, stamp) {
    let low = due - 1, high = stamp + 1;
    // nextOccurrence is monotonic; this bounds coalescing even after years offline.
    while (high - low > 1) { const middle = low + Math.floor((high - low) / 2), next = nextOccurrence(schedule, middle); if (next !== null && next <= stamp) low = middle; else high = middle; }
    const result = nextOccurrence(schedule, low);
    if (result === null || result < due || result > stamp) fail('task_schedule', 'Unable to select a due schedule slot');
    return result;
  }
  async function launch(row) {
    let task = taskRow(row.task_id);
    if (closed || task.status !== 'active' || task.generation !== row.generation || row.cancel_requested) { cancelPrepared(row); return; }
    try {
      const existing = await lookup(row); if (existing) { accept(row.id, existing); return; }
      task = taskRow(row.task_id); row = occurrenceRow(row.id);
      if (closed || task.status !== 'active' || task.generation !== row.generation || row.cancel_requested) { cancelPrepared(row); return; }
      if (db.prepare("UPDATE scheduled_task_occurrences SET status='dispatching',updated_at=? WHERE id=? AND status='prepared'").run(time(), row.id).changes !== 1) return;
      const body = frozenBody(row);
      // Persisted dispatch intent precedes the call. A missing response can never trigger a replay.
      const pending = Promise.resolve().then(async () => {
        const busy = await agent.isBusy();
        const currentTask = taskRow(row.task_id), current = occurrenceRow(row.id);
        if (closed || currentTask.status !== 'active' || currentTask.generation !== row.generation || current.cancel_requested) {
          cancelPrepared(current, true); throw error('task_not_dispatched', 'Task authority stopped before adapter dispatch');
        }
        if (busy !== false) {
          db.prepare("UPDATE scheduled_task_occurrences SET status='prepared',updated_at=? WHERE id=? AND status='dispatching'").run(time(), row.id);
          throw error('task_deferred', 'Interactive agent work began before scheduled dispatch');
        }
        return agent.start(body);
      }); inFlightStarts.set(row.id, pending);
      let run;
      try { run = await pending; }
      catch (caught) { if (['task_not_dispatched','task_deferred'].includes(caught?.code)) return; run = await lookup(occurrenceRow(row.id)); if (!run) { attention(row.id, 'task_dispatch_unknown', 'Agent acceptance was not confirmed; this occurrence will never be resubmitted'); return; } }
      accept(row.id, run);
      if (closed) db.prepare('UPDATE scheduled_task_occurrences SET cancel_requested=1 WHERE id=?').run(row.id);
      await cancelOwned(row.task_id);
    } catch { attention(row.id, 'task_dispatch_unknown', 'Agent occurrence could not be safely reconciled; no retry is permitted'); }
    finally { inFlightStarts.delete(row.id); }
  }
  async function reconcile(row) {
    if (row.status === 'prepared') { await launch(row); return; }
    try {
      const run = await lookup(row);
      if (!run) { attention(row.id, 'task_dispatch_unknown', 'An attempted occurrence has no durable agent run; it will never be resubmitted'); return; }
      accept(row.id, run); await cancelOwned(row.task_id);
    } catch { attention(row.id, 'task_recovery_unknown', 'Agent state could not be reconciled; no replay is permitted'); }
  }
  async function performTick() {
    if (closed) return { closed: true, dispatched: 0 };
    const active = activeOccurrence();
    if (active) { await reconcile(active); return { dispatched: 0, activeOccurrenceId: activeOccurrence()?.id || null }; }
    let busy;
    try { busy = await agent.isBusy(); } catch { return { dispatched: 0, deferred: 'agent_unavailable' }; }
    if (closed || busy !== false) return { dispatched: 0, deferred: closed ? 'closed' : 'agent_busy' };
    const stamp = time();
    const row = transaction(db, () => {
      if (closed || activeOccurrence()) return null;
      const task = db.prepare("SELECT * FROM scheduled_tasks WHERE status='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT 1").get(stamp); if (!task) return null;
      const spec = JSON.parse(task.spec_json);
      if (task.runs_started >= spec.limits.maxRuns || task.used_tokens + task.reserved_tokens + spec.budget.maxTotalTokens > spec.limits.maxTotalTokens) {
        db.prepare("UPDATE scheduled_tasks SET status='completed',next_run_at=NULL,updated_at=? WHERE id=?").run(stamp, task.id); return null;
      }
      const slot = latestDue(spec.schedule, task.next_run_at, stamp), id = randomUUID(), requestId = `task:${task.id}:g${task.generation}:${slot}`;
      const body = { requestId, conversationId: `task:${task.id}:g${task.generation}`, goal: spec.goal, model: spec.model, provider: 'ollama', allowCloud: false, budget: spec.budget, attachments: [] };
      const json = serialized(body), reservation = spec.budget.maxTotalTokens;
      db.prepare('INSERT INTO scheduled_task_occurrences(id,task_id,generation,scheduled_at,request_id,request_json,request_hash,status,reservation,reserved_tokens,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, task.id, task.generation, slot, requestId, json, digest(json), 'prepared', reservation, reservation, stamp, stamp);
      db.prepare('UPDATE scheduled_tasks SET runs_started=runs_started+1,reserved_tokens=reserved_tokens+?,active_occurrence_id=?,next_run_at=?,updated_at=? WHERE id=?').run(reservation, id, nextOccurrence(spec.schedule, stamp), stamp, task.id);
      return occurrenceRow(id);
    });
    if (!row) return { dispatched: 0 };
    event('task_occurrence_prepared', row.task_id, row.id, { scheduledAt: row.scheduled_at, reservation: row.reservation });
    await launch(row); return { dispatched: 1, occurrenceId: row.id };
  }
  function tick() {
    if (ticking) return ticking;
    const pending = performTick(); ticking = pending;
    return pending.finally(() => { if (ticking === pending) ticking = undefined; });
  }
  async function start() {
    ensureOpen(); if (!timer) { timer = setInterval(() => { tick().catch(() => event('task_scheduler_error', undefined, undefined, { code: 'task_tick_failed' })); }, 1000); timer.unref?.(); }
    await tick(); return { started: true };
  }
  async function close() {
    closed = true; clearInterval(timer); timer = undefined;
    const active = activeOccurrence();
    if (active) db.prepare('UPDATE scheduled_task_occurrences SET cancel_requested=1,updated_at=? WHERE id=?').run(time(), active.id);
    let settled = false, deadline;
    const settle = (async () => {
      if (active) await cancelOwned(active.task_id);
      await Promise.allSettled([...(ticking ? [ticking] : []), ...inFlightStarts.values()]);
      settled = true;
    })();
    await Promise.race([settle, new Promise(resolve => { deadline = setTimeout(resolve, 5000); })]); clearTimeout(deadline);
    return { closed: true, cleanupConfirmed: settled && inFlightStarts.size === 0, pendingStart: inFlightStarts.size > 0, activeOccurrenceId: activeOccurrence()?.id || null };
  }
  function reconcileUsage(run) {
    if(!run||typeof run.requestId!=='string')return false;
    const row=db.prepare('SELECT * FROM scheduled_task_occurrences WHERE request_id=?').get(run.requestId);
    if(!row)return false;
    accept(row.id,run);return true;
  }
  const api = { preview, create, update, pause: (id, input) => stateChange('pause', id, input), resume: (id, input) => stateChange('resume', id, input), archive: (id, input) => stateChange('archive', id, input), list, get, request, cancelRequest, start, tick, close,reconcileUsage };
  if (autoStart) queueMicrotask(() => { if (!closed) start().catch(() => event('task_scheduler_error', undefined, undefined, { code: 'task_start_failed' })); });
  return api;
}
