import { Router } from 'express';
import { optimizeForPlatform, distributeToAll } from './social.js';
import { availablePlatforms, createDistributionIntel } from './shared.js';
import {
  initContentCalendar,
  scheduleContent,
  listScheduled,
  cancelScheduled,
  listDistributionRuns,
  getDistributionStats,
  runDistributionPipeline,
} from './scheduler.js';

export function installDistributionRoutes(app, { memoryBridge, broadcast }) {
  const router = Router();
  const intel = createDistributionIntel(memoryBridge);

  initContentCalendar();

  router.get('/api/distribution/platforms', (_req, res) => {
    res.json({ platforms: availablePlatforms() });
  });

  router.post('/api/distribution/optimize', async (req, res, next) => {
    try {
      const { content, platform } = req.body;
      if (!content || !platform) return res.status(400).json({ error: 'content and platform required' });
      const optimized = await optimizeForPlatform(content, platform);
      res.json({ platform, optimized });
    } catch (e) { next(e); }
  });

  router.post('/api/distribution/publish', async (req, res, next) => {
    try {
      const { content, platforms, creationRunId } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const result = await runDistributionPipeline(content, { intel, broadcast, creationRunId });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/api/distribution/runs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json({ runs: listDistributionRuns(limit) });
  });

  router.get('/api/distribution/stats', (_req, res) => {
    res.json(getDistributionStats());
  });

  // Content Calendar
  router.post('/api/distribution/calendar', async (req, res, next) => {
    try {
      const { topic, format, style, platforms, scheduledAt } = req.body;
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const entry = scheduleContent({ topic, format, style, platforms, scheduledAt });
      broadcast('creation', { type: 'calendar', action: 'scheduled', topic, id: entry.id });
      res.json(entry);
    } catch (e) { next(e); }
  });

  router.get('/api/distribution/calendar', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    res.json({ entries: listScheduled(limit) });
  });

  router.delete('/api/distribution/calendar/:id', (req, res) => {
    const cancelled = cancelScheduled(req.params.id);
    if (!cancelled) return res.status(404).json({ error: 'not found or already processed' });
    res.json({ cancelled: true });
  });

  app.use(router);
}
