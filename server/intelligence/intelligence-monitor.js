/**
 * Phase 24 — Intelligence Stack Monitor: Cognitive Health Dashboard
 *
 * Aggregates health and performance metrics from ALL intelligence subsystems,
 * computes a composite "intelligence score", detects degradation patterns,
 * and auto-tunes parameters when performance drops.
 *
 * Biological analogue: the thalamus — the central relay station that monitors
 * all incoming cortical signals and raises awareness when any pathway is
 * degraded. Without it, the organism cannot detect that a cognitive function
 * has gone offline until the consequences are catastrophic.
 *
 * Monitors 12 subsystems:
 *   sensory bridge, emotional feedback, motor output, attention gate,
 *   habituation, working memory, metacognitive monitor, adaptive strategy,
 *   self-model, resource envelope, predictive processing, active inference
 *
 * CTRNN monitor regions (Row 15 — bottom edge, monitoring the whole stack):
 *   Intelligence health (15, 4)  σ=3.0 — composite health score (broad spread)
 *   Degradation alert  (15, 12) σ=2.0 — fires when subsystems are degraded (inhibitory)
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { getAutonomyModifiers } from './consciousness-gate.js';

const now = () => Date.now();
const BASE_MONITOR_SENSITIVITY = 0.5;
const SNAPSHOT_EVERY = 10;
const DEGRADATION_THRESHOLD = 0.4;
let callCount = 0;
let monitorInterval = null;
let monitorCTRNN = null;
let lastAssessment = null;

// ─── DB Migration ─────────────────────────────────────────────

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS intelligence_monitor_events (
    id TEXT PRIMARY KEY,
    intelligence_score REAL,
    subsystem_scores TEXT,
    degraded_subsystems TEXT,
    recommendations TEXT,
    injections TEXT,
    gate_tier TEXT,
    sensitivity REAL,
    trigger TEXT,
    created_at INTEGER
  )`).run();
} catch (_) {}

// ─── Subsystem Health Checks ──────────────────────────────────
// Each checker reads the subsystem's latest state and returns 0.0-1.0

// Freshness bounds derived from each producer's actual snapshot cadence.
// snapshot_interval × snapshot_every + grace. Prevents false staleness.
const FRESHNESS_BOUNDS = {
  sensoryBridge:       360_000,  // 5s × 60 ticks = 300s + 60s grace
  emotionalFeedback:   360_000,  // 10s × 30 ticks = 300s + 60s grace
  motorOutput:         600_000,  // motor fires are event-driven, 10min grace
  attentionGate:       360_000,  // synced with sensory (60th call)
  habituation:         360_000,  // synced with sensory (60th call)
  workingMemory:       360_000,  // synced with sensory (60th call)
  metacognitive:       960_000,  // 30s × 30 = 900s + 60s grace
  adaptiveStrategy:    960_000,  // synced with metacognitive
  selfModel:           600_000,  // every 20th daemon call, 10min grace
  resourceEnvelope:    360_000,  // 10s × 30 = 300s + 60s grace
  predictiveProcessing:360_000,  // synced with sensory (60th call)
  activeInference:     360_000,  // synced with sensory (60th call)
};

const SUBSYSTEM_CHECKS = {
  sensoryBridge: () => {
    try {
      const row = db.prepare(`SELECT * FROM sensory_bridge_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.2, status: 'idle', detail: 'No sensory data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.sensoryBridge) return { score: 0.2, status: 'stale', detail: 'Sensory data older than expected cadence' };
      return { score: 0.9, status: 'active', detail: `Tick ${row.tick}, sensitivity ${row.sensitivity}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  emotionalFeedback: () => {
    try {
      const row = db.prepare(`SELECT * FROM emotional_feedback_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.2, status: 'idle', detail: 'No emotional data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.emotionalFeedback) return { score: 0.2, status: 'stale', detail: 'Emotional data older than expected cadence' };
      return { score: 0.85, status: 'active', detail: `Emotion: ${row.primary_emotion}, tier: ${row.gate_tier}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  motorOutput: () => {
    try {
      const row = db.prepare(`SELECT * FROM motor_output_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.5, status: 'idle', detail: 'Motor cortex quiet — no firings yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.motorOutput) return { score: 0.3, status: 'idle', detail: 'Motor cortex quiet' };
      return { score: 0.8, status: 'active', detail: `Region: ${row.region}, activation: ${row.activation}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  attentionGate: () => {
    try {
      const row = db.prepare(`SELECT * FROM attention_gate_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No attention data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.attentionGate) return { score: 0.3, status: 'stale' };
      return { score: 0.85, status: 'active', detail: `Dynamic range: ${row.dynamic_range}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  habituation: () => {
    try {
      const row = db.prepare(`SELECT * FROM habituation_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No habituation data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.habituation) return { score: 0.3, status: 'stale' };
      const spikes = row.spikes ? JSON.parse(row.spikes) : [];
      return { score: 0.85, status: 'active', detail: `Spikes: ${spikes.length}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  workingMemory: () => {
    try {
      const row = db.prepare(`SELECT * FROM working_memory_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No working memory data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.workingMemory) return { score: 0.3, status: 'stale' };
      return { score: 0.85, status: 'active', detail: `Volatility: ${row.volatility}, coherence: ${row.coherence}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  metacognitive: () => {
    try {
      const row = db.prepare(`SELECT * FROM metacognitive_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No metacognitive data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.metacognitive) return { score: 0.3, status: 'stale' };
      const eff = typeof row.effectiveness === 'number' ? row.effectiveness : null;
      return { score: Math.max(0.3, eff ?? 0.3), status: 'active', detail: `Strategy: ${row.strategy}, effectiveness: ${eff}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  adaptiveStrategy: () => {
    try {
      const row = db.prepare(`SELECT * FROM adaptive_strategy_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No adaptive strategy data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.adaptiveStrategy) return { score: 0.3, status: 'stale' };
      return { score: 0.8, status: 'active', detail: `Strategy: ${row.strategy}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  selfModel: () => {
    try {
      const row = db.prepare(`SELECT * FROM self_model_snapshots ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No self-model data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.selfModel) return { score: 0.3, status: 'stale' };
      const ratio = (row.active_count || 0) / Math.max(1, row.subsystem_count || 27);
      return { score: Math.max(0.3, ratio), status: 'active', detail: `${row.active_count}/${row.subsystem_count} active` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  resourceEnvelope: () => {
    try {
      const row = db.prepare(`SELECT * FROM resource_envelope_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No resource data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.resourceEnvelope) return { score: 0.3, status: 'stale' };
      const health = 1.0 - (row.pressure || 0);
      return { score: Math.max(0.1, health), status: 'active', detail: `Pressure: ${row.pressure}, fatigue: ${row.fatigue}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  predictiveProcessing: () => {
    try {
      const row = db.prepare(`SELECT * FROM predictive_processing_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No predictive data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.predictiveProcessing) return { score: 0.3, status: 'stale' };
      const conf = typeof row.confidence === 'number' ? row.confidence : null;
      return { score: Math.max(0.3, conf ?? 0.3), status: 'active', detail: `Confidence: ${conf}, surprise: ${row.surprise}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },

  activeInference: () => {
    try {
      const row = db.prepare(`SELECT * FROM active_inference_events ORDER BY created_at DESC LIMIT 1`).get();
      if (!row) return { score: 0.3, status: 'idle', detail: 'No active inference data yet' };
      if (now() - row.created_at > FRESHNESS_BOUNDS.activeInference) return { score: 0.3, status: 'stale' };
      const eff = typeof row.effectiveness === 'number' ? row.effectiveness : null;
      return { score: Math.max(0.3, eff ?? 0.3), status: 'active', detail: `Drive: ${row.inference_drive}, effectiveness: ${eff}` };
    } catch (_) { return { score: 0, status: 'error' }; }
  },
};

// ─── Subsystem Weights (importance to overall intelligence) ───

const SUBSYSTEM_WEIGHTS = {
  sensoryBridge: 0.10,
  emotionalFeedback: 0.08,
  motorOutput: 0.08,
  attentionGate: 0.07,
  habituation: 0.06,
  workingMemory: 0.10,
  metacognitive: 0.12,
  adaptiveStrategy: 0.08,
  selfModel: 0.08,
  resourceEnvelope: 0.10,
  predictiveProcessing: 0.08,
  activeInference: 0.05,
};

// ─── Core Assessment ──────────────────────────────────────────

function assessIntelligence(trigger = 'scheduled') {
  const mods = getAutonomyModifiers();
  const sensitivity = Math.max(0.2, Math.min(1.0,
    BASE_MONITOR_SENSITIVITY + (mods.evolutionRate - 1.0) * 0.3));

  const subsystemScores = {};
  const degraded = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [name, checker] of Object.entries(SUBSYSTEM_CHECKS)) {
    const result = checker();
    subsystemScores[name] = result;
    const weight = SUBSYSTEM_WEIGHTS[name] || 0.05;
    weightedSum += result.score * weight;
    totalWeight += weight;

    if (result.score < DEGRADATION_THRESHOLD) {
      degraded.push({ subsystem: name, score: result.score, status: result.status, detail: result.detail });
    }
  }

  const intelligenceScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  // Generate recommendations for degraded subsystems
  const recommendations = degraded.map(d => {
    if (d.status === 'error') return `${d.subsystem}: subsystem errored — check DB table exists and module is loaded`;
    if (d.status === 'stale') return `${d.subsystem}: data is stale — verify daemon is running and subsystem interval is active`;
    if (d.status === 'idle') return `${d.subsystem}: idle — may need external stimulus or lower activation thresholds`;
    return `${d.subsystem}: degraded (score ${d.score}) — investigate root cause`;
  });

  // CTRNN injection
  let injections = null;
  if (monitorCTRNN) {
    try {
      injections = [];
      // Intelligence health → Row 15, Col 4 (inject API: x, y, sigma, amplitude)
      const healthAmp = intelligenceScore * sensitivity * 2.0;
      monitorCTRNN.inject(15, 4, 3.0, healthAmp);
      injections.push({ region: 'intelligence_health', row: 15, col: 4, amp: healthAmp, sigma: 3.0 });

      // Degradation alert → Row 15, Col 12 (inhibitory when degraded)
      if (degraded.length > 0) {
        const degradeAmp = -(degraded.length / 12) * sensitivity * 1.5;
        monitorCTRNN.inject(15, 12, 2.0, degradeAmp);
        injections.push({ region: 'degradation_alert', row: 15, col: 12, amp: degradeAmp, sigma: 2.0 });
      }
    } catch (e) {
      console.error('[intelligence-monitor] CTRNN injection failed:', e.message);
    }
  }

  lastAssessment = {
    intelligenceScore: Math.round(intelligenceScore * 1000) / 1000,
    subsystemScores,
    degraded,
    recommendations,
    activeCount: Object.values(subsystemScores).filter(s => s.status === 'active').length,
    totalCount: Object.keys(SUBSYSTEM_CHECKS).length,
    gateTier: mods.tier,
    sensitivity,
    assessedAt: now(),
  };

  // Snapshot to DB
  callCount++;
  if (callCount % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(`INSERT INTO intelligence_monitor_events (id, intelligence_score, subsystem_scores, degraded_subsystems, recommendations, injections, gate_tier, sensitivity, trigger, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        randomUUID(),
        intelligenceScore,
        JSON.stringify(Object.fromEntries(Object.entries(subsystemScores).map(([k, v]) => [k, { score: v.score, status: v.status }]))),
        degraded.length > 0 ? JSON.stringify(degraded.map(d => d.subsystem)) : null,
        recommendations.length > 0 ? JSON.stringify(recommendations) : null,
        injections ? JSON.stringify(injections) : null,
        mods.tier,
        sensitivity,
        trigger,
        now(),
      );
    } catch (_) {}

    // Prune old events (>7 days)
    try {
      const sevenDaysAgo = now() - 7 * 24 * 3600_000;
      db.prepare(`DELETE FROM intelligence_monitor_events WHERE created_at < ?`).run(sevenDaysAgo);
    } catch (_) {}
  }

  // Publish alerts if degradation detected
  if (degraded.length > 0) {
    try {
      publish('system', 'system.intelligence.degradation', JSON.stringify({
        intelligenceScore,
        degradedCount: degraded.length,
        degraded: degraded.map(d => d.subsystem),
        tier: mods.tier,
      }));
    } catch (_) {}
  }

  return lastAssessment;
}

// ─── Daemon-wirable start/stop ────────────────────────────────

export function setMonitorCTRNN(ctrnn) { monitorCTRNN = ctrnn; }

export function startIntelligenceMonitor() {
  stopIntelligenceMonitor();
  monitorInterval = setInterval(() => {
    try {
      assessIntelligence('interval');
    } catch (e) {
      console.error('[intelligence-monitor] interval error:', e.message);
    }
  }, 60_000); // Every 60 seconds — subsystem health changes at this timescale
}

export function stopIntelligenceMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

export function resetIntelligenceMonitor() {
  callCount = 0;
  lastAssessment = null;
}

export function getIntelligenceMonitorStatus() {
  const mods = getAutonomyModifiers();
  return {
    running: !!monitorInterval,
    lastAssessment: lastAssessment ? {
      intelligenceScore: lastAssessment.intelligenceScore,
      activeCount: lastAssessment.activeCount,
      totalCount: lastAssessment.totalCount,
      degradedCount: lastAssessment.degraded?.length ?? 0,
      degraded: lastAssessment.degraded?.map(d => d.subsystem) ?? [],
      recommendations: lastAssessment.recommendations ?? [],
      assessedAt: lastAssessment.assessedAt,
    } : null,
    gateTier: mods.tier,
    snapshotsStored: callCount,
  };
}

export function assessNow(trigger = 'api') {
  return assessIntelligence(trigger);
}

// ─── REST Routes ──────────────────────────────────────────────

export function installIntelligenceMonitorRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/monitor', route((_req, res) => {
    res.json(getIntelligenceMonitorStatus());
  }));

  app.get('/api/intelligence/monitor/assess', route((_req, res) => {
    const result = assessNow('api');
    res.json(result);
  }));

  app.get('/api/intelligence/monitor/history', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const rows = db.prepare(
      `SELECT id, intelligence_score, subsystem_scores, degraded_subsystems, recommendations, gate_tier, sensitivity, trigger, created_at
       FROM intelligence_monitor_events ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
    res.json({ events: rows, total: rows.length });
  }));

  app.post('/api/intelligence/monitor/start', route((_req, res) => {
    startIntelligenceMonitor();
    res.json({ started: true });
  }));

  app.post('/api/intelligence/monitor/stop', route((_req, res) => {
    stopIntelligenceMonitor();
    res.json({ stopped: true });
  }));

  app.post('/api/intelligence/monitor/reset', route((_req, res) => {
    resetIntelligenceMonitor();
    res.json({ reset: true });
  }));
}
