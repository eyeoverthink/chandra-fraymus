/**
 * Awareness Layer — User Sensorium
 *
 * Maps user-facing interaction telemetry to CTRNN Row 15 via Gaussian injection,
 * giving the neural core a felt sense of what the USER is doing — the external
 * complement to the internal Sensory Bridge (Row 2).
 *
 * Signals sensed (all derived from server-side observables, no client agent):
 *   Interaction recency — time since last API call or WebSocket message
 *   Navigation context  — which view/panel the user has open
 *   Command frequency   — rate of commands sent (engagement proxy)
 *   Session duration    — how long the current client session has been active
 *
 * CTRNN injection regions (Row 15 — bottom edge, user-facing):
 *   User activity   (15, 2)  σ=2.0  — inverse of idle time
 *   User attention  (15, 6)  σ=2.0  — navigation focus signal
 *   User engagement (15, 10) σ=2.0  — command rate
 *   Session state   (15, 14) σ=2.0  — session duration / fatigue
 *
 * Runs on 5-second interval (matches Sensory Bridge cadence).
 * Consciousness-aware: gate modifiers scale sensitivity.
 */

import { db } from '../db.js';
import { getCTRNN } from '../intelligence/ctrnn-instance.js';
import { getAutonomyModifiers } from '../intelligence/consciousness-gate.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const SENSORIUM_INTERVAL_MS = 5_000;
const SNAPSHOT_EVERY = 60;
const BASE_SENSITIVITY = 0.5;

const USER_REGIONS = {
  activity:   { tx: 15, ty: 2,  sigma: 2.0, label: 'User activity' },
  attention:  { tx: 15, ty: 6,  sigma: 2.0, label: 'User attention' },
  engagement: { tx: 15, ty: 10, sigma: 2.0, label: 'User engagement' },
  session:    { tx: 15, ty: 14, sigma: 2.0, label: 'Session state' },
};

let sensoriumTimer = null;
let sensoriumState = {
  running: false,
  injections: 0,
  lastSignals: {},
  lastAmplitudes: {},
  lastInjectedAt: 0,
  startedAt: 0,
};

