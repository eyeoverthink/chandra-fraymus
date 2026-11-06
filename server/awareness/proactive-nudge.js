/**
 * Awareness Layer — Proactive Nudge Engine
 *
 * Anticipatory intervention system inspired by Brahma's AnticipatoryWatcher.
 * Monitors system state and proactively nudges the user when attention is needed.
 *
 * Categories: health, intelligence, fleet, user_context, suggestions
 * 15-minute cooldown per category (prevents notification fatigue).
 * DND (Do Not Disturb) mode suppresses all nudges.
 * Delivery: WebSocket broadcast with type 'nudge'.
 *
 * Runs on 30-second interval (nudges are expensive and slow-changing).
 */

import { db } from '../db.js';
import { getAutonomyModifiers } from '../intelligence/consciousness-gate.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const NUDGE_INTERVAL_MS = 30_000;
const COOLDOWN_MS = 15 * 60_000;
const SNAPSHOT_EVERY = 20;

const CATEGORIES = ['health', 'intelligence', 'fleet', 'user_context', 'suggestions'];

let nudgeTimer = null;
let broadcastFn = null;
let nudgeState = {
  running: false,
  nudgesSent: 0,
  lastNudge: null,
  dnd: false,
  startedAt: 0,
};
let cooldowns = {};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS nudge_events (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      priority TEXT DEFAULT 'info',
      suppressed INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_nudge_ts ON nudge_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

export function setNudgeBroadcast(fn) {
  broadcastFn = fn;
}

function isCoolingDown(category) {
  const last = cooldowns[category];
  if (!last) return false;
  return (now() - last) < COOLDOWN_MS;
}

function sendNudge(category, title, body, priority = 'info') {
  if (nudgeState.dnd) return false;
  if (isCoolingDown(category)) return false;

  cooldowns[category] = now();
  nudgeState.nudgesSent++;
  nudgeState.lastNudge = { category, title, body, priority, at: now() };

  const nudge = { type: 'nudge', category, title, body, priority, ts: now() };

  if (broadcastFn) {
    try { broadcastFn('nudge', nudge); } catch (_) {}
  }

  try {
    publish('system.nudge', JSON.stringify(nudge));
  } catch (_) {}

  // Persist
  try {
    db.prepare(
      `INSERT INTO nudge_events (id, category, title, body, priority, suppressed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`
    ).run(randomUUID().slice(0, 12), category, title, body, priority, now());
  } catch (_) {}

  return true;
}

function collectHealthSignals() {
  const nudges = [];

  try {
    const alerts = db.prepare(
      `SELECT COUNT(*) as cnt FROM health_alerts WHERE resolved_at IS NULL AND severity = 'critical'`
    ).get();
    if (alerts?.cnt > 0) {
      nudges.push({ title: `${alerts.cnt} critical alert${alerts.cnt > 1 ? 's' : ''} unresolved`, priority: 'warning' });
    }
  } catch (_) {}

  try {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / (1024 * 1024));
    if (heapMB > 400) {
      nudges.push({ title: `High memory usage: ${heapMB}MB heap`, priority: 'warning' });
    }
  } catch (_) {}

  return nudges;
}

function collectIntelligenceSignals() {
  const nudges = [];

  try {
    const mods = getAutonomyModifiers();
    if (mods.tier === 'DORMANT') {
      nudges.push({ title: 'Consciousness tier: DORMANT — system is in minimal awareness mode', priority: 'info' });
    } else if (mods.tier === 'INTEGRATED') {
      nudges.push({ title: 'Full consciousness integration achieved (4/4 proofs)', priority: 'info' });
    }
  } catch (_) {}

  try {
    const stale = db.prepare(
      `SELECT COUNT(*) as cnt FROM daemon_cycles WHERE created_at > ?`
    ).get(now() - 3600_000);
    if (stale?.cnt === 0) {
      nudges.push({ title: 'No daemon cycles in the last hour — daemon may be stopped', priority: 'warning' });
    }
  } catch (_) {}

  return nudges;
}

