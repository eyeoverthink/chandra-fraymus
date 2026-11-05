/**
 * Phase 13 — Working Memory: Temporal Buffer & Trend Detection
 *
 * Maintains a circular buffer of recent sensory frames (signals, amplitudes,
 * attention weights, novelty factors) and computes temporal derivatives —
 * giving the CTRNN a sense of whether things are ramping up, winding down,
 * or volatile. Three aggregate temporal signals are injected into dedicated
 * CTRNN "temporal cortex" regions.
 *
 * Biological analogy:
 *   Prefrontal working memory maintains task-relevant information across
 *   seconds to minutes. Temporal integration in auditory cortex tracks
 *   changes over time. Hippocampal time cells encode elapsed time.
 *
 * Temporal cortex CTRNN regions (row 6 — between sensory and motor bands):
 *   Trend direction  (6, 4)  σ=1.5  — aggregate derivative sign: positive = ramping up
 *   Volatility       (6, 8)  σ=2.0  — sum of |derivatives|: high = rapid change
 *   Coherence        (6, 12) σ=1.5  — channel correlation: high = coordinated shift
 *
 * Buffer: 24 frames = 2 minutes at 5s sensory interval.
 * Runs synchronously (called by sensory bridge each cycle).
 * Consciousness-aware: gate evolutionRate scales temporal sensitivity.
 */

import { getAutonomyModifiers } from './consciousness-gate.js';
import { getCTRNN } from './ctrnn-instance.js';
import { publish } from '../fleet/bus.js';
import { db } from '../db.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const BUFFER_SIZE = 24;
const SNAPSHOT_EVERY = 60;
const MIN_FRAMES_FOR_DERIVATIVE = 3;
const BASE_TEMPORAL_SENSITIVITY = 0.6;
const TREND_SPIKE_THRESHOLD = 0.4;

const SENSORY_KEYS = ['bus', 'memory', 'emotion', 'consciousness', 'agent', 'health', 'workflow', 'goals'];

const TEMPORAL_REGIONS = {
  trend:     { tx: 6, ty: 4,  sigma: 1.5, label: 'Trend direction' },
  volatility: { tx: 6, ty: 8,  sigma: 2.0, label: 'Volatility' },
  coherence: { tx: 6, ty: 12, sigma: 1.5, label: 'Coherence' },
};

const frameBuffer = [];

