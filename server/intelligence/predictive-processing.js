/**
 * Phase 19 — Predictive Processing: Forward Model & Prediction Error
 *
 * Gives the CTRNN the ability to ANTICIPATE future states rather than
 * only reacting to present state. Based on Karl Friston's Free Energy
 * Principle + cross-system insight from Gemini DREAM: Cycle 108 (the
 * efference copy forward model and EP3 cube-root surprise signal).
 *
 * Architecture:
 *   Forward Model: Uses working memory's temporal derivatives (1st-order)
 *   plus computed 2nd-order derivatives to project each sensory channel
 *   forward by 1–3 measurement cycles (5–15 seconds ahead).
 *
 *   Prediction Error: Compares previous cycle's predictions against
 *   actual current signals. Per-channel error compressed via EP3
 *   cube-root (Stevens' power law) — preserves sensitivity to small
 *   surprises while compressing large ones.
 *
 *   Efference Copy: Motor output firings recorded as "motor commands"
 *   that adjust predictions for expected sensory consequences. If
 *   motor cortex fires "reflect", predict memory-writes will increase;
 *   if "neurogenesis" fires, predict health metrics will shift.
 *
 * CTRNN prediction error regions (Row 3 — between sensory and metacognitive):
 *   Aggregate surprise  (3, 4)   σ=2.0  — total prediction error (excitatory)
 *   Prediction confidence (3, 8)  σ=1.5  — rolling accuracy (excitatory when high)
 *   Anticipatory signal   (3, 12) σ=1.5  — directional forecast for motor pre-activation
 *
 * Runs synchronously (called by sensory bridge each 5s cycle).
 * Consciousness-aware: gate evolutionRate scales prediction sensitivity.
 */

import { getAutonomyModifiers } from './consciousness-gate.js';
import { getCTRNN } from './ctrnn-instance.js';
import { queryWorkingMemory } from './working-memory.js';
import { publish } from '../fleet/bus.js';
import { db } from '../db.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const SENSORY_KEYS = ['bus', 'memory', 'emotion', 'consciousness', 'agent', 'health', 'workflow', 'goals', 'binary_insight'];
const PREDICTION_HORIZONS = [1, 2, 3]; // cycles ahead (5s, 10s, 15s)
const SNAPSHOT_EVERY = 60;
const BASE_PREDICTION_SENSITIVITY = 0.5;
const HIGH_SURPRISE_THRESHOLD = 0.4;
const CONFIDENCE_DECAY = 0.9;
const DERIVATIVE_HISTORY_SIZE = 12;

const PREDICTION_REGIONS = {
  surprise:    { tx: 3, ty: 4,  sigma: 2.0, label: 'Aggregate surprise' },
  confidence:  { tx: 3, ty: 8,  sigma: 1.5, label: 'Prediction confidence' },
  anticipatory: { tx: 3, ty: 12, sigma: 1.5, label: 'Anticipatory signal' },
};

// Motor → sensory consequence map (efference copy)
// When a motor region fires, which sensory channels should we expect to change?
const EFFERENCE_MAP = {
  reflect:      { memory: 0.3, consciousness: 0.1 },
  neurogenesis: { health: 0.2, agent: 0.1 },
  dream:        { emotion: 0.2, memory: 0.15 },
  selfAudit:    { consciousness: 0.3, health: 0.1 },
  communicate:  { bus: 0.4, agent: 0.1 },
  goalSeek:     { goals: 0.3, workflow: 0.15 },
};

