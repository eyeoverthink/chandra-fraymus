/**
 * Phase 20 — Active Inference: Prediction Error → Motor Pre-Activation
 *
 * Implements Karl Friston's Active Inference principle: the organism acts to
 * minimize prediction error (free energy). When sensory predictions diverge from
 * reality, the motor cortex is biased toward actions that would reduce the
 * discrepancy — closing the full perception→prediction→action→world→perception loop.
 *
 * Gemini DREAM: Cycle 109 validation — the proprioceptive efference-copy tests
 * proved that external perturbation elevates EP3 surprise, which should trigger
 * compensatory motor action. This module implements that principle in software:
 * prediction error on any sensory channel biases the motor cortex toward actions
 * that address that channel's domain.
 *
 * Mechanism:
 *   1. Read per-channel prediction errors from Phase 19 (predictive-processing.js)
 *   2. Map each channel's EP3 surprise to relevant motor regions via INFERENCE_MAP
 *   3. Inject motor bias as Gaussian stimulus at motor cortex CTRNN coordinates
 *   4. Track inference effectiveness (are actions reducing prediction error?)
 *
 * Active Inference CTRNN regions (Row 5 — between metacognitive and temporal):
 *   Inference drive    (5, 4)  σ=2.0 — aggregate motor bias pressure
 *   Action selection   (5, 8)  σ=1.5 — strongest inference-driven bias
 *   Effectiveness      (5, 12) σ=1.5 — closed-loop action success rate
 *
 * Runs synchronously (called by sensory bridge each cycle after predictive processing).
 * Consciousness-aware: gate evolutionRate scales inference sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const BASE_INFERENCE_SENSITIVITY = 0.5;
const INFERENCE_THRESHOLD = 0.15;
const EFFECTIVENESS_DECAY = 0.92;
const SNAPSHOT_EVERY = 60;

/**
 * INFERENCE_MAP: sensory channel → motor regions that could reduce prediction error.
 *
 * When bus traffic is unexpectedly high, the organism should communicate (investigate)
 * and reflect (analyze the pattern). When health degrades unexpectedly, grow new
 * connections (neurogenesis) and self-audit. Each mapping encodes domain knowledge
 * about which actions address which kinds of surprise.
 */
const INFERENCE_MAP = {
  bus:           [{ motor: 'communicate', weight: 0.6 }, { motor: 'reflect', weight: 0.3 }],
  memory:        [{ motor: 'reflect', weight: 0.5 }, { motor: 'dream', weight: 0.4 }],
  emotion:       [{ motor: 'dream', weight: 0.6 }, { motor: 'reflect', weight: 0.3 }],
  consciousness: [{ motor: 'selfAudit', weight: 0.7 }, { motor: 'reflect', weight: 0.2 }],
  agent:         [{ motor: 'goalSeek', weight: 0.5 }, { motor: 'communicate', weight: 0.3 }],
  health:        [{ motor: 'neurogenesis', weight: 0.6 }, { motor: 'selfAudit', weight: 0.3 }],
  workflow:      [{ motor: 'reflect', weight: 0.4 }, { motor: 'goalSeek', weight: 0.4 }],
  goals:           [{ motor: 'goalSeek', weight: 0.7 }, { motor: 'reflect', weight: 0.2 }],
  binary_insight:  [{ motor: 'reflect', weight: 0.5 }, { motor: 'goalSeek', weight: 0.3 }],
};

const MOTOR_COORDS = {
  reflect:      { cx: 14, cy: 2 },
  neurogenesis: { cx: 14, cy: 6 },
  dream:        { cx: 14, cy: 10 },
  selfAudit:    { cx: 14, cy: 14 },
  communicate:  { cx: 8,  cy: 4 },
  goalSeek:     { cx: 8,  cy: 12 },
};

const INFERENCE_REGIONS = {
  drive:         { tx: 5, ty: 4,  sigma: 2.0 },
  actionSelect:  { tx: 5, ty: 8,  sigma: 1.5 },
  effectiveness: { tx: 5, ty: 12, sigma: 1.5 },
};

