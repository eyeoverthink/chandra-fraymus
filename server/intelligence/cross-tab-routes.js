/**
 * Cross-Tab Intelligence REST API
 *
 * 10 endpoints for page visit tracking, classification, insight generation,
 * topic clusters, and Perspective context injection.
 */

import {
  recordVisit, recordAndClassify, classifyVisit,
  getVisits, getVisitStats, generateInsights,
  getInsights, getClusters, getPerspectiveContext,
  pruneOldVisits,
} from './cross-tab.js';

export function installCrossTabRoutes(app, { memoryBridge, broadcast } = {}) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // Record a page visit (lightweight — no LLM, just stores)
  app.post('/api/cross-tab/visit', route(async (req, res) => {
    const { url, title, content, source } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = recordVisit({ url, title, content, source });
    if (broadcast && !result.deduplicated) {
      broadcast('cross-tab', { type: 'visit', ...result });
    }
    res.status(201).json(result);
  }));

  // Record + classify in one shot (uses Ollama)
  app.post('/api/cross-tab/ingest', route(async (req, res) => {
    const { url, title, content, source } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    const result = await recordAndClassify({ url, title, content, source });
    if (broadcast && !result.deduplicated) {
      broadcast('cross-tab', { type: 'ingested', ...result });
    }
    res.json(result);
  }));

  // Classify an existing unclassified visit
  app.post('/api/cross-tab/classify/:id', route(async (req, res) => {
    const result = await classifyVisit(req.params.id, { content: req.body?.content });
    if (broadcast) broadcast('cross-tab', { type: 'classified', ...result });
    res.json(result);
  }));

  // List visits with filtering
  app.get('/api/cross-tab/visits', route(async (_req, res) => {
    const { limit, offset, category, domain, since } = _req.query;
    const visits = getVisits({
      limit: limit ? parseInt(limit) : 50,
      offset: offset ? parseInt(offset) : 0,
      category, domain,
      since: since ? parseInt(since) : undefined,
    });
    res.json({ visits, count: visits.length });
  }));

  // Stats overview
  app.get('/api/cross-tab/stats', route(async (_req, res) => {
    res.json(getVisitStats());
  }));

  // Generate insights from recent browsing
  app.post('/api/cross-tab/insights/generate', route(async (req, res) => {
    const hours = Math.min(168, Math.max(1, parseInt(req.body?.hours) || 24));
    const result = await generateInsights({ hours, memoryBridge });
    if (broadcast && result.id) {
      broadcast('cross-tab', { type: 'insights_generated', id: result.id });
    }
    res.json(result);
  }));

  // List generated insights
  app.get('/api/cross-tab/insights', route(async (_req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(_req.query.limit) || 20));
    res.json({ insights: getInsights({ limit }) });
  }));

  // Topic clusters
  app.get('/api/cross-tab/clusters', route(async (_req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(_req.query.limit) || 20));
    res.json({ clusters: getClusters({ limit }) });
  }));

  // Perspective context (for injection into agent prompts)
  app.get('/api/cross-tab/perspective-context', route(async (_req, res) => {
    const context = getPerspectiveContext();
    res.json({ context, active: !!context });
  }));

  // Prune old data
  app.post('/api/cross-tab/prune', route(async (req, res) => {
    const days = Math.min(365, Math.max(1, parseInt(req.body?.days) || 30));
    res.json(pruneOldVisits(days));
  }));
}
