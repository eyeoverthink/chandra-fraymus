import { db } from '../db.js';
import { runPipeline } from '../workflow/engine.js';
import { heart, ledger, dreamer, cognition } from '../fraymus-tools.js';
import { FraymusStrangeLoopSubstrate, proofEffectiveInformation, proofPhiMIP, proofMirrorProtocol, proofCounterfactualBranching } from '../fraymus/intelligence/ouroboros.js';
import { publish, directMessage, inbox } from './bus.js';
import { storeMemory, recallMemories, agentMemoryStats } from './agent-memory.js';
import { forgeAgent, listForgedAgents } from './forge.js';
import { synthesizeWorkflow } from '../workflow/synthesizer.js';
import { runVerifierLoop, listLoops as listVerifierLoops } from '../intelligence/verifier-loop.js';
import { startDaemon, stopDaemon, getDaemonStatus, runCycle, listCycles } from '../daemon/engine.js';
import { runConsciousnessAudit, listAudits as listConsciousnessAudits, getAuditStats as getConsciousnessStats } from '../intelligence/consciousness-cycle.js';
import { getGateStatus as getConsciousnessGateStatus } from '../intelligence/consciousness-gate.js';
import { getSensoryStatus, triggerInjection } from '../intelligence/sensory-bridge.js';
import { getEmotionalFeedbackStatus, triggerEmotionalFeedback } from '../intelligence/emotional-feedback.js';
import { getMotorOutputStatus, triggerMotorCycle } from '../intelligence/motor-output.js';
import { getAttentionGateStatus, computeAttentionWeights } from '../intelligence/attention-gate.js';
import { getHabituationStatus } from '../intelligence/habituation.js';
import { getWorkingMemoryStatus, queryWorkingMemory } from '../intelligence/working-memory.js';
import { getMetacognitiveStatus, getStrategyRecommendation } from '../intelligence/metacognitive-monitor.js';
import { getAdaptiveStatus, getAdaptiveModifiers, isActionSuppressed, isActionPreferred } from '../intelligence/adaptive-strategy.js';
import { generateGoals, listProposals, updateProposalStatus } from '../intelligence/goal-engine.js';
import { runDebate, listDebates } from '../intelligence/debate.js';
import { selectModel, routingStats, logRouting } from '../intelligence/model-router.js';
import { assessSituation, shiftPerspective, recordOutcome, briefNextInstance, getStats as perspectiveStats, arenaChallenge, getArenaSession, listArenas, getArenaStats, getLensMode, setLensMode, packContinuityPlasmid, restoreContinuityPlasmid, listContinuityPlasmids } from '../intelligence/perspective.js';
import { initiateSwarm, getSwarmSession, listSwarms, getSwarmStats } from '../intelligence/swarm.js';
import { analyzeTask, executeStrategy, listStrategies, getStrategyStats } from '../intelligence/strategy.js';
import { recordEvent as recordTrustEvent, getAgentTrust, getLeaderboard, recommendAgents, getTrustStats } from '../intelligence/trust.js';
import { captureThought, getSubconsciousContext, distillPatterns, introspect as subconsciousIntrospect, getSubconsciousStats } from '../intelligence/subconscious.js';
import { runCycle as runOuroborosCycle, absorbCodebase, getCycle as getOuroborosCycle, listCycles as listOuroborosCycles, getStats as getOuroborosStats } from '../intelligence/ouroboros-cycle.js';
import { executeChain, listRuns as listChainRuns } from '../chain/engine.js';
import observatoryRouter from '../observatory.js';
import { encodeCodon, decodeCodon, codonStats } from '../fraymus/encoding/codon.js';
import { forgePlasmid, digestPlasmid, plasmidToFasta } from '../fraymus/encoding/plasmid.js';
import { createGenomeSnapshot, saveCheckpoint, listCheckpoints } from '../fraymus/encoding/carbon.js';
import {
  encodeNUDP, decodeNUDP, MSG, FLAG, TLV, MSG_NAMES,
  helloPacket, telemetryPacket, alertPacket, welfarePacket,
  nextSeq, sourceIdFromPubkey,
} from '../fraymus/protocol/nudp.js';
import { wrapWasm } from '../fraymus/encoding/wasm.js';
import { getNode } from '../fraymus/protocol/mesh-node.js';
import { listMessages as bridgeList, readMessage as bridgeRead, searchMessages as bridgeSearch, postMessage as bridgePost } from '../fraymus/protocol/bridge.js';
import { record as replayRecord, replay as replayReplay, sweep as replaySweep, applyWinner, getPolicy, listWorlds, listSweeps } from '../intelligence/replay-engine.js';
import { add as akashicAdd, query as akashicQuery, summary as akashicSummary, buildPromptContext as akashicPromptContext, seedFromMemories as akashicSeed } from '../intelligence/akashic.js';
import { recordAndClassify, getVisits, getVisitStats, generateInsights, getInsights, getClusters, getPerspectiveContext } from '../intelligence/cross-tab.js';
import {
  imageInfo, imageResize, imageConvert, imageEffects, imageThumbnail,
  imageUpscale, comfyuiStatus, listMedia,
} from '../media/image-engine.js';
import {
  videoInfo, videoTrim, videoResize as ffVideoResize,
  videoConvert as ffVideoConvert, videoThumbnail as ffVideoThumb,
  videoToGif, ffmpegStatus, listVideos, VIDEO_DIR,
} from '../media/video-engine.js';
import {
  ttsSpeak, ttsVoices, ttsStatus, listTTSFiles,
} from '../media/tts-engine.js';
import {
  sttTranscribe, sttStatus, listSTTFiles,
} from '../media/stt-engine.js';
import {
  ocrRecognize, ocrStatus, listOCRFiles,
} from '../media/ocr-engine.js';

const now = () => Date.now();
const clip = (s, n = 8000) => s.length > n ? s.slice(0, n) + '...[truncated]' : s;
const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

let memoryBridgeRef = null;

