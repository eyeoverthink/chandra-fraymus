import { db } from '../db.js';
import { setConfig, getConfig, bulkSet, getConfigStats, getConfigHistory } from './config-store.js';
import { getFlagStats, getAllFlags } from './feature-flags.js';

const CONFIG_SCHEMAS = {
  'gateway': {
    'rate_limit.default.maxRequests': { type: 'number', default: 120, min: 1, max: 10000, description: 'Default max requests per window' },
    'rate_limit.default.windowMs': { type: 'number', default: 60000, min: 1000, max: 600000, description: 'Default rate limit window (ms)' },
    'rate_limit.command.maxRequests': { type: 'number', default: 30, min: 1, max: 1000, description: 'Command endpoint max requests' },
    'rate_limit.fleet.maxRequests': { type: 'number', default: 20, min: 1, max: 1000, description: 'Fleet runs max requests' },
    'validator.maxBodySize': { type: 'number', default: 1048576, min: 1024, max: 52428800, description: 'Max request body size (bytes)' },
  },
  'caching': {
    'lru.maxSize': { type: 'number', default: 500, min: 10, max: 50000, description: 'LRU cache max entries' },
    'lru.defaultTtlMs': { type: 'number', default: 300000, min: 1000, max: 3600000, description: 'Default cache TTL (ms)' },
    'compression.threshold': { type: 'number', default: 1024, min: 0, max: 1048576, description: 'Gzip compression threshold (bytes)' },
    'etag.enabled': { type: 'boolean', default: true, description: 'ETag conditional response support' },
  },
  'resilience': {
    'backup.intervalMs': { type: 'number', default: 3600000, min: 60000, max: 86400000, description: 'Backup interval (ms)' },
    'backup.maxFiles': { type: 'number', default: 10, min: 1, max: 100, description: 'Max backup files to retain' },
    'circuit.failureThreshold': { type: 'number', default: 5, min: 1, max: 50, description: 'Circuit breaker failure threshold' },
    'circuit.resetTimeMs': { type: 'number', default: 30000, min: 5000, max: 300000, description: 'Circuit breaker reset time (ms)' },
    'recovery.checkIntervalMs': { type: 'number', default: 60000, min: 10000, max: 600000, description: 'Recovery check interval (ms)' },
  },
  'profiling': {
    'request.slowThresholdMs': { type: 'number', default: 1000, min: 50, max: 30000, description: 'Slow request threshold (ms)' },
    'query.slowThresholdMs': { type: 'number', default: 50, min: 5, max: 5000, description: 'Slow query threshold (ms)' },
    'memory.snapshotIntervalMs': { type: 'number', default: 30000, min: 5000, max: 300000, description: 'Memory snapshot interval (ms)' },
    'memory.heapWarningPct': { type: 'number', default: 80, min: 50, max: 99, description: 'Heap usage warning threshold (%)' },
  },
  'db_optimize': {
    'wal.checkpointIntervalMs': { type: 'number', default: 300000, min: 60000, max: 3600000, description: 'WAL checkpoint interval (ms)' },
    'retention.maxAgeDays': { type: 'number', default: 30, min: 1, max: 365, description: 'Data retention max age (days)' },
    'retention.checkIntervalMs': { type: 'number', default: 3600000, min: 600000, max: 86400000, description: 'Retention check interval (ms)' },
    'index.autoAnalyze': { type: 'boolean', default: true, description: 'Auto-analyze index usage' },
  },
  'supervisor': {
    'process.checkIntervalMs': { type: 'number', default: 10000, min: 5000, max: 120000, description: 'Process monitor check interval (ms)' },
    'healer.maxRestarts': { type: 'number', default: 3, min: 1, max: 10, description: 'Max auto-restart attempts' },
    'healer.cooldownMs': { type: 'number', default: 60000, min: 10000, max: 600000, description: 'Auto-healer cooldown between restarts (ms)' },
  },
  'observability': {
    'logger.maxFileSize': { type: 'number', default: 52428800, min: 1048576, max: 524288000, description: 'Log file max size (bytes, ~50MB default)' },
    'logger.retainDays': { type: 'number', default: 7, min: 1, max: 90, description: 'Log retention days' },
    'metrics.snapshotIntervalMs': { type: 'number', default: 60000, min: 10000, max: 600000, description: 'Metrics snapshot interval (ms)' },
    'webhook.maxRetries': { type: 'number', default: 3, min: 0, max: 10, description: 'Alert webhook max retry attempts' },
  },
  'daemon': {
    'cycle.intervalMs': { type: 'number', default: 1800000, min: 60000, max: 7200000, description: 'Daemon cycle interval (ms, ~30min default)' },
    'dream.enabled': { type: 'boolean', default: true, description: 'Dream consolidation in daemon cycles' },
    'promptEvolution.enabled': { type: 'boolean', default: true, description: 'Prompt evolution from verified fossils' },
  },
};

