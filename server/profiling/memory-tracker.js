import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('memory-tracker');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    heap_used_mb REAL NOT NULL,
    heap_total_mb REAL NOT NULL,
    rss_mb REAL NOT NULL,
    external_mb REAL NOT NULL,
    array_buffers_mb REAL NOT NULL,
    gc_pause_ms REAL,
    event_loop_lag_ms REAL,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ms_created ON memory_snapshots(created_at)');
} catch (e) { log.error('memory-tracker migration failed', { err: e.message }); }

const SNAPSHOT_INTERVAL_MS = 30_000;
const PRUNE_OLDER_THAN_MS = 48 * 3600_000;
const HIGH_HEAP_THRESHOLD_MB = 400;
const HIGH_RSS_THRESHOLD_MB = 600;

let snapshotTimer = null;
let lastGcTime = 0;
let gcPauseEstimate = 0;

function toMB(bytes) {
  return Math.round((bytes / 1_048_576) * 100) / 100;
}

function measureEventLoopLag() {
  return new Promise(resolve => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lag = Number(process.hrtime.bigint() - start) / 1_000_000;
      resolve(Math.round(lag * 100) / 100);
    });
  });
}

export async function takeSnapshot() {
  const mem = process.memoryUsage();
  const lagMs = await measureEventLoopLag();

  const heapUsedMb = toMB(mem.heapUsed);
  const heapTotalMb = toMB(mem.heapTotal);
  const rssMb = toMB(mem.rss);
  const externalMb = toMB(mem.external);
  const arrayBuffersMb = toMB(mem.arrayBuffers);

  const now = Date.now();

  if (heapUsedMb < toMB(mem.heapTotal * 0.5) && lastGcTime > 0) {
    gcPauseEstimate = now - lastGcTime;
  }
  lastGcTime = now;

  try {
    db.prepare(`INSERT INTO memory_snapshots
      (heap_used_mb, heap_total_mb, rss_mb, external_mb, array_buffers_mb, gc_pause_ms, event_loop_lag_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(heapUsedMb, heapTotalMb, rssMb, externalMb, arrayBuffersMb, gcPauseEstimate || null, lagMs, now);
  } catch (_) {}

  if (heapUsedMb >= HIGH_HEAP_THRESHOLD_MB) {
    log.warn('high heap usage', { heapUsedMb, heapTotalMb });
  }
  if (rssMb >= HIGH_RSS_THRESHOLD_MB) {
    log.warn('high RSS', { rssMb });
  }

  return { heapUsedMb, heapTotalMb, rssMb, externalMb, arrayBuffersMb, gcPauseEstimate, eventLoopLagMs: lagMs };
}

export function startMemoryTracking(intervalMs) {
  if (snapshotTimer) return;
  const interval = Math.max(10_000, intervalMs || SNAPSHOT_INTERVAL_MS);
  snapshotTimer = setInterval(() => takeSnapshot().catch(() => {}), interval);
  snapshotTimer.unref();
  log.info('memory tracking started', { intervalMs: interval });
}

export function stopMemoryTracking() {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
    log.info('memory tracking stopped');
  }
}

export function getCurrentMemory() {
  const mem = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  return {
    heapUsedMb: toMB(mem.heapUsed),
    heapTotalMb: toMB(mem.heapTotal),
    rssMb: toMB(mem.rss),
    externalMb: toMB(mem.external),
    arrayBuffersMb: toMB(mem.arrayBuffers),
    heapUtilization: Math.round((mem.heapUsed / mem.heapTotal) * 1000) / 10,
    cpuUserMs: Math.round(cpuUsage.user / 1000),
    cpuSystemMs: Math.round(cpuUsage.system / 1000),
    uptimeSeconds: Math.round(process.uptime()),
    tracking: !!snapshotTimer,
  };
}

export function getMemoryHistory(limit = 60) {
  return db.prepare(
    'SELECT heap_used_mb, heap_total_mb, rss_mb, external_mb, event_loop_lag_ms, gc_pause_ms, created_at FROM memory_snapshots ORDER BY created_at DESC LIMIT ?'
  ).all(limit).reverse();
}

export function getMemoryStats() {
  const hour = Date.now() - 3600_000;
  const stats = db.prepare(`
    SELECT
      ROUND(AVG(heap_used_mb), 1) as avg_heap,
      ROUND(MAX(heap_used_mb), 1) as max_heap,
      ROUND(MIN(heap_used_mb), 1) as min_heap,
      ROUND(AVG(rss_mb), 1) as avg_rss,
      ROUND(MAX(rss_mb), 1) as max_rss,
      ROUND(AVG(event_loop_lag_ms), 2) as avg_loop_lag,
      ROUND(MAX(event_loop_lag_ms), 2) as max_loop_lag,
      COUNT(*) as sample_count
    FROM memory_snapshots WHERE created_at > ?
  `).get(hour);

  const trend = db.prepare(`
    SELECT heap_used_mb, created_at FROM memory_snapshots
    WHERE created_at > ? ORDER BY created_at ASC
  `).all(hour);

  let heapTrend = 'stable';
  if (trend.length >= 4) {
    const first = trend.slice(0, Math.floor(trend.length / 3));
    const last = trend.slice(-Math.floor(trend.length / 3));
    const avgFirst = first.reduce((a, r) => a + r.heap_used_mb, 0) / first.length;
    const avgLast = last.reduce((a, r) => a + r.heap_used_mb, 0) / last.length;
    const diff = avgLast - avgFirst;
    if (diff > 20) heapTrend = 'growing';
    else if (diff < -20) heapTrend = 'shrinking';
  }

  return { ...stats, heapTrend };
}

export function pruneOldSnapshots() {
  const cutoff = Date.now() - PRUNE_OLDER_THAN_MS;
  const result = db.prepare('DELETE FROM memory_snapshots WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) log.info('pruned old memory snapshots', { deleted: result.changes });
  return { pruned: result.changes };
}

export function installMemoryTrackerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/profiling/memory', route((_req, res) => {
    res.json({ current: getCurrentMemory(), stats: getMemoryStats() });
  }));

  app.get('/api/profiling/memory/history', route((req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 60));
    res.json({ history: getMemoryHistory(limit) });
  }));

  app.post('/api/profiling/memory/start', route((_req, res) => {
    startMemoryTracking();
    res.json({ status: 'started' });
  }));

  app.post('/api/profiling/memory/stop', route((_req, res) => {
    stopMemoryTracking();
    res.json({ status: 'stopped' });
  }));

  app.post('/api/profiling/memory/snapshot', route(async (_req, res) => {
    const snapshot = await takeSnapshot();
    res.json(snapshot);
  }));

  app.post('/api/profiling/memory/prune', route((_req, res) => {
    res.json(pruneOldSnapshots());
  }));
}
