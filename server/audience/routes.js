import { Router } from 'express';
import {
  initAudienceTables, getSegments, getSegment, getSegmentSignals,
  getSegmentPredictions, recordSignal, createSegment, getAudienceStats,
  discoverSegments, predictEngagement, generatePersona,
} from './audience-engine.js';

export function installAudienceRoutes(app, { memoryBridge, broadcast } = {}) {
  initAudienceTables();
  const router = Router();

  router.get('/api/audience/segments', (req, res, next) => {
    try {
      const { status, limit } = req.query;
      res.json({ segments: getSegments({ status, limit: parseInt(limit) || 20 }) });
    } catch (e) { next(e); }
  });

  router.get('/api/audience/segments/:id', (req, res, next) => {
    try {
      const segment = getSegment(req.params.id);
      if (!segment) return res.status(404).json({ error: 'Segment not found' });
      const signals = getSegmentSignals(req.params.id, parseInt(req.query.signalLimit) || 20);
      const predictions = getSegmentPredictions(req.params.id, parseInt(req.query.predLimit) || 10);
      res.json({ segment, signals, predictions });
    } catch (e) { next(e); }
  });

  router.post('/api/audience/segments', (req, res, next) => {
    try {
      const result = createSegment(req.body);
      if (broadcast) broadcast('audience', { type: 'segment_created', id: result.id, name: result.name });
      res.status(201).json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/audience/signals', (req, res, next) => {
    try {
      const result = recordSignal(req.body);
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/api/audience/stats', (req, res, next) => {
    try {
      res.json(getAudienceStats());
    } catch (e) { next(e); }
  });

  router.post('/api/audience/discover', async (req, res, next) => {
    try {
      const result = await discoverSegments({ memoryBridge });
      if (broadcast) broadcast('audience', { type: 'segments_discovered', count: result.segments.length });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/audience/segments/:id/predict', async (req, res, next) => {
    try {
      const { contentTopic } = req.body;
      if (!contentTopic) return res.status(400).json({ error: 'contentTopic required' });
      const result = await predictEngagement(req.params.id, contentTopic, { memoryBridge });
      if (result.error) return res.status(404).json(result);
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/audience/segments/:id/persona', async (req, res, next) => {
    try {
      const result = await generatePersona(req.params.id, { memoryBridge });
      if (result.error) return res.status(404).json(result);
      if (broadcast) broadcast('audience', { type: 'persona_generated', segmentId: req.params.id });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.use(router);
}
