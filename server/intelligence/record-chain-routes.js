import { append, verify, tail, stats, selftest } from './record-chain.js';

export function installRecordChainRoutes(app) {
  app.post('/api/record-chain/append', (req, res) => {
    const { agent_id, kind, payload } = req.body || {};
    if (!agent_id || !kind) return res.status(400).json({ error: 'agent_id and kind required' });
    try {
      res.json(append(agent_id, kind, payload || {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/record-chain/verify/:agentId', (req, res) => {
    try {
      res.json(verify(req.params.agentId));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/record-chain/tail/:agentId', (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    try {
      res.json(tail(req.params.agentId, limit));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/record-chain/stats', (_req, res) => {
    try {
      res.json(stats());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/record-chain/selftest', (_req, res) => {
    try {
      res.json(selftest());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
