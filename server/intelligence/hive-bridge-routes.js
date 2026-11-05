import {
  ensureHiveBridgeTable,
  ingestHiveFile,
  verifyHiveChain,
  getIngestionStats,
  detectFormat
} from './hive-bridge.js';
import { db } from '../db.js';

export function installHiveBridgeRoutes(app) {
  ensureHiveBridgeTable();

  app.get('/api/intelligence/hive-bridge', (_req, res, next) => {
    try {
      const stats = getIngestionStats();
      res.json(stats);
    } catch (e) { next(e); }
  });

  app.get('/api/intelligence/hive-bridge/receipts', (req, res, next) => {
    try {
      const format = req.query.format;
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);

      let sql = 'SELECT * FROM hive_ingestion';
      const params = [];
      if (format === 'raw' || format === 'projection') {
        sql += ' WHERE source_format = ?';
        params.push(format);
      }
      sql += ' ORDER BY receipt_index ASC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = db.prepare(sql).all(...params);

      let countSql = 'SELECT COUNT(*) as c FROM hive_ingestion';
      const countParams = [];
      if (format === 'raw' || format === 'projection') {
        countSql += ' WHERE source_format = ?';
        countParams.push(format);
      }
      const total = db.prepare(countSql).get(...countParams);

      res.json({ receipts: rows, total: total?.c || 0, limit, offset });
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/hive-bridge/ingest', (req, res, next) => {
    try {
      const { path } = req.body || {};
      const result = ingestHiveFile(path || undefined);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.post('/api/intelligence/hive-bridge/verify', (req, res, next) => {
    try {
      const { path } = req.body || {};
      const result = verifyHiveChain(path || undefined);
      if (result.error) return res.status(400).json(result);
      res.json(result);
    } catch (e) { next(e); }
  });
}
