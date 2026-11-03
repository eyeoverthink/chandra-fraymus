import { db } from '../db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS trust_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'general',
    score REAL NOT NULL DEFAULT 0.5,
    confidence REAL NOT NULL DEFAULT 0.0,
    successes INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    total_runs INTEGER NOT NULL DEFAULT 0,
    avg_quality REAL,
    avg_duration_ms REAL,
    last_updated TEXT DEFAULT (datetime('now')),
    UNIQUE(agent_id, domain)
  );
  CREATE TABLE IF NOT EXISTS trust_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'general',
    task TEXT NOT NULL,
    outcome TEXT NOT NULL,
    quality REAL,
    duration_ms INTEGER,
    source TEXT DEFAULT 'fleet',
    weight REAL DEFAULT 1.0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_trust_events_agent ON trust_events(agent_id, domain);
  CREATE INDEX IF NOT EXISTS idx_trust_scores_agent ON trust_scores(agent_id);
`);

const DECAY_HALF_LIFE_DAYS = 14;
const MIN_CONFIDENCE = 0.0;
const MAX_CONFIDENCE = 1.0;
const PRIOR_SCORE = 0.5;
const PRIOR_WEIGHT = 2;

function bayesianUpdate(prior, successes, failures, priorWeight) {
  const alpha = priorWeight * prior + successes;
  const beta = priorWeight * (1 - prior) + failures;
  return alpha / (alpha + beta);
}

function computeConfidence(totalRuns, decayedRuns) {
  const effective = Math.min(decayedRuns, totalRuns);
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, 1 - 1 / (1 + effective * 0.3)));
}

function decayWeight(ageMs) {
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

export function recordEvent({ agentId, domain = 'general', task, outcome, quality, durationMs, source = 'fleet', weight = 1.0 }) {
  if (!agentId || !task || !outcome) throw new Error('agentId, task, and outcome are required');
  const validOutcomes = ['success', 'failure', 'partial', 'error', 'timeout'];
  if (!validOutcomes.includes(outcome)) throw new Error(`outcome must be one of: ${validOutcomes.join(', ')}`);

  db.prepare(
    `INSERT INTO trust_events (agent_id, domain, task, outcome, quality, duration_ms, source, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, domain, task, outcome, quality ?? null, durationMs ?? null, source, weight);

  recomputeScore(agentId, domain);

  try {
    import('../fleet/bus.js').then(({ publish }) => {
      publish('trust-engine', 'system.trust', { agentId, domain, outcome, quality });
    });
  } catch {}
}

function recomputeScore(agentId, domain) {
  const events = db.prepare(
    `SELECT outcome, quality, weight, created_at FROM trust_events WHERE agent_id = ? AND domain = ? ORDER BY created_at DESC LIMIT 200`
  ).all(agentId, domain);

  if (events.length === 0) return;

  const now = Date.now();
  let weightedSuccesses = 0;
  let weightedFailures = 0;
  let decayedRuns = 0;
  let qualitySum = 0;
  let qualityCount = 0;
  let durationSum = 0;
  let durationCount = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;

  for (const ev of events) {
    const ageMs = now - new Date(ev.created_at + 'Z').getTime();
    const decay = decayWeight(ageMs);
    const w = (ev.weight || 1.0) * decay;
    decayedRuns += w;

    if (ev.outcome === 'success') {
      weightedSuccesses += w;
      totalSuccesses++;
    } else if (ev.outcome === 'failure' || ev.outcome === 'error' || ev.outcome === 'timeout') {
      weightedFailures += w;
      totalFailures++;
    } else if (ev.outcome === 'partial') {
      weightedSuccesses += w * 0.5;
      weightedFailures += w * 0.5;
    }

    if (ev.quality != null) { qualitySum += ev.quality * w; qualityCount += w; }
  }

  const allEvents = db.prepare(
    `SELECT duration_ms FROM trust_events WHERE agent_id = ? AND domain = ? AND duration_ms IS NOT NULL ORDER BY created_at DESC LIMIT 50`
  ).all(agentId, domain);
  for (const ev of allEvents) {
    if (ev.duration_ms != null) { durationSum += ev.duration_ms; durationCount++; }
  }

  const score = bayesianUpdate(PRIOR_SCORE, weightedSuccesses, weightedFailures, PRIOR_WEIGHT);
  const confidence = computeConfidence(events.length, decayedRuns);
  const avgQuality = qualityCount > 0 ? qualitySum / qualityCount : null;
  const avgDuration = durationCount > 0 ? durationSum / durationCount : null;

  db.prepare(`
    INSERT INTO trust_scores (agent_id, domain, score, confidence, successes, failures, total_runs, avg_quality, avg_duration_ms, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(agent_id, domain) DO UPDATE SET
      score = excluded.score,
      confidence = excluded.confidence,
      successes = excluded.successes,
      failures = excluded.failures,
      total_runs = excluded.total_runs,
      avg_quality = excluded.avg_quality,
      avg_duration_ms = excluded.avg_duration_ms,
      last_updated = datetime('now')
  `).run(agentId, domain, score, confidence, totalSuccesses, totalFailures, events.length, avgQuality, avgDuration);
}

