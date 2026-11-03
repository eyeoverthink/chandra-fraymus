import { Router } from 'express';
import {
  initAnalyticsTables,
  recordMetrics,
  getTopPerformers,
  getAnalyticsByTopic,
  getAnalyticsOverview,
  generateInsights,
  getInsights,
} from './collector.js';

export function installAnalyticsRoutes(app, { memoryBridge, broadcast }) {
  const router = Router();

  initAnalyticsTables();

  router.post('/api/analytics/record', async (req, res, next) => {
    try {
      const { distributionRunId, creationRunId, platform, topic, metrics } = req.body;
      if (!platform || !metrics) return res.status(400).json({ error: 'platform and metrics required' });
      const result = recordMetrics({ distributionRunId, creationRunId, platform, topic, metrics });
      broadcast('analytics', { type: 'metrics_recorded', platform, topic });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/api/analytics/overview', (_req, res) => {
    res.json(getAnalyticsOverview());
  });

  router.get('/api/analytics/top', (req, res) => {
    const platform = req.query.platform || null;
    const limit = Math.min(Number(req.query.limit) || 10, 100);
    res.json({ top: getTopPerformers(platform, limit) });
  });

  router.get('/api/analytics/topic/:topic', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 200);
    res.json({ analytics: getAnalyticsByTopic(req.params.topic, limit) });
  });

  router.post('/api/analytics/insights', async (req, res, next) => {
    try {
      const result = await generateInsights(memoryBridge);
      if (result.insights.length > 0) {
        broadcast('analytics', { type: 'insights_generated', count: result.insights.length });
      }
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/api/analytics/insights', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json({ insights: getInsights(limit) });
  });

  app.use(router);
}
