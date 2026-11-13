import {
  startRun, decideApproval, listAgents, getAgent,
  saveAgentManifest, resetAgentManifest, listThreads, getThread,
  getQueueStatus, reloadManifests, fleetToolNames, modelPoolStatus, searchSharedTools, listSharedTools, lastModelCall,
} from './runtime.js';
import { poolModels } from '../intelligence/model-pool.js';

export function installFleetRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // Backward-compatible alias used by older UI code.
  app.get('/api/fleet', route((req, res) => {
    const agents = listAgents(req.query.userId || 'local');
    const sanitized = agents.map(({ systemPrompt, ...a }) => a);
    res.json({ agents: sanitized, fleet: sanitized });
  }));

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
    const { agentId, message, threadId, model } = req.body;
    if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });
    // model (optional): run this agent on a named model; the pool sends each call to a machine that has it
    const result = startRun(req.body.userId || 'local', agentId, message, threadId, { model, interactive: req.body.interactive === true });
    res.status(201).json(result);
  }));

  app.post('/api/fleet/approvals/:id', route(async (req, res) => {
    const result = await decideApproval(req.body?.userId || 'local', req.params.id, req.body?.approve !== false);
    res.json(result);
  }));

  // Every shared tool with its approval label (every agent may use every tool; only approvals stop one)
  app.get('/api/fleet/tools', route((_req, res) => { const tools = listSharedTools(); res.json({ total: tools.length, tools }); }));

  // Every model the pool can reach and which machines hold it, plus the last agent call that was answered
  app.get('/api/fleet/models', route(async (_req, res) => res.json({ models: await poolModels(), last: lastModelCall() })));

  // What an agent's tools.search would find
  app.get('/api/fleet/tools/search', route((req, res) => {
    const q = String(req.query.q || '').slice(0, 300);
    if (!q.trim()) return res.status(400).json({ error: 'q required' });
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));
    res.json({ query: q, results: searchSharedTools(q, limit) });
  }));

  // Phase D: runtime status — queue depth, streaming, hot-reload
  app.get('/api/fleet/runtime', route((req, res) => {
    const queue = getQueueStatus();
    const agents = listAgents(req.query.userId || 'local');
    res.json({
      streaming: true,
      parallelTools: true,
      registeredTools: fleetToolNames(),
      modelPool: modelPoolStatus(),
      hotReload: true,
      queue,
      agentCount: agents.length,
    });
  }));

  app.post('/api/fleet/reload', route((req, res) => {
    reloadManifests();
    const agents = listAgents(req.query.userId || 'local');
    res.json({ reloaded: true, agentCount: agents.length });
  }));
}
