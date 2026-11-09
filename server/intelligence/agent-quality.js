/**
 * Agent Quality & Credit Assignment — Phase W.
 *
 * Phase R made outcomes measurable (goal_executions.quality, 0–1). Phase W makes them
 * matter: quality now changes WHO runs the next goal and WHICH goal is worth running.
 *
 *   1. Quality-weighted selection — selectAgent() multiplies keyword fit by
 *      agentQualityWeight(): 0.5 + 7-day mean quality once an agent has ≥ 3 scored
 *      outcomes; neutral 1.0 before that so new agents still get tried.
 *   2. Reversible retirement — a forged/custom agent with ≥ AGENT_RETIRE_MIN_SAMPLES (5)
 *      outcomes and 7-day mean quality < AGENT_RETIRE_THRESHOLD (0.2) is retired: excluded
 *      from autonomous selection, row in agent_retirements, bus event, memories. Manifests
 *      are never deleted; POST …/retirements/:id/restore brings an agent back. Hand-written
 *      ('default') agents are exempt — Vaughn wrote those; a bad run is a prompt problem,
 *      not a reason to drop them.
 *   3. Goal utility from history — goalUtility() estimates the expected quality of a
 *      proposal from past executions of similar objectives (token overlap). pickNextGoal()
 *      orders by priority, then expected utility. A proposal whose similar history shows
 *      ≥ 3 attempts averaging < AGENT_SHELVE_THRESHOLD (0.15) is SHELVED — status 'shelved',
 *      never auto-executed again — so the backlog gets triaged by evidence.
 *   4. Measurement — qualityTrend() gives daily fleet means so "quality trend positive over
 *      7 days" is a number; the self-audit flags any execution by a retired agent.
 *
 * No new LLM calls: everything here is bookkeeping on data the organism already produces.
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { fleetQualityStats, agentQualityStats } from './outcome-scorer.js';

const now = () => Date.now();
const DAY = 86400_000;
const WINDOW_MS = 7 * DAY;
export const RETIRE_MIN_SAMPLES = Math.max(3, parseInt(process.env.AGENT_RETIRE_MIN_SAMPLES, 10) || 5);
export const RETIRE_THRESHOLD = Math.min(0.5, Math.max(0.05, parseFloat(process.env.AGENT_RETIRE_THRESHOLD) || 0.2));
export const SHELVE_THRESHOLD = Math.min(0.5, Math.max(0.05, parseFloat(process.env.AGENT_SHELVE_THRESHOLD) || 0.15));
export const SHELVE_MIN_ATTEMPTS = 3;
const WEIGHT_MIN_SAMPLES = 3;

function ensureSchema() {
  db.prepare(`CREATE TABLE IF NOT EXISTS agent_retirements (
    agent_id TEXT PRIMARY KEY,
    quality REAL,
    samples INTEGER,
    reason TEXT,
    retired_at INTEGER NOT NULL,
    restored_at INTEGER,
    restored_by TEXT
  )`).run();
}
try { ensureSchema(); } catch (e) { console.error('[agent-quality] schema:', e.message); }

// ─── Retirement ──────────────────────────────────────────────────

export function isRetired(agentId) {
  try { return !!db.prepare(`SELECT 1 FROM agent_retirements WHERE agent_id = ? AND restored_at IS NULL`).get(agentId); } catch (_) { return false; }
}

export function listRetirements({ includeRestored = false } = {}) {
  return db.prepare(`SELECT * FROM agent_retirements ${includeRestored ? '' : 'WHERE restored_at IS NULL'} ORDER BY retired_at DESC`).all();
}

export function retireAgent(agentId, { quality, samples, reason = 'low_quality', by = 'sweep' } = {}) {
  if (isRetired(agentId)) return { retired: false, reason: 'already_retired', agentId };
  db.prepare(`INSERT INTO agent_retirements (agent_id, quality, samples, reason, retired_at, restored_at, restored_by)
              VALUES (?, ?, ?, ?, ?, NULL, NULL)
              ON CONFLICT(agent_id) DO UPDATE SET quality = excluded.quality, samples = excluded.samples, reason = excluded.reason, retired_at = excluded.retired_at, restored_at = NULL, restored_by = NULL`)
    .run(agentId, quality ?? null, samples ?? null, `${reason}:${by}`, now());
  const summary = `Agent ${agentId} retired from autonomous goal selection: 7-day mean quality ${quality == null ? 'n/a' : quality.toFixed(2)} over ${samples ?? '?'} outcomes (threshold ${RETIRE_THRESHOLD}). Reversible via POST /api/goal-executor/retirements/${agentId}/restore.`;
  try { storeMemory(agentId, 'outcome', `retired:${now()}`, summary, { confidence: 0.9, source: 'agent-quality' }); } catch (_) {}
  try { storeMemory('system', 'outcome', `retired:${agentId}`, summary, { confidence: 0.9, source: 'agent-quality' }); } catch (_) {}
  try { publish('agent-quality', 'system.fleet.retired', JSON.stringify({ agentId, quality, samples, reason, by })); } catch (_) {}
  return { retired: true, agentId, quality, samples };
}

export function restoreAgent(agentId, { by = 'operator' } = {}) {
  const info = db.prepare(`UPDATE agent_retirements SET restored_at = ?, restored_by = ? WHERE agent_id = ? AND restored_at IS NULL`).run(now(), by, agentId);
  if (info.changes) {
    try { publish('agent-quality', 'system.fleet.restored', JSON.stringify({ agentId, by })); } catch (_) {}
    try { storeMemory('system', 'outcome', `restored:${agentId}`, `Agent ${agentId} restored to autonomous selection by ${by}.`, { confidence: 0.9, source: 'agent-quality' }); } catch (_) {}
  }
  return { restored: info.changes > 0, agentId };
}

/**
 * Retire forged/custom agents whose recent outcomes are consistently poor. `agents` is the
 * live fleet list (so hand-written manifests can be exempted by source); without it every
 * low scorer is treated as eligible.
 */
