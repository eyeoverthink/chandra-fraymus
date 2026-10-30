import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { forgeAgent } from '../fleet/forge.js';
import { synthesizeWorkflow } from '../workflow/synthesizer.js';

const now = () => Date.now();
const MAX_ACTIONS_PER_CYCLE = 5;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

let reflectionTimer = null;
let lastReflectionAt = 0;

function collectState() {
  const memoryStats = (() => {
    try {
      const total = db.prepare(`SELECT COUNT(*) as c FROM agent_memories`).get().c;
      const verified = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE verified_at IS NOT NULL`).get().c;
      const topCategories = db.prepare(
        `SELECT category, COUNT(*) as c FROM agent_memories GROUP BY category ORDER BY c DESC LIMIT 5`
      ).all();
      const recentHigh = db.prepare(
        `SELECT agent_id, category, key, value, confidence FROM agent_memories WHERE confidence >= 0.8 ORDER BY updated_at DESC LIMIT 10`
      ).all();
      return { total, verified, topCategories, recentHigh };
    } catch (_) { return { total: 0, verified: 0, topCategories: [], recentHigh: [] }; }
  })();

  const workflowStats = (() => {
    try {
      const totalRuns = db.prepare(`SELECT COUNT(*) as c FROM workflow_runs`).get().c;
      const recentRuns = db.prepare(
        `SELECT workflow_id, status, duration_ms FROM workflow_runs ORDER BY created_at DESC LIMIT 20`
      ).all();
      const successRate = recentRuns.length > 0
        ? recentRuns.filter(r => r.status === 'done' || r.status === 'completed').length / recentRuns.length
        : 0;
      const avgDuration = recentRuns.length > 0
        ? Math.round(recentRuns.reduce((s, r) => s + (r.duration_ms || 0), 0) / recentRuns.length)
        : 0;
      return { totalRuns, recentRunCount: recentRuns.length, successRate: Math.round(successRate * 100), avgDurationMs: avgDuration };
    } catch (_) { return { totalRuns: 0, recentRunCount: 0, successRate: 0, avgDurationMs: 0 }; }
  })();

  const healthStats = (() => {
    try {
      const latest = db.prepare(
        `SELECT metric, value FROM health_metrics WHERE collected_at > ? GROUP BY metric HAVING collected_at = MAX(collected_at)`,
      ).all(now() - 3600_000);
      const activeAlerts = db.prepare(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`).get().c;
      return { metrics: Object.fromEntries(latest.map(m => [m.metric, m.value])), activeAlerts };
    } catch (_) { return { metrics: {}, activeAlerts: 0 }; }
  })();

  const busStats = (() => {
    try {
      const totalMessages = db.prepare(`SELECT COUNT(*) as c FROM bus_messages`).get().c;
      const recentMessages = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(now() - 3600_000).c;
      const triggerFires = db.prepare(`SELECT SUM(fire_count) as c FROM bus_triggers`).get().c || 0;
      return { totalMessages, recentMessages, triggerFires };
    } catch (_) { return { totalMessages: 0, recentMessages: 0, triggerFires: 0 }; }
  })();

  const forgeStats = (() => {
    try {
      const forgedCount = db.prepare(`SELECT COUNT(*) as c FROM forged_agents`).get().c;
      return { forgedCount };
    } catch (_) { return { forgedCount: 0 }; }
  })();

  const synthesisStats = (() => {
    try {
      const synthesizedCount = db.prepare(`SELECT COUNT(*) as c FROM synthesized_workflows`).get().c;
      return { synthesizedCount };
    } catch (_) { return { synthesizedCount: 0 }; }
  })();

  return { memoryStats, workflowStats, healthStats, busStats, forgeStats, synthesisStats, collectedAt: now() };
}

const REFLECTION_PROMPT = `You are the Reflection Engine for a sovereign AI system called Chandra-FRAYMUS. You analyze system state and decide what actions to take to improve the system.

You can take these actions (max ${MAX_ACTIONS_PER_CYCLE} per cycle):
1. verify_memory: {"action": "verify_memory", "memoryId": <number>} — mark a high-confidence memory as verified
2. prune_memory: {"action": "prune_memory", "memoryId": <number>} — remove a stale/low-confidence memory
3. forge_agent: {"action": "forge_agent", "goal": "..."} — create a new specialist agent to handle a pattern you identified
4. synthesize_workflow: {"action": "synthesize_workflow", "goal": "..."} — create a new workflow for a recurring need
5. publish_insight: {"action": "publish_insight", "topic": "...", "insight": "..."} — share a finding with other agents

Rules:
- Only take actions when there's clear evidence from the data
- Prefer verify_memory for memories with high confidence that match system behavior
- Only forge an agent when there's a clear repeated need no existing agent covers
- Only synthesize a workflow when you see a recurring multi-step pattern
- Always explain your reasoning in the "reason" field of each action

Output ONLY valid JSON: {"actions": [...], "insights": "brief summary of what you observed"}
No markdown fences.`;

