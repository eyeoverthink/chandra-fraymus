import { db } from '../db.js';

const TABLE = 'feature_flags';
const HISTORY_TABLE = 'feature_flag_history';
const flagSubscribers = new Map();

function ensureTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    flag TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    category TEXT DEFAULT 'general',
    rollout_pct INTEGER DEFAULT 100,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flag TEXT NOT NULL,
    action TEXT NOT NULL,
    old_enabled INTEGER,
    new_enabled INTEGER,
    source TEXT DEFAULT 'api',
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

const DEFAULT_FLAGS = [
  { flag: 'autonomy.daemon', description: 'Background evolution daemon cycle', category: 'intelligence', enabled: true },
  { flag: 'autonomy.reflection', description: 'Scheduled self-analysis reflections', category: 'intelligence', enabled: true },
  { flag: 'autonomy.neurogenesis', description: 'Spontaneous connectivity re-ignition', category: 'intelligence', enabled: true },
  { flag: 'autonomy.consciousness', description: 'CTRNN consciousness audit cycle', category: 'intelligence', enabled: true },
  { flag: 'autonomy.sensory', description: 'Sensory bridge telemetry injection', category: 'intelligence', enabled: true },
  { flag: 'autonomy.emotional', description: 'Emotional feedback CTRNN plasticity', category: 'intelligence', enabled: true },
  { flag: 'autonomy.motor', description: 'Motor output action firing', category: 'intelligence', enabled: true },
  { flag: 'infra.rate_limiter', description: 'API rate limiting middleware', category: 'infrastructure', enabled: true },
  { flag: 'infra.request_validator', description: 'Request body validation/sanitization', category: 'infrastructure', enabled: true },
  { flag: 'infra.compression', description: 'Gzip response compression', category: 'infrastructure', enabled: true },
  { flag: 'infra.etag', description: 'ETag conditional responses', category: 'infrastructure', enabled: true },
  { flag: 'infra.request_profiler', description: 'Request timing profiler', category: 'infrastructure', enabled: true },
  { flag: 'infra.auto_healer', description: 'Automatic recovery from health alerts', category: 'infrastructure', enabled: true },
  { flag: 'infra.scheduled_backups', description: 'Periodic SQLite backups', category: 'infrastructure', enabled: true },
  { flag: 'commerce.shopify', description: 'Shopify integration pipelines', category: 'commerce', enabled: true },
  { flag: 'commerce.printify', description: 'Printify integration for apparel', category: 'commerce', enabled: true },
  { flag: 'fleet.forge', description: 'LLM-driven agent forging', category: 'fleet', enabled: true },
  { flag: 'fleet.bus_triggers', description: 'Event-driven workflow triggers', category: 'fleet', enabled: true },
  { flag: 'media.tts', description: 'Text-to-speech engine', category: 'media', enabled: true },
  { flag: 'media.stt', description: 'Speech-to-text transcription', category: 'media', enabled: true },
  { flag: 'streaming.overlay', description: 'OBS streaming overlay bridge', category: 'streaming', enabled: true },
];

export function seedDefaultFlags() {
  try {
    ensureTables();
    const insert = db.prepare(`INSERT OR IGNORE INTO ${TABLE} (flag, enabled, description, category) VALUES (?, ?, ?, ?)`);
    const transaction = db.transaction(() => {
      for (const f of DEFAULT_FLAGS) {
        insert.run(f.flag, f.enabled ? 1 : 0, f.description, f.category);
      }
    });
    transaction();
  } catch (e) { console.error('[feature-flags] seed error:', e.message); }
}

export function isEnabled(flag) {
  try {
    ensureTables();
    const row = db.prepare(`SELECT enabled, rollout_pct FROM ${TABLE} WHERE flag = ?`).get(flag);
    if (!row) return true;
    if (!row.enabled) return false;
    if (row.rollout_pct < 100) {
      const hash = flag.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      return (Math.abs(hash) % 100) < row.rollout_pct;
    }
    return true;
  } catch { return true; }
}

export function setFlag(flag, enabled, opts = {}) {
  try {
    ensureTables();
    const existing = db.prepare(`SELECT enabled FROM ${TABLE} WHERE flag = ?`).get(flag);
    const oldEnabled = existing ? existing.enabled : null;
    const newEnabled = enabled ? 1 : 0;

    if (existing) {
      db.prepare(`UPDATE ${TABLE} SET enabled = ?, updated_at = datetime('now') WHERE flag = ?`).run(newEnabled, flag);
    } else {
      db.prepare(`INSERT INTO ${TABLE} (flag, enabled, description, category) VALUES (?, ?, ?, ?)`)
        .run(flag, newEnabled, opts.description || null, opts.category || 'general');
    }

    db.prepare(`INSERT INTO ${HISTORY_TABLE} (flag, action, old_enabled, new_enabled, source) VALUES (?, ?, ?, ?, ?)`)
      .run(flag, enabled ? 'enable' : 'disable', oldEnabled, newEnabled, opts.source || 'api');

    notifyFlagSubscribers(flag, !!enabled);
    return true;
  } catch (e) { console.error('[feature-flags] set error:', e.message); return false; }
}