export function sweepAgentQuality({ agents = null, minSamples = RETIRE_MIN_SAMPLES, threshold = RETIRE_THRESHOLD, windowMs = WINDOW_MS } = {}) {
  const bySource = new Map((agents || []).map(a => [a.id, a.source || 'unknown']));
  const stats = fleetQualityStats({ windowMs });
  const retired = [], exempt = [], kept = [];
  for (const s of stats) {
    if (s.n < minSamples) { kept.push({ agentId: s.agent_id, reason: 'too_few_samples', n: s.n }); continue; }
    if (s.mean >= threshold) { kept.push({ agentId: s.agent_id, reason: 'above_threshold', mean: +s.mean.toFixed(3) }); continue; }
    if (bySource.get(s.agent_id) === 'default') { exempt.push({ agentId: s.agent_id, mean: +s.mean.toFixed(3), n: s.n, reason: 'hand_written_manifest' }); continue; }
    if (isRetired(s.agent_id)) continue;
    retired.push(retireAgent(s.agent_id, { quality: s.mean, samples: s.n, reason: 'low_quality', by: 'sweep' }));
  }
  return { checked: stats.length, retired, exempt, kept: kept.length, minSamples, threshold, windowMs };
}

// ─── Selection weight ────────────────────────────────────────────

/** 0.5 + mean quality once an agent has enough scored outcomes; neutral 1.0 before. */
export function agentQualityWeight(agentId, { windowMs = WINDOW_MS } = {}) {
  try {
    const s = agentQualityStats(agentId, { windowMs, limit: 30 });
    if (!s || s.n < WEIGHT_MIN_SAMPLES || s.mean == null) return { weight: 1.0, n: s?.n || 0, mean: s?.mean ?? null, neutral: true };
    return { weight: +(0.5 + s.mean).toFixed(3), n: s.n, mean: +s.mean.toFixed(3), neutral: false };
  } catch (_) { return { weight: 1.0, n: 0, mean: null, neutral: true }; }
}

// ─── Goal utility from history ───────────────────────────────────

