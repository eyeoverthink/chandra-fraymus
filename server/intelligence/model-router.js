/**
 * Adaptive Model Router — intelligence-aware model selection.
 *
 * Replaces static model assignment with dynamic routing based on:
 *   - Task complexity (estimated from prompt length, tool usage, depth)
 *   - Historical performance (success rates per model from recent runs)
 *   - System load (Ollama model availability)
 *   - Intelligence state (Heart emotion intensity, active chain runs)
 *
 * The router maintains a performance ledger in SQLite and adapts model
 * selection over time. It exposes a simple `selectModel(task)` that
 * Motor and fleet runtime can call instead of hardcoding model names.
 */

import { db } from '../db.js';

const DEFAULT_MODEL = 'llama3.1:8b';
const FALLBACK_MODEL = 'llama3.1:8b';

const MODEL_TIERS = [
  { pattern: /70b|72b/i, tier: 'large', weight: 3, costFactor: 4.0 },
  { pattern: /34b|33b|27b|32b/i, tier: 'medium-large', weight: 2.5, costFactor: 2.5 },
  { pattern: /13b|14b/i, tier: 'medium', weight: 2, costFactor: 1.5 },
  { pattern: /8b|7b/i, tier: 'standard', weight: 1, costFactor: 1.0 },
  { pattern: /3b|4b|1b|2b/i, tier: 'small', weight: 0.5, costFactor: 0.3 },
];

const TASK_COMPLEXITY = {
  simple: { minTier: 'small', prefTier: 'standard', maxTokens: 500 },
  moderate: { minTier: 'standard', prefTier: 'standard', maxTokens: 2000 },
  complex: { minTier: 'standard', prefTier: 'medium', maxTokens: 4000 },
  expert: { minTier: 'medium', prefTier: 'medium-large', maxTokens: 8000 },
  critical: { minTier: 'medium', prefTier: 'large', maxTokens: 16000 },
};

const TIER_ORDER = ['small', 'standard', 'medium', 'medium-large', 'large'];

function ensureTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_routing_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type TEXT NOT NULL,
      complexity TEXT NOT NULL,
      model_selected TEXT NOT NULL,
      model_tier TEXT,
      success INTEGER DEFAULT 0,
      duration_ms INTEGER,
      token_estimate INTEGER,
      reason TEXT,
      created_at INTEGER NOT NULL
    )
  `);
}

function getModelTier(model) {
  for (const t of MODEL_TIERS) {
    if (t.pattern.test(model)) return t;
  }
  return { pattern: /.*/, tier: 'standard', weight: 1, costFactor: 1.0 };
}

function tierIndex(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx >= 0 ? idx : 1;
}

function estimateComplexity(task) {
  const prompt = task.prompt || task.command || '';
  const promptLen = prompt.length;
  const hasSystem = !!task.system;
  const toolCount = (task.tools || []).length;
  const depth = task.depth || 0;
  const isDebate = task.type === 'debate';
  const isChain = task.type === 'chain' || task.type === 'chain_stage';
  const isSynthesis = task.type === 'synthesis' || task.type === 'forge';
  const isReview = task.type === 'review' || task.type === 'verification';

  if (isDebate || isSynthesis) return 'expert';
  if (isChain && depth > 8) return 'complex';
  if (isChain) return 'moderate';
  if (isReview) return 'complex';

  let score = 0;
  if (promptLen > 4000) score += 3;
  else if (promptLen > 2000) score += 2;
  else if (promptLen > 500) score += 1;

  if (hasSystem) score += 1;
  if (toolCount > 5) score += 2;
  else if (toolCount > 0) score += 1;
  if (depth > 3) score += 1;

  if (score >= 6) return 'critical';
  if (score >= 4) return 'expert';
  if (score >= 2) return 'complex';
  if (score >= 1) return 'moderate';
  return 'simple';
}

async function getAvailableModels() {
  try {
    const url = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    const data = await res.json();
    return (data.models || []).map(m => m.name || m.model);
  } catch {
    return [];
  }
}

function getRecentPerformance(limit = 50) {
  ensureTable();
  try {
    return db.prepare(`
      SELECT model_selected, complexity,
             COUNT(*) as total,
             SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
             AVG(duration_ms) as avgDuration
      FROM model_routing_log
      WHERE created_at > ?
      GROUP BY model_selected, complexity
    `).all(Date.now() - 7 * 86400_000);
  } catch {
    return [];
  }
}

export async function selectModel(task = {}) {
  ensureTable();

  const explicitModel = task.model;
  if (explicitModel) {
    return { model: explicitModel, reason: 'explicit', complexity: estimateComplexity(task), tier: getModelTier(explicitModel).tier };
  }

  const complexity = estimateComplexity(task);
  const spec = TASK_COMPLEXITY[complexity] || TASK_COMPLEXITY.moderate;
  const available = await getAvailableModels();

  if (available.length === 0) {
    return { model: DEFAULT_MODEL, reason: 'no-models-detected', complexity, tier: 'standard' };
  }

  const scored = available.map(name => {
    const tierInfo = getModelTier(name);
    const tierIdx = tierIndex(tierInfo.tier);
    const prefIdx = tierIndex(spec.prefTier);
    const minIdx = tierIndex(spec.minTier);

    if (tierIdx < minIdx) return { name, score: -1, tier: tierInfo.tier };

    let score = 10 - Math.abs(tierIdx - prefIdx) * 2;

    const perf = getRecentPerformance().find(p => p.model_selected === name && p.complexity === complexity);
    if (perf && perf.total >= 3) {
      const successRate = perf.successes / perf.total;
      score += successRate * 5;
      if (perf.avgDuration < 10_000) score += 1;
    }

    score -= tierInfo.costFactor * 0.5;

    return { name, score, tier: tierInfo.tier, costFactor: tierInfo.costFactor };
  }).filter(m => m.score >= 0);

  if (scored.length === 0) {
    const allScored = available.map(name => {
      const tierInfo = getModelTier(name);
      const tierIdx = tierIndex(tierInfo.tier);
      return { name, tierIdx, tier: tierInfo.tier, costFactor: tierInfo.costFactor };
    });
    allScored.sort((a, b) => b.tierIdx - a.tierIdx || a.costFactor - b.costFactor);
    const fallback = allScored[0]?.name || FALLBACK_MODEL;
    return { model: fallback, reason: 'best-available-below-min', complexity, tier: getModelTier(fallback).tier };
  }

  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0];

  return {
    model: selected.name,
    reason: 'adaptive',
    complexity,
    tier: selected.tier,
    score: Math.round(selected.score * 100) / 100,
    candidates: scored.slice(0, 5).map(s => ({ model: s.name, tier: s.tier, score: Math.round(s.score * 100) / 100 })),
  };
}

export function logRouting({ taskType, complexity, model, tier, success, durationMs, tokenEstimate, reason }) {
  ensureTable();
  db.prepare(`INSERT INTO model_routing_log (task_type, complexity, model_selected, model_tier, success, duration_ms, token_estimate, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    taskType || 'unknown', complexity || 'moderate', model, tier || 'standard', success ? 1 : 0, durationMs || null, tokenEstimate || null, reason || '', Date.now(),
  );
}

export function routingStats({ days = 7 } = {}) {
  ensureTable();
  const since = Date.now() - days * 86400_000;

  const byModel = db.prepare(`
    SELECT model_selected as model, model_tier as tier,
           COUNT(*) as total,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
           ROUND(AVG(duration_ms)) as avgDuration
    FROM model_routing_log WHERE created_at > ?
    GROUP BY model_selected ORDER BY total DESC
  `).all(since);

  const byComplexity = db.prepare(`
    SELECT complexity,
           COUNT(*) as total,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
           ROUND(AVG(duration_ms)) as avgDuration
    FROM model_routing_log WHERE created_at > ?
    GROUP BY complexity ORDER BY total DESC
  `).all(since);

  const totalRouted = db.prepare(`SELECT COUNT(*) as c FROM model_routing_log WHERE created_at > ?`).get(since)?.c || 0;

  return { totalRouted, days, byModel, byComplexity };
}

export function installModelRouterRoutes(app) {
  ensureTable();

  app.post('/api/model-router/select', async (req, res, next) => {
    try {
      const result = await selectModel(req.body);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/model-router/stats', (req, res) => {
    const days = Math.min(30, Math.max(1, parseInt(req.query.days) || 7));
    res.json(routingStats({ days }));
  });

  app.get('/api/model-router/models', async (req, res) => {
    try {
      const models = await getAvailableModels();
      const enriched = models.map(name => {
        const tierInfo = getModelTier(name);
        return { name, tier: tierInfo.tier, costFactor: tierInfo.costFactor };
      });
      res.json({ models: enriched });
    } catch (e) { res.json({ models: [], error: e.message }); }
  });
}
