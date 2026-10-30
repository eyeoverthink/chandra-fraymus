import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { loadManifests, writeOverride } from '../fleet/manifest.js';
import { reloadManifests } from '../fleet/runtime.js';
import { reflect } from '../intelligence/reflection.js';

const now = () => Date.now();
const DEFAULT_CYCLE_MS = 30 * 60 * 1000;
const MIN_CYCLE_MS = 60_000;

let daemonTimer = null;
let daemonState = {
  running: false,
  cycleMs: DEFAULT_CYCLE_MS,
  lastCycleAt: 0,
  nextCycleAt: 0,
  cyclesRun: 0,
  startedAt: 0,
};

// ─── Dream Consolidation ──────────────────────────────────────
// Reads recent events/messages, summarizes them into compressed context

const CONSOLIDATION_PROMPT = `You are a Dream Consolidator for a sovereign AI system. Your job is to compress recent system activity into a concise knowledge summary that agents can use as context.

Given recent events (agent runs, bus messages, workflow executions, health alerts), produce a brief consolidated summary. Focus on:
1. Patterns — what happened repeatedly?
2. Outcomes — what succeeded, what failed, and why?
3. Learnings — what should be remembered for next time?

Output JSON only, no markdown fences:
{"patterns": ["..."], "outcomes": ["..."], "learnings": ["..."], "summary": "one paragraph compressed context"}`;

