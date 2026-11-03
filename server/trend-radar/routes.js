import { Router } from 'express';
import {
  initTrendRadarTables, getTrends, getTrendStats,
  dismissTrend, scanTrends, assessTrendForContent,
} from './radar.js';

export function installTrendRadarRoutes(app, { memoryBridge, broadcast } = {}) {
  initTrendRadarTables();
  const router = Router();

  router.get('/api/trends', (req, res, next) => {
    try {
      const { status, category, minRelevance, limit } = req.query;
      res.json({ trends: getTrends({ status, category, minRelevance, limit: parseInt(limit) || 20 }) });
    } catch (e) { next(e); }
  });

  router.get('/api/trends/stats', (req, res, next) => {
    try {
      res.json(getTrendStats());
    } catch (e) { next(e); }
  });

  router.post('/api/trends/scan', async (req, res, next) => {
    try {
      const { niche } = req.body;
      const result = await scanTrends({ niche, memoryBridge });
      if (broadcast) broadcast('trend_radar', { type: 'scan_complete', newTrends: result.newTrends, total: result.totalTracked });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/trends/:id/assess', async (req, res, next) => {
    try {
      const result = await assessTrendForContent(req.params.id, { memoryBridge });
      if (result.error) return res.status(404).json(result);
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/trends/:id/dismiss', (req, res, next) => {
    try {
      const ok = dismissTrend(req.params.id);
      if (ok && broadcast) broadcast('trend_radar', { type: 'trend_dismissed', id: req.params.id });
      res.json({ dismissed: ok });
    } catch (e) { next(e); }
  });

  app.use(router);
}
