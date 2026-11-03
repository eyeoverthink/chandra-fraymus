import { Router } from 'express';
import {
  initRepurposeTables, getTemplates, getJobs, getJob, getRepurposeStats,
  repurposeContent, suggestRepurposeTargets,
} from './repurpose-engine.js';

export function installRepurposeRoutes(app, { memoryBridge, broadcast } = {}) {
  initRepurposeTables();
  const router = Router();

  router.get('/api/repurpose/templates', (req, res, next) => {
    try {
      const { sourceFormat, targetFormat } = req.query;
      res.json({ templates: getTemplates({ sourceFormat, targetFormat }) });
    } catch (e) { next(e); }
  });

  router.get('/api/repurpose/jobs', (req, res, next) => {
    try {
      const { status, limit } = req.query;
      res.json({ jobs: getJobs({ status, limit: parseInt(limit) || 20 }) });
    } catch (e) { next(e); }
  });

  router.get('/api/repurpose/jobs/:id', (req, res, next) => {
    try {
      const job = getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json(job);
    } catch (e) { next(e); }
  });

  router.get('/api/repurpose/stats', (req, res, next) => {
    try {
      res.json(getRepurposeStats());
    } catch (e) { next(e); }
  });

  router.post('/api/repurpose/run', async (req, res, next) => {
    try {
      const { content, sourceFormat, sourcePlatform, targetFormats, targetPlatforms, audienceSegment } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const result = await repurposeContent({ content, sourceFormat, sourcePlatform, targetFormats, targetPlatforms, audienceSegment, memoryBridge, broadcast });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/repurpose/suggest', async (req, res, next) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: 'content required' });
      const result = await suggestRepurposeTargets(content, { memoryBridge });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.use(router);
}