async function consolidateDreams() {
  const oneHourAgo = now() - 3600_000;

  const recentBus = (() => {
    try {
      return db.prepare(
        `SELECT from_agent, topic, payload FROM bus_messages WHERE created_at > ? ORDER BY created_at DESC LIMIT 50`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentRuns = (() => {
    try {
      return db.prepare(
        `SELECT workflow_id, status, duration_ms FROM workflow_runs WHERE created_at > ? ORDER BY created_at DESC LIMIT 20`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentAlerts = (() => {
    try {
      return db.prepare(
        `SELECT rule, severity, message FROM health_alerts WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentVerifications = (() => {
    try {
      return db.prepare(
        `SELECT goal, status, iterations_used FROM verification_loops WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const activityCount = recentBus.length + recentRuns.length + recentAlerts.length + recentVerifications.length;
  if (activityCount === 0) return { consolidated: false, reason: 'no_recent_activity' };

  const input = JSON.stringify({
    busMessages: recentBus.slice(0, 20).map(m => ({ from: m.from_agent, topic: m.topic, payload: m.payload?.slice(0, 200) })),
    workflowRuns: recentRuns.map(r => ({ id: r.workflow_id, status: r.status, durationMs: r.duration_ms })),
    healthAlerts: recentAlerts.map(a => ({ rule: a.rule, severity: a.severity, message: a.message })),
    verifications: recentVerifications.map(v => ({ goal: v.goal?.slice(0, 100), status: v.status, iterations: v.iterations_used })),
  }, null, 2);

  const response = await chatOllama([
    { role: 'system', content: CONSOLIDATION_PROMPT },
    { role: 'user', content: `Recent system activity (last hour):\n${input}` },
  ]);

  const parsed = parseJSON(response, { patterns: [], outcomes: [], learnings: [], summary: 'Consolidation parse error' });

  db.prepare(
    `INSERT INTO daemon_cycles (id, type, input_summary, output, created_at) VALUES (?, 'consolidation', ?, ?, ?)`
  ).run(randomUUID().slice(0, 12), input.slice(0, 4000), JSON.stringify(parsed).slice(0, 8000), now());

  // Store consolidated learnings as system memories
  for (const learning of (parsed.learnings || []).slice(0, 5)) {
    try {
      db.prepare(
        `INSERT OR REPLACE INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, created_at, updated_at) VALUES ('system', 'dream', ?, ?, 0.7, 'daemon-consolidation', 0, ?, ?)`
      ).run(`dream:${now()}:${Math.random().toString(36).slice(2, 6)}`, String(learning).slice(0, 4000), now(), now());
    } catch (_) {}
  }

  return { consolidated: true, activityCount, patterns: parsed.patterns?.length || 0, learnings: parsed.learnings?.length || 0, summary: parsed.summary };
}

// ─── Prompt Evolution ─────────────────────────────────────────
// Reads verified fossils and injects proven patterns into agent prompts

async function evolvePrompts() {
  // Find verified fossils not yet applied
  const fossils = (() => {
    try {
      return db.prepare(
        `SELECT id, agent_id, key, value, confidence FROM agent_memories WHERE category = 'fossil' AND confidence >= 1.0 AND verified_at IS NOT NULL ORDER BY updated_at DESC LIMIT 10`
      ).all();
    } catch (_) { return []; }
  })();

  // Also include unverified fossils with high confidence from verifier-loop
  const recentFossils = (() => {
    try {
      return db.prepare(
        `SELECT id, agent_id, key, value, confidence FROM agent_memories WHERE category = 'fossil' AND source = 'verifier-loop' AND confidence >= 1.0 ORDER BY updated_at DESC LIMIT 10`
      ).all();
    } catch (_) { return []; }
  })();

  const allFossils = [...fossils, ...recentFossils];
  const uniqueFossils = [...new Map(allFossils.map(f => [f.id, f])).values()];

  if (uniqueFossils.length === 0) return { evolved: false, reason: 'no_fossils' };

  // Parse fossil data to extract proven patterns
  const patterns = [];
  for (const fossil of uniqueFossils) {
    try {
      const data = JSON.parse(fossil.value);
      if (data.goal && data.code) {
        patterns.push({ goal: data.goal.slice(0, 200), language: data.language, iterations: data.iterations });
      }
    } catch (_) {}
  }

  if (patterns.length === 0) return { evolved: false, reason: 'no_parseable_fossils' };

  // Check which agents have the forge/verify tools — they benefit from knowing proven patterns
  const manifests = loadManifests();
  let evolvedCount = 0;

  for (const [agentId, manifest] of manifests) {
    if (manifest.source !== 'override') continue; // only evolve forged agents, not defaults
    const hasEvolutionTools = manifest.tools === '*' || (Array.isArray(manifest.tools) && manifest.tools.some(t => ['verify_loop', 'agent_forge', 'workflow_synthesize'].includes(t)));
    if (!hasEvolutionTools) continue;

    // Check if this agent already has the fossil context
    const promptLower = (manifest.systemPrompt || '').toLowerCase();
    if (promptLower.includes('[proven patterns]')) continue; // already evolved

    const patternBlock = patterns.slice(0, 3).map(p =>
      `- Verified: "${p.goal}" (${p.language}, ${p.iterations} iteration${p.iterations === 1 ? '' : 's'})`
    ).join('\n');

    const evolvedPrompt = manifest.systemPrompt + `\n\n[Proven Patterns — injected by daemon at ${new Date().toISOString()}]\n${patternBlock}`;

    writeOverride({ ...manifest, systemPrompt: evolvedPrompt });
    evolvedCount++;
  }

  if (evolvedCount > 0) {
    try { reloadManifests(); } catch (_) {}
  }

  db.prepare(
    `INSERT INTO daemon_cycles (id, type, input_summary, output, created_at) VALUES (?, 'prompt_evolution', ?, ?, ?)`
  ).run(randomUUID().slice(0, 12), `${uniqueFossils.length} fossils, ${patterns.length} patterns`, `evolved ${evolvedCount} agents`, now());

  return { evolved: evolvedCount > 0, fossilCount: uniqueFossils.length, patternCount: patterns.length, agentsEvolved: evolvedCount };
}

// ─── Daemon Cycle ─────────────────────────────────────────────

async function runCycle({ trigger = 'scheduled' } = {}) {
  const cycleId = randomUUID().slice(0, 12);
  const t0 = now();
  const stepResults = {};

  try {
    // Step 1: Dream consolidation
    try {
      stepResults.consolidation = await consolidateDreams();
    } catch (e) {
      stepResults.consolidation = { error: e.message };
    }

    // Step 2: Prompt evolution
    try {
      stepResults.promptEvolution = await evolvePrompts();
    } catch (e) {
      stepResults.promptEvolution = { error: e.message };
    }

    // Step 3: Reflection (only if there's new data)
    try {
      stepResults.reflection = await reflect({ trigger: `daemon:${trigger}` });
    } catch (e) {
      stepResults.reflection = { error: e.message };
    }

    const duration = now() - t0;

    db.prepare(
      `INSERT INTO daemon_cycles (id, type, input_summary, output, duration_ms, created_at) VALUES (?, 'full_cycle', ?, ?, ?, ?)`
    ).run(cycleId, trigger, JSON.stringify(stepResults).slice(0, 8000), duration, t0);

    daemonState.lastCycleAt = now();
    daemonState.cyclesRun++;

    try {
      publish('system', 'system.daemon', JSON.stringify({
        action: 'cycle_complete', cycleId, trigger,
        consolidation: stepResults.consolidation?.consolidated ?? false,
        evolved: stepResults.promptEvolution?.evolved ?? false,
        reflectionActions: stepResults.reflection?.actionsCount ?? 0,
        durationMs: duration, at: t0,
      }));
    } catch (_) {}

    return { cycleId, trigger, steps: stepResults, durationMs: duration };
  } catch (err) {
    db.prepare(
      `INSERT INTO daemon_cycles (id, type, input_summary, output, duration_ms, created_at) VALUES (?, 'full_cycle', ?, ?, ?, ?)`
    ).run(cycleId, `error:${trigger}`, err.message, 0, t0);
    throw err;
  }
}

// ─── Daemon Control ───────────────────────────────────────────

export function startDaemon({ cycleMs = DEFAULT_CYCLE_MS } = {}) {
  stopDaemon();
  const interval = Math.max(MIN_CYCLE_MS, cycleMs);
  daemonState = {
    running: true,
    cycleMs: interval,
    lastCycleAt: 0,
    nextCycleAt: now() + interval,
    cyclesRun: 0,
    startedAt: now(),
  };

  daemonTimer = setInterval(async () => {
    daemonState.nextCycleAt = now() + interval;
    try {
      await runCycle({ trigger: 'scheduled' });
    } catch (e) {
      console.error('daemon cycle error:', e.message);
    }
  }, interval);

  return { started: true, intervalMs: interval };
}

export function stopDaemon() {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = null;
  }
  daemonState.running = false;
  daemonState.nextCycleAt = 0;
  return { stopped: true };
}

export function getDaemonStatus() {
  return { ...daemonState };
}

export function listCycles({ limit = 20 } = {}) {
  return db.prepare(
    `SELECT id, type, input_summary, output, duration_ms, created_at FROM daemon_cycles ORDER BY created_at DESC LIMIT ?`
  ).all(Math.min(100, Math.max(1, limit)));
}

export { runCycle, consolidateDreams, evolvePrompts };

// ─── Routes ───────────────────────────────────────────────────

export function installDaemonRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.post('/api/daemon/start', route((req, res) => {
    const cycleMs = parseInt(req.body?.cycleMs) || DEFAULT_CYCLE_MS;
    const result = startDaemon({ cycleMs });
    res.json(result);
  }));

  app.post('/api/daemon/stop', route((_req, res) => {
    res.json(stopDaemon());
  }));

  app.get('/api/daemon/status', route((_req, res) => {
    res.json(getDaemonStatus());
  }));

  app.post('/api/daemon/cycle', route(async (_req, res) => {
    const result = await runCycle({ trigger: 'api' });
    res.json(result);
  }));

  app.get('/api/daemon/cycles', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    res.json({ cycles: listCycles({ limit }) });
  }));

  app.post('/api/daemon/consolidate', route(async (_req, res) => {
    const result = await consolidateDreams();
    res.json(result);
  }));

  app.post('/api/daemon/evolve', route(async (_req, res) => {
    const result = await evolvePrompts();
    res.json(result);
  }));
}

function parseJSON(text, fallback) {
  try {
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return fallback; }
}