export function toggleFlag(flag) {
  try {
    ensureTables();
    const existing = db.prepare(`SELECT enabled FROM ${TABLE} WHERE flag = ?`).get(flag);
    if (!existing) return false;
    return setFlag(flag, !existing.enabled);
  } catch { return false; }
}

export function getAllFlags(category) {
  try {
    ensureTables();
    if (category) {
      return db.prepare(`SELECT * FROM ${TABLE} WHERE category = ? ORDER BY flag`).all(category);
    }
    return db.prepare(`SELECT * FROM ${TABLE} ORDER BY category, flag`).all();
  } catch { return []; }
}

export function getCategories() {
  try {
    ensureTables();
    return db.prepare(`SELECT category, COUNT(*) as count, SUM(enabled) as enabled_count FROM ${TABLE} GROUP BY category ORDER BY category`).all();
  } catch { return []; }
}

export function getFlagHistory(opts = {}) {
  try {
    ensureTables();
    const limit = Math.min(200, Math.max(1, opts.limit || 50));
    if (opts.flag) {
      return db.prepare(`SELECT * FROM ${HISTORY_TABLE} WHERE flag = ? ORDER BY id DESC LIMIT ?`).all(opts.flag, limit);
    }
    return db.prepare(`SELECT * FROM ${HISTORY_TABLE} ORDER BY id DESC LIMIT ?`).all(limit);
  } catch { return []; }
}

export function setRollout(flag, pct) {
  try {
    ensureTables();
    const clamped = Math.min(100, Math.max(0, pct));
    db.prepare(`UPDATE ${TABLE} SET rollout_pct = ?, updated_at = datetime('now') WHERE flag = ?`).run(clamped, flag);
    return true;
  } catch { return false; }
}

export function subscribeFlagChange(flag, callback) {
  if (!flagSubscribers.has(flag)) flagSubscribers.set(flag, new Set());
  flagSubscribers.get(flag).add(callback);
  return () => { flagSubscribers.get(flag)?.delete(callback); };
}

function notifyFlagSubscribers(flag, enabled) {
  const subs = flagSubscribers.get(flag);
  if (!subs) return;
  for (const cb of subs) {
    try { cb(enabled); } catch (e) { console.error('[feature-flags] subscriber error:', e.message); }
  }
}

export function getFlagStats() {
  try {
    ensureTables();
    const total = db.prepare(`SELECT COUNT(*) as count FROM ${TABLE}`).get().count;
    const enabled = db.prepare(`SELECT COUNT(*) as count FROM ${TABLE} WHERE enabled = 1`).get().count;
    const categories = getCategories();
    const recentToggles = db.prepare(`SELECT COUNT(*) as count FROM ${HISTORY_TABLE} WHERE created_at > datetime('now', '-1 hour')`).get().count;
    return { total, enabled, disabled: total - enabled, categories, recentToggles };
  } catch { return { total: 0, enabled: 0, disabled: 0, categories: [], recentToggles: 0 }; }
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installFeatureFlagRoutes(app) {
  ensureTables();
  seedDefaultFlags();

  app.get('/api/config-mgr/flags', route(async (req, res) => {
    const category = req.query.category;
    res.json({ flags: getAllFlags(category), stats: getFlagStats() });
  }));

  app.get('/api/config-mgr/flags/categories', route(async (req, res) => {
    res.json({ categories: getCategories() });
  }));

  app.get('/api/config-mgr/flags/:flag', route(async (req, res) => {
    const flag = req.params.flag;
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE flag = ?`).get(flag);
    if (!row) return res.status(404).json({ error: 'Flag not found' });
    res.json(row);
  }));

  app.post('/api/config-mgr/flags', route(async (req, res) => {
    const { flag, enabled, description, category } = req.body || {};
    if (!flag) return res.status(400).json({ error: 'flag name required' });
    const ok = setFlag(flag, enabled !== false, { description, category });
    res.json({ updated: ok });
  }));

  app.post('/api/config-mgr/flags/:flag/toggle', route(async (req, res) => {
    const ok = toggleFlag(req.params.flag);
    if (!ok) return res.status(404).json({ error: 'Flag not found' });
    const row = db.prepare(`SELECT * FROM ${TABLE} WHERE flag = ?`).get(req.params.flag);
    res.json({ toggled: true, flag: row });
  }));

  app.post('/api/config-mgr/flags/:flag/rollout', route(async (req, res) => {
    const { percentage } = req.body || {};
    if (percentage === undefined) return res.status(400).json({ error: 'percentage required' });
    const ok = setRollout(req.params.flag, percentage);
    res.json({ updated: ok });
  }));

  app.get('/api/config-mgr/flags-history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const flag = req.query.flag;
    res.json(getFlagHistory({ limit, flag }));
  }));
}