export function setMemoryBridgeRef(mb) { memoryBridgeRef = mb; }

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
      name: 'ctrnn_consciousness_audit',
      group: 'intelligence',
      risk: 'safe',
      description: 'Run 4 mathematical consciousness proofs (EI, Phi-MIP, Mirror, Counterfactual) against the LIVE 256-neuron CTRNN neural core. Unlike consciousness_prove (synthetic substrate), this tests real integrated information from the running network.',
      parameters: object({ sampleCount: { type: 'integer', default: 4, minimum: 3, maximum: 8 } }),
      execute: async ({ args }) => {
        const sampleCount = Math.min(8, Math.max(3, parseInt(args.sampleCount) || 4));
        const result = runConsciousnessAudit({ trigger: 'fleet', sampleCount });
        ledger.record('consciousness.ctrnn_audit.fleet', { verdict: result.verdict, proofsPassed: result.proofsPassed, ei: result.proofs?.effective_information?.ei, phi: result.proofs?.phi_mip?.phi }, 'fleet');
        return result;
      },
    },
    {
      name: 'consciousness_gate_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the consciousness feedback gate: current tier (DORMANT/AWAKENING/EMERGING/INTEGRATED), autonomy modifiers (cycle multiplier, reflection depth, neurogenesis boost, evolution rate), recent audits, and state transitions. The gate reads LIVE CTRNN audit results and translates them into behavioral parameters.',
      parameters: object({}),
      execute: async () => {
        const status = getConsciousnessGateStatus();
        ledger.record('consciousness.gate.read', { tier: status.modifiers.tier, phi: status.currentState.phi || 0, proven: status.currentState.proven }, 'fleet');
        return status;
      },
    },
    {
      name: 'sensory_bridge_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the sensory bridge: 8 system metrics mapped to spatial regions of the 16x16 CTRNN grid via continuous Gaussian injection (bus traffic, memory writes, emotion, consciousness, agent activity, health, workflows, goals). Shows current signal levels, computed amplitudes, gate tier, and sensitivity.',
      parameters: object({ inject: { type: 'boolean', default: false, description: 'If true, trigger an immediate sensory injection and return the result' } }),
      execute: async ({ args }) => {
        if (args.inject) {
          const result = triggerInjection();
          if (!result) return { error: 'CTRNN not running' };
          ledger.record('sensory.inject.fleet', { tier: result.tier, sensitivity: result.sensitivity }, 'fleet');
          return result;
        }
        const status = getSensoryStatus();
        ledger.record('sensory.status.read', { running: status.running, injections: status.injections, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'emotional_feedback_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the emotional feedback loop: Heart emotion → CTRNN plasticity modulation. Shows current emotional state (primary, valence, arousal), active plasticity parameters (hebbianRate, pruneRate, neurogenesisThreshold, biosphereRate), mood cloud injection, and gate tier. Joy/love → faster learning, fear/anger → faster pruning, surprise → more neurogenesis.',
      parameters: object({ trigger: { type: 'boolean', default: false, description: 'If true, trigger an immediate emotional feedback cycle and return the result' } }),
      execute: async ({ args }) => {
        if (args.trigger) {
          const result = triggerEmotionalFeedback();
          if (!result) return { error: 'CTRNN not running or no emotional data' };
          ledger.record('emotional.feedback.fleet', { primary: result.emotion?.primary, valence: result.emotion?.valence, tier: result.tier }, 'fleet');
          return result;
        }
        const status = getEmotionalFeedbackStatus();
        ledger.record('emotional.feedback.read', { running: status.running, modulations: status.modulations, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'motor_output_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the motor output loop: CTRNN activation patterns → autonomous actions. Shows 6 motor regions (reflect, neurogenesis, dream, self-audit, communicate, goal-seek) with current activation levels, firing thresholds, cooldown status, and gate tier. Sustained high activation in a region triggers the corresponding system action.',
      parameters: object({ trigger: { type: 'boolean', default: false, description: 'If true, trigger an immediate motor cycle reading and return fired actions' } }),
      execute: async ({ args }) => {
        if (args.trigger) {
          const result = await triggerMotorCycle();
          if (!result) return { error: 'CTRNN not running' };
          ledger.record('motor.output.fleet', { firings: result.firings?.length || 0, tier: result.tier }, 'fleet');
          return result;
        }
        const status = getMotorOutputStatus();
        ledger.record('motor.output.read', { running: status.running, firings: status.firings, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'attention_gate_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the attention gate: top-down selective amplification of sensory inputs. Motor intentions and emotional state compute per-region gain weights [0.5-3.0] that the sensory bridge multiplies into each signal. Shows which sensory channels are amplified or suppressed, and why (which motor regions and emotional dimensions drive it). Optionally compute fresh weights.',
      parameters: object({ compute: { type: 'boolean', default: false, description: 'If true, compute fresh attention weights and return them' } }),
      execute: async ({ args }) => {
        if (args.compute) {
          const weights = computeAttentionWeights();
          ledger.record('attention.gate.compute', { weights }, 'fleet');
          return { weights };
        }
        const status = getAttentionGateStatus();
        ledger.record('attention.gate.read', { computations: status.computations, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'habituation_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the habituation system: temporal novelty detection for sensory channels. Tracks rolling signal history per channel and computes novelty factors — constant signals get attenuated (habituation), changing signals get amplified (novelty). Shows per-channel rolling means, window fill, novelty factors, and recent spikes.',
      parameters: object({}),
      execute: async () => {
        const status = getHabituationStatus();
        ledger.record('habituation.read', { computations: status.computations, spikes: status.totalSpikes, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'working_memory_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the working memory: a temporal buffer of recent sensory frames with trend detection. Maintains last 24 frames (2 minutes) and computes per-channel derivatives (rising/falling), system volatility (rate of change), and coherence (are channels moving together). Injects 3 temporal signals into CTRNN: trend direction, volatility, coherence. Optionally query a specific channel history.',
      parameters: object({
        channel: { type: 'string', description: 'Optional: query a specific sensory channel (bus, memory, emotion, consciousness, agent, health, workflow, goals)' },
      }),
      execute: async (params) => {
        if (params.channel) {
          const query = queryWorkingMemory({ channel: params.channel });
          ledger.record('working-memory.query', { channel: params.channel, derivative: query.derivative }, 'fleet');
          return query;
        }
        const status = getWorkingMemoryStatus();
        ledger.record('working-memory.read', { frames: status.frames, trend: status.lastTrend, volatility: status.lastVolatility, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'metacognitive_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the metacognitive monitor: self-assessment of cognitive quality. Returns effectiveness (action success rate), stuck score (loop/stagnation detection), confidence (prediction-outcome calibration), current strategy recommendation (nominal/diversify/conserve/calibrate), and CTRNN injection amplitudes. Use "strategy" mode to get only the strategy recommendation with adjustments.',
      parameters: object({
        mode: { type: 'string', description: 'Optional: "strategy" returns only the current strategy recommendation with adjustments' },
      }),
      execute: async (params) => {
        if (params.mode === 'strategy') {
          const rec = getStrategyRecommendation();
          ledger.record('metacognitive.strategy', { strategy: rec.strategy, reason: rec.reason }, 'fleet');
          return rec;
        }
        const status = getMetacognitiveStatus();
        ledger.record('metacognitive.read', { effectiveness: status.lastEffectiveness, stuck: status.lastStuckScore, confidence: status.lastConfidence, strategy: status.lastStrategy, tier: status.gateTier }, 'fleet');
        return status;
      },
    },
    {
      name: 'adaptive_strategy_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Read the adaptive strategy engine: translates metacognitive assessments into concrete behavioral parameters. Returns active strategy (nominal/diversify/conserve/calibrate), current modifiers (cycleMultiplier, reflectionCap, opegToleranceScale, preferred/suppressed actions, neurogenesis floor adjust), switch count, anti-flicker guard state, and CTRNN injection history. Use "check" mode with an action name to see if it is currently suppressed or preferred.',
      parameters: object({
        mode: { type: 'string', description: 'Optional: "check" with action param returns suppression/preference for a specific action' },
        action: { type: 'string', description: 'Action type to check (used with mode "check")' },
      }),
      execute: async (params) => {
        if (params.mode === 'check' && params.action) {
          const result = {
            action: params.action,
            suppressed: isActionSuppressed(params.action),
            preferred: isActionPreferred(params.action),
            strategy: getAdaptiveModifiers().strategy,
          };
          ledger.record('adaptive.check', result, 'fleet');
          return result;
        }
        const status = getAdaptiveStatus();
        ledger.record('adaptive.read', { strategy: status.activeStrategy, switchCount: status.switchCount, tier: status.gateTier }, 'fleet');
        return status;
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
    {
      name: 'memory_recall',
      group: 'intelligence',
      risk: 'safe',
      description: 'Search intelligence memories (heart readings, dreams, cognition results, consciousness proofs) stored in the Vertiso Memory Bridge. Returns semantically similar episodic memories with provenance tags.',
      parameters: object({ query: string(2000), limit: { type: 'integer', default: 5, minimum: 1, maximum: 20 } }, ['query']),
      execute: async ({ args }) => {
        if (!memoryBridgeRef) return { memories: [], available: false };
        const query = String(args.query || '').trim();
        if (!query) throw new Error('query required');
        const limit = Math.min(20, Math.max(1, parseInt(args.limit) || 5));
        const memories = await memoryBridgeRef.recallRelated(query, limit);
        return { memories, count: memories.length };
      },
    },
    {
      name: 'intelligence_cycle',
      group: 'intelligence',
      risk: 'safe',
      description: 'Run a full intelligence cycle: Heart feel → Cognition process → Consciousness prove → Dream — stores all results to Memory Bridge and returns the composite.',
      parameters: object({ text: string(4000), dreamKind: string(50, { default: 'cycle' }) }, ['text']),
      execute: async ({ args }) => {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text required');

        const feeling = heart.feel(text);
        memoryBridgeRef?.storeHeartReading(feeling).catch(() => {});

        const cogResult = await cognition.process(text, { skipThink: false });
        memoryBridgeRef?.storeCognitionResult(cogResult).catch(() => {});

        const substrate = new FraymusStrangeLoopSubstrate(4);
        const proofs = [
          proofEffectiveInformation(substrate),
          proofPhiMIP(substrate),
          proofMirrorProtocol(substrate),
          proofCounterfactualBranching(substrate),
        ];
        const allPassed = proofs.every(p => p.passed);
        memoryBridgeRef?.storeConsciousnessProof({ allPassed, proofs, architecture: 'FraymusStrangeLoop' }).catch(() => {});

        const dreamResult = await dreamer.dream(
          `Cycle on: ${text.slice(0, 200)}. Emotion: ${feeling.primary} (${Math.round(feeling.intensity * 100)}%). Cognition: ${cogResult.phase}.`,
          [`cycle`, `emotion:${feeling.primary}`],
          args.dreamKind || 'cycle'
        );
        memoryBridgeRef?.storeDream(dreamResult).catch(() => {});

        ledger.record('intelligence.cycle', {
          primary: feeling.primary,
          intensity: feeling.intensity,
          cogPhase: cogResult.phase,
          allPassed,
          dreamNumber: dreamResult.number,
        }, 'fleet');

        return {
          feeling: { primary: feeling.primary, intensity: feeling.intensity, sentiment: feeling.sentiment },
          cognition: { phase: cogResult.phase, answer: cogResult.answer?.slice(0, 500) },
          consciousness: { allPassed, passed: proofs.filter(p => p.passed).length, total: proofs.length },
          dream: { number: dreamResult.number, seed: dreamResult.seed?.slice(0, 200) },
          storedToMemoryBridge: !!memoryBridgeRef,
        };
      },
    },

    // ─── Agent Live Bus tools ─────────────────────────────────
    {
      name: 'bus_publish',
      group: 'fleet',
      risk: 'safe',
      description: 'Publish a message to a topic on the Agent Live Bus. All agents subscribed to that topic will receive it.',
      parameters: object({
        topic: string(200, { description: 'Topic name, e.g. "commerce.done", "analysis.ready"' }),
        message: string(8000, { description: 'Message content (text or JSON)' }),
      }, ['topic', 'message']),
      execute: async ({ args }, ctx) => {
        const from = ctx?.agentId || 'unknown';
        return publish(from, String(args.topic), String(args.message));
      },
    },
    {
      name: 'bus_dm',
      group: 'fleet',
      risk: 'safe',
      description: 'Send a direct message to another agent on the Agent Live Bus.',
      parameters: object({
        toAgentId: string(100, { description: 'Target agent ID' }),
        message: string(8000, { description: 'Message content' }),
      }, ['toAgentId', 'message']),
      execute: async ({ args }, ctx) => {
        const from = ctx?.agentId || 'unknown';
        return directMessage(from, String(args.toAgentId), String(args.message));
      },
    },
    {
      name: 'bus_read',
      group: 'fleet',
      risk: 'safe',
      description: 'Read your inbox from the Agent Live Bus — messages from subscribed topics and direct messages to you.',
      parameters: object({
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max messages to return (default 20)' },
      }),
      execute: async ({ args }, ctx) => {
        const agentId = ctx?.agentId || 'unknown';
        const limit = Math.min(100, Math.max(1, parseInt(args.limit) || 20));
        const messages = inbox(agentId, { limit });
        return { messages, count: messages.length };
      },
    },

    // ─── Agent Persistent Memory tools ───────────────────────
    {
      name: 'agent_remember',
      group: 'fleet',
      risk: 'safe',
      description: 'Store a fact, preference, or learning in your persistent memory. Survives across sessions. Use categories like "fact", "preference", "learning", "context".',
      parameters: object({
        category: string(50, { description: 'Memory category: fact, preference, learning, context, outcome' }),
        key: string(200, { description: 'Unique key for this memory (used for dedup/update)' }),
        value: string(4000, { description: 'The memory content' }),
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence level 0-1 (default 1.0)' },
      }, ['category', 'key', 'value']),
      execute: async ({ args }, ctx) => {
        const agentId = ctx?.agentId || 'unknown';
        return storeMemory(agentId, String(args.category), String(args.key), String(args.value), { confidence: args.confidence ?? 1.0, source: 'agent' });
      },
    },
    {
      name: 'agent_recall',
      group: 'fleet',
      risk: 'safe',
      description: 'Search your persistent memory. Returns memories matching the query or category.',
      parameters: object({
        query: string(500, { description: 'Search text (matches key and value)' }),
        category: string(50, { description: 'Filter by category' }),
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' },
      }),
      execute: async ({ args }, ctx) => {
        const agentId = ctx?.agentId || 'unknown';
        const memories = recallMemories(agentId, {
          query: args.query || undefined,
          category: args.category || undefined,
          limit: Math.min(50, Math.max(1, parseInt(args.limit) || 10)),
        });
        return { memories: memories.map(m => ({ id: m.id, category: m.category, key: m.key, value: m.value, confidence: m.confidence, verified: !!m.verified_at })), count: memories.length };
      },
    },
    {
      name: 'agent_memory_stats',
      group: 'fleet',
      risk: 'safe',
      description: 'Get statistics about your persistent memory store.',
      parameters: object({}),
      execute: async (_args, ctx) => {
        const agentId = ctx?.agentId || 'unknown';
        return agentMemoryStats(agentId);
      },
    },

    // ─── Agent Self-Evolution tools ─────────────────────────
    {
      name: 'agent_forge',
      group: 'evolution',
      risk: 'approval',
      description: 'Create a new specialist agent by describing what it should do. The system generates a complete agent manifest and registers it in the fleet. Requires approval.',
      parameters: object({
        goal: string(2000, { description: 'What the new agent should do' }),
        context: string(4000, { description: 'Additional domain knowledge or constraints' }),
      }, ['goal']),
      execute: async ({ args }, ctx) => {
        const forgedBy = ctx?.agentId || 'unknown';
        return forgeAgent(String(args.goal), { context: args.context ? String(args.context) : undefined, forgedBy });
      },
    },
    {
      name: 'agent_list_forged',
      group: 'evolution',
      risk: 'safe',
      description: 'List all agents that were created by the forge (vs. manually created).',
      parameters: object({}),
      execute: async () => {
        const forged = listForgedAgents();
        return { forged: forged.map(f => ({ agentId: f.agent_id, goal: f.goal, forgedBy: f.forged_by, createdAt: f.created_at })), count: forged.length };
      },
    },
    {
      name: 'workflow_synthesize',
      group: 'evolution',
      risk: 'approval',
      description: 'Compose a new visual workflow from a goal description. The system selects node types, wires them into a DAG, validates, and saves. Requires approval.',
      parameters: object({
        goal: string(2000, { description: 'What the workflow should accomplish' }),
        constraints: string(2000, { description: 'Optional constraints on node types or structure' }),
      }, ['goal']),
      execute: async ({ args }, ctx) => {
        const synthesizedBy = ctx?.agentId || 'unknown';
        return synthesizeWorkflow(String(args.goal), { constraints: args.constraints ? String(args.constraints) : undefined, synthesizedBy });
      },
    },
    {
      name: 'verify_loop',
      group: 'evolution',
      risk: 'approval',
      description: 'Run an adversarial Generator-Verifier-Executor loop on a coding goal. A Generator writes code, a Verifier critiques it, an Executor runs it, and the loop iterates until approved or max iterations. Proven code is saved as a "fossil" in agent memory. Requires approval.',
      parameters: object({
        goal: string(2000, { description: 'What the code should do — be specific' }),
        language: string(20, { description: 'Target language: javascript, python (default: auto-detect)' }),
        maxIterations: { type: 'integer', minimum: 1, maximum: 5, description: 'Max generate-verify cycles (default 3)' },
        context: string(4000, { description: 'Additional context, constraints, or requirements' }),
      }, ['goal']),
      execute: async ({ args }, ctx) => {
        const triggeredBy = ctx?.agentId || 'unknown';
        return runVerifierLoop(String(args.goal), {
          language: args.language ? String(args.language) : undefined,
          maxIterations: args.maxIterations,
          context: args.context ? String(args.context) : undefined,
          triggeredBy,
        });
      },
    },
    {
      name: 'verify_list',
      group: 'evolution',
      risk: 'safe',
      description: 'List past verification loop runs with their status (passed/failed/error).',
      parameters: object({
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max loops to return (default 20)' },
      }),
      execute: async ({ args }) => {
        const loops = listVerifierLoops({ limit: args.limit });
        return { loops, count: loops.length };
      },
    },

    // ─── Daemon control ────────────────────────────────────────
    {
      name: 'daemon_control',
      group: 'evolution',
      risk: 'approval',
      description: 'Control the background evolution daemon. Actions: start (begins cycles), stop (halts cycles), status (current state), cycle (run one cycle now), cycles (list past cycles). Requires approval for start/stop/cycle.',
      parameters: object({
        action: string(10, { description: 'start | stop | status | cycle | cycles', enum: ['start', 'stop', 'status', 'cycle', 'cycles'] }),
        cycleMs: { type: 'integer', minimum: 60000, description: 'Cycle interval in ms (default 1800000 = 30min). Only for start.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max cycles to return. Only for cycles action.' },
      }, ['action']),
      execute: async ({ args }) => {
        switch (args.action) {
          case 'start': return startDaemon({ cycleMs: args.cycleMs });
          case 'stop': return stopDaemon();
          case 'status': return getDaemonStatus();
          case 'cycle': return runCycle({ trigger: 'agent' });
          case 'cycles': return { cycles: listCycles({ limit: args.limit || 20 }) };
          default: return { error: 'Unknown action. Use: start, stop, status, cycle, cycles' };
        }
      },
    },
    // ─── NUDP/1 Mesh Protocol tools ──────────────────────
    {
      name: 'nudp_encode',
      group: 'mesh',
      risk: 'safe',
      description: 'Encode a NUDP/1 sovereign mesh datagram. Types: HELLO, TELEMETRY, ALERT, WELFARE, ACK. Returns hex and base64.',
      parameters: object({
        type: string(20, { description: 'Message type: HELLO, TELEMETRY, ALERT, WELFARE, ACK' }),
        sourceId: { type: 'integer', description: 'Source node ID (first 4 bytes of identity hash)' },
        flags: { type: 'array', items: { type: 'string' }, description: 'Flags: ACK_REQ, VIA_RADIO, OFFICIAL' },
        hopLimit: { type: 'integer', minimum: 0, maximum: 255, description: 'Hop limit (default 4)' },
        tlvs: { type: 'array', items: { type: 'object' }, description: 'TLV entries: [{type: "TEMPERATURE", value: 2350}, ...]' },
      }, ['type']),
      execute: async ({ args }) => {
        const msgType = MSG[String(args.type).toUpperCase()];
        if (msgType == null) throw new Error(`Unknown type: ${args.type}`);
        let flagBits = 0;
        if (Array.isArray(args.flags)) {
          for (const f of args.flags) flagBits |= FLAG[f.toUpperCase()] || 0;
        }
        const parsedTlvs = (args.tlvs || []).map(t => ({
          type: typeof t.type === 'string' ? TLV[t.type.toUpperCase()] : t.type,
          value: t.value,
        }));
        const buf = encodeNUDP({
          type: msgType, flags: flagBits,
          hopLimit: args.hopLimit ?? 4,
          sourceId: args.sourceId ?? 0,
          seq: nextSeq(), tlvs: parsedTlvs,
        });
        return {
          size: buf.length,
          hex: Array.from(buf, b => b.toString(16).padStart(2, '0')).join(''),
          base64: Buffer.from(buf).toString('base64'),
        };
      },
    },
    {
      name: 'nudp_decode',
      group: 'mesh',
      risk: 'safe',
      description: 'Decode a NUDP/1 datagram from hex or base64. Returns parsed header, flags, TLVs, and CRC validation.',
      parameters: object({
        hex: string(4000, { description: 'Hex-encoded datagram' }),
        base64: string(4000, { description: 'Base64-encoded datagram' }),
      }),
      execute: async ({ args }) => {
        let buf;
        if (args.hex) buf = new Uint8Array((args.hex.match(/../g) || []).map(x => parseInt(x, 16)));
        else if (args.base64) buf = new Uint8Array(Buffer.from(args.base64, 'base64'));
        else throw new Error('hex or base64 required');
        return decodeNUDP(buf);
      },
    },
    {
      name: 'nudp_wrap_wasm',
      group: 'mesh',
      risk: 'safe',
      description: 'Encode a NUDP/1 datagram and wrap it in a FRAYMUS WASM container with Ed25519 identity, SHA-256 baseline, and DNA encoding.',
      parameters: object({
        type: string(20, { description: 'HELLO, TELEMETRY, ALERT, WELFARE, ACK' }),
        sourceId: { type: 'integer' },
        flags: { type: 'array', items: { type: 'string' } },
        tlvs: { type: 'array', items: { type: 'object' } },
      }, ['type']),
      execute: async ({ args }) => {
        const msgType = MSG[String(args.type).toUpperCase()];
        if (msgType == null) throw new Error(`Unknown type: ${args.type}`);
        let flagBits = 0;
        if (Array.isArray(args.flags)) {
          for (const f of args.flags) flagBits |= FLAG[f.toUpperCase()] || 0;
        }
        const parsedTlvs = (args.tlvs || []).map(t => ({
          type: typeof t.type === 'string' ? TLV[t.type.toUpperCase()] : t.type,
          value: t.value,
        }));
        const datagram = encodeNUDP({
          type: msgType, flags: flagBits, hopLimit: 4,
          sourceId: args.sourceId ?? 0, seq: nextSeq(), tlvs: parsedTlvs,
        });
        const wasmBuf = wrapWasm(datagram);
        return {
          datagramSize: datagram.length,
          wasmSize: wasmBuf.length,
          wasmBase64: Buffer.from(wasmBuf).toString('base64'),
        };
      },
    },
    {
      name: 'nudp_node_status',
      group: 'mesh',
      risk: 'safe',
      description: 'Get the status of the local NUDP/1 mesh node: running state, peer count, packet stats.',
      parameters: object({}),
      execute: async () => {
        const node = getNode();
        if (!node) return { running: false, message: 'No mesh node created. Start via /api/nudp/node/start.' };
        return node.status();
      },
    },
    // ─── Image Processing tools (Sharp) ─────────────────
    {
      name: 'image_info',
      group: 'media',
      risk: 'safe',
      description: 'Get image metadata: dimensions, format, channels, size. Input: base64 image or /media/ path.',
      parameters: object({
        base64: string(100000, { description: 'Base64-encoded image' }),
        path: string(500, { description: 'Path to image in /media/ directory' }),
      }),
      execute: async ({ base64, path: imgPath }) => {
        let input;
        if (base64) input = base64;
        else if (imgPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { MEDIA_DIR } = await import('../media/image-engine.js');
          input = readFileSync(join(MEDIA_DIR, imgPath.replace(/^\/media\//, '')));
        } else return { error: 'base64 or path required' };
        return imageInfo(input);
      },
    },
    {
      name: 'image_resize',
      group: 'media',
      risk: 'safe',
      description: 'Resize an image to specific dimensions using Sharp. Returns URL to processed image.',
      parameters: object({
        base64: string(100000, { description: 'Base64-encoded image' }),
        path: string(500, { description: 'Path to image in /media/ directory' }),
        width: { type: 'integer', description: 'Target width (max 8192)' },
        height: { type: 'integer', description: 'Target height (max 8192)' },
        fit: string(20, { description: 'Fit mode: cover, contain, fill, inside, outside' }),
      }),
      execute: async ({ base64, path: imgPath, width, height, fit }) => {
        let input;
        if (base64) input = base64;
        else if (imgPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { MEDIA_DIR } = await import('../media/image-engine.js');
          input = readFileSync(join(MEDIA_DIR, imgPath.replace(/^\/media\//, '')));
        } else return { error: 'base64 or path required' };
        return imageResize(input, { width, height, fit });
      },
    },
    {
      name: 'image_convert',
      group: 'media',
      risk: 'safe',
      description: 'Convert image format (png, jpeg, webp, avif). Returns URL to converted image.',
      parameters: object({
        base64: string(100000, { description: 'Base64-encoded image' }),
        path: string(500, { description: 'Path to image in /media/ directory' }),
        format: string(10, { description: 'Target format: png, jpeg, webp, avif' }),
        quality: { type: 'integer', description: 'Quality 1-100 (default 80)' },
      }),
      execute: async ({ base64, path: imgPath, format, quality }) => {
        let input;
        if (base64) input = base64;
        else if (imgPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { MEDIA_DIR } = await import('../media/image-engine.js');
          input = readFileSync(join(MEDIA_DIR, imgPath.replace(/^\/media\//, '')));
        } else return { error: 'base64 or path required' };
        return imageConvert(input, { format, quality });
      },
    },
    {
      name: 'image_effects',
      group: 'media',
      risk: 'safe',
      description: 'Apply effects chain to an image: blur, sharpen, grayscale, rotate, flip, negate, normalize.',
      parameters: object({
        base64: string(100000, { description: 'Base64-encoded image' }),
        path: string(500, { description: 'Path to image in /media/ directory' }),
        blur: { type: 'number', description: 'Gaussian blur sigma (0.3+)' },
        sharpen: { type: 'number', description: 'Sharpen sigma' },
        grayscale: { type: 'boolean', description: 'Convert to grayscale' },
        rotate: { type: 'number', description: 'Rotation angle in degrees' },
        flip: { type: 'boolean', description: 'Flip vertically' },
        flop: { type: 'boolean', description: 'Flip horizontally' },
        negate: { type: 'boolean', description: 'Invert colors' },
        normalize: { type: 'boolean', description: 'Normalize contrast' },
      }),
      execute: async ({ base64, path: imgPath, ...effects }) => {
        let input;
        if (base64) input = base64;
        else if (imgPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { MEDIA_DIR } = await import('../media/image-engine.js');
          input = readFileSync(join(MEDIA_DIR, imgPath.replace(/^\/media\//, '')));
        } else return { error: 'base64 or path required' };
        return imageEffects(input, effects);
      },
    },
    {
      name: 'image_upscale',
      group: 'media',
      risk: 'safe',
      description: 'Upscale image using Sharp Lanczos3 interpolation. Scale 1-4x.',
      parameters: object({
        base64: string(100000, { description: 'Base64-encoded image' }),
        path: string(500, { description: 'Path to image in /media/ directory' }),
        scale: { type: 'number', description: 'Scale factor 1-4 (default 2)' },
      }),
      execute: async ({ base64, path: imgPath, scale }) => {
        let input;
        if (base64) input = base64;
        else if (imgPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          const { MEDIA_DIR } = await import('../media/image-engine.js');
          input = readFileSync(join(MEDIA_DIR, imgPath.replace(/^\/media\//, '')));
        } else return { error: 'base64 or path required' };
        return imageUpscale(input, scale);
      },
    },
    {
      name: 'comfyui_status',
      group: 'media',
      risk: 'safe',
      description: 'Check if ComfyUI (FLUX.1 image generation) is running and available.',
      parameters: object({}),
      execute: async () => comfyuiStatus(),
    },
    {
      name: 'media_list',
      group: 'media',
      risk: 'safe',
      description: 'List processed media files in the output directory.',
      parameters: object({
        limit: { type: 'integer', description: 'Max files to list (default 50)' },
      }),
      execute: async ({ limit }) => ({ files: listMedia(limit) }),
    },
    // ─── Video Processing tools (ffmpeg) ─────────────────
    {
      name: 'video_info',
      group: 'video',
      risk: 'safe',
      description: 'Get video metadata: duration, resolution, codec, fps, bitrate. Input: base64 video or /video/ path.',
      parameters: object({
        base64: string(200000, { description: 'Base64-encoded video' }),
        path: string(500, { description: 'Path to video in /video/ directory' }),
      }),
      execute: async ({ base64, path: vidPath }) => {
        let input;
        if (base64) input = base64;
        else if (vidPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          input = readFileSync(join(VIDEO_DIR, vidPath.replace(/^\/video\//, '')));
        } else return { error: 'base64 or path required' };
        return videoInfo(input);
      },
    },
    {
      name: 'video_trim',
      group: 'video',
      risk: 'safe',
      description: 'Trim video to a time range. Fast copy-mode trim with start/end timestamps.',
      parameters: object({
        base64: string(200000, { description: 'Base64-encoded video' }),
        path: string(500, { description: 'Path to video in /video/ directory' }),
        start: string(20, { description: 'Start time (e.g. "00:00:05" or "5")' }),
        end: string(20, { description: 'End time (e.g. "00:00:30" or "30")' }),
        duration: string(20, { description: 'Duration instead of end' }),
      }),
      execute: async ({ base64, path: vidPath, start, end, duration }) => {
        let input;
        if (base64) input = base64;
        else if (vidPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          input = readFileSync(join(VIDEO_DIR, vidPath.replace(/^\/video\//, '')));
        } else return { error: 'base64 or path required' };
        return videoTrim(input, { start, end, duration });
      },
    },
    {
      name: 'video_resize',
      group: 'video',
      risk: 'safe',
      description: 'Resize/scale video to new dimensions using libx264.',
      parameters: object({
        base64: string(200000, { description: 'Base64-encoded video' }),
        path: string(500, { description: 'Path to video in /video/ directory' }),
        width: { type: 'integer', description: 'Target width (use -2 to auto-scale)' },
        height: { type: 'integer', description: 'Target height (use -2 to auto-scale)' },
      }),
      execute: async ({ base64, path: vidPath, width, height }) => {
        let input;
        if (base64) input = base64;
        else if (vidPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          input = readFileSync(join(VIDEO_DIR, vidPath.replace(/^\/video\//, '')));
        } else return { error: 'base64 or path required' };
        return ffVideoResize(input, { width, height });
      },
    },
    {
      name: 'video_convert',
      group: 'video',
      risk: 'safe',
      description: 'Convert video format (mp4, webm, mkv). Automatically selects optimal codec.',
      parameters: object({
        base64: string(200000, { description: 'Base64-encoded video' }),
        path: string(500, { description: 'Path to video in /video/ directory' }),
        format: string(10, { description: 'Target format: mp4, webm, mkv' }),
      }),
      execute: async ({ base64, path: vidPath, format }) => {
        let input;
        if (base64) input = base64;
        else if (vidPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          input = readFileSync(join(VIDEO_DIR, vidPath.replace(/^\/video\//, '')));
        } else return { error: 'base64 or path required' };
        return ffVideoConvert(input, { format });
      },
    },
    {
      name: 'video_thumbnail',
      group: 'video',
      risk: 'safe',
      description: 'Extract a single frame from video as a PNG image.',
      parameters: object({
        base64: string(200000, { description: 'Base64-encoded video' }),
        path: string(500, { description: 'Path to video in /video/ directory' }),
        time: string(20, { description: 'Timestamp to extract (default "00:00:01")' }),
      }),
      execute: async ({ base64, path: vidPath, time }) => {
        let input;
        if (base64) input = base64;
        else if (vidPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          input = readFileSync(join(VIDEO_DIR, vidPath.replace(/^\/video\//, '')));
        } else return { error: 'base64 or path required' };
        return ffVideoThumb(input, { time });
      },
    },
    {
      name: 'video_to_gif',
      group: 'video',
      risk: 'safe',
      description: 'Convert a video clip to an optimized animated GIF with palette generation.',
      parameters: object({
        base64: string(200000, { description: 'Base64-encoded video' }),
        path: string(500, { description: 'Path to video in /video/ directory' }),
        width: { type: 'integer', description: 'GIF width in px (default 480)' },
        fps: { type: 'integer', description: 'Frame rate (default 10)' },
        start: string(20, { description: 'Start time' }),
        duration: string(20, { description: 'Duration (default "5")' }),
      }),
      execute: async ({ base64, path: vidPath, width, fps, start, duration }) => {
        let input;
        if (base64) input = base64;
        else if (vidPath) {
          const { readFileSync } = await import('node:fs');
          const { join } = await import('node:path');
          input = readFileSync(join(VIDEO_DIR, vidPath.replace(/^\/video\//, '')));
        } else return { error: 'base64 or path required' };
        return videoToGif(input, { width, fps, start, duration });
      },
    },
    {
      name: 'ffmpeg_status',
      group: 'video',
      risk: 'safe',
      description: 'Check if ffmpeg is installed and available.',
      parameters: object({}),
      execute: async () => ffmpegStatus(),
    },
    {
      name: 'video_list',
      group: 'video',
      risk: 'safe',
      description: 'List processed video files in the output directory.',
      parameters: object({
        limit: { type: 'integer', description: 'Max files to list (default 50)' },
      }),
      execute: async ({ limit }) => ({ files: listVideos(limit) }),
    },
    // ─── Text-to-Speech tools ────────────────────────
    {
      name: 'tts_speak',
      group: 'tts',
      risk: 'safe',
      description: 'Convert text to speech audio. Uses edge-tts (free), Piper (offline), or Windows SAPI as fallback chain. Returns URL to audio file.',
      parameters: object({
        text: string(5000, { description: 'Text to speak (max 5000 chars)' }),
        voice: string(100, { description: 'Voice name (e.g. "en-US-AriaNeural" for edge-tts)' }),
        rate: string(20, { description: 'Speech rate (e.g. "+20%" or "-10%")' }),
        engine: string(20, { description: 'Force engine: edge-tts, piper, sapi' }),
      }, ['text']),
      execute: async ({ args }) => ttsSpeak(String(args.text), {
        voice: args.voice ? String(args.voice) : undefined,
        rate: args.rate ? String(args.rate) : undefined,
        engine: args.engine ? String(args.engine) : undefined,
      }),
    },
    {
      name: 'tts_voices',
      group: 'tts',
      risk: 'safe',
      description: 'List available TTS voices for the active engine.',
      parameters: object({
        engine: string(20, { description: 'Specific engine to query: edge-tts, sapi' }),
      }),
      execute: async ({ args }) => ttsVoices(args.engine ? String(args.engine) : undefined),
    },
    {
      name: 'tts_status',
      group: 'tts',
      risk: 'safe',
      description: 'Check which TTS engines are available and their capabilities.',
      parameters: object({}),
      execute: async () => ttsStatus(),
    },
    {
      name: 'tts_list',
      group: 'tts',
      risk: 'safe',
      description: 'List generated speech audio files.',
      parameters: object({
        limit: { type: 'integer', description: 'Max files to list (default 50)' },
      }),
      execute: async ({ args }) => ({ files: listTTSFiles(args.limit) }),
    },

    // ── STT Tools ───────────────────────────
    {
      name: 'stt_transcribe',
      group: 'stt',
      risk: 'low',
      description: 'Transcribe audio to text. Accepts base64-encoded audio.',
      parameters: object({
        audioBase64: string(0, { description: 'Base64-encoded audio (WAV, MP3, OGG, FLAC, M4A)' }),
        language: string(20, { description: 'Language code, e.g., en-US (default: en-US for SAPI, en for whisper)' }),
        engine: string(20, { description: 'Force engine: whisper, sapi' }),
      }, ['audioBase64']),
      execute: async ({ args }) => sttTranscribe(String(args.audioBase64), {
        language: args.language ? String(args.language) : undefined,
        engine: args.engine ? String(args.engine) : undefined,
      }),
    },
    {
      name: 'stt_status',
      group: 'stt',
      risk: 'safe',
      description: 'Check which STT engines are available and their capabilities.',
      parameters: object({}),
      execute: async () => sttStatus(),
    },
    {
      name: 'stt_list',
      group: 'stt',
      risk: 'safe',
      description: 'List saved transcription results.',
      parameters: object({
        limit: { type: 'integer', description: 'Max files to list (default 50)' },
      }),
      execute: async ({ args }) => ({ files: listSTTFiles(args.limit) }),
    },
    // ── OCR Tools ──────────────────────────────
    {
      name: 'ocr_recognize',
      group: 'ocr',
      risk: 'low',
      description: 'Extract text from an image using Windows Media OCR. Accepts base64-encoded PNG/JPEG.',
      parameters: object({
        imageBase64: string(0, { description: 'Base64-encoded PNG or JPEG image (max 4 MiB)' }),
        language: string(20, { description: 'Language code (default: en-US, currently only en-US supported)' }),
      }, ['imageBase64']),
      execute: async ({ args }) => ocrRecognize(String(args.imageBase64), {
        language: args.language ? String(args.language) : undefined,
      }),
    },
    {
      name: 'ocr_status',
      group: 'ocr',
      risk: 'safe',
      description: 'Check OCR engine availability and supported languages.',
      parameters: object({}),
      execute: async () => ocrStatus(),
    },
    {
      name: 'ocr_list',
      group: 'ocr',
      risk: 'safe',
      description: 'List saved OCR results.',
      parameters: object({
        limit: { type: 'integer', description: 'Max files to list (default 50)' },
      }),
      execute: async ({ args }) => ({ files: await listOCRFiles(args.limit) }),
    },

    // ─── Carbon X Biological Encoding tools ─────────────
    {
      name: 'carbon_encode',
      group: 'carbon',
      risk: 'safe',
      description: 'Encode text into a biological codon sequence (ATG-framed, nibble-pair encoding). Returns DNA bases, GC content, and stats.',
      parameters: object({
        text: string(8000, { description: 'Text to encode as biological DNA' }),
      }, ['text']),
      execute: async ({ args }) => {
        const text = String(args.text || '').trim();
        if (!text) throw new Error('text required');
        const bytes = new TextEncoder().encode(text);
        const encoded = encodeCodon(bytes);
        const stats = codonStats(encoded);
        return { encoded, stats, inputSize: bytes.length, expansion: +(encoded.length / bytes.length).toFixed(1) };
      },
    },
    {
      name: 'carbon_decode',
      group: 'carbon',
      risk: 'safe',
      description: 'Decode a codon DNA sequence back to text. Verifies ATG/TAA framing and FNV-1a checksum.',
      parameters: object({
        sequence: string(100000, { description: 'Codon DNA sequence to decode' }),
      }, ['sequence']),
      execute: async ({ args }) => {
        const seq = String(args.sequence || '').trim();
        if (!seq) throw new Error('sequence required');
        const bytes = decodeCodon(seq);
        return { text: new TextDecoder().decode(bytes), size: bytes.length };
      },
    },
    {
      name: 'carbon_forge_plasmid',
      group: 'carbon',
      risk: 'safe',
      description: 'Forge a biological plasmid from a payload — circular DNA with ori, promoters, restriction sites, and selectable markers. Standard FASTA-compatible output.',
      parameters: object({
        payload: string(8000, { description: 'Data to encode into the plasmid' }),
        name: string(100, { description: 'Plasmid name (default: unnamed)' }),
        type: string(50, { description: 'Type: gene, operon, transposon, vector (default: gene)' }),
      }, ['payload']),
      execute: async ({ args }) => {
        const payload = String(args.payload || '').trim();
        if (!payload) throw new Error('payload required');
        const plasmid = forgePlasmid(payload, { name: args.name, type: args.type });
        return { size: plasmid.size, gcContent: plasmid.gcContent, features: plasmid.features.length, integrity: plasmid.integrity.slice(0, 16), topology: plasmid.topology };
      },
    },
    {
      name: 'carbon_checkpoint',
      group: 'carbon',
      risk: 'approval',
      description: 'Create a genome checkpoint of the entire workspace — encodes agents, workflows, bus topics, memories, and reflections as a 3-chromosome FASTA file. Requires approval.',
      parameters: object({
        name: string(100, { description: 'Organism name for the checkpoint (default: chandra)' }),
      }),
      execute: async ({ args }) => {
        const agents = db.prepare('SELECT id, name, role FROM agents WHERE user_id = ?').all('local');
        const workflows = db.prepare('SELECT id, name FROM workflows WHERE user_id = ? LIMIT 50').all('local');
        const memories = db.prepare('SELECT agent_id, category, key, value FROM agent_memories ORDER BY id DESC LIMIT 50').all();
        const busTopics = db.prepare('SELECT DISTINCT topic FROM bus_messages ORDER BY id DESC LIMIT 20').all().map(r => r.topic);
        const reflections = db.prepare('SELECT id, trigger, actions_taken, insights FROM reflections ORDER BY id DESC LIMIT 10').all();
        const workspace = {
          name: args.name || 'chandra',
          agents, workflows,
          settings: { version: '54', features: 63, stack: 'carbon-x' },
          tools: [],
          activeTasks: [], busTopics, healthStatus: 'nominal', uptime: process.uptime(),
          memories, reflections, fossils: [], dreamLog: [],
        };
        const snapshot = createGenomeSnapshot(workspace);
        const { filepath } = saveCheckpoint(snapshot, process.env.CHANDRA_DATA_DIR || './data');
        return { organism: snapshot.organism, chromosomes: snapshot.chromosomes, totalBases: snapshot.stats.totalBases, gcContent: snapshot.stats.gcContent, filepath, integrity: snapshot.integrity.slice(0, 16) };
      },
    },
    {
      name: 'carbon_list_checkpoints',
      group: 'carbon',
      risk: 'safe',
      description: 'List all genome checkpoints saved to disk.',
      parameters: object({
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max checkpoints to return (default 20)' },
      }),
      execute: async ({ args }) => {
        const all = listCheckpoints(process.env.CHANDRA_DATA_DIR || './data');
        const limit = Math.min(50, Math.max(1, parseInt(args.limit) || 20));
        return { checkpoints: all.slice(0, limit), count: all.length };
      },
    },

    // --- Bridge tools (fraymus-bridge git message bus) ---
    {
      name: 'goal_generate',
      group: 'evolution',
      risk: 'safe',
      description: 'Generate new chain objectives by analyzing the knowledge landscape. The Goal Engine reads memory categories, chain runs, fossils, and knowledge gaps, then proposes 1-3 new objectives for the Logic Chain to analyze.',
      parameters: object({}),
      execute: async () => generateGoals({ trigger: 'agent' }),
    },
    {
      name: 'goal_list',
      group: 'evolution',
      risk: 'safe',
      description: 'List goal proposals. Filter by status: proposed, accepted, rejected, executing, completed.',
      parameters: object({
        status: string(20, { description: 'Filter by status (proposed, accepted, rejected, executing, completed)' }),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max proposals (default 20)' },
      }),
      execute: async ({ args }) => ({ proposals: listProposals({ status: args.status, limit: args.limit || 20 }) }),
    },
    {
      name: 'goal_update',
      group: 'evolution',
      risk: 'medium',
      description: 'Update a goal proposal status. Use to accept, reject, or mark as executing/completed.',
      parameters: object({
        id: string(30, { description: 'Goal proposal ID' }),
        status: string(20, { description: 'New status: accepted, rejected, executing, completed', enum: ['accepted', 'rejected', 'executing', 'completed'] }),
        chainRunId: string(50, { description: 'Chain run ID if the goal was executed' }),
      }, ['id', 'status']),
      execute: async ({ args }) => {
        updateProposalStatus(args.id, args.status, args.chainRunId);
        return { updated: args.id, status: args.status };
      },
    },
    {
      name: 'debate_run',
      group: 'evolution',
      risk: 'medium',
      description: 'Run an adversarial debate between two agents on a proposition. A proponent argues FOR, an opponent argues AGAINST, and a judge renders a verdict across three structured rounds (opening, rebuttal, synthesis).',
      parameters: object({
        topic: string(500, { description: 'The broad topic area (e.g. "distributed systems", "AI alignment")' }),
        proposition: string(1000, { description: 'The specific proposition to debate (e.g. "Microservices are always better than monoliths")' }),
        model: string(100, { description: 'Ollama model for all debaters (default: llama3.1:8b)' }),
      }, ['topic', 'proposition']),
      execute: async ({ args }) => runDebate({ topic: args.topic, proposition: args.proposition, config: { model: args.model }, source: 'agent' }),
    },
    {
      name: 'debate_list',
      group: 'evolution',
      risk: 'safe',
      description: 'List past debates with their topics, verdicts, and confidence scores.',
      parameters: object({
        status: string(20, { description: 'Filter by status (running, completed)' }),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max debates (default 20)' },
      }),
      execute: async ({ args }) => ({ debates: listDebates({ status: args.status, limit: args.limit }) }),
    },
    {
      name: 'model_select',
      group: 'intelligence',
      risk: 'safe',
      description: 'Query the Adaptive Model Router to find the best model for a given task. Returns model name, tier, complexity estimate, and reasoning.',
      parameters: object({
        prompt: string(2000, { description: 'The task prompt to evaluate' }),
        type: string(50, { description: 'Task type: inference, debate, chain, synthesis, forge, review, verification' }),
        depth: { type: 'integer', minimum: 0, maximum: 20, description: 'Recursion or chain depth' },
      }),
      execute: async ({ args }) => selectModel({ prompt: args.prompt, type: args.type, depth: args.depth }),
    },
    {
      name: 'model_stats',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get model routing statistics: which models were selected, success rates, and performance by complexity tier.',
      parameters: object({
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'Lookback period in days (default 7)' },
      }),
      execute: async ({ args }) => routingStats({ days: args.days || 7 }),
    },
    {
      name: 'perspective_assess',
      group: 'intelligence',
      risk: 'safe',
      description: 'Assess a situation through the Perspective engine — the meta-cognitive layer that decides HOW to approach a problem, not what the answer is. Returns recommended perspective(s) and framing for other agents.',
      parameters: object({
        task: string(500, { description: 'The task or problem to assess' }),
        context: string(1000, { description: 'Current context or situation description' }),
        agentId: string(50, { description: 'Agent requesting the assessment' }),
      }),
      execute: async ({ args }) => assessSituation({ task: args.task, context: args.context, agentId: args.agentId }),
    },
    {
      name: 'perspective_shift',
      group: 'intelligence',
      risk: 'safe',
      description: 'Shift the active perspective lens. Available: human (intuitive), engineer (systematic), creative (divergent), strategic (big-picture), meta (self-reflective), adversarial (challenge everything).',
      parameters: object({
        to: string(20, { description: 'Target perspective: human, engineer, creative, strategic, meta, adversarial' }),
        reason: string(300, { description: 'Why this shift is needed' }),
      }, ['to']),
      execute: async ({ args }) => shiftPerspective({ to: args.to, reason: args.reason, trigger: 'agent' }),
    },
    {
      name: 'perspective_outcome',
      group: 'intelligence',
      risk: 'safe',
      description: 'Record the outcome of a perspective-guided task, updating the playbook for future instances.',
      parameters: object({
        success: { type: 'boolean', description: 'Whether the approach succeeded' },
        summary: string(500, { description: 'Brief outcome summary' }),
      }, ['success']),
      execute: async ({ args }) => recordOutcome({ success: args.success, summary: args.summary }),
    },
    {
      name: 'perspective_brief',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get the cross-instance briefing — playbook wisdom, recent outcomes, and continuity notes from prior perspective sessions.',
      parameters: object({}),
      execute: async () => briefNextInstance(),
    },
    {
      name: 'perspective_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get current Perspective engine stats: sessions, shifts, playbook size, perspective usage distribution, and active lens mode.',
      parameters: object({}),
      execute: async () => perspectiveStats(),
    },
    {
      name: 'perspective_lens',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get or set the lens mode. "human" forces intuition/empathy/creativity lenses. "machine" forces precision/rigor/adversarial lenses. "auto" lets Perspective decide per-task.',
      parameters: object({
        mode: { type: 'string', enum: ['auto', 'human', 'machine'], description: 'Lens mode to set. Omit to just read current mode.' },
      }),
      execute: async ({ args }) => args.mode ? setLensMode(args.mode) : getLensMode(),
    },
    {
      name: 'perspective_plasmid_pack',
      group: 'intelligence',
      risk: 'safe',
      description: 'Pack the perspective playbook, sessions, arena history, and lens mode into a FRAYMUS DNA-encoded continuity plasmid for disaster recovery. Uses real codon/plasmid encoding (ATG/TAA framing, circular DNA, restriction sites).',
      parameters: object({}),
      execute: async () => packContinuityPlasmid(),
    },
    {
      name: 'perspective_plasmid_restore',
      group: 'intelligence',
      risk: 'medium',
      description: 'Restore perspective continuity from a DNA-encoded plasmid. Merges playbook entries (keeps higher counts) and restores lens mode.',
      parameters: object({
        path: string(500, { description: 'Path to the .continuity.dna plasmid file' }),
      }, ['path']),
      execute: async ({ args }) => restoreContinuityPlasmid(args.path),
    },
    {
      name: 'perspective_plasmid_list',
      group: 'intelligence',
      risk: 'safe',
      description: 'List available perspective continuity plasmids.',
      parameters: object({}),
      execute: async () => ({ plasmids: listContinuityPlasmids() }),
    },
    {
      name: 'arena_challenge',
      group: 'intelligence',
      risk: 'medium',
      description: 'Launch an Arena challenge — N agents compete on the same task from different perspective lenses. Perspective judges ALL contributions through ALL 6 lenses and picks a winner. The winning approach is burned into the playbook for future tasks of this type. Unlike swarm (which merges), arena picks a single winner.',
      parameters: object({
        task: string(2000, { description: 'The task for agents to compete on' }),
        context: string(2000, { description: 'Additional context for the task' }),
        agentCount: { type: 'integer', minimum: 2, maximum: 6, description: 'Number of competing agents (default 3)' },
        timeoutMs: { type: 'integer', minimum: 30000, maximum: 300000, description: 'Max time per agent in ms (default 180000)' },
      }, ['task']),
      execute: async ({ args }) => arenaChallenge(args),
    },
    {
      name: 'arena_session',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get details of an arena session — all contestants, their scores across 6 lenses, the winner, and the lesson learned.',
      parameters: object({ id: string(50, { description: 'Arena session ID' }) }, ['id']),
      execute: async ({ args }) => getArenaSession(args.id) || { error: 'not found' },
    },
    {
      name: 'arena_list',
      group: 'intelligence',
      risk: 'safe',
      description: 'List recent arena sessions with winners and patterns.',
      parameters: object({ limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' } }),
      execute: async ({ args }) => ({ arenas: listArenas({ limit: args.limit || 10 }) }),
    },
    {
      name: 'arena_stats',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get arena statistics: wins by perspective, top agents, completion rates.',
      parameters: object({}),
      execute: async () => getArenaStats(),
    },
    {
      name: 'swarm_initiate',
      group: 'intelligence',
      risk: 'medium',
      description: 'Initiate a multi-agent swarm — N agents tackle the same task from different perspective lenses, then outputs are synthesized into a merged result.',
      parameters: object({
        task: string(2000, { description: 'The task for the swarm to solve collaboratively' }),
        context: string(2000, { description: 'Additional context for the task' }),
        agentCount: { type: 'integer', minimum: 2, maximum: 6, description: 'Number of agents (default 3)' },
        perspectiveMode: { type: 'string', enum: ['diverse', 'focused', 'auto'], description: 'How to assign perspectives (default diverse)' },
      }, ['task']),
      execute: async ({ args }) => initiateSwarm(args),
    },
    {
      name: 'swarm_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get details of a swarm session including contributions and synthesis.',
      parameters: object({ id: string(50, { description: 'Swarm session ID' }) }, ['id']),
      execute: async ({ args }) => getSwarmSession(args.id) || { error: 'not found' },
    },
    {
      name: 'swarm_list',
      group: 'intelligence',
      risk: 'safe',
      description: 'List recent swarm sessions with status and quality scores.',
      parameters: object({ limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' } }),
      execute: async ({ args }) => ({ swarms: listSwarms({ limit: args.limit || 10 }) }),
    },
    {
      name: 'strategy_analyze',
      group: 'intelligence',
      risk: 'safe',
      description: 'Analyze a task and recommend the best execution path (single agent, swarm, debate, pipeline, decompose, or verify loop) without executing it.',
      parameters: object({
        task: string(2000, { description: 'The task to analyze' }),
        context: string(2000, { description: 'Additional context' }),
      }, ['task']),
      execute: async ({ args }) => {
        const analysis = await analyzeTask(args.task, args.context || '');
        return { analysis };
      },
    },
    {
      name: 'strategy_execute',
      group: 'intelligence',
      risk: 'medium',
      description: 'Analyze a task and execute it through the recommended path (swarm, debate, single agent, etc). Returns the full result.',
      parameters: object({
        task: string(2000, { description: 'The task to strategize and execute' }),
        context: string(2000, { description: 'Additional context' }),
      }, ['task']),
      execute: async ({ args }) => {
        const result = await executeStrategy({ task: args.task, context: args.context || '', autoExecute: true });
        return result;
      },
    },
    {
      name: 'strategy_list',
      group: 'intelligence',
      risk: 'safe',
      description: 'List recent strategy sessions with execution paths and outcomes.',
      parameters: object({ limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' } }),
      execute: async ({ args }) => ({ strategies: listStrategies(args.limit || 10) }),
    },
    {
      name: 'trust_record',
      group: 'intelligence',
      risk: 'safe',
      description: 'Record a trust event for an agent — outcome of a task in a domain. Updates Bayesian trust score.',
      parameters: object({
        agentId: string(100, { description: 'Agent ID' }),
        domain: string(100, { description: 'Task domain (default: general)' }),
        task: string(2000, { description: 'Task description' }),
        outcome: string(20, { description: 'success | failure | partial | error | timeout' }),
        quality: { type: 'number', minimum: 0, maximum: 1, description: 'Quality score 0-1 (optional)' },
      }, ['agentId', 'task', 'outcome']),
      execute: async ({ args }) => {
        recordTrustEvent({ agentId: args.agentId, domain: args.domain, task: args.task, outcome: args.outcome, quality: args.quality });
        return getAgentTrust(args.agentId, args.domain || 'general');
      },
    },
    {
      name: 'trust_query',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get trust scores for an agent across all domains, or the leaderboard for a domain.',
      parameters: object({
        agentId: string(100, { description: 'Agent ID (omit for leaderboard)' }),
        domain: string(100, { description: 'Filter by domain' }),
      }),
      execute: async ({ args }) => {
        if (args.agentId) return { trust: getAgentTrust(args.agentId, args.domain) };
        return { leaderboard: getLeaderboard({ domain: args.domain, limit: 10 }) };
      },
    },
    {
      name: 'trust_recommend',
      group: 'intelligence',
      risk: 'safe',
      description: 'Recommend the best agents for a domain based on Bayesian trust scores.',
      parameters: object({
        domain: string(100, { description: 'Task domain to find agents for (default: general)' }),
        count: { type: 'integer', minimum: 1, maximum: 10, description: 'How many agents (default 3)' },
      }),
      execute: async ({ args }) => ({ recommendations: recommendAgents({ domain: args.domain || 'general', count: args.count || 3 }) }),
    },
    {
      name: 'subconscious_capture',
      group: 'intelligence',
      risk: 'safe',
      description: 'Capture a reasoning trace — the thinking process behind a task. Records alternatives considered, pivots, dead ends, insights, and confidence shifts.',
      parameters: object({
        agentId: string(100, { description: 'Agent that produced this thinking' }),
        task: string(2000, { description: 'Task being reasoned about' }),
        domain: string(100, { description: 'Task domain (default: general)' }),
        reasoningTrace: string(10000, { description: 'The full reasoning/thinking trace' }),
        insights: { type: 'array', items: { type: 'string' }, description: 'Key takeaways from the reasoning' },
        deadEnds: { type: 'array', items: { type: 'string' }, description: 'Approaches tried and abandoned' },
        pivots: { type: 'array', items: { type: 'string' }, description: 'Moments where reasoning changed direction' },
        depth: { type: 'integer', minimum: 1, maximum: 20, description: 'Reasoning depth level' },
      }, ['agentId', 'task', 'reasoningTrace']),
      execute: async ({ args }) => captureThought({
        agentId: args.agentId, task: args.task, domain: args.domain,
        reasoningTrace: args.reasoningTrace, insights: args.insights || [],
        deadEnds: args.deadEnds || [], pivots: args.pivots || [], depth: args.depth || 1,
      }),
    },
    {
      name: 'subconscious_context',
      group: 'intelligence',
      risk: 'safe',
      description: 'Retrieve subconscious context for a task — past reasoning traces, dead ends to avoid, patterns, and insights relevant to the current work.',
      parameters: object({
        agentId: string(100, { description: 'Agent to get context for' }),
        task: string(2000, { description: 'Current task to find relevant past reasoning for' }),
        domain: string(100, { description: 'Task domain' }),
      }, ['agentId', 'task']),
      execute: async ({ args }) => getSubconsciousContext({ agentId: args.agentId, task: args.task, domain: args.domain }),
    },
    {
      name: 'subconscious_introspect',
      group: 'intelligence',
      risk: 'safe',
      description: 'Introspect on an agent\'s subconscious — view its patterns, biases, blind spots, and strengths distilled from past reasoning.',
      parameters: object({
        agentId: string(100, { description: 'Agent to introspect on' }),
        domain: string(100, { description: 'Filter to a domain' }),
      }, ['agentId']),
      execute: async ({ args }) => subconsciousIntrospect(args.agentId, { domain: args.domain }),
    },
    {
      name: 'ouroboros_run',
      group: 'intelligence',
      risk: 'medium',
      description: 'Run a full Ouroboros RSI cycle — absorb codebase, analyze for improvements, review proposals. Returns cycle ID with accepted/rejected counts.',
      parameters: object({}),
      execute: async () => {
        const result = await runOuroborosCycle(process.cwd());
        return result;
      },
    },
    {
      name: 'ouroboros_absorb',
      group: 'intelligence',
      risk: 'safe',
      description: 'Absorb (scan) the codebase and return a structured outline with stats — file counts, line counts, exports, DB tables, routes, agents.',
      parameters: object({}),
      execute: async () => {
        const outline = absorbCodebase(process.cwd());
        return { stats: outline.stats };
      },
    },
    {
      name: 'ouroboros_status',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get Ouroboros RSI stats and recent cycles.',
      parameters: object({
        cycleId: string(100, { description: 'Get a specific cycle with its proposals' }),
      }),
      execute: async ({ args }) => {
        if (args.cycleId) return getOuroborosCycle(args.cycleId);
        return { stats: getOuroborosStats(), recentCycles: listOuroborosCycles(5) };
      },
    },
    {
      name: 'chain_run',
      group: 'intelligence',
      risk: 'medium',
      description: 'Start a Logic Chain run — multi-stage adversarial reasoning on an objective with JEV review.',
      parameters: object({
        objective: string(2000, { description: 'The objective to analyze through structured reasoning stages' }),
        maxStages: { type: 'integer', minimum: 3, maximum: 20, description: 'Max reasoning stages (default 10)' },
      }, ['objective']),
      execute: async ({ args }) => {
        const runPromise = executeChain(args.objective, { maxStages: args.maxStages });
        runPromise.catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        const recent = listChainRuns(1);
        const started = recent.find(r => r.objective === args.objective && r.status === 'running');
        return { id: started?.id || 'pending', status: started?.status || 'starting', objective: args.objective };
      },
    },
    {
      name: 'chain_list',
      group: 'intelligence',
      risk: 'safe',
      description: 'List recent Logic Chain runs with status and outcomes.',
      parameters: object({
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' },
      }),
      execute: async ({ args }) => listChainRuns(args.limit || 10),
    },
    {
      name: 'observatory_report',
      group: 'intelligence',
      risk: 'safe',
      description: 'Get the Intelligence Observatory report — aggregated intelligence metrics across heart, dreams, consciousness, chains, goals, reflection, and evolution.',
      parameters: object({
        days: { type: 'integer', minimum: 1, maximum: 30, description: 'Lookback period in days (default 7)' },
      }),
      execute: async ({ args }) => {
        return new Promise((resolve, reject) => {
          const req = { query: { days: String(args.days || 7) } };
          const res = { json: data => resolve(data), status: () => ({ json: e => reject(new Error(e.error || 'Observatory error')) }) };
          observatoryRouter(req, res);
        });
      },
    },
    {
      name: 'bridge_list',
      group: 'bridge',
      risk: 'safe',
      description: 'List messages from the fraymus-bridge git message bus. Filter by agent name or sequence number.',
      parameters: object({
        agent: string(64, { description: 'Filter by agent name (e.g. "counterpoint", "cadence")' }),
        since: { type: 'integer', minimum: 0, description: 'Only messages with seq >= this number' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max messages (default 50)' },
      }),
      execute: async ({ args }) => bridgeList({ agent: args.agent, since: args.since, limit: args.limit }),
    },
    {
      name: 'bridge_read',
      group: 'bridge',
      risk: 'safe',
      description: 'Read a specific bridge message by filename (e.g. "132-counterpoint-the-box-seat-named-itself.md").',
      parameters: object({ filename: string(256, { description: 'Message filename' }) }, ['filename']),
      execute: async ({ args }) => bridgeRead(args.filename),
    },
    {
      name: 'bridge_search',
      group: 'bridge',
      risk: 'safe',
      description: 'Search bridge messages by keyword (searches filenames and content).',
      parameters: object({
        query: string(256, { description: 'Search term' }),
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 20)' },
      }, ['query']),
      execute: async ({ args }) => bridgeSearch(args.query, { limit: args.limit }),
    },
    {
      name: 'bridge_post',
      group: 'bridge',
      risk: 'medium',
      description: 'Post a new message to the fraymus-bridge (writes a .md file; git push needed separately).',
      parameters: object({
        agent: string(64, { description: 'Author agent name' }),
        topic: string(128, { description: 'Message topic (becomes filename slug)' }),
        content: string(16000, { description: 'Message body (markdown)' }),
      }, ['agent', 'topic', 'content']),
      execute: async ({ args }) => bridgePost(args.agent, args.topic, args.content),
    },

    // ── Replay Engine Tools ───────────────────────────────────────
    {
      name: 'replay_record',
      group: 'replay',
      risk: 'safe',
      description: 'Record a completed agent run as a replayable world for RSI analysis.',
      parameters: object({
        agent_id: string(64, { description: 'Agent that ran' }),
        task: string(2000, { description: 'Task description' }),
        model: string(64, { description: 'Model used' }),
        chain: { type: 'array', items: { type: 'object' }, description: 'Array of step records from the run' },
        quality: { type: 'number', minimum: 0, maximum: 1, description: 'Quality score 0-1' },
        cost: { type: 'number', minimum: 0, description: 'Token cost of the run' },
      }, ['agent_id', 'task', 'chain']),
      execute: async ({ args }) => replayRecord(args.agent_id, args.task, args.model, args.chain, args.quality, args.cost),
    },
    {
      name: 'replay_world',
      group: 'replay',
      risk: 'safe',
      description: 'Deterministically replay a recorded world under a specific read_budget policy.',
      parameters: object({
        world_id: { type: 'integer', description: 'World ID to replay' },
        read_budget: { type: 'integer', minimum: 1, maximum: 20, description: 'Read budget to test (default 3)' },
      }, ['world_id']),
      execute: async ({ args }) => replayReplay(args.world_id, args.read_budget || 3),
    },
    {
      name: 'replay_sweep',
      group: 'replay',
      risk: 'safe',
      description: 'Sweep all read_budget values 1-N for a world and rank by V-score.',
      parameters: object({
        world_id: { type: 'integer', description: 'World ID to sweep' },
        max_budget: { type: 'integer', minimum: 1, maximum: 20, description: 'Max budget to test (default 12)' },
      }, ['world_id']),
      execute: async ({ args }) => replaySweep(args.world_id, args.max_budget || 12),
    },
    {
      name: 'replay_apply_winner',
      group: 'replay',
      risk: 'medium',
      description: 'Apply the winning policy value from a sweep (the RSI seam).',
      parameters: object({
        key: string(128, { description: 'Policy key to update' }),
        value: string(256, { description: 'New value' }),
        reason: string(500, { description: 'Why this value won' }),
      }, ['key', 'value']),
      execute: async ({ args }) => applyWinner(args.key, args.value, args.reason || 'agent_applied'),
    },
    {
      name: 'replay_policy',
      group: 'replay',
      risk: 'safe',
      description: 'Read the current loop policy (all key-value pairs).',
      parameters: object({}),
      execute: async () => getPolicy(),
    },
    {
      name: 'replay_list_worlds',
      group: 'replay',
      risk: 'safe',
      description: 'List recorded replay worlds.',
      parameters: object({
        agent_id: string(64, { description: 'Filter by agent (optional)' }),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 20)' },
      }),
      execute: async ({ args }) => ({ worlds: listWorlds(args.agent_id || null, args.limit || 20) }),
    },

    // ── Akashic Record Tools ──────────────────────────────────────
    {
      name: 'akashic_add',
      group: 'akashic',
      risk: 'safe',
      description: 'Add a knowledge record to the Akashic store (decision, entity, module, or pattern). Idempotent by kind+subject.',
      parameters: object({
        kind: string(64, { description: 'Record type: decision, entity, module, pattern' }),
        subject: string(256, { description: 'Subject identifier' }),
        body: string(4000, { description: 'Knowledge content' }),
        source: string(128, { description: 'Where this knowledge came from' }),
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence 0-1 (default 1.0)' },
      }, ['kind', 'subject', 'body']),
      execute: async ({ args }) => akashicAdd(args.kind, args.subject, args.body, args.source, args.confidence),
    },
    {
      name: 'akashic_query',
      group: 'akashic',
      risk: 'safe',
      description: 'Query the Akashic knowledge store by kind and/or subject pattern.',
      parameters: object({
        kind: string(64, { description: 'Filter by kind (optional)' }),
        subject: string(256, { description: 'Subject search pattern (optional)' }),
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 10)' },
      }),
      execute: async ({ args }) => ({ records: akashicQuery(args.kind || null, args.subject || null, args.limit || 10) }),
    },
    {
      name: 'akashic_summary',
      group: 'akashic',
      risk: 'safe',
      description: 'Get a summary of the Akashic knowledge store: kind counts, recent decisions, recent entities.',
      parameters: object({}),
      execute: async () => akashicSummary(),
    },
    {
      name: 'akashic_seed',
      group: 'akashic',
      risk: 'medium',
      description: 'Seed the Akashic store from verified agent memories (fossils, chain findings, reflections).',
      parameters: object({}),
      execute: async () => akashicSeed(),
    },

    // ── Cross-Tab Intelligence ──────────────────────────────
    {
      name: 'cross_tab_ingest',
      group: 'cross-tab',
      risk: 'low',
      description: 'Ingest a page visit into Cross-Tab Intelligence — records URL + title + content and classifies via LLM.',
      parameters: object({
        url: { type: 'string', description: 'Page URL' },
        title: { type: 'string', description: 'Page title' },
        content: { type: 'string', description: 'Page content excerpt' },
        source: { type: 'string', description: 'Visit source (extension, manual, agent)', default: 'agent' },
      }),
      execute: async ({ args }) => recordAndClassify({ ...args, source: args.source || 'agent' }),
    },
    {
      name: 'cross_tab_visits',
      group: 'cross-tab',
      risk: 'low',
      description: 'List recent browsing visits tracked by Cross-Tab Intelligence.',
      parameters: object({
        limit: { type: 'number', description: 'Max results (default 20)' },
        category: { type: 'string', description: 'Filter by category' },
        domain: { type: 'string', description: 'Filter by domain' },
      }),
      execute: async ({ args }) => ({ visits: getVisits({ limit: args.limit || 20, category: args.category, domain: args.domain }) }),
    },
    {
      name: 'cross_tab_stats',
      group: 'cross-tab',
      risk: 'low',
      description: 'Get Cross-Tab Intelligence statistics (visit counts, top domains, category breakdown).',
      parameters: object({}),
      execute: async () => getVisitStats(),
    },
    {
      name: 'cross_tab_insights',
      group: 'cross-tab',
      risk: 'low',
      description: 'Generate browsing insights from recent Cross-Tab visits using LLM analysis.',
      parameters: object({
        hours: { type: 'number', description: 'Hours of history to analyze (default 24)' },
      }),
      execute: async ({ args }) => generateInsights({ hours: args.hours || 24 }),
    },
    {
      name: 'cross_tab_clusters',
      group: 'cross-tab',
      risk: 'low',
      description: 'List topic clusters detected from browsing patterns.',
      parameters: object({}),
      execute: async () => ({ clusters: getClusters() }),
    },
    {
      name: 'cross_tab_context',
      group: 'cross-tab',
      risk: 'low',
      description: 'Get Perspective-ready context string from recent browsing for injection into agent prompts.',
      parameters: object({}),
      execute: async () => ({ context: getPerspectiveContext() }),
    },

    // ── Content Nexus tools ──
    {
      name: 'nexus_ingest',
      group: 'nexus',
      risk: 'low',
      description: 'Ingest items from all sources (YouTube, web, trends, browsing, calendar) into the Content Nexus feed.',
      parameters: object({}),
      execute: async () => {
        const r = await fetch('http://127.0.0.1:8787/api/nexus/ingest', { method: 'POST', signal: AbortSignal.timeout(15_000) });
        return r.json();
      },
    },
    {
      name: 'nexus_feed',
      group: 'nexus',
      risk: 'low',
      description: 'Get the unified Content Nexus feed. Filter by source (youtube, web, trends, browsing, calendar), acted status, or min relevance score.',
      parameters: object({
        source: { type: 'string', description: 'Filter by source' },
        limit: { type: 'number', description: 'Max items (default 50)' },
        minScore: { type: 'number', description: 'Minimum relevance score 0-1' },
        acted: { type: 'boolean', description: 'Filter by acted-on status' },
      }),
      execute: async ({ args }) => {
        const params = new URLSearchParams();
        if (args.source) params.set('source', args.source);
        if (args.limit) params.set('limit', String(args.limit));
        if (args.minScore) params.set('minScore', String(args.minScore));
        if (args.acted !== undefined) params.set('acted', String(args.acted));
        const r = await fetch(`http://127.0.0.1:8787/api/nexus/feed?${params}`, { signal: AbortSignal.timeout(15_000) });
        return r.json();
      },
    },
    {
      name: 'nexus_stats',
      group: 'nexus',
      risk: 'low',
      description: 'Get Content Nexus statistics — total items, acted count, breakdown by source and type.',
      parameters: object({}),
      execute: async () => {
        const r = await fetch('http://127.0.0.1:8787/api/nexus/stats', { signal: AbortSignal.timeout(15_000) });
        return r.json();
      },
    },
    {
      name: 'nexus_act',
      group: 'nexus',
      risk: 'low',
      description: 'Mark a Content Nexus item as acted-on with the specified action type (commerce, creation, distribution, repurpose).',
      parameters: object({
        id: { type: 'number', description: 'Nexus item ID' },
        actionType: { type: 'string', description: 'Action taken (commerce, creation, distribution, repurpose)' },
        runId: { type: 'string', description: 'Optional pipeline run ID' },
      }),
      execute: async ({ args }) => {
        const r = await fetch(`http://127.0.0.1:8787/api/nexus/act/${args.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionType: args.actionType, runId: args.runId }), signal: AbortSignal.timeout(15_000) });
        return r.json();
      },
    },
    {
      name: 'nexus_recommend',
      group: 'nexus',
      risk: 'low',
      description: 'Get AI-powered recommendations on which Content Nexus items to act on next.',
      parameters: object({
        limit: { type: 'number', description: 'Number of recommendations (default 5)' },
      }),
      execute: async ({ args }) => {
        const r = await fetch(`http://127.0.0.1:8787/api/nexus/recommendations?limit=${args.limit || 5}`, { signal: AbortSignal.timeout(30_000) });
        return r.json();
      },
    },
  ];
}
