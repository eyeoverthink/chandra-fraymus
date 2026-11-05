export function installContentNexusRoutes(app, { nexus }) {
  app.get('/api/nexus/stats', (_req, res, next) => {
    try { res.json(nexus.getStats()); } catch (e) { next(e); }
  });

  app.get('/api/nexus/feed', (req, res, next) => {
    try {
      const source = req.query.source || undefined;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);
      const minScore = req.query.minScore === undefined ? undefined : Number(req.query.minScore);
      if (source && !nexus.SOURCES.includes(source)) return res.status(400).json({ error: 'Unknown source' });
      if (minScore !== undefined && (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)) return res.status(400).json({ error: 'minScore must be between 0 and 1' });
      const acted = req.query.acted === 'true' ? true : req.query.acted === 'false' ? false : undefined;
      res.json({ items: nexus.getFeed({ source, limit, offset, acted, minScore }), limit, offset });
    } catch (e) { next(e); }
  });

  app.post('/api/nexus/ingest', (_req, res, next) => {
    try {
      const result = nexus.ingestAll();
      res.json(result);
    } catch (e) { next(e); }
  });

  app.post('/api/nexus/ingest/:source', (req, res, next) => {
    try {
      const src = req.params.source;
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
      if (!nexus.SOURCES.includes(src)) return res.status(400).json({ error: 'Unknown source' });
      const result = nexus.ingestSource(src, limit);
      res.status(['error', 'unavailable'].includes(result.status) ? 503 : 200).json({ ...result, ...(result.error ? { error: result.error } : {}) });
    } catch (e) { next(e); }
  });

  app.post('/api/nexus/act/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { actionType, runId } = req.body || {};
      if (!Number.isSafeInteger(id) || id < 1 || !['commerce', 'creation', 'distribution', 'repurpose'].includes(actionType)) return res.status(400).json({ error: 'Valid item ID and actionType required' });
      if (runId != null && (typeof runId !== 'string' || runId.length > 200)) return res.status(400).json({ error: 'Invalid runId' });
      const item = nexus.actOnItem(id, actionType, runId);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      res.json({ ok: true, item });
    } catch (e) { next(e); }
  });

  app.get('/api/nexus/recommendations', async (req, res, next) => {
    try {
      const limit = Math.min(10, Math.max(1, parseInt(req.query.limit) || 5));
      const focus = typeof req.query.focus === 'string' ? req.query.focus.slice(0, 500) : '';
      const result = await nexus.generateRecommendations(limit, { focus });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/nexus/sources', (_req, res, next) => {
    try { res.json({ sources: nexus.SOURCES, itemTypes: nexus.ITEM_TYPES, details: nexus.getSourceStatus() }); }
    catch (e) { next(e); }
  });
}
