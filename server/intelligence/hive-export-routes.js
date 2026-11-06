/**
 * Phase 7 — Hive Export REST API
 *
 * 3 endpoints for the Chandra outbound ledger:
 *   GET  /api/intelligence/hive-export          — export stats
 *   GET  /api/intelligence/hive-export/receipts  — recent exported receipts
 *   POST /api/intelligence/hive-export/run       — manual export trigger
 */

import { exportChandraReceipts, getExportStats, getRecentReceipts, verifyExportChain } from './hive-export.js';

export function installHiveExportRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/hive-export', route((_req, res) => {
    const stats = getExportStats();
    const verification = verifyExportChain();
    res.json({ ...stats, chainVerification: verification });
  }));

  app.get('/api/intelligence/hive-export/receipts', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    res.json(getRecentReceipts({ limit }));
  }));

  app.post('/api/intelligence/hive-export/run', route(async (_req, res) => {
    const result = exportChandraReceipts();
    res.json(result);
  }));
}
