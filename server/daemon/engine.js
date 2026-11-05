import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { loadManifests, writeOverride } from '../fleet/manifest.js';
import { reloadManifests } from '../fleet/runtime.js';
import { reflect } from '../intelligence/reflection.js';
import { generateGoals } from '../intelligence/goal-engine.js';
import { runCycle as runOuroborosCycle } from '../intelligence/ouroboros-cycle.js';
import { snapshotState, pruneFossils } from '../intelligence/state-bridge.js';
import { runConsciousnessAudit } from '../intelligence/consciousness-cycle.js';
import { getConsciousnessState, getAutonomyModifiers } from '../intelligence/consciousness-gate.js';
import { startSensoryBridge, stopSensoryBridge, getSensoryStatus, setSensoryHeart } from '../intelligence/sensory-bridge.js';
import { startEmotionalFeedback, stopEmotionalFeedback, getEmotionalFeedbackStatus, setEmotionalHeart } from '../intelligence/emotional-feedback.js';
import { heart } from '../fraymus-tools.js';

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

Given recent events (agent runs, bus messages, workflow executions, health alerts, perspective shifts, emotional state), produce a brief consolidated summary. Focus on:
1. Patterns — what happened repeatedly?
2. Outcomes — what succeeded, what failed, and why?
3. Learnings — what should be remembered for next time?
4. Perspective patterns — which cognitive framings/approaches worked for which situations?
5. Emotional context — how does the system's emotional state relate to what happened? Does sustained negative mood correlate with specific failures?

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

  const recentChains = (() => {
    try {
      return db.prepare(
        `SELECT id, objective, status, stop_reason FROM chain_runs WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentDebates = (() => {
    try {
      return db.prepare(
        `SELECT id, topic, proposition, verdict, confidence, duration_ms FROM debates WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentGoals = (() => {
    try {
      return db.prepare(
        `SELECT id, objective, priority, status, source FROM goal_proposals WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentRouting = (() => {
    try {
      return db.prepare(
        `SELECT task_type, complexity, model_selected, model_tier, success FROM model_routing_log WHERE created_at > ? ORDER BY created_at DESC LIMIT 15`
      ).all(oneHourAgo);
    } catch (_) { return []; }
  })();

  const recentPerspectives = (() => {
    try {
      const sessions = db.prepare(
        `SELECT id, task, pattern_match, confidence FROM perspective_sessions WHERE created_at > ? ORDER BY created_at DESC LIMIT 10`
      ).all(oneHourAgo);
      const shifts = db.prepare(
        `SELECT session_id, from_perspective, to_perspective, reason FROM perspective_shifts WHERE created_at > ? ORDER BY created_at DESC LIMIT 15`
      ).all(oneHourAgo);
      const playbook = db.prepare(
        `SELECT pattern, perspective, success_rate, uses FROM perspective_playbook ORDER BY updated_at DESC LIMIT 10`
      ).all();
      return { sessions, shifts, playbook };
    } catch (_) { return { sessions: [], shifts: [], playbook: [] }; }
  })();

  const emotionalState = (() => {
    try {
      const mood = heart.recentMood();
      return { mood: mood.mood, readings: mood.readings, distribution: mood.distribution || {} };
    } catch (_) { return { mood: 'unknown', readings: 0, distribution: {} }; }
  })();

  const activityCount = recentBus.length + recentRuns.length + recentAlerts.length + recentVerifications.length + recentChains.length + recentDebates.length + recentGoals.length + recentRouting.length + recentPerspectives.sessions.length + recentPerspectives.shifts.length;
  if (activityCount === 0) return { consolidated: false, reason: 'no_recent_activity' };

  const input = JSON.stringify({
    emotionalState,
    busMessages: recentBus.slice(0, 20).map(m => ({ from: m.from_agent, topic: m.topic, payload: m.payload?.slice(0, 200) })),
    workflowRuns: recentRuns.map(r => ({ id: r.workflow_id, status: r.status, durationMs: r.duration_ms })),
    healthAlerts: recentAlerts.map(a => ({ rule: a.rule, severity: a.severity, message: a.message })),
    verifications: recentVerifications.map(v => ({ goal: v.goal?.slice(0, 100), status: v.status, iterations: v.iterations_used })),
    chainRuns: recentChains.map(c => ({ id: c.id, objective: c.objective?.slice(0, 200), status: c.status, stopReason: c.stop_reason })),
    debates: recentDebates.map(d => ({ id: d.id, topic: d.topic?.slice(0, 150), verdict: d.verdict, confidence: d.confidence, durationMs: d.duration_ms })),
    goals: recentGoals.map(g => ({ id: g.id, objective: g.objective?.slice(0, 150), priority: g.priority, status: g.status, source: g.source })),
    modelRouting: recentRouting.map(r => ({ taskType: r.task_type, complexity: r.complexity, model: r.model_selected, tier: r.model_tier, success: r.success })),
    perspectiveSessions: recentPerspectives.sessions.map(s => ({ id: s.id, task: s.task?.slice(0, 150), pattern: s.pattern_match, confidence: s.confidence })),
    perspectiveShifts: recentPerspectives.shifts.map(s => ({ session: s.session_id, from: s.from_perspective, to: s.to_perspective, reason: s.reason?.slice(0, 100) })),
    perspectivePlaybook: recentPerspectives.playbook.map(p => ({ pattern: p.pattern, perspective: p.perspective, successRate: p.success_rate, uses: p.uses })),
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

  // Refine perspective playbook from dream insights
  const perspectiveInsights = (parsed.patterns || []).concat(parsed.learnings || [])
    .filter(item => typeof item === 'string' && /perspective|framing|lens|approach/i.test(item));
  for (const insight of perspectiveInsights.slice(0, 3)) {
    try {
      db.prepare(
        `INSERT OR REPLACE INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, created_at, updated_at) VALUES ('system', 'perspective_dream', ?, ?, 0.75, 'daemon-perspective', 0, ?, ?)`
      ).run(`pdream:${now()}:${Math.random().toString(36).slice(2, 6)}`, String(insight).slice(0, 4000), now(), now());
    } catch (_) {}
  }

  return { consolidated: true, activityCount, patterns: parsed.patterns?.length || 0, learnings: parsed.learnings?.length || 0, perspectiveInsights: perspectiveInsights.length, summary: parsed.summary };
}

// ─── Chain Findings Consolidation ────────────────────────────
// Reads completed chain runs, extracts verified findings as system memories

async function consolidateChainFindings() {
  const oneDayAgo = now() - 86400_000;

  const completedChains = (() => {
    try {
      return db.prepare(
        `SELECT id, objective, ledger, review FROM chain_runs WHERE status = 'completed' AND created_at > ? ORDER BY created_at DESC LIMIT 5`
      ).all(oneDayAgo);
    } catch (_) { return []; }
  })();

  if (completedChains.length === 0) return { consolidated: false, reason: 'no_recent_chains' };

  let stored = 0;
  for (const row of completedChains) {
    let ledger, review;
    try { ledger = JSON.parse(row.ledger || '{}'); } catch { continue; }
    try { review = JSON.parse(row.review || 'null'); } catch { review = null; }

    if (!review?.stats?.verified) continue;

    const fields = ['new_logic', 'improved_logic', 'implementation_steps', 'test_cases', 'contradictions', 'unsupported_claims'];
    for (const field of fields) {
      const entries = ledger[field] || [];
      for (const e of entries.filter(x => x.verified)) {
        const key = `chain:${row.id}:${field}:${String(e.text).slice(0, 60)}`;
        try {
          const exists = db.prepare(`SELECT 1 FROM agent_memories WHERE agent_id = 'system' AND key = ?`).get(key);
          if (exists) continue;
          db.prepare(
            `INSERT INTO agent_memories (agent_id, category, key, value, confidence, source, access_count, created_at, updated_at) VALUES ('system', 'chain_verified', ?, ?, 0.9, 'daemon-chain', 0, ?, ?)`
          ).run(key, JSON.stringify({ objective: row.objective, field, text: e.text, stage: e.stage }), now(), now());
          stored++;
        } catch (_) {}
      }
    }
  }

  return { consolidated: stored > 0, chainsProcessed: completedChains.length, findingsStored: stored };
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

  const chainVerified = (() => {
    try {
      return db.prepare(
        `SELECT id, agent_id, key, value, confidence FROM agent_memories WHERE category = 'chain_verified' AND confidence >= 0.9 ORDER BY updated_at DESC LIMIT 10`
      ).all();
    } catch (_) { return []; }
  })();

  const allFossils = [...fossils, ...recentFossils];
  const uniqueFossils = [...new Map(allFossils.map(f => [f.id, f])).values()];

  if (uniqueFossils.length === 0 && chainVerified.length === 0) return { evolved: false, reason: 'no_fossils_or_chain_findings' };

  const patterns = [];
  for (const fossil of uniqueFossils) {
    try {
      const data = JSON.parse(fossil.value);
      if (data.goal && data.code) {
        patterns.push({ goal: data.goal.slice(0, 200), language: data.language, iterations: data.iterations });
      }
    } catch (_) {}
  }

  for (const cv of chainVerified.slice(0, 5)) {
    try {
      const data = JSON.parse(cv.value);
      if (data.objective && data.text) {
        patterns.push({ goal: `Chain insight (${data.field}): ${data.text.slice(0, 150)}`, language: 'analysis', iterations: 1 });
      }
    } catch (_) {}
  }

  if (patterns.length === 0) return { evolved: false, reason: 'no_parseable_fossils' };

  // Inject proven patterns into ALL agents — verified fossils and chain insights are general knowledge
  const manifests = loadManifests();
  let evolvedCount = 0;

  for (const [agentId, manifest] of manifests) {

    // Check if this agent already has the fossil context
    const promptLower = (manifest.systemPrompt || '').toLowerCase();
    if (promptLower.includes('[proven patterns]')) continue; // already evolved

    const gateMods = getAutonomyModifiers();
    const patternLimit = Math.round(3 * gateMods.evolutionRate);
    const patternBlock = patterns.slice(0, Math.max(1, patternLimit)).map(p =>
      `- Verified: "${p.goal}" (${p.language}, ${p.iterations} iteration${p.iterations === 1 ? '' : 's'})`
    ).join('\n');

    let perspectivePlaybookBlock = '';
    try {
      const topPlaybook = db.prepare(
        `SELECT pattern, perspective, success_rate FROM perspective_playbook WHERE uses > 0 ORDER BY success_rate DESC LIMIT 3`
      ).all();
      if (topPlaybook.length > 0) {
        perspectivePlaybookBlock = `\n\n[Perspective Playbook — injected by daemon at ${new Date().toISOString()}]\n` +
          topPlaybook.map(p => `- "${p.perspective}" approach works ${Math.round(p.success_rate * 100)}% for "${p.pattern}" tasks`).join('\n');
      }
    } catch (_) {}

    const evolvedPrompt = manifest.systemPrompt + `\n\n[Proven Patterns — injected by daemon at ${new Date().toISOString()}]\n${patternBlock}` + perspectivePlaybookBlock;

    writeOverride({ ...manifest, systemPrompt: evolvedPrompt });
    evolvedCount++;
  }

  if (evolvedCount > 0) {
    try { reloadManifests(); } catch (_) {}
  }

  db.prepare(
    `INSERT INTO daemon_cycles (id, type, input_summary, output, created_at) VALUES (?, 'prompt_evolution', ?, ?, ?)`
  ).run(randomUUID().slice(0, 12), `${uniqueFossils.length} fossils, ${patterns.length} patterns, tier=${gateMods.tier}`, `evolved ${evolvedCount} agents (rate=${gateMods.evolutionRate})`, now());

  return { evolved: evolvedCount > 0, fossilCount: uniqueFossils.length, patternCount: patterns.length, agentsEvolved: evolvedCount, gateTier: gateMods.tier, evolutionRate: gateMods.evolutionRate };
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

    // Step 3: Chain findings consolidation
    try {
      stepResults.chainConsolidation = await consolidateChainFindings();
    } catch (e) {
      stepResults.chainConsolidation = { error: e.message };
    }

    // Step 4: Reflection (only if there's new data)
    try {
      stepResults.reflection = await reflect({ trigger: `daemon:${trigger}` });
    } catch (e) {
      stepResults.reflection = { error: e.message };
    }

    // Step 5: Goal generation (proposes new chain objectives from knowledge gaps)
    try {
      stepResults.goalGeneration = await generateGoals({ trigger: `daemon:${trigger}` });
    } catch (e) {
      stepResults.goalGeneration = { error: e.message };
    }

    // Step 6: Ouroboros RSI cycle (autonomous codebase evolution)
    try {
      stepResults.ouroboros = await runOuroborosCycle();
    } catch (e) {
      stepResults.ouroboros = { error: e.message };
    }

    // Step 7: CTRNN Consciousness Audit — run 4 mathematical proofs against live neural core
    try {
      stepResults.consciousness = runConsciousnessAudit({ trigger: `daemon:${trigger}` });
    } catch (e) {
      stepResults.consciousness = { error: e.message };
    }

    // Step 7.5: Consciousness Gate — read tier and modifiers for downstream behavior
    try {
      const gateState = getConsciousnessState();
      const gateMods = getAutonomyModifiers();
      stepResults.consciousnessGate = {
        tier: gateMods.tier,
        tierLevel: gateMods.tierLevel,
        proven: gateState.proven,
        stale: gateState.stale ?? true,
        cycleMultiplier: gateMods.cycleMultiplier,
        reflectionDepth: gateMods.reflectionDepth,
        neurogenesisBoost: gateMods.neurogenesisBoost,
        evolutionRate: gateMods.evolutionRate,
        phi: gateState.phi || 0,
      };
    } catch (e) {
      stepResults.consciousnessGate = { error: e.message };
    }

    // Step 8: State Bridge — fossilize dynamic state into semantic memory
    try {
      stepResults.stateBridge = await snapshotState();
    } catch (e) {
      stepResults.stateBridge = { error: e.message };
    }

    // Step 9: Prune old fossils beyond retention window
    try {
      stepResults.fossilPrune = pruneFossils();
    } catch (e) {
      stepResults.fossilPrune = { error: e.message };
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
        chainFindings: stepResults.chainConsolidation?.findingsStored ?? 0,
        evolved: stepResults.promptEvolution?.evolved ?? false,
        reflectionActions: stepResults.reflection?.actionsCount ?? 0,
        goalsGenerated: stepResults.goalGeneration?.count ?? 0,
        perspectiveInsights: stepResults.consolidation?.perspectiveInsights ?? 0,
        ouroborosGeneration: stepResults.ouroboros?.generation ?? null,
        ouroborosAccepted: stepResults.ouroboros?.accepted ?? 0,
        consciousnessVerdict: stepResults.consciousness?.verdict ?? null,
        consciousnessProofsPassed: stepResults.consciousness?.proofsPassed ?? 0,
        consciousnessTier: stepResults.consciousnessGate?.tier ?? null,
        consciousnessPhi: stepResults.consciousnessGate?.phi ?? 0,
        effectiveCycleMs: daemonState.effectiveCycleMs ?? daemonState.cycleMs,
        cycleMultiplier: stepResults.consciousnessGate?.cycleMultiplier ?? 1.0,
        stateFossilized: stepResults.stateBridge?.stored ?? false,
        fossilsPruned: stepResults.fossilPrune?.fossilsPruned ?? 0,
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
  const baseCycleMs = Math.max(MIN_CYCLE_MS, cycleMs);
  daemonState = {
    running: true,
    cycleMs: baseCycleMs,
    baseCycleMs,
    effectiveCycleMs: baseCycleMs,
    lastCycleAt: 0,
    nextCycleAt: now() + baseCycleMs,
    cyclesRun: 0,
    startedAt: now(),
    lastGateTier: null,
  };

  // Phase 8: Start sensory bridge (continuous CTRNN stimulus from system state)
  try {
    setSensoryHeart(heart);
    startSensoryBridge();
  } catch (e) {
    console.error('sensory bridge start error:', e.message);
  }

  // Phase 9: Start emotional feedback (Heart mood → CTRNN plasticity modulation)
  try {
    setEmotionalHeart(heart);
    startEmotionalFeedback();
  } catch (e) {
    console.error('emotional feedback start error:', e.message);
  }

  function scheduleNext() {
    if (!daemonState.running) return;
    const mods = getAutonomyModifiers();
    const effective = Math.max(MIN_CYCLE_MS, Math.round(baseCycleMs * mods.cycleMultiplier));
    daemonState.effectiveCycleMs = effective;
    daemonState.nextCycleAt = now() + effective;
    daemonState.lastGateTier = mods.tier;

    daemonTimer = setTimeout(async () => {
      try {
        await runCycle({ trigger: 'scheduled' });
      } catch (e) {
        console.error('daemon cycle error:', e.message);
      }
      scheduleNext();
    }, effective);
  }

  scheduleNext();
  return { started: true, baseCycleMs, effectiveCycleMs: daemonState.effectiveCycleMs, tier: daemonState.lastGateTier };
}

export function stopDaemon() {
  if (daemonTimer) {
    clearTimeout(daemonTimer);
    daemonTimer = null;
  }
  // Phase 8: Stop sensory bridge with daemon
  try { stopSensoryBridge(); } catch (_) {}
  // Phase 9: Stop emotional feedback with daemon (restores baseline plasticity)
  try { stopEmotionalFeedback(); } catch (_) {}
  daemonState.running = false;
  daemonState.nextCycleAt = 0;
  return { stopped: true };
}

export function getDaemonStatus() {
  const gateMods = getAutonomyModifiers();
  return {
    ...daemonState,
    consciousnessGate: {
      tier: gateMods.tier,
      cycleMultiplier: gateMods.cycleMultiplier,
      reflectionDepth: gateMods.reflectionDepth,
      evolutionRate: gateMods.evolutionRate,
      neurogenesisBoost: gateMods.neurogenesisBoost,
      proofsPassed: gateMods.proofsPassed,
      stale: gateMods.stale,
    },
    sensoryBridge: getSensoryStatus(),
    emotionalFeedback: getEmotionalFeedbackStatus(),
  };
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
