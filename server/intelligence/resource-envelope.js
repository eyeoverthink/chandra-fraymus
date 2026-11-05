/**
 * Phase 18 — Resource Envelope: Bounded Intelligence
 *
 * The debate engine flagged "unbounded resources → catastrophic failure" 20 times.
 * This module gives the system awareness of its own resource limits — heap memory,
 * DB size, Ollama availability, concurrent run count, CTRNN tick drift — so the
 * consciousness gate, adaptive strategy, and motor output can throttle before
 * the system overextends.
 *
 * Biological analogue: energy homeostasis + fatigue sensing. An organism that
 * doesn't feel tiredness runs until it collapses. This module is the system's
 * sense of how much capacity it has left.
 *
 * CTRNN resource regions (row 1 — just below proprioceptive crown):
 *   Energy level   (1, 4)  σ=2.0 — inverse of pressure (high = resources free)
 *   Fatigue signal (1, 12) σ=2.0 — sustained high pressure (inhibitory)
 *
 * Interval: 10s (between sensory 5s and motor 15s — resource state changes
 * faster than cognitive quality but slower than raw sensory input)
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { OLLAMA_URL } from '../config.js';
import { getAutonomyModifiers } from './consciousness-gate.js';

const now = () => Date.now();

const ENVELOPE_INTERVAL_MS = 10_000;
const SNAPSHOT_EVERY = 30;
const BASE_RESOURCE_SENSITIVITY = 0.5;

const RESOURCE_BUDGETS = {
  heapMB: { ceiling: 512, warning: 384, critical: 480 },
  dbSizeMB: { ceiling: 2048, warning: 1024, critical: 1800 },
  concurrentRuns: { ceiling: 8, warning: 5, critical: 7 },
  ollamaLatencyMs: { ceiling: 30_000, warning: 10_000, critical: 20_000 },
  busBacklog: { ceiling: 100, warning: 50, critical: 80 },
};

const PRESSURE_WEIGHTS = {
  heap: 0.25,
  dbSize: 0.15,
  concurrentRuns: 0.25,
  ollamaLatency: 0.20,
  busBacklog: 0.15,
};

let envelopeTimer = null;
let ctrnnRef = null;
let fatigueAccumulator = 0;
const FATIGUE_DECAY = 0.92;
const FATIGUE_THRESHOLD = 0.7;

let envelopeState = {
  running: false,
  readings: 0,
  lastPressure: 0,
  lastResources: {},
  lastReadAt: 0,
  startedAt: 0,
  pressureSpikes: 0,
  fatigueLevel: 0,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS resource_envelope_events (
      id TEXT PRIMARY KEY,
      pressure REAL,
      fatigue REAL,
      resources TEXT,
      injections TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      trigger_reason TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_resource_envelope_ts ON resource_envelope_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function measureHeap() {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1048576);
  const budget = RESOURCE_BUDGETS.heapMB;
  const ratio = Math.min(1, heapMB / budget.ceiling);
  return { heapMB, heapTotalMB: Math.round(mem.heapTotal / 1048576), rssMB: Math.round(mem.rss / 1048576), ratio, budget };
}

function measureDbSize() {
  try {
    const dbPath = join(DATA_DIR, 'chandra.db');
    const stat = statSync(dbPath);
    const sizeMB = Math.round(stat.size / 1048576);
    const budget = RESOURCE_BUDGETS.dbSizeMB;
    const ratio = Math.min(1, sizeMB / budget.ceiling);
    return { sizeMB, ratio, budget };
  } catch (_) {
    return { sizeMB: 0, ratio: 0, budget: RESOURCE_BUDGETS.dbSizeMB };
  }
}

function measureConcurrentRuns() {
  try {
    const active = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE status = 'running'`).get()?.c || 0;
    const budget = RESOURCE_BUDGETS.concurrentRuns;
    const ratio = Math.min(1, active / budget.ceiling);
    return { active, ratio, budget };
  } catch (_) {
    return { active: 0, ratio: 0, budget: RESOURCE_BUDGETS.concurrentRuns };
  }
}

async function measureOllamaLatency() {
  const budget = RESOURCE_BUDGETS.ollamaLatencyMs;
  try {
    const t0 = performance.now();
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    const latencyMs = Math.round(performance.now() - t0);
    if (!r.ok) return { latencyMs: budget.ceiling, available: false, ratio: 1, budget };
    const ratio = Math.min(1, latencyMs / budget.ceiling);
    return { latencyMs, available: true, ratio, budget };
  } catch (_) {
    return { latencyMs: budget.ceiling, available: false, ratio: 1, budget };
  }
}

function measureBusBacklog() {
  try {
    const recent = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(now() - 60_000)?.c || 0;
    const budget = RESOURCE_BUDGETS.busBacklog;
    const ratio = Math.min(1, recent / budget.ceiling);
    return { messagesPerMinute: recent, ratio, budget };
  } catch (_) {
    return { messagesPerMinute: 0, ratio: 0, budget: RESOURCE_BUDGETS.busBacklog };
  }
}

function computeResourcePressure(resources) {
  const pressure =
    (resources.heap?.ratio || 0) * PRESSURE_WEIGHTS.heap +
    (resources.dbSize?.ratio || 0) * PRESSURE_WEIGHTS.dbSize +
    (resources.concurrentRuns?.ratio || 0) * PRESSURE_WEIGHTS.concurrentRuns +
    (resources.ollamaLatency?.ratio || 0) * PRESSURE_WEIGHTS.ollamaLatency +
    (resources.busBacklog?.ratio || 0) * PRESSURE_WEIGHTS.busBacklog;

  return Math.max(0, Math.min(1, pressure));
}

function classifyPressure(pressure) {
  if (pressure >= 0.8) return 'CRITICAL';
  if (pressure >= 0.6) return 'HIGH';
  if (pressure >= 0.35) return 'MODERATE';
  return 'LOW';
}

function injectResourceSignals(pressure, fatigue) {
  if (!ctrnnRef || !ctrnnRef.running) return null;

  let gateMods = { evolutionRate: 1.0, tier: 'UNKNOWN' };
  try { gateMods = getAutonomyModifiers(); } catch (_) {}

  const sensitivity = Math.max(0.2, Math.min(1.2,
    BASE_RESOURCE_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3
  ));

  const injections = [];

  // Energy level — inverse of pressure (excitatory when resources are free)
  const energyAmp = (1 - pressure) * 2.0 * sensitivity;
  if (energyAmp > 0.05) {
    ctrnnRef.inject(1, 4, 2.0, energyAmp);
    injections.push({ region: 'energy_level', x: 1, y: 4, amp: +energyAmp.toFixed(3) });
  }

  // Fatigue signal — sustained pressure (inhibitory, negative amplitude)
  const fatigueAmp = -fatigue * 1.8 * sensitivity;
  if (Math.abs(fatigueAmp) > 0.05) {
    ctrnnRef.inject(1, 12, 2.0, fatigueAmp);
    injections.push({ region: 'fatigue', x: 1, y: 12, amp: +fatigueAmp.toFixed(3) });
  }

  return { injections, sensitivity, tier: gateMods.tier };
}

async function envelopeCycle() {
  const resources = {
    heap: measureHeap(),
    dbSize: measureDbSize(),
    concurrentRuns: measureConcurrentRuns(),
    ollamaLatency: await measureOllamaLatency(),
    busBacklog: measureBusBacklog(),
  };

  const pressure = computeResourcePressure(resources);
  const level = classifyPressure(pressure);

  // Fatigue: accumulates when pressure is high, decays when low
  fatigueAccumulator = fatigueAccumulator * FATIGUE_DECAY + pressure * (1 - FATIGUE_DECAY);
  const fatigue = Math.max(0, Math.min(1, fatigueAccumulator));

  const ctrnnResult = injectResourceSignals(pressure, fatigue);

  envelopeState.readings++;
  envelopeState.lastPressure = +pressure.toFixed(3);
  envelopeState.lastResources = {
    heapMB: resources.heap.heapMB,
    dbSizeMB: resources.dbSize.sizeMB,
    concurrentRuns: resources.concurrentRuns.active,
    ollamaLatencyMs: resources.ollamaLatency.latencyMs,
    ollamaAvailable: resources.ollamaLatency.available,
    busMessagesPerMin: resources.busBacklog.messagesPerMinute,
  };
  envelopeState.lastReadAt = now();
  envelopeState.fatigueLevel = +fatigue.toFixed(3);

  // Pressure spike detection
  if (level === 'CRITICAL' || level === 'HIGH') {
    envelopeState.pressureSpikes++;

    publish('resource-envelope', 'system.resource.pressure', JSON.stringify({
      pressure: +pressure.toFixed(3),
      fatigue: +fatigue.toFixed(3),
      level,
      resources: envelopeState.lastResources,
      tier: ctrnnResult?.tier || 'UNKNOWN',
    }));
  }

  // Snapshot to DB periodically
  if (envelopeState.readings % SNAPSHOT_EVERY === 0) {
    try {
      db.prepare(
        `INSERT INTO resource_envelope_events (id, pressure, fatigue, resources, injections, gate_tier, sensitivity, trigger_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID().slice(0, 12),
        pressure,
        fatigue,
        JSON.stringify(envelopeState.lastResources),
        JSON.stringify(ctrnnResult?.injections || []),
        ctrnnResult?.tier || 'UNKNOWN',
        ctrnnResult?.sensitivity || BASE_RESOURCE_SENSITIVITY,
        level === 'CRITICAL' ? 'critical_pressure' : 'periodic',
        now()
      );
    } catch (_) {}

    // Prune >7 days
    try {
      db.prepare(`DELETE FROM resource_envelope_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
    } catch (_) {}
  }

  return { pressure: +pressure.toFixed(3), fatigue: +fatigue.toFixed(3), level, resources: envelopeState.lastResources, ctrnn: ctrnnResult };
}

export function setEnvelopeCTRNN(ctrnn) {
  ctrnnRef = ctrnn;
}

export function startResourceEnvelope() {
  stopResourceEnvelope();
  envelopeState = {
    running: true,
    readings: 0,
    lastPressure: 0,
    lastResources: {},
    lastReadAt: 0,
    startedAt: now(),
    pressureSpikes: 0,
    fatigueLevel: 0,
  };
  fatigueAccumulator = 0;

  envelopeTimer = setInterval(async () => {
    try {
      await envelopeCycle();
    } catch (e) {
      console.error(`Resource envelope error: ${e.message}`);
    }
  }, ENVELOPE_INTERVAL_MS);

  envelopeCycle();

  return { started: true, intervalMs: ENVELOPE_INTERVAL_MS, budgets: RESOURCE_BUDGETS };
}

export function stopResourceEnvelope() {
  if (envelopeTimer) {
    clearInterval(envelopeTimer);
    envelopeTimer = null;
  }
  envelopeState.running = false;
  fatigueAccumulator = 0;
  return { stopped: true, totalReadings: envelopeState.readings, spikes: envelopeState.pressureSpikes };
}

export function getResourceEnvelopeStatus() {
  let gateMods = { tier: 'UNKNOWN', evolutionRate: 1.0 };
  try { gateMods = getAutonomyModifiers(); } catch (_) {}

  return {
    ...envelopeState,
    intervalMs: ENVELOPE_INTERVAL_MS,
    budgets: RESOURCE_BUDGETS,
    pressureLevel: classifyPressure(envelopeState.lastPressure),
    gateTier: gateMods.tier,
    sensitivity: Math.max(0.2, Math.min(1.2,
      BASE_RESOURCE_SENSITIVITY + (gateMods.evolutionRate - 1.0) * 0.3
    )),
  };
}

export function getResourcePressure() {
  return {
    pressure: envelopeState.lastPressure,
    fatigue: envelopeState.fatigueLevel,
    level: classifyPressure(envelopeState.lastPressure),
    resources: envelopeState.lastResources,
  };
}

export function isResourceConstrained() {
  if (envelopeState.lastPressure >= 0.6) return true;
  // Per-resource critical check: a single resource at its critical threshold
  // should suppress expensive actions even if aggregate pressure is low
  const r = envelopeState.lastResources;
  if (!r || typeof r !== 'object') return false;
  if (r.heapMB >= RESOURCE_BUDGETS.heapMB.critical) return true;
  if (r.dbSizeMB >= RESOURCE_BUDGETS.dbSizeMB.critical) return true;
  if (r.concurrentRuns >= RESOURCE_BUDGETS.concurrentRuns.critical) return true;
  if (r.ollamaLatencyMs >= RESOURCE_BUDGETS.ollamaLatencyMs.critical) return true;
  if (r.busMessagesPerMin >= RESOURCE_BUDGETS.busBacklog.critical) return true;
  return false;
}

export function getResourceEnvelopeHistory({ limit = 50 } = {}) {
  return db.prepare(
    `SELECT * FROM resource_envelope_events ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(200, Math.max(1, limit)));
}

export function resetResourceEnvelope() {
  fatigueAccumulator = 0;
  envelopeState.pressureSpikes = 0;
  ctrnnRef = null;
}

export function triggerEnvelopeCycle() {
  return envelopeCycle();
}

export function installResourceEnvelopeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/resource-envelope', route((_req, res) => {
    res.json(getResourceEnvelopeStatus());
  }));

  app.get('/api/intelligence/resource-envelope/pressure', route((_req, res) => {
    res.json(getResourcePressure());
  }));

  app.get('/api/intelligence/resource-envelope/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: getResourceEnvelopeHistory({ limit }) });
  }));

  app.get('/api/intelligence/resource-envelope/budgets', route((_req, res) => {
    res.json({ budgets: RESOURCE_BUDGETS, weights: PRESSURE_WEIGHTS });
  }));

  app.post('/api/intelligence/resource-envelope/start', route((_req, res) => {
    res.json(startResourceEnvelope());
  }));

  app.post('/api/intelligence/resource-envelope/stop', route((_req, res) => {
    res.json(stopResourceEnvelope());
  }));

  app.post('/api/intelligence/resource-envelope/trigger', route(async (_req, res) => {
    const result = await triggerEnvelopeCycle();
    res.json(result);
  }));
}
