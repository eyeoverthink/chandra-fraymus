import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('retention');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS retention_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tables_cleaned INTEGER NOT NULL,
    rows_deleted INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_retention_created ON retention_runs(created_at)');
} catch (e) { log.error('retention migration failed', { err: e.message }); }

const DEFAULT_POLICIES = {
  request_profiles:       { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  slow_queries:           { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  memory_snapshots:       { column: 'created_at', maxAgeDays: 3,  format: 'epoch' },
  cache_stats:            { column: 'recorded_at', maxAgeDays: 3, format: 'epoch' },
  health_metrics:         { column: 'created_at', maxAgeDays: 2,  format: 'epoch' },
  health_alerts:          { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  ctrnn_snapshots:        { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  bus_messages:           { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  consciousness_audits:   { column: 'created_at', maxAgeDays: 14, format: 'text' },
  sensory_bridge_events:  { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  emotional_feedback_events: { column: 'created_at', maxAgeDays: 7, format: 'epoch' },
  motor_output_events:    { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  attention_gate_events:  { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  habituation_events:     { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  working_memory_events:  { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  metacognitive_events:   { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  adaptive_strategy_events: { column: 'created_at', maxAgeDays: 7, format: 'epoch' },
  self_model_snapshots:   { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  resource_envelope_events: { column: 'created_at', maxAgeDays: 7, format: 'epoch' },
  predictive_processing_events: { column: 'created_at', maxAgeDays: 7, format: 'epoch' },
  active_inference_events: { column: 'created_at', maxAgeDays: 7, format: 'epoch' },
  state_fossils:          { column: 'created_at', maxAgeDays: 30, format: 'epoch' },
  daemon_cycles:          { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  reflections:            { column: 'created_at', maxAgeDays: 30, format: 'epoch' },
  verification_loops:     { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  verification_steps:     { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  neurogenesis_events:    { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  opeg_proposals:         { column: 'created_at', maxAgeDays: 30, format: 'epoch' },
  consciousness_transitions: { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  wal_operations:         { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
  index_analysis:         { column: 'created_at', maxAgeDays: 30, format: 'epoch' },
  retention_runs:         { column: 'created_at', maxAgeDays: 30, format: 'epoch' },
  circuit_breaker_events: { column: 'created_at', maxAgeDays: 7,  format: 'epoch' },
  recovery_events:        { column: 'created_at', maxAgeDays: 14, format: 'epoch' },
};

let customOverrides = {};
let retentionTimer = null;

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function getRetentionPolicies() {
  const merged = { ...DEFAULT_POLICIES };
  for (const [table, override] of Object.entries(customOverrides)) {
    if (merged[table]) {
      merged[table] = { ...merged[table], ...override };
    }
  }
  return merged;
}

export function setRetentionOverride(table, maxAgeDays) {
  if (!DEFAULT_POLICIES[table]) return { error: `Unknown table: ${table}` };
  if (maxAgeDays < 1 || maxAgeDays > 365) return { error: 'maxAgeDays must be 1-365' };
  customOverrides[table] = { maxAgeDays };
  return { table, maxAgeDays };
}

export function removeRetentionOverride(table) {
  delete customOverrides[table];
  return { table, reset: true };
}

export function runRetention() {
  const start = Date.now();
  const policies = getRetentionPolicies();
  let totalDeleted = 0;
  let tablesCleaned = 0;
  const details = [];

  for (const [table, policy] of Object.entries(policies)) {
    if (!tableExists(table)) continue;

    const cutoffMs = Date.now() - (policy.maxAgeDays * 86400_000);
    let cutoffValue;

    if (policy.format === 'text') {
      cutoffValue = new Date(cutoffMs).toISOString();
    } else {
      cutoffValue = cutoffMs;
    }

    try {
      const result = db.prepare(
        `DELETE FROM "${table}" WHERE "${policy.column}" < ?`
      ).run(cutoffValue);

      if (result.changes > 0) {
        totalDeleted += result.changes;
        tablesCleaned++;
        details.push({ table, deleted: result.changes, maxAgeDays: policy.maxAgeDays });
        log.info('retention cleanup', { table, deleted: result.changes });
      }
    } catch (e) {
      details.push({ table, error: e.message });
    }
  }

  const ms = Date.now() - start;
  try {
    db.prepare('INSERT INTO retention_runs (tables_cleaned, rows_deleted, duration_ms, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tablesCleaned, totalDeleted, ms, JSON.stringify(details), Date.now());
  } catch (_) {}

  log.info('retention run complete', { tablesCleaned, totalDeleted, durationMs: ms });
  return { tablesCleaned, totalDeleted, durationMs: ms, details };
}

export function startScheduledRetention(intervalMs = 86400_000) {
  if (retentionTimer) return;
  retentionTimer = setInterval(() => runRetention(), intervalMs);
  retentionTimer.unref();
  log.info('scheduled retention started', { intervalH: intervalMs / 3600_000 });
}

export function stopScheduledRetention() {
  if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
}

export function getRetentionHistory(limit = 20) {
  return db.prepare('SELECT * FROM retention_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function getRetentionPreview() {
  const policies = getRetentionPolicies();
  const preview = [];

  for (const [table, policy] of Object.entries(policies)) {
    if (!tableExists(table)) continue;

    const cutoffMs = Date.now() - (policy.maxAgeDays * 86400_000);
    let cutoffValue;
    if (policy.format === 'text') {
      cutoffValue = new Date(cutoffMs).toISOString();
    } else {
      cutoffValue = cutoffMs;
    }

    try {
      const count = db.prepare(
        `SELECT COUNT(*) as c FROM "${table}" WHERE "${policy.column}" < ?`
      ).get(cutoffValue)?.c || 0;

      const total = db.prepare(`SELECT COUNT(*) as c FROM "${table}"`).get()?.c || 0;

      if (count > 0) {
        preview.push({ table, wouldDelete: count, total, maxAgeDays: policy.maxAgeDays });
      }
    } catch (_) {}
  }

  return preview;
}

export function installRetentionRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/db-optimize/retention', route((_req, res) => {
    res.json({
      policies: getRetentionPolicies(),
      overrides: customOverrides,
      scheduled: !!retentionTimer,
    });
  }));

  app.get('/api/db-optimize/retention/history', route((req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ history: getRetentionHistory(limit) });
  }));

  app.get('/api/db-optimize/retention/preview', route((_req, res) => {
    res.json({ preview: getRetentionPreview() });
  }));

  app.post('/api/db-optimize/retention/run', route((_req, res) => {
    res.json(runRetention());
  }));

  app.post('/api/db-optimize/retention/override', route((req, res) => {
    const { table, maxAgeDays } = req.body || {};
    if (!table || !maxAgeDays) return res.status(400).json({ error: 'table and maxAgeDays required' });
    res.json(setRetentionOverride(table, parseInt(maxAgeDays)));
  }));

  app.delete('/api/db-optimize/retention/override/:table', route((req, res) => {
    res.json(removeRetentionOverride(req.params.table));
  }));

  app.post('/api/db-optimize/retention/start', route((_req, res) => {
    startScheduledRetention();
    res.json({ status: 'started' });
  }));

  app.post('/api/db-optimize/retention/stop', route((_req, res) => {
    stopScheduledRetention();
    res.json({ status: 'stopped' });
  }));
}
