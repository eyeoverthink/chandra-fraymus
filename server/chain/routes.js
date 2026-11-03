/**
 * Logic Chain REST API routes.
 */

import { executeChain, loadRun, loadRunStages, listRuns, deleteRun, renderDocument, saveRun } from './engine.js';
import { getDefaultSlots } from './roles.js';
import { ledgerStats } from './ledger.js';
import { reviewLedger, REVIEW_PANEL, JEV_THRESHOLD } from './review.js';

let broadcastFn = () => {};
let memoryBridgeRef = null;

export function installChainRoutes(app, { broadcast, memoryBridge } = {}) {
  broadcastFn = broadcast || (() => {});
  memoryBridgeRef = memoryBridge || null;

  app.post('/api/chain/run', async (req, res, next) => {
    try {
      const { objective, config } = req.body || {};
      if (!objective || typeof objective !== 'string' || objective.trim().length < 3) {
        return res.status(400).json({ error: 'Objective must be a non-empty string (min 3 chars)' });
      }

      const runPromise = executeChain(objective.trim(), config || {}, { broadcast: broadcastFn, memoryBridge: memoryBridgeRef });
      runPromise.then(() => {}).catch(err => console.error('chain: background run failed:', err.message));

      await new Promise(resolve => setTimeout(resolve, 300));
      const recent = listRuns(1);
      const started = recent.find(r => r.objective === objective.trim() && r.status === 'running');
      res.status(202).json({ id: started?.id || 'pending', status: started?.status || 'starting' });
    } catch (e) { next(e); }
  });

  app.get('/api/chain/runs', (_req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, parseInt(_req.query.limit) || 50));
      res.json({ runs: listRuns(limit) });
    } catch (e) { next(e); }
  });

  app.get('/api/chain/runs/:id', (req, res, next) => {
    try {
      const run = loadRun(req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      run.stageDetails = loadRunStages(req.params.id);
      run.ledgerStats = ledgerStats(run.ledger);
      res.json(run);
    } catch (e) { next(e); }
  });

  app.get('/api/chain/runs/:id/document', (req, res, next) => {
    try {
      const run = loadRun(req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      const md = renderDocument(run);
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(md);
    } catch (e) { next(e); }
  });

  app.delete('/api/chain/runs/:id', (req, res, next) => {
    try {
      const deleted = deleteRun(req.params.id);
      if (!deleted) return res.status(404).json({ error: 'Run not found' });
      res.json({ deleted: req.params.id });
    } catch (e) { next(e); }
  });

  app.get('/api/chain/runs/:id/review', (req, res, next) => {
    try {
      const run = loadRun(req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (!run.review) return res.json({ review: null, message: 'No review yet — run is still in progress or review was skipped' });
      res.json({ review: run.review });
    } catch (e) { next(e); }
  });

  app.post('/api/chain/runs/:id/review', async (req, res, next) => {
    try {
      const run = loadRun(req.params.id);
      if (!run) return res.status(404).json({ error: 'Run not found' });
      if (run.status === 'running') return res.status(409).json({ error: 'Cannot review a running chain — wait for completion' });

      const reviewPromise = reviewLedger(run.objective, run.ledger, run.config || {}, { broadcast: broadcastFn });
      reviewPromise.then(review => {
        const freshRun = loadRun(req.params.id);
        if (freshRun) {
          freshRun.review = review;
          saveRun(freshRun);
        }
      }).catch(err => console.error('chain: standalone review failed:', err.message));

      res.status(202).json({ status: 'review_started', runId: req.params.id });
    } catch (e) { next(e); }
  });

  app.get('/api/chain/review-panel', (_req, res) => {
    res.json({ panel: REVIEW_PANEL, jevThreshold: JEV_THRESHOLD });
  });

  app.get('/api/chain/slots', (_req, res) => {
    res.json({ slots: getDefaultSlots() });
  });
}