export function getAgentTrust(agentId, domain) {
  if (domain) {
    const row = db.prepare(`SELECT * FROM trust_scores WHERE agent_id = ? AND domain = ?`).get(agentId, domain);
    return row || { agent_id: agentId, domain, score: PRIOR_SCORE, confidence: 0, successes: 0, failures: 0, total_runs: 0 };
  }
  const rows = db.prepare(`SELECT * FROM trust_scores WHERE agent_id = ? ORDER BY total_runs DESC`).all(agentId);
  if (rows.length === 0) return [{ agent_id: agentId, domain: 'general', score: PRIOR_SCORE, confidence: 0, successes: 0, failures: 0, total_runs: 0 }];
  return rows;
}

export function getLeaderboard({ domain, limit = 20 } = {}) {
  if (domain) {
    return db.prepare(
      `SELECT * FROM trust_scores WHERE domain = ? ORDER BY score DESC, confidence DESC LIMIT ?`
    ).all(domain, limit);
  }
  return db.prepare(`
    SELECT agent_id,
      AVG(score) as score,
      AVG(confidence) as confidence,
      SUM(successes) as successes,
      SUM(failures) as failures,
      SUM(total_runs) as total_runs,
      AVG(avg_quality) as avg_quality
    FROM trust_scores
    GROUP BY agent_id
    ORDER BY AVG(score) DESC, SUM(total_runs) DESC
    LIMIT ?
  `).all(limit);
}

export function recommendAgents({ domain = 'general', count = 3, minConfidence = 0.1 } = {}) {
  const candidates = db.prepare(`
    SELECT * FROM trust_scores
    WHERE domain = ? AND confidence >= ?
    ORDER BY score DESC, confidence DESC
    LIMIT ?
  `).all(domain, minConfidence, count * 2);

  if (candidates.length < count) {
    const general = db.prepare(`
      SELECT * FROM trust_scores
      WHERE domain = 'general' AND confidence >= ?
      AND agent_id NOT IN (SELECT agent_id FROM trust_scores WHERE domain = ?)
      ORDER BY score DESC LIMIT ?
    `).all(minConfidence, domain, count - candidates.length);
    candidates.push(...general);
  }

  return candidates.slice(0, count).map(c => ({
    agentId: c.agent_id,
    domain: c.domain,
    score: c.score,
    confidence: c.confidence,
    totalRuns: c.total_runs,
    reasoning: c.confidence >= 0.5
      ? `Proven performer: ${Math.round(c.score * 100)}% trust (${c.total_runs} runs)`
      : `Limited data: ${Math.round(c.score * 100)}% trust (${c.total_runs} runs)`,
  }));
}

