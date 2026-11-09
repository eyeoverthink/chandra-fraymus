/**
 * Phase 10 — Motor Output: CTRNN Activation → Autonomous Actions
 *
 * Reads activation patterns from designated "motor cortex" regions of the
 * 16×16 CTRNN grid and translates sustained high activation into autonomous
 * system actions. Closes the full perception→emotion→cognition→action loop.
 *
 * Motor regions (grid center, sigma for reading):
 *   Bottom-left quadrant (self-directed):
 *     Reflect       (14, 2)  — trigger reflection cycle
 *     Neurogenesis  (14, 6)  — trigger neural growth cycle
 *     Dream         (14, 10) — publish dream consolidation request
 *     Self-audit    (14, 14) — trigger consciousness audit
 *
 *   Center band (externally-directed):
 *     Communicate   (8, 4)   — publish bus event (system.motor.impulse)
 *     Goal-seek     (8, 12)  — trigger goal generation cycle
 *
 * Each motor region reads a 3×3 patch of neurons centered on its grid point,
 * averages their |tanh(B)| activations, and fires when that average exceeds
 * a threshold for two consecutive readings (debounce prevents spurious firing).
 *
 * Runs on its own 15-second interval (actions are expensive; slower than
 * sensory 5s and emotional 10s to avoid action spam).
 * Consciousness-aware: gate modifiers scale firing threshold and cooldowns.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { isActionSuppressed, isActionPreferred } from './adaptive-strategy.js';
import { isResourceConstrained } from './resource-envelope.js';
import { recordEfferenceCopy } from './predictive-processing.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const MOTOR_INTERVAL_MS = 15_000;
const SNAPSHOT_EVERY = 20;
const BASE_THRESHOLD = 0.55;
const BASE_COOLDOWN_MS = 120_000;

const MOTOR_REGIONS = {
  reflect:      { cx: 14, cy: 2,  label: 'Reflect',      action: 'reflect' },
  neurogenesis: { cx: 14, cy: 6,  label: 'Neurogenesis',  action: 'neurogenesis' },
  dream:        { cx: 14, cy: 10, label: 'Dream',         action: 'dream' },
  selfAudit:    { cx: 14, cy: 14, label: 'Self-audit',    action: 'consciousness' },
  communicate:  { cx: 8,  cy: 4,  label: 'Communicate',   action: 'bus_impulse' },
  goalSeek:     { cx: 8,  cy: 12, label: 'Goal-seek',     action: 'goals' },
};

// Phase V: the adaptive strategy names actions 'goal_seek' / 'consciousness_audit' while
// the regions are keyed 'goalSeek' / 'selfAudit' — so suppression and preference never
// matched for those two. Map region → strategy key explicitly.
const STRATEGY_KEY = {
  reflect: 'reflect', neurogenesis: 'neurogenesis', dream: 'dream',
  selfAudit: 'consciousness_audit', communicate: 'communicate', goalSeek: 'goal_seek',
};

// Hard floors on how often a region may fire, independent of the gate-scaled cooldown.
// Measured 2026-11-09 before this: Reflect every ~90 s (884/24 h), Self-audit every ~45 s
// (1,914 consciousness audits/24 h). Each firing is one or more Ollama calls or a 4-proof
// audit; nothing downstream consumes them faster than this.
const MIN_INTERVAL_MS = {
  reflect: Math.max(60_000, parseInt(process.env.MOTOR_REFLECT_MIN_MS, 10) || 10 * 60_000),
  goalSeek: Math.max(60_000, parseInt(process.env.MOTOR_GOALSEEK_MIN_MS, 10) || 3 * 60_000),
  selfAudit: Math.max(60_000, parseInt(process.env.MOTOR_SELFAUDIT_MIN_MS, 10) || 10 * 60_000),
  dream: 5 * 60_000,
  neurogenesis: 2 * 60_000,
  communicate: 60_000,
};

let motorTimer = null;
let previousReadings = {};
let cooldowns = {};
let motorState = {
  running: false,
  readings: 0,
  firings: 0,
  lastReadings: {},
  lastFirings: [],
  lastReadAt: 0,
  startedAt: 0,
};

let reflectFn = null;
let neurogenesisFn = null;
let consciousnessFn = null;
let goalsFn = null;

export function setMotorTargets({ reflect, neurogenesis, consciousness, goals } = {}) {
  if (reflect) reflectFn = reflect;
  if (neurogenesis) neurogenesisFn = neurogenesis;
  if (consciousness) consciousnessFn = consciousness;
  if (goals) goalsFn = goals;
}

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS motor_output_events (
      id TEXT PRIMARY KEY,
      tick INTEGER,
      region TEXT NOT NULL,
      activation REAL,
      action_taken TEXT,
      gate_tier TEXT,
      threshold REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_motor_output_ts ON motor_output_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function readRegionActivation(B, gridSize, cx, cy) {
  let sum = 0;
  let count = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const rx = cx + dx;
      const ry = cy + dy;
      if (rx >= 0 && rx < gridSize && ry >= 0 && ry < gridSize) {
        const idx = rx * gridSize + ry;
        sum += Math.abs(Math.tanh(B[idx]));
        count++;
      }
    }
  }
  return count > 0 ? sum / count : 0;
}

function computeThreshold(gateMods) {
  return BASE_THRESHOLD * (1 / clamp(gateMods.evolutionRate, 0.5, 1.5));
}

function computeCooldown(gateMods) {
  return BASE_COOLDOWN_MS * (1 / clamp(gateMods.evolutionRate, 0.5, 1.5));
}

function isOnCooldown(regionKey, cooldownMs) {
  const last = cooldowns[regionKey] || 0;
  return (now() - last) < cooldownMs;
}

async function fireAction(regionKey, activation, gateMods) {
  const region = MOTOR_REGIONS[regionKey];
  if (!region) return null;

  cooldowns[regionKey] = now();
  let result = null;

  try {
    switch (region.action) {
      case 'reflect': {
        if (reflectFn) {
          result = await reflectFn({ trigger: 'motor' });
        }
        try {
          const lowConfCount = db.prepare(
            `SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier' AND confidence < 0.5`
          ).get()?.c || 0;
          if (lowConfCount > 0) {
            publish('motor-cortex', 'system.re.motor-review', JSON.stringify({
              request: 'dossier_review',
              lowConfidenceDossiers: lowConfCount,
              activation: Math.round(activation * 1000) / 1000,
              tier: gateMods.tier,
              ts: now(),
            }));
            result = { ...result, reReview: { triggered: true, lowConfCount } };
          }
        } catch (_) {}
        break;
      }

      case 'neurogenesis':
        if (neurogenesisFn) {
          result = await neurogenesisFn();
        }
        break;

      case 'dream':
        publish('motor-cortex', 'system.motor.dream', JSON.stringify({
          request: 'dream_consolidation',
          activation: Math.round(activation * 1000) / 1000,
          tier: gateMods.tier,
          ts: now(),
        }));
        result = { published: true, topic: 'system.motor.dream' };
        break;

      case 'consciousness':
        if (consciousnessFn) {
          result = await consciousnessFn({ trigger: 'motor' });
        }
        break;

      case 'bus_impulse':
        publish('motor-cortex', 'system.motor.impulse', JSON.stringify({
          type: 'neural_impulse',
          activation: Math.round(activation * 1000) / 1000,
          tier: gateMods.tier,
          ts: now(),
        }));
        result = { published: true, topic: 'system.motor.impulse' };
        break;

      case 'goals': {
        if (goalsFn) {
          result = await goalsFn({ trigger: 'motor' });
        }
        try {
          const uningestedCount = db.prepare(
            `SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = 're-analyst' AND category = 'binary_dossier' AND key LIKE 'pending_%'`
          ).get()?.c || 0;
          if (uningestedCount > 0) {
            publish('motor-cortex', 'system.re.motor-goal', JSON.stringify({
              request: 'binary_analysis_goal',
              pendingDossiers: uningestedCount,
              activation: Math.round(activation * 1000) / 1000,
              tier: gateMods.tier,
              ts: now(),
            }));
            result = { ...result, reGoal: { proposed: true, pendingDossiers: uningestedCount } };
          }
        } catch (_) {}
        break;
      }
    }
  } catch (e) {
    console.error(`Motor fire error [${regionKey}]: ${e.message}`);
    result = { error: e.message };
  }

  return result;
}

async function motorCycle() {
  const ctrnn = getCTRNN();
  if (!ctrnn.running) return null;

  const state = ctrnn.state();
  const { B, gridSize } = state;
  const gateMods = getAutonomyModifiers();

  const threshold = computeThreshold(gateMods);
  const cooldownMs = computeCooldown(gateMods);

  const readings = {};
  const firings = [];

  for (const [key, region] of Object.entries(MOTOR_REGIONS)) {
    const activation = readRegionActivation(B, gridSize, region.cx, region.cy);
    readings[key] = Math.round(activation * 1000) / 1000;

    const prevActivation = previousReadings[key] || 0;
    const preferred = isActionPreferred(STRATEGY_KEY[key] || key);
    const effectiveThreshold = preferred ? threshold * 0.85 : threshold;
    const sustained = prevActivation >= effectiveThreshold && activation >= effectiveThreshold;
    const regionCooldown = Math.max(cooldownMs, MIN_INTERVAL_MS[key] || 0);

    if (sustained && !isOnCooldown(key, regionCooldown)) {
      if (isActionSuppressed(STRATEGY_KEY[key] || key) || isResourceConstrained()) {
        firings.push({
          region: key, label: region.label, activation: readings[key],
          action: region.action, result: isResourceConstrained() ? 'resource_constrained' : 'suppressed',
        });
        continue;
      }
      if (!motorState.running) break;
      const result = await fireAction(key, activation, gateMods);
      const succeeded = result && !result.error;
      if (succeeded) {
        try { recordEfferenceCopy(key); } catch (_) {}
      }
      firings.push({
        region: key,
        label: region.label,
        activation: readings[key],
        action: region.action,
        result: succeeded ? 'ok' : (result?.error ? 'error' : 'no_handler'),
        preferred,
      });
    }
  }

  previousReadings = { ...readings };

  motorState.readings++;
  motorState.lastReadings = readings;
  motorState.lastReadAt = now();

  if (firings.length > 0) {
    motorState.firings += firings.length;
    motorState.lastFirings = firings;

    for (const f of firings) {
      if (motorState.readings % SNAPSHOT_EVERY === 0 || firings.length > 0) {
        try {
          db.prepare(
            `INSERT INTO motor_output_events (id, tick, region, activation, action_taken, gate_tier, threshold, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            randomUUID().slice(0, 12),
            state.tick,
            f.region,
            f.activation,
            f.action,
            gateMods.tier,
            Math.round(threshold * 1000) / 1000,
            now()
          );
        } catch (_) {}
      }
    }

    publish('motor-cortex', 'system.motor.fired', JSON.stringify({
      firings: firings.map(f => ({ region: f.region, activation: f.activation, action: f.action })),
      tier: gateMods.tier,
      tick: state.tick,
    }));
  }

  if (motorState.readings % (SNAPSHOT_EVERY * 5) === 0) {
    try {
      db.prepare(`DELETE FROM motor_output_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return { readings, firings, threshold: Math.round(threshold * 1000) / 1000, tier: gateMods.tier, tick: state.tick };
}

export function startMotorOutput() {
  stopMotorOutput();
  motorState = {
    running: true,
    readings: 0,
    firings: 0,
    lastReadings: {},
    lastFirings: [],
    lastReadAt: 0,
    startedAt: now(),
  };
  previousReadings = {};
  cooldowns = {};

  motorTimer = setInterval(async () => {
    try {
      await motorCycle();
    } catch (e) {
      console.error(`Motor output error: ${e.message}`);
    }
  }, MOTOR_INTERVAL_MS);

  motorCycle();

  return { started: true, intervalMs: MOTOR_INTERVAL_MS, regions: Object.keys(MOTOR_REGIONS) };
}

export function stopMotorOutput() {
  if (motorTimer) {
    clearInterval(motorTimer);
    motorTimer = null;
  }
  motorState.running = false;
  return { stopped: true, totalReadings: motorState.readings, totalFirings: motorState.firings };
}

export function getMotorOutputStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...motorState,
    intervalMs: MOTOR_INTERVAL_MS,
    threshold: Math.round(computeThreshold(gateMods) * 1000) / 1000,
    cooldownMs: Math.round(computeCooldown(gateMods)),
    gateTier: gateMods.tier,
    regions: Object.fromEntries(
      Object.entries(MOTOR_REGIONS).map(([k, v]) => [k, {
        label: v.label,
        cx: v.cx,
        cy: v.cy,
        action: v.action,
        activation: motorState.lastReadings[k] || 0,
        onCooldown: isOnCooldown(k, computeCooldown(gateMods)),
      }])
    ),
  };
}

export function getMotorOutputHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM motor_output_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function triggerMotorCycle() {
  return motorCycle();
}

export function installMotorOutputRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/motor-output', route((_req, res) => {
    res.json(getMotorOutputStatus());
  }));

  app.get('/api/intelligence/motor-output/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getMotorOutputHistory({ limit }) });
  }));

  app.post('/api/intelligence/motor-output/start', route((_req, res) => {
    res.json(startMotorOutput());
  }));

  app.post('/api/intelligence/motor-output/stop', route((_req, res) => {
    res.json(stopMotorOutput());
  }));

  app.post('/api/intelligence/motor-output/trigger', route(async (_req, res) => {
    const result = await triggerMotorCycle();
    if (!result) return res.status(409).json({ error: 'CTRNN not running' });
    res.json(result);
  }));
}
