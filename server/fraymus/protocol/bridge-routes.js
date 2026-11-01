// Bridge REST API — exposes fraymus-bridge message bus to Chandra's UI and agents
import { listMessages, readMessage, searchMessages, postMessage, bridgeStatus } from './bridge.js';
import { FLEET_REGISTRY } from '../core/constants.js';

export function installBridgeRoutes(app) {
  app.get('/api/bridge/status', async (_req, res, next) => {
    try {
      const status = bridgeStatus();
      res.json(status);
    } catch (e) { next(e); }
  });

  app.get('/api/bridge/messages', async (req, res, next) => {
    try {
      const agent = req.query.agent || undefined;
      const since = req.query.since ? parseInt(req.query.since, 10) : undefined;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
      const result = await listMessages({ agent, since, limit });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/bridge/messages/:filename', async (req, res, next) => {
    try {
      const result = await readMessage(req.params.filename);
      if (result.error) return res.status(404).json(result);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/bridge/search', async (req, res, next) => {
    try {
      const q = req.query.q;
      if (!q) return res.status(400).json({ error: 'Missing ?q= query param' });
      const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
      const result = await searchMessages(q, { limit });
      res.json(result);
    } catch (e) { next(e); }
  });

  app.post('/api/bridge/post', async (req, res, next) => {
    try {
      const { agent, topic, content } = req.body;
      if (!agent || !topic || !content) {
        return res.status(400).json({ error: 'Required: agent, topic, content' });
      }
      const result = await postMessage(agent, topic, content);
      res.json(result);
    } catch (e) { next(e); }
  });

  app.get('/api/fleet/registry', async (_req, res, next) => {
    try {
      const agents = Object.entries(FLEET_REGISTRY).map(([name, info]) => ({ name, ...info }));
      res.json({ total: agents.length, agents });
    } catch (e) { next(e); }
  });

  app.get('/api/fleet/registry/:name', async (req, res, next) => {
    try {
      const info = FLEET_REGISTRY[req.params.name];
      if (!info) return res.status(404).json({ error: `Unknown fleet agent: ${req.params.name}` });
      res.json({ name: req.params.name, ...info });
    } catch (e) { next(e); }
  });
}
