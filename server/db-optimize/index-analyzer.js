import { db } from '../db.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('index-analyzer');

try {
  db.exec(`CREATE TABLE IF NOT EXISTS index_analysis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    severity TEXT NOT NULL,
    detail TEXT,
    applied INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ia_created ON index_analysis(created_at)');
} catch (e) { log.error('index-analyzer migration failed', { err: e.message }); }

export function listTables() {
  return db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map(r => r.name);
}

export function getTableInfo(tableName) {
  const columns = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '')}")`).all();
  const indexes = db.prepare(`PRAGMA index_list("${tableName.replace(/"/g, '')}")`).all();
  const indexDetails = indexes.map(idx => ({
    ...idx,
    columns: db.prepare(`PRAGMA index_info("${idx.name.replace(/"/g, '')}")`).all(),
  }));

  const rowCount = db.prepare(`SELECT COUNT(*) as c FROM "${tableName.replace(/"/g, '')}"`).get()?.c || 0;

  const pageCount = db.prepare(`SELECT COUNT(*) as c FROM dbstat WHERE name = ?`).get(tableName)?.c || 0;
  const sizeBytes = pageCount * 4096;

  return {
    name: tableName,
    columns,
    indexes: indexDetails,
    rowCount,
    sizeBytes,
    sizeMB: Math.round(sizeBytes / 1048576 * 100) / 100,
  };
}

export function getAllTableStats() {
  const tables = listTables();
  return tables.map(name => {
    try {
      return getTableInfo(name);
    } catch (e) {
      return { name, error: e.message, rowCount: 0, sizeBytes: 0, sizeMB: 0, columns: [], indexes: [] };
    }
  });
}

export function analyzeIndexes() {
  const recommendations = [];
  const tables = getAllTableStats();

  for (const table of tables) {
    if (table.error) continue;

    const indexedColumns = new Set();
    for (const idx of table.indexes) {
      for (const col of idx.columns) {
        indexedColumns.add(col.name);
      }
    }

    for (const col of table.columns) {
      if (col.name === 'id') continue;

      if (col.name === 'created_at' && !indexedColumns.has('created_at') && table.rowCount > 100) {
        recommendations.push({
          table: table.name,
          recommendation: `CREATE INDEX idx_${table.name}_created ON "${table.name}"(created_at)`,
          severity: 'high',
          detail: `${table.name} has ${table.rowCount} rows with unindexed created_at — time-range queries will full-scan`,
        });
      }

      if ((col.name.endsWith('_id') || col.name === 'agent_id' || col.name === 'workflow_id')
          && !indexedColumns.has(col.name) && table.rowCount > 50) {
        recommendations.push({
          table: table.name,
          recommendation: `CREATE INDEX idx_${table.name}_${col.name} ON "${table.name}"("${col.name}")`,
          severity: 'medium',
          detail: `Foreign key column ${col.name} on ${table.name} (${table.rowCount} rows) lacks an index — JOIN/WHERE lookups are O(n)`,
        });
      }

      if (col.name === 'status' && !indexedColumns.has('status') && table.rowCount > 200) {
        recommendations.push({
          table: table.name,
          recommendation: `CREATE INDEX idx_${table.name}_status ON "${table.name}"(status)`,
          severity: 'low',
          detail: `Status column on ${table.name} (${table.rowCount} rows) could benefit from an index for filtered queries`,
        });
      }
    }

    if (table.indexes.length === 0 && table.rowCount > 500) {
      recommendations.push({
        table: table.name,
        recommendation: 'Add indexes based on common query patterns',
        severity: 'high',
        detail: `${table.name} has ${table.rowCount} rows and NO indexes — every query is a full table scan`,
      });
    }
  }

  return recommendations;
}

export function runAnalysis() {
  const recs = analyzeIndexes();
  const now = Date.now();

  db.prepare('DELETE FROM index_analysis WHERE applied = 0').run();

  const insert = db.prepare(
    'INSERT INTO index_analysis (table_name, recommendation, severity, detail, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const r of recs) {
    insert.run(r.table, r.recommendation, r.severity, r.detail, now);
  }

  log.info('index analysis complete', { recommendations: recs.length });
  return { recommendations: recs, total: recs.length };
}

export function applyRecommendation(id) {
  const rec = db.prepare('SELECT * FROM index_analysis WHERE id = ? AND applied = 0').get(id);
  if (!rec) return { error: 'Recommendation not found or already applied' };

  if (!rec.recommendation.startsWith('CREATE INDEX')) {
    return { error: 'Only CREATE INDEX recommendations can be auto-applied' };
  }

  try {
    db.exec(rec.recommendation);
    db.prepare('UPDATE index_analysis SET applied = 1 WHERE id = ?').run(id);
    log.info('applied index recommendation', { id, sql: rec.recommendation });
    return { applied: true, sql: rec.recommendation };
  } catch (e) {
    return { error: e.message, sql: rec.recommendation };
  }
}

export function getAnalysisHistory(limit = 20) {
  return db.prepare(
    'SELECT * FROM index_analysis ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

export function explainQuery(sql) {
  try {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    return { sql, plan };
  } catch (e) {
    return { sql, error: e.message };
  }
}

export function installIndexAnalyzerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/db-optimize/tables', route((_req, res) => {
    res.json({ tables: getAllTableStats() });
  }));

  app.get('/api/db-optimize/tables/:name', route((req, res) => {
    try {
      res.json(getTableInfo(req.params.name));
    } catch (e) { res.status(404).json({ error: e.message }); }
  }));

  app.get('/api/db-optimize/analysis', route((_req, res) => {
    res.json({ history: getAnalysisHistory() });
  }));

  app.post('/api/db-optimize/analyze', route((_req, res) => {
    res.json(runAnalysis());
  }));

  app.post('/api/db-optimize/apply/:id', route((req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    res.json(applyRecommendation(id));
  }));

  app.post('/api/db-optimize/explain', route((req, res) => {
    const { sql } = req.body || {};
    if (!sql) return res.status(400).json({ error: 'sql required' });
    if (!/^\s*SELECT/i.test(sql)) return res.status(400).json({ error: 'only SELECT queries allowed' });
    res.json(explainQuery(sql));
  }));
}