export function getAgentHistory(agentId, { domain, limit = 50 } = {}) {
  if (domain) {
    return db.prepare(
      `SELECT * FROM trust_events WHERE agent_id = ? AND domain = ? ORDER BY created_at DESC LIMIT ?`
    ).all(agentId, domain, limit);
  }
  return db.prepare(
    `SELECT * FROM trust_events WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`
  ).all(agentId, limit);
}

export function getTrustStats() {
  const totalAgents = db.prepare(`SELECT COUNT(DISTINCT agent_id) as c FROM trust_scores`).get().c;
  const totalEvents = db.prepare(`SELECT COUNT(*) as c FROM trust_events`).get().c;
  const totalDomains = db.prepare(`SELECT COUNT(DISTINCT domain) as c FROM trust_scores`).get().c;
  const avgScore = db.prepare(`SELECT AVG(score) as v FROM trust_scores WHERE total_runs > 0`).get().v;
  const avgConfidence = db.prepare(`SELECT AVG(confidence) as v FROM trust_scores WHERE total_runs > 0`).get().v;

  const domainBreakdown = db.prepare(`
    SELECT domain, COUNT(*) as agents, AVG(score) as avg_score, SUM(total_runs) as total_runs
    FROM trust_scores WHERE total_runs > 0
    GROUP BY domain ORDER BY total_runs DESC LIMIT 10
  `).all();

  const recentEvents = db.prepare(`
    SELECT outcome, COUNT(*) as count FROM trust_events
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY outcome
  `).all();

  const topAgents = db.prepare(`
    SELECT agent_id, AVG(score) as score, SUM(total_runs) as runs
    FROM trust_scores WHERE total_runs > 0
    GROUP BY agent_id ORDER BY AVG(score) DESC LIMIT 5
  `).all();

  return { totalAgents, totalEvents, totalDomains, avgScore, avgConfidence, domainBreakdown, recentEvents, topAgents };
}

export function pruneOldEvents(olderThanDays = 60) {
  const result = db.prepare(
    `DELETE FROM trust_events WHERE created_at < datetime('now', '-' || ? || ' days')`
  ).run(olderThanDays);
  return { deleted: result.changes };
}

export function installTrustRoutes(app) {
  app.get('/api/intelligence/trust/stats', (_req, res, next) => {
    try { res.json(getTrustStats()); } catch (e) { next(e); }
  });

  app.get('/api/intelligence/trust/leaderboard', (req, res, next) => {
    try {
      const domain = req.query.domain || undefined;
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      res.json({ leaderboard: getLeaderboard({ domain, limit }) });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/trust/recommend', (req, res, next) => {
    try {
      const domain = req.query.domain || 'general';
      const count = Math.min(10, Math.max(1, parseInt(req.query.count) || 3));
      const minConfidence = Math.max(0, Math.min(1, parseFloat(req.query.minConfidence) || 0.1));
      res.json({ recommendations: recommendAgents({ domain, count, minConfidence }) });
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/trust/agent/:agentId', (req, res, next) => {
    try {
      const domain = req.query.domain || undefined;
      const trust = getAgentTrust(req.params.agentId, domain);
      res.json(Array.isArray(trust) ? { domains: trust } : trust);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/trust/agent/:agentId/history', (req, res, next) => {
    try {
      const domain = req.query.domain || undefined;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      res.json({ events: getAgentHistory(req.params.agentId, { domain, limit }) });
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/trust/record', async (req, res, next) => {
    try {
      const { agentId, domain, task, outcome, quality, durationMs, source } = req.body;
      if (!agentId || !task || !outcome) return res.status(400).json({ error: 'agentId, task, and outcome are required' });
      recordEvent({ agentId, domain, task, outcome, quality, durationMs, source });
      const trust = getAgentTrust(agentId, domain || 'general');
      res.json({ recorded: true, trust: Array.isArray(trust) ? trust[0] : trust });
    } catch (e) { next(e); }
  });
}
