import { randomUUID } from 'node:crypto';
import { fail } from './schema.js';

const MAX_INPUT = 1_000_000_000;
const TABLES = Object.freeze({ embedding: 'agent_auxiliary_inputs', vision: 'agent_auxiliary_generations' });
const ACTIVE = new Set(['queued', 'running', 'awaiting_approval']);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
function transaction(db, callback) {
  if (typeof db.transaction === 'function') return db.transaction(callback).immediate();
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Shared durable local AI accounting. Tickets never contain enumerable identity. */
export function createAuxiliaryBudgetLedger({ db, onUsage = () => {}, now = Date.now, assertLiveCall } = {}) {
  if (!db?.prepare || !db?.exec || typeof onUsage !== 'function' || typeof now !== 'function' || typeof assertLiveCall !== 'function') {
    fail('invalid_auxiliary_budget', 'A synchronous database, live-call guard, clock and usage observer are required');
  }
  const tickets = new WeakMap();
  db.exec(`CREATE TABLE IF NOT EXISTS agent_auxiliary_inputs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind='embedding'), estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens BETWEEN 1 AND 1000000000),
    actual_input_tokens INTEGER CHECK(actual_input_tokens IS NULL OR actual_input_tokens BETWEEN 0 AND 1000000000),
    status TEXT NOT NULL CHECK(status IN ('reserved','unknown','settled','not_dispatched')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK((status='settled' AND actual_input_tokens IS NOT NULL) OR (status!='settled' AND actual_input_tokens IS NULL))
  ); CREATE INDEX IF NOT EXISTS agent_auxiliary_run ON agent_auxiliary_inputs(run_id,status);
  CREATE TABLE IF NOT EXISTS agent_auxiliary_generations (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind='vision'),
    estimated_input_tokens INTEGER NOT NULL CHECK(estimated_input_tokens BETWEEN 1 AND 1000000000),
    max_output_tokens INTEGER NOT NULL CHECK(max_output_tokens BETWEEN 1 AND 1000000000),
    actual_input_tokens INTEGER CHECK(actual_input_tokens IS NULL OR actual_input_tokens BETWEEN 0 AND 1000000000),
    actual_output_tokens INTEGER CHECK(actual_output_tokens IS NULL OR actual_output_tokens BETWEEN 0 AND 1000000000),
    status TEXT NOT NULL CHECK(status IN ('reserved','unknown','settled','not_dispatched')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK((status='settled' AND actual_input_tokens IS NOT NULL AND actual_output_tokens IS NOT NULL)
      OR (status='unknown' AND (actual_input_tokens IS NULL OR actual_output_tokens IS NULL))
      OR (status IN ('reserved','not_dispatched') AND actual_input_tokens IS NULL AND actual_output_tokens IS NULL))
  ); CREATE INDEX IF NOT EXISTS agent_auxiliary_generation_run ON agent_auxiliary_generations(run_id,status);`);
  function time() {
    const stamp = now(); if (!integer(stamp)) fail('auxiliary_clock', 'Auxiliary accounting clock is invalid'); return stamp;
  }
  function run(runId) {
    const row = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId);
    if (!row) fail('run_not_found', 'Auxiliary input owner does not exist');
    let request, usage;
    try { request = JSON.parse(row.request_json); usage = JSON.parse(row.usage_json); }
    catch { fail('auxiliary_usage_invalid', 'Stored run accounting is invalid'); }
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)
      || !integer(usage.inputTokens) || !integer(usage.outputTokens) || !integer(usage.totalTokens)
      || usage.totalTokens !== usage.inputTokens + usage.outputTokens
      || !integer(usage.auxiliaryInputTokens ?? 0) || (usage.auxiliaryInputTokens ?? 0) > usage.inputTokens
      || !integer(usage.auxiliaryOutputTokens ?? 0) || (usage.auxiliaryOutputTokens ?? 0) > usage.outputTokens
      || !integer(request?.budget?.maxTotalTokens, 1)) fail('auxiliary_usage_invalid', 'Stored run token accounting is invalid');
    return { row, usage, maximum: request.budget.maxTotalTokens, maximumInput: request.budget.maxInputTokens,
      maximumOutput: request.budget.maxOutputTokens };
  }
  function aggregate(runId) {
    const inputs = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status='settled' THEN actual_input_tokens ELSE 0 END),0) AS actual,
      COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') THEN estimated_input_tokens ELSE 0 END),0) AS held
      FROM agent_auxiliary_inputs WHERE run_id=?`).get(runId);
    const generations = db.prepare(`SELECT
      COALESCE(SUM(actual_input_tokens),0) AS actualInput,
      COALESCE(SUM(actual_output_tokens),0) AS actualOutput,
      COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') AND actual_input_tokens IS NULL THEN estimated_input_tokens ELSE 0 END),0) AS heldInput,
      COALESCE(SUM(CASE WHEN status IN ('reserved','unknown') AND actual_output_tokens IS NULL THEN max_output_tokens ELSE 0 END),0) AS heldOutput
      FROM agent_auxiliary_generations WHERE run_id=?`).get(runId);
    const totals = { actualInput: inputs.actual + generations.actualInput, actualOutput: generations.actualOutput,
      heldInput: inputs.held + generations.heldInput, heldOutput: generations.heldOutput };
    if (!Object.values(totals).every(value => integer(value))) fail('auxiliary_usage_invalid', 'Auxiliary token totals exceed safe accounting bounds');
    return totals;
  }
  // The aggregate is authoritative; delta adds only newly known auxiliary
  // input/output to CURRENT chat/aux usage, preserving USD and other fields.
  function refresh(runId, stamp) {
    const owner = run(runId), totals = aggregate(runId), inputDelta = totals.actualInput - (owner.usage.auxiliaryInputTokens ?? 0),
      outputDelta = totals.actualOutput - (owner.usage.auxiliaryOutputTokens ?? 0);
    if (inputDelta < 0 || outputDelta < 0 || !integer(owner.usage.inputTokens + inputDelta)
      || !integer(owner.usage.outputTokens + outputDelta) || !integer(owner.usage.totalTokens + inputDelta + outputDelta)
      || !integer(owner.usage.totalTokens + inputDelta + outputDelta + totals.heldInput + totals.heldOutput)) {
      fail('auxiliary_usage_invalid', 'Auxiliary accounting cannot decrease actual usage or overflow');
    }
    const usage = { ...owner.usage, inputTokens: owner.usage.inputTokens + inputDelta, outputTokens: owner.usage.outputTokens + outputDelta,
      totalTokens: owner.usage.totalTokens + inputDelta + outputDelta, auxiliaryInputTokens: totals.actualInput,
      auxiliaryOutputTokens: totals.actualOutput, reservedInputTokens: totals.heldInput, reservedOutputTokens: totals.heldOutput,
      auxiliaryUsageKnown: totals.heldInput === 0 && totals.heldOutput === 0 };
    const serialized = JSON.stringify(usage), changed = serialized !== owner.row.usage_json;
    if (changed) db.prepare('UPDATE agent_runs SET usage_json=?,updated_at=? WHERE id=?').run(serialized, stamp, runId);
    return { runId, usage: freeze(usage), overBudget: usage.totalTokens + usage.reservedInputTokens + usage.reservedOutputTokens > owner.maximum
      || integer(owner.maximumOutput, 1) && usage.outputTokens + usage.reservedOutputTokens > owner.maximumOutput, changed };
  }
  function notify(result) {
    if (result.changed) {
      try { const pending = onUsage(result.runId, result.usage); pending?.catch?.(() => {}); }
      catch { /* Accounting is already durable; an observer cannot refund it. */ }
    }
    return { usage: result.usage, overBudget: result.overBudget };
  }
  function ticketRow(ticket, kind) {
    const identity = ticket && typeof ticket === 'object' ? tickets.get(ticket) : undefined;
    if (!identity) fail('auxiliary_ticket_invalid', 'An original private auxiliary ticket is required');
    if (kind && kind !== identity.kind) fail('auxiliary_ticket_invalid', 'This private ticket belongs to a different AI operation');
    const table = TABLES[identity.kind], row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(identity.id);
    if (!row || row.run_id !== identity.runId || row.call_id !== identity.callId || row.kind !== identity.kind) {
      fail('auxiliary_ticket_invalid', 'Auxiliary ticket ownership does not match its durable record');
    }
    return { ...row, table };
  }

  // A previous process cannot prove that its accepted requests never ran.
  const recovered = transaction(db, () => {
    const rows = db.prepare("SELECT run_id FROM agent_auxiliary_inputs WHERE status='reserved' UNION SELECT run_id FROM agent_auxiliary_generations WHERE status='reserved'").all();
    if (!rows.length) return [];
    const stamp = time(); db.prepare("UPDATE agent_auxiliary_inputs SET status='unknown',updated_at=? WHERE status='reserved'").run(stamp);
    db.prepare("UPDATE agent_auxiliary_generations SET status='unknown',updated_at=? WHERE status='reserved'").run(stamp);
    return rows.map(row => ({ ...refresh(row.run_id, stamp), changed: true }));
  });
  recovered.forEach(notify);

  function reserve(input) {
    if (!exact(input, ['runId', 'callId', 'estimatedInputTokens', 'kind']) || !identifier(input.runId) || !identifier(input.callId)
      || input.kind !== 'embedding' || !integer(input.estimatedInputTokens, 1, MAX_INPUT)) {
      fail('invalid_auxiliary_input', 'Embedding reservation requires bounded run/call IDs and a positive safe input estimate');
    }
    return reserveOwned(input);
  }
  function reserveGeneration(input) {
    if (!exact(input, ['runId', 'callId', 'estimatedInputTokens', 'maxOutputTokens', 'kind']) || !identifier(input.runId) || !identifier(input.callId)
      || input.kind !== 'vision' || !integer(input.estimatedInputTokens, 1, MAX_INPUT) || !integer(input.maxOutputTokens, 1, MAX_INPUT)) {
      fail('invalid_auxiliary_input', 'Vision reservation requires bounded input/output estimates and exact run/call identity');
    }
    return reserveOwned(input);
  }
  function reserveOwned(input) {
    const id = randomUUID(), generation = input.kind === 'vision';
    const result = transaction(db, () => {
      const stamp = time(), owner = run(input.runId);
      if (!ACTIVE.has(owner.row.status)) fail('run_inactive', 'Auxiliary input requires an active run');
      if (!integer(owner.row.deadline_at) || stamp >= owner.row.deadline_at) fail('budget_duration', 'Run deadline expired before auxiliary dispatch');
      const live = assertLiveCall(input.runId, input.callId);
      // An asynchronous authority check cannot authorize this synchronous
      // transaction. Consume its rejection without allowing a later grant.
      if (live && typeof live.then === 'function') Promise.resolve(live).catch(() => {});
      if (live !== undefined && live !== true) fail('auxiliary_call_inactive', 'Auxiliary input requires a live synchronous native call');
      // Synchronize known totals and holds before testing this new reservation.
      const current = refresh(input.runId, stamp);
      if (generation && (!integer(owner.maximumInput, 1) || !integer(owner.maximumOutput, 1))) fail('auxiliary_usage_invalid', 'Generation requires explicit per-request input and cumulative output budgets');
      if (generation && input.estimatedInputTokens > owner.maximumInput) fail('budget_context', 'Auxiliary generation input exceeds maxInputTokens');
      const required = current.usage.totalTokens + current.usage.reservedInputTokens + current.usage.reservedOutputTokens
        + input.estimatedInputTokens + (generation ? input.maxOutputTokens : 0);
      const outputRequired = current.usage.outputTokens + current.usage.reservedOutputTokens + (generation ? input.maxOutputTokens : 0);
      if (!integer(required) || required > owner.maximum || current.overBudget
        || generation && outputRequired > owner.maximumOutput) fail('budget_tokens', 'Auxiliary work exceeds remaining total or output token budget');
      if (generation) db.prepare(`INSERT INTO agent_auxiliary_generations
        (id,run_id,call_id,kind,estimated_input_tokens,max_output_tokens,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'reserved',?,?)`)
        .run(id, input.runId, input.callId, input.kind, input.estimatedInputTokens, input.maxOutputTokens, stamp, stamp);
      else db.prepare(`INSERT INTO agent_auxiliary_inputs
        (id,run_id,call_id,kind,estimated_input_tokens,status,created_at,updated_at) VALUES(?,?,?,?,?,'reserved',?,?)`)
        .run(id, input.runId, input.callId, input.kind, input.estimatedInputTokens, stamp, stamp);
      return { ...refresh(input.runId, stamp), changed: true };
    });
    const ticket = Object.freeze({}); tickets.set(ticket, Object.freeze({ id, runId: input.runId, callId: input.callId, kind: input.kind }));
    notify(result); return ticket;
  }
  function settle(ticket, actualInputTokens) {
    if (!integer(actualInputTokens, 0, MAX_INPUT)) fail('invalid_auxiliary_input', 'Actual auxiliary input must be a bounded safe token count');
    const result = transaction(db, () => {
      const row = ticketRow(ticket, 'embedding'), stamp = time();
      if (row.status === 'not_dispatched' || row.status === 'settled' && row.actual_input_tokens !== actualInputTokens) {
        fail('auxiliary_settlement_conflict', 'This ticket cannot be settled with a different dispatch outcome or token count');
      }
      if (row.status !== 'settled') db.prepare("UPDATE agent_auxiliary_inputs SET status='settled',actual_input_tokens=?,updated_at=? WHERE id=?").run(actualInputTokens, stamp, row.id);
      return refresh(row.run_id, stamp);
    });
    return notify(result);
  }
  function settleGeneration(ticket, actual) {
    if (!exact(actual, ['inputTokens', 'outputTokens']) || !integer(actual.inputTokens, 0, MAX_INPUT) || !integer(actual.outputTokens, 0, MAX_INPUT)) {
      fail('invalid_auxiliary_input', 'Actual auxiliary generation requires bounded exact input/output token counts');
    }
    return recordGeneration(ticket, actual);
  }
  function partialGeneration(ticket, actual) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(actual).length < 1
      || Object.keys(actual).some(key => !['inputTokens', 'outputTokens'].includes(key))
      || Object.entries(actual).some(([, value]) => !integer(value, 0, MAX_INPUT))) {
      fail('invalid_auxiliary_input', 'Partial generation usage requires at least one bounded actual input/output count');
    }
    return recordGeneration(ticket, actual);
  }
  function recordGeneration(ticket, actual) {
    const result = transaction(db, () => {
      const row = ticketRow(ticket, 'vision'), stamp = time();
      const hasInput = Object.hasOwn(actual, 'inputTokens'), hasOutput = Object.hasOwn(actual, 'outputTokens');
      if (row.status === 'not_dispatched'
        || hasInput && row.actual_input_tokens !== null && row.actual_input_tokens !== actual.inputTokens
        || hasOutput && row.actual_output_tokens !== null && row.actual_output_tokens !== actual.outputTokens) {
        fail('auxiliary_settlement_conflict', 'This generation ticket already has a different outcome or actual usage');
      }
      const input = hasInput ? actual.inputTokens : row.actual_input_tokens, output = hasOutput ? actual.outputTokens : row.actual_output_tokens;
      const status = input !== null && output !== null ? 'settled' : 'unknown';
      if (row.status !== status || row.actual_input_tokens !== input || row.actual_output_tokens !== output) {
        db.prepare('UPDATE agent_auxiliary_generations SET status=?,actual_input_tokens=?,actual_output_tokens=?,updated_at=? WHERE id=?')
          .run(status, input, output, stamp, row.id);
      }
      return refresh(row.run_id, stamp);
    });
    return notify(result);
  }
  function notDispatched(ticket) {
    const result = transaction(db, () => {
      const row = ticketRow(ticket), stamp = time();
      if (!['reserved', 'not_dispatched'].includes(row.status)) fail('auxiliary_dispatch_unknown', 'Only an original reservation proven never dispatched can be released');
      if (row.status === 'reserved') db.prepare(`UPDATE ${row.table} SET status='not_dispatched',updated_at=? WHERE id=?`).run(stamp, row.id);
      return refresh(row.run_id, stamp);
    });
    return notify(result);
  }
  function unknown(ticket) {
    const result = transaction(db, () => {
      const row = ticketRow(ticket), stamp = time();
      const changed = row.status === 'reserved';
      if (changed) db.prepare(`UPDATE ${row.table} SET status='unknown',updated_at=? WHERE id=?`).run(stamp, row.id);
      return { ...refresh(row.run_id, stamp), ...(changed ? { changed: true } : {}) };
    });
    return notify(result);
  }
  return Object.freeze({ reserve, settle, reserveGeneration, settleGeneration, partialGeneration, notDispatched, unknown });
}
