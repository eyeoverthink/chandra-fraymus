import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { runAgentAndWait, listAgents } from '../fleet/runtime.js';
import { assessSituation } from './perspective.js';

const now = () => Date.now();

// ─── Schema ──────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS swarm_sessions (
    id TEXT PRIMARY KEY,
    task TEXT NOT NULL,
    context TEXT,
    agent_count INTEGER DEFAULT 0,
    perspective_mode TEXT DEFAULT 'diverse',
    status TEXT DEFAULT 'pending',
    contributions TEXT,
    synthesis TEXT,
    quality_score REAL,
    duration_ms INTEGER,
    created_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS swarm_contributions (
    id TEXT PRIMARY KEY,
    swarm_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    perspective TEXT,
    output TEXT,
    quality_score REAL,
    duration_ms INTEGER,
    created_at INTEGER
  );
`);

// ─── Perspective Assignment ──────────────────────────────────

const PERSPECTIVES = ['human', 'engineer', 'creative', 'strategic', 'meta', 'adversarial'];

function assignPerspectives(agentCount, mode) {
  if (mode === 'focused') return Array(agentCount).fill('engineer');
  // 'diverse' — cycle through all lenses to maximize coverage
  return Array.from({ length: agentCount }, (_, i) => PERSPECTIVES[i % PERSPECTIVES.length]);
}

function getPerspectiveInstruction(perspective) {
  const map = {
    human: 'Focus on user experience, empathy, accessibility, and how a real person would interact with this.',
    engineer: 'Focus on technical correctness, performance, reliability, edge cases, and maintainability.',
    creative: 'Focus on novel approaches, unconventional solutions, creative reframing, and innovation.',
    strategic: 'Focus on long-term implications, trade-offs, alignment with goals, and resource efficiency.',
    meta: 'Focus on the problem-solving process itself — are we asking the right question? What assumptions are we making?',
    adversarial: 'Focus on what could go wrong — attack vectors, failure modes, worst-case scenarios, and hidden risks.',
  };
  return map[perspective] || '';
}

// ─── Agent Selection ─────────────────────────────────────────
// Scores agents by keyword overlap with the task, picks the most relevant

function selectAgents(task, count) {
  const agents = listAgents('local');
  const taskLower = task.toLowerCase();
  const words = taskLower.match(/[a-z]{3,}/g) || [];

  const scored = agents.map(a => {
    const text = `${a.id} ${a.name} ${a.role || ''} ${a.description || ''}`.toLowerCase();
    const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
    return { agent: a, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, count).map(s => s.agent);

  if (selected.length < count) {
    const remaining = agents.filter(a => !selected.find(s => s.id === a.id));
    selected.push(...remaining.slice(0, count - selected.length));
  }

  return selected.slice(0, count);
}

// ─── Synthesis ───────────────────────────────────────────────

const SYNTHESIS_PROMPT = `You are the Swarm Synthesizer for a sovereign AI system. Multiple agents have approached the same task from different cognitive perspectives. Produce a single high-quality synthesis combining the best insights.

Rules:
1. Identify the strongest insights from each perspective
2. Resolve contradictions by favoring the most well-reasoned argument
3. Preserve unique insights that only one perspective caught
4. Produce a unified response better than any single contribution
5. Score each contribution 0.0–1.0 for relevance, depth, and uniqueness

