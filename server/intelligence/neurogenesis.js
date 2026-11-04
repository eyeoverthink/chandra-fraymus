import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { runPipeline as opegPipeline } from './opeg.js';

const now = () => Date.now();

/**
 * Autonomous Neurogenesis Engine
 *
 * Prevents the system from trending toward degenerate sparse connectivity
 * by spontaneously re-igniting dead connections when activity drops.
 *
 * Biological analogue: stem cell differentiation in response to tissue damage.
 *
 * Mechanisms:
 * 1. Connectivity monitor — tracks agent activity, memory health, bus traffic
 * 2. Poisson-distributed stimulus — probabilistic injection of new connections
 * 3. Minimum connectivity floor — hard threshold that triggers emergency re-ignition
 * 4. OPEG-gated agent forging — new agents pass through empirical grounding
 */

const CONNECTIVITY_FLOOR = 0.15;
const POISSON_LAMBDA = 0.3;
const MAX_STIMULI_PER_CYCLE = 3;

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS neurogenesis_events (
      id TEXT PRIMARY KEY,
      trigger_type TEXT NOT NULL,
      connectivity_score REAL,
      action_taken TEXT,
      stimulus_count INTEGER DEFAULT 0,
      opeg_id TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_neurogenesis_ts ON neurogenesis_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function measureConnectivity() {
  const metrics = {};

  try {
    const totalAgents = db.prepare(`SELECT COUNT(*) as c FROM agents`).get()?.c || 0;
    const recentRuns = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE created_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.agentActivityRate = totalAgents > 0 ? Math.min(1, recentRuns / totalAgents) : 0;
  } catch (_) { metrics.agentActivityRate = 0; }

  try {
    const totalMemories = db.prepare(`SELECT COUNT(*) as c FROM agent_memories`).get()?.c || 0;
    const verifiedMemories = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE verified_at IS NOT NULL`).get()?.c || 0;
    const recentAccess = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE updated_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.memoryHealth = totalMemories > 0
      ? (verifiedMemories / totalMemories * 0.4) + (Math.min(1, recentAccess / Math.max(1, totalMemories)) * 0.6)
      : 0;
  } catch (_) { metrics.memoryHealth = 0; }

  try {
    const recentBus = db.prepare(`SELECT COUNT(*) as c FROM bus_messages WHERE created_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.busTraffic = Math.min(1, recentBus / 50);
  } catch (_) { metrics.busTraffic = 0; }

  try {
    const recentWorkflows = db.prepare(`SELECT COUNT(*) as c FROM workflow_runs WHERE created_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.workflowActivity = Math.min(1, recentWorkflows / 10);
  } catch (_) { metrics.workflowActivity = 0; }

  try {
    const activeAlerts = db.prepare(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0`).get()?.c || 0;
    metrics.healthPenalty = Math.min(0.3, activeAlerts * 0.1);
  } catch (_) { metrics.healthPenalty = 0; }

  const score = (
    metrics.agentActivityRate * 0.30 +
    metrics.memoryHealth * 0.25 +
    metrics.busTraffic * 0.25 +
    metrics.workflowActivity * 0.20
  ) - metrics.healthPenalty;

  return { score: Math.max(0, Math.min(1, score)), metrics };
}

function poissonSample(lambda) {
  let L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

async function injectStimulus(type, context) {
  switch (type) {
    case 'memory_seed': {
      const categories = ['pattern', 'insight', 'hypothesis', 'dream'];
      const category = categories[Math.floor(Math.random() * categories.length)];
      const key = `neurogenesis:${now()}:${Math.random().toString(36).slice(2, 6)}`;
      const value = `Spontaneous activation: ${context.reason}. Connectivity score: ${context.score.toFixed(3)}`;
      try {
        db.prepare(
          `INSERT INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, created_at, updated_at)
           VALUES ('system', ?, ?, ?, 0.5, 'neurogenesis', 0, ?, ?)`
        ).run(category, key, value, now(), now());
      } catch (_) {}
      return { type: 'memory_seed', category, key };
    }

    case 'bus_stimulus': {
      const topics = ['system.stimulus', 'system.evolution', 'system.activity'];
      const topic = topics[Math.floor(Math.random() * topics.length)];
      publish('neurogenesis', topic, JSON.stringify({
        event: 'spontaneous_activation',
        connectivity: context.score,
        reason: context.reason,
        ts: now(),
      }));
      return { type: 'bus_stimulus', topic };
    }

    case 'forge_agent': {
      const goals = [
        'Monitor and report on system connectivity health',
        'Analyze patterns in agent memory access and suggest consolidation',
        'Bridge communication gaps between underutilized agents',
        'Synthesize cross-agent insights from recent activity',
      ];
      const goal = goals[Math.floor(Math.random() * goals.length)];
      const opegResult = await opegPipeline({
        type: 'neurogenesis',
        hypothesis: `Connectivity below floor (${context.score.toFixed(3)} < ${CONNECTIVITY_FLOOR}). Forging specialist: ${goal}`,
        params: { goal, trigger: 'neurogenesis_emergency' },
        source: 'neurogenesis',
        executeFn: async () => {
          publish('neurogenesis', 'system.evolution', JSON.stringify({
            event: 'emergency_forge_requested',
            goal,
            connectivity: context.score,
          }));
          return { ok: true, goal, requested: true };
        },
      });
      return { type: 'forge_agent', goal, opeg: opegResult.proposalId, approved: opegResult.approved };
    }

    default:
      return { type: 'unknown' };
  }
}

export async function neurogenesisCycle() {
  const { score, metrics } = measureConnectivity();
  const stimuli = [];

  if (score < CONNECTIVITY_FLOOR) {
    stimuli.push(await injectStimulus('bus_stimulus', { score, reason: 'Below connectivity floor' }));
    stimuli.push(await injectStimulus('memory_seed', { score, reason: 'Emergency re-ignition' }));
    stimuli.push(await injectStimulus('forge_agent', { score, reason: 'Critical connectivity drop' }));

    const id = randomUUID().slice(0, 12);
    db.prepare(`INSERT INTO neurogenesis_events (id, trigger_type, connectivity_score, action_taken, stimulus_count, created_at) VALUES (?, 'emergency', ?, ?, ?, ?)`).run(
      id, score, JSON.stringify(stimuli), stimuli.length, now()
    );

    publish('neurogenesis', 'system.neurogenesis', JSON.stringify({
      type: 'emergency', score, stimuli: stimuli.length, metrics,
    }));

    return { triggered: true, type: 'emergency', score, metrics, stimuli };
  }

  const poissonCount = poissonSample(POISSON_LAMBDA * (1 - score));
  const count = Math.min(poissonCount, MAX_STIMULI_PER_CYCLE);

  if (count > 0) {
    const types = ['memory_seed', 'bus_stimulus'];
    for (let i = 0; i < count; i++) {
      const type = types[Math.floor(Math.random() * types.length)];
      stimuli.push(await injectStimulus(type, { score, reason: `Poisson stimulus (λ=${(POISSON_LAMBDA * (1 - score)).toFixed(3)})` }));
    }

    const id = randomUUID().slice(0, 12);
    db.prepare(`INSERT INTO neurogenesis_events (id, trigger_type, connectivity_score, action_taken, stimulus_count, created_at) VALUES (?, 'poisson', ?, ?, ?, ?)`).run(
      id, score, JSON.stringify(stimuli), stimuli.length, now()
    );
  }

  return { triggered: count > 0, type: count > 0 ? 'poisson' : 'idle', score, metrics, stimuli };
}

export function neurogenesisStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM neurogenesis_events`).get()?.c || 0;
  const emergency = db.prepare(`SELECT COUNT(*) as c FROM neurogenesis_events WHERE trigger_type = 'emergency'`).get()?.c || 0;
  const poisson = db.prepare(`SELECT COUNT(*) as c FROM neurogenesis_events WHERE trigger_type = 'poisson'`).get()?.c || 0;
  const recent = db.prepare(`SELECT * FROM neurogenesis_events ORDER BY created_at DESC LIMIT 10`).all();
  const { score, metrics } = measureConnectivity();
  return { total, emergency, poisson, currentConnectivity: score, metrics, recent };
}

export function neurogenesisHistory({ limit = 50 } = {}) {
  return db.prepare(`SELECT * FROM neurogenesis_events ORDER BY created_at DESC LIMIT ?`).all(
    Math.min(200, Math.max(1, limit))
  );
}
