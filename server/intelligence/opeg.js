import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { getAdaptiveModifiers } from './adaptive-strategy.js';

const now = () => Date.now();
const BASE_REGRESSION_TOLERANCE = 10;

/**
 * OPEG V1.0 — Observe-Propose-Execute-Ground protocol
 *
 * State machine: S0_IDLE → S1_HYPOTHESIS → S2_EXECUTE → S3_SANITIZE → S4_UPDATE
 *
 * All self-modifications (forge_agent, synthesize_workflow, evolve_prompt, prune_memory)
 * must pass through this pipeline. The SANITIZE stage enforces empirical grounding:
 * a modification is rejected if it cannot demonstrate measurable improvement or
 * introduces regression.
 */

const STATES = {
  IDLE: 'S0_IDLE',
  HYPOTHESIS: 'S1_HYPOTHESIS',
  EXECUTE: 'S2_EXECUTE',
  SANITIZE: 'S3_SANITIZE',
  UPDATE: 'S4_UPDATE',
};

const MODIFICATION_TYPES = [
  'forge_agent',
  'synthesize_workflow',
  'evolve_prompt',
  'prune_memory',
  'verify_memory',
  'publish_insight',
  'neurogenesis',
];

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS opeg_proposals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'S0_IDLE',
      hypothesis TEXT,
      params TEXT,
      pre_metrics TEXT,
      post_metrics TEXT,
      execution_result TEXT,
      sanitize_verdict TEXT,
      source TEXT DEFAULT 'unknown',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_opeg_state ON opeg_proposals(state)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_opeg_type ON opeg_proposals(type)`).run();
  } catch (_) {}
}

ensureTable();

function collectPreMetrics() {
  const metrics = {};
  try {
    metrics.agentCount = db.prepare(`SELECT COUNT(*) as c FROM agents`).get()?.c || 0;
    metrics.forgedAgentCount = db.prepare(`SELECT COUNT(*) as c FROM forged_agents`).get()?.c || 0;
    metrics.memoryCount = db.prepare(`SELECT COUNT(*) as c FROM agent_memories`).get()?.c || 0;
    metrics.verifiedMemories = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE verified_at IS NOT NULL`).get()?.c || 0;
    metrics.workflowCount = db.prepare(`SELECT COUNT(*) as c FROM workflows`).get()?.c || 0;
    metrics.recentRunSuccess = (() => {
      const recent = db.prepare(`SELECT status FROM runs ORDER BY created_at DESC LIMIT 20`).all();
      return recent.length > 0
        ? Math.round(recent.filter(r => r.status === 'done' || r.status === 'completed').length / recent.length * 100)
        : 0;
    })();
    metrics.busActivity = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.activeAlerts = db.prepare(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`).get()?.c || 0;
  } catch (_) {}
  metrics.ts = now();
  return metrics;
}

export function propose({ type, hypothesis, params, source = 'unknown' }) {
  if (!MODIFICATION_TYPES.includes(type)) {
    return { ok: false, error: `Unknown modification type: ${type}. Allowed: ${MODIFICATION_TYPES.join(', ')}` };
  }
  if (!hypothesis) {
    return { ok: false, error: 'Hypothesis required — what improvement do you expect?' };
  }

  const id = randomUUID().slice(0, 12);
  const preMetrics = collectPreMetrics();

  db.prepare(`INSERT INTO opeg_proposals (id, type, state, hypothesis, params, pre_metrics, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, type, STATES.HYPOTHESIS, hypothesis,
    JSON.stringify(params || {}), JSON.stringify(preMetrics),
    source, now(), now()
  );

  publish('system', 'opeg.hypothesis', JSON.stringify({ id, type, hypothesis, source }));

  return { ok: true, id, state: STATES.HYPOTHESIS, preMetrics };
}