Output ONLY valid JSON, no markdown fences:
{"synthesis": "merged response", "contributionScores": [{"agentId": "...", "perspective": "...", "score": 0.0, "reason": "..."}], "keyInsights": ["..."], "conflicts": ["..."]}`;

function parseJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return fallback; }
}

async function synthesizeContributions(task, contributions) {
  const contribText = contributions.map(c =>
    `--- Agent: ${c.agentId} | Perspective: ${c.perspective} ---\n${c.output}`
  ).join('\n\n');

  const response = await chatOllama([
    { role: 'system', content: SYNTHESIS_PROMPT },
    { role: 'user', content: `Task: ${task}\n\nContributions:\n${contribText}` },
  ]);

  return parseJSON(response, { synthesis: response, contributionScores: [], keyInsights: [], conflicts: [] });
}

// ─── Core Swarm ──────────────────────────────────────────────

export async function initiateSwarm({ task, context = '', agentCount = 3, perspectiveMode = 'diverse', timeoutMs = 180_000 }) {
  const swarmId = randomUUID().slice(0, 12);
  const t0 = now();
  const count = Math.min(6, Math.max(2, agentCount));

  const agents = selectAgents(task, count);
  let perspectives;

  if (perspectiveMode === 'auto') {
    try {
      const assessment = await assessSituation({ task, context });
      perspectives = (assessment.perspectives || []).slice(0, count);
      while (perspectives.length < count) perspectives.push(PERSPECTIVES[perspectives.length % PERSPECTIVES.length]);
    } catch (_) {
      perspectives = assignPerspectives(count, 'diverse');
    }
  } else {
    perspectives = assignPerspectives(count, perspectiveMode);
  }

  db.prepare(
    `INSERT INTO swarm_sessions (id, task, context, agent_count, perspective_mode, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`
  ).run(swarmId, task.slice(0, 4000), context.slice(0, 2000), count, perspectiveMode, t0);

  try {
    publish('system', 'system.swarm', JSON.stringify({ action: 'initiated', swarmId, agents: agents.map(a => a.id), perspectives, at: t0 }));
  } catch (_) {}

  // Run all agents in parallel — each gets the same task framed through a different lens
  const promises = agents.map((agent, i) => {
    const perspective = perspectives[i];
    const framedTask = `[Swarm task — ${perspective} perspective]\nApproach this from the ${perspective} perspective. ${getPerspectiveInstruction(perspective)}\n\nTask: ${task}${context ? `\n\nContext: ${context}` : ''}`;

    return runAgentAndWait('local', agent.id, framedTask, undefined, timeoutMs)
      .then(result => ({ agentId: agent.id, perspective, output: result.lastReply || '[no output]', status: result.status, durationMs: now() - t0 }))
      .catch(e => ({ agentId: agent.id, perspective, output: `[error: ${e.message}]`, status: 'error', durationMs: now() - t0 }));
  });

  const results = await Promise.allSettled(promises);
  const contributions = results.map(r => r.status === 'fulfilled' ? r.value : { agentId: 'unknown', perspective: 'unknown', output: '[promise rejected]', status: 'error', durationMs: 0 });

  for (const contrib of contributions) {
    db.prepare(
      `INSERT INTO swarm_contributions (id, swarm_id, agent_id, perspective, output, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID().slice(0, 12), swarmId, contrib.agentId, contrib.perspective, contrib.output?.slice(0, 8000), contrib.durationMs, now());
  }

  const synthesis = await synthesizeContributions(task, contributions);

  for (const score of (synthesis.contributionScores || [])) {
    try {
      db.prepare(`UPDATE swarm_contributions SET quality_score = ? WHERE swarm_id = ? AND agent_id = ?`)
        .run(score.score, swarmId, score.agentId);
    } catch (_) {}
  }

  const avgQuality = synthesis.contributionScores?.length > 0
    ? synthesis.contributionScores.reduce((s, c) => s + (c.score || 0), 0) / synthesis.contributionScores.length
    : null;

  const duration = now() - t0;

  db.prepare(
    `UPDATE swarm_sessions SET status = 'completed', contributions = ?, synthesis = ?, quality_score = ?, duration_ms = ? WHERE id = ?`
  ).run(
    JSON.stringify(contributions.map(c => ({ agent: c.agentId, perspective: c.perspective, status: c.status }))).slice(0, 8000),
    JSON.stringify(synthesis).slice(0, 16000),
    avgQuality, duration, swarmId
  );

  try {
    publish('system', 'system.swarm', JSON.stringify({
      action: 'completed', swarmId, agentCount: count,
      synthesisLength: (synthesis.synthesis || '').length,
      keyInsights: (synthesis.keyInsights || []).length,
      quality: avgQuality, durationMs: duration, at: now(),
    }));
  } catch (_) {}

  return {
    swarmId, task: task.slice(0, 200), agentCount: count, perspectives,
    contributions: contributions.map(c => ({ agent: c.agentId, perspective: c.perspective, status: c.status })),
    synthesis: synthesis.synthesis,
    keyInsights: synthesis.keyInsights || [],
    conflicts: synthesis.conflicts || [],
    quality: avgQuality, durationMs: duration,
  };
}

