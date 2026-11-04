import { add, query, get, remove, summary, buildPromptContext, seedFromMemories, selftest, migrateAkashic } from './akashic.js';

export function installAkashicRoutes(app) {
  app.post('/api/akashic/add', (req, res) => {
    const { kind, subject, body, source, confidence } = req.body || {};
    if (!kind || !subject || !body) return res.status(400).json({ error: 'kind, subject, and body required' });
    try {
      res.json(add(kind, subject, body, source, confidence));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/akashic/query', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    try {
      res.json(query(req.query.kind || null, req.query.subject || null, limit));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/akashic/get/:sha', (req, res) => {
    try {
      const r = get(req.params.sha);
      if (!r) return res.status(404).json({ error: 'record not found' });
      res.json(r);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/akashic/:sha', (req, res) => {
    try {
      res.json(remove(req.params.sha));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/akashic/summary', (_req, res) => {
    try {
      res.json(summary());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/akashic/prompt-context', (_req, res) => {
    try {
      res.json({ context: buildPromptContext() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/akashic/seed', (_req, res) => {
    try {
      res.json(seedFromMemories());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/akashic/selftest', (_req, res) => {
    try {
      res.json(selftest());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