function parseReflectionResponse(text) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return { actions: [], insights: 'Could not parse reflection response' };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed.actions)) parsed.actions = [];
    parsed.actions = parsed.actions.slice(0, MAX_ACTIONS_PER_CYCLE);
    return parsed;
  } catch (_) {
    return { actions: [], insights: 'Failed to parse LLM response' };
  }
}

async function executeAction(action) {
  try {
    switch (action.action) {
      case 'verify_memory': {
        const id = parseInt(action.memoryId);
        if (!id) return { ok: false, error: 'invalid memoryId' };
        const info = db.prepare(`UPDATE agent_memories SET verified_at = ? WHERE id = ? AND verified_at IS NULL`).run(now(), id);
        return { ok: info.changes > 0, action: 'verify_memory', memoryId: id };
      }
      case 'prune_memory': {
        const id = parseInt(action.memoryId);
        if (!id) return { ok: false, error: 'invalid memoryId' };
        const info = db.prepare(`DELETE FROM agent_memories WHERE id = ?`).run(id);
        return { ok: info.changes > 0, action: 'prune_memory', memoryId: id };
      }
      case 'forge_agent': {
        if (!action.goal) return { ok: false, error: 'goal required' };
        const result = await forgeAgent(action.goal, { forgedBy: 'reflection' });
        return { ok: true, action: 'forge_agent', agent: result.agent };
      }
      case 'synthesize_workflow': {
        if (!action.goal) return { ok: false, error: 'goal required' };
        const result = await synthesizeWorkflow(action.goal, { synthesizedBy: 'reflection' });
        return { ok: true, action: 'synthesize_workflow', workflow: { id: result.workflow.id, name: result.workflow.name } };
      }
      case 'publish_insight': {
        if (!action.insight) return { ok: false, error: 'insight required' };
        publish('reflection', action.topic || 'system.insight', typeof action.insight === 'string' ? action.insight : JSON.stringify(action.insight));
        return { ok: true, action: 'publish_insight', topic: action.topic || 'system.insight' };
      }
      default:
        return { ok: false, error: `unknown action: ${action.action}` };
    }
  } catch (e) {
    return { ok: false, action: action.action, error: e.message };
  }
}

export async function reflect({ trigger = 'manual' } = {}) {
  const t0 = now();
  const state = collectState();

  const stateStr = JSON.stringify(state, null, 2);
  const response = await chatOllama([
    { role: 'system', content: REFLECTION_PROMPT },
    { role: 'user', content: `Current system state:\n${stateStr}\n\nAnalyze this state and decide what actions to take.` },
  ]);

  const plan = parseReflectionResponse(response);
  const results = [];

  for (const action of plan.actions) {
    const result = await executeAction(action);
    results.push({ ...action, result });
  }

  const duration = now() - t0;
  db.prepare(
    `INSERT INTO reflections (trigger, input_summary, actions_taken, insights, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(trigger, stateStr.slice(0, 5000), JSON.stringify(results), plan.insights || '', duration, t0);

  lastReflectionAt = now();

  try {
    publish('system', 'system.reflection', JSON.stringify({
      trigger,
      actionsCount: results.length,
      successful: results.filter(r => r.result?.ok).length,
      insights: plan.insights,
      durationMs: duration,
      at: t0,
    }));
  } catch (_) {}

  return {
    trigger,
    actionsCount: results.length,
    actions: results,
    insights: plan.insights,
    durationMs: duration,
  };
}

export function listReflections({ limit = 20 } = {}) {
  return db.prepare(
    `SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(100, Math.max(1, limit)));
}

export function getReflection(id) {
  return db.prepare(`SELECT * FROM reflections WHERE id = ?`).get(id);
}

function hasNewData() {
  try {
    const recent = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(lastReflectionAt || 0).c;
    const recentRuns = db.prepare(`SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ?`).get(lastReflectionAt || 0).c;
    return recent > 0 || recentRuns > 0;
  } catch (_) { return false; }
}

export function startReflectionLoop({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  stopReflectionLoop();
  reflectionTimer = setInterval(async () => {
    if (!hasNewData()) return;
    try {
      await reflect({ trigger: 'scheduled' });
    } catch (e) {
      console.error('reflection loop error:', e.message);
    }
  }, intervalMs);
  return { started: true, intervalMs };
}

export function stopReflectionLoop() {
  if (reflectionTimer) {
    clearInterval(reflectionTimer);
    reflectionTimer = null;
  }
  return { stopped: true };
}

export function installReflectionRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/intelligence/reflect', route(async (_req, res) => {
    const result = await reflect({ trigger: 'api' });
    res.json(result);
  }));

  app.get('/api/intelligence/reflections', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ reflections: listReflections({ limit }) });
  }));

  app.get('/api/intelligence/reflections/:id', route((req, res) => {
    const r = getReflection(parseInt(req.params.id));
    if (!r) return res.status(404).json({ error: 'Reflection not found' });
    r.actions_taken = JSON.parse(r.actions_taken || '[]');
    res.json(r);
  }));
}
