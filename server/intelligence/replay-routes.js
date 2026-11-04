import { record, replay, sweep, applyWinner, getPolicy, getPolicyValue, listWorlds, getWorld, listSweeps, selftest, migrateReplay } from './replay-engine.js';

export function installReplayRoutes(app) {
  app.post('/api/replay/record', (req, res) => {
    const { agent_id, task, model, chain, quality, cost } = req.body || {};
    if (!agent_id || !task || !chain) return res.status(400).json({ error: 'agent_id, task, and chain required' });
    try {
      res.json(record(agent_id, task, model, chain, quality, cost));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/replay/replay', (req, res) => {
    const { world_id, read_budget } = req.body || {};
    if (!world_id) return res.status(400).json({ error: 'world_id required' });
    try {
      res.json(replay(world_id, read_budget || 3));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/replay/sweep', (req, res) => {
    const { world_id, max_budget } = req.body || {};
    if (!world_id) return res.status(400).json({ error: 'world_id required' });
    try {
      res.json(sweep(world_id, max_budget || 12));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/replay/apply', (req, res) => {
    const { key, value, reason } = req.body || {};
    if (!key || value == null) return res.status(400).json({ error: 'key and value required' });
    try {
      res.json(applyWinner(key, value, reason || 'manual'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/replay/policy', (_req, res) => {
    try {
      res.json(getPolicy());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/replay/worlds', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const agent_id = req.query.agent_id || null;
    try {
      res.json(listWorlds(agent_id, limit));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/replay/worlds/:id', (req, res) => {
    try {
      const w = getWorld(req.params.id);
      if (!w) return res.status(404).json({ error: 'world not found' });
      res.json(w);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/replay/sweeps', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const world_id = req.query.world_id || null;
    try {
      res.json(listSweeps(world_id, limit));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/replay/selftest', (_req, res) => {
    try {
      res.json(selftest());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
