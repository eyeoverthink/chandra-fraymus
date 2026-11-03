import { Router } from 'express';
import {
  initLearningLoopTables, attributeRevenue, getRevenueSummary, getRevenueByTopic,
  getRevenueByPlatform, processShopifyWebhook, generateDecisions, getDecisions,
  markDecisionApplied, pollShopifyOrders,
} from './learning-loop.js';

export function installLearningLoopRoutes(app, { memoryBridge, broadcast } = {}) {
  initLearningLoopTables();
  const router = Router();

  router.get('/api/commerce/revenue/summary', (req, res, next) => {
    try {
      res.json(getRevenueSummary());
    } catch (e) { next(e); }
  });

  router.get('/api/commerce/revenue/by-topic', (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      res.json({ topics: getRevenueByTopic(limit) });
    } catch (e) { next(e); }
  });

  router.get('/api/commerce/revenue/by-platform', (req, res, next) => {
    try {
      res.json({ platforms: getRevenueByPlatform() });
    } catch (e) { next(e); }
  });

  router.post('/api/commerce/revenue/attribute', async (req, res, next) => {
    try {
      const result = attributeRevenue(req.body);
      if (broadcast) broadcast('commerce', { type: 'revenue_attribution', ...result });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/commerce/webhook/shopify-order', async (req, res, next) => {
    try {
      const result = await processShopifyWebhook(req.body, { broadcast, memoryBridge });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.post('/api/commerce/learning/decisions', async (req, res, next) => {
    try {
      const result = await generateDecisions({ memoryBridge, broadcast });
      res.json(result);
    } catch (e) { next(e); }
  });

  router.get('/api/commerce/learning/decisions', (req, res, next) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      res.json({ decisions: getDecisions(limit) });
    } catch (e) { next(e); }
  });

  router.post('/api/commerce/learning/decisions/:id/apply', (req, res, next) => {
    try {
      markDecisionApplied(req.params.id, req.body.outcome);
      res.json({ applied: true });
    } catch (e) { next(e); }
  });

  router.post('/api/commerce/revenue/poll-shopify', async (req, res, next) => {
    try {
      const result = await pollShopifyOrders({ broadcast, memoryBridge });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.use(router);
}
