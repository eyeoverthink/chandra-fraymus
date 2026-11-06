import { db } from '../db.js';
import { getProcessStatus } from './process-monitor.js';

const TABLE = 'healing_events';
let healerInterval = null;
let healerConfig = {
  eventLoopLagThresholdMs: 500,
  heapGrowthThresholdPct: 25,
  maxHeapMb: 512,
  checkIntervalMs: 30000,
};

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    detail TEXT,
    success INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function recordHealing(triggerType, severity, actionTaken, detail, success = true) {
  try {
    db.prepare(`INSERT INTO ${TABLE} (trigger_type, severity, action_taken, detail, success)
      VALUES (?,?,?,?,?)`).run(triggerType, severity, actionTaken, detail || '', success ? 1 : 0);
  } catch (e) { console.error('[auto-healer] record error:', e.message); }
}

function tryForceGC() {
  if (typeof global.gc === 'function') {
    global.gc();
    return true;
  }
  return false;
}

function tryWalCheckpoint() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    return true;
  } catch (e) { return false; }
}

function pruneOldData(tableName, column, maxAgeDays) {
  try {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
    const info = db.prepare(`DELETE FROM ${tableName} WHERE ${column} < ?`).run(cutoff);
    return info.changes;
  } catch { return 0; }
}

function runHealingCheck() {
  const status = getProcessStatus();
  const { current } = status;
  const actions = [];

  // Check 1: Event loop lag
  if (current.eventLoopLagP99 > healerConfig.eventLoopLagThresholdMs) {
    const detail = `p99=${current.eventLoopLagP99}ms, threshold=${healerConfig.eventLoopLagThresholdMs}ms`;
    const gcResult = tryForceGC();
    const action = gcResult ? 'forced_gc' : 'logged_warning';
    actions.push({ trigger: 'event_loop_lag', severity: 'warning', action, detail });
    recordHealing('event_loop_lag', 'warning', action, detail);
    console.warn(`[auto-healer] Event loop lag high: ${detail}`);
  }

  // Check 2: Heap memory pressure
  if (current.heapUsedMb > healerConfig.maxHeapMb) {
    const detail = `heap=${current.heapUsedMb}MB, limit=${healerConfig.maxHeapMb}MB`;
    const gcResult = tryForceGC();
    const checkpointResult = tryWalCheckpoint();
    const action = gcResult ? 'forced_gc_and_checkpoint' : 'wal_checkpoint';
    actions.push({ trigger: 'heap_pressure', severity: 'critical', action, detail });
    recordHealing('heap_pressure', 'critical', action, detail + ` gc=${gcResult} checkpoint=${checkpointResult}`);
    console.warn(`[auto-healer] Heap pressure: ${detail}`);
  }

  // Check 3: Heap growth trend
  if (current.heapTrend === 'growing') {
    const detail = `trend=growing, heap=${current.heapUsedMb}MB`;
    const gcResult = tryForceGC();
    const action = gcResult ? 'forced_gc' : 'logged_growth_warning';
    actions.push({ trigger: 'heap_growth', severity: 'warning', action, detail });
    recordHealing('heap_growth', 'warning', action, detail);
  }

  // Check 4: Handle leak detection (> 500 active handles suggests leak)
  if (current.activeHandles > 500) {
    const detail = `active_handles=${current.activeHandles}`;
    actions.push({ trigger: 'handle_leak', severity: 'warning', action: 'logged_warning', detail });
    recordHealing('handle_leak', 'warning', 'logged_warning', detail);
    console.warn(`[auto-healer] Possible handle leak: ${detail}`);
  }

  // Check 5: Self-prune healing events older than 7 days
  const pruned = pruneOldData(TABLE, 'created_at', 7);
  if (pruned > 0) {
    actions.push({ trigger: 'self_maintenance', severity: 'info', action: 'pruned_old_events', detail: `removed=${pruned}` });
  }

  return actions;
}

export function startAutoHealer(config = {}) {
  if (healerInterval) return;
  ensureTable();
  Object.assign(healerConfig, config);
  healerInterval = setInterval(() => {
    try { runHealingCheck(); } catch (e) {
      console.error('[auto-healer] check error:', e.message);
    }
  }, healerConfig.checkIntervalMs);
  healerInterval.unref();
  console.log('[auto-healer] started');
}

export function stopAutoHealer() {
  if (healerInterval) { clearInterval(healerInterval); healerInterval = null; }
  console.log('[auto-healer] stopped');
}

export function getHealerStatus() {
  return {
    running: !!healerInterval,
    config: { ...healerConfig },
  };
}

export function getHealingHistory(limit = 50) {
  try {
    ensureTable();
    return db.prepare(`SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)));
  } catch (e) { return []; }
}

export function triggerManualHealing() {
  ensureTable();
  return runHealingCheck();
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installAutoHealerRoutes(app) {
  ensureTable();

  app.get('/api/supervisor/healer', route(async (req, res) => {
    res.json(getHealerStatus());
  }));

  app.get('/api/supervisor/healer/history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json(getHealingHistory(limit));
  }));

  app.post('/api/supervisor/healer/trigger', route(async (req, res) => {
    const actions = triggerManualHealing();
    res.json({ triggered: true, actions });
  }));

  app.post('/api/supervisor/healer/start', route(async (req, res) => {
    startAutoHealer();
    res.json({ started: true });
  }));

  app.post('/api/supervisor/healer/stop', route(async (req, res) => {
    stopAutoHealer();
    res.json({ stopped: true });
  }));
}
