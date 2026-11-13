/**
 * Outcome Feedback — human-in-the-loop credit assignment (absorbed from looseScrew's
 * "tighten / loosen screw" rating, 2026-11-09).
 *
 * Phases R and W made quality measurable and consequential, but every signal was
 * machine-made: an 8B judge plus deterministic heuristics. Nothing let Vaughn say
 * "this was good" or "this was useless" in a way the organism would act on. This module
 * does. One click becomes credit:
 *
 *   rating ∈ {+1, −1}  →  quality_human = 0.9 | 0.1
 *   goal_executions.quality  ←  HUMAN_WEIGHT × quality_human + (1 − HUMAN_WEIGHT) × quality_machine
 *
 * `quality` stays the single column every reader already uses (agent weights, retirement,
 * goal utility, reality fitness, trend, digests, hive export), so a human vote flows
 * everywhere without touching those readers. The machine score is preserved in
 * `quality_machine`; `quality_human` records the vote. Feedback also writes a high-
 * confidence 'outcome' memory for the agent (so its next prompt sees what the human
 * thought) and publishes `system.goals` action `human_feedback`.
 *
 * HUMAN_FEEDBACK_WEIGHT (default 0.65): the human vote outweighs the judge, deliberately.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { ensureGoalExecutionsTable } from './goal-executions-schema.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';

const now = () => Date.now();
const DAY = 86400_000;
export const HUMAN_WEIGHT = Math.min(0.95, Math.max(0.2, parseFloat(process.env.HUMAN_FEEDBACK_WEIGHT) || 0.65));
const HUMAN_SCORE = { 1: 0.9, '-1': 0.1 };
const clamp01 = x => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

function ensureSchema() {
  db.prepare(`CREATE TABLE IF NOT EXISTS outcome_feedback (
    id TEXT PRIMARY KEY,
    exec_id TEXT NOT NULL,
    goal_id TEXT,
    agent_id TEXT,
    rating INTEGER NOT NULL,
    note TEXT,
    source TEXT NOT NULL DEFAULT 'user',
    quality_before REAL,
    quality_after REAL,
    created_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_outcome_feedback_exec ON outcome_feedback(exec_id, created_at)`).run();
  ensureGoalExecutionsTable();
  const cols = db.prepare(`PRAGMA table_info(goal_executions)`).all().map(c => c.name);
  if (!cols.includes('quality_machine')) db.prepare(`ALTER TABLE goal_executions ADD COLUMN quality_machine REAL`).run();
  if (!cols.includes('quality_human')) db.prepare(`ALTER TABLE goal_executions ADD COLUMN quality_human REAL`).run();
}
try { ensureSchema(); } catch (e) { console.error('[outcome-feedback] schema:', e.message); }

export function blendQuality(machine, human) {
  if (human == null) return machine;
  const m = machine == null ? 0.5 : clamp01(machine);
  return +clamp01(HUMAN_WEIGHT * clamp01(human) + (1 - HUMAN_WEIGHT) * m).toFixed(3);
}

export function recordFeedback({ execId, rating, note = '', source = 'user' }) {
  const r = Number(rating);
  if (r !== 1 && r !== -1) throw Object.assign(new Error('rating must be +1 or -1'), { status: 400 });
  const exec = db.prepare(
    `SELECT e.*, g.objective FROM goal_executions e LEFT JOIN goal_proposals g ON g.id = e.goal_id WHERE e.id = ?`
  ).get(String(execId || '').slice(0, 64));
  if (!exec) throw Object.assign(new Error('execution not found'), { status: 404 });

  // First human touch freezes the machine score; later votes re-blend from it, not from each other.
  const machine = exec.quality_machine ?? exec.quality;
  const human = HUMAN_SCORE[r];
  const effective = blendQuality(machine, human);
  const id = 'fb_' + randomUUID().replace(/-/g, '').slice(0, 10);
  const cleanNote = String(note || '').slice(0, 500);

  db.prepare(`INSERT INTO outcome_feedback (id, exec_id, goal_id, agent_id, rating, note, source, quality_before, quality_after, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, exec.id, exec.goal_id, exec.agent_id, r, cleanNote || null, String(source).slice(0, 40), exec.quality, effective, now());
  db.prepare(`UPDATE goal_executions SET quality_machine = COALESCE(quality_machine, quality), quality_human = ?, quality = ? WHERE id = ?`)
    .run(human, effective, exec.id);

  const verdict = r > 0 ? 'useful' : 'not useful';
  const summary = `[Human feedback] Vaughn rated the outcome of goal "${String(exec.objective || exec.goal_id).slice(0, 140)}" as ${verdict} (${r > 0 ? '👍' : '👎'}).` +
    (cleanNote ? ` Note: ${cleanNote}` : '') + ` Quality ${exec.quality == null ? 'n/a' : exec.quality.toFixed(2)} → ${effective.toFixed(2)}.`;
  try {
    if (exec.agent_id) storeMemory(exec.agent_id, 'outcome', `feedback:${exec.id}`, summary, { confidence: 0.95, source: 'human' });
    storeMemory('system', 'outcome', `feedback:${exec.id}`, summary, { confidence: 0.95, source: 'human' });
  } catch (e) { console.error('[outcome-feedback] memory:', e.message); }
  try {
    publish('human', 'system.goals', JSON.stringify({ action: 'human_feedback', execId: exec.id, goalId: exec.goal_id, agentId: exec.agent_id, rating: r, note: cleanNote.slice(0, 200), qualityBefore: exec.quality, qualityAfter: effective }));
  } catch (_) {}

  return { id, execId: exec.id, goalId: exec.goal_id, agentId: exec.agent_id, rating: r, note: cleanNote, qualityMachine: machine, qualityHuman: human, qualityBefore: exec.quality, qualityAfter: effective, humanWeight: HUMAN_WEIGHT };
}

/** Undo a vote (misclick, or a test). Quality re-blends from the latest remaining vote, or returns to the machine score. */
export function deleteFeedback(id) {
  const row = db.prepare(`SELECT * FROM outcome_feedback WHERE id = ?`).get(String(id || '').slice(0, 40));
  if (!row) throw Object.assign(new Error('feedback not found'), { status: 404 });
  db.prepare(`DELETE FROM outcome_feedback WHERE id = ?`).run(row.id);
  const exec = db.prepare(`SELECT id, quality, quality_machine FROM goal_executions WHERE id = ?`).get(row.exec_id);
  let restored = null;
  if (exec) {
    const latest = db.prepare(`SELECT rating FROM outcome_feedback WHERE exec_id = ? ORDER BY created_at DESC LIMIT 1`).get(row.exec_id);
    const machine = exec.quality_machine ?? exec.quality;
    if (latest) {
      restored = blendQuality(machine, HUMAN_SCORE[latest.rating]);
      db.prepare(`UPDATE goal_executions SET quality_human = ?, quality = ? WHERE id = ?`).run(HUMAN_SCORE[latest.rating], restored, row.exec_id);
    } else {
      restored = machine;
      db.prepare(`UPDATE goal_executions SET quality_human = NULL, quality = ?, quality_machine = NULL WHERE id = ?`).run(machine, row.exec_id);
    }
  }
  for (const agentId of [row.agent_id, 'system']) {
    if (!agentId) continue;
    try { db.prepare(`DELETE FROM agent_memories WHERE agent_id = ? AND key = ?`).run(agentId, `feedback:${row.exec_id}`); } catch (_) {}
  }
  try { publish('human', 'system.goals', JSON.stringify({ action: 'human_feedback_undone', execId: row.exec_id, agentId: row.agent_id, qualityNow: restored })); } catch (_) {}
  return { deleted: true, id: row.id, execId: row.exec_id, qualityNow: restored };
}

