// Vertiso + RSI REST API routes
export function installVertisoRoutes(app, { vertiso, rsi }) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // ── Vertiso Memory ──
  app.post('/api/vertiso/store', route(async (req, res) => {
    const { agentId, content, namespace, importance, metadata } = req.body;
    if (!agentId || !content) return res.status(400).json({ error: 'agentId and content required' });
    const result = await vertiso.store({ agentId, content, namespace, importance, metadata });
    res.status(201).json(result);
  }));

  app.post('/api/vertiso/recall', route(async (req, res) => {
    const { agentId, query, namespace, limit, minSimilarity } = req.body;
    if (!agentId || !query) return res.status(400).json({ error: 'agentId and query required' });
    const memories = await vertiso.recall({ agentId, query, namespace, limit, minSimilarity });
    res.json({ memories, count: memories.length });
  }));

  app.post('/api/vertiso/recall/global', route(async (req, res) => {
    const { query, limit, minSimilarity } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });
    const memories = await vertiso.recallGlobal({ query, limit, minSimilarity });
    res.json({ memories, count: memories.length });
  }));

  app.post('/api/vertiso/consolidate', route(async (req, res) => {
    const { agentId, namespace } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    res.json(await vertiso.consolidate(agentId, namespace));
  }));

  app.delete('/api/vertiso/memory/:id', route((req, res) => {
    res.json(vertiso.forget(req.params.id));
  }));

  app.get('/api/vertiso/stats', route((_req, res) => {
    res.json(vertiso.allStats());
  }));

  app.get('/api/vertiso/stats/:agentId', route((req, res) => {
    res.json(vertiso.stats(req.params.agentId));
  }));

  // ── RSI Engine ──
  app.post('/api/rsi/evolve', route(async (req, res) => {
    const { agentId, metrics, populationSize, mutationRate } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    const result = await rsi.evolve(agentId, metrics || {}, { populationSize, mutationRate });
    res.json(result);
  }));

  app.post('/api/rsi/reflect', route(async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    res.json(await rsi.reflect(agentId));
  }));

  app.post('/api/rsi/improve', route(async (req, res) => {
    const { agentId, kind, target, value } = req.body;
    if (!agentId || !kind || !target) return res.status(400).json({ error: 'agentId, kind, target required' });
    res.json(await rsi.improve(agentId, kind, { target, value }));
  }));

  app.post('/api/rsi/rewrite-prompt', route(async (req, res) => {
    const { agentId, currentPrompt, feedback } = req.body;
    if (!agentId || !currentPrompt || !feedback) return res.status(400).json({ error: 'agentId, currentPrompt, feedback required' });
    res.json(await rsi.rewritePrompt(agentId, currentPrompt, feedback));
  }));

  app.post('/api/rsi/revert/:id', route((req, res) => {
    res.json(rsi.revert(req.params.id));
  }));

  app.post('/api/rsi/evolve-fleet', route(async (req, res) => {
    const { agentIds, metrics } = req.body;
    if (!agentIds?.length) return res.status(400).json({ error: 'agentIds array required' });
    res.json(await rsi.evolveFleet(agentIds, metrics || {}));
  }));

  app.get('/api/rsi/genome/:agentId', route((req, res) => {
    res.json({ agentId: req.params.agentId, genome: rsi.getGenome(req.params.agentId), generation: rsi.currentGeneration(req.params.agentId) });
  }));

  app.get('/api/rsi/history/:agentId', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ history: rsi.history(req.params.agentId, limit) });
  }));

  app.get('/api/rsi/status', route((_req, res) => {
    res.json(rsi.status());
  }));
}
