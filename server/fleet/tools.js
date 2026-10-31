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
  ];
}