let ppState = {
  cycles: 0,
  lastPredictions: {},    // { channel: { h1, h2, h3 } }  predictions from LAST cycle
  lastActuals: {},        // actual signals from LAST cycle
  lastErrors: {},         // per-channel prediction error from LAST cycle
  lastSurprise: 0,        // aggregate surprise level
  lastConfidence: 0.5,    // rolling prediction accuracy (0–1)
  lastAnticipatory: 0,    // directional forecast signal
  lastInjections: {},
  lastComputedAt: 0,
  surpriseSpikes: 0,
  efferenceCopy: {},       // pending motor command effects
  derivativeHistory: {},   // per-channel: array of recent 1st-derivatives for 2nd-order computation
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS predictive_processing_events (
      id TEXT PRIMARY KEY,
      predictions TEXT NOT NULL,
      errors TEXT NOT NULL,
      surprise REAL,
      confidence REAL,
      anticipatory REAL,
      injections TEXT,
      efference TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_predictive_ts ON predictive_processing_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * EP3 cube-root surprise — Stevens' power law compression.
 * Preserves sensitivity to small prediction errors while compressing
 * large ones. Sign-preserving: positive error = over-prediction,
 * negative = under-prediction.
 */
function ep3Surprise(error) {
  return Math.sign(error) * Math.cbrt(Math.abs(error));
}

/**
 * Compute 2nd-order derivative from history of 1st-order derivatives.
 * This is the "acceleration" of a sensory channel — is the rate of
 * change itself changing?
 */
function secondOrderDerivative(derivHistory) {
  if (!derivHistory || derivHistory.length < 3) return 0;
  const n = derivHistory.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += derivHistory[i];
    sumXY += i * derivHistory[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Forward model: project each sensory channel forward using Taylor expansion.
 * predictedNext = current + dBdt * dt + 0.5 * d2Bdt2 * dt²
 * where dt = horizon steps (1, 2, or 3 cycles of 5s each)
 *
 * Incorporates efference copy: pending motor effects shift predictions.
 */
function generatePredictions(currentSignals) {
  const wmData = queryWorkingMemory();
  const derivatives = wmData.derivatives || {};
  const predictions = {};

  for (const key of SENSORY_KEYS) {
    const current = currentSignals[key] || 0;
    const d1 = derivatives[key] || 0;

    // Track derivative history for 2nd-order computation
    if (!ppState.derivativeHistory[key]) ppState.derivativeHistory[key] = [];
    ppState.derivativeHistory[key].push(d1);
    if (ppState.derivativeHistory[key].length > DERIVATIVE_HISTORY_SIZE) {
      ppState.derivativeHistory[key].shift();
    }

    const d2 = secondOrderDerivative(ppState.derivativeHistory[key]);

    // Efference copy adjustment: motor commands shift expected sensory state
    const efferenceShift = ppState.efferenceCopy[key] || 0;

    const channelPredictions = {};
    for (const h of PREDICTION_HORIZONS) {
      // Taylor expansion: f(t+h) ≈ f(t) + f'(t)*h + 0.5*f''(t)*h²
      const raw = current + d1 * h + 0.5 * d2 * h * h + efferenceShift;
      channelPredictions[`h${h}`] = clamp(raw, 0, 1);
    }
    predictions[key] = channelPredictions;
  }

  return predictions;
}

/**
 * Compute per-channel prediction error: compare previous predictions
 * (horizon 1 = one cycle ahead) against current actuals.
 */
function computePredictionErrors(currentSignals) {
  const errors = {};
  const prevPredictions = ppState.lastPredictions;

  if (Object.keys(prevPredictions).length === 0) {
    for (const key of SENSORY_KEYS) errors[key] = 0;
    return errors;
  }

  for (const key of SENSORY_KEYS) {
    const predicted = prevPredictions[key]?.h1 ?? currentSignals[key] ?? 0;
    const actual = currentSignals[key] || 0;
    const rawError = actual - predicted;
    errors[key] = Math.round(ep3Surprise(rawError) * 10000) / 10000;
  }

  return errors;
}

/**
 * Record a motor firing as an efference copy for next-cycle prediction adjustment.
 * Called by motor-output when it fires an action.
 */
export function recordEfferenceCopy(motorRegion) {
  const effects = EFFERENCE_MAP[motorRegion];
  if (!effects) return;
  for (const [channel, magnitude] of Object.entries(effects)) {
    ppState.efferenceCopy[channel] = (ppState.efferenceCopy[channel] || 0) + magnitude;
  }
}

/**
 * Main prediction cycle — called by sensory bridge each 5s.
 * 1. Compute prediction errors from last cycle's predictions vs current actuals
 * 2. Update rolling confidence
 * 3. Generate new predictions for next cycle
 * 4. Inject prediction error signals into CTRNN Row 3
 * 5. Decay efference copy (motor effects are transient)
 */
export function updatePredictions(currentSignals) {
  ppState.cycles++;

  const gateMods = getAutonomyModifiers();
  const sensitivity = clamp(
    BASE_PREDICTION_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3,
    0.2, 1.2
  );

  // Step 1: Compute prediction errors
  const errors = computePredictionErrors(currentSignals);

  // Step 2: Aggregate surprise (RMS of per-channel EP3 errors)
  let sumSq = 0;
  for (const key of SENSORY_KEYS) sumSq += errors[key] * errors[key];
  const surprise = Math.round(Math.sqrt(sumSq / SENSORY_KEYS.length) * 10000) / 10000;

  // Step 3: Update rolling confidence (exponential moving average of accuracy)
  // Accuracy = 1 - normalized surprise (higher is better)
  const cycleAccuracy = clamp(1 - surprise * 2, 0, 1);
  const confidence = Math.round(
    (ppState.lastConfidence * CONFIDENCE_DECAY + cycleAccuracy * (1 - CONFIDENCE_DECAY)) * 10000
  ) / 10000;

  // Step 4: Anticipatory signal — weighted directional forecast
  // Positive = system trending upward across channels; negative = trending down
  let anticipatorySum = 0;
  const predictions = generatePredictions(currentSignals);
  for (const key of SENSORY_KEYS) {
    const predicted = predictions[key]?.h1 ?? 0;
    const current = currentSignals[key] || 0;
    anticipatorySum += (predicted - current);
  }
  const anticipatory = Math.round((anticipatorySum / SENSORY_KEYS.length) * 10000) / 10000;

  // Step 5: Inject into CTRNN Row 3
  const injections = {};
  const ctrnn = getCTRNN();
  if (ctrnn.running) {
    // Surprise: excitatory when high (drives attention/exploration)
    const surpriseAmp = clamp(surprise * sensitivity * 4, 0, 1.5);
    if (surpriseAmp > 0.01) {
      ctrnn.inject(
        PREDICTION_REGIONS.surprise.tx,
        PREDICTION_REGIONS.surprise.ty,
        PREDICTION_REGIONS.surprise.sigma,
        surpriseAmp
      );
      injections.surprise = Math.round(surpriseAmp * 1000) / 1000;
    }

    // Confidence: excitatory when predictions are accurate (stabilizing signal)
    const confAmp = clamp((confidence - 0.5) * sensitivity * 2, -1.0, 1.0);
    if (Math.abs(confAmp) > 0.01) {
      ctrnn.inject(
        PREDICTION_REGIONS.confidence.tx,
        PREDICTION_REGIONS.confidence.ty,
        PREDICTION_REGIONS.confidence.sigma,
        confAmp
      );
      injections.confidence = Math.round(confAmp * 1000) / 1000;
    }

    // Anticipatory: directional forecast for motor pre-activation
    const antiAmp = clamp(anticipatory * sensitivity * 3, -1.0, 1.0);
    if (Math.abs(antiAmp) > 0.01) {
      ctrnn.inject(
        PREDICTION_REGIONS.anticipatory.tx,
        PREDICTION_REGIONS.anticipatory.ty,
        PREDICTION_REGIONS.anticipatory.sigma,
        antiAmp
      );
      injections.anticipatory = Math.round(antiAmp * 1000) / 1000;
    }
  }

  // Step 6: Decay efference copy (motor effects are transient, ~1 cycle half-life)
  for (const key of SENSORY_KEYS) {
    if (ppState.efferenceCopy[key]) {
      ppState.efferenceCopy[key] *= 0.3; // rapid decay — motor effect mostly in first cycle
      if (Math.abs(ppState.efferenceCopy[key]) < 0.01) {
        delete ppState.efferenceCopy[key];
      }
    }
  }

  // Update state
  ppState.lastPredictions = predictions;
  ppState.lastActuals = { ...currentSignals };
  ppState.lastErrors = errors;
  ppState.lastSurprise = surprise;
  ppState.lastConfidence = confidence;
  ppState.lastAnticipatory = anticipatory;
  ppState.lastInjections = injections;
  ppState.lastComputedAt = now();

  // Publish bus event on high surprise
  if (surprise > HIGH_SURPRISE_THRESHOLD) {
    ppState.surpriseSpikes++;
    try {
      publish('predictive-processing', 'system.prediction.surprise', JSON.stringify({
        surprise, confidence, anticipatory,
        topErrors: Object.entries(errors)
          .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
          .slice(0, 3)
          .map(([k, v]) => ({ channel: k, error: v })),
        tier: gateMods.tier,
        ts: now(),
      }));
    } catch (_) {}
  }

  // Periodic snapshot
  if (ppState.cycles % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO predictive_processing_events (id, predictions, errors, surprise, confidence, anticipatory, injections, efference, gate_tier, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        JSON.stringify(predictions),
        JSON.stringify(errors),
        surprise,
        confidence,
        anticipatory,
        JSON.stringify(injections),
        JSON.stringify(ppState.efferenceCopy),
        gateMods.tier,
        Math.round(sensitivity * 1000) / 1000,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM predictive_processing_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return { predictions, errors, surprise, confidence, anticipatory, injections, sensitivity, tier: gateMods.tier };
}

export function resetPredictions() {
  ppState = {
    cycles: 0,
    lastPredictions: {},
    lastActuals: {},
    lastErrors: {},
    lastSurprise: 0,
    lastConfidence: 0.5,
    lastAnticipatory: 0,
    lastInjections: {},
    lastComputedAt: 0,
    surpriseSpikes: 0,
    efferenceCopy: {},
    derivativeHistory: {},
  };
  return { reset: true };
}

export function getPredictiveStatus() {
  const gateMods = getAutonomyModifiers();
  const sensitivity = clamp(
    BASE_PREDICTION_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3,
    0.2, 1.2
  );
  return {
    cycles: ppState.cycles,
    surprise: ppState.lastSurprise,
    confidence: ppState.lastConfidence,
    anticipatory: ppState.lastAnticipatory,
    errors: ppState.lastErrors,
    predictions: ppState.lastPredictions,
    injections: ppState.lastInjections,
    efferenceCopy: ppState.efferenceCopy,
    surpriseSpikes: ppState.surpriseSpikes,
    lastComputedAt: ppState.lastComputedAt,
    gateTier: gateMods.tier,
    sensitivity: Math.round(sensitivity * 1000) / 1000,
    regions: PREDICTION_REGIONS,
    horizons: PREDICTION_HORIZONS,
  };
}

export function getPredictiveHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM predictive_processing_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function installPredictiveRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/predictive', route((_req, res) => {
    res.json(getPredictiveStatus());
  }));

  app.get('/api/intelligence/predictive/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getPredictiveHistory({ limit }) });
  }));

  app.post('/api/intelligence/predictive/reset', route((_req, res) => {
    res.json(resetPredictions());
  }));
}
