import { db } from '../db.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const TABLE = 'process_monitor_snapshots';
let monitorInterval = null;
let eldHistogram = null;
let snapshots = [];
const MAX_SNAPSHOTS = 120; // 10 minutes at 5s interval

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_loop_lag_p50 REAL,
    event_loop_lag_p99 REAL,
    event_loop_lag_max REAL,
    heap_used_mb REAL,
    heap_total_mb REAL,
    rss_mb REAL,
    external_mb REAL,
    active_handles INTEGER,
    active_requests INTEGER,
    uptime_seconds REAL,
    heap_trend TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function nsToMs(ns) { return Number(ns) / 1e6; }

function collectSnapshot() {
  const mem = process.memoryUsage();
  const heapUsedMb = +(mem.heapUsed / 1048576).toFixed(2);
  const heapTotalMb = +(mem.heapTotal / 1048576).toFixed(2);
  const rssMb = +(mem.rss / 1048576).toFixed(2);
  const externalMb = +(mem.external / 1048576).toFixed(2);

  let lagP50 = 0, lagP99 = 0, lagMax = 0;
  if (eldHistogram) {
    lagP50 = +nsToMs(eldHistogram.percentile(50)).toFixed(3);
    lagP99 = +nsToMs(eldHistogram.percentile(99)).toFixed(3);
    lagMax = +nsToMs(eldHistogram.max).toFixed(3);
    eldHistogram.reset();
  }

  const activeHandles = (process._getActiveHandles?.() || []).length;
  const activeRequests = (process._getActiveRequests?.() || []).length;

  snapshots.push({ heapUsedMb, ts: Date.now() });
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();

  const heapTrend = computeHeapTrend();

  return {
    eventLoopLagP50: lagP50,
    eventLoopLagP99: lagP99,
    eventLoopLagMax: lagMax,
    heapUsedMb,
    heapTotalMb,
    rssMb,
    externalMb,
    activeHandles,
    activeRequests,
    uptimeSeconds: +process.uptime().toFixed(1),
    heapTrend,
  };
}

function computeHeapTrend() {
  if (snapshots.length < 6) return 'insufficient_data';
  const recent = snapshots.slice(-6);
  const first = recent[0].heapUsedMb;
  const last = recent[recent.length - 1].heapUsedMb;
  const delta = last - first;
  const pct = (delta / first) * 100;
  if (pct > 10) return 'growing';
  if (pct < -10) return 'shrinking';
  return 'stable';
}

function saveSnapshot(snapshot) {
  try {
    db.prepare(`INSERT INTO ${TABLE}
      (event_loop_lag_p50, event_loop_lag_p99, event_loop_lag_max,
       heap_used_mb, heap_total_mb, rss_mb, external_mb,
       active_handles, active_requests, uptime_seconds, heap_trend)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      snapshot.eventLoopLagP50, snapshot.eventLoopLagP99, snapshot.eventLoopLagMax,
      snapshot.heapUsedMb, snapshot.heapTotalMb, snapshot.rssMb, snapshot.externalMb,
      snapshot.activeHandles, snapshot.activeRequests, snapshot.uptimeSeconds,
      snapshot.heapTrend
    );
  } catch (e) { console.error('[process-monitor] save error:', e.message); }
}

let saveCounter = 0;

export function startProcessMonitor(intervalMs = 5000) {
  if (monitorInterval) return;
  ensureTable();
  try {
    eldHistogram = monitorEventLoopDelay({ resolution: 20 });
    eldHistogram.enable();
  } catch (e) {
    console.warn('[process-monitor] ELD not available:', e.message);
  }
  monitorInterval = setInterval(() => {
    const snap = collectSnapshot();
    saveCounter++;
    if (saveCounter % 12 === 0) saveSnapshot(snap); // persist every 60s
  }, intervalMs);
  monitorInterval.unref();
  console.log('[process-monitor] started');
}

export function stopProcessMonitor() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  if (eldHistogram) { eldHistogram.disable(); eldHistogram = null; }
  snapshots = [];
  console.log('[process-monitor] stopped');
}

export function getProcessStatus() {
  const snapshot = collectSnapshot();
  return {
    running: !!monitorInterval,
    current: snapshot,
    recentSnapshots: snapshots.slice(-30).map(s => ({ heapUsedMb: s.heapUsedMb, ts: s.ts })),
    nodeVersion: process.version,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
  };
}

export function getProcessHistory(limit = 50) {
  try {
    ensureTable();
    return db.prepare(`SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)));
  } catch (e) { return []; }
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installProcessMonitorRoutes(app) {
  ensureTable();

  app.get('/api/supervisor/process', route(async (req, res) => {
    res.json(getProcessStatus());
  }));

  app.get('/api/supervisor/process/history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json(getProcessHistory(limit));
  }));

  app.post('/api/supervisor/process/start', route(async (req, res) => {
    startProcessMonitor();
    res.json({ started: true });
  }));

  app.post('/api/supervisor/process/stop', route(async (req, res) => {
    stopProcessMonitor();
    res.json({ stopped: true });
  }));

  // prune old snapshots
  app.post('/api/supervisor/process/prune', route(async (req, res) => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare(`DELETE FROM ${TABLE} WHERE created_at < ?`).run(cutoff);
    res.json({ pruned: info.changes });
  }));
}