const tokenize = s => new Set(String(s || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || []);
const STOP = new Set(['that', 'this', 'with', 'from', 'into', 'their', 'between', 'across', 'within', 'using', 'based', 'develop', 'analyze', 'analyse', 'create', 'system', 'model', 'novel', 'approach', 'areas', 'categories', 'category', 'relationship', 'relationships', 'high-confidence', 'low-confidence']);
function keyTokens(s) { const t = tokenize(s); for (const w of STOP) t.delete(w); return t; }

let historyCache = { at: 0, rows: [] };
function scoredHistory() {
  if (now() - historyCache.at < 60_000) return historyCache.rows;
  try {
    const rows = db.prepare(
      `SELECT e.goal_id, e.quality, e.status, e.agent_id, g.objective
       FROM goal_executions e JOIN goal_proposals g ON g.id = e.goal_id
       WHERE e.quality IS NOT NULL AND e.started_at > ? ORDER BY e.started_at DESC LIMIT 400`
    ).all(now() - 30 * DAY);
    historyCache = { at: now(), rows: rows.map(r => ({ ...r, tokens: keyTokens(r.objective) })) };
  } catch (_) { historyCache = { at: now(), rows: [] }; }
  return historyCache.rows;
}

/**
 * Expected quality of a proposal, from past scored executions of similar objectives.
 * Similarity = Jaccard over key tokens; a match needs ≥ 2 shared tokens and J ≥ 0.2.
 * Returns { expected, samples, attempts, basis } — `expected` is null with no history.
 */
export function goalUtility(goal) {
  const mine = keyTokens(`${goal.objective} ${goal.rationale || ''}`);
  if (!mine.size) return { expected: null, samples: 0, attempts: 0, basis: 'no_tokens' };
  let wsum = 0, qsum = 0, samples = 0, attempts = 0;
  const own = [];
  for (const h of scoredHistory()) {
    if (h.goal_id === goal.id) { own.push(h.quality); attempts++; continue; }
    let shared = 0;
    for (const t of mine) if (h.tokens.has(t)) shared++;
    if (shared < 2) continue;
    const j = shared / (mine.size + h.tokens.size - shared);
    if (j < 0.2) continue;
    wsum += j; qsum += j * h.quality; samples++; attempts++;
  }
  if (own.length) { // the goal's own past attempts count double — nothing is more similar than itself
    for (const q of own) { wsum += 2; qsum += 2 * q; samples++; }
  }
  if (!samples) return { expected: null, samples: 0, attempts, basis: 'no_similar_history' };
  return { expected: +(qsum / wsum).toFixed(3), samples, attempts, basis: own.length ? 'own+similar' : 'similar' };
}

export function shouldShelve(goal, utility = goalUtility(goal)) {
  return utility.expected != null && utility.samples >= SHELVE_MIN_ATTEMPTS && utility.expected < SHELVE_THRESHOLD;
}

export function shelveGoal(goal, utility) {
  db.prepare(`UPDATE goal_proposals SET status = 'shelved', acted_at = ? WHERE id = ? AND status = 'proposed'`).run(now(), goal.id);
  try { publish('agent-quality', 'system.goals', JSON.stringify({ action: 'goal_shelved', goalId: goal.id, objective: String(goal.objective).slice(0, 160), expectedQuality: utility?.expected, samples: utility?.samples })); } catch (_) {}
  return { shelved: true, goalId: goal.id, expected: utility?.expected, samples: utility?.samples };
}

// ─── Measurement ─────────────────────────────────────────────────

export function qualityTrend({ days = 7 } = {}) {
  const since = now() - days * DAY;
  const rows = db.prepare(
    `SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS n, AVG(quality) AS mean, SUM(status = 'completed') AS completed
     FROM goal_executions WHERE quality IS NOT NULL AND started_at > ? GROUP BY day ORDER BY day`
  ).all(since).map(r => ({ day: r.day, n: r.n, mean: +r.mean.toFixed(3), completed: r.completed }));
  // least-squares slope of daily mean vs day index — positive = improving
  let slope = null;
  if (rows.length >= 2) {
    const xs = rows.map((_, i) => i), ys = rows.map(r => r.mean);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0), den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    slope = den ? +(num / den).toFixed(4) : 0;
  }
  const shelved = db.prepare(`SELECT COUNT(*) AS c FROM goal_proposals WHERE status = 'shelved'`).get()?.c || 0;
  return { days, daily: rows, slope, improving: slope != null ? slope > 0 : null, retired: listRetirements().length, shelved };
}

export function getAgentQualityStatus() {
  return {
    thresholds: { retireMinSamples: RETIRE_MIN_SAMPLES, retireThreshold: RETIRE_THRESHOLD, shelveThreshold: SHELVE_THRESHOLD, shelveMinAttempts: SHELVE_MIN_ATTEMPTS, weightMinSamples: WEIGHT_MIN_SAMPLES },
    retirements: listRetirements(),
    trend: qualityTrend(),
  };
}

export function installAgentQualityRoutes(app, { listAgents = null } = {}) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/goal-executor/quality/trend', route((req, res) => res.json(qualityTrend({ days: Math.min(90, Math.max(1, parseInt(req.query.days) || 7)) }))));
  app.get('/api/goal-executor/retirements', route((req, res) => res.json({ retirements: listRetirements({ includeRestored: req.query.all === '1' }), thresholds: getAgentQualityStatus().thresholds })));
  app.post('/api/goal-executor/retirements/sweep', route((_req, res) => res.json(sweepAgentQuality({ agents: typeof listAgents === 'function' ? listAgents() : null }))));
  app.post('/api/goal-executor/retirements/:agentId/restore', route((req, res) => res.json(restoreAgent(String(req.params.agentId).slice(0, 120), { by: 'operator' }))));
  app.post('/api/goal-executor/retirements/:agentId', route((req, res) => res.json(retireAgent(String(req.params.agentId).slice(0, 120), { reason: String(req.body?.reason || 'operator').slice(0, 80), by: 'operator' }))));
  app.get('/api/goal-executor/utility', route((req, res) => {
    const id = String(req.query.goalId || '').slice(0, 64);
    const goal = id ? db.prepare(`SELECT * FROM goal_proposals WHERE id = ?`).get(id) : null;
    if (!goal) return res.status(404).json({ error: 'goal not found' });
    const u = goalUtility(goal);
    res.json({ goalId: goal.id, objective: goal.objective, status: goal.status, utility: u, wouldShelve: shouldShelve(goal, u) });
  }));
}
