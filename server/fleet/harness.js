import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';

const sha256 = (data) => createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data, null, 0)).digest('hex');
const sha8 = (data) => sha256(data).slice(0, 8);
const now = () => Date.now();

// ── Anti-Invention Evidence System ──────────────────────────────────────
// Every tool result carries a sha256 evidence hash proving the harness executed it.
// The model cannot fabricate results because every fact is harness-measured.

export function sealToolResult(toolName, args, result, durationMs) {
  const resultStr = JSON.stringify(result, null, 0);
  const evidencePayload = { tool: toolName, args_hash: sha8(JSON.stringify(args)), result_hash: sha256(resultStr), bytes: resultStr.length, ts: now() };
  if (durationMs !== undefined) evidencePayload.duration_ms = durationMs;
  evidencePayload.evidence_sha = sha256(JSON.stringify(evidencePayload));
  return {
    result,
    evidence: {
      executed: true,
      sha256: evidencePayload.result_hash,
      sha8: evidencePayload.result_hash.slice(0, 8),
      evidence_sha: evidencePayload.evidence_sha,
      tool: toolName,
      duration_ms: durationMs,
    },
  };
}

export function sealRefusal(toolName, reason) {
  return {
    result: null,
    evidence: {
      executed: false,
      refused: reason,
      tool: toolName,
      evidence_sha: sha256(JSON.stringify({ refused: reason, tool: toolName, ts: now() })),
    },
  };
}

// ── Strix Budget Laws ───────────────────────────────────────────────────
// Law 3: Budget Phases + Reserve
// Warning bands fire ONCE as the budget crosses each threshold.
// Past the reserve fraction, reads are refused — last portion is for the report.

const DEFAULT_BUDGET_WARNS = [0.60, 0.75, 0.85];
const DEFAULT_RESERVE = 0.85;

export function budgetBands(step, maxSteps, firedSet = new Set()) {
  const frac = (step - 1) / Math.max(maxSteps, 1);
  const firedNow = DEFAULT_BUDGET_WARNS.filter(w => frac >= w && !firedSet.has(w));
  const inReserve = frac >= DEFAULT_RESERVE;
  const newFired = new Set([...firedSet, ...firedNow]);
  return { firedNow, inReserve, newFired };
}

export function bandDirective(bandPct) {
  if (bandPct === 0.60) return '[HARNESS] Budget band 60%: past half budget — start converging toward output.';
  if (bandPct === 0.75) return '[HARNESS] Budget band 75%: produce your output THIS step if you have not yet.';
  if (bandPct === 0.85) return '[HARNESS] Budget band 85%: reserve in force — reads refuse from now; produce output or finish with summary.';
  return null;
}

// ── Law 2: Salvage on Crash ─────────────────────────────────────────────
// Partial history persisted before death so the revived agent loses nothing.

export function salvageOnCrash(runId, agentId, error, steps, threadId) {
  try {
    const payload = {
      run_id: runId,
      agent_id: agentId,
      thread_id: threadId,
      error_class: error?.constructor?.name || 'Error',
      error_message: String(error?.message || error).slice(0, 500),
      steps_completed: steps,
      salvaged_at: new Date().toISOString(),
      law: 'salvage-on-crash: revived agent loses nothing (strix execution.py:199)',
    };
    db.prepare(`INSERT INTO harness_salvage (id, run_id, agent_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), runId, agentId, JSON.stringify(payload), now());
    return payload;
  } catch (e) {
    console.error('harness: salvage write failed:', e.message);
    return null;
  }
}

// ── Law 4: Bounded Outputs + Spill ──────────────────────────────────────
// Oversized tool results get head+tail; full text referenced by sha256.

const BOUND_MAX_CHARS = 4000;
const BOUND_MAX_LINES = 48;

export function boundResult(text, name) {
  if (typeof text !== 'string') text = JSON.stringify(text, null, 2);
  const lines = text.split('\n');

  if (lines.length <= BOUND_MAX_LINES && text.length <= BOUND_MAX_CHARS) {
    return { bounded: text, spilled: false };
  }

  const headCount = Math.floor(BOUND_MAX_LINES / 2);
  const tailCount = BOUND_MAX_LINES - headCount - 1;
  const head = lines.slice(0, headCount);
  const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
  const omitted = lines.length - head.length - tail.length;

  const bounded = [
    `[${name}] ${lines.length} lines -> head ${head.length}/tail ${tail.length}, ${omitted} omitted`,
    ...head,
    `... ${omitted} lines omitted (full result: ${text.length} chars, sha256: ${sha8(text)}) ...`,
    ...tail,
  ].join('\n');

  return { bounded, spilled: true, fullLength: text.length, fullHash: sha256(text) };
}

// ── Permission Scoping ──────────────────────────────────────────────────
// Per-agent tool access control. Each agent manifest can declare:
//   permissions: { allow: [...], deny: [...] }
// The harness checks before execution.

export function checkPermission(agent, toolName) {
  const perms = agent.permissions;
  if (!perms) return { allowed: true };

  if (perms.deny && Array.isArray(perms.deny)) {
    const denied = perms.deny.some(p =>
      p === toolName || (p.endsWith('*') && toolName.startsWith(p.slice(0, -1)))
    );
    if (denied) return { allowed: false, reason: `tool '${toolName}' denied by agent permissions` };
  }

  if (perms.allow && Array.isArray(perms.allow)) {
    const allowed = perms.allow.some(p =>
      p === '*' || p === toolName || (p.endsWith('*') && toolName.startsWith(p.slice(0, -1)))
    );
    if (!allowed) return { allowed: false, reason: `tool '${toolName}' not in agent allow list` };
  }

  return { allowed: true };
}

// ── Chain Verification ──────────────────────────────────────────────────
// Verify the integrity of a hash-chained JSONL ledger file.

export function verifyChain(entries) {
  const GENESIS = '0'.repeat(64);
  let prevHash = GENESIS;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.prev_hash !== prevHash) {
      return { ok: false, n: i, broken_at: i, reason: 'prev_hash mismatch' };
    }
    const payload = { ts: entry.ts, type: entry.type, data: entry.data };
    const expectedHash = sha256(prevHash + JSON.stringify(payload, null, 0));
    if (entry.self_hash && entry.self_hash !== expectedHash) {
      return { ok: false, n: i, broken_at: i, reason: 'self_hash mismatch' };
    }
    prevHash = entry.self_hash || expectedHash;
  }

  return { ok: true, n: entries.length, broken_at: null };
}

// ── Harness Run Envelope ────────────────────────────────────────────────
// Wraps the entire run with harness metadata for audit.

export function createRunEnvelope(runId, agentId, task) {
  return {
    run_id: runId,
    agent_id: agentId,
    task_hash: sha8(task),
    started_at: new Date().toISOString(),
    harness_version: '1.0.0',
    anti_invention: 'every tool result harness-measured',
    steps: [],
    budget: { fired: new Set(), inReserve: false },
  };
}

export function recordStep(envelope, step, toolName, args, sealed) {
  envelope.steps.push({
    step,
    tool: toolName,
    args_hash: sha8(JSON.stringify(args)),
    evidence: sealed.evidence,
    ts: now(),
  });
}