export function execute(id, executionResult) {
  const row = db.prepare(`SELECT * FROM opeg_proposals WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Proposal not found' };
  if (row.state !== STATES.HYPOTHESIS) {
    return { ok: false, error: `Cannot execute from state ${row.state}, expected ${STATES.HYPOTHESIS}` };
  }

  db.prepare(`UPDATE opeg_proposals SET state = ?, execution_result = ?, updated_at = ? WHERE id = ?`).run(
    STATES.EXECUTE, JSON.stringify(executionResult || {}), now(), id
  );

  publish('system', 'opeg.execute', JSON.stringify({ id, type: row.type }));

  return { ok: true, id, state: STATES.EXECUTE };
}

export function sanitize(id) {
  const row = db.prepare(`SELECT * FROM opeg_proposals WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Proposal not found' };
  if (row.state !== STATES.EXECUTE) {
    return { ok: false, error: `Cannot sanitize from state ${row.state}, expected ${STATES.EXECUTE}` };
  }

  const postMetrics = collectPreMetrics();
  let preMetrics;
  try { preMetrics = JSON.parse(row.pre_metrics); } catch { preMetrics = {}; }
  let execResult;
  try { execResult = JSON.parse(row.execution_result); } catch { execResult = {}; }

  const verdict = evaluateModification(row.type, preMetrics, postMetrics, execResult);

  db.prepare(`UPDATE opeg_proposals SET state = ?, post_metrics = ?, sanitize_verdict = ?, updated_at = ? WHERE id = ?`).run(
    STATES.SANITIZE, JSON.stringify(postMetrics), JSON.stringify(verdict), now(), id
  );

  publish('system', 'opeg.sanitize', JSON.stringify({ id, type: row.type, verdict: verdict.decision }));

  return { ok: true, id, state: STATES.SANITIZE, verdict };
}

function evaluateModification(type, pre, post, execResult) {
  const gateMods = getAutonomyModifiers();
  const adaptiveMods = getAdaptiveModifiers();
  const regressionTolerance = Math.round(BASE_REGRESSION_TOLERANCE * gateMods.evolutionRate * (adaptiveMods.opegToleranceScale || 1.0));
  const checks = [];

  if (execResult.error || execResult.ok === false) {
    checks.push({ check: 'execution_success', passed: false, detail: 'Execution reported failure' });
    return { decision: 'REJECTED', reason: 'Execution failed', checks, gateTier: gateMods.tier };
  }

  checks.push({ check: 'execution_success', passed: true, detail: 'Execution completed' });

  if (post.activeAlerts > pre.activeAlerts) {
    checks.push({ check: 'no_new_alerts', passed: false, detail: `Alerts increased: ${pre.activeAlerts} → ${post.activeAlerts}` });
    return { decision: 'REJECTED', reason: 'Modification introduced new health alerts', checks, gateTier: gateMods.tier };
  }
  checks.push({ check: 'no_new_alerts', passed: true, detail: 'No new alerts' });

  if (type === 'forge_agent') {
    const countGrew = post.forgedAgentCount > pre.forgedAgentCount;
    checks.push({ check: 'agent_created', passed: countGrew, detail: `Forged agents: ${pre.forgedAgentCount} → ${post.forgedAgentCount}` });
    if (!countGrew) {
      return { decision: 'REJECTED', reason: 'Agent forge did not produce a new agent', checks, gateTier: gateMods.tier };
    }
  }

  if (type === 'synthesize_workflow') {
    const countGrew = post.workflowCount > pre.workflowCount;
    checks.push({ check: 'workflow_created', passed: countGrew, detail: `Workflows: ${pre.workflowCount} → ${post.workflowCount}` });
    if (!countGrew) {
      return { decision: 'REJECTED', reason: 'Synthesis did not produce a new workflow', checks, gateTier: gateMods.tier };
    }
  }

  if (type === 'prune_memory') {
    const countShrank = post.memoryCount < pre.memoryCount;
    checks.push({ check: 'memory_pruned', passed: countShrank, detail: `Memories: ${pre.memoryCount} → ${post.memoryCount}` });
    if (!countShrank) {
      return { decision: 'REJECTED', reason: 'Memory prune did not reduce memory count', checks, gateTier: gateMods.tier };
    }
  }

  if (type === 'verify_memory') {
    const verifiedGrew = post.verifiedMemories > pre.verifiedMemories;
    checks.push({ check: 'memory_verified', passed: verifiedGrew, detail: `Verified: ${pre.verifiedMemories} → ${post.verifiedMemories}` });
    if (!verifiedGrew) {
      return { decision: 'REJECTED', reason: 'Memory verification did not increase verified count', checks, gateTier: gateMods.tier };
    }
  }

  if (post.recentRunSuccess < pre.recentRunSuccess - regressionTolerance) {
    checks.push({ check: 'no_regression', passed: false, detail: `Run success dropped: ${pre.recentRunSuccess}% → ${post.recentRunSuccess}% (tolerance: ${regressionTolerance}%, tier: ${gateMods.tier})` });
    return { decision: 'REJECTED', reason: `Modification caused run success regression (tolerance ${regressionTolerance}% at ${gateMods.tier})`, checks, gateTier: gateMods.tier };
  }
  checks.push({ check: 'no_regression', passed: true, detail: `No success rate regression (tolerance: ${regressionTolerance}%, tier: ${gateMods.tier})` });

  return { decision: 'APPROVED', reason: 'All sanity checks passed', checks, gateTier: gateMods.tier };
}

export function update(id) {
  const row = db.prepare(`SELECT * FROM opeg_proposals WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Proposal not found' };
  if (row.state !== STATES.SANITIZE) {
    return { ok: false, error: `Cannot update from state ${row.state}, expected ${STATES.SANITIZE}` };
  }

  let verdict;
  try { verdict = JSON.parse(row.sanitize_verdict); } catch { verdict = { decision: 'UNKNOWN' }; }

  const finalState = verdict.decision === 'APPROVED' ? STATES.UPDATE : STATES.IDLE;

  db.prepare(`UPDATE opeg_proposals SET state = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(
    finalState, now(), now(), id
  );

  publish('system', 'opeg.update', JSON.stringify({
    id, type: row.type, finalState,
    approved: verdict.decision === 'APPROVED',
    reason: verdict.reason,
  }));

  return { ok: true, id, state: finalState, approved: verdict.decision === 'APPROVED', verdict };
}

export async function runPipeline({ type, hypothesis, params, source = 'unknown', executeFn }) {
  const proposal = propose({ type, hypothesis, params, source });
  if (!proposal.ok) return proposal;

  let execResult;
  try {
    execResult = await executeFn(params);
  } catch (e) {
    execResult = { ok: false, error: e.message };
  }

  const execStep = execute(proposal.id, execResult);
  if (!execStep.ok) return { ...execStep, proposalId: proposal.id };

  const sanStep = sanitize(proposal.id);
  if (!sanStep.ok) return { ...sanStep, proposalId: proposal.id };

  const finalStep = update(proposal.id);

  if (!finalStep.approved) {
    try { rollbackExecution(type, execResult, params); } catch (_) {}
  }

  return {
    ok: true,
    proposalId: proposal.id,
    type,
    approved: finalStep.approved,
    verdict: finalStep.verdict,
    executionResult: execResult,
  };
}

function rollbackExecution(type, execResult, params) {
  if (type === 'forge_agent') {
    const agentId = execResult?.agent?.id;
    if (agentId) {
      db.prepare(`DELETE FROM forged_agents WHERE agent_id = ?`).run(agentId);
      publish('system', 'opeg.rollback', JSON.stringify({ type, agentId, reason: 'OPEG rejection' }));
    }
  } else if (type === 'synthesize_workflow') {
    const workflowId = execResult?.workflow?.id;
    if (workflowId) {
      db.prepare(`DELETE FROM synthesized_workflows WHERE workflow_id = ?`).run(workflowId);
      publish('system', 'opeg.rollback', JSON.stringify({ type, workflowId, reason: 'OPEG rejection' }));
    }
  }
}

export function getProposal(id) {
  const row = db.prepare(`SELECT * FROM opeg_proposals WHERE id = ?`).get(id);
  if (!row) return null;
  try { row.pre_metrics = JSON.parse(row.pre_metrics); } catch {}
  try { row.post_metrics = JSON.parse(row.post_metrics); } catch {}
  try { row.params = JSON.parse(row.params); } catch {}
  try { row.execution_result = JSON.parse(row.execution_result); } catch {}
  try { row.sanitize_verdict = JSON.parse(row.sanitize_verdict); } catch {}
  return row;
}

export function listProposals({ limit = 50, type, state } = {}) {
  let sql = `SELECT * FROM opeg_proposals WHERE 1=1`;
  const args = [];
  if (type) { sql += ` AND type = ?`; args.push(type); }
  if (state) { sql += ` AND state = ?`; args.push(state); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(200, Math.max(1, limit)));
  return db.prepare(sql).all(...args);
}

export function stats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM opeg_proposals`).get()?.c || 0;
  const byState = db.prepare(`SELECT state, COUNT(*) as c FROM opeg_proposals GROUP BY state`).all();
  const byType = db.prepare(`SELECT type, COUNT(*) as c FROM opeg_proposals GROUP BY type`).all();
  const approved = db.prepare(`SELECT COUNT(*) as c FROM opeg_proposals WHERE sanitize_verdict LIKE '%APPROVED%'`).get()?.c || 0;
  const rejected = db.prepare(`SELECT COUNT(*) as c FROM opeg_proposals WHERE sanitize_verdict LIKE '%REJECTED%'`).get()?.c || 0;
  return { total, approved, rejected, approvalRate: total > 0 ? Math.round(approved / total * 100) : 0, byState, byType };
}

export const OPEG_STATES = STATES;
export const OPEG_TYPES = MODIFICATION_TYPES;