export function listFeedback({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT f.*, g.objective FROM outcome_feedback f LEFT JOIN goal_proposals g ON g.id = f.goal_id ORDER BY f.created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

/** Finished executions with a reply that nobody has rated yet — the review queue. */
export function pendingForReview({ limit = 30, windowMs = 7 * DAY } = {}) {
  return db.prepare(
    `SELECT e.id AS exec_id, e.goal_id, e.agent_id, e.status, e.quality, e.quality_machine, e.quality_human, e.reply_excerpt, e.duration_ms, e.finished_at, e.quality_detail, g.objective, g.priority
     FROM goal_executions e LEFT JOIN goal_proposals g ON g.id = e.goal_id
     WHERE e.status IN ('completed', 'failed') AND e.finished_at > ?
       AND NOT EXISTS (SELECT 1 FROM outcome_feedback f WHERE f.exec_id = e.id)
     ORDER BY e.finished_at DESC LIMIT ?`
  ).all(now() - windowMs, Math.min(200, Math.max(1, limit))).map(r => {
    let critique = null;
    try { critique = JSON.parse(r.quality_detail || '{}')?.judge?.critique || null; } catch (_) {}
    const { quality_detail, ...rest } = r;
    return { ...rest, critique };
  });
}

export function feedbackStats({ windowMs = 30 * DAY } = {}) {
  const since = now() - windowMs;
  const total = db.prepare(`SELECT COUNT(*) n, SUM(rating > 0) up, SUM(rating < 0) down FROM outcome_feedback WHERE created_at > ?`).get(since);
  // Agreement: did the machine already think what the human said? (machine ≥ 0.5 ⇔ 👍)
  const rows = db.prepare(`SELECT f.rating, e.quality_machine AS m FROM outcome_feedback f JOIN goal_executions e ON e.id = f.exec_id WHERE f.created_at > ? AND e.quality_machine IS NOT NULL`).all(since);
  let agree = 0;
  for (const r of rows) if ((r.m >= 0.5) === (r.rating > 0)) agree++;
  const byAgent = db.prepare(
    `SELECT agent_id, COUNT(*) n, SUM(rating > 0) up, SUM(rating < 0) down FROM outcome_feedback WHERE created_at > ? GROUP BY agent_id ORDER BY n DESC LIMIT 20`
  ).all(since);
  const pending = db.prepare(
    `SELECT COUNT(*) n FROM goal_executions e WHERE e.status IN ('completed','failed') AND e.finished_at > ? AND NOT EXISTS (SELECT 1 FROM outcome_feedback f WHERE f.exec_id = e.id)`
  ).get(now() - 7 * DAY).n;
  return {
    windowMs, humanWeight: HUMAN_WEIGHT,
    total: total.n || 0, up: total.up || 0, down: total.down || 0,
    machineAgreement: rows.length ? +(agree / rows.length).toFixed(3) : null, agreementSamples: rows.length,
    byAgent, pendingReview7d: pending,
  };
}

export function installOutcomeFeedbackRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/goal-executor/feedback', route((req, res) => res.json({ feedback: listFeedback({ limit: parseInt(req.query.limit) || 50 }), stats: feedbackStats() })));
  app.get('/api/goal-executor/feedback/pending', route((req, res) => res.json({ pending: pendingForReview({ limit: parseInt(req.query.limit) || 30 }) })));
  app.get('/api/goal-executor/feedback/stats', route((_req, res) => res.json(feedbackStats())));
  app.post('/api/goal-executor/feedback', route((req, res) => {
    try {
      res.json(recordFeedback({ execId: req.body?.execId, rating: req.body?.rating, note: req.body?.note, source: 'user' }));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  }));
  app.delete('/api/goal-executor/feedback/:id', route((req, res) => {
    try { res.json(deleteFeedback(req.params.id)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }));
}
