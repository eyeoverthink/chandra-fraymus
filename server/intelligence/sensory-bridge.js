/**
 * Phase 8 — Sensory Bridge: System State → CTRNN External Input
 *
 * Maps live system telemetry to spatial regions of the 16×16 CTRNN grid
 * via continuous Gaussian injection, giving the neural core a felt sense
 * of what the organism is doing.
 *
 * Sensory regions (grid center, sigma):
 *   Left hemisphere (internal state):
 *     Bus traffic    (2, 2)   σ=2.0  — communication volume
 *     Memory writes  (2, 6)   σ=2.0  — knowledge growth
 *     Emotion        (2, 10)  σ=2.5  — Heart mood (global, wider spread)
 *     Consciousness  (2, 14)  σ=2.0  — gate tier / proofs passed
 *
 *   Right hemisphere (action state):
 *     Agent activity  (10, 2)  σ=2.0  — fleet work rate
 *     Health status   (10, 6)  σ=2.0  — system health (inverted: alerts = high)
 *     Workflow runs   (10, 10) σ=2.0  — pipeline activity
 *     Goals / RSI     (10, 14) σ=2.0  — self-directed ambition
 *
 *   Temporal cortex band (Phase 5 — RE integration):
 *     Binary insight  (6, 14)  σ=2.0  — RE analysis activity (dossier + compile + debate)
 *
 * Runs on its own 5-second interval (Iext decays at 0.95/tick → ~1s half-life).
 * Consciousness-aware: gate modifiers scale overall sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { computeAttentionWeights } from './attention-gate.js';
import { computeNoveltyFactors } from './habituation.js';
import { updateWorkingMemory } from './working-memory.js';
import { updatePredictions } from './predictive-processing.js';
import { updateActiveInference } from './active-inference.js';
import { SENSORY_REGIONS, EXTERNAL_KEYS } from './sensory-channels.js';
import { getExternalSignals } from './external-senses.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const SENSORY_INTERVAL_MS = 5_000;
const SNAPSHOT_EVERY = 60;

let bridgeTimer = null;
let bridgeState = {
  running: false,
  injections: 0,
  lastSignals: {},
  lastAmplitudes: {},
  lastInjectedAt: 0,
  startedAt: 0,
};

let heartRef = null;

export function setSensoryHeart(h) { heartRef = h; }

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS sensory_bridge_events (
      id TEXT PRIMARY KEY,
      tick INTEGER,
      signals TEXT,
      amplitudes TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_sensory_ts ON sensory_bridge_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function collectSignals() {
  const fiveMinAgo = now() - 300_000;
  const oneMinAgo = now() - 60_000;
  const signals = {};

  signals.bus = (() => {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`
      ).get(oneMinAgo)?.c || 0;
      return clamp01(count / 20);
    } catch (_) { return 0; }
  })();

  signals.memory = (() => {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM agent_memories WHERE updated_at > ?`
      ).get(fiveMinAgo)?.c || 0;
      return clamp01(count / 30);
    } catch (_) { return 0; }
  })();

  signals.emotion = (() => {
    try {
      if (!heartRef) return 0.3;
      const mood = heartRef.recentMood();
      if (mood.readings === 0) return 0.3;
      const intensity = Math.abs(mood.avgIntensity ?? 0.3);
      return clamp01(intensity);
    } catch (_) { return 0.3; }
  })();

  signals.consciousness = (() => {
    try {
      const mods = getAutonomyModifiers();
      return clamp01(mods.proofsPassed / 4);
    } catch (_) { return 0; }
  })();

  signals.agent = (() => {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM runs WHERE created_at > ?`
      ).get(fiveMinAgo)?.c || 0;
      return clamp01(count / 10);
    } catch (_) { return 0; }
  })();

  signals.health = (() => {
    try {
      const alerts = db.prepare(
        `SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`
      ).get()?.c || 0;
      return clamp01(alerts / 5);
    } catch (_) { return 0; }
  })();

  signals.workflow = (() => {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ?`
      ).get(fiveMinAgo)?.c || 0;
      return clamp01(count / 10);
    } catch (_) { return 0; }
  })();

  signals.goals = (() => {
    try {
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM goal_proposals WHERE status = 'proposed'`
      ).get()?.c || 0;
      return clamp01(count / 5);
    } catch (_) { return 0; }
  })();

  signals.binary_insight = (() => {
    try {
      const oneHourAgo = now() - 3_600_000;

      // Sub-signal 1: dossier ingestion activity in last 5 min
      const dossierCount = db.prepare(
        `SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier' AND updated_at > ?`
      ).get(fiveMinAgo)?.c || 0;
      const dossierActivity = clamp01(dossierCount / 3);

      // Idle decay: check if any dossier was ingested in the last hour
      const lastDossierRow = db.prepare(
        `SELECT MAX(updated_at) as ts FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier'`
      ).get();
      const lastDossierAt = lastDossierRow?.ts || 0;
      const dossierStale = lastDossierAt < oneHourAgo;

      // Sub-signal 2: compile quality (decays to 0 if no recent dossier)
      let compileQuality = 0;
      if (!dossierStale) {
        const compileRow = db.prepare(
          `SELECT value FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier' AND key LIKE '%compile_rate%' ORDER BY updated_at DESC LIMIT 1`
        ).get();
        if (compileRow) {
          try {
            const parsed = JSON.parse(compileRow.value);
            compileQuality = clamp01((parsed.compileRate || 0) / 100);
          } catch (_) {}
        }
      }

      // Sub-signal 3: debate confidence (fraction CONFIRMED in recent debates)
      const debateTotal = db.prepare(
        `SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier' AND key LIKE 'debate_%' AND updated_at > ?`
      ).get(fiveMinAgo)?.c || 0;
      const debateConfirmed = db.prepare(
        `SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier' AND key LIKE 'debate_%' AND value LIKE '%CONFIRMED%' AND updated_at > ?`
      ).get(fiveMinAgo)?.c || 0;
      const debateConfidence = debateTotal > 0 ? clamp01(debateConfirmed / debateTotal) : 0;

      return clamp01((dossierActivity + compileQuality + debateConfidence) / 3);
    } catch (_) { return 0; }
  })();

  // Phase Q: outward senses (web, youtube, commerce, mesh, git, user)
  try {
    const ext = getExternalSignals();
    for (const key of EXTERNAL_KEYS) signals[key] = clamp01(ext[key] ?? 0);
  } catch (_) {
    for (const key of EXTERNAL_KEYS) signals[key] = 0;
  }

  return signals;
}

function injectSensorySignals() {
  const ctrnn = getCTRNN();
  if (!ctrnn.running) return null;

  const signals = collectSignals();

  const gateMods = getAutonomyModifiers();
  const baseSensitivity = 0.5;
  const sensitivity = baseSensitivity + (gateMods.neurogenesisBoost * 0.3);

  let attentionWeights = {};
  try {
    attentionWeights = computeAttentionWeights();
  } catch (_) {}

  let noveltyFactors = {};
  try {
    noveltyFactors = computeNoveltyFactors(signals);
  } catch (_) {}

  const amplitudes = {};
  for (const [key, region] of Object.entries(SENSORY_REGIONS)) {
    const raw = signals[key] || 0;
    const attention = attentionWeights[key] || 1.0;
    const novelty = noveltyFactors[key] || 1.0;
    const amp = raw * sensitivity * attention * novelty;
    amplitudes[key] = Math.round(amp * 1000) / 1000;
    if (amp > 0.01 && region.inject !== false) {
      ctrnn.inject(region.tx, region.ty, region.sigma, amp);
    }
  }

  let workingMemoryResult = {};
  try {
    workingMemoryResult = updateWorkingMemory({ signals, amplitudes, attentionWeights, noveltyFactors });
  } catch (_) {}

  let predictiveResult = {};
  try {
    predictiveResult = updatePredictions(signals);
  } catch (_) {}

  let activeInferenceResult = {};
  try {
    activeInferenceResult = updateActiveInference(predictiveResult);
  } catch (_) {}

  bridgeState.injections++;
  bridgeState.lastSignals = signals;
  bridgeState.lastAmplitudes = amplitudes;
  bridgeState.lastInjectedAt = now();

  if (bridgeState.injections % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO sensory_bridge_events (id, tick, signals, amplitudes, gate_tier, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        ctrnn.tick,
        JSON.stringify(signals),
        JSON.stringify(amplitudes),
        gateMods.tier,
        Math.round(sensitivity * 1000) / 1000,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM sensory_bridge_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return { signals, amplitudes, attentionWeights, noveltyFactors, workingMemory: workingMemoryResult, predictive: predictiveResult, activeInference: activeInferenceResult, sensitivity, tier: gateMods.tier, tick: ctrnn.tick };
}

export function startSensoryBridge() {
  stopSensoryBridge();
  bridgeState = {
    running: true,
    injections: 0,
    lastSignals: {},
    lastAmplitudes: {},
    lastInjectedAt: 0,
    startedAt: now(),
  };

  bridgeTimer = setInterval(() => {
    try {
      injectSensorySignals();
    } catch (e) {
      console.error(`Sensory bridge error: ${e.message}`);
    }
  }, SENSORY_INTERVAL_MS);

  injectSensorySignals();

  return { started: true, intervalMs: SENSORY_INTERVAL_MS, regions: Object.keys(SENSORY_REGIONS) };
}

export function stopSensoryBridge() {
  if (bridgeTimer) {
    clearInterval(bridgeTimer);
    bridgeTimer = null;
  }
  bridgeState.running = false;
  return { stopped: true, totalInjections: bridgeState.injections };
}

export function getSensoryStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...bridgeState,
    intervalMs: SENSORY_INTERVAL_MS,
    regions: Object.fromEntries(
      Object.entries(SENSORY_REGIONS).map(([k, v]) => [k, {
        ...v,
        signal: bridgeState.lastSignals[k] ?? 0,
        amplitude: bridgeState.lastAmplitudes[k] ?? 0,
      }])
    ),
    gateTier: gateMods.tier,
    sensitivity: 0.5 + (gateMods.neurogenesisBoost * 0.3),
  };
}

export function getSensoryHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM sensory_bridge_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function triggerInjection() {
  return injectSensorySignals();
}

export function installSensoryRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/sensory', route((_req, res) => {
    res.json(getSensoryStatus());
  }));

  app.get('/api/intelligence/sensory/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getSensoryHistory({ limit }) });
  }));

  app.post('/api/intelligence/sensory/start', route((_req, res) => {
    res.json(startSensoryBridge());
  }));

  app.post('/api/intelligence/sensory/stop', route((_req, res) => {
    res.json(stopSensoryBridge());
  }));

  app.post('/api/intelligence/sensory/inject', route((_req, res) => {
    const result = triggerInjection();
    if (!result) return res.status(409).json({ error: 'CTRNN not running' });
    res.json(result);
  }));
}
