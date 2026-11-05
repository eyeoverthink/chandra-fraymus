/**
 * Phase 12 — Habituation & Novelty Detection
 *
 * Tracks rolling signal history per sensory channel and computes a
 * per-region novelty factor. Constant signals get attenuated (habituation),
 * changing signals get amplified (novelty detection). This is the temporal
 * complement to Phase 11's top-down attention: attention selects WHAT to
 * sense, habituation selects WHEN a signal matters.
 *
 * Biological analogy:
 *   Sensory adaptation — neurons literally reduce firing rate to constant
 *   stimuli (Aplysia gill reflex, retinal adaptation, auditory habituation).
 *   Novelty neurons in the hippocampus fire specifically for unexpected inputs.
 *
 * Per-channel computation:
 *   rollingMean = average of last WINDOW_SIZE signal values
 *   delta = |current - rollingMean| / max(rollingMean, epsilon)
 *   novelty = BASE_NOVELTY + delta * noveltyScale * dynamicRange
 *   clamped to [MIN_NOVELTY, MAX_NOVELTY]
 *
 * BASE_NOVELTY = 0.7 — constant signals still get 70% through (never fully dark)
 * Novelty spikes (> SPIKE_THRESHOLD) publish to bus for other subsystems.
 *
 * Runs synchronously (called by sensory bridge each cycle, no own timer).
 * Consciousness-aware: gate evolutionRate scales novelty sensitivity.
 */

import { getAutonomyModifiers } from './consciousness-gate.js';
import { publish } from '../fleet/bus.js';
import { db } from '../db.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const WINDOW_SIZE = 12;
const EPSILON = 0.01;
const BASE_NOVELTY = 0.7;
const MIN_NOVELTY = 0.3;
const MAX_NOVELTY = 2.5;
const BASE_NOVELTY_SCALE = 3.0;
const SPIKE_THRESHOLD = 1.8;
const SNAPSHOT_EVERY = 60;

const SENSORY_KEYS = ['bus', 'memory', 'emotion', 'consciousness', 'agent', 'health', 'workflow', 'goals'];

const signalHistory = {};
for (const key of SENSORY_KEYS) signalHistory[key] = [];

let habState = {
  computations: 0,
  lastNovelty: {},
  lastSpikes: [],
  totalSpikes: 0,
  lastComputedAt: 0,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS habituation_events (
      id TEXT PRIMARY KEY,
      novelty_factors TEXT NOT NULL,
      spikes TEXT,
      gate_tier TEXT,
      dynamic_range REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_habituation_ts ON habituation_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function pushSignal(key, value) {
  const history = signalHistory[key];
  history.push(value);
  if (history.length > WINDOW_SIZE) history.shift();
}

function rollingMean(key) {
  const history = signalHistory[key];
  if (history.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < history.length; i++) sum += history[i];
  return sum / history.length;
}

export function computeNoveltyFactors(signals) {
  const gateMods = getAutonomyModifiers();
  const dynamicRange = clamp(0.5 + (gateMods.evolutionRate - 1.0) * 0.5, 0.3, 1.5);
  const noveltyScale = BASE_NOVELTY_SCALE * dynamicRange;

  const factors = {};
  const spikes = [];

  for (const key of SENSORY_KEYS) {
    const raw = signals[key] || 0;
    const mean = rollingMean(key);

    pushSignal(key, raw);

    const delta = Math.abs(raw - mean) / Math.max(mean, EPSILON);
    const novelty = clamp(BASE_NOVELTY + delta * noveltyScale, MIN_NOVELTY, MAX_NOVELTY);

    factors[key] = Math.round(novelty * 1000) / 1000;

    if (novelty >= SPIKE_THRESHOLD) {
      spikes.push({ key, novelty: factors[key], delta: Math.round(delta * 1000) / 1000, mean: Math.round(mean * 1000) / 1000, raw: Math.round(raw * 1000) / 1000 });
    }
  }

  habState.computations++;
  habState.lastNovelty = factors;
  habState.lastSpikes = spikes;
  habState.lastComputedAt = now();

  if (spikes.length > 0) {
    habState.totalSpikes += spikes.length;
    try {
      publish('habituation', 'system.habituation.spike', JSON.stringify({
        spikes,
        tier: gateMods.tier,
        ts: now(),
      }));
    } catch (_) {}
  }

  if (habState.computations % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO habituation_events (id, novelty_factors, spikes, gate_tier, dynamic_range, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        JSON.stringify(factors),
        spikes.length > 0 ? JSON.stringify(spikes) : null,
        gateMods.tier,
        Math.round(dynamicRange * 1000) / 1000,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM habituation_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return factors;
}

export function resetHabituation() {
  for (const key of SENSORY_KEYS) signalHistory[key] = [];
  habState = {
    computations: 0,
    lastNovelty: {},
    lastSpikes: [],
    totalSpikes: 0,
    lastComputedAt: 0,
  };
  return { reset: true };
}

export function getHabituationStatus() {
  const gateMods = getAutonomyModifiers();
  const histories = {};
  for (const key of SENSORY_KEYS) {
    histories[key] = {
      windowSize: signalHistory[key].length,
      mean: Math.round(rollingMean(key) * 1000) / 1000,
    };
  }
  return {
    ...habState,
    windowSize: WINDOW_SIZE,
    gateTier: gateMods.tier,
    dynamicRange: Math.round(clamp(0.5 + (gateMods.evolutionRate - 1.0) * 0.5, 0.3, 1.5) * 1000) / 1000,
    channels: histories,
  };
}

export function getHabituationHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM habituation_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function installHabituationRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/habituation', route((_req, res) => {
    res.json(getHabituationStatus());
  }));

  app.get('/api/intelligence/habituation/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getHabituationHistory({ limit }) });
  }));

  app.post('/api/intelligence/habituation/reset', route((_req, res) => {
    res.json(resetHabituation());
  }));
}
