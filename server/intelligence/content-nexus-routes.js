export function installContentNexusRoutes(app, { nexus, broadcast }) {
  app.get('/api/nexus/stats', (_req, res, next) => {
    try { res.json(nexus.getStats()); } catch (e) { next(e); }
  });

  app.get('/api/nexus/feed', (req, res, next) => {
    try {
      const source = req.query.source || undefined;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const offset = Math.max(0, parseInt(req.query.offset) || 0);
      const minScore = req.query.minScore ? parseFloat(req.query.minScore) : undefined;
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
      let count = 0;
      switch (src) {
        case 'youtube': count = nexus.ingestFromYouTube(limit); break;
        case 'web': count = nexus.ingestFromWeb(limit); break;
        case 'trends': count = nexus.ingestFromTrends(limit); break;
        case 'browsing': count = nexus.ingestFromBrowsing(limit); break;
        case 'calendar': count = nexus.ingestFromCalendar(limit); break;
        default: return res.status(400).json({ error: `Unknown source: ${src}` });
      }
      res.json({ source: src, ingested: count });
    } catch (e) { next(e); }
  });

  app.post('/api/nexus/act/:id', (req, res, next) => {
    try {
      const id = parseInt(req.params.id);
      const { actionType, runId } = req.body || {};
      if (!actionType) return res.status(400).json({ error: 'actionType required' });
      const item = nexus.actOnItem(id, actionType, runId);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      res.json({ ok: true, item });
    } catch (e) { next(e); }
  });

  app.get('/api/nexus/recommendations', async (req, res, next) => {
    try {
      const limit = Math.min(10, Math.max(1, parseInt(req.query.limit) || 5));
      const result = await nexus.generateRecommendations(limit);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/nexus/sources', (_req, res) => {
    res.json({ sources: nexus.SOURCES, itemTypes: nexus.ITEM_TYPES });
  });
}
