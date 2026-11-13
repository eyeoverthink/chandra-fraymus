/**
 * Autonomous Goal Engine — self-directed intelligence.
 *
 * Proposes what the fleet works on next, from the system's real, measured problems and the owner's
 * projects (goal-landscape.js). Every objective cites one of them and says how it will be checked;
 * objectives about the system's own memory labels are refused (78 % of a week's goals were, before).
 *
 * Inputs:  self_audit_findings, runs, capability_runs, smk_code_proposals, research_items, creation_jobs, data/projects.json
 * Outputs: goal proposals stored in goal_proposals table, optionally auto-queued
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { isActionSuppressed } from './adaptive-strategy.js';
import { publish } from '../fleet/bus.js';
import { tunable } from './tunables.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { realProblems, loadProjects, saveProjects, memoryCategories, checkObjective, sameJob } from './goal-landscape.js';
import { autonomyPaused } from '../awareness/protocol-engine.js';

const BASE_MAX_PROPOSALS = 2;

const now = () => Date.now();

// 2026-11-13: the engine used to be shown memory category names as "knowledge domains" and told to fill "gaps"
// between them; 78 % of a week's goals were about its own filing labels. It now sees real problems (P1…) and
// Vaughn's projects, and every objective must cite one and say how it will be checked (goal-landscape.js).
const GOAL_PROMPT = `You are the goal engine of Chandra-FRAYMUS, a local AI system with a fleet of agents that have real tools
(code, web, files, media, the store, the hive). You choose what the fleet works on next.

You receive two lists:
1. PROBLEMS — real, measured problems in the system, each with an id (P1, P2, …) and how fixing it is checked.
2. PROJECTS — the owner's projects, each with an id, its aim, where it lives, and how progress is checked.

Propose objectives that an agent can actually carry out with tools in one run, and that move one listed problem or project forward.
Rules:
- Every objective cites exactly one id from the lists in "grounded_in".
- Propose a mix: when you propose two or more, at least one must be for a PROJECT (cite its id), not only problems.
- Be concrete: name the file, route, tool, feature or error involved. No research programmes, no frameworks, no "unified models".
- The system's own memory categories and internal labels (such as dream, world, outcome, fossil) are NOT subjects to study.
- "done_when" says how anyone can check it was done (a test passes, a route answers, a finding resolves, a file exists).
- Anything that would publish, spend, or change the live store is phrased as preparing a proposal for the owner, never doing it.

Output JSON only, no markdown fences:
{
  "proposals": [
    {
      "objective": "one concrete thing to do",
      "grounded_in": "P3 or a project id",
      "done_when": "how to check it is done",
      "rationale": "why this is worth a run now",
      "priority": "high|medium|low",
      "estimated_complexity": "simple|moderate|complex"
    }
  ],
  "landscape_summary": "one or two sentences on what most needs work"
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


// Phase R: proposals are only worth generating if the executor can reach them.
// Generation ran ~1,000/day against ~288/day execution capacity; the backlog grew
// to 3,013 and the oldest proposals expired unread. Gate on queue depth.
const DEFAULT_MAX_PENDING = Math.max(1, parseInt(process.env.GOAL_MAX_PENDING) || 12);
const maxPending = () => tunable('goals.max_pending', DEFAULT_MAX_PENDING); // Phase Y: live tunable

export function pendingProposalCount() {
  ensureTable();
  return db.prepare(`SELECT COUNT(*) as c FROM goal_proposals WHERE status IN ('proposed', 'executing')`).get()?.c || 0;
}

export async function generateGoals({ trigger = 'daemon', force = false } = {}) {
  ensureTable();
  const pending = pendingProposalCount();
  if (!force && pending >= maxPending()) {
    return { generated: false, reason: 'queue_full', pending, maxPending: maxPending() };
  }
  // Phase V: generation has its own strategy key so conserve can stop proposals without stopping execution.
  if (!force && autonomyPaused()) {
    return { generated: false, reason: 'protocol_lockdown', pending, maxPending: maxPending() };
  }
  if (!force && isActionSuppressed('goal_generate')) {
    return { generated: false, reason: 'suppressed_by_strategy', pending, maxPending: maxPending() };
  }
  const problems = realProblems(db);
  const projects = loadProjects();
  const categories = memoryCategories(db);
  const landscape = { problems, projects, existingProposals: (() => {
    try { return db.prepare(`SELECT objective FROM goal_proposals WHERE status = 'proposed' ORDER BY created_at DESC LIMIT 6`).all().map(r => r.objective.slice(0, 160)); }
    catch (_) { return []; }
  })() };

  const gateMods = getAutonomyModifiers();
  const maxProposals = Math.min(5, Math.max(1, Math.round(BASE_MAX_PROPOSALS * gateMods.evolutionRate)));

  const tierContext = gateMods.tier === 'DORMANT' ? '\n\nThe system is in a cautious state: prefer small, safe fixes.' : '';
  const list = [
    'PROBLEMS:', ...(problems.length ? problems.map(p => `${p.id} [${p.kind}] ${p.text} — checked: ${p.check}`) : ['(none measured right now)']),
    '', 'PROJECTS:', ...projects.map(p => `${p.id}: ${p.name} — aim: ${p.aim} — where: ${p.where} — checked: ${p.check}`),
    '', 'ALREADY QUEUED (do not repeat):', ...(landscape.existingProposals.length ? landscape.existingProposals : ['(nothing)']),
  ].join('\n');

  const response = await chatOllama([
    { role: 'system', content: GOAL_PROMPT + tierContext },
    { role: 'user', content: `${list}\n\nPropose up to ${maxProposals} objectives.` },
  ], { priority: 'goal', label: `goal-engine:${trigger}`, format: 'json' });

  const parsed = parseJSON(response, { proposals: [], landscape_summary: 'Parse error' });
  const proposals = (parsed.proposals || []).slice(0, maxProposals);

  const stored = [], refused = [];
  for (const p of proposals) {
    if (!p || typeof p.objective !== 'string') continue;
    const check = checkObjective(p, { problems, projects, categories });
    if (!check.ok) { refused.push({ objective: String(p.objective).slice(0, 160), reason: check.reason }); continue; }
    // the agent that runs it sees how it will be judged
    p.objective = `${check.objective} (Done when: ${check.doneWhen})`;
    p.builds_on = check.ref;

    // Phase S: dedup across ALL statuses for 7 days (was: exact match on 'proposed' only, so
    // an objective expired or completed yesterday was re-proposed today — self-audit saw 13x).
    const exists = db.prepare(
      `SELECT 1 FROM goal_proposals WHERE lower(trim(objective)) = lower(trim(?)) AND created_at > ?`
    ).get(p.objective, now() - 7 * 86400_000);
    if (exists) continue;
    // the same job in other words, against the last 7 days and this batch
    const recent = db.prepare(`SELECT objective FROM goal_proposals WHERE created_at > ? ORDER BY created_at DESC LIMIT 200`).all(now() - 7 * 86400_000);
    if (recent.some(r => sameJob(r.objective, p.objective)) || stored.some(s => sameJob(s.objective, p.objective))) {
      refused.push({ objective: String(p.objective).slice(0, 160), reason: 'same job as a goal already proposed this week' });
      continue;
    }

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
      action: 'goals_generated', count: stored.length, trigger, refused: refused.length,
      proposals: stored.map(s => s.objective.slice(0, 100)),
      gateTier: gateMods.tier, maxProposals, at: now(),
    }));
  } catch (_) {}

  return {
    generated: stored.length > 0,
    count: stored.length,
    proposals: stored,
    refused,
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
  const valid = ['proposed', 'accepted', 'rejected', 'executing', 'completed', 'failed', 'blocked', 'expired', 'shelved'];
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

  app.post('/api/goals/generate', route(async (req, res) => {
    const result = await generateGoals({ trigger: 'api', force: req.body?.force === true });
    res.json(result);
  }));

  // What goals are drawn from: the measured problems right now and Vaughn's project list (data/projects.json).
  // Own prefix: /api/goals/:id below is a param route and would swallow /api/goals/landscape.
  app.get('/api/goal-engine/landscape', route((_req, res) => res.json({ problems: realProblems(db), projects: loadProjects() })));
  app.get('/api/goal-engine/projects', route((_req, res) => res.json({ projects: loadProjects() })));
  app.put('/api/goal-engine/projects', route((req, res) => {
    try { res.json({ projects: saveProjects(req.body?.projects) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
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
