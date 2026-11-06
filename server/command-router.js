import { startRun, listAgents } from './fleet/runtime.js';
import { guardCommandInput } from './integrity/guard-tasks.js';
import { assessSituation, arenaChallenge, setLensMode, getLensMode } from './intelligence/perspective.js';

const PIPELINE_ALIASES = {
  'content-pipeline': 'commerce',
  'content': 'commerce',
  'commerce': 'commerce',
  'apparel': 'apparel',
  'shopper': 'shopper',
  'mystery-shopper': 'shopper',
  'fixer': 'fixer',
  'store-fixer': 'fixer',
  'carbon': 'carbon',
  'carbon-x': 'carbon',
  'checkpoint': 'carbon',
  'streaming': 'streaming',
  'artifact': 'streaming',
  'mint': 'streaming',
  'living-artifact': 'streaming',
  'creation': 'creation',
  'create': 'creation',
  'brief': 'creation',
  'content-creation': 'creation',
  'distribute': 'distribution',
  'distribution': 'distribution',
  'publish': 'distribution',
  'social': 'distribution',
  'analytics': 'analytics',
  'insights': 'analytics',
  'metrics': 'analytics',
  'music': 'music',
  'soundtrack': 'music',
  'score': 'music',
  'learning-loop': 'learning-loop',
  'learning': 'learning-loop',
  'revenue': 'learning-loop',
  'attribution': 'learning-loop',
  'calendar': 'calendar',
  'schedule': 'calendar',
  'suggest': 'calendar',
  'ab-test': 'ab-testing',
  'ab': 'ab-testing',
  'experiment': 'ab-testing',
  'split-test': 'ab-testing',
  'trend': 'trend-radar',
  'trends': 'trend-radar',
  'radar': 'trend-radar',
  'trend-radar': 'trend-radar',
  'audience': 'audience',
  'segments': 'audience',
  'persona': 'audience',
  'repurpose': 'repurpose',
  'reformat': 'repurpose',
  'adapt': 'repurpose',
  'content-repurpose': 'repurpose',
  'chain': 'chain',
  'logic-chain': 'chain',
  'logic': 'chain',
  'analyze': 'chain',
  'debate': 'debate',
  'argue': 'debate',
  'adversarial': 'debate',
  'goal': 'goal',
  'goals': 'goal',
  'propose': 'goal',
  'observatory': 'observatory',
  'observe': 'observatory',
  'intel-report': 'observatory',
  'model-router': 'model-router',
  'route': 'model-router',
  'select-model': 'model-router',
  'arena': 'arena',
  'compete': 'arena',
  'challenge': 'arena',
  'swarm': 'swarm',
  'hive': 'swarm',
  'cipher': 'cipher',
  'team': 'cipher',
  'compose-team': 'cipher',
  'perspective': 'perspective',
  'workspace': 'workspace',
  'docs': 'workspace',
  'generate-docs': 'workspace',
};

const PIPELINE_ENDPOINTS = {
  commerce: '/api/commerce/pipeline',
  apparel: '/api/apparel/pipeline',
  shopper: '/api/shopper/audit',
  fixer: '/api/fixer/pipeline',
  carbon: '/api/carbon/checkpoint',
  streaming: '/api/streaming/simulate-donation',
  creation: '/api/creation/pipeline',
  distribution: '/api/distribution/publish',
  analytics: '/api/analytics/insights',
  music: '/api/media/music/pipeline',
  'learning-loop': '/api/commerce/learning/decisions',
  calendar: '/api/calendar/suggest',
  'ab-testing': '/api/ab/experiments/auto',
  'trend-radar': '/api/trends/scan',
  audience: '/api/audience/discover',
  repurpose: '/api/repurpose/suggest',
  chain: '/api/chain/run',
  debate: '/api/debates/run',
  goal: '/api/goals/generate',
  observatory: '/api/observatory',
  'model-router': '/api/model-router/select',
  arena: '/api/perspective/arena',
  swarm: '/api/swarm/initiate',
  cipher: '/api/intelligence/cipher/compose',
  perspective: '/api/perspective/assess',
  workspace: '/api/workspace/generate',
};

