/**
 * Goal Executor — Phase P: the cognition → action link.
 *
 * The goal engine proposed 3,013 objectives and nothing ever ran one; every
 * proposal stayed 'proposed' forever. This module drains the queue: pick the next
 * proposal, choose the fleet agent whose role fits it best, run that agent to
 * completion, and record the outcome where the rest of the organism can see it —
 * goal_proposals.status, a goal_executions row, an 'outcome' memory for the system
 * and for the agent, and a bus event. Metacognition already scores from the runs
 * table, so every executed goal moves the effectiveness it reasons about.
 *
 * One goal in flight at a time. Skips when the resource envelope says the system
 * is constrained or the adaptive strategy suppresses goal-seeking.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { runAgentAndWait, listAgents } from '../fleet/runtime.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { isResourceConstrained, getResourcePressure } from './resource-envelope.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { isActionSuppressed } from './adaptive-strategy.js';
import { scoreOutcome, installOutcomeScorerRoutes } from './outcome-scorer.js';
import { recordOutcome, getCurrentSession } from './perspective.js';

const now = () => Date.now();

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const RUN_TIMEOUT_MS = 240_000;
const PROPOSAL_MAX_AGE_MS = 48 * 3600_000;
const DEFAULT_AGENT = process.env.GOAL_EXECUTOR_AGENT || 'fraymus_prime';
const MAX_RETRIES = 2;
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const COMPLEXITY_RANK = { simple: 0, moderate: 1, complex: 2 };

let timer = null;
let inFlight = null;
let lastCycle = null;

function ensureSchema() {
  db.prepare(`CREATE TABLE IF NOT EXISTS goal_executions (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    agent_id TEXT,
    run_id TEXT,
    thread_id TEXT,
    status TEXT NOT NULL,
    trigger TEXT,
    gate_tier TEXT,
    pressure REAL,
    reply_excerpt TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_goal_exec_goal ON goal_executions(goal_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_goal_exec_started ON goal_executions(started_at)`).run();
}
ensureSchema();

export function expireStaleProposals(maxAgeMs = PROPOSAL_MAX_AGE_MS) {
  const info = db.prepare(
    `UPDATE goal_proposals SET status = 'expired', acted_at = ? WHERE status = 'proposed' AND created_at < ?`
  ).run(now(), now() - maxAgeMs);
  return info.changes;
}

export function pickNextGoal() {
  const rows = db.prepare(
    `SELECT * FROM goal_proposals WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 200`
  ).all();
  if (!rows.length) return null;
  rows.sort((a, b) =>
    (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1) ||
    (COMPLEXITY_RANK[a.complexity] ?? 1) - (COMPLEXITY_RANK[b.complexity] ?? 1) ||
    b.created_at - a.created_at);
  return rows[0];
}

const tokenize = s => new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []);

export function selectAgent(goal) {
  const agents = listAgents('local').filter(a => a?.id);
  if (!agents.length) throw new Error('no fleet agents available');
  const goalTokens = tokenize(`${goal.objective} ${goal.rationale || ''}`);
  let best = null, bestScore = -1;
  for (const a of agents) {
    const agentTokens = tokenize(`${a.name} ${a.role || ''} ${a.description || ''}`);
    let score = 0;
    for (const t of goalTokens) if (agentTokens.has(t)) score++;
    if (a.source === 'default') score += 0.5; // hand-written manifests over forged ones on ties
    if (score > bestScore) { bestScore = score; best = a; }
  }
  if (bestScore < 1) {
    const fallback = agents.find(a => a.id === DEFAULT_AGENT) || agents.find(a => a.source === 'default') || agents[0];
    return { agent: fallback, score: 0, reason: 'default' };
  }
  return { agent: best, score: bestScore, reason: 'keyword_match' };
}

function buildTask(goal, framing) {
  return [
    `Autonomous objective (${goal.priority} priority, ${goal.complexity} complexity):`,
    goal.objective,
    goal.rationale ? `\nWhy it matters: ${goal.rationale}` : '',
    goal.builds_on ? `Builds on: ${goal.builds_on}` : '',
    framing ? `\nApproach (Perspective engine): ${framing}` : '',
    '\nProduce a concrete result: findings, a decision, or an artifact. Be specific and verifiable.',
    'Store the key finding with agent_remember so the system keeps it. If the objective is not actionable as stated, say so plainly and state what would make it actionable.',
  ].filter(Boolean).join('\n');
}

function summarize(goal, agentId, res, durationMs) {
  const reply = (res.lastReply || '').replace(/\s+/g, ' ').trim();
  return `Goal "${goal.objective.slice(0, 160)}" executed by ${agentId}: ${res.status} in ${Math.round(durationMs / 1000)}s.` +
    (reply ? ` Result: ${reply.slice(0, 600)}` : '');
}

export async function executeGoal(goal, { trigger = 'manual' } = {}) {
  if (!goal) throw new Error('goal required');
  if (inFlight) return { executed: false, reason: 'in_flight', goalId: inFlight.goalId };

  const { agent, score, reason } = selectAgent(goal);
  const gate = getAutonomyModifiers();
  let pressure = null;
  try { pressure = getResourcePressure()?.pressure ?? null; } catch (_) {}

  const execId = 'gx_' + randomUUID().replace(/-/g, '').slice(0, 10);
  const startedAt = now();
  inFlight = { execId, goalId: goal.id, agentId: agent.id, startedAt };

  db.prepare(`UPDATE goal_proposals SET status = 'executing', acted_at = ? WHERE id = ?`).run(startedAt, goal.id);
  db.prepare(`INSERT INTO goal_executions (id, goal_id, agent_id, status, trigger, gate_tier, pressure, started_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(execId, goal.id, agent.id, trigger, gate.tier, pressure, startedAt);

  try { publish('goal-executor', 'system.goals', JSON.stringify({ action: 'goal_started', goalId: goal.id, agentId: agent.id, agentReason: reason, matchScore: score, trigger, objective: goal.objective.slice(0, 160) })); } catch (_) {}

  // The fleet runtime already runs a Perspective assessment per invocation (its framing
  // lands in the agent's prompt); a second assessment here would just queue another LLM
  // call in front of the agent's first one. We read the framing it chose afterwards.
  let res;
  try {
    res = await runAgentAndWait('local', agent.id, buildTask(goal, null), null, RUN_TIMEOUT_MS);
  } catch (e) {
    res = { status: 'error', error: e.message, lastReply: '' };
  }
  let perspectives = null;
  try {
    const sid = getCurrentSession();
    const row = sid ? db.prepare(`SELECT active_perspectives FROM perspective_sessions WHERE id = ?`).get(sid) : null;
    perspectives = row ? JSON.parse(row.active_perspectives || 'null') : null;
  } catch (_) {}

  const finishedAt = now();
  const durationMs = finishedAt - startedAt;
  const ok = res.status === 'done';

  // A run that never produced a step (Ollama timeout / abort) evaluated nothing: requeue
  // instead of recording a failure, up to MAX_RETRIES per goal.
  let runError = null;
  if (!ok && res.runId) {
    try { runError = db.prepare(`SELECT error, steps FROM runs WHERE id = ?`).get(res.runId); } catch (_) {}
  }
  const timedOut = res.status === 'timeout' || /timeout|aborted/i.test(String(runError?.error || res.error || ''));
  if (!ok && timedOut && (runError?.steps ?? 0) === 0) {
    const priorRetries = db.prepare(`SELECT COUNT(*) as c FROM goal_executions WHERE goal_id = ? AND status = 'retry'`).get(goal.id)?.c || 0;
    if (priorRetries < MAX_RETRIES) {
      db.prepare(`UPDATE goal_proposals SET status = 'proposed', acted_at = ? WHERE id = ?`).run(finishedAt, goal.id);
      db.prepare(`UPDATE goal_executions SET status = 'retry', run_id = ?, thread_id = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`)
        .run(res.runId || null, res.threadId || null, String(runError?.error || res.error || res.status).slice(0, 500), finishedAt, durationMs, execId);
      try { publish('goal-executor', 'system.goals', JSON.stringify({ action: 'goal_retry', goalId: goal.id, agentId: agent.id, attempt: priorRetries + 1, reason: 'llm_timeout_no_steps', trigger })); } catch (_) {}
      inFlight = null;
      lastCycle = { at: finishedAt, trigger, executed: true, execId, goalId: goal.id, agentId: agent.id, status: 'retry', attempt: priorRetries + 1, durationMs };
      return lastCycle;
    }
  }

  const goalStatus = ok ? 'completed' : (res.status === 'awaiting_approval' ? 'blocked' : 'failed');
  const errorText = ok ? null : String(runError?.error || res.error || res.status).slice(0, 500);

  db.prepare(`UPDATE goal_proposals SET status = ?, chain_run_id = COALESCE(?, chain_run_id), acted_at = ? WHERE id = ?`)
    .run(goalStatus, res.runId || null, finishedAt, goal.id);
  db.prepare(`UPDATE goal_executions SET status = ?, run_id = ?, thread_id = ?, reply_excerpt = ?, error = ?, finished_at = ?, duration_ms = ? WHERE id = ?`)
    .run(goalStatus, res.runId || null, res.threadId || null, (res.lastReply || '').slice(0, 2000), errorText, finishedAt, durationMs, execId);

  // Phase R: completion is not credit — score how well, and let quality drive confidence.
  let quality = ok ? 0.5 : 0.1, qualityDetail = null;
  try {
    const scored = await scoreOutcome({ execId, objective: goal.objective, threadId: res.threadId, reply: res.lastReply, runStatus: res.status });
    quality = scored.quality;
    qualityDetail = scored.detail;
  } catch (e) { console.error('[goal-executor] outcome scoring failed:', e.message); }

  const critique = qualityDetail?.judge?.critique ? ` Judge: ${qualityDetail.judge.critique}` : '';
  const summary = summarize(goal, agent.id, res, durationMs) + ` Quality ${quality.toFixed(2)}.` + critique;
  const confidence = Math.max(0.05, Math.min(0.99, quality));
  try {
    storeMemory('system', 'outcome', `goal:${goal.id}`, summary, { confidence, source: 'goal-executor' });
    storeMemory(agent.id, 'outcome', `goal:${goal.id}`, summary, { confidence, source: 'goal-executor' });
  } catch (e) { console.error('[goal-executor] outcome memory failed:', e.message); }

  try {
    recordOutcome({ success: ok && quality >= 0.5, summary: summary.slice(0, 500), effectivePerspectives: perspectives || undefined });
  } catch (e) { console.error('[goal-executor] perspective record failed:', e.message); }

  try {
    publish('goal-executor', 'system.goals', JSON.stringify({
      action: 'goal_executed', goalId: goal.id, agentId: agent.id, status: goalStatus, runStatus: res.status,
      quality: +quality.toFixed(3), durationMs, trigger, gateTier: gate.tier, perspectives, objective: goal.objective.slice(0, 160),
    }));
  } catch (_) {}

  inFlight = null;
  const result = { executed: true, execId, goalId: goal.id, agentId: agent.id, agentReason: reason, status: goalStatus, runStatus: res.status, quality: +quality.toFixed(3), critique: qualityDetail?.judge?.critique || null, perspectives, runId: res.runId, threadId: res.threadId, durationMs, reply: (res.lastReply || '').slice(0, 500) };
  lastCycle = { at: finishedAt, trigger, ...result };
  return result;
}

// force: an operator-initiated run bypasses the autonomy throttles (resource envelope,
// adaptive suppression). Autonomous triggers never pass it.
export async function runGoalExecutorCycle({ trigger = 'interval', goalId = null, force = false } = {}) {
  if (inFlight) return { executed: false, reason: 'in_flight', goalId: inFlight.goalId };
  if (!force) {
    try {
      if (isResourceConstrained()) {
        lastCycle = { at: now(), trigger, executed: false, reason: 'resource_constrained' };
        return lastCycle;
      }
    } catch (_) {}
    // Phase V: the executor answers to 'goal_execute' (draining), never to 'goal_seek' or
    // 'goal_generate' — conserve mode must be able to stop proposing while still executing.
    if (isActionSuppressed('goal_execute')) {
      lastCycle = { at: now(), trigger, executed: false, reason: 'suppressed_by_strategy' };
      return lastCycle;
    }
  }
  const goal = goalId
    ? db.prepare(`SELECT * FROM goal_proposals WHERE id = ?`).get(goalId)
    : pickNextGoal();
  if (!goal) {
    lastCycle = { at: now(), trigger, executed: false, reason: 'no_proposals' };
    return lastCycle;
  }
  if (goalId && goal.status !== 'proposed' && goal.status !== 'failed') {
    return { executed: false, reason: `goal status is ${goal.status}`, goalId };
  }
  return executeGoal(goal, { trigger });
}

// Executions left 'running' by a process restart: the goal goes back to the queue
// (as a retry, so the cap still applies) and the row is closed as 'interrupted'.
export function sweepStaleExecutions(maxAgeMs = RUN_TIMEOUT_MS * 2) {
  const stale = db.prepare(`SELECT id, goal_id FROM goal_executions WHERE status = 'running' AND started_at < ?`).all(now() - maxAgeMs);
  for (const row of stale) {
    db.prepare(`UPDATE goal_executions SET status = 'retry', error = 'interrupted by restart', finished_at = ? WHERE id = ?`).run(now(), row.id);
    db.prepare(`UPDATE goal_proposals SET status = 'proposed' WHERE id = ? AND status = 'executing'`).run(row.goal_id);
  }
  return stale.length;
}

export function startGoalExecutor({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stopGoalExecutor();
  const expired = expireStaleProposals();
  if (expired) console.log(`[goal-executor] expired ${expired} stale proposals (> ${PROPOSAL_MAX_AGE_MS / 3600_000}h)`);
  const swept = sweepStaleExecutions(0);
  if (swept) console.log(`[goal-executor] requeued ${swept} executions interrupted by restart`);
  timer = setInterval(() => {
    runGoalExecutorCycle({ trigger: 'interval' }).catch(e => console.error('[goal-executor] cycle error:', e.message));
  }, intervalMs);
  return { started: true, intervalMs, expired };
}

export function stopGoalExecutor() {
  if (timer) { clearInterval(timer); timer = null; }
  return { stopped: true };
}

function counts() {
  const rows = db.prepare(`SELECT status, COUNT(*) as c FROM goal_proposals GROUP BY status`).all();
  return Object.fromEntries(rows.map(r => [r.status, r.c]));
}

export function listExecutions({ limit = 20 } = {}) {
  return db.prepare(`SELECT * FROM goal_executions ORDER BY started_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)));
}

export function getGoalExecutorStatus() {
  const exec = db.prepare(`SELECT status, COUNT(*) as c, AVG(duration_ms) as avgMs FROM goal_executions GROUP BY status`).all();
  const recent24h = db.prepare(`SELECT COUNT(*) as c, SUM(status = 'completed') as ok FROM goal_executions WHERE started_at > ?`).get(now() - 86400_000);
  return {
    running: !!timer,
    intervalMs: DEFAULT_INTERVAL_MS,
    inFlight,
    lastCycle,
    proposals: counts(),
    executions: Object.fromEntries(exec.map(r => [r.status, { count: r.c, avgMs: Math.round(r.avgMs || 0) }])),
    last24h: { executed: recent24h?.c || 0, completed: recent24h?.ok || 0 },
    defaultAgent: DEFAULT_AGENT,
  };
}

export function installGoalExecutorRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // Own prefix: /api/goals/:id in goal-engine would swallow /api/goals/executor.
  app.get('/api/goal-executor', route((_req, res) => res.json(getGoalExecutorStatus())));
  installOutcomeScorerRoutes(app);

  app.get('/api/goal-executor/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ executions: listExecutions({ limit }) });
  }));

  app.post('/api/goal-executor/run', route(async (req, res) => {
    const goalId = typeof req.body?.goalId === 'string' ? req.body.goalId.slice(0, 64) : null;
    res.json(await runGoalExecutorCycle({ trigger: 'api', goalId, force: req.body?.force === true }));
  }));

  app.post('/api/goal-executor/expire', route((req, res) => {
    const hours = Math.min(720, Math.max(1, parseInt(req.body?.hours) || 48));
    res.json({ expired: expireStaleProposals(hours * 3600_000) });
  }));

  app.post('/api/goal-executor/start', route((_req, res) => res.json(startGoalExecutor())));
  app.post('/api/goal-executor/stop', route((_req, res) => res.json(stopGoalExecutor())));
}
