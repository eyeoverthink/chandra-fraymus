/**
 * Phase 9 — Emotional Feedback: Heart Mood → CTRNN Plasticity Modulation
 *
 * Maps the Heart emotion engine's output to CTRNN neuromodulatory parameters,
 * so emotional state shapes how the neural substrate learns, forgets, and grows.
 *
 * Biological analogy:
 *   Joy/Love  → dopamine  → ↑ hebbianRate (faster co-activation learning)
 *   Fear/Anger → norepinephrine → ↑ pruneRate (stress-induced forgetting)
 *   Surprise  → acetylcholine → ↑ neurogenesisThreshold (novelty → new connections)
 *   Sadness   → serotonin drop → ↓ biosphereRate (conservation mode)
 *
 * Also injects a diffuse "mood cloud" across the grid — a global activation
 * bias that shifts the CTRNN's energy landscape toward the current emotional tone.
 *
 * Runs on its own 10-second interval (slower than sensory bridge's 5s —
 * mood changes slower than perception).
 * Consciousness-aware: gate modifiers scale emotional sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from './ctrnn-instance.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const FEEDBACK_INTERVAL_MS = 10_000;
const SNAPSHOT_EVERY = 30;

let feedbackTimer = null;
let heartRef = null;
let feedbackState = {
  running: false,
  modulations: 0,
  lastEmotion: null,
  lastModulation: {},
  lastMoodCloud: {},
  lastModulatedAt: 0,
  startedAt: 0,
};

export function setEmotionalHeart(h) { heartRef = h; }

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS emotional_feedback_events (
      id TEXT PRIMARY KEY,
      tick INTEGER,
      primary_emotion TEXT,
      intensity REAL,
      sentiment REAL,
      plasticity_before TEXT,
      plasticity_after TEXT,
      mood_cloud TEXT,
      gate_tier TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_emotional_fb_ts ON emotional_feedback_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function readEmotionalState() {
  if (!heartRef) return null;
  try {
    const mood = heartRef.recentMood();
    if (!mood || mood.readings === 0) return null;

    const dist = mood.distribution || {};
    const total = Object.values(dist).reduce((s, v) => s + v, 0) || 1;
    const normalized = {};
    for (const [k, v] of Object.entries(dist)) {
      normalized[k] = v / total;
    }

    const positiveWeight = (normalized.joy || 0) + (normalized.love || 0);
    const negativeWeight = (normalized.anger || 0) + (normalized.fear || 0) + (normalized.anxiety || 0);
    const valence = clamp(positiveWeight - negativeWeight, -1, 1);
    const arousal = clamp(
      (normalized.anger || 0) * 0.9 +
      (normalized.fear || 0) * 0.8 +
      (normalized.surprise || 0) * 0.7 +
      (normalized.joy || 0) * 0.6 +
      (normalized.anxiety || 0) * 0.5 -
      (normalized.sadness || 0) * 0.3,
      0, 1
    );

    return {
      primary: mood.mood,
      readings: mood.readings,
      distribution: normalized,
      valence,
      arousal,
      surprise: normalized.surprise || 0,
      sadness: normalized.sadness || 0,
    };
  } catch (_) { return null; }
}

function computePlasticityModulation(emotion, gateMods) {
  if (!emotion) return null;

  const base = getCTRNN().baseConfig;
  const sensitivity = 0.5 + (gateMods.evolutionRate - 1.0) * 0.3;
  const scale = clamp(sensitivity, 0.2, 1.5);

  const { valence, arousal, surprise, sadness } = emotion;

  const hebbianRate = base.hebbianRate * (1 + valence * 0.5 * scale);
  const hebbianDecay = base.hebbianDecay * (1 - valence * 0.3 * scale);
  const pruneRate = base.pruneRate * (1 + (-valence) * 0.4 * scale + arousal * 0.2 * scale);
  const neurogenesisThreshold = base.neurogenesisThreshold * (1 + surprise * 2.0 * scale);
  const biosphereRate = base.biosphereRate * (1 - sadness * 0.5 * scale + arousal * 0.3 * scale);

  return {
    hebbianRate: clamp(hebbianRate, 0.0005, 0.015),
    hebbianDecay: clamp(hebbianDecay, 0.00001, 0.005),
    pruneRate: clamp(pruneRate, 0.0002, 0.008),
    neurogenesisThreshold: clamp(neurogenesisThreshold, 0.02, 0.4),
    biosphereRate: clamp(biosphereRate, 0.002, 0.05),
  };
}

function injectMoodCloud(emotion, gateMods) {
  const ctrnn = getCTRNN();
  if (!ctrnn.running || !emotion) return null;

  const sensitivity = 0.3 + (gateMods.neurogenesisBoost * 0.2);
  const { valence, arousal } = emotion;
  const amplitude = Math.abs(valence) * arousal * sensitivity;

  if (amplitude < 0.02) return { injected: false, amplitude: 0 };

  const gridCenter = 8;
  const sigma = 6.0;
  ctrnn.inject(gridCenter, gridCenter, sigma, amplitude * (valence >= 0 ? 1 : -0.3));

  if (arousal > 0.4) {
    const edgeAmplitude = arousal * sensitivity * 0.3;
    ctrnn.inject(0, 0, 3.0, edgeAmplitude);
    ctrnn.inject(15, 15, 3.0, edgeAmplitude);
  }

  return { injected: true, amplitude: Math.round(amplitude * 1000) / 1000, valence, arousal };
}

function applyEmotionalFeedback() {
  const ctrnn = getCTRNN();
  if (!ctrnn.running) return null;

  const emotion = readEmotionalState();
  if (!emotion) return null;

  const gateMods = getAutonomyModifiers();
  const modulation = computePlasticityModulation(emotion, gateMods);
  const modResult = modulation ? ctrnn.modulatePlasticity(modulation) : null;
  const moodCloud = injectMoodCloud(emotion, gateMods);

  feedbackState.modulations++;
  feedbackState.lastEmotion = emotion;
  feedbackState.lastModulation = modResult || {};
  feedbackState.lastMoodCloud = moodCloud || {};
  feedbackState.lastModulatedAt = now();

  if (feedbackState.modulations % SNAPSHOT_EVERY === 0 && modResult) {
    try {
      db.prepare(
        `INSERT INTO emotional_feedback_events (id, tick, primary_emotion, intensity, sentiment, plasticity_before, plasticity_after, mood_cloud, gate_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        ctrnn.tick,
        emotion.primary,
        Math.round(emotion.arousal * 1000) / 1000,
        Math.round(emotion.valence * 1000) / 1000,
        JSON.stringify(modResult.before),
        JSON.stringify(modResult.after),
        JSON.stringify(moodCloud),
        gateMods.tier,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM emotional_feedback_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return {
    emotion: { primary: emotion.primary, valence: emotion.valence, arousal: emotion.arousal },
    plasticity: modResult,
    moodCloud,
    tier: gateMods.tier,
    tick: ctrnn.tick,
  };
}

export function startEmotionalFeedback() {
  stopEmotionalFeedback();
  feedbackState = {
    running: true,
    modulations: 0,
    lastEmotion: null,
    lastModulation: {},
    lastMoodCloud: {},
    lastModulatedAt: 0,
    startedAt: now(),
  };

  feedbackTimer = setInterval(() => {
    try {
      applyEmotionalFeedback();
    } catch (e) {
      console.error(`Emotional feedback error: ${e.message}`);
    }
  }, FEEDBACK_INTERVAL_MS);

  applyEmotionalFeedback();

  return { started: true, intervalMs: FEEDBACK_INTERVAL_MS };
}

export function stopEmotionalFeedback() {
  if (feedbackTimer) {
    clearInterval(feedbackTimer);
    feedbackTimer = null;
  }

  const ctrnn = getCTRNN();
  try {
    const base = ctrnn.baseConfig;
    ctrnn.modulatePlasticity({
      hebbianRate: base.hebbianRate,
      hebbianDecay: base.hebbianDecay,
      pruneRate: base.pruneRate,
      neurogenesisThreshold: base.neurogenesisThreshold,
      biosphereRate: base.biosphereRate,
    });
  } catch (_) {}

  feedbackState.running = false;
  return { stopped: true, totalModulations: feedbackState.modulations };
}

export function getEmotionalFeedbackStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...feedbackState,
    intervalMs: FEEDBACK_INTERVAL_MS,
    gateTier: gateMods.tier,
    sensitivity: 0.5 + (gateMods.evolutionRate - 1.0) * 0.3,
  };
}

export function getEmotionalFeedbackHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM emotional_feedback_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function triggerEmotionalFeedback() {
  return applyEmotionalFeedback();
}

export function installEmotionalFeedbackRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/emotional-feedback', route((_req, res) => {
    res.json(getEmotionalFeedbackStatus());
  }));

  app.get('/api/intelligence/emotional-feedback/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getEmotionalFeedbackHistory({ limit }) });
  }));

  app.post('/api/intelligence/emotional-feedback/start', route((_req, res) => {
    res.json(startEmotionalFeedback());
  }));

  app.post('/api/intelligence/emotional-feedback/stop', route((_req, res) => {
    res.json(stopEmotionalFeedback());
  }));

  app.post('/api/intelligence/emotional-feedback/trigger', route((_req, res) => {
    const result = triggerEmotionalFeedback();
    if (!result) return res.status(409).json({ error: 'CTRNN not running or no emotional data' });
    res.json(result);
  }));
}
