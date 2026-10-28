import {
  startRun, decideApproval, listAgents, getAgent,
  saveAgentManifest, resetAgentManifest, listThreads, getThread,
} from './runtime.js';

export function installFleetRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/fleet/agents', route((req, res) => {
    const agents = listAgents(req.query.userId || 'local');
    res.json({ agents: agents.map(({ systemPrompt, ...a }) => a) });
  }));

  app.get('/api/fleet/agents/:id', route((req, res) => {
    const agent = getAgent(req.query.userId || 'local', req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  }));

  app.put('/api/fleet/agents/:id', route((req, res) => {
    const result = saveAgentManifest({ id: req.params.id, ...req.body });
    res.json(result);
  }));

  app.delete('/api/fleet/agents/:id/override', route((req, res) => {
    const removed = resetAgentManifest(req.params.id);
    res.json({ removed });
  }));

  app.get('/api/fleet/threads', route((req, res) => {
    res.json({ threads: listThreads(req.query.userId || 'local') });
  }));

  app.get('/api/fleet/threads/:id', route((req, res) => {
    const thread = getThread(req.query.userId || 'local', req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json(thread);
  }));

  app.post('/api/fleet/runs', route((req, res) => {
    const { agentId, message, threadId } = req.body;
    if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });
    const result = startRun(req.body.userId || 'local', agentId, message, threadId);
    res.status(201).json(result);
  }));

  app.post('/api/fleet/approvals/:id', route((req, res) => {
    const result = decideApproval(req.body?.userId || 'local', req.params.id, req.body?.approve !== false);
    res.json(result);
  }));
}
