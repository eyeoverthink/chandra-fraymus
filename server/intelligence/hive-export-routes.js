/**
 * Phase 7 — Hive Export REST API
 *
 * 3 endpoints for the Chandra outbound ledger:
 *   GET  /api/intelligence/hive-export          — export stats
 *   GET  /api/intelligence/hive-export/receipts  — recent exported receipts
 *   POST /api/intelligence/hive-export/run       — manual export trigger (body.since optional)
 *   POST /api/intelligence/hive-export/compact   — dedup + re-seal ledger (dryRun true unless body.dryRun === false)
 */

import { exportChandraReceipts, getExportStats, getRecentReceipts, verifyExportChain, compactExportLedger } from './hive-export.js';

export function installHiveExportRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/intelligence/hive-export', route((_req, res) => {
    const stats = getExportStats();
    // The chain verifier refuses files over 10 MB; a bloated ledger must not take the stats down with it.
    let verification;
    try { verification = verifyExportChain(); }
    catch (e) { verification = { intact: null, error: e.message.slice(0, 200), hint: 'POST /api/intelligence/hive-export/compact {"dryRun":false} rebuilds the ledger with one receipt per event' }; }
    res.json({ ...stats, chainVerification: verification });
  }));

  app.get('/api/intelligence/hive-export/receipts', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    res.json(getRecentReceipts({ limit }));
  }));

  app.post('/api/intelligence/hive-export/run', route(async (req, res) => {
    // Optional explicit window; default is the watermark (start of the previous export).
    const since = parseInt(req.body?.since, 10);
    const result = exportChandraReceipts(Number.isFinite(since) && since > 0 ? { since } : {});
    res.json(result);
  }));

  // Operator-only: rewrite the ledger with one receipt per event (old chain archived beside it).
  // POST {"dryRun": true} reports what would change without touching the file.
  app.post('/api/intelligence/hive-export/compact', route((req, res) => {
    res.json(compactExportLedger({ dryRun: req.body?.dryRun !== false }));
  }));
}
