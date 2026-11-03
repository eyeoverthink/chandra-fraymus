import { Router } from 'express';
import {
  initAbTestingTables, createExperiment, listExperiments, getExperiment,
  recordEvent, getResults, concludeExperiment, autoCreateExperiment,
} from './ab-engine.js';

export function installAbTestingRoutes(app, { memoryBridge, broadcast } = {}) {
  initAbTestingTables();
  const router = Router();

  router.get('/api/ab/experiments', (req, res, next) => {
    try {
      const { status, limit } = req.query;
      res.json({ experiments: listExperiments({ status, limit: parseInt(limit) || 20 }) });
    } catch (e) { next(e); }
  });

  router.get('/api/ab/experiments/:id', (req, res, next) => {
    try {
      const exp = getExperiment(req.params.id);
      if (!exp) return res.status(404).json({ error: 'Experiment not found' });
      res.json(exp);
    } catch (e) { next(e); }
  });

  router.post('/api/ab/experiments', (req, res, next) => {
    try {
      const { name, hypothesis, dimension, variantA, variantB } = req.body;
      if (!name || !variantA || !variantB) return res.status(400).json({ error: 'name, variantA, variantB required' });
      const result = createExperiment({ name, hypothesis, dimension, variantA, variantB });
      if (broadcast) broadcast('ab_testing', { type: 'experiment_created', id: result.id, name });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/ab/experiments/auto', async (req, res, next) => {
    try {
      const { topic } = req.body;
      if (!topic) return res.status(400).json({ error: 'topic required' });
      const result = await autoCreateExperiment({ topic, memoryBridge });
      if (result.id && broadcast) broadcast('ab_testing', { type: 'experiment_created', id: result.id, name: result.name });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/ab/events', (req, res, next) => {
    try {
      const { experimentId, variant, eventType, value, metadata } = req.body;
      if (!experimentId || !variant) return res.status(400).json({ error: 'experimentId and variant required' });
      const result = recordEvent({ experimentId, variant, eventType, value, metadata });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/api/ab/experiments/:id/results', (req, res, next) => {
    try {
      const results = getResults(req.params.id);
      if (!results) return res.status(404).json({ error: 'Experiment not found' });
      res.json(results);
    } catch (e) { next(e); }
  });

  router.post('/api/ab/experiments/:id/conclude', (req, res, next) => {
    try {
      const result = concludeExperiment(req.params.id);
      if (!result) return res.status(404).json({ error: 'Experiment not found' });
      if (broadcast) broadcast('ab_testing', { type: 'experiment_concluded', id: req.params.id, winner: result.winner });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.use(router);
}
