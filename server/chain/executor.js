/**
 * Chain-to-Code Bridge — takes verified chain findings and feeds them
 * through the Generator-Verifier-Executor loop to produce proven code.
 *
 * Closes the analysis→code loop: Chain runs analysis → verified steps
 * feed into verifier-loop → proven code becomes fossils → daemon injects
 * fossils into agent prompts.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { loadRun } from './engine.js';
import { ledgerStats } from './ledger.js';
import { runVerifierLoop } from '../intelligence/verifier-loop.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();

function extractExecutableSteps(run) {
  if (!run?.ledger) return [];

  const steps = (run.ledger.implementation_steps || [])
    .filter(e => e.verified)
    .map(e => ({ ...e, source: 'implementation_steps' }));

  const testCases = (run.ledger.test_cases || [])
    .filter(e => e.verified)
    .map(e => ({ ...e, source: 'test_cases' }));

  return steps.map(step => {
    const related = testCases.filter(t =>
      t.text.toLowerCase().includes(step.text.slice(0, 40).toLowerCase()) ||
      step.text.toLowerCase().includes(t.text.slice(0, 40).toLowerCase())
    );
    return {
      text: step.text,
      stage: step.stage,
      tests: related.map(t => t.text),
    };
  });
}

function buildGoal(step, objective) {
  let goal = step.text;
  if (step.tests.length > 0) {
    goal += '\n\nAcceptance criteria (from chain analysis):\n' +
      step.tests.map((t, i) => `${i + 1}. ${t}`).join('\n');
  }
  return goal;
}

export async function executeChainToCode(chainRunId, config = {}, { broadcast = () => {} } = {}) {
  const run = typeof chainRunId === 'string' ? loadRun(chainRunId) : chainRunId;
  if (!run) throw new Error(`Chain run not found: ${chainRunId}`);
  if (run.status !== 'completed') throw new Error(`Chain run ${run.id} is ${run.status}, not completed`);

  const stats = ledgerStats(run.ledger);
  const steps = extractExecutableSteps(run);

  if (steps.length === 0) {
    return {
      chainRunId: run.id,
      status: 'no_steps',
      message: 'No verified implementation steps found in chain ledger',
      stats,
    };
  }

  const execId = 'cexec_' + randomUUID().replace(/-/g, '').slice(0, 10);
  const maxSteps = Math.min(steps.length, config.maxSteps || 5);
  const language = config.language || 'javascript';

  const results = [];
  let passed = 0;
  let failed = 0;
  const t0 = now();

  broadcast('chain', {
    type: 'chain.exec_started',
    execId,
    chainRunId: run.id,
    objective: run.objective,
    totalSteps: maxSteps,
  });

  for (let i = 0; i < maxSteps; i++) {
    const step = steps[i];
    const goal = buildGoal(step, run.objective);

    broadcast('chain', {
      type: 'chain.exec_step',
      execId,
      step: i + 1,
      total: maxSteps,
      goal: goal.slice(0, 200),
    });

    try {
      const context = `This code is part of a larger system analyzed by a Logic Chain.\n` +
        `Original objective: ${run.objective.slice(0, 500)}\n` +
        `This step was verified by ${run.review?.stats?.verified || 0} reviewers.`;

      const loopResult = await runVerifierLoop(goal, {
        language,
        maxIterations: config.maxIterations || 3,
        context,
        triggeredBy: `chain:${run.id}`,
      });

      results.push({
        step: i + 1,
        goal: step.text.slice(0, 200),
        loopId: loopResult.loopId,
        status: loopResult.status,
        iterations: loopResult.iterations,
        hasCode: !!loopResult.code,
      });

      if (loopResult.status === 'passed') passed++;
      else failed++;

      broadcast('chain', {
        type: 'chain.exec_step_done',
        execId,
        step: i + 1,
        loopId: loopResult.loopId,
        status: loopResult.status,
      });
    } catch (err) {
      results.push({
        step: i + 1,
        goal: step.text.slice(0, 200),
        status: 'error',
        error: err.message.slice(0, 300),
      });
      failed++;
    }
  }

  const durationMs = now() - t0;
  const status = passed > 0 ? (failed === 0 ? 'all_passed' : 'partial') : 'none_passed';

  const record = {
    id: execId,
    chain_run_id: run.id,
    objective: run.objective,
    status,
    steps_total: maxSteps,
    steps_passed: passed,
    steps_failed: failed,
    results: JSON.stringify(results),
    language,
    duration_ms: durationMs,
    created_at: t0,
  };

  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS chain_executions (
      id TEXT PRIMARY KEY,
      chain_run_id TEXT NOT NULL,
      objective TEXT,
      status TEXT,
      steps_total INTEGER,
      steps_passed INTEGER,
      steps_failed INTEGER,
      results TEXT,
      language TEXT,
      duration_ms INTEGER,
      created_at INTEGER
    )`).run();

    db.prepare(`INSERT INTO chain_executions (id, chain_run_id, objective, status, steps_total, steps_passed, steps_failed, results, language, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.chain_run_id, record.objective, record.status,
      record.steps_total, record.steps_passed, record.steps_failed,
      record.results, record.language, record.duration_ms, record.created_at
    );
  } catch (_) {}

  try {
    publish('system', 'system.evolution', JSON.stringify({
      action: 'chain_to_code',
      execId,
      chainRunId: run.id,
      status,
      passed,
      failed,
      durationMs,
      at: t0,
    }));
  } catch (_) {}

  broadcast('chain', {
    type: 'chain.exec_completed',
    execId,
    chainRunId: run.id,
    status,
    passed,
    failed,
    durationMs,
  });

  return {
    execId,
    chainRunId: run.id,
    objective: run.objective,
    status,
    passed,
    failed,
    total: maxSteps,
    results,
    durationMs,
  };
}

export function getExecution(id) {
  try {
    const row = db.prepare('SELECT * FROM chain_executions WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, results: JSON.parse(row.results || '[]') };
  } catch (_) { return null; }
}

export function listExecutions(chainRunId, limit = 20) {
  try {
    const q = chainRunId
      ? db.prepare('SELECT * FROM chain_executions WHERE chain_run_id = ? ORDER BY created_at DESC LIMIT ?')
      : db.prepare('SELECT * FROM chain_executions ORDER BY created_at DESC LIMIT ?');
    const rows = chainRunId ? q.all(chainRunId, limit) : q.all(limit);
    return rows.map(r => ({ ...r, results: JSON.parse(r.results || '[]') }));
  } catch (_) { return []; }
}
