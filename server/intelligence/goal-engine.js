/**
 * Autonomous Goal Engine — self-directed intelligence.
 *
 * Reads the system's memory landscape, identifies knowledge gaps and
 * opportunities, and proposes new chain objectives. When wired into
 * the daemon cycle, the system goes from reactive to self-directed.
 *
 * Inputs:  agent_memories, chain_runs, verification_loops, vertiso_memories
 * Outputs: goal proposals stored in goal_proposals table, optionally auto-queued
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { getAutonomyModifiers } from './consciousness-gate.js';

const BASE_MAX_PROPOSALS = 2;

const now = () => Date.now();

const GOAL_PROMPT = `You are an Autonomous Goal Engine for a sovereign AI system called FRAYMUS.
Your job is to analyze the system's current knowledge state and propose NEW objectives
that the Logic Chain engine should analyze next.

You receive:
1. Recent chain run outcomes (what was analyzed, what succeeded/failed)
2. Memory landscape (what knowledge categories exist, their confidence levels)
3. Knowledge gaps (areas with low confidence or missing coverage)
4. Recent evolution activity (fossils, verified findings)

Propose 1-3 new objectives that would:
- Fill knowledge gaps the system has identified
- Build on successful chain runs with deeper analysis
- Re-examine failed chains from a different angle
- Explore connections between existing knowledge domains

Output JSON only, no markdown fences:
{
  "proposals": [
    {
      "objective": "clear, specific objective for a Logic Chain run",
      "rationale": "why this matters to the system's growth",
      "priority": "high|medium|low",
      "builds_on": "chain_run_id or null if novel",
      "estimated_complexity": "simple|moderate|complex"
    }
  ],
  "landscape_summary": "one paragraph on current knowledge state"
}`;

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS goal_proposals (
    id TEXT PRIMARY KEY,
    objective TEXT NOT NULL,
    rationale TEXT,
    priority TEXT DEFAULT 'medium',
    builds_on TEXT,
    complexity TEXT DEFAULT 'moderate',
    status TEXT DEFAULT 'proposed',
    source TEXT DEFAULT 'goal-engine',
    chain_run_id TEXT,
    landscape_summary TEXT,
    created_at INTEGER,
    acted_at INTEGER
  )`).run();
}

async function gatherLandscape() {
  const oneDayAgo = now() - 86400_000;
  const oneWeekAgo = now() - 7 * 86400_000;

  const recentChains = (() => {
    try {
      return db.prepare(
        `SELECT id, objective, status, stop_reason FROM chain_runs ORDER BY created_at DESC LIMIT 15`
      ).all();
    } catch (_) { return []; }
  })();

  const memoryCategories = (() => {
    try {
      return db.prepare(
        `SELECT category, COUNT(*) as count, AVG(confidence) as avgConf, MAX(updated_at) as latest
         FROM agent_memories GROUP BY category ORDER BY count DESC LIMIT 20`
      ).all();
    } catch (_) { return []; }
  })();

  const recentFossils = (() => {
    try {
      return db.prepare(
        `SELECT key, value FROM agent_memories WHERE category = 'fossil' AND created_at > ? ORDER BY created_at DESC LIMIT 5`
      ).all(oneWeekAgo);
    } catch (_) { return []; }
  })();

  const chainVerified = (() => {
    try {
      return db.prepare(
        `SELECT key, value FROM agent_memories WHERE category = 'chain_verified' AND created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneWeekAgo);
    } catch (_) { return []; }
  })();

  const failedChains = recentChains.filter(c => c.status === 'crashed' || c.status === 'failed');
  const completedChains = recentChains.filter(c => c.status === 'completed');

  const lowConfidence = memoryCategories.filter(c => c.avgConf < 0.6 && c.count > 2);

  const vertisoNamespaces = (() => {
    try {
      return db.prepare(
        `SELECT namespace, COUNT(*) as count, AVG(importance) as avgImportance
         FROM vertiso_memories GROUP BY namespace ORDER BY count DESC LIMIT 10`
      ).all();
    } catch (_) { return []; }
  })();

  return {
    recentChains: recentChains.slice(0, 10).map(c => ({
      id: c.id, objective: c.objective?.slice(0, 200), status: c.status, stopReason: c.stop_reason,
    })),
    completedCount: completedChains.length,
    failedChains: failedChains.map(c => ({
      id: c.id, objective: c.objective?.slice(0, 200), reason: c.stop_reason,
    })),
    memoryCategories: memoryCategories.map(c => ({
      category: c.category, count: c.count, avgConfidence: Math.round((c.avgConf || 0) * 100) / 100,
    })),
    lowConfidenceAreas: lowConfidence.map(c => c.category),
    recentFossils: recentFossils.length,
    chainVerifiedCount: chainVerified.length,
    vertisoNamespaces: vertisoNamespaces.map(n => ({
      namespace: n.namespace, count: n.count, avgImportance: Math.round((n.avgImportance || 0) * 100) / 100,
    })),
    existingProposals: (() => {
      try {
        ensureTable();
        return db.prepare(`SELECT objective, status FROM goal_proposals WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 5`).all();
      } catch (_) { return []; }
    })(),
  };
}

// Phase R: proposals are only worth generating if the executor can reach them.
// Generation ran ~1,000/day against ~288/day execution capacity; the backlog grew
// to 3,013 and the oldest proposals expired unread. Gate on queue depth.
const MAX_PENDING_PROPOSALS = Math.max(1, parseInt(process.env.GOAL_MAX_PENDING) || 12);

export function pendingProposalCount() {
  ensureTable();
  return db.prepare(`SELECT COUNT(*) as c FROM goal_proposals WHERE status IN ('proposed', 'executing')`).get()?.c || 0;
}

export async function generateGoals({ trigger = 'daemon', force = false } = {}) {
  ensureTable();
  const pending = pendingProposalCount();
  if (!force && pending >= MAX_PENDING_PROPOSALS) {
    return { generated: false, reason: 'queue_full', pending, maxPending: MAX_PENDING_PROPOSALS };
  }
  const landscape = await gatherLandscape();

  const totalKnowledge = landscape.memoryCategories.reduce((s, c) => s + c.count, 0);
  if (totalKnowledge === 0 && landscape.recentChains.length === 0) {
    return { generated: false, reason: 'no_knowledge_base', landscape };
  }

  const gateMods = getAutonomyModifiers();
  const maxProposals = Math.min(5, Math.max(1, Math.round(BASE_MAX_PROPOSALS * gateMods.evolutionRate)));

  const tierContext = `\n\nSystem consciousness tier: ${gateMods.tier} (${gateMods.proofsPassed}/4 proofs, evolution rate ${gateMods.evolutionRate}x). ` +
    (gateMods.tier === 'DORMANT' ? 'Propose only safe, well-understood objectives. Avoid speculative or complex goals.' :
     gateMods.tier === 'INTEGRATED' ? 'The system is fully coherent — propose ambitious, cross-domain objectives that push boundaries.' :
     'Balance ambition with feasibility in your proposals.');

  const input = JSON.stringify(landscape, null, 2);

  const response = await chatOllama([
    { role: 'system', content: GOAL_PROMPT + tierContext },
    { role: 'user', content: `Current system knowledge landscape:\n${input}\n\nPropose up to ${maxProposals} objectives.` },
  ]);

  const parsed = parseJSON(response, { proposals: [], landscape_summary: 'Parse error' });
  const proposals = (parsed.proposals || []).slice(0, maxProposals);

  const stored = [];
  for (const p of proposals) {
    if (!p.objective || typeof p.objective !== 'string') continue;

    // Phase S: dedup across ALL statuses for 7 days (was: exact match on 'proposed' only, so
    // an objective expired or completed yesterday was re-proposed today — self-audit saw 13x).
    const exists = db.prepare(
      `SELECT 1 FROM goal_proposals WHERE lower(trim(objective)) = lower(trim(?)) AND created_at > ?`
    ).get(p.objective, now() - 7 * 86400_000);
    if (exists) continue;

    const id = 'goal_' + randomUUID().replace(/-/g, '').slice(0, 10);
    db.prepare(
      `INSERT INTO goal_proposals (id, objective, rationale, priority, builds_on, complexity, status, source, landscape_summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`
    ).run(
      id, p.objective.trim(), p.rationale || null,
      ['high', 'medium', 'low'].includes(p.priority) ? p.priority : 'medium',
      p.builds_on || null,
      ['simple', 'moderate', 'complex'].includes(p.estimated_complexity) ? p.estimated_complexity : 'moderate',
      trigger, parsed.landscape_summary?.slice(0, 2000) || null, now()
    );
    stored.push({ id, objective: p.objective.trim(), priority: p.priority });
  }

  try {
    publish('system', 'system.goals', JSON.stringify({
      action: 'goals_generated', count: stored.length, trigger,
      proposals: stored.map(s => s.objective.slice(0, 100)),
      gateTier: gateMods.tier, maxProposals, at: now(),
    }));
  } catch (_) {}

  return {
    generated: stored.length > 0,
    count: stored.length,
    proposals: stored,
    landscapeSummary: parsed.landscape_summary,
    landscape,
    gateTier: gateMods.tier,
    maxProposals,
  };
}

export function listProposals({ status, limit = 20 } = {}) {
  ensureTable();
  const q = status
    ? db.prepare('SELECT * FROM goal_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    : db.prepare('SELECT * FROM goal_proposals ORDER BY created_at DESC LIMIT ?');
  return status ? q.all(status, limit) : q.all(limit);
}

export function getProposal(id) {
  ensureTable();
  return db.prepare('SELECT * FROM goal_proposals WHERE id = ?').get(id) || null;
}

export function updateProposalStatus(id, status, chainRunId = null) {
  ensureTable();
  const valid = ['proposed', 'accepted', 'rejected', 'executing', 'completed', 'failed', 'blocked', 'expired'];
  if (!valid.includes(status)) throw new Error(`Invalid status: ${status}`);
  db.prepare(
    `UPDATE goal_proposals SET status = ?, chain_run_id = COALESCE(?, chain_run_id), acted_at = ? WHERE id = ?`
  ).run(status, chainRunId, now(), id);
}

export function deleteProposal(id) {
  ensureTable();
  const row = db.prepare('SELECT 1 FROM goal_proposals WHERE id = ?').get(id);
  if (!row) return false;
  db.prepare('DELETE FROM goal_proposals WHERE id = ?').run(id);
  return true;
}

export function installGoalRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/goals/generate', route(async (_req, res) => {
    const result = await generateGoals({ trigger: 'api' });
    res.json(result);
  }));

  app.get('/api/goals', route((req, res) => {
    const status = req.query.status || null;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ proposals: listProposals({ status, limit }) });
  }));

  app.get('/api/goals/:id', route((req, res) => {
    const p = getProposal(req.params.id);
    if (!p) return res.status(404).json({ error: 'Proposal not found' });
    res.json(p);
  }));

  app.patch('/api/goals/:id', route((req, res) => {
    const { status, chainRunId } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    updateProposalStatus(req.params.id, status, chainRunId);
    res.json({ updated: req.params.id, status });
  }));

  app.delete('/api/goals/:id', route((req, res) => {
    const deleted = deleteProposal(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Proposal not found' });
    res.json({ deleted: req.params.id });
  }));
}

function parseJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return fallback; }
}