// ─── Queries ─────────────────────────────────────────────────

export function getSwarmSession(id) {
  const session = db.prepare(`SELECT * FROM swarm_sessions WHERE id = ?`).get(id);
  if (!session) return null;
  session.contributions_parsed = (() => { try { return JSON.parse(session.contributions || '[]'); } catch { return []; } })();
  session.synthesis_parsed = (() => { try { return JSON.parse(session.synthesis || '{}'); } catch { return {}; } })();
  session.fullContributions = db.prepare(`SELECT * FROM swarm_contributions WHERE swarm_id = ? ORDER BY created_at`).all(id);
  return session;
}

export function listSwarms({ limit = 20 } = {}) {
  return db.prepare(
    `SELECT id, task, agent_count, perspective_mode, status, quality_score, duration_ms, created_at FROM swarm_sessions ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(100, Math.max(1, limit)));
}

export function getSwarmStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM swarm_sessions`).get().c;
  const completed = db.prepare(`SELECT COUNT(*) as c FROM swarm_sessions WHERE status = 'completed'`).get().c;
  const avgQuality = db.prepare(`SELECT AVG(quality_score) as avg FROM swarm_sessions WHERE quality_score IS NOT NULL`).get().avg;
  const avgDuration = db.prepare(`SELECT AVG(duration_ms) as avg FROM swarm_sessions WHERE duration_ms IS NOT NULL`).get().avg;
  const totalContributions = db.prepare(`SELECT COUNT(*) as c FROM swarm_contributions`).get().c;
  const topAgents = db.prepare(
    `SELECT agent_id, COUNT(*) as runs, AVG(quality_score) as avg_quality FROM swarm_contributions WHERE quality_score IS NOT NULL GROUP BY agent_id ORDER BY avg_quality DESC LIMIT 5`
  ).all();
  const topPerspectives = db.prepare(
    `SELECT perspective, COUNT(*) as uses, AVG(quality_score) as avg_quality FROM swarm_contributions WHERE quality_score IS NOT NULL GROUP BY perspective ORDER BY avg_quality DESC`
  ).all();
  return { total, completed, avgQuality: avgQuality ? Math.round(avgQuality * 100) / 100 : null, avgDurationMs: avgDuration ? Math.round(avgDuration) : null, totalContributions, topAgents, topPerspectives };
}

// ─── Routes ──────────────────────────────────────────────────

export function installSwarmRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/intelligence/swarm', route(async (req, res) => {
    const { task, context, agentCount, perspectiveMode, timeoutMs } = req.body;
    if (!task) return res.status(400).json({ error: 'task required' });
    const result = await initiateSwarm({
      task, context: context || '',
      agentCount: parseInt(agentCount) || 3,
      perspectiveMode: perspectiveMode || 'diverse',
      timeoutMs: parseInt(timeoutMs) || 180_000,
    });
    res.json(result);
  }));

  app.get('/api/intelligence/swarm/stats', route((_req, res) => {
    res.json(getSwarmStats());
  }));

  app.get('/api/intelligence/swarms', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ swarms: listSwarms({ limit }) });
  }));

  // :id must come after /stats and /swarms to avoid param swallowing
  app.get('/api/intelligence/swarm/:id', route((req, res) => {
    const session = getSwarmSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Swarm session not found' });
    res.json(session);
  }));
}
