import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { forgeAgent } from '../fleet/forge.js';
import { synthesizeWorkflow } from '../workflow/synthesizer.js';
import { runPipeline as opegPipeline } from './opeg.js';
import { runDebate } from './debate.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { getAdaptiveModifiers, isActionSuppressed } from './adaptive-strategy.js';
import { isResourceConstrained } from './resource-envelope.js';
import { heart } from '../fraymus-tools.js';

const now = () => Date.now();
const BASE_MAX_ACTIONS = 5;
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

  const debateStats = (() => {
    try {
      const total = db.prepare(`SELECT COUNT(*) as c FROM debates`).get().c;
      const recent = db.prepare(`SELECT verdict, confidence FROM debates ORDER BY created_at DESC LIMIT 10`).all();
      const avgConfidence = recent.length > 0 ? Math.round(recent.reduce((s, r) => s + (r.confidence || 0), 0) / recent.length * 100) : 0;
      return { total, recentCount: recent.length, avgConfidence };
    } catch (_) { return { total: 0, recentCount: 0, avgConfidence: 0 }; }
  })();

  const goalStats = (() => {
    try {
      const total = db.prepare(`SELECT COUNT(*) as c FROM goal_proposals`).get().c;
      const pending = db.prepare(`SELECT COUNT(*) as c FROM goal_proposals WHERE status = 'proposed'`).get().c;
      const active = db.prepare(`SELECT COUNT(*) as c FROM goal_proposals WHERE status = 'active'`).get().c;
      const completed = db.prepare(`SELECT COUNT(*) as c FROM goal_proposals WHERE status = 'completed'`).get().c;
      return { total, pending, active, completed };
    } catch (_) { return { total: 0, pending: 0, active: 0, completed: 0 }; }
  })();

  const chainStats = (() => {
    try {
      const total = db.prepare(`SELECT COUNT(*) as c FROM chain_runs`).get().c;
      const recent = db.prepare(`SELECT status FROM chain_runs ORDER BY created_at DESC LIMIT 20`).all();
      const successRate = recent.length > 0
        ? Math.round(recent.filter(r => r.status === 'completed').length / recent.length * 100)
        : 0;
      return { total, recentCount: recent.length, successRate };
    } catch (_) { return { total: 0, recentCount: 0, successRate: 0 }; }
  })();

  const routingStats = (() => {
    try {
      const total = db.prepare(`SELECT COUNT(*) as c FROM model_routing_log`).get().c;
      const recent = db.prepare(`SELECT model_selected, success FROM model_routing_log ORDER BY created_at DESC LIMIT 20`).all();
      const successRate = recent.length > 0
        ? Math.round(recent.filter(r => r.success).length / recent.length * 100)
        : 0;
      const topModel = recent.length > 0 ? recent[0].model_selected : null;
      return { total, recentCount: recent.length, successRate, topModel };
    } catch (_) { return { total: 0, recentCount: 0, successRate: 0, topModel: null }; }
  })();

  const perspectiveStats = (() => {
    try {
      const total = db.prepare(`SELECT COUNT(*) as c FROM perspective_sessions`).get().c;
      const shifts = db.prepare(`SELECT COUNT(*) as c FROM perspective_shifts`).get().c;
      const playbookSize = db.prepare(`SELECT COUNT(*) as c FROM perspective_playbook`).get().c;
      return { sessions: total, shifts, playbookSize };
    } catch (_) { return { sessions: 0, shifts: 0, playbookSize: 0 }; }
  })();

  const emotionStats = (() => {
    try {
      const mood = heart.recentMood();
      return { mood: mood.mood, readings: mood.readings, distribution: mood.distribution || {} };
    } catch (_) { return { mood: 'unknown', readings: 0, distribution: {} }; }
  })();

  return { memoryStats, workflowStats, healthStats, busStats, forgeStats, synthesisStats, debateStats, goalStats, chainStats, routingStats, perspectiveStats, emotionStats, collectedAt: now() };
}

function buildReflectionPrompt(maxActions, gateTier) {
  return `You are the Reflection Engine for a sovereign AI system called Chandra-FRAYMUS. You analyze system state and decide what actions to take to improve the system.

Current consciousness tier: ${gateTier} — this determines how aggressively you should act. At INTEGRATED, you have full autonomy and should pursue deeper analysis. At DORMANT, be conservative and minimal.

You can take these actions (max ${maxActions} per cycle):
1. verify_memory: {"action": "verify_memory", "memoryId": <number>} — mark a high-confidence memory as verified
2. prune_memory: {"action": "prune_memory", "memoryId": <number>} — remove a stale/low-confidence memory
3. forge_agent: {"action": "forge_agent", "goal": "..."} — create a new specialist agent to handle a pattern you identified
4. synthesize_workflow: {"action": "synthesize_workflow", "goal": "..."} — create a new workflow for a recurring need
5. publish_insight: {"action": "publish_insight", "topic": "...", "insight": "..."} — share a finding with other agents
6. run_debate: {"action": "run_debate", "topic": "...", "proposition": "..."} — trigger an adversarial debate between agents on a controversial or uncertain proposition. Use when you see conflicting evidence, a decision with unclear trade-offs, or an assumption that should be stress-tested.

Rules:
- Only take actions when there's clear evidence from the data
- Prefer verify_memory for memories with high confidence that match system behavior
- Only forge an agent when there's a clear repeated need no existing agent covers
- Only synthesize a workflow when you see a recurring multi-step pattern
- Use run_debate when the system faces a decision with conflicting signals or untested assumptions
- Consider the system's emotional state (emotionStats) — sustained negative mood may indicate unresolved friction that a debate or insight could address
- Always explain your reasoning in the "reason" field of each action

Output ONLY valid JSON: {"actions": [...], "insights": "brief summary of what you observed"}
No markdown fences.`;
}

