import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { runPipeline as opegPipeline } from './opeg.js';
import { forgeAgent, checkForgeAllowed } from '../fleet/forge.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { getAdaptiveModifiers } from './adaptive-strategy.js';

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
const FORGE_STREAK_LIMIT = 3;
const ESCALATION_STREAKS = new Set([3, 10, 50, 200]);

// Absolute activity targets. Ratios against fleet size or memory count were perverse:
// every forged agent and every seeded memory grew the denominator and lowered the score.
const RUNS_PER_HOUR_FULL = 5;
const MEMORY_ACCESS_PER_HOUR_FULL = 20;
const ALERT_WINDOW_MS = 24 * 3600_000;

let emergencyStreak = 0;
let lastEmergencyScore = null;

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
    const recentRuns = db.prepare(`SELECT COUNT(*) as c FROM runs WHERE created_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.agentActivityRate = Math.min(1, recentRuns / RUNS_PER_HOUR_FULL);
    metrics.recentRuns = recentRuns;
  } catch (_) { metrics.agentActivityRate = 0; }

  try {
    const totalMemories = db.prepare(`SELECT COUNT(*) as c FROM agent_memories`).get()?.c || 0;
    const verifiedMemories = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE verified_at IS NOT NULL`).get()?.c || 0;
    const recentAccess = db.prepare(`SELECT COUNT(*) as c FROM agent_memories WHERE updated_at > ?`).get(now() - 3600_000)?.c || 0;
    metrics.memoryHealth = totalMemories > 0
      ? (verifiedMemories / totalMemories * 0.4) + (Math.min(1, recentAccess / MEMORY_ACCESS_PER_HOUR_FULL) * 0.6)
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
    const activeAlerts = db.prepare(`SELECT COUNT(*) as c FROM health_alerts WHERE resolved = 0 AND created_at > ?`).get(now() - ALERT_WINDOW_MS)?.c || 0;
    metrics.healthPenalty = Math.min(0.3, activeAlerts * 0.1);
    metrics.activeAlerts = activeAlerts;
  } catch (_) { metrics.healthPenalty = 0; }

  const contributions = {
    agentActivity: metrics.agentActivityRate * 0.30,
    memoryHealth: metrics.memoryHealth * 0.25,
    busTraffic: metrics.busTraffic * 0.25,
    workflowActivity: metrics.workflowActivity * 0.20,
    healthPenalty: -metrics.healthPenalty,
  };
  const score = Object.values(contributions).reduce((a, b) => a + b, 0);
  const diagnosis = Object.entries(contributions).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k}=${v.toFixed(3)}`);

  return { score: Math.max(0, Math.min(1, score)), metrics, contributions, diagnosis };
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
      if (emergencyStreak > FORGE_STREAK_LIMIT) {
        return { type: 'forge_suppressed', reason: 'emergency_streak', streak: emergencyStreak, diagnosis: context.diagnosis };
      }
      let goal = null;
      let lastCheck = null;
      for (const g of goals) {
        lastCheck = checkForgeAllowed(g);
        if (lastCheck.allowed) { goal = g; break; }
      }
      if (!goal) {
        return { type: 'forge_suppressed', reason: lastCheck?.reason || 'no_novel_goal', diagnosis: context.diagnosis };
      }
      const opegResult = await opegPipeline({
        type: 'forge_agent',
        hypothesis: `Connectivity below floor (${context.score.toFixed(3)} < ${CONNECTIVITY_FLOOR}). Forging specialist: ${goal}`,
        params: { goal, trigger: 'neurogenesis_emergency' },
        source: 'neurogenesis',
        executeFn: async () => {
          try {
            const result = await forgeAgent(goal, { context: `Emergency neurogenesis: connectivity ${context.score.toFixed(3)}`, forgedBy: 'neurogenesis' });
            if (!result.forged) return { ok: false, suppressed: true, reason: result.reason, goal };
            return { ok: true, agent: { id: result.agent?.id }, goal, forged: true };
          } catch (e) {
            publish('neurogenesis', 'system.evolution', JSON.stringify({ event: 'emergency_forge_failed', goal, error: e.message }));
            return { ok: false, error: e.message, goal };
          }
        },
      });
      return { type: 'forge_agent', goal, opeg: opegResult.proposalId, approved: opegResult.approved };
    }

    default:
      return { type: 'unknown' };
  }
}

async function injectCTRNNTargeted(sampleIndices) {
  let ctrnn;
  try {
    const { getCTRNN } = await import('./ctrnn-instance.js');
    ctrnn = getCTRNN();
  } catch (_) { return null; }
  if (!ctrnn || !ctrnn.running) return null;

  const gridSize = ctrnn.config?.gridSize || 16;
  const injected = [];
  for (const idx of sampleIndices.slice(0, 4)) {
    const x = idx % gridSize;
    const y = Math.floor(idx / gridSize);
    const amp = 1.5 + Math.random() * 1.5;
    ctrnn.inject(x, y, 2, amp);
    injected.push({ idx, x, y, amp: +amp.toFixed(2) });
  }
  return { type: 'ctrnn_targeted', neurons: injected.length, indices: sampleIndices.slice(0, 4) };
}

export async function neurogenesisCycle() {
  const { score, metrics, diagnosis } = measureConnectivity();
  const stimuli = [];

  // Phase 4: read consciousness gate for targeted stimulus and boost
  let gateMods = { neurogenesisBoost: 0, sampleIndices: [], tier: 'UNKNOWN' };
  try { gateMods = getAutonomyModifiers(); } catch (_) {}

  // Phase 16: adaptive strategy shifts the connectivity floor
  const adaptiveMods = getAdaptiveModifiers();
  const effectiveFloor = Math.max(0.05, Math.min(0.30, CONNECTIVITY_FLOOR + (adaptiveMods.neurogenesisFloorAdjust || 0)));

  if (score < effectiveFloor) {
    emergencyStreak++;
    const scoreMoved = lastEmergencyScore === null || Math.abs(score - lastEmergencyScore) > 0.05;
    lastEmergencyScore = score;

    stimuli.push(await injectStimulus('bus_stimulus', { score, reason: 'Below connectivity floor' }));
    // Memory seeds and forges only while the emergency is new or the score is still moving;
    // a flat streak means the stimulus isn't reaching the metric, so repeating it is waste.
    if (emergencyStreak <= FORGE_STREAK_LIMIT || scoreMoved) {
      stimuli.push(await injectStimulus('memory_seed', { score, reason: 'Emergency re-ignition' }));
    }
    stimuli.push(await injectStimulus('forge_agent', { score, reason: 'Critical connectivity drop', diagnosis }));

    if (ESCALATION_STREAKS.has(emergencyStreak)) {
      publish('neurogenesis', 'system.neurogenesis.escalation', JSON.stringify({
        streak: emergencyStreak, score, floor: effectiveFloor, diagnosis, metrics,
        message: `Connectivity has been below floor for ${emergencyStreak} consecutive cycles; stimuli are not moving the score. Weakest terms: ${diagnosis.slice(0, 2).join(', ')}`,
      }));
      console.warn(`[neurogenesis] escalation: streak=${emergencyStreak} score=${score.toFixed(3)} ${diagnosis.join(' ')}`);
    }

    // Phase 4: emergency CTRNN targeted injection near consciousness core
    if (gateMods.sampleIndices.length > 0) {
      const ctrnnResult = await injectCTRNNTargeted(gateMods.sampleIndices);
      if (ctrnnResult) stimuli.push(ctrnnResult);
    }

    const id = randomUUID().slice(0, 12);
    db.prepare(`INSERT INTO neurogenesis_events (id, trigger_type, connectivity_score, action_taken, stimulus_count, created_at) VALUES (?, 'emergency', ?, ?, ?, ?)`).run(
      id, score, JSON.stringify(stimuli), stimuli.length, now()
    );

    publish('neurogenesis', 'system.neurogenesis', JSON.stringify({
      type: 'emergency', score, stimuli: stimuli.length, metrics, diagnosis, streak: emergencyStreak,
      consciousnessTier: gateMods.tier,
    }));

    return { triggered: true, type: 'emergency', score, metrics, diagnosis, streak: emergencyStreak, stimuli, consciousnessTier: gateMods.tier };
  }

  if (emergencyStreak > 0) {
    console.log(`[neurogenesis] recovered above floor after ${emergencyStreak} emergency cycles (score=${score.toFixed(3)})`);
    emergencyStreak = 0;
    lastEmergencyScore = null;
  }

  // Phase 4: consciousness boost modulates Poisson lambda — higher consciousness = more stimulus
  const effectiveLambda = POISSON_LAMBDA * (1 - score) * (1 + gateMods.neurogenesisBoost);
  const poissonCount = poissonSample(effectiveLambda);
  const count = Math.min(poissonCount, MAX_STIMULI_PER_CYCLE);

  if (count > 0) {
    const types = ['memory_seed', 'bus_stimulus'];
    for (let i = 0; i < count; i++) {
      const type = types[Math.floor(Math.random() * types.length)];
      stimuli.push(await injectStimulus(type, { score, reason: `Poisson stimulus (λ=${effectiveLambda.toFixed(3)}, tier=${gateMods.tier})` }));
    }

    // Phase 4: if consciousness gate has core neuron indices, also inject targeted CTRNN stimulus
    if (gateMods.sampleIndices.length > 0 && gateMods.neurogenesisBoost > 0) {
      const ctrnnResult = await injectCTRNNTargeted(gateMods.sampleIndices);
      if (ctrnnResult) stimuli.push(ctrnnResult);
    }

    const id = randomUUID().slice(0, 12);
    db.prepare(`INSERT INTO neurogenesis_events (id, trigger_type, connectivity_score, action_taken, stimulus_count, created_at) VALUES (?, 'poisson', ?, ?, ?, ?)`).run(
      id, score, JSON.stringify(stimuli), stimuli.length, now()
    );
  }

  return { triggered: count > 0, type: count > 0 ? 'poisson' : 'idle', score, metrics, stimuli, consciousnessTier: gateMods.tier };
}

export function neurogenesisStats() {
  const total = db.prepare(`SELECT COUNT(*) as c FROM neurogenesis_events`).get()?.c || 0;
  const emergency = db.prepare(`SELECT COUNT(*) as c FROM neurogenesis_events WHERE trigger_type = 'emergency'`).get()?.c || 0;
  const poisson = db.prepare(`SELECT COUNT(*) as c FROM neurogenesis_events WHERE trigger_type = 'poisson'`).get()?.c || 0;
  const recent = db.prepare(`SELECT * FROM neurogenesis_events ORDER BY created_at DESC LIMIT 10`).all();
  const { score, metrics, contributions, diagnosis } = measureConnectivity();
  return { total, emergency, poisson, currentConnectivity: score, metrics, contributions, diagnosis, emergencyStreak, recent };
}

export function neurogenesisHistory({ limit = 50 } = {}) {
  return db.prepare(`SELECT * FROM neurogenesis_events ORDER BY created_at DESC LIMIT ?`).all(
    Math.min(200, Math.max(1, limit))
  );
}
