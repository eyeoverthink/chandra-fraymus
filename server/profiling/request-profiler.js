import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('request-profiler');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS request_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rp_created ON request_profiles(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_rp_path ON request_profiles(path)');
} catch (e) { log.error('request-profiler migration failed', { err: e.message }); }

const SLOW_THRESHOLD_MS = 1000;
const PRUNE_OLDER_THAN_MS = 48 * 3600_000;

const endpointStats = new Map();

function normalizePath(path) {
  return path
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .split('?')[0];
}

function updateStats(key, duration) {
  if (!endpointStats.has(key)) {
    endpointStats.set(key, { count: 0, totalMs: 0, maxMs: 0, minMs: Infinity, durations: [] });
  }
  const s = endpointStats.get(key);
  s.count++;
  s.totalMs += duration;
  if (duration > s.maxMs) s.maxMs = duration;
  if (duration < s.minMs) s.minMs = duration;
  s.durations.push(duration);
  if (s.durations.length > 1000) s.durations.shift();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * p / 100) - 1);
  return sorted[idx];
}

export function requestProfiler() {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    const origEnd = res.end;
    res.end = function (...args) {
      const ns = Number(process.hrtime.bigint() - start);
      const ms = ns / 1_000_000;
      const normalized = normalizePath(req.path);
      const key = `${req.method} ${normalized}`;

      updateStats(key, ms);

      try {
        db.prepare('INSERT INTO request_profiles (method, path, status, duration_ms, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(req.method, normalized, res.statusCode, Math.round(ms * 100) / 100, Date.now());
      } catch (_) {}

      if (ms >= SLOW_THRESHOLD_MS) {
        log.warn('slow request', { method: req.method, path: req.path, status: res.statusCode, duration: Math.round(ms) });
      }

      return origEnd.apply(this, args);
    };
    next();
  };
}

export function getEndpointProfile(path, method) {
  const hour = Date.now() - 3600_000;
  const rows = db.prepare(
    'SELECT duration_ms FROM request_profiles WHERE path = ? AND method = ? AND created_at > ? ORDER BY duration_ms ASC'
  ).all(path, method || 'GET', hour);

  const durations = rows.map(r => r.duration_ms);
  return {
    endpoint: `${method || 'GET'} ${path}`,
    count: durations.length,
    avg: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    p50: percentile(durations, 50),
    p95: percentile(durations, 95),
    p99: percentile(durations, 99),
    max: durations.length > 0 ? durations[durations.length - 1] : 0,
    min: durations.length > 0 ? durations[0] : 0,
  };
}

export function getSlowestEndpoints(limit = 15) {
  const hour = Date.now() - 3600_000;
  const rows = db.prepare(`
    SELECT method, path, COUNT(*) as cnt, ROUND(AVG(duration_ms), 1) as avg_ms,
      MAX(duration_ms) as max_ms, MIN(duration_ms) as min_ms
    FROM request_profiles WHERE created_at > ?
    GROUP BY method, path ORDER BY avg_ms DESC LIMIT ?
  `).all(hour, limit);
  return rows;
}

export function getSlowRequests(limit = 20) {
  const rows = db.prepare(
    'SELECT method, path, status, duration_ms, created_at FROM request_profiles WHERE duration_ms >= ? ORDER BY created_at DESC LIMIT ?'
  ).all(SLOW_THRESHOLD_MS, limit);
  return rows;
}

export function getRequestVolume() {
  const now = Date.now();
  const intervals = [
    { label: '1m', since: now - 60_000 },
    { label: '5m', since: now - 300_000 },
    { label: '1h', since: now - 3600_000 },
    { label: '24h', since: now - 86400_000 },
  ];
  return intervals.map(({ label, since }) => ({
    interval: label,
    count: db.prepare('SELECT COUNT(*) as c FROM request_profiles WHERE created_at > ?').get(since)?.c || 0,
    avgMs: Math.round(db.prepare('SELECT AVG(duration_ms) as a FROM request_profiles WHERE created_at > ?').get(since)?.a || 0),
    errorCount: db.prepare('SELECT COUNT(*) as c FROM request_profiles WHERE created_at > ? AND status >= 400').get(since)?.c || 0,
  }));
}

export function pruneOldProfiles() {
  const cutoff = Date.now() - PRUNE_OLDER_THAN_MS;
  const result = db.prepare('DELETE FROM request_profiles WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) log.info('pruned old request profiles', { deleted: result.changes });
  return { pruned: result.changes };
}

export function installRequestProfilerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/profiling/endpoints', route((_req, res) => {
    res.json({ endpoints: getSlowestEndpoints() });
  }));

  app.get('/api/profiling/slow', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ slowRequests: getSlowRequests(limit) });
  }));

  app.get('/api/profiling/volume', route((_req, res) => {
    res.json({ volume: getRequestVolume() });
  }));

  app.get('/api/profiling/endpoint', route((req, res) => {
    const { path, method } = req.query;
    if (!path) return res.status(400).json({ error: 'path required' });
    res.json(getEndpointProfile(path, method));
  }));

  app.post('/api/profiling/prune', route((_req, res) => {
    res.json(pruneOldProfiles());
  }));
}
