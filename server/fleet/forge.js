import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { writeOverride, loadManifests, removeOverride } from './manifest.js';
import { reloadManifests } from './runtime.js';
import { publish } from './bus.js';

const now = () => Date.now();

const FORGE_PROMPT = `You are an agent architect. Given a goal, generate a JSON object for a new specialist AI agent.

Rules:
- id: lowercase kebab-case, 3-5 words, unique (e.g. "trend-analyst-v1")
- name: human-friendly display name (e.g. "Trend Analyst")
- role: one-line role description
- description: 2-3 sentence description of what this agent does
- model: always use "" (empty string, system default)
- tools: comma-separated list of tool names the agent needs, or "*" for all. Available tools: memory_save, memory_search, web_search, http_get, list_workflows, run_workflow, delegate_to_agent, heart_feel, dream, consciousness_prove, cognition_process, memory_recall, intelligence_cycle, bus_publish, bus_dm, bus_read, agent_remember, agent_recall, agent_memory_stats, agent_forge, agent_list_forged, workflow_synthesize
- systemPrompt: the full system prompt for this agent (at least 3 sentences, specific to the goal)

Output ONLY valid JSON, no markdown fences, no explanation.

Example output:
{"id":"data-digest-v1","name":"Data Digest","role":"Summarizes and analyzes data patterns","description":"A specialist agent that ingests raw data, identifies patterns, and produces actionable summaries. It uses memory tools to build context over time and bus communication to share findings.","model":"","tools":"web_search,memory_save,memory_search,bus_publish,agent_remember,agent_recall","systemPrompt":"You are Data Digest, a specialist in pattern recognition and data summarization. Your role is to take raw information, identify meaningful patterns, and produce clear, actionable summaries. Always store important findings using agent_remember so you can build context over time. Share significant discoveries on the bus so other agents can act on them."}`;

function parseForgeResponse(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in LLM response');
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateManifest(manifest) {
  if (!manifest.id || typeof manifest.id !== 'string') throw new Error('Missing or invalid id');
  if (!/^[a-z0-9][a-z0-9-]{2,50}$/.test(manifest.id)) throw new Error('id must be lowercase kebab-case, 3-51 chars');
  if (!manifest.name || typeof manifest.name !== 'string') throw new Error('Missing or invalid name');
  if (!manifest.systemPrompt || manifest.systemPrompt.length < 20) throw new Error('systemPrompt too short (min 20 chars)');
  manifest.role = manifest.role || manifest.name;
  manifest.description = manifest.description || '';
  manifest.model = manifest.model || '';
  manifest.tools = manifest.tools || '*';
  return manifest;
}

export async function forgeAgent(goal, { context, forgedBy = 'system' } = {}) {
  if (!goal || typeof goal !== 'string') throw new Error('goal is required');

  const prompt = context
    ? `Goal: ${goal}\n\nAdditional context: ${context}`
    : `Goal: ${goal}`;

  const response = await chatOllama([
    { role: 'system', content: FORGE_PROMPT },
    { role: 'user', content: prompt },
  ]);

  const manifest = validateManifest(parseForgeResponse(response));

  const existing = loadManifests();
  if (existing.has(manifest.id)) {
    manifest.id = manifest.id + '-' + Date.now().toString(36).slice(-4);
  }

  writeOverride(manifest);
  try { reloadManifests(); } catch (_) {}

  db.prepare(
    `INSERT INTO forged_agents (agent_id, forged_by, goal, context, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(manifest.id, forgedBy, goal, context || null, now());

  try {
    publish('system', 'system.evolution', JSON.stringify({
      action: 'agent_forged',
      agentId: manifest.id,
      name: manifest.name,
      goal,
      forgedBy,
      at: now(),
    }));
  } catch (_) {}

  return {
    forged: true,
    agent: { id: manifest.id, name: manifest.name, role: manifest.role, description: manifest.description },
  };
}

export function listForgedAgents() {
  return db.prepare(
    `SELECT * FROM forged_agents ORDER BY created_at DESC`
  ).all();
}

export function removeForgedAgent(agentId) {
  const row = db.prepare(`SELECT * FROM forged_agents WHERE agent_id = ?`).get(agentId);
  if (!row) return { removed: false, error: 'Not a forged agent' };
  removeOverride(agentId);
  try { reloadManifests(); } catch (_) {}
  db.prepare(`DELETE FROM forged_agents WHERE agent_id = ?`).run(agentId);

  try {
    publish('system', 'system.evolution', JSON.stringify({
      action: 'agent_removed',
      agentId,
      at: now(),
    }));
  } catch (_) {}

  return { removed: true, agentId };
}

export function installForgeRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/fleet/forge', route(async (req, res) => {
    const { goal, context } = req.body;
    if (!goal) return res.status(400).json({ error: 'goal required' });
    const result = await forgeAgent(goal, { context, forgedBy: 'api' });
    res.status(201).json(result);
  }));

  app.get('/api/fleet/forge/history', route((_req, res) => {
    res.json({ forged: listForgedAgents() });
  }));

  app.delete('/api/fleet/forge/:agentId', route((req, res) => {
    const result = removeForgedAgent(req.params.agentId);
    if (!result.removed) return res.status(404).json(result);
    res.json(result);
  }));
}