let wmState = {
  frames: 0,
  lastDerivatives: {},
  lastTrend: 0,
  lastVolatility: 0,
  lastCoherence: 0,
  lastInjections: {},
  lastComputedAt: 0,
  trendSpikes: 0,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS working_memory_events (
      id TEXT PRIMARY KEY,
      derivatives TEXT NOT NULL,
      trend REAL,
      volatility REAL,
      coherence REAL,
      injections TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      buffer_depth INTEGER,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_working_memory_ts ON working_memory_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function linearSlope(values) {
  const n = values.length;
  if (n < MIN_FRAMES_FOR_DERIVATIVE) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function channelVariance(values) {
  const n = values.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (values[i] - mean) ** 2;
  return variance / (n - 1);
}

export function updateWorkingMemory(frame) {
  frameBuffer.push({
    signals: { ...frame.signals },
    amplitudes: { ...frame.amplitudes },
    attentionWeights: { ...(frame.attentionWeights || {}) },
    noveltyFactors: { ...(frame.noveltyFactors || {}) },
    ts: now(),
  });
  if (frameBuffer.length > BUFFER_SIZE) frameBuffer.shift();

  if (frameBuffer.length < MIN_FRAMES_FOR_DERIVATIVE) {
    wmState.frames = frameBuffer.length;
    wmState.lastComputedAt = now();
    return { derivatives: {}, trend: 0, volatility: 0, coherence: 0, injections: {}, bufferDepth: frameBuffer.length };
  }

  const gateMods = getAutonomyModifiers();
  const sensitivity = BASE_TEMPORAL_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3;
  const effectiveSensitivity = clamp(sensitivity, 0.2, 1.2);

  const derivatives = {};
  const variances = {};
  for (const key of SENSORY_KEYS) {
    const values = frameBuffer.map(f => f.signals[key] || 0);
    derivatives[key] = Math.round(linearSlope(values) * 10000) / 10000;
    variances[key] = Math.round(channelVariance(values) * 10000) / 10000;
  }

  let trendSum = 0;
  let volatilitySum = 0;
  for (const key of SENSORY_KEYS) {
    trendSum += derivatives[key];
    volatilitySum += Math.abs(derivatives[key]);
  }
  const trend = Math.round((trendSum / SENSORY_KEYS.length) * 10000) / 10000;
  const volatility = Math.round((volatilitySum / SENSORY_KEYS.length) * 10000) / 10000;

  let coherence = 0;
  if (volatilitySum > 0.001) {
    const signs = SENSORY_KEYS.map(k => Math.sign(derivatives[k]));
    const positiveCount = signs.filter(s => s > 0).length;
    const negativeCount = signs.filter(s => s < 0).length;
    const dominant = Math.max(positiveCount, negativeCount);
    const moving = positiveCount + negativeCount;
    coherence = moving > 0 ? Math.round((dominant / moving) * 1000) / 1000 : 0;
  }

  const injections = {};
  const ctrnn = getCTRNN();
  if (ctrnn.running) {
    const trendAmp = clamp(Math.abs(trend) * effectiveSensitivity * 5, 0, 1.5);
    if (trendAmp > 0.01) {
      ctrnn.inject(TEMPORAL_REGIONS.trend.tx, TEMPORAL_REGIONS.trend.ty, TEMPORAL_REGIONS.trend.sigma, trend > 0 ? trendAmp : -trendAmp);
      injections.trend = Math.round(trendAmp * (trend > 0 ? 1 : -1) * 1000) / 1000;
    }

    const volAmp = clamp(volatility * effectiveSensitivity * 4, 0, 1.5);
    if (volAmp > 0.01) {
      ctrnn.inject(TEMPORAL_REGIONS.volatility.tx, TEMPORAL_REGIONS.volatility.ty, TEMPORAL_REGIONS.volatility.sigma, volAmp);
      injections.volatility = Math.round(volAmp * 1000) / 1000;
    }

    const cohAmp = clamp(coherence * effectiveSensitivity * 0.8, 0, 1.0);
    if (cohAmp > 0.01) {
      ctrnn.inject(TEMPORAL_REGIONS.coherence.tx, TEMPORAL_REGIONS.coherence.ty, TEMPORAL_REGIONS.coherence.sigma, cohAmp);
      injections.coherence = Math.round(cohAmp * 1000) / 1000;
    }
  }

  wmState.frames = frameBuffer.length;
  wmState.lastDerivatives = derivatives;
  wmState.lastVariances = variances;
  wmState.lastTrend = trend;
  wmState.lastVolatility = volatility;
  wmState.lastCoherence = coherence;
  wmState.lastInjections = injections;
  wmState.lastComputedAt = now();

  if (volatility > TREND_SPIKE_THRESHOLD) {
    wmState.trendSpikes++;
    try {
      publish('working-memory', 'system.working-memory.trend-spike', JSON.stringify({
        trend, volatility, coherence,
        derivatives,
        tier: gateMods.tier,
        ts: now(),
      }));
    } catch (_) {}
  }

  if ((wmState.frames + wmState.trendSpikes) % SNAPSHOT_EVERY === 0 && wmState.frames > 0) {
    try {
      db.prepare(
        `INSERT INTO working_memory_events (id, derivatives, trend, volatility, coherence, injections, gate_tier, sensitivity, buffer_depth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        JSON.stringify(derivatives),
        trend,
        volatility,
        coherence,
        JSON.stringify(injections),
        gateMods.tier,
        Math.round(effectiveSensitivity * 1000) / 1000,
        frameBuffer.length,
        now()
      );
    } catch (_) {}

    try {
      db.prepare(`DELETE FROM working_memory_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return { derivatives, variances, trend, volatility, coherence, injections, bufferDepth: frameBuffer.length };
}

export function queryWorkingMemory({ channel, lastN } = {}) {
  const depth = Math.min(frameBuffer.length, Math.max(1, lastN || BUFFER_SIZE));
  const frames = frameBuffer.slice(-depth);

  if (channel && SENSORY_KEYS.includes(channel)) {
    return {
      channel,
      values: frames.map(f => f.signals[channel] || 0),
      amplitudes: frames.map(f => f.amplitudes[channel] || 0),
      derivative: wmState.lastDerivatives[channel] || 0,
      variance: wmState.lastVariances?.[channel] || 0,
      timestamps: frames.map(f => f.ts),
    };
  }

  return {
    bufferDepth: frames.length,
    maxDepth: BUFFER_SIZE,
    derivatives: wmState.lastDerivatives,
    variances: wmState.lastVariances || {},
    trend: wmState.lastTrend,
    volatility: wmState.lastVolatility,
    coherence: wmState.lastCoherence,
    channels: Object.fromEntries(SENSORY_KEYS.map(k => [k, {
      current: frames.length > 0 ? (frames[frames.length - 1].signals[k] || 0) : 0,
      mean: frames.length > 0 ? Math.round(frames.reduce((s, f) => s + (f.signals[k] || 0), 0) / frames.length * 1000) / 1000 : 0,
      derivative: wmState.lastDerivatives[k] || 0,
      variance: wmState.lastVariances?.[k] || 0,
    }])),
  };
}

export function resetWorkingMemory() {
  frameBuffer.length = 0;
  wmState = {
    frames: 0,
    lastDerivatives: {},
    lastVariances: {},
    lastTrend: 0,
    lastVolatility: 0,
    lastCoherence: 0,
    lastInjections: {},
    lastComputedAt: 0,
    trendSpikes: 0,
  };
  return { reset: true };
}

export function getWorkingMemoryStatus() {
  const gateMods = getAutonomyModifiers();
  const sensitivity = clamp(BASE_TEMPORAL_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3, 0.2, 1.2);
  return {
    ...wmState,
    bufferSize: BUFFER_SIZE,
    bufferDepth: frameBuffer.length,
    minFramesForDerivative: MIN_FRAMES_FOR_DERIVATIVE,
    gateTier: gateMods.tier,
    sensitivity: Math.round(sensitivity * 1000) / 1000,
    temporalRegions: TEMPORAL_REGIONS,
  };
}

export function getWorkingMemoryHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM working_memory_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function installWorkingMemoryRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/working-memory', route((_req, res) => {
    res.json(getWorkingMemoryStatus());
  }));

  app.get('/api/intelligence/working-memory/query', route((req, res) => {
    const channel = SENSORY_KEYS.includes(req.query.channel) ? req.query.channel : undefined;
    const lastN = Math.min(BUFFER_SIZE, Math.max(1, parseInt(req.query.lastN) || BUFFER_SIZE));
    res.json(queryWorkingMemory({ channel, lastN }));
  }));

  app.get('/api/intelligence/working-memory/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getWorkingMemoryHistory({ limit }) });
  }));

  app.post('/api/intelligence/working-memory/reset', route((_req, res) => {
    res.json(resetWorkingMemory());
  }));
}
