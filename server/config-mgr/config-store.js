import { db } from '../db.js';

const TABLE = 'config_store';
const HISTORY_TABLE = 'config_history';
const subscribers = new Map();

function ensureTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'string',
    description TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (namespace, key)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    source TEXT DEFAULT 'api',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

function castValue(raw, type) {
  switch (type) {
    case 'number': return Number(raw);
    case 'boolean': return raw === 'true' || raw === '1';
    case 'json': try { return JSON.parse(raw); } catch { return raw; }
    default: return raw;
  }
}

function serializeValue(val) {
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

export function getConfig(namespace, key, defaultVal = undefined) {
  try {
    ensureTables();
    const row = db.prepare(`SELECT value, type FROM ${TABLE} WHERE namespace = ? AND key = ?`).get(namespace, key);
    if (!row) return defaultVal;
    return castValue(row.value, row.type);
  } catch { return defaultVal; }
}

export function getNamespaceConfig(namespace) {
  try {
    ensureTables();
    const rows = db.prepare(`SELECT key, value, type, description, updated_at FROM ${TABLE} WHERE namespace = ?`).all(namespace);
    const config = {};
    for (const r of rows) {
      config[r.key] = { value: castValue(r.value, r.type), type: r.type, description: r.description, updatedAt: r.updated_at };
    }
    return config;
  } catch { return {}; }
}

export function getAllNamespaces() {
  try {
    ensureTables();
    const rows = db.prepare(`SELECT DISTINCT namespace FROM ${TABLE} ORDER BY namespace`).all();
    return rows.map(r => r.namespace);
  } catch { return []; }
}

export function setConfig(namespace, key, value, opts = {}) {
  try {
    ensureTables();
    const type = opts.type || (typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : typeof value === 'object' ? 'json' : 'string');
    const serialized = serializeValue(value);
    const description = opts.description || null;
    const source = opts.source || 'api';

    const existing = db.prepare(`SELECT value FROM ${TABLE} WHERE namespace = ? AND key = ?`).get(namespace, key);
    const oldValue = existing ? existing.value : null;

    db.prepare(`INSERT INTO ${TABLE} (namespace, key, value, type, description, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(namespace, key) DO UPDATE SET value = ?, type = ?, description = COALESCE(?, description), updated_at = datetime('now')`)
      .run(namespace, key, serialized, type, description, serialized, type, description);

    if (oldValue !== serialized) {
      db.prepare(`INSERT INTO ${HISTORY_TABLE} (namespace, key, old_value, new_value, source) VALUES (?, ?, ?, ?, ?)`)
        .run(namespace, key, oldValue, serialized, source);
    }

    notifySubscribers(namespace, key, castValue(serialized, type));
    return true;
  } catch (e) { console.error('[config-store] set error:', e.message); return false; }
}

export function deleteConfig(namespace, key) {
  try {
    ensureTables();
    const existing = db.prepare(`SELECT value FROM ${TABLE} WHERE namespace = ? AND key = ?`).get(namespace, key);
    if (!existing) return false;
    db.prepare(`INSERT INTO ${HISTORY_TABLE} (namespace, key, old_value, new_value, source) VALUES (?, ?, ?, NULL, 'delete')`)
      .run(namespace, key, existing.value);
    db.prepare(`DELETE FROM ${TABLE} WHERE namespace = ? AND key = ?`).run(namespace, key);
    notifySubscribers(namespace, key, undefined);
    return true;
  } catch (e) { console.error('[config-store] delete error:', e.message); return false; }
}

export function bulkSet(namespace, entries, source = 'bulk') {
  try {
    ensureTables();
    let count = 0;
    const transaction = db.transaction(() => {
      for (const [key, val] of Object.entries(entries)) {
        const value = typeof val === 'object' && val !== null && 'value' in val ? val.value : val;
        const opts = typeof val === 'object' && val !== null && 'value' in val ? val : {};
        if (setConfig(namespace, key, value, { ...opts, source })) count++;
      }
    });
    transaction();
    return count;
  } catch (e) { console.error('[config-store] bulkSet error:', e.message); return 0; }
}

export function getConfigHistory(opts = {}) {
  try {
    ensureTables();
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    const namespace = opts.namespace;
    if (namespace) {
      return db.prepare(`SELECT * FROM ${HISTORY_TABLE} WHERE namespace = ? ORDER BY id DESC LIMIT ?`).all(namespace, limit);
    }
    return db.prepare(`SELECT * FROM ${HISTORY_TABLE} ORDER BY id DESC LIMIT ?`).all(limit);
  } catch { return []; }
}

export function subscribeConfig(namespace, callback) {
  if (!subscribers.has(namespace)) subscribers.set(namespace, new Set());
  subscribers.get(namespace).add(callback);
  return () => { subscribers.get(namespace)?.delete(callback); };
}

function notifySubscribers(namespace, key, value) {
  const subs = subscribers.get(namespace);
  if (!subs) return;
  for (const cb of subs) {
    try { cb(key, value); } catch (e) { console.error('[config-store] subscriber error:', e.message); }
  }
}

export function getConfigStats() {
  try {
    ensureTables();
    const totalKeys = db.prepare(`SELECT COUNT(*) as count FROM ${TABLE}`).get().count;
    const namespaces = db.prepare(`SELECT namespace, COUNT(*) as count FROM ${TABLE} GROUP BY namespace`).all();
    const recentChanges = db.prepare(`SELECT COUNT(*) as count FROM ${HISTORY_TABLE} WHERE created_at > datetime('now', '-1 hour')`).get().count;
    const totalChanges = db.prepare(`SELECT COUNT(*) as count FROM ${HISTORY_TABLE}`).get().count;
    return { totalKeys, namespaces, recentChanges, totalChanges, subscriberCount: [...subscribers.values()].reduce((s, set) => s + set.size, 0) };
  } catch { return { totalKeys: 0, namespaces: [], recentChanges: 0, totalChanges: 0, subscriberCount: 0 }; }
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installConfigStoreRoutes(app) {
  ensureTables();

  app.get('/api/config-mgr/store', route(async (req, res) => {
    const ns = req.query.namespace;
    if (ns) return res.json(getNamespaceConfig(ns));
    res.json({ namespaces: getAllNamespaces(), stats: getConfigStats() });
  }));

  app.get('/api/config-mgr/store/:namespace/:key', route(async (req, res) => {
    const val = getConfig(req.params.namespace, req.params.key);
    if (val === undefined) return res.status(404).json({ error: 'Key not found' });
    res.json({ namespace: req.params.namespace, key: req.params.key, value: val });
  }));

  app.post('/api/config-mgr/store', route(async (req, res) => {
    const { namespace, key, value, type, description } = req.body || {};
    if (!namespace || !key || value === undefined) return res.status(400).json({ error: 'namespace, key, and value required' });
    const ok = setConfig(namespace, key, value, { type, description });
    res.json({ updated: ok });
  }));

  app.post('/api/config-mgr/store/bulk', route(async (req, res) => {
    const { namespace, entries } = req.body || {};
    if (!namespace || !entries) return res.status(400).json({ error: 'namespace and entries required' });
    const count = bulkSet(namespace, entries);
    res.json({ updated: count });
  }));

  app.delete('/api/config-mgr/store/:namespace/:key', route(async (req, res) => {
    const ok = deleteConfig(req.params.namespace, req.params.key);
    res.json({ deleted: ok });
  }));

  app.get('/api/config-mgr/history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const namespace = req.query.namespace;
    res.json(getConfigHistory({ limit, namespace }));
  }));

  app.get('/api/config-mgr/stats', route(async (req, res) => {
    res.json(getConfigStats());
  }));
}
