import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('wal-tuner');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS wal_operations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_walops_created ON wal_operations(created_at)');
} catch (e) { log.error('wal-tuner migration failed', { err: e.message }); }

let checkpointTimer = null;
let vacuumTimer = null;
let analyzeTimer = null;

function recordOp(operation, durationMs, detail) {
  try {
    db.prepare('INSERT INTO wal_operations (operation, duration_ms, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(operation, durationMs, detail || null, Date.now());
  } catch (_) {}
}

export function getWalStatus() {
  const walMode = db.pragma('journal_mode')[0]?.journal_mode || 'unknown';
  const walCheckpoint = db.pragma('wal_checkpoint')[0] || {};
  const pageSize = db.pragma('page_size')[0]?.page_size || 4096;
  const pageCount = db.pragma('page_count')[0]?.page_count || 0;
  const freelistCount = db.pragma('freelist_count')[0]?.freelist_count || 0;
  const cacheSize = db.pragma('cache_size')[0]?.cache_size || 0;
  const mmapSize = db.pragma('mmap_size')[0]?.mmap_size || 0;

  return {
    journalMode: walMode,
    walCheckpoint,
    pageSize,
    pageCount,
    dbSizeBytes: pageSize * pageCount,
    dbSizeMB: Math.round((pageSize * pageCount) / 1048576 * 100) / 100,
    freelistPages: freelistCount,
    wastedBytes: freelistCount * pageSize,
    cacheSize: Math.abs(cacheSize),
    cacheSizeKB: Math.abs(cacheSize) > 0 ? (cacheSize < 0 ? Math.abs(cacheSize) : cacheSize * pageSize / 1024) : 0,
    mmapSize,
  };
}

export function runCheckpoint() {
  const start = Date.now();
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    const ms = Date.now() - start;
    const detail = JSON.stringify(result[0] || {});
    recordOp('checkpoint', ms, detail);
    log.info('WAL checkpoint complete', { durationMs: ms });
    return { success: true, durationMs: ms, result: result[0] };
  } catch (e) {
    const ms = Date.now() - start;
    recordOp('checkpoint_failed', ms, e.message);
    return { success: false, error: e.message, durationMs: ms };
  }
}

export function runVacuum() {
  const start = Date.now();
  try {
    const beforeStatus = getWalStatus();
    db.exec('VACUUM');
    const ms = Date.now() - start;
    const afterStatus = getWalStatus();
    const savedBytes = beforeStatus.dbSizeBytes - afterStatus.dbSizeBytes;
    recordOp('vacuum', ms, `saved ${savedBytes} bytes`);
    log.info('VACUUM complete', { durationMs: ms, savedBytes });
    return { success: true, durationMs: ms, savedBytes, beforeMB: beforeStatus.dbSizeMB, afterMB: afterStatus.dbSizeMB };
  } catch (e) {
    const ms = Date.now() - start;
    recordOp('vacuum_failed', ms, e.message);
    return { success: false, error: e.message, durationMs: ms };
  }
}

export function runAnalyze() {
  const start = Date.now();
  try {
    db.exec('ANALYZE');
    const ms = Date.now() - start;
    recordOp('analyze', ms, 'query planner stats updated');
    log.info('ANALYZE complete', { durationMs: ms });
    return { success: true, durationMs: ms };
  } catch (e) {
    const ms = Date.now() - start;
    recordOp('analyze_failed', ms, e.message);
    return { success: false, error: e.message, durationMs: ms };
  }
}

export function optimizePragmas() {
  const applied = [];
  try {
    const current = db.pragma('journal_mode')[0]?.journal_mode;
    if (current !== 'wal') {
      db.pragma('journal_mode = WAL');
      applied.push('journal_mode=WAL');
    }
  } catch (_) {}

  try { db.pragma('synchronous = NORMAL'); applied.push('synchronous=NORMAL'); } catch (_) {}
  try { db.pragma('cache_size = -8000'); applied.push('cache_size=8MB'); } catch (_) {}
  try { db.pragma('busy_timeout = 5000'); applied.push('busy_timeout=5000ms'); } catch (_) {}
  try { db.pragma('temp_store = MEMORY'); applied.push('temp_store=MEMORY'); } catch (_) {}

  if (applied.length > 0) {
    recordOp('pragma_optimize', 0, applied.join(', '));
    log.info('pragmas optimized', { applied });
  }
  return { applied };
}

export function startScheduledMaintenance(opts = {}) {
  const checkpointMs = opts.checkpointMs || 3600_000;
  const vacuumMs = opts.vacuumMs || 86400_000;
  const analyzeMs = opts.analyzeMs || 14400_000;

  if (!checkpointTimer) {
    checkpointTimer = setInterval(() => runCheckpoint(), checkpointMs);
    checkpointTimer.unref();
  }
  if (!vacuumTimer) {
    vacuumTimer = setInterval(() => runVacuum(), vacuumMs);
    vacuumTimer.unref();
  }
  if (!analyzeTimer) {
    analyzeTimer = setInterval(() => runAnalyze(), analyzeMs);
    analyzeTimer.unref();
  }

  log.info('scheduled maintenance started', {
    checkpoint: `${checkpointMs / 60000}min`,
    vacuum: `${vacuumMs / 3600000}h`,
    analyze: `${analyzeMs / 3600000}h`,
  });
}

export function stopScheduledMaintenance() {
  if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
  if (vacuumTimer) { clearInterval(vacuumTimer); vacuumTimer = null; }
  if (analyzeTimer) { clearInterval(analyzeTimer); analyzeTimer = null; }
}

export function getOperationHistory(limit = 30) {
  return db.prepare('SELECT * FROM wal_operations ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function installWalTunerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/db-optimize/wal', route((_req, res) => {
    res.json({ wal: getWalStatus(), maintenance: { checkpoint: !!checkpointTimer, vacuum: !!vacuumTimer, analyze: !!analyzeTimer } });
  }));

  app.get('/api/db-optimize/operations', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    res.json({ operations: getOperationHistory(limit) });
  }));

  app.post('/api/db-optimize/checkpoint', route((_req, res) => {
    res.json(runCheckpoint());
  }));

  app.post('/api/db-optimize/vacuum', route((_req, res) => {
    res.json(runVacuum());
  }));

  app.post('/api/db-optimize/analyze-stats', route((_req, res) => {
    res.json(runAnalyze());
  }));

  app.post('/api/db-optimize/optimize-pragmas', route((_req, res) => {
    res.json(optimizePragmas());
  }));

  app.post('/api/db-optimize/maintenance/start', route((_req, res) => {
    startScheduledMaintenance();
    res.json({ status: 'started' });
  }));

  app.post('/api/db-optimize/maintenance/stop', route((_req, res) => {
    stopScheduledMaintenance();
    res.json({ status: 'stopped' });
  }));
}