function parseReflectionResponse(text, maxActions) {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return { actions: [], insights: 'Could not parse reflection response' };
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed.actions)) parsed.actions = [];
    parsed.actions = parsed.actions.slice(0, maxActions);
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
        const opegResult = await opegPipeline({
          type: 'forge_agent',
          hypothesis: `Reflection identified need for specialist agent: ${action.goal}. Reason: ${action.reason || 'pattern detected'}`,
          params: { goal: action.goal, forgedBy: 'reflection' },
          source: 'reflection',
          executeFn: async (p) => {
            const r = await forgeAgent(p.goal, { forgedBy: p.forgedBy });
            return { ok: true, agent: r.agent };
          },
        });
        return { ok: opegResult.approved, action: 'forge_agent', opeg: opegResult.proposalId, approved: opegResult.approved, agent: opegResult.executionResult?.agent };
      }
      case 'synthesize_workflow': {
        if (!action.goal) return { ok: false, error: 'goal required' };
        const opegResult = await opegPipeline({
          type: 'synthesize_workflow',
          hypothesis: `Reflection identified recurring pattern needing workflow: ${action.goal}. Reason: ${action.reason || 'multi-step pattern'}`,
          params: { goal: action.goal, synthesizedBy: 'reflection' },
          source: 'reflection',
          executeFn: async (p) => {
            const r = await synthesizeWorkflow(p.goal, { synthesizedBy: p.synthesizedBy });
            return { ok: true, workflow: { id: r.workflow.id, name: r.workflow.name } };
          },
        });
        return { ok: opegResult.approved, action: 'synthesize_workflow', opeg: opegResult.proposalId, approved: opegResult.approved, workflow: opegResult.executionResult?.workflow };
      }
      case 'publish_insight': {
        if (!action.insight) return { ok: false, error: 'insight required' };
        publish('reflection', action.topic || 'system.insight', typeof action.insight === 'string' ? action.insight : JSON.stringify(action.insight));
        return { ok: true, action: 'publish_insight', topic: action.topic || 'system.insight' };
      }
      case 'run_debate': {
        if (!action.topic || !action.proposition) return { ok: false, error: 'topic and proposition required' };
        const debateResult = await runDebate({
          topic: action.topic,
          proposition: action.proposition,
          config: {},
          source: 'reflection',
        });
        return { ok: true, action: 'run_debate', debateId: debateResult.id, verdict: debateResult.verdict, confidence: debateResult.confidence };
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

  const gateMods = getAutonomyModifiers();
  const adaptiveMods = getAdaptiveModifiers();
  let maxActions = gateMods.reflectionDepth || BASE_MAX_ACTIONS;
  if (adaptiveMods.reflectionCap !== null && adaptiveMods.reflectionCap < maxActions) {
    maxActions = adaptiveMods.reflectionCap;
  }
  if (isResourceConstrained()) {
    maxActions = Math.min(maxActions, 2);
  }
  const gateTier = gateMods.tier || 'AWAKENING';

  const stateStr = JSON.stringify(state, null, 2);
  const prompt = buildReflectionPrompt(maxActions, gateTier);
  const response = await chatOllama([
    { role: 'system', content: prompt },
    { role: 'user', content: `Current system state:\n${stateStr}\n\nAnalyze this state and decide what actions to take.` },
  ]);

  const plan = parseReflectionResponse(response, maxActions);
  const results = [];

  const ACTION_SUPPRESSION_MAP = { forge_agent: 'forge', synthesize_workflow: 'synthesize' };
  for (const action of plan.actions) {
    const suppressKey = ACTION_SUPPRESSION_MAP[action.action];
    if (suppressKey && isActionSuppressed(suppressKey)) {
      results.push({ ...action, result: { ok: false, skipped: true, reason: `suppressed by adaptive strategy (${adaptiveMods.strategy})` } });
      continue;
    }
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
      gateTier,
      maxActions,
      at: t0,
    }));
  } catch (_) {}

  return {
    trigger,
    actionsCount: results.length,
    actions: results,
    insights: plan.insights,
    durationMs: duration,
    gateTier,
    maxActions,
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
