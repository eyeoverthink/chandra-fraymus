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
 * Runs on its own 5-second interval (Iext decays at 0.95/tick → ~1s half-life).
 * Consciousness-aware: gate modifiers scale overall sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const SENSORY_INTERVAL_MS = 5_000;
const SNAPSHOT_EVERY = 60;

const SENSORY_REGIONS = {
  bus:           { tx: 2,  ty: 2,  sigma: 2.0, label: 'Bus traffic' },
  memory:        { tx: 2,  ty: 6,  sigma: 2.0, label: 'Memory writes' },
  emotion:       { tx: 2,  ty: 10, sigma: 2.5, label: 'Emotion state' },
  consciousness: { tx: 2,  ty: 14, sigma: 2.0, label: 'Consciousness tier' },
  agent:         { tx: 10, ty: 2,  sigma: 2.0, label: 'Agent activity' },
  health:        { tx: 10, ty: 6,  sigma: 2.0, label: 'Health status' },
  workflow:      { tx: 10, ty: 10, sigma: 2.0, label: 'Workflow runs' },
  goals:         { tx: 10, ty: 14, sigma: 2.0, label: 'Goals / RSI' },
};

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

  return signals;
}

function injectSensorySignals() {
  const ctrnn = getCTRNN();
  if (!ctrnn.running) return null;

  const signals = collectSignals();

  const gateMods = getAutonomyModifiers();
  const baseSensitivity = 0.5;
  const sensitivity = baseSensitivity + (gateMods.neurogenesisBoost * 0.3);

  const amplitudes = {};
  for (const [key, region] of Object.entries(SENSORY_REGIONS)) {
    const raw = signals[key] || 0;
    const amp = raw * sensitivity;
    amplitudes[key] = Math.round(amp * 1000) / 1000;
    if (amp > 0.01) {
      ctrnn.inject(region.tx, region.ty, region.sigma, amp);
    }
  }

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

  return { signals, amplitudes, sensitivity, tier: gateMods.tier, tick: ctrnn.tick };
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