function collectFleetSignals() {
  const nudges = [];

  try {
    const fiveMin = now() - 300_000;
    const failed = db.prepare(
      `SELECT COUNT(*) as cnt FROM runs WHERE status = 'error' AND created_at > ?`
    ).get(fiveMin);
    if (failed?.cnt >= 3) {
      nudges.push({ title: `${failed.cnt} agent failures in last 5 minutes`, priority: 'warning' });
    }
  } catch (_) {}

  return nudges;
}

function nudgeCycle() {
  if (nudgeState.dnd) return;

  try {
    const healthNudges = collectHealthSignals();
    for (const n of healthNudges) {
      sendNudge('health', n.title, n.body || '', n.priority);
    }

    const intNudges = collectIntelligenceSignals();
    for (const n of intNudges) {
      sendNudge('intelligence', n.title, n.body || '', n.priority);
    }

    const fleetNudges = collectFleetSignals();
    for (const n of fleetNudges) {
      sendNudge('fleet', n.title, n.body || '', n.priority);
    }

    // Snapshot
    if (nudgeState.nudgesSent % SNAPSHOT_EVERY === 0 && nudgeState.nudgesSent > 0) {
      try {
        db.prepare(`DELETE FROM nudge_events WHERE created_at < ?`).run(now() - 7 * 86400_000);
      } catch (_) {}
    }
  } catch (e) {
    console.error('nudge cycle error:', e.message);
  }
}

export function startNudgeEngine() {
  if (nudgeTimer) return { started: false, reason: 'already_running' };
  nudgeState = { running: true, nudgesSent: 0, lastNudge: null, dnd: false, startedAt: now() };
  cooldowns = {};
  nudgeTimer = setInterval(nudgeCycle, NUDGE_INTERVAL_MS);
  return { started: true };
}

export function stopNudgeEngine() {
  if (nudgeTimer) {
    clearInterval(nudgeTimer);
    nudgeTimer = null;
  }
  nudgeState.running = false;
  return { stopped: true };
}

export function setDnd(enabled) {
  nudgeState.dnd = !!enabled;
  return { dnd: nudgeState.dnd };
}

export function getNudgeStatus() {
  return {
    ...nudgeState,
    cooldowns: Object.fromEntries(
      Object.entries(cooldowns).map(([k, v]) => [k, { lastFired: v, coolingDown: isCoolingDown(k), remainingMs: Math.max(0, COOLDOWN_MS - (now() - v)) }])
    ),
    categories: CATEGORIES,
  };
}

export function installNudgeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/awareness/nudge', route((_req, res) => {
    res.json(getNudgeStatus());
  }));

  app.get('/api/awareness/nudge/history', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const cat = req.query.category;
    let rows;
    if (cat && CATEGORIES.includes(cat)) {
      rows = db.prepare(`SELECT * FROM nudge_events WHERE category = ? ORDER BY created_at DESC LIMIT ?`).all(cat, limit);
    } else {
      rows = db.prepare(`SELECT * FROM nudge_events ORDER BY created_at DESC LIMIT ?`).all(limit);
    }
    res.json({ events: rows });
  }));

  app.post('/api/awareness/nudge/start', route((_req, res) => {
    res.json(startNudgeEngine());
  }));

  app.post('/api/awareness/nudge/stop', route((_req, res) => {
    res.json(stopNudgeEngine());
  }));

  app.post('/api/awareness/nudge/dnd', route((req, res) => {
    const enabled = req.body?.enabled !== false;
    res.json(setDnd(enabled));
  }));

  app.post('/api/awareness/nudge/send', route((req, res) => {
    const { category, title, body, priority } = req.body || {};
    if (!category || !title) return res.status(400).json({ error: 'category and title required' });
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: `invalid category, must be one of: ${CATEGORIES.join(', ')}` });
    const sent = sendNudge(category, title, body || '', priority || 'info');
    res.json({ sent, reason: sent ? 'delivered' : (nudgeState.dnd ? 'dnd_active' : 'cooldown') });
  }));
}
