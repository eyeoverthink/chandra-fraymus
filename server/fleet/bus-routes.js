import {
  publish, directMessage, subscribe, unsubscribe,
  listSubscriptions, inbox, history, topics, busStats,
} from './bus.js';

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installBusRoutes(app) {

  // Publish a message to a topic
  app.post('/api/fleet/bus/publish', route((req, res) => {
    const { from, topic, payload } = req.body;
    if (!from || !topic) return res.status(400).json({ error: 'from and topic required' });
    const msg = publish(from, topic, payload || {});
    res.status(201).json(msg);
  }));

  // Send a direct message to an agent
  app.post('/api/fleet/bus/dm', route((req, res) => {
    const { from, to, payload } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    const msg = directMessage(from, to, payload || {});
    res.status(201).json(msg);
  }));

  // Subscribe an agent to a topic
  app.post('/api/fleet/bus/subscribe', route((req, res) => {
    const { agentId, topic } = req.body;
    if (!agentId || !topic) return res.status(400).json({ error: 'agentId and topic required' });
    res.json(subscribe(agentId, topic));
  }));

  // Unsubscribe an agent from a topic
  app.delete('/api/fleet/bus/subscribe', route((req, res) => {
    const { agentId, topic } = req.body;
    if (!agentId || !topic) return res.status(400).json({ error: 'agentId and topic required' });
    res.json(unsubscribe(agentId, topic));
  }));

  // List topics with message counts
  app.get('/api/fleet/bus/topics', route((_req, res) => {
    res.json({ topics: topics() });
  }));

  // Message history for a topic
  app.get('/api/fleet/bus/history/:topic', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const since = parseInt(req.query.since) || 0;
    res.json({ messages: history(req.params.topic, { limit, since }) });
  }));

  // Agent inbox (subscribed topics + DMs)
  app.get('/api/fleet/bus/inbox/:agentId', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const since = parseInt(req.query.since) || 0;
    res.json({ messages: inbox(req.params.agentId, { limit, since }) });
  }));

  // List subscriptions (all, or per agent)
  app.get('/api/fleet/bus/subscriptions', route((req, res) => {
    res.json({ subscriptions: listSubscriptions(req.query.agentId || null) });
  }));

  // Bus stats
  app.get('/api/fleet/bus/stats', route((_req, res) => {
    res.json(busStats());
  }));
}
