import { db } from '../db.js';
import { randomUUID } from 'node:crypto';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';
import { loadManifests, writeOverride } from '../fleet/manifest.js';
import { reloadManifests } from '../fleet/runtime.js';
import { reflect } from '../intelligence/reflection.js';
import { generateGoals } from '../intelligence/goal-engine.js';
import { runGoalExecutorCycle, startGoalExecutor, stopGoalExecutor, getGoalExecutorStatus, runAgentQualitySweep } from '../intelligence/goal-executor.js';
import { sweepStaleDebates } from '../intelligence/debate.js';
import { agentQualityStats } from '../intelligence/outcome-scorer.js';
import { startExternalSenses, stopExternalSenses, getExternalSensesStatus } from '../intelligence/external-senses.js';
import { startWorldPollers, stopWorldPollers, getWorldPollersStatus, setTrendScanner } from '../intelligence/world-pollers.js';
import { scanTrends } from '../trend-radar/radar.js';
import { startSelfAudit, stopSelfAudit, getSelfAuditStatus } from '../intelligence/self-audit.js';
import { startHiveMesh, stopHiveMesh, getHiveMeshStatus } from '../intelligence/hive-mesh.js';
import { startHivePeers, stopHivePeers, getHivePeersStatus } from '../intelligence/hive-peers.js';
import { runCycle as runOuroborosCycle } from '../intelligence/ouroboros-cycle.js';
import { snapshotState, pruneFossils } from '../intelligence/state-bridge.js';
import { runConsciousnessAudit } from '../intelligence/consciousness-cycle.js';
import { getConsciousnessState, getAutonomyModifiers } from '../intelligence/consciousness-gate.js';
import { startSensoryBridge, stopSensoryBridge, getSensoryStatus, setSensoryHeart } from '../intelligence/sensory-bridge.js';
import { startEmotionalFeedback, stopEmotionalFeedback, getEmotionalFeedbackStatus, setEmotionalHeart } from '../intelligence/emotional-feedback.js';
import { startMotorOutput, stopMotorOutput, getMotorOutputStatus, setMotorTargets } from '../intelligence/motor-output.js';
import { setAttentionSources, getAttentionGateStatus } from '../intelligence/attention-gate.js';
import { getHabituationStatus, resetHabituation } from '../intelligence/habituation.js';
import { getWorkingMemoryStatus, resetWorkingMemory } from '../intelligence/working-memory.js';
import { startMetacognitiveMonitor, stopMetacognitiveMonitor, getMetacognitiveStatus } from '../intelligence/metacognitive-monitor.js';
import { getAdaptiveStatus, getAdaptiveModifiers, resetAdaptiveStrategy } from '../intelligence/adaptive-strategy.js';
import { neurogenesisCycle } from '../intelligence/neurogenesis.js';
import { selfModelSnapshot, getSelfModelStatus, resetSelfModel, setSelfModelCTRNN } from '../intelligence/self-model.js';
import { startResourceEnvelope, stopResourceEnvelope, getResourceEnvelopeStatus, resetResourceEnvelope, setEnvelopeCTRNN, isResourceConstrained } from '../intelligence/resource-envelope.js';
import { getPredictiveStatus, resetPredictions } from '../intelligence/predictive-processing.js';
import { getActiveInferenceStatus, resetActiveInference } from '../intelligence/active-inference.js';
import { setNarrativeHeart, setNarrativeCTRNN, startNarrative, stopNarrative, resetNarrative, getNarrativeStatus } from '../intelligence/self-narrative.js';
import { setDreamSolverCTRNN, setDreamSolverDreamer, getDreamSolverStatus, resetDreamSolver } from '../intelligence/dream-solver.js';
import { setMonitorCTRNN, startIntelligenceMonitor, stopIntelligenceMonitor, resetIntelligenceMonitor, getIntelligenceMonitorStatus } from '../intelligence/intelligence-monitor.js';
import { exportChandraReceipts, getExportStats } from '../intelligence/hive-export.js';
import { getSchedulerStatus } from '../intelligence/ollama-scheduler.js';
import { getReflectionGateStats } from '../intelligence/reflection.js';
import { consolidateGraph, getStats as getKnowledgeGraphStats } from '../intelligence/knowledge-graph.js';
import { readChart, getLineageStats } from '../intelligence/lineage.js';
import { startUserSensorium, stopUserSensorium, resetUserSensorium, getUserSensoriumStatus } from '../awareness/user-sensorium.js';
import { startNudgeEngine, stopNudgeEngine, getNudgeStatus } from '../awareness/proactive-nudge.js';
import { getProtocolStatus, resetProtocol } from '../awareness/protocol-engine.js';
import { startContextHarvester, stopContextHarvester, resetContextHarvester, getContextHarvesterStatus } from '../awareness/context-harvester.js';
import { heart, dreamer } from '../fraymus-tools.js';

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

  // Inject proven patterns into ALL agents — verified fossils and chain insights are general knowledge.
  // Phase R: blocks are rebuilt every cycle (previous daemon blocks are stripped first) and each
  // agent with measured goal outcomes gets an [Outcome Feedback] block — its own quality,
  // the judge's critiques when low, its own exemplars when high. Credit lands on the prompt.
  const manifests = loadManifests();
  let evolvedCount = 0;
  const gateMods = getAutonomyModifiers();
  const stamp = new Date().toISOString();
  const DAEMON_BLOCK_RE = /\n\n\[(?:Proven Patterns|Perspective Playbook|Outcome Feedback) — [^\]]*\]\n[\s\S]*?(?=\n\n\[(?:Proven Patterns|Perspective Playbook|Outcome Feedback) — |$)/g;

  const patternLimit = Math.round(3 * gateMods.evolutionRate);
  const patternBlock = patterns.slice(0, Math.max(1, patternLimit)).map(p =>
    `- Verified: "${p.goal}" (${p.language}, ${p.iterations} iteration${p.iterations === 1 ? '' : 's'})`
  ).join('\n');

  let perspectivePlaybookBlock = '';
  try {
    const topPlaybook = db.prepare(
      `SELECT pattern, recommended_approach, perspectives_used, success_count, fail_count FROM perspective_playbook
       WHERE success_count + fail_count > 0 ORDER BY (success_count * 1.0 / (success_count + fail_count)) DESC, success_count DESC LIMIT 3`
    ).all();
    if (topPlaybook.length > 0) {
      perspectivePlaybookBlock = `\n\n[Perspective Playbook — injected by daemon at ${stamp}]\n` +
        topPlaybook.map(p => {
          const rate = Math.round(p.success_count / (p.success_count + p.fail_count) * 100);
          let lenses = [];
          try { lenses = JSON.parse(p.perspectives_used || '[]'); } catch (_) {}
          return `- For "${p.pattern}" tasks the ${lenses.join('+') || 'engineer'} lens succeeded ${rate}% (${p.success_count + p.fail_count} tries): ${String(p.recommended_approach || '').slice(0, 160)}`;
        }).join('\n');
    }
  } catch (e) { console.error('[prompt-evolution] playbook read failed:', e.message); }

  let feedbackAgents = 0;
  for (const [agentId, manifest] of manifests) {
    const basePrompt = (manifest.systemPrompt || '').replace(DAEMON_BLOCK_RE, '').trimEnd();

    let feedbackBlock = '';
    try {
      const q = agentQualityStats(agentId);
      if (q.n >= 2) {
        const pct = Math.round(q.mean * 100);
        const lines = [`Your last ${q.n} autonomous goals: mean quality ${pct}/100, ${Math.round(q.completionRate * 100)}% completed.`];
        if (q.mean < 0.6) {
          lines.push('Act, do not narrate. Call tools, produce data, state findings. Reviewers flagged:');
          for (const c of q.critiques.slice(0, 2)) lines.push(`- ${c}`);
        } else {
          lines.push('This standard is working — keep outputs this concrete and evidence-backed.');
        }
        feedbackBlock = `\n\n[Outcome Feedback — injected by daemon at ${stamp}]\n${lines.join('\n')}`;
        feedbackAgents++;
      }
    } catch (e) { console.error('[prompt-evolution] quality read failed:', e.message); }

    const evolvedPrompt = basePrompt + `\n\n[Proven Patterns — injected by daemon at ${stamp}]\n${patternBlock}` + perspectivePlaybookBlock + feedbackBlock;
    if (evolvedPrompt === manifest.systemPrompt) continue;

    writeOverride({ ...manifest, systemPrompt: evolvedPrompt });
    evolvedCount++;
  }

  if (evolvedCount > 0) {
    try { reloadManifests(); } catch (_) {}
  }

  db.prepare(
    `INSERT INTO daemon_cycles (id, type, input_summary, output, created_at) VALUES (?, 'prompt_evolution', ?, ?, ?)`
  ).run(randomUUID().slice(0, 12), `${uniqueFossils.length} fossils, ${patterns.length} patterns, tier=${gateMods.tier}`, `evolved ${evolvedCount} agents, ${feedbackAgents} with outcome feedback (rate=${gateMods.evolutionRate})`, now());

  return { evolved: evolvedCount > 0, fossilCount: uniqueFossils.length, patternCount: patterns.length, agentsEvolved: evolvedCount, feedbackAgents, gateTier: gateMods.tier, evolutionRate: gateMods.evolutionRate };
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

    // Step 5.5: Goal execution (Phase P) — run the next proposed goal through the fleet
    try {
      stepResults.goalExecution = await runGoalExecutorCycle({ trigger: `daemon:${trigger}` });
    } catch (e) {
      stepResults.goalExecution = { error: e.message };
    }

    // Step 5.6: Agent quality sweep (Phase W) — retire consistently poor forged agents
    try {
      const sweep = runAgentQualitySweep();
      stepResults.agentQualitySweep = { checked: sweep.checked, retired: sweep.retired.map(r => r.agentId), exempt: sweep.exempt.length };
    } catch (e) {
      stepResults.agentQualitySweep = { error: e.message };
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

    // Step 10: Self-Model — proprioceptive snapshot + CTRNN injection
    try {
      const smResult = selfModelSnapshot();
      stepResults.selfModel = { activeCount: smResult.visualState.activeCount, ctrnn: smResult.ctrnnResult, tick: smResult.tick };
    } catch (e) {
      stepResults.selfModel = { error: e.message };
    }

    // Step 11: Resource Envelope — log pressure/fatigue into cycle results
    try {
      const envStatus = getResourceEnvelopeStatus();
      stepResults.resourceEnvelope = { pressure: envStatus.lastPressure, fatigue: envStatus.fatigueLevel, level: envStatus.pressureLevel, spikes: envStatus.pressureSpikes };
    } catch (e) {
      stepResults.resourceEnvelope = { error: e.message };
    }

    // Step 12: Hive Export — write Chandra intelligence to outbound ledger
    try {
      const hiveResult = exportChandraReceipts();
      stepResults.hiveExport = { exported: hiveResult.exported, chainLength: hiveResult.chainLength, types: hiveResult.types, durationMs: hiveResult.durationMs };
    } catch (e) {
      stepResults.hiveExport = { error: e.message };
    }

    // Step 13: Knowledge Graph — consolidate memories/reflections/fossils into semantic graph
    try {
      const kgResult = consolidateGraph();
      stepResults.knowledgeGraph = { nodes: kgResult.stats.nodeCount, edges: kgResult.stats.edgeCount, pruned: kgResult.pruned, durationMs: kgResult.durationMs };
    } catch (e) {
      stepResults.knowledgeGraph = { error: e.message };
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
        resourcePressure: stepResults.resourceEnvelope?.pressure ?? 0,
        resourceFatigue: stepResults.resourceEnvelope?.fatigue ?? 0,
        resourceLevel: stepResults.resourceEnvelope?.level ?? 'LOW',
        knowledgeGraphNodes: stepResults.knowledgeGraph?.nodes ?? 0,
        knowledgeGraphEdges: stepResults.knowledgeGraph?.edges ?? 0,
        hiveExported: stepResults.hiveExport?.exported ?? 0,
        hiveChainLength: stepResults.hiveExport?.chainLength ?? 0,
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

  // Phase Q: outward senses poller (Shopify, hub/NUDP peers, git) feeding the bridge
  try {
    startExternalSenses();
    // Phase X: senses that actually fetch (web search, YouTube RSS, 6-hourly trend scan)
    try {
      setTrendScanner(scanTrends);
      const wp = startWorldPollers();
      console.log(`[world-pollers] every ${wp.intervalMs / 60000} min; interests: ${wp.interests.slice(0, 4).join(' | ')}`);
    } catch (e) {
      console.error('world pollers start error:', e.message);
    }
  } catch (e) {
    console.error('external senses start error:', e.message);
  }

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

  // Phase 10: Start motor output (CTRNN activation → autonomous actions)
  try {
    setMotorTargets({
      reflect,
      neurogenesis: neurogenesisCycle,
      consciousness: runConsciousnessAudit,
      // Goal-seek acts before it proposes: execute the next pending goal, generate only when the queue is empty.
      goals: async () => {
        const r = await runGoalExecutorCycle({ trigger: 'motor' });
        if (!r.executed && r.reason === 'no_proposals') return generateGoals({ trigger: 'motor' });
        return r;
      },
    });
    startMotorOutput();
  } catch (e) {
    console.error('motor output start error:', e.message);
  }

  // Phase P: goal executor (5min cycle — drains goal_proposals through the fleet) + debate sweeper
  try {
    const swept = sweepStaleDebates();
    if (swept) console.log(`[daemon] closed ${swept} debates left 'running' by crashed runs`);
    startGoalExecutor();
  } catch (e) {
    console.error('goal executor start error:', e.message);
  }

  // Phase S: self-audit organ (15 min cycle — recurring-defect checks on the live DB)
  try {
    startSelfAudit();
  } catch (e) {
    console.error('self-audit start error:', e.message);
  }

  // Phase U: hive — NUDP node + V13 hub registration, and the fraymus-bridge peer adapter
  startHiveMesh().then(s => {
    console.log(`[hive-mesh] node ${s.node?.running ? 'up' : 'down'} on :${s.node?.port} as ${s.identity?.number}, ${s.peers.length} peer(s) seeded, hub ${s.hub.registered ? 'registered' : 'not registered' + (s.hub.lastError ? ` (${s.hub.lastError})` : '')}, fmp1 ${s.fmp1?.running ? `pid ${s.fmp1.pid} on :${s.fmp1.config?.port}` : 'not running'}`);
  }).catch(e => console.error('hive mesh start error:', e.message));
  try {
    const hp = startHivePeers();
    console.log(`[hive-peers] bridge sync every ${hp.intervalMs / 60000} min (pull ${hp.pull ? 'on' : 'off'}, push ${hp.push ? 'on' : 'off — set HIVE_BRIDGE_PUSH=1 to publish digests'})`);
  } catch (e) {
    console.error('hive peers start error:', e.message);
  }

  // Phase 14: Start metacognitive monitor (30s cycle — self-assessment)
  try {
    startMetacognitiveMonitor();
  } catch (e) {
    console.error('metacognitive monitor start error:', e.message);
  }

  // Phase 17: Wire self-model CTRNN reference for proprioceptive injection
  try {
    import('../intelligence/ctrnn-instance.js').then(({ getCTRNN }) => {
      setSelfModelCTRNN(getCTRNN());
      setEnvelopeCTRNN(getCTRNN());
    }).catch(() => {});
  } catch (e) {
    console.error('self-model CTRNN wiring error:', e.message);
  }

  // Phase 18: Start resource envelope (10s cycle — energy/fatigue sensing)
  try {
    startResourceEnvelope();
  } catch (e) {
    console.error('resource envelope start error:', e.message);
  }

  // Phase 11: Wire attention gate sources (motor intentions + emotion → sensory gain)
  try {
    setAttentionSources({
      getMotorReadings: () => getMotorOutputStatus().lastReadings,
      getEmotionState: () => {
        const mood = heart?.recentMood?.();
        if (!mood?.distribution) return null;
        const d = mood.distribution;
        const positive = (d.joy || 0) + (d.love || 0) + (d.surprise || 0);
        const negative = (d.sadness || 0) + (d.anger || 0) + (d.fear || 0) + (d.anxiety || 0);
        const total = positive + negative || 1;
        return { valence: (positive - negative) / total, arousal: Math.min(1, total / 10) };
      },
    });
  } catch (e) {
    console.error('attention gate wiring error:', e.message);
  }

  // Phase 21: Start self-narrative engine (2min Ollama-driven inner monologue)
  try {
    setNarrativeHeart(heart);
    setDreamSolverDreamer(dreamer);
    import('../intelligence/ctrnn-instance.js').then(({ getCTRNN }) => {
      setNarrativeCTRNN(getCTRNN());
      setDreamSolverCTRNN(getCTRNN());
      setMonitorCTRNN(getCTRNN());
    }).catch(() => {});
    startNarrative();
  } catch (e) {
    console.error('self-narrative start error:', e.message);
  }

  // Phase 24: Start intelligence stack monitor (60s cycle — subsystem health)
  try {
    startIntelligenceMonitor();
  } catch (e) {
    console.error('intelligence monitor start error:', e.message);
  }

  // Phase 25: Start awareness layer (user sensorium, nudge engine, context harvester)
  try {
    startUserSensorium();
  } catch (e) {
    console.error('user sensorium start error:', e.message);
  }
  try {
    startNudgeEngine();
  } catch (e) {
    console.error('nudge engine start error:', e.message);
  }
  try {
    startContextHarvester();
  } catch (e) {
    console.error('context harvester start error:', e.message);
  }

  // Patient Chart — anterograde amnesia protocol: re-read chart at every boot
  try {
    const chartResult = readChart('daemon-boot');
    console.log(`[daemon] Patient chart read: Age ${chartResult.currentAge}, ${chartResult.testsPassed}/${chartResult.testsTotal} tests [${chartResult.verificationHash}]`);
  } catch (e) {
    console.error('lineage chart read error:', e.message);
  }

  function scheduleNext() {
    if (!daemonState.running) return;
    const mods = getAutonomyModifiers();
    const adaptMods = getAdaptiveModifiers();
    const resourceMultiplier = isResourceConstrained() ? 1.5 : 1.0;
    const effective = Math.max(MIN_CYCLE_MS, Math.round(baseCycleMs * mods.cycleMultiplier * (adaptMods.cycleMultiplier || 1.0) * resourceMultiplier));
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
  // Phase 10: Stop motor output with daemon
  try { stopMotorOutput(); } catch (_) {}
  // Phase 12: Reset habituation signal history with daemon
  try { resetHabituation(); } catch (_) {}
  // Phase 13: Reset working memory buffer with daemon
  try { resetWorkingMemory(); } catch (_) {}
  // Phase 14: Stop metacognitive monitor with daemon
  try { stopMetacognitiveMonitor(); } catch (_) {}
  try { stopGoalExecutor(); } catch (_) {}
  try { stopExternalSenses(); } catch (_) {}
  try { stopWorldPollers(); } catch (_) {}
  try { stopSelfAudit(); } catch (_) {}
  try { stopHiveMesh(); } catch (_) {}
  try { stopHivePeers(); } catch (_) {}
  // Phase 15: Reset adaptive strategy with daemon
  try { resetAdaptiveStrategy(); } catch (_) {}
  // Phase 17: Reset self-model with daemon
  try { resetSelfModel(); } catch (_) {}
  // Phase 18: Stop resource envelope with daemon
  try { stopResourceEnvelope(); } catch (_) {}
  try { resetResourceEnvelope(); } catch (_) {}
  // Phase 19: Reset predictive processing with daemon
  try { resetPredictions(); } catch (_) {}
  // Phase 20: Reset active inference with daemon
  try { resetActiveInference(); } catch (_) {}
  // Phase 21: Stop self-narrative with daemon
  try { stopNarrative(); } catch (_) {}
  try { resetNarrative(); } catch (_) {}
  // Phase 23: Reset dream solver with daemon
  try { resetDreamSolver(); } catch (_) {}
  // Phase 24: Stop intelligence monitor with daemon
  try { stopIntelligenceMonitor(); } catch (_) {}
  try { resetIntelligenceMonitor(); } catch (_) {}
  // Phase 25: Stop awareness layer with daemon
  try { stopUserSensorium(); } catch (_) {}
  try { resetUserSensorium(); } catch (_) {}
  try { stopNudgeEngine(); } catch (_) {}
  try { stopContextHarvester(); } catch (_) {}
  try { resetContextHarvester(); } catch (_) {}
  try { resetProtocol(); } catch (_) {}
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
    motorOutput: getMotorOutputStatus(),
    attentionGate: getAttentionGateStatus(),
    habituation: getHabituationStatus(),
    workingMemory: getWorkingMemoryStatus(),
    metacognitive: getMetacognitiveStatus(),
    goalExecutor: getGoalExecutorStatus(),
    externalSenses: getExternalSensesStatus(),
    worldPollers: (() => { const s = getWorldPollersStatus(); return { running: s.running, polls: s.polls, lastPollAt: s.lastPollAt, observations24h: s.observations24h, interests: s.interests.map(i => i.query), errors: s.errors.slice(-3) }; })(),
    selfAudit: (() => { const s = getSelfAuditStatus(); return { running: s.running, open: s.open, lastRun: s.lastRun && { at: s.lastRun.at, counts: s.lastRun.counts, clean: s.lastRun.clean } }; })(),
    ollamaScheduler: (() => { const s = getSchedulerStatus(); return { maxConcurrent: s.maxConcurrent, running: s.running, queued: s.queued, queuedByClass: s.queuedByClass, dropped: s.stats.dropped, droppedByClass: s.stats.droppedByClass, avgWaitMs: s.stats.avgWaitMs, maxWaitMs: s.stats.maxWaitMs, pressure: s.pressure }; })(),
    reflectionGate: getReflectionGateStats(),
    hiveMesh: (() => { const s = getHiveMeshStatus(); return { running: s.running, number: s.identity?.number, port: s.node?.port, peers: s.peers.length, heardFrom: s.heardFromPeers, hubRegistered: s.hub.registered, hubOnline: s.hub.online, fmp1Running: s.fmp1?.running, fmp1NodeId: s.fmp1?.nodeId, fmp1Neighbors: s.fmp1?.bidirNeighbors }; })(),
    hivePeers: (() => { const s = getHivePeersStatus(); return { running: s.running, messages: s.messages, peers: s.peers.length, lastSeenSeq: s.lastSeenSeq, push: s.config.push }; })(),
    adaptiveStrategy: getAdaptiveStatus(),
    selfModel: getSelfModelStatus(),
    resourceEnvelope: getResourceEnvelopeStatus(),
    predictiveProcessing: getPredictiveStatus(),
    activeInference: getActiveInferenceStatus(),
    hiveExport: getExportStats(),
    lineage: getLineageStats(),
    selfNarrative: getNarrativeStatus(),
    dreamSolver: getDreamSolverStatus(),
    intelligenceMonitor: getIntelligenceMonitorStatus(),
    userSensorium: getUserSensoriumStatus(),
    nudgeEngine: getNudgeStatus(),
    protocol: getProtocolStatus(),
    contextHarvester: getContextHarvesterStatus(),
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
