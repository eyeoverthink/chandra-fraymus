/**
 * Phase 14 — Metacognitive Monitor: Self-Assessment & Strategy Adjustment
 *
 * Monitors the quality of the system's own cognitive outputs — agent runs,
 * reflections, verifier loops, forged agents, synthesized workflows — and
 * computes three metacognitive signals injected into CTRNN "prefrontal"
 * regions. Detects pathological patterns (stuck loops, repeated failures,
 * diminishing returns) and publishes strategy adjustments.
 *
 * Biological analogy:
 *   Prefrontal cortex metacognitive monitoring — "thinking about thinking."
 *   Anterior cingulate cortex conflict monitoring — detecting when current
 *   strategy isn't working. Error-related negativity (ERN) — automatic
 *   detection of mistakes in cognitive processing.
 *
 * Metacognitive CTRNN regions (row 4 — above sensory, below temporal):
 *   Effectiveness    (4, 4)   σ=2.0  — cognitive action success rate
 *   Stuck detection  (4, 8)   σ=1.5  — loop/stagnation signal (inhibitory)
 *   Confidence       (4, 12)  σ=1.5  — prediction-outcome calibration
 *
 * Runs on its own 30-second interval (cognitive quality changes slowly).
 * Consciousness-aware: gate evolutionRate scales metacognitive sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const METACOG_INTERVAL_MS = 30_000;
const SNAPSHOT_EVERY = 30;
const ASSESSMENT_WINDOW_MS = 30 * 60_000;
const BASE_METACOG_SENSITIVITY = 0.5;
const STUCK_THRESHOLD = 0.6;
const LOW_EFFECTIVENESS_THRESHOLD = 0.3;

const METACOG_REGIONS = {
  effectiveness: { tx: 4, ty: 4,  sigma: 2.0, label: 'Cognitive effectiveness' },
  stuck:         { tx: 4, ty: 8,  sigma: 1.5, label: 'Stuck detection' },
  confidence:    { tx: 4, ty: 12, sigma: 1.5, label: 'Confidence calibration' },
};

let metacogTimer = null;
let metacogState = {
  running: false,
  assessments: 0,
  lastEffectiveness: 0,
  lastStuckScore: 0,
  lastConfidence: 0.5,
  lastInjections: {},
  lastAssessedAt: 0,
  lastStrategy: null,
  strategyChanges: 0,
  startedAt: 0,
};

const recentActionTypes = [];
const MAX_ACTION_HISTORY = 20;

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS metacognitive_events (
      id TEXT PRIMARY KEY,
      effectiveness REAL,
      stuck_score REAL,
      confidence REAL,
      injections TEXT,
      strategy TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      assessment_data TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_metacog_ts ON metacognitive_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function assessEffectiveness() {
  const windowStart = now() - ASSESSMENT_WINDOW_MS;
  const metrics = {};

  try {
    const total = db.prepare(
      `SELECT COUNT(*) as c FROM runs WHERE created_at > ?`
    ).get(windowStart)?.c || 0;
    const succeeded = db.prepare(
      `SELECT COUNT(*) as c FROM runs WHERE created_at > ? AND status = 'completed'`
    ).get(windowStart)?.c || 0;
    metrics.runSuccess = total > 0 ? succeeded / total : 0.5;
    metrics.runCount = total;
  } catch (_) { metrics.runSuccess = 0.5; metrics.runCount = 0; }

  try {
    const total = db.prepare(
      `SELECT COUNT(*) as c FROM verification_loops WHERE created_at > ?`
    ).get(windowStart)?.c || 0;
    const approved = db.prepare(
      `SELECT COUNT(*) as c FROM verification_loops WHERE created_at > ? AND status = 'APPROVED'`
    ).get(windowStart)?.c || 0;
    metrics.verifySuccess = total > 0 ? approved / total : 0.5;
    metrics.verifyCount = total;
  } catch (_) { metrics.verifySuccess = 0.5; metrics.verifyCount = 0; }

  try {
    const reflections = db.prepare(
      `SELECT actions_taken FROM reflections WHERE created_at > ? ORDER BY created_at DESC LIMIT 5`
    ).all(windowStart);
    if (reflections.length > 0) {
      let totalActions = 0;
      for (const r of reflections) {
        try {
          const actions = JSON.parse(r.actions_taken || '[]');
          totalActions += Array.isArray(actions) ? actions.length : 0;
        } catch (_) {}
      }
      metrics.reflectionDensity = clamp(totalActions / (reflections.length * 5), 0, 1);
    } else {
      metrics.reflectionDensity = 0;
    }
    metrics.reflectionCount = reflections.length;
  } catch (_) { metrics.reflectionDensity = 0; metrics.reflectionCount = 0; }

  try {
    const total = db.prepare(
      `SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ?`
    ).get(windowStart)?.c || 0;
    const completed = db.prepare(
      `SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ? AND status = 'completed'`
    ).get(windowStart)?.c || 0;
    metrics.workflowSuccess = total > 0 ? completed / total : 0.5;
    metrics.workflowCount = total;
  } catch (_) { metrics.workflowSuccess = 0.5; metrics.workflowCount = 0; }

  const totalActivity = metrics.runCount + metrics.verifyCount + metrics.reflectionCount + metrics.workflowCount;
  if (totalActivity === 0) return { effectiveness: 0.5, metrics };

  const effectiveness = (
    metrics.runSuccess * 0.35 +
    metrics.verifySuccess * 0.25 +
    metrics.reflectionDensity * 0.20 +
    metrics.workflowSuccess * 0.20
  );

  return { effectiveness: Math.round(effectiveness * 1000) / 1000, metrics };
}

function assessStuckness() {
  const windowStart = now() - ASSESSMENT_WINDOW_MS;
  let stuckSignals = 0;
  let totalChecks = 0;

  if (recentActionTypes.length >= 6) {
    const last6 = recentActionTypes.slice(-6);
    const uniqueTypes = new Set(last6).size;
    if (uniqueTypes <= 2) stuckSignals++;
    totalChecks++;
  }

  try {
    const forged = db.prepare(
      `SELECT COUNT(*) as c FROM forged_agents WHERE created_at > ?`
    ).get(windowStart)?.c || 0;
    if (forged > 2) {
      const forgedIds = db.prepare(
        `SELECT agent_id FROM forged_agents WHERE created_at > ?`
      ).all(windowStart).map(r => r.agent_id);
      let unused = 0;
      for (const id of forgedIds) {
        const used = db.prepare(
          `SELECT COUNT(*) as c FROM runs WHERE agent_id = ? AND created_at > ?`
        ).get(id, windowStart)?.c || 0;
        if (used === 0) unused++;
      }
      if (unused > forged * 0.6) stuckSignals++;
      totalChecks++;
    }
  } catch (_) {}

  try {
    const emptyReflections = db.prepare(
      `SELECT COUNT(*) as c FROM reflections WHERE created_at > ? AND (actions_taken = '[]' OR actions_taken IS NULL)`
    ).get(windowStart)?.c || 0;
    const totalReflections = db.prepare(
      `SELECT COUNT(*) as c FROM reflections WHERE created_at > ?`
    ).get(windowStart)?.c || 0;
    if (totalReflections > 2 && emptyReflections > totalReflections * 0.5) stuckSignals++;
    totalChecks++;
  } catch (_) {}

  try {
    const recentFails = db.prepare(
      `SELECT COUNT(*) as c FROM verification_loops WHERE created_at > ? AND status != 'APPROVED'`
    ).get(windowStart)?.c || 0;
    if (recentFails >= 3) stuckSignals++;
    totalChecks++;
  } catch (_) {}

  try {
    const totalProposals = db.prepare(
      `SELECT COUNT(*) as c FROM opeg_proposals WHERE created_at > ?`
    ).get(windowStart)?.c || 0;
    const rejected = db.prepare(
      `SELECT COUNT(*) as c FROM opeg_proposals WHERE created_at > ? AND state = 'S4_REJECTED'`
    ).get(windowStart)?.c || 0;
    if (totalProposals > 2 && rejected > totalProposals * 0.6) stuckSignals++;
    totalChecks++;
  } catch (_) {}

  const stuckScore = totalChecks > 0 ? stuckSignals / totalChecks : 0;
  return Math.round(stuckScore * 1000) / 1000;
}

function assessConfidence() {
  const windowStart = now() - ASSESSMENT_WINDOW_MS;

  try {
    const proposals = db.prepare(
      `SELECT state, sanitize_verdict FROM opeg_proposals WHERE created_at > ? AND state IN ('S4_UPDATED', 'S4_REJECTED') LIMIT 10`
    ).all(windowStart);

    if (proposals.length === 0) return 0.5;

    let calibrated = 0;
    for (const p of proposals) {
      const wasAccepted = p.state === 'S4_UPDATED';
      try {
        const verdict = JSON.parse(p.sanitize_verdict || '{}');
        const predictedSuccess = verdict.passed !== false;
        if (predictedSuccess === wasAccepted) calibrated++;
      } catch (_) {
        calibrated += 0.5;
      }
    }

    return Math.round((calibrated / proposals.length) * 1000) / 1000;
  } catch (_) { return 0.5; }
}

function determineStrategy(effectiveness, stuckScore, confidence) {
  if (stuckScore >= STUCK_THRESHOLD) {
    return {
      strategy: 'diversify',
      reason: 'stuck pattern detected — switch action types',
      adjustments: { preferDream: true, suppressRepeat: true },
    };
  }
  if (effectiveness < LOW_EFFECTIVENESS_THRESHOLD) {
    return {
      strategy: 'conserve',
      reason: 'low effectiveness — reduce autonomous action rate',
      adjustments: { dampAutonomy: true, increaseReflection: true },
    };
  }
  if (confidence < 0.3) {
    return {
      strategy: 'calibrate',
      reason: 'poor prediction-outcome alignment — tighten OPEG gates',
      adjustments: { tightenOPEG: true, increaseVerification: true },
    };
  }
  return {
    strategy: 'nominal',
    reason: 'cognitive performance within acceptable bounds',
    adjustments: {},
  };
}

function runAssessment() {
  const ctrnn = getCTRNN();

  const { effectiveness, metrics } = assessEffectiveness();
  const stuckScore = assessStuckness();
  const confidence = assessConfidence();

  const gateMods = getAutonomyModifiers();
  const sensitivity = clamp(
    BASE_METACOG_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3,
    0.2, 1.0
  );

  if (metrics.runCount > 0) recentActionTypes.push('run');
  if (metrics.verifyCount > 0) recentActionTypes.push('verify');
  if (metrics.reflectionCount > 0) recentActionTypes.push('reflect');
  if (metrics.workflowCount > 0) recentActionTypes.push('workflow');
  while (recentActionTypes.length > MAX_ACTION_HISTORY) recentActionTypes.shift();

  const injections = {};
  if (ctrnn.running) {
    const effAmp = clamp(effectiveness * sensitivity * 2, 0, 1.5);
    if (effAmp > 0.01) {
      ctrnn.inject(METACOG_REGIONS.effectiveness.tx, METACOG_REGIONS.effectiveness.ty, METACOG_REGIONS.effectiveness.sigma, effAmp);
      injections.effectiveness = Math.round(effAmp * 1000) / 1000;
    }

    const stuckAmp = clamp(stuckScore * sensitivity * 3, 0, 1.5);
    if (stuckAmp > 0.01) {
      ctrnn.inject(METACOG_REGIONS.stuck.tx, METACOG_REGIONS.stuck.ty, METACOG_REGIONS.stuck.sigma, -stuckAmp);
      injections.stuck = Math.round(-stuckAmp * 1000) / 1000;
    }

    const confAmp = clamp((confidence - 0.5) * sensitivity * 2, -1.0, 1.0);
    if (Math.abs(confAmp) > 0.01) {
      ctrnn.inject(METACOG_REGIONS.confidence.tx, METACOG_REGIONS.confidence.ty, METACOG_REGIONS.confidence.sigma, confAmp);
      injections.confidence = Math.round(confAmp * 1000) / 1000;
    }
  }

  const strategyResult = determineStrategy(effectiveness, stuckScore, confidence);

  const prevStrategy = metacogState.lastStrategy;
  if (prevStrategy && prevStrategy !== strategyResult.strategy) {
    metacogState.strategyChanges++;
    try {
      publish('metacognitive-monitor', 'system.metacognition.strategy-change', JSON.stringify({
        from: prevStrategy,
        to: strategyResult.strategy,
        reason: strategyResult.reason,
        effectiveness, stuckScore, confidence,
        tier: gateMods.tier,
        ts: now(),
      }));
    } catch (_) {}
  }

  metacogState.assessments++;
  metacogState.lastEffectiveness = effectiveness;
  metacogState.lastStuckScore = stuckScore;
  metacogState.lastConfidence = confidence;
  metacogState.lastInjections = injections;
  metacogState.lastStrategy = strategyResult.strategy;
  metacogState.lastStrategyDetail = strategyResult;
  metacogState.lastAssessedAt = now();

  if (metacogState.assessments % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO metacognitive_events (id, effectiveness, stuck_score, confidence, injections, strategy, gate_tier, sensitivity, assessment_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        effectiveness,
        stuckScore,
        confidence,
        JSON.stringify(injections),
        strategyResult.strategy,
        gateMods.tier,
        Math.round(sensitivity * 1000) / 1000,
        JSON.stringify(metrics),
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM metacognitive_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return { effectiveness, stuckScore, confidence, injections, strategy: strategyResult, metrics, tier: gateMods.tier };
}

export function startMetacognitiveMonitor() {
  stopMetacognitiveMonitor();
  metacogState = {
    running: true,
    assessments: 0,
    lastEffectiveness: 0,
    lastStuckScore: 0,
    lastConfidence: 0.5,
    lastInjections: {},
    lastAssessedAt: 0,
    lastStrategy: null,
    lastStrategyDetail: null,
    strategyChanges: 0,
    startedAt: now(),
  };
  recentActionTypes.length = 0;

  metacogTimer = setInterval(() => {
    try { runAssessment(); } catch (e) {
      console.error(`Metacognitive monitor error: ${e.message}`);
    }
  }, METACOG_INTERVAL_MS);

  runAssessment();

  return { started: true, intervalMs: METACOG_INTERVAL_MS, regions: Object.keys(METACOG_REGIONS) };
}

export function stopMetacognitiveMonitor() {
  if (metacogTimer) {
    clearInterval(metacogTimer);
    metacogTimer = null;
  }
  metacogState.running = false;
  return { stopped: true, totalAssessments: metacogState.assessments };
}

export function getMetacognitiveStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...metacogState,
    intervalMs: METACOG_INTERVAL_MS,
    regions: METACOG_REGIONS,
    gateTier: gateMods.tier,
    sensitivity: clamp(BASE_METACOG_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3, 0.2, 1.0),
  };
}

export function getMetacognitiveHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM metacognitive_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function triggerAssessment() {
  return runAssessment();
}

export function getStrategyRecommendation() {
  return determineStrategy(metacogState.lastEffectiveness, metacogState.lastStuckScore, metacogState.lastConfidence);
}

export function installMetacognitiveRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/metacognitive', route((_req, res) => {
    res.json(getMetacognitiveStatus());
  }));

  app.get('/api/intelligence/metacognitive/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getMetacognitiveHistory({ limit }) });
  }));

  app.get('/api/intelligence/metacognitive/strategy', route((_req, res) => {
    res.json(getStrategyRecommendation());
  }));

  app.post('/api/intelligence/metacognitive/start', route((_req, res) => {
    res.json(startMetacognitiveMonitor());
  }));

  app.post('/api/intelligence/metacognitive/stop', route((_req, res) => {
    res.json(stopMetacognitiveMonitor());
  }));

  app.post('/api/intelligence/metacognitive/trigger', route((_req, res) => {
    const result = triggerAssessment();
    if (!result) return res.status(409).json({ error: 'Monitor not initialized' });
    res.json(result);
  }));
}
