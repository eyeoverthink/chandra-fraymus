import { db } from '../db.js';
import { OLLAMA_URL } from '../config.js';

const TABLE = 'orchestrator_checks';

const SUBSYSTEM_CHECKS = [
  {
    id: 'database',
    name: 'SQLite Database',
    category: 'core',
    check: () => {
      const row = db.prepare('SELECT 1 as ok').get();
      const mode = db.pragma('journal_mode', { simple: true });
      return { ok: row?.ok === 1, journalMode: mode };
    },
  },
  {
    id: 'ollama',
    name: 'Ollama LLM',
    category: 'core',
    check: async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return { ok: false, error: `status ${res.status}` };
        const data = await res.json();
        return { ok: true, models: (data.models || []).length };
      } catch (e) {
        clearTimeout(timer);
        return { ok: false, error: e.message };
      }
    },
  },
  {
    id: 'tables',
    name: 'Schema Integrity',
    category: 'core',
    check: () => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const critical = ['runs', 'bus_messages', 'health_metrics', 'agent_memories', 'workflow_runs'];
      const missing = critical.filter(t => !tables.find(r => r.name === t));
      return { ok: missing.length === 0, tableCount: tables.length, missing };
    },
  },
  {
    id: 'wal_health',
    name: 'WAL Status',
    category: 'storage',
    check: () => {
      const mode = db.pragma('journal_mode', { simple: true });
      const pageCount = db.pragma('page_count', { simple: true });
      const freelistCount = db.pragma('freelist_count', { simple: true });
      const wasteRatio = pageCount > 0 ? +(freelistCount / pageCount * 100).toFixed(1) : 0;
      return { ok: mode === 'wal' && wasteRatio < 20, mode, wasteRatio };
    },
  },
  {
    id: 'disk_space',
    name: 'Data Directory',
    category: 'storage',
    check: () => {
      const size = db.pragma('page_size', { simple: true }) * db.pragma('page_count', { simple: true });
      const sizeMb = +(size / 1048576).toFixed(2);
      return { ok: sizeMb < 2048, sizeMb };
    },
  },
  {
    id: 'memory',
    name: 'Process Memory',
    category: 'runtime',
    check: () => {
      const mem = process.memoryUsage();
      const heapMb = +(mem.heapUsed / 1048576).toFixed(2);
      const rssMb = +(mem.rss / 1048576).toFixed(2);
      return { ok: heapMb < 512, heapMb, rssMb };
    },
  },
  {
    id: 'event_loop',
    name: 'Event Loop',
    category: 'runtime',
    check: () => {
      return new Promise(resolve => {
        const start = process.hrtime.bigint();
        setImmediate(() => {
          const lag = Number(process.hrtime.bigint() - start) / 1e6;
          resolve({ ok: lag < 100, lagMs: +lag.toFixed(2) });
        });
      });
    },
  },
];

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_type TEXT NOT NULL,
    subsystems_checked INTEGER,
    subsystems_passed INTEGER,
    subsystems_failed INTEGER,
    results TEXT,
    duration_ms REAL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

export async function runHealthCheck(checkType = 'full') {
  ensureTable();
  const start = Date.now();
  const results = [];

  for (const sub of SUBSYSTEM_CHECKS) {
    const subStart = Date.now();
    try {
      const result = await sub.check();
      results.push({
        id: sub.id,
        name: sub.name,
        category: sub.category,
        status: result.ok ? 'healthy' : 'degraded',
        durationMs: Date.now() - subStart,
        detail: result,
      });
    } catch (e) {
      results.push({
        id: sub.id,
        name: sub.name,
        category: sub.category,
        status: 'failed',
        durationMs: Date.now() - subStart,
        detail: { ok: false, error: e.message },
      });
    }
  }

  const passed = results.filter(r => r.status === 'healthy').length;
  const failed = results.filter(r => r.status !== 'healthy').length;
  const durationMs = Date.now() - start;

  try {
        db.prepare(`INSERT INTO ${TABLE} (check_type, subsystems_checked, subsystems_passed, subsystems_failed, results, duration_ms)
      VALUES (?,?,?,?,?,?)`).run(checkType, results.length, passed, failed, JSON.stringify(results), durationMs);
  } catch (e) { console.error('[orchestrator] save error:', e.message); }

  return { checkType, checked: results.length, passed, failed, durationMs, results };
}

export function getReadinessProbe() {
  try {
        const row = db.prepare('SELECT 1 as ok').get();
    const mem = process.memoryUsage();
    const heapMb = +(mem.heapUsed / 1048576).toFixed(2);
    return {
      ready: row?.ok === 1 && heapMb < 512,
      checks: { database: row?.ok === 1, memoryOk: heapMb < 512, heapMb },
    };
  } catch (e) {
    return { ready: false, checks: { database: false, error: e.message } };
  }
}

export function getLivenessProbe() {
  return new Promise(resolve => {
    const start = process.hrtime.bigint();
    setImmediate(() => {
      const lagMs = +(Number(process.hrtime.bigint() - start) / 1e6).toFixed(2);
      resolve({
        alive: lagMs < 500,
        checks: { eventLoopLagMs: lagMs, uptimeSeconds: +process.uptime().toFixed(1), pid: process.pid },
      });
    });
  });
}

export function getCheckHistory(limit = 50) {
  try {
        ensureTable();
    const rows = db.prepare(`SELECT * FROM ${TABLE} ORDER BY id DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)));
    return rows.map(r => {
      try { r.results = JSON.parse(r.results); } catch {}
      return r;
    });
  } catch { return []; }
}

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installHealthOrchestratorRoutes(app) {
  ensureTable();

  app.get('/api/supervisor/orchestrator', route(async (req, res) => {
    const result = await runHealthCheck('manual');
    res.json(result);
  }));

  app.get('/api/supervisor/orchestrator/history', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json(getCheckHistory(limit));
  }));

  app.get('/api/supervisor/orchestrator/readiness', route(async (req, res) => {
    const probe = getReadinessProbe();
    res.status(probe.ready ? 200 : 503).json(probe);
  }));

  app.get('/api/supervisor/orchestrator/liveness', route(async (req, res) => {
    const probe = await getLivenessProbe();
    res.status(probe.alive ? 200 : 503).json(probe);
  }));

  app.post('/api/supervisor/orchestrator/check', route(async (req, res) => {
    const result = await runHealthCheck('triggered');
    res.json(result);
  }));

  // prune old checks
  app.post('/api/supervisor/orchestrator/prune', route(async (req, res) => {
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const info = db.prepare(`DELETE FROM ${TABLE} WHERE created_at < ?`).run(cutoff);
    res.json({ pruned: info.changes });
  }));
}
