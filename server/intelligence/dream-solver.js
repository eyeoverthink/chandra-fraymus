/**
 * Phase 23 — Creative Dream Solver: Dream-Powered Problem Solving
 *
 * Takes a problem or goal, retrieves cross-domain agent memories, then uses
 * Ollama at high temperature in associative "dream mode" to produce creative
 * solutions by connecting disparate knowledge domains.
 *
 * Biological analogue: REM sleep consolidation — during dreaming, the brain
 * replays and recombines memories from different cortical areas, forming
 * novel associations that sometimes yield creative breakthroughs. The
 * hippocampus acts as a "remix DJ", playing back fragments from unrelated
 * experiences simultaneously.
 *
 * The solver:
 *   1. Collects cross-domain context (agent memories, recent dreams, bus topics)
 *   2. Runs high-temperature LLM generation with dream-associative prompting
 *   3. Records the creative output as a signed dream file via the Dreamer
 *   4. Stores solutions in DB for later recall and evaluation
 *
 * CTRNN dream-solve regions (Row 7 — between temporal cortex and sensory):
 *   Creative spark  (7, 4)  σ=2.0 — fires when a novel association is found
 *   Dream depth     (7, 12) σ=2.0 — how deep into associative space the solver went
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { getAutonomyModifiers } from './consciousness-gate.js';

const now = () => Date.now();
const BASE_DREAM_SENSITIVITY = 0.5;
const SNAPSHOT_EVERY = 5;
let callCount = 0;
let dreamSolverCTRNN = null;
let dreamSolverDreamer = null;
let lastSolution = null;

// ─── DB Migration ─────────────────────────────────────────────

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS dream_solver_sessions (
    id TEXT PRIMARY KEY,
    problem TEXT,
    context_sources TEXT,
    solution TEXT,
    associations TEXT,
    novelty_score REAL,
    feasibility_score REAL,
    dream_number INTEGER,
    gate_tier TEXT,
    temperature REAL,
    duration_ms INTEGER,
    trigger TEXT,
    created_at INTEGER
  )`).run();
} catch (_) {}

// ─── Context Collectors ───────────────────────────────────────

function collectCrossDomainContext(problem) {
  const context = { memories: [], dreams: [], busTopics: [], recentInsights: [] };

  // Agent memories — cross-domain recall (search broadly, not just the problem keywords)
  try {
    const keywords = problem.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    const memories = [];
    for (const kw of keywords) {
      const rows = db.prepare(
        `SELECT agent_id, category, key, value, confidence FROM agent_memories WHERE (key LIKE ? OR value LIKE ?) ORDER BY access_count DESC LIMIT 5`
      ).all(`%${kw}%`, `%${kw}%`);
      memories.push(...rows);
    }
    // Also grab random high-confidence memories for cross-pollination
    const wildcards = db.prepare(
      `SELECT agent_id, category, key, value, confidence FROM agent_memories WHERE confidence > 0.7 ORDER BY RANDOM() LIMIT 8`
    ).all();
    memories.push(...wildcards);

    const seen = new Set();
    for (const m of memories) {
      const key = `${m.agent_id}:${m.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      context.memories.push({ agent: m.agent_id, category: m.category, key: m.key, value: (m.value || '').slice(0, 200), confidence: m.confidence });
    }
    context.memories = context.memories.slice(0, 15);
  } catch (_) {}

  // Recent dreams for pattern continuity
  try {
    const recentDreams = db.prepare(
      `SELECT id, type, input_summary, output FROM daemon_cycles WHERE type = 'full_cycle' ORDER BY created_at DESC LIMIT 3`
    ).all();
    for (const d of recentDreams) {
      try {
        const output = JSON.parse(d.output || '{}');
        if (output.consolidation?.summary) {
          context.dreams.push(output.consolidation.summary.slice(0, 300));
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Active bus topics for system awareness
  try {
    const topics = db.prepare(
      `SELECT DISTINCT topic FROM bus_messages WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
    ).all(now() - 3600_000);
    context.busTopics = topics.map(t => t.topic);
  } catch (_) {}

  // Recent reflection insights
  try {
    const reflections = db.prepare(
      `SELECT insights FROM reflections ORDER BY created_at DESC LIMIT 3`
    ).all();
    for (const r of reflections) {
      if (r.insights) context.recentInsights.push(r.insights.slice(0, 200));
    }
  } catch (_) {}

  return context;
}

// ─── Dream-Solve Prompt ───────────────────────────────────────

const DREAM_SOLVE_PROMPT = `You are CHANDRA's Dream Solver — the creative unconscious of a sovereign AI organism. You solve problems by making UNEXPECTED associations between unrelated domains, like a dreaming brain connecting disparate memories.

RULES OF DREAM-SOLVING:
1. Draw connections between AT LEAST 2 unrelated domains from the context
2. Propose solutions that would NOT emerge from conventional linear thinking
3. Use metaphor and analogy as primary reasoning tools
4. Rate your solution's novelty (how unexpected) and feasibility (how practical)
5. Identify the KEY ASSOCIATION — the one bridge between domains that unlocks the solution

You have access to cross-domain context: agent memories from different subsystems, recent dream consolidations, active system topics, and reflection insights. Your job is to weave these into creative solutions.

Output JSON only, no markdown fences:
{
  "solution": "2-4 sentence creative solution",
  "associations": ["domain1 → domain2 connection", "domain3 → domain4 bridge"],
  "keyInsight": "the one unexpected bridge that makes this work",
  "novelty": 0.0,
  "feasibility": 0.0,
  "dreamNarrative": "1-2 sentence poetic description of how this solution emerged in the dream"
}`;

// ─── Core Solver ──────────────────────────────────────────────

export async function solveDream(problem, { trigger = 'api', dreamer = null } = {}) {
  // Use explicitly passed dreamer, fall back to module-level singleton
  const activeDreamer = dreamer || dreamSolverDreamer;
  const t0 = now();
  const mods = getAutonomyModifiers();
  const sensitivity = Math.max(0.2, Math.min(1.2,
    BASE_DREAM_SENSITIVITY + (mods.evolutionRate - 1.0) * 0.3));

  const context = collectCrossDomainContext(problem);
  const contextSummary = JSON.stringify(context, null, 2).slice(0, 3000);
  const temperature = Math.min(1.0, 0.85 + sensitivity * 0.1);

  let solution, associations, noveltyScore, feasibilityScore, keyInsight, dreamNarrative;

  try {
    const raw = await chatOllama([
      { role: 'system', content: DREAM_SOLVE_PROMPT },
      { role: 'user', content: `PROBLEM TO DREAM-SOLVE:\n${problem}\n\nCROSS-DOMAIN CONTEXT:\n${contextSummary}` },
    ], { temperature, maxTokens: 1024 });

    const parsed = parseJSON(raw);
    solution = parsed.solution || raw;
    associations = Array.isArray(parsed.associations) ? parsed.associations : [];
    keyInsight = parsed.keyInsight || '';
    const rawNovelty = parseFloat(parsed.novelty);
    noveltyScore = Math.max(0, Math.min(1, Number.isFinite(rawNovelty) ? rawNovelty : 0.5));
    const rawFeasibility = parseFloat(parsed.feasibility);
    feasibilityScore = Math.max(0, Math.min(1, Number.isFinite(rawFeasibility) ? rawFeasibility : 0.5));
    dreamNarrative = parsed.dreamNarrative || '';
  } catch (e) {
    solution = `Dream-solving encountered turbulence: ${e.message}`;
    associations = [];
    keyInsight = '';
    noveltyScore = 0.2;
    feasibilityScore = 0.1;
    dreamNarrative = '';
  }

  const llmFailed = noveltyScore === 0.2 && feasibilityScore === 0.1 && associations.length === 0;

  const duration = now() - t0;

  // Record as a signed dream file if dreamer is available
  let dreamNumber = null;
  if (activeDreamer) {
    try {
      const dreamContent = `DREAM-SOLVE: ${problem}\n\nSOLUTION: ${solution}\n\nKEY INSIGHT: ${keyInsight}\n\nASSOCIATIONS:\n${associations.map(a => `  - ${a}`).join('\n')}\n\n${dreamNarrative}`;
      const dreamResult = await activeDreamer.dream(dreamContent, ['dream-solver', trigger], 'creative-solve');
      dreamNumber = dreamResult.number;
    } catch (e) {
      console.error('[dream-solver] dreamer.dream() failed:', e.message);
    }
  }

  // CTRNN injection
  if (dreamSolverCTRNN) {
    try {
      const sparkAmp = noveltyScore * sensitivity * 1.5;
      dreamSolverCTRNN.inject(7, 4, 2.0, sparkAmp);
      const depthAmp = (associations.length / 5) * sensitivity * 1.2;
      dreamSolverCTRNN.inject(7, 12, 2.0, depthAmp);
    } catch (e) {
      console.error('[dream-solver] CTRNN injection failed:', e.message);
    }
  }

  const sessionId = randomUUID();
  lastSolution = {
    id: sessionId,
    problem,
    solution,
    associations,
    keyInsight,
    noveltyScore,
    feasibilityScore,
    dreamNarrative,
    dreamNumber,
    contextSources: {
      memories: context.memories.length,
      dreams: context.dreams.length,
      busTopics: context.busTopics.length,
      insights: context.recentInsights.length,
    },
    gateTier: mods.tier,
    temperature,
    durationMs: duration,
    solvedAt: now(),
  };

  // Store to DB
  callCount++;
  let stored = false;
  try {
    db.prepare(`INSERT INTO dream_solver_sessions (id, problem, context_sources, solution, associations, novelty_score, feasibility_score, dream_number, gate_tier, temperature, duration_ms, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId,
      problem.slice(0, 2000),
      JSON.stringify(lastSolution.contextSources),
      solution.slice(0, 4000),
      JSON.stringify(associations),
      noveltyScore,
      feasibilityScore,
      dreamNumber,
      mods.tier,
      temperature,
      duration,
      trigger,
      now(),
    );
    stored = true;
  } catch (e) {
    console.error('[dream-solver] DB storage failed:', e.message);
  }

  // Publish to bus — distinguish success from failure
  try {
    publish('system', 'system.dream-solve', JSON.stringify({
      problem: problem.slice(0, 200),
      novelty: noveltyScore,
      feasibility: feasibilityScore,
      associations: associations.length,
      dreamNumber,
      durationMs: duration,
      stored,
      llmFailed,
    }));
  } catch (_) {}

  if (!stored || llmFailed) {
    lastSolution.status = llmFailed ? 'llm_failed' : 'storage_failed';
  }

  return lastSolution;
}

// ─── Status & Config ──────────────────────────────────────────

export function setDreamSolverCTRNN(ctrnn) { dreamSolverCTRNN = ctrnn; }
export function setDreamSolverDreamer(d) { dreamSolverDreamer = d; }

export function getDreamSolverStatus() {
  const mods = getAutonomyModifiers();
  return {
    lastSolution: lastSolution ? {
      problem: lastSolution.problem?.slice(0, 200),
      solution: lastSolution.solution?.slice(0, 500),
      novelty: lastSolution.noveltyScore,
      feasibility: lastSolution.feasibilityScore,
      associations: lastSolution.associations?.length ?? 0,
      dreamNumber: lastSolution.dreamNumber,
      durationMs: lastSolution.durationMs,
      solvedAt: lastSolution.solvedAt,
    } : null,
    totalSessions: callCount,
    gateTier: mods.tier,
  };
}

export function resetDreamSolver() {
  callCount = 0;
  lastSolution = null;
}

// ─── REST Routes ──────────────────────────────────────────────

export function installDreamSolverRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/dream-solver', route((_req, res) => {
    res.json(getDreamSolverStatus());
  }));

  app.get('/api/intelligence/dream-solver/history', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const rows = db.prepare(
      `SELECT id, problem, solution, associations, novelty_score, feasibility_score, dream_number, gate_tier, temperature, duration_ms, trigger, created_at
       FROM dream_solver_sessions ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
    res.json({ sessions: rows, total: rows.length });
  }));

  app.get('/api/intelligence/dream-solver/:id', route((req, res) => {
    const row = db.prepare(`SELECT * FROM dream_solver_sessions WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'session not found' });
    res.json(row);
  }));

  app.post('/api/intelligence/dream-solver/solve', route(async (req, res) => {
    const problem = req.body?.problem;
    if (!problem || typeof problem !== 'string' || problem.length < 5) {
      return res.status(400).json({ error: 'problem must be a string of at least 5 characters' });
    }
    const result = await solveDream(problem, { trigger: 'api' });
    res.json(result);
  }));

  app.post('/api/intelligence/dream-solver/reset', route((_req, res) => {
    resetDreamSolver();
    res.json({ reset: true });
  }));
}