let lastApiCallAt = now();
let lastWsMessageAt = now();
let commandTimestamps = [];
let currentView = 'command-center';
let currentPanel = null;
let sessionStartedAt = now();
let wsConnectionCount = 0;

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS user_sensorium_events (
      id TEXT PRIMARY KEY,
      tick INTEGER,
      signals TEXT,
      amplitudes TEXT,
      gate_tier TEXT,
      sensitivity REAL,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_sensorium_ts ON user_sensorium_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

export function recordApiCall() {
  lastApiCallAt = now();
}

export function recordWsMessage(data) {
  lastWsMessageAt = now();
  if (data?.view) currentView = data.view;
  if (data?.panel !== undefined) currentPanel = data.panel;
}

export function recordCommand() {
  const t = now();
  commandTimestamps.push(t);
  // Keep only last 2 minutes of timestamps
  const twoMinAgo = t - 120_000;
  commandTimestamps = commandTimestamps.filter(ts => ts > twoMinAgo);
}

export function recordWsConnect() {
  wsConnectionCount++;
  if (wsConnectionCount === 1) sessionStartedAt = now();
}

export function recordWsDisconnect() {
  wsConnectionCount = Math.max(0, wsConnectionCount - 1);
}

function collectSignals() {
  const t = now();
  const signals = {};

  // Activity: inverse of idle time (1.0 = just interacted, 0.0 = idle 10+ min)
  const lastInteraction = Math.max(lastApiCallAt, lastWsMessageAt);
  const idleMs = t - lastInteraction;
  signals.activity = clamp01(1.0 - (idleMs / 600_000));

  // Attention: signal based on which view is open (intelligence views = high signal)
  const attentionMap = {
    'command-center': 0.5,
    'constellation': 0.7,
    'canvas': 0.6,
    'library': 0.4,
    'manifold': 0.8,
  };
  signals.attention = attentionMap[currentView] || 0.5;
  if (currentPanel) signals.attention = Math.min(1.0, signals.attention + 0.2);

  // Engagement: commands per minute over last 2 minutes
  const twoMinAgo = t - 120_000;
  const recentCommands = commandTimestamps.filter(ts => ts > twoMinAgo).length;
  signals.engagement = clamp01(recentCommands / 10);

  // Session state: duration-based fatigue curve (peaks at 30min, decays after 2h)
  const sessionMinutes = (t - sessionStartedAt) / 60_000;
  if (sessionMinutes < 30) {
    signals.session = clamp01(sessionMinutes / 30);
  } else if (sessionMinutes < 120) {
    signals.session = 1.0;
  } else {
    signals.session = clamp01(1.0 - ((sessionMinutes - 120) / 240));
  }

  return signals;
}

function injectSignals(signals) {
  const ctrnn = getCTRNN();
  if (!ctrnn || !ctrnn.inject) return { injected: false };

  const mods = getAutonomyModifiers();
  const sensitivity = Math.max(0.2, Math.min(1.2, BASE_SENSITIVITY + (mods.evolutionRate - 1.0) * 0.3));

  const amplitudes = {};
  const injections = [];

  for (const [key, region] of Object.entries(USER_REGIONS)) {
    const raw = signals[key] ?? 0;
    const amp = raw * sensitivity;
    amplitudes[key] = amp;
    if (amp > 0.01) {
      ctrnn.inject(region.tx, region.ty, region.sigma, amp);
      injections.push({ region: key, row: region.tx, col: region.ty, amp, sigma: region.sigma });
    }
  }

  return { injected: true, sensitivity, amplitudes, injections, tier: mods.tier };
}

function sensoriumCycle() {
  try {
    const signals = collectSignals();
    const result = injectSignals(signals);

    sensoriumState.injections++;
    sensoriumState.lastSignals = signals;
    sensoriumState.lastAmplitudes = result.amplitudes || {};
    sensoriumState.lastInjectedAt = now();

    // Snapshot every Nth cycle
    if (sensoriumState.injections % SNAPSHOT_EVERY === 0) {
      try {
        const id = randomUUID().slice(0, 12);
        const ctrnn = getCTRNN();
        db.prepare(
          `INSERT INTO user_sensorium_events (id, tick, signals, amplitudes, gate_tier, sensitivity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id, ctrnn?.tick ?? 0, JSON.stringify(signals), JSON.stringify(result.amplitudes || {}), result.tier || 'unknown', result.sensitivity || BASE_SENSITIVITY, now());

        // Prune >7 days
        db.prepare(`DELETE FROM user_sensorium_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
      } catch (_) {}
    }

    // Publish idle alert if idle > 5 minutes
    if (signals.activity < 0.5 && sensoriumState.injections % 12 === 0) {
      try {
        publish('system.user.idle', JSON.stringify({
          idleMinutes: Math.round((now() - Math.max(lastApiCallAt, lastWsMessageAt)) / 60_000),
          currentView,
          currentPanel,
        }));
      } catch (_) {}
    }
  } catch (e) {
    console.error('user sensorium cycle error:', e.message);
  }
}

export function startUserSensorium() {
  if (sensoriumTimer) return { started: false, reason: 'already_running' };
  sensoriumState = {
    running: true,
    injections: 0,
    lastSignals: {},
    lastAmplitudes: {},
    lastInjectedAt: 0,
    startedAt: now(),
  };
  sensoriumTimer = setInterval(sensoriumCycle, SENSORIUM_INTERVAL_MS);
  return { started: true };
}

export function stopUserSensorium() {
  if (sensoriumTimer) {
    clearInterval(sensoriumTimer);
    sensoriumTimer = null;
  }
  sensoriumState.running = false;
  return { stopped: true };
}

export function resetUserSensorium() {
  commandTimestamps = [];
  currentView = 'command-center';
  currentPanel = null;
  sessionStartedAt = now();
  lastApiCallAt = now();
  lastWsMessageAt = now();
}

export function getUserSensoriumStatus() {
  return {
    ...sensoriumState,
    currentView,
    currentPanel,
    wsConnections: wsConnectionCount,
    sessionMinutes: Math.round((now() - sessionStartedAt) / 60_000),
    idleSeconds: Math.round((now() - Math.max(lastApiCallAt, lastWsMessageAt)) / 1000),
    regions: USER_REGIONS,
  };
}

export function installUserSensoriumRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/awareness/user-sensorium', route((_req, res) => {
    res.json(getUserSensoriumStatus());
  }));

  app.get('/api/awareness/user-sensorium/history', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const rows = db.prepare(
      `SELECT * FROM user_sensorium_events ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
    res.json({ events: rows });
  }));

  app.post('/api/awareness/user-sensorium/start', route((_req, res) => {
    res.json(startUserSensorium());
  }));

  app.post('/api/awareness/user-sensorium/stop', route((_req, res) => {
    res.json(stopUserSensorium());
  }));
}
