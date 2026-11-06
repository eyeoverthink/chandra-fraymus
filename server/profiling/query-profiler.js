import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('query-profiler');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS slow_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sql_text TEXT NOT NULL,
    duration_ms REAL NOT NULL,
    caller TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sq_created ON slow_queries(created_at)');
} catch (e) { log.error('query-profiler migration failed', { err: e.message }); }

const SLOW_QUERY_MS = 50;
const PRUNE_OLDER_THAN_MS = 48 * 3600_000;

const queryStats = new Map();

function trackQuery(sql, durationMs, caller) {
  const key = sql.substring(0, 120).replace(/\s+/g, ' ').trim();
  if (!queryStats.has(key)) {
    queryStats.set(key, { count: 0, totalMs: 0, maxMs: 0, minMs: Infinity });
  }
  const s = queryStats.get(key);
  s.count++;
  s.totalMs += durationMs;
  if (durationMs > s.maxMs) s.maxMs = durationMs;
  if (durationMs < s.minMs) s.minMs = durationMs;

  if (durationMs >= SLOW_QUERY_MS) {
    try {
      db.prepare('INSERT INTO slow_queries (sql_text, duration_ms, caller, created_at) VALUES (?, ?, ?, ?)')
        .run(sql.substring(0, 500), Math.round(durationMs * 100) / 100, caller || null, Date.now());
    } catch (_) {}
    log.warn('slow query', { sql: key, duration: Math.round(durationMs), caller });
  }
}

export function wrapStatement(stmt, caller) {
  const origRun = stmt.run.bind(stmt);
  const origGet = stmt.get.bind(stmt);
  const origAll = stmt.all.bind(stmt);

  stmt.run = function (...args) {
    const start = process.hrtime.bigint();
    const result = origRun(...args);
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    trackQuery(stmt.source, ms, caller);
    return result;
  };

  stmt.get = function (...args) {
    const start = process.hrtime.bigint();
    const result = origGet(...args);
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    trackQuery(stmt.source, ms, caller);
    return result;
  };

  stmt.all = function (...args) {
    const start = process.hrtime.bigint();
    const result = origAll(...args);
    const ms = Number(process.hrtime.bigint() - start) / 1_000_000;
    trackQuery(stmt.source, ms, caller);
    return result;
  };

  return stmt;
}

export function getQueryStats(limit = 20) {
  const entries = [...queryStats.entries()]
    .map(([sql, s]) => ({
      sql,
      count: s.count,
      avgMs: Math.round((s.totalMs / s.count) * 10) / 10,
      maxMs: Math.round(s.maxMs * 10) / 10,
      minMs: s.minMs === Infinity ? 0 : Math.round(s.minMs * 10) / 10,
      totalMs: Math.round(s.totalMs),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
  return entries;
}

export function getSlowQueries(limit = 20) {
  return db.prepare(
    'SELECT sql_text, duration_ms, caller, created_at FROM slow_queries ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

export function getSlowestQueries(limit = 10) {
  const hour = Date.now() - 3600_000;
  return db.prepare(
    'SELECT sql_text, duration_ms, caller, created_at FROM slow_queries WHERE created_at > ? ORDER BY duration_ms DESC LIMIT ?'
  ).all(hour, limit);
}

export function getQueryProfile() {
  const hour = Date.now() - 3600_000;
  const total = db.prepare('SELECT COUNT(*) as c FROM slow_queries WHERE created_at > ?').get(hour)?.c || 0;
  const avgMs = Math.round(
    db.prepare('SELECT AVG(duration_ms) as a FROM slow_queries WHERE created_at > ?').get(hour)?.a || 0
  );
  const maxMs = Math.round(
    db.prepare('SELECT MAX(duration_ms) as m FROM slow_queries WHERE created_at > ?').get(hour)?.m || 0
  );
  const topCallers = db.prepare(`
    SELECT caller, COUNT(*) as cnt, ROUND(AVG(duration_ms), 1) as avg_ms
    FROM slow_queries WHERE created_at > ? AND caller IS NOT NULL
    GROUP BY caller ORDER BY cnt DESC LIMIT 10
  `).all(hour);

  return { slowCount: total, avgMs, maxMs, topCallers, threshold: SLOW_QUERY_MS };
}

export function pruneOldQueries() {
  const cutoff = Date.now() - PRUNE_OLDER_THAN_MS;
  const result = db.prepare('DELETE FROM slow_queries WHERE created_at < ?').run(cutoff);
  if (result.changes > 0) log.info('pruned old slow queries', { deleted: result.changes });
  return { pruned: result.changes };
}

export function installQueryProfilerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/profiling/queries', route((_req, res) => {
    res.json({ stats: getQueryStats(), profile: getQueryProfile() });
  }));

  app.get('/api/profiling/queries/slow', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ slowQueries: getSlowQueries(limit) });
  }));

  app.get('/api/profiling/queries/slowest', route((_req, res) => {
    res.json({ slowest: getSlowestQueries() });
  }));

  app.post('/api/profiling/queries/prune', route((_req, res) => {
    res.json(pruneOldQueries());
  }));
}
