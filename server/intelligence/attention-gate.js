/**
 * Phase 11 — Attention Gate: Top-Down Selective Sensory Amplification
 *
 * Reads motor cortex activation patterns and emotional state, then computes
 * per-sensory-region attention weights that the sensory bridge uses to
 * amplify or suppress specific inputs. This is top-down attention: the
 * CTRNN's own intentions and feelings shape what it perceives.
 *
 * Biological analogy:
 *   Prefrontal cortex (motor planning) → sensory cortex gain modulation
 *   Amygdala (emotion) → sensory cortex salience enhancement
 *
 * Motor → Sensory attention mapping:
 *   reflect      → amplify: memory, consciousness  (introspection needs self-awareness)
 *   neurogenesis → amplify: health, consciousness   (growth needs health context)
 *   dream        → amplify: emotion, memory         (dreams consolidate emotional memories)
 *   selfAudit    → amplify: consciousness, health   (self-audit needs system state)
 *   communicate  → amplify: bus, agent              (communication needs social awareness)
 *   goalSeek     → amplify: goals, workflow          (goal-seeking needs action context)
 *
 * Emotional → Sensory attention:
 *   High arousal       → amplify: emotion, health   (body awareness under stress)
 *   Positive valence   → amplify: goals, agent      (optimism → action orientation)
 *   Negative valence   → amplify: health, consciousness (concern → self-monitoring)
 *
 * Attention weights range [0.5, 3.0] — no region goes fully dark.
 * Runs synchronously (called by sensory bridge each cycle, no own timer).
 * Consciousness-aware: gate evolutionRate scales attention dynamic range.
 */

import { getAutonomyModifiers } from './consciousness-gate.js';
import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { SENSORY_KEYS } from './sensory-channels.js';

const now = () => Date.now();

const SNAPSHOT_EVERY = 60;
const MIN_GAIN = 0.5;
const MAX_GAIN = 3.0;
const BASE_MOTOR_INFLUENCE = 0.8;
const BASE_EMOTION_INFLUENCE = 0.4;

// Phase Q: outward channels join the map — communicating sharpens the social senses
// (mesh, user), goal-seeking sharpens the market senses (commerce, youtube, web),
// reflection sharpens awareness of the repository's own change (git).
const MOTOR_SENSORY_MAP = {
  reflect:      { primary: ['memory', 'consciousness', 'binary_insight', 'git'], weight: 1.0 },
  neurogenesis: { primary: ['health', 'consciousness'], weight: 0.8 },
  dream:        { primary: ['emotion', 'memory'],       weight: 0.9 },
  selfAudit:    { primary: ['consciousness', 'health', 'binary_insight', 'git'], weight: 0.7 },
  communicate:  { primary: ['bus', 'agent', 'mesh', 'user'], weight: 0.9 },
  goalSeek:     { primary: ['goals', 'workflow', 'commerce', 'youtube', 'web'], weight: 1.0 },
};

let motorReadingsFn = null;
let emotionReadingsFn = null;

let attentionState = {
  computations: 0,
  lastWeights: {},
  lastMotorInfluence: {},
  lastEmotionInfluence: {},
  lastComputedAt: 0,
};

export function setAttentionSources({ getMotorReadings, getEmotionState } = {}) {
  if (getMotorReadings) motorReadingsFn = getMotorReadings;
  if (getEmotionState) emotionReadingsFn = getEmotionState;
}

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS attention_gate_events (
      id TEXT PRIMARY KEY,
      weights TEXT NOT NULL,
      motor_influence TEXT,
      emotion_influence TEXT,
      gate_tier TEXT,
      dynamic_range REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_attention_ts ON attention_gate_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeMotorAttention(motorReadings, dynamicRange) {
  const influence = {};
  for (const key of SENSORY_KEYS) influence[key] = 0;

  if (!motorReadings || Object.keys(motorReadings).length === 0) return influence;

  for (const [motorKey, mapping] of Object.entries(MOTOR_SENSORY_MAP)) {
    const activation = motorReadings[motorKey] || 0;
    if (activation < 0.1) continue;

    const boost = activation * mapping.weight * BASE_MOTOR_INFLUENCE * dynamicRange;
    for (const sensoryKey of mapping.primary) {
      influence[sensoryKey] = Math.max(influence[sensoryKey], boost);
    }
  }

  return influence;
}

function computeEmotionAttention(emotionState, dynamicRange) {
  const influence = {};
  for (const key of SENSORY_KEYS) influence[key] = 0;

  if (!emotionState) return influence;

  const { valence = 0, arousal = 0 } = emotionState;
  const scale = BASE_EMOTION_INFLUENCE * dynamicRange;

  if (arousal > 0.3) {
    influence.emotion += arousal * scale * 0.6;
    influence.health += arousal * scale * 0.4;
  }

  if (valence > 0.1) {
    influence.goals += valence * scale * 0.5;
    influence.agent += valence * scale * 0.3;
  } else if (valence < -0.1) {
    influence.health += Math.abs(valence) * scale * 0.5;
    influence.consciousness += Math.abs(valence) * scale * 0.4;
  }

  return influence;
}

export function computeAttentionWeights() {
  const gateMods = getAutonomyModifiers();
  const dynamicRange = clamp(0.5 + (gateMods.evolutionRate - 1.0) * 0.5, 0.3, 1.5);

  let motorReadings = null;
  try {
    if (motorReadingsFn) motorReadings = motorReadingsFn();
  } catch (_) {}

  let emotionState = null;
  try {
    if (emotionReadingsFn) emotionState = emotionReadingsFn();
  } catch (_) {}

  const motorInfluence = computeMotorAttention(motorReadings, dynamicRange);
  const emotionInfluence = computeEmotionAttention(emotionState, dynamicRange);

  const weights = {};
  for (const key of SENSORY_KEYS) {
    const combined = 1.0 + (motorInfluence[key] || 0) + (emotionInfluence[key] || 0);
    weights[key] = Math.round(clamp(combined, MIN_GAIN, MAX_GAIN) * 1000) / 1000;
  }

  attentionState.computations++;
  attentionState.lastWeights = weights;
  attentionState.lastMotorInfluence = motorInfluence;
  attentionState.lastEmotionInfluence = emotionInfluence;
  attentionState.lastComputedAt = now();

  if (attentionState.computations % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO attention_gate_events (id, weights, motor_influence, emotion_influence, gate_tier, dynamic_range, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        JSON.stringify(weights),
        JSON.stringify(motorInfluence),
        JSON.stringify(emotionInfluence),
        gateMods.tier,
        Math.round(dynamicRange * 1000) / 1000,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM attention_gate_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return weights;
}

export function getAttentionGateStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...attentionState,
    gateTier: gateMods.tier,
    dynamicRange: Math.round(clamp(0.5 + (gateMods.evolutionRate - 1.0) * 0.5, 0.3, 1.5) * 1000) / 1000,
    sourceConnected: {
      motor: !!motorReadingsFn,
      emotion: !!emotionReadingsFn,
    },
  };
}

export function getAttentionGateHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM attention_gate_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function installAttentionGateRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/attention', route((_req, res) => {
    res.json(getAttentionGateStatus());
  }));

  app.get('/api/intelligence/attention/weights', route((_req, res) => {
    res.json({ weights: computeAttentionWeights() });
  }));

  app.get('/api/intelligence/attention/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getAttentionGateHistory({ limit }) });
  }));
}
