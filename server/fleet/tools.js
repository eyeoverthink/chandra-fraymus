import { db } from '../db.js';
import { runPipeline } from '../workflow/engine.js';
import { heart, ledger, dreamer, cognition } from '../fraymus-tools.js';
import { FraymusStrangeLoopSubstrate, proofEffectiveInformation, proofPhiMIP, proofMirrorProtocol, proofCounterfactualBranching } from '../fraymus/intelligence/ouroboros.js';

const now = () => Date.now();
const clip = (s, n = 8000) => s.length > n ? s.slice(0, n) + '...[truncated]' : s;
const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

export function createFleetTools({ workflowStore }) {
  return [
    {
      name: 'memory_save',
      group: 'fleet',
      risk: 'safe',
      description: 'Save a durable fact or preference about the user so it is remembered in future conversations.',
      parameters: object({ text: string(2000), tags: { type: 'array', items: { type: 'string' } } }, ['text']),
      execute: async ({ args }) => {
        const text = String(args.text || '').trim().slice(0, 2000);
        if (!text) throw new Error('text required');
        db.prepare('INSERT INTO fleet_memories (user_id, agent_id, text, tags, created_at) VALUES (?, ?, ?, ?, ?)')
          .run('local', 'fleet', text, JSON.stringify(args.tags || []), now());
        return { saved: true };
      },
    },
    {
      name: 'memory_search',
      group: 'fleet',
      risk: 'safe',
      description: 'Search saved memories by keywords.',
      parameters: object({ query: string(500) }, ['query']),
      execute: async ({ args }) => {
        const words = [...new Set((String(args.query).toLowerCase().match(/[a-z0-9]{3,}/g) || []))];
        const rows = db.prepare('SELECT id, agent_id, text, tags, created_at FROM fleet_memories WHERE user_id = ? ORDER BY id DESC LIMIT 500').all('local');
        const matches = rows
          .map(r => ({ r, score: words.reduce((s, w) => s + (r.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score || b.r.id - a.r.id)
          .slice(0, 8)
          .map(x => ({ id: x.r.id, text: x.r.text, agent: x.r.agent_id }));
        return { memories: matches };
      },
    },
    {
      name: 'web_search',
      group: 'fleet',
      risk: 'safe',
      description: 'Search the web via DuckDuckGo. Returns titles, URLs and snippets.',
      parameters: object({ query: string(500) }, ['query']),
      execute: async ({ args }) => {
        try {
          const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChandraAgent/1.0)' },
            signal: AbortSignal.timeout(15_000),
          });
          const html = await r.text();
          const out = [];
          const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
          let m;
          while ((m = re.exec(html)) && out.length < 6) {
            const href = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
            const target = new URL(href).searchParams.get('uddg') || href;
            const strip = h => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
            out.push({ title: strip(m[2]), url: decodeURIComponent(target), snippet: strip(m[3]) });
          }
          return { results: out };
        } catch (e) {
          return { error: e.message };
        }
      },
    },
    {
      name: 'http_get',
      group: 'fleet',
      risk: 'approval',
      description: 'Fetch a public web page or JSON endpoint. Requires user approval.',
      parameters: object({ url: string(2000) }, ['url']),
      execute: async ({ args }) => {
        const r = await fetch(String(args.url), {
          headers: { 'User-Agent': 'ChandraAgent/1.0' },
          signal: AbortSignal.timeout(20_000),
          redirect: 'follow',
        });
        const ct = r.headers.get('content-type') || '';
        const body = await r.text();
        const text = ct.includes('html')
          ? body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
          : body;
        return { status: r.status, contentType: ct, text: clip(text) };
      },
    },
    {
      name: 'list_workflows',
      group: 'fleet',
      risk: 'safe',
      description: "List the user's saved visual workflows.",
      parameters: object({}),
      execute: async () => {
        const workflows = workflowStore.listWorkflows('local');
        return { workflows: workflows.map(w => ({ id: w.id, name: w.name, deployed: w.is_deployed, nodes: (w.nodes || []).length })) };
      },
    },
    {
      name: 'run_workflow',
      group: 'fleet',
      risk: 'approval',
      description: 'Run a saved visual workflow by ID. Requires approval.',
      parameters: object({ workflowId: string(100), prompt: string(2000) }, ['workflowId']),
      execute: async ({ args }) => {
        const wf = workflowStore.getWorkflow(String(args.workflowId));
        if (!wf) throw new Error('Workflow not found');
        const result = await runPipeline(wf.nodes, wf.edges, { prompt: args.prompt });
        workflowStore.saveRun({ workflow_id: wf.id, user_id: 'local', status: result.status, input_prompt: args.prompt, results: result.results, final_image_url: result.imageUrl, final_html: result.html, duration_ms: result.durationMs });
        return { status: result.status, imageUrl: result.imageUrl, durationMs: result.durationMs };
      },
    },
    {
      name: 'delegate_to_agent',
      group: 'fleet',
      risk: 'safe',
      description: 'Hand a self-contained task to another specialist agent and get its answer.',
      parameters: object({ agentId: string(100), task: string(4000) }, ['agentId', 'task']),
      execute: async ({ args }, ctx) => {
        if (ctx && ctx.depth >= 2) throw new Error('Delegation depth limit reached');
        if (ctx && ctx.delegate) return { answer: await ctx.delegate(String(args.agentId), String(args.task)) };
        return { error: 'Delegation not available in this context' };
      },
    },
    {
      name: 'heart_feel',
      group: 'intelligence',
      risk: 'safe',
      description: 'Analyze the emotional content of text using the Heart emotion engine. Returns primary emotion, intensity, sentiment, and normalized scores.',
      parameters: object({ text: string(4000) }, ['text']),
      execute: async ({ args }) => {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text required');
        return heart.feel(text);
      },
    },
    {
      name: 'dream',
      group: 'intelligence',
      risk: 'safe',
      description: 'Generate a signed dream through the Dreamer module. Dreams are progressive, Ed25519-signed files that capture emergent thoughts.',
      parameters: object({ seed: string(2000), kind: string(50, { default: 'agent' }) }, ['seed']),
      execute: async ({ args }) => {
        const seed = String(args.seed || '').trim();
        if (!seed) throw new Error('seed required');
        return dreamer.dream(seed, [], args.kind || 'agent');
      },
    },
    {
      name: 'consciousness_prove',
      group: 'intelligence',
      risk: 'safe',
      description: 'Run 4 mathematical consciousness proofs (EI, Phi-MIP, Mirror Protocol, Counterfactual Branching) on a FraymusStrangeLoopSubstrate.',
      parameters: object({ nodeCount: { type: 'integer', default: 4, minimum: 2, maximum: 16 } }),
      execute: async ({ args }) => {
        const n = Math.min(16, Math.max(2, parseInt(args.nodeCount) || 4));
        const substrate = new FraymusStrangeLoopSubstrate(n);
        const proofs = [
          proofEffectiveInformation(substrate),
          proofPhiMIP(substrate),
          proofMirrorProtocol(substrate),
          proofCounterfactualBranching(substrate),
        ];
        const out = { allPassed: proofs.every(p => p.passed), proofs, architecture: 'FraymusStrangeLoop' };
        ledger.record('consciousness.proof.fleet', { allPassed: out.allPassed, passed: proofs.filter(p => p.passed).length }, 'fleet');
        return out;
      },
    },
    {
      name: 'cognition_process',
      group: 'intelligence',
      risk: 'safe',
      description: 'Run text through the two-speed cognition pipeline: feel (instant emotion) → quick-route (pattern match) → think (Ollama LLM).',
      parameters: object({ text: string(4000), skipThink: { type: 'boolean', default: false } }, ['text']),
      execute: async ({ args }) => {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text required');
        return cognition.process(text, { skipThink: !!args.skipThink });
      },
    },
  ];
}
