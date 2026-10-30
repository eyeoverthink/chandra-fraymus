import { startRun, listAgents } from './fleet/runtime.js';

const PIPELINE_ALIASES = {
  'content-pipeline': 'commerce',
  'content': 'commerce',
  'commerce': 'commerce',
  'apparel': 'apparel',
  'shopper': 'shopper',
  'mystery-shopper': 'shopper',
  'fixer': 'fixer',
  'store-fixer': 'fixer',
};

const PIPELINE_ENDPOINTS = {
  commerce: '/api/commerce/pipeline',
  apparel: '/api/apparel/pipeline',
  shopper: '/api/shopper/audit',
  fixer: '/api/fixer/pipeline',
};

export function installCommandRouter(app, { broadcast }) {
  app.post('/api/command', async (req, res, next) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'text is required' });
      }
      const trimmed = text.trim();

      const agentMatch = trimmed.match(/^@(\S+)\s+(.+)$/s);
      if (agentMatch) {
        const [, agentId, message] = agentMatch;
        const agents = listAgents('local');
        const agent = agents.find(a => a.id === agentId || a.name?.toLowerCase() === agentId.toLowerCase());
        if (!agent) {
          return res.json({ type: 'error', error: `Agent "${agentId}" not found`, agents: agents.map(a => a.id) });
        }
        const result = startRun('local', agent.id, message);
        broadcast('agents', { agentId: agent.id, agentName: agent.name, action: 'started', preview: message.slice(0, 100) });
        return res.json({ type: 'agent_run', runId: result.runId, threadId: result.threadId, agentId: agent.id, agentName: agent.name });
      }

      const runMatch = trimmed.match(/^run\s+(\S+)(?:\s+"([^"]+)"|\s+(.+))?$/i);
      if (runMatch) {
        const [, pipelineName, quotedArg, plainArg] = runMatch;
        const arg = quotedArg || plainArg || '';

        if (pipelineName === 'workflow') {
          const name = arg.trim();
          if (!name) return res.json({ type: 'error', error: 'Workflow name required: run workflow "name"' });
          const wfRes = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}/api/workflows`);
          const { workflows } = await wfRes.json();
          const wf = (workflows || []).find(w => w.name?.toLowerCase() === name.toLowerCase());
          if (!wf) return res.json({ type: 'error', error: `Workflow "${name}" not found` });
          const runRes = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}/api/workflows/${wf.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const result = await runRes.json();
          broadcast('event', { source: 'workflow', workflow: wf.name, action: 'started' });
          return res.json({ type: 'workflow_run', workflowId: wf.id, workflowName: wf.name, result });
        }

        const pipeline = PIPELINE_ALIASES[pipelineName.toLowerCase()];
        if (pipeline) {
          const endpoint = PIPELINE_ENDPOINTS[pipeline];
          const body = pipeline === 'commerce' ? { topic: arg }
            : pipeline === 'apparel' ? { niche: arg }
            : pipeline === 'shopper' ? { store_url: arg }
            : {};
          const pRes = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}${endpoint}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          });
          const result = await pRes.json();
          broadcast('event', { source: 'pipeline', pipeline, action: 'started', arg });
          return res.json({ type: 'pipeline_run', pipeline, runId: result.runId || result.id, result });
        }

        return res.json({ type: 'error', error: `Unknown command: "${pipelineName}". Try: content-pipeline, apparel, shopper, fixer, workflow` });
      }

      const result = startRun('local', 'fraymus_prime', trimmed);
      broadcast('agents', { agentId: 'fraymus_prime', agentName: 'Fraymus Prime', action: 'started', preview: trimmed.slice(0, 100) });
      return res.json({ type: 'agent_run', runId: result.runId, threadId: result.threadId, agentId: 'fraymus_prime', agentName: 'Fraymus Prime' });
    } catch (err) {
      next(err);
    }
  });
}