export function installCommandRouter(app, { broadcast }) {
  app.post('/api/command', async (req, res, next) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'text is required' });
      }
      const trimmed = text.trim();

      // Governance: Guard Tasks injection check
      const guardResult = guardCommandInput(trimmed);
      if (!guardResult.pass) {
        return res.status(403).json({ type: 'guard_rejected', error: guardResult.reason, verdict: guardResult.verdict });
      }

      // Lens mode toggle: "human mode", "machine mode", "auto mode", "think like a human/machine"
      const lensMatch = trimmed.match(/^(?:think\s+like\s+(?:a\s+)?(human|machine)|(?:(human|machine|auto)\s+mode))$/i);
      if (lensMatch) {
        const mode = (lensMatch[1] || lensMatch[2]).toLowerCase();
        const result = setLensMode(mode);
        broadcast('perspective', { type: 'lens_mode', ...result });
        return res.json({ type: 'lens_mode', ...result });
      }

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
            : pipeline === 'creation' ? { topic: arg }
            : pipeline === 'distribution' ? { content: arg, platforms: ['youtube', 'tiktok', 'instagram', 'x'] }
            : pipeline === 'analytics' ? {}
            : pipeline === 'music' ? { topic: arg }
            : pipeline === 'learning-loop' ? {}
            : pipeline === 'calendar' ? { count: 5, daysAhead: 7 }
            : pipeline === 'ab-testing' ? { topic: arg }
            : pipeline === 'trend-radar' ? { niche: arg }
            : pipeline === 'audience' ? {}
            : pipeline === 'repurpose' ? { content: arg }
            : pipeline === 'chain' ? { objective: arg }
            : pipeline === 'debate' ? { topic: arg, proposition: arg }
            : pipeline === 'goal' ? { trigger: 'command' }
            : pipeline === 'observatory' ? {}
            : pipeline === 'model-router' ? { prompt: arg, type: 'command' }
            : pipeline === 'arena' ? { task: arg, agentCount: 3 }
            : pipeline === 'swarm' ? { task: arg }
            : pipeline === 'perspective' ? { task: arg, context: 'command-router' }
            : pipeline === 'workspace' ? (arg ? { outputDir: arg } : {})
            : pipeline === 'cipher' ? { goal: arg }
            : {};
          const method = pipeline === 'observatory' ? 'GET' : 'POST';
          const fetchOpts = method === 'GET'
            ? { method: 'GET' }
            : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
          const pRes = await fetch(`http://127.0.0.1:${process.env.PORT || 8787}${endpoint}`, fetchOpts);
          const result = await pRes.json();
          broadcast('event', { source: 'pipeline', pipeline, action: 'started', arg });
          return res.json({ type: 'pipeline_run', pipeline, runId: result.runId || result.id, result });
        }

        return res.json({ type: 'error', error: `Unknown command: "${pipelineName}". Try: content-pipeline, apparel, shopper, fixer, chain, workflow` });
      }

      // Perspective-aware smart routing: consult the bartender before defaulting to fraymus_prime
      let targetAgent = 'fraymus_prime';
      let targetName = 'Fraymus Prime';
      let perspectiveHint = null;
      try {
        const assessment = await Promise.race([
          assessSituation({ task: trimmed, context: 'command-router freetext dispatch' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        perspectiveHint = assessment;
        // If playbook has a strong pattern match, check if a specific agent fits better
        if (assessment.pattern_match && assessment.confidence > 0.6) {
          const agents = listAgents('local');
          const recommended = assessment.recommended_agent;
          if (recommended) {
            const match = agents.find(a => a.id === recommended || a.name?.toLowerCase() === recommended.toLowerCase());
            if (match) { targetAgent = match.id; targetName = match.name; }
          }
        }
      } catch (_) { /* TAG-not-BLOCK: 3s timeout, proceed without framing */ }

      const result = startRun('local', targetAgent, trimmed);
      broadcast('agents', { agentId: targetAgent, agentName: targetName, action: 'started', preview: trimmed.slice(0, 100), perspectiveHint });
      return res.json({ type: 'agent_run', runId: result.runId, threadId: result.threadId, agentId: targetAgent, agentName: targetName, perspectiveHint });
    } catch (err) {
      next(err);
    }
  });
}