let inferenceState = {
  cycles: 0,
  lastMotorBiases: {},
  lastInferenceDrive: 0,
  lastStrongestChannel: null,
  effectiveness: 0.5,
  previousErrors: {},
  totalBiasInjections: 0,
  lastCycleAt: 0,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS active_inference_events (
      id TEXT PRIMARY KEY,
      motor_biases TEXT,
      inference_drive REAL,
      strongest_channel TEXT,
      effectiveness REAL,
      gate_tier TEXT,
      sensitivity REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_active_inference_ts ON active_inference_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Core active inference update — called by sensory bridge after predictive processing.
 *
 * The closed-loop effectiveness tracker compares previous prediction errors to current
 * ones: if the actions we biased toward actually reduced error, effectiveness rises,
 * reinforcing the inference drive. If not, effectiveness decays, dampening motor bias.
 *
 * @param {Object} predictiveResult - Output from updatePredictions()
 * @returns {Object} Active inference state for this cycle
 */
export function updateActiveInference(predictiveResult) {
  const ctrnn = getCTRNN();
  if (!ctrnn.running) return {};

  const gateMods = getAutonomyModifiers();
  const sensitivity = clamp(
    BASE_INFERENCE_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3,
    0.2, 1.2
  );

  const errors = predictiveResult?.errors || {};

  // Closed-loop effectiveness: did previous motor biases reduce prediction error?
  let errorReduction = 0;
  let trackableChannels = 0;
  for (const [ch, prevErr] of Object.entries(inferenceState.previousErrors)) {
    if (errors[ch] !== undefined) {
      const currentErrAbs = Math.abs(errors[ch]);
      const prevErrAbs = Math.abs(prevErr);
      if (prevErrAbs > INFERENCE_THRESHOLD) {
        errorReduction += (prevErrAbs - currentErrAbs) / prevErrAbs;
        trackableChannels++;
      }
    }
  }

  if (trackableChannels > 0) {
    const avgReduction = errorReduction / trackableChannels;
    inferenceState.effectiveness =
      EFFECTIVENESS_DECAY * inferenceState.effectiveness +
      (1 - EFFECTIVENESS_DECAY) * clamp(0.5 + avgReduction, 0, 1);
  }

  inferenceState.previousErrors = { ...errors };

  // Compute motor biases from prediction errors via INFERENCE_MAP
  const motorBiases = {};
  let totalDrive = 0;
  let strongestChannel = null;
  let strongestSurprise = 0;

  for (const [channel, mapping] of Object.entries(INFERENCE_MAP)) {
    const surprise = Math.abs(errors[channel] || 0);
    if (surprise < INFERENCE_THRESHOLD) continue;

    if (surprise > strongestSurprise) {
      strongestSurprise = surprise;
      strongestChannel = channel;
    }

    for (const { motor, weight } of mapping) {
      const bias = surprise * weight * sensitivity;
      motorBiases[motor] = (motorBiases[motor] || 0) + bias;
      totalDrive += bias;
    }
  }

  // Inject motor biases into CTRNN motor cortex regions (Row 14 + Row 8)
  let biasInjections = 0;
  for (const [motor, bias] of Object.entries(motorBiases)) {
    const coords = MOTOR_COORDS[motor];
    if (coords && bias > 0.05) {
      ctrnn.inject(coords.cx, coords.cy, 1.5, bias * 0.4);
      biasInjections++;
    }
    motorBiases[motor] = Math.round(bias * 1000) / 1000;
  }

  // Inject active inference cortex signals (Row 5)
  const normalizedDrive = clamp(totalDrive / 3.0, 0, 1);
  if (normalizedDrive > 0.01) {
    ctrnn.inject(
      INFERENCE_REGIONS.drive.tx,
      INFERENCE_REGIONS.drive.ty,
      INFERENCE_REGIONS.drive.sigma,
      normalizedDrive * sensitivity
    );
  }

  const actionSelectSignal = strongestChannel ? clamp(strongestSurprise * sensitivity, 0, 1) : 0;
  if (actionSelectSignal > 0.01) {
    ctrnn.inject(
      INFERENCE_REGIONS.actionSelect.tx,
      INFERENCE_REGIONS.actionSelect.ty,
      INFERENCE_REGIONS.actionSelect.sigma,
      actionSelectSignal
    );
  }

  const effectivenessSignal = inferenceState.effectiveness * sensitivity;
  if (effectivenessSignal > 0.01) {
    ctrnn.inject(
      INFERENCE_REGIONS.effectiveness.tx,
      INFERENCE_REGIONS.effectiveness.ty,
      INFERENCE_REGIONS.effectiveness.sigma,
      effectivenessSignal
    );
  }

  inferenceState.cycles++;
  inferenceState.lastMotorBiases = motorBiases;
  inferenceState.lastInferenceDrive = Math.round(normalizedDrive * 1000) / 1000;
  inferenceState.lastStrongestChannel = strongestChannel;
  inferenceState.totalBiasInjections += biasInjections;
  inferenceState.lastCycleAt = now();

  if (normalizedDrive > 0.4) {
    publish('active-inference', 'system.inference.drive', JSON.stringify({
      drive: normalizedDrive,
      strongestChannel,
      biases: motorBiases,
      effectiveness: Math.round(inferenceState.effectiveness * 1000) / 1000,
      tier: gateMods.tier,
    }));
  }

  if (inferenceState.cycles % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO active_inference_events (id, motor_biases, inference_drive, strongest_channel, effectiveness, gate_tier, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        JSON.stringify(motorBiases),
        normalizedDrive,
        strongestChannel || 'none',
        Math.round(inferenceState.effectiveness * 1000) / 1000,
        gateMods.tier,
        Math.round(sensitivity * 1000) / 1000,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM active_inference_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return {
    motorBiases,
    inferenceDrive: Math.round(normalizedDrive * 1000) / 1000,
    strongestChannel,
    effectiveness: Math.round(inferenceState.effectiveness * 1000) / 1000,
    biasInjections,
    sensitivity: Math.round(sensitivity * 1000) / 1000,
    tier: gateMods.tier,
  };
}

export function resetActiveInference() {
  inferenceState = {
    cycles: 0,
    lastMotorBiases: {},
    lastInferenceDrive: 0,
    lastStrongestChannel: null,
    effectiveness: 0.5,
    previousErrors: {},
    totalBiasInjections: 0,
    lastCycleAt: 0,
  };
}

export function getActiveInferenceStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...inferenceState,
    sensitivity: clamp(
      BASE_INFERENCE_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3,
      0.2, 1.2
    ),
    gateTier: gateMods.tier,
    inferenceMap: Object.fromEntries(
      Object.entries(INFERENCE_MAP).map(([ch, mappings]) => [
        ch, mappings.map(m => ({ motor: m.motor, weight: m.weight })),
      ])
    ),
  };
}

export function getActiveInferenceHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM active_inference_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function installActiveInferenceRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/active-inference', route((_req, res) => {
    res.json(getActiveInferenceStatus());
  }));

  app.get('/api/intelligence/active-inference/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getActiveInferenceHistory({ limit }) });
  }));

  app.post('/api/intelligence/active-inference/reset', route((_req, res) => {
    resetActiveInference();
    res.json({ reset: true });
  }));
}