export function getSchemas() {
  return CONFIG_SCHEMAS;
}

export function getNamespaceSchema(namespace) {
  return CONFIG_SCHEMAS[namespace] || null;
}

export function validateConfig(namespace, key, value) {
  const schema = CONFIG_SCHEMAS[namespace]?.[key];
  if (!schema) return { valid: true };

  if (schema.type === 'number') {
    const num = Number(value);
    if (isNaN(num)) return { valid: false, error: `${key} must be a number` };
    if (schema.min !== undefined && num < schema.min) return { valid: false, error: `${key} minimum is ${schema.min}` };
    if (schema.max !== undefined && num > schema.max) return { valid: false, error: `${key} maximum is ${schema.max}` };
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
    return { valid: false, error: `${key} must be a boolean` };
  }
  return { valid: true };
}

export function seedDefaults() {
  try {
    for (const [namespace, keys] of Object.entries(CONFIG_SCHEMAS)) {
      for (const [key, schema] of Object.entries(keys)) {
        const existing = getConfig(namespace, key);
        if (existing === undefined) {
          setConfig(namespace, key, schema.default, { type: schema.type, description: schema.description, source: 'seed' });
        }
      }
    }
  } catch (e) { console.error('[config-schema] seed error:', e.message); }
}

export function getUnifiedDashboard() {
  try {
    const configStats = getConfigStats();
    const flagStats = getFlagStats();
    const allFlags = getAllFlags();
    const recentHistory = getConfigHistory({ limit: 10 });

    const flagsByCategory = {};
    for (const f of allFlags) {
      if (!flagsByCategory[f.category]) flagsByCategory[f.category] = { total: 0, enabled: 0 };
      flagsByCategory[f.category].total++;
      if (f.enabled) flagsByCategory[f.category].enabled++;
    }

    return {
      config: configStats,
      flags: flagStats,
      flagsByCategory,
      recentChanges: recentHistory,
      schemaNamespaces: Object.keys(CONFIG_SCHEMAS),
    };
  } catch { return { config: {}, flags: {}, flagsByCategory: {}, recentChanges: [], schemaNamespaces: [] }; }
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installConfigSchemaRoutes(app) {

  app.get('/api/config-mgr/schemas', route(async (req, res) => {
    const namespace = req.query.namespace;
    if (namespace) {
      const schema = getNamespaceSchema(namespace);
      if (!schema) return res.status(404).json({ error: 'Namespace not found' });
      return res.json({ namespace, schema });
    }
    res.json({ schemas: getSchemas() });
  }));

  app.post('/api/config-mgr/validate', route(async (req, res) => {
    const { namespace, key, value } = req.body || {};
    if (!namespace || !key) return res.status(400).json({ error: 'namespace and key required' });
    const result = validateConfig(namespace, key, value);
    res.json(result);
  }));

  app.post('/api/config-mgr/seed', route(async (req, res) => {
    seedDefaults();
    res.json({ seeded: true, stats: getConfigStats() });
  }));

  app.get('/api/config-mgr/dashboard', route(async (req, res) => {
    res.json(getUnifiedDashboard());
  }));

  app.post('/api/config-mgr/reset/:namespace', route(async (req, res) => {
    const ns = req.params.namespace;
    const schema = CONFIG_SCHEMAS[ns];
    if (!schema) return res.status(404).json({ error: 'Namespace not found' });
    const entries = {};
    for (const [key, def] of Object.entries(schema)) {
      entries[key] = { value: def.default, type: def.type, description: def.description };
    }
    const count = bulkSet(ns, entries, 'reset');
    res.json({ reset: true, namespace: ns, keysReset: count });
  }));
}
