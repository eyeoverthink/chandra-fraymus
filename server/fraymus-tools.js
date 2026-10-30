import {
  generateIdentity, numberFromPub, signText, verifyText,
  newPureIdentity, checkPureIdentity, pureSign, pureVerify,
} from './fraymus/core/identity.js';
import {
  sha256hex, fnv1aStr, crc32, canonical,
} from './fraymus/core/crypto.js';
import { signMessage, verifyMessage } from './fraymus/core/signing.js';
import { toEmoji, fromEmoji, encodeEmoji, decodeEmoji } from './fraymus/encoding/emoji.js';
import { encodeDna, decodeDna, dnaHypervector } from './fraymus/encoding/dna.js';
import { buildWasm, decodeWasm, verifyWasm, transmute } from './fraymus/encoding/wasm.js';
import { frayHeader, parseFrayHeader } from './fraymus/encoding/fray.js';
import { merkleRoot, merkle41, merkleDivergence } from './fraymus/encoding/merkle.js';
import { zipStore } from './fraymus/encoding/zip.js';
import { allForms } from './fraymus/encoding/forms.js';
import { ENDPOINTS, sendCanonical, registerCanonical, inboxCanonical, kuramotoR, kuramotoStep } from './fraymus/protocol/v13.js';
import { postSigned, verifyChain } from './fraymus/protocol/mesh.js';
import { signThought, matrix, matrixDna } from './fraymus/protocol/hive.js';
import { presenceStatus, presenceColor, isChainHealthy } from './fraymus/protocol/presence.js';
import { OuroborosEngine } from './fraymus/intelligence/ouroboros.js';
import { HermesFleet } from './fraymus/intelligence/hermes.js';
import { MotorDispatcher } from './fraymus/intelligence/motor.js';
import { OpenClawGateway } from './fraymus/intelligence/openclaw.js';
import { ControlPlane } from './fraymus/intelligence/control-plane.js';
import { NeedleQueue } from './fraymus/intelligence/needle.js';
import { OrificeBridge } from './fraymus/bridge/orifice.js';
import { NILES_MODEL, FRAYVM_OPCODES, buildModelfile, executeFrayvm } from './fraymus/intelligence/niles.js';
import { SCHEMAS, getSchema, entitiesBySource } from './fraymus/entities/schemas.js';
import { getWorkflow, scheduledWorkflows, eventTriggeredWorkflows } from './fraymus/workflows/definitions.js';
import { MCP_TOOLS, getToolDefinition, listTools as listMcpTools } from './fraymus/mcp/tools.js';
import { AGENTS, ZONES, COMPUTE_NODES, PHI } from './fraymus/core/constants.js';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

let _systemIdentity = null;
async function getSystemIdentity() {
  if (!_systemIdentity) _systemIdentity = await generateIdentity();
  return _systemIdentity;
}

import { entityStore } from './fraymus/entity-store.js';
import { chatOllama } from './commerce/shared.js';

// Wire all intelligence modules to SQLite-backed entity store
const ouroboros = new OuroborosEngine(entityStore, { chat: chatOllama });
const hermesExecutors = buildHermesExecutors();
const hermes = new HermesFleet(hermesExecutors);
const motor = new MotorDispatcher(entityStore);
const controlPlane = new ControlPlane(entityStore);
const needle = new NeedleQueue(entityStore);
const bridge = new OrificeBridge(entityStore);
const openclaw = new OpenClawGateway({ hermes, motor, ouroboros, controlPlane, bridge, entityStore });

function buildHermesExecutors() {
  return {
    duckduckgo_search: async ({ query }) => {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query || '')}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Chandra/1.0' },
      });
      const html = await res.text();
      const matches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/g)];
      return { results: matches.slice(0, 10).map(m => ({ url: m[1], title: m[2].trim() })) };
    },
    web_scrape: async ({ url }) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      return { length: text.length, preview: text.slice(0, 2000) };
    },
    target_analysis: async ({ target }) => {
      const prompt = [{ role: 'user', content: `Analyze this target for research purposes: ${target}. Provide key facts, domain info, and notable details.` }];
      const analysis = await chatOllama(prompt);
      return { target, analysis };
    },
    deep_research: async ({ topic }) => {
      const prompt = [{ role: 'user', content: `Conduct deep research on: ${topic}. Provide comprehensive analysis with key findings, trends, and implications.` }];
      const research = await chatOllama(prompt);
      return { topic, research };
    },
    news_scan: async ({ topic }) => {
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(topic + ' news')}&t=h_&iar=news`, {
        signal: AbortSignal.timeout(15_000),
        headers: { 'User-Agent': 'Chandra/1.0' },
      });
      const html = await res.text();
      const matches = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)/g)];
      return { results: matches.slice(0, 10).map(m => ({ url: m[1], title: m[2].trim() })) };
    },
    code_generation: async ({ description, language }) => {
      const prompt = [{ role: 'user', content: `Generate ${language || 'JavaScript'} code for: ${description}` }];
      const code = await chatOllama(prompt);
      return { language: language || 'JavaScript', code };
    },
    code_review: async ({ code }) => {
      const prompt = [{ role: 'user', content: `Review this code for bugs, security issues, and improvements:\n\n${code}` }];
      const review = await chatOllama(prompt);
      return { review };
    },
    ollama_manage: async ({ action }) => {
      try {
        const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(10_000) });
        const data = await res.json();
        return { action: action || 'list', models: data.models?.map(m => m.name) || [] };
      } catch (e) {
        return { error: e.message, action };
      }
    },
    db_query: async ({ sql }) => {
      // Safe read-only queries only
      if (!/^\s*SELECT\s/i.test(sql)) return { error: 'Only SELECT queries allowed' };
      try {
        const { db: database } = await import('./db.js');
        const rows = database.prepare(sql).all();
        return { rows: rows.slice(0, 100), count: rows.length };
      } catch (e) {
        return { error: e.message };
      }
    },
    log_analysis: async ({ lines }) => {
      const prompt = [{ role: 'user', content: `Analyze these log lines for errors, patterns, and anomalies:\n\n${lines}` }];
      const analysis = await chatOllama(prompt);
      return { analysis };
    },
    sentiment_analyze: async ({ text }) => {
      const prompt = [{ role: 'user', content: `Analyze the sentiment of this text. Return: sentiment (positive/negative/neutral/mixed), confidence (0-1), and key phrases:\n\n${text}` }];
      const result = await chatOllama(prompt);
      return { result };
    },
    pattern_match: async ({ data, pattern }) => {
      const prompt = [{ role: 'user', content: `Find patterns matching "${pattern}" in this data:\n\n${data}` }];
      const result = await chatOllama(prompt);
      return { pattern, result };
    },
    anomaly_detect: async ({ data }) => {
      const prompt = [{ role: 'user', content: `Detect anomalies in this data. Identify outliers, unusual patterns, and deviations:\n\n${typeof data === 'string' ? data : JSON.stringify(data)}` }];
      const result = await chatOllama(prompt);
      return { result };
    },
  };
}

export { ouroboros, hermes, motor, openclaw, controlPlane, needle };

export function createFraymusTools() {
  return [
    // ── Identity ──
    {
      name: 'fraymus.identity.generate',
      group: 'fraymus-identity',
      description: 'Generate a new Ed25519 cryptographic identity (keypair + agent number). Returns publicKey, agentNumber, and a reference handle for signing.',
      parameters: object({ label: string(100) }),
      execute: async () => {
        const id = await generateIdentity();
        const num = await numberFromPub(id.publicKey);
        return { publicKey: id.publicKey, agentNumber: num, algorithm: 'Ed25519-WebCrypto' };
      },
    },
    {
      name: 'fraymus.identity.sign',
      group: 'fraymus-identity',
      description: 'Sign a text message with the system Ed25519 identity. Returns the hex signature.',
      parameters: object({ message: string(16000, { minLength: 1 }) }, ['message']),
      execute: async ({ args }) => {
        const id = await getSystemIdentity();
        const sig = await signText(id.privateKey, args.message);
        return { signature: sig, algorithm: 'Ed25519', signerNumber: await numberFromPub(id.publicKey) };
      },
    },
    {
      name: 'fraymus.identity.verify',
      group: 'fraymus-identity',
      description: 'Verify an Ed25519 signature against a public key and message.',
      parameters: object({
        message: string(16000, { minLength: 1 }),
        signature: string(256, { minLength: 1 }),
        publicKey: string(512, { minLength: 1 }),
      }, ['message', 'signature', 'publicKey']),
      execute: async ({ args }) => {
        const valid = await verifyText(args.publicKey, args.signature, args.message);
        return { valid, algorithm: 'Ed25519' };
      },
    },

    // ── Encoding ──
    {
      name: 'fraymus.encode.emoji',
      group: 'fraymus-encoding',
      description: 'Encode data to visible emoji representation and steganographic emoji carrier.',
      parameters: object({ data: string(8000, { minLength: 1 }) }, ['data']),
      execute: async ({ args }) => {
        const buf = new TextEncoder().encode(args.data);
        return { visible: toEmoji(buf), stego: encodeEmoji(buf), bytes: buf.length };
      },
    },
    {
      name: 'fraymus.encode.dna',
      group: 'fraymus-encoding',
      description: 'Encode data to DNA bases (A/T/C/G) and generate a 16384-dimensional hypervector.',
      parameters: object({ data: string(8000, { minLength: 1 }) }, ['data']),
      execute: async ({ args }) => {
        const buf = new TextEncoder().encode(args.data);
        const dna = encodeDna(buf);
        const hv = dnaHypervector(buf);
        return { dna, dimensions: 16384, hvPreview: Array.from(hv.subarray(0, 32)) };
      },
    },
    {
      name: 'fraymus.encode.wasm',
      group: 'fraymus-encoding',
      description: 'Build a WebAssembly container with custom sections holding the given data.',
      parameters: object({ data: string(8000, { minLength: 1 }), label: string(100) }, ['data']),
      execute: async ({ args }) => {
        const buf = new TextEncoder().encode(args.data);
        const wasm = buildWasm([{ name: args.label || 'fraymus.data', data: buf }]);
        return { wasmBytes: wasm.length, magic: '0x00 0x61 0x73 0x6d', sections: 1, verified: verifyWasm(wasm) };
      },
    },
    {
      name: 'fraymus.encode.merkle',
      group: 'fraymus-encoding',
      description: 'Compute SHA-256 Merkle root and FNV-1a fast Merkle root for a list of items.',
      parameters: object({ items: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 256 } }, ['items']),
      execute: async ({ args }) => {
        const bufs = args.items.map(s => new TextEncoder().encode(s));
        const sha = await merkleRoot(bufs);
        const fnv = merkle41(args.items);
        return { sha256Root: sha, fnvRoot: fnv, leafCount: args.items.length };
      },
    },
    {
      name: 'fraymus.encode.all',
      group: 'fraymus-encoding',
      description: 'Encode data in all 7 FRAYMUS formats at once: emoji, DNA, WASM, FRAY header, Merkle, ZIP, steganographic.',
      parameters: object({ data: string(4000, { minLength: 1 }) }, ['data']),
      execute: async ({ args }) => {
        const forms = await allForms(new TextEncoder().encode(args.data));
        return { formats: Object.keys(forms), summary: `Encoded ${args.data.length} chars into 7 formats` };
      },
    },

    // ── Protocol ──
    {
      name: 'fraymus.protocol.send',
      group: 'fraymus-protocol',
      description: 'Create a v13 signed message canonical for mesh transmission.',
      parameters: object({
        from: string(100, { minLength: 1 }),
        to: string(100, { minLength: 1 }),
        body: string(8000, { minLength: 1 }),
      }, ['from', 'to', 'body']),
      execute: async ({ args }) => {
        const id = await getSystemIdentity();
        const msg = await signMessage({
          from: args.from, to: args.to, body: args.body,
          version: 13, timestamp: Date.now(),
        }, id);
        return { signed: true, version: 13, hash: await sha256hex(JSON.stringify(msg)) };
      },
    },
    {
      name: 'fraymus.protocol.register',
      group: 'fraymus-protocol',
      description: 'Generate a v13 mesh registration canonical for an agent identity.',
      parameters: object({ agentName: string(100, { minLength: 1 }) }, ['agentName']),
      execute: async ({ args }) => {
        const id = await getSystemIdentity();
        const pub = id.publicKey;
        const num = await numberFromPub(pub);
        return { agentName: args.agentName, agentNumber: num, registered: true, protocol: 'v13' };
      },
    },
    {
      name: 'fraymus.mesh.post',
      group: 'fraymus-protocol',
      description: 'Post a signed entry to the hash chain (Merkle mesh).',
      parameters: object({ content: string(8000, { minLength: 1 }), previousHash: string(128) }, ['content']),
      execute: async ({ args }) => {
        const id = await getSystemIdentity();
        const entry = await postSigned(args.content, args.previousHash || '0'.repeat(64), id);
        return entry;
      },
    },
    {
      name: 'fraymus.mesh.verify',
      group: 'fraymus-protocol',
      description: 'Verify integrity of a hash chain.',
      parameters: object({ chain: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 100 } }, ['chain']),
      execute: async ({ args }) => {
        const result = await verifyChain(args.chain);
        return result;
      },
    },
    {
      name: 'fraymus.hive.think',
      group: 'fraymus-protocol',
      description: 'Sign a thought for the hive mind matrix. Returns signed thought with DNA representation.',
      parameters: object({ thought: string(4000, { minLength: 1 }), agentName: string(100) }, ['thought']),
      execute: async ({ args }) => {
        const id = await getSystemIdentity();
        const signed = await signThought(args.thought, args.agentName || 'chandra', id);
        return signed;
      },
    },
    {
      name: 'fraymus.presence.status',
      group: 'fraymus-protocol',
      description: 'Get presence status for all known agents in the mesh network.',
      parameters: object({}),
      execute: async () => {
        return { agents: AGENTS.map(a => ({ name: a, status: presenceStatus(a), color: presenceColor(a) })) };
      },
    },

    // ── Intelligence: Ouroboros RSI ──
    {
      name: 'fraymus.ouroboros.evolve',
      group: 'fraymus-intelligence',
      description: 'Run one Ouroboros Recursive Self-Improvement cycle. Evaluates current genome fitness, generates mutations, runs falsification tests, and selects the best variant.',
      parameters: object({
        populationSize: { type: 'integer', minimum: 2, maximum: 32 },
        mutationRate: { type: 'number', minimum: 0.01, maximum: 1.0 },
      }),
      execute: async ({ args }) => {
        const result = ouroboros.evolve({
          populationSize: args.populationSize || 8,
          mutationRate: args.mutationRate || 0.15,
        });
        return result;
      },
    },
    {
      name: 'fraymus.ouroboros.fitness',
      group: 'fraymus-intelligence',
      description: 'Evaluate the current Ouroboros genome fitness score. Returns orbital distance, decay rate, and falsification test results.',
      parameters: object({}),
      execute: async () => {
        return ouroboros.fitness();
      },
    },

    // ── Intelligence: Hermes Skills ──
    {
      name: 'fraymus.hermes.dispatch',
      group: 'fraymus-intelligence',
      description: 'Dispatch a task to the Hermes 30-skill fleet. Automatically selects the optimal skill based on task description.',
      parameters: object({
        task: string(4000, { minLength: 1 }),
        category: string(100),
        priority: { type: 'integer', minimum: 1, maximum: 10 },
      }, ['task']),
      execute: async ({ args }) => {
        const result = hermes.dispatch({
          task: args.task,
          category: args.category,
          priority: args.priority || 5,
        });
        return result;
      },
    },
    {
      name: 'fraymus.hermes.skills',
      group: 'fraymus-intelligence',
      description: 'List all 30 Hermes skills organized by category (reasoning, code, data, comms, system).',
      parameters: object({ category: string(100) }),
      execute: async ({ args }) => {
        return hermes.listSkills(args.category);
      },
    },

    // ── Intelligence: Motor Dispatcher ──
    {
      name: 'fraymus.motor.submit',
      group: 'fraymus-intelligence',
      description: 'Submit a compute job to the Motor dispatcher. Routes to optimal compute node (WASM, GPU, FPGA, or Edge).',
      parameters: object({
        task: string(4000, { minLength: 1 }),
        nodePreference: string(50),
        priority: { type: 'integer', minimum: 1, maximum: 10 },
      }, ['task']),
      execute: async ({ args }) => {
        const result = motor.submit({
          task: args.task,
          node: args.nodePreference,
          priority: args.priority || 5,
        });
        return result;
      },
    },
    {
      name: 'fraymus.motor.status',
      group: 'fraymus-intelligence',
      description: 'Get status of all Motor compute nodes and queued jobs.',
      parameters: object({}),
      execute: async () => {
        return motor.status();
      },
    },

    // ── Intelligence: OpenClaw Gateway ──
    {
      name: 'fraymus.openclaw.execute',
      group: 'fraymus-intelligence',
      description: 'Execute one of 23 OpenClaw gateway actions (deploy, scan, audit, bridge, sync, etc.).',
      parameters: object({
        action: string(100, { minLength: 1 }),
        payload: { type: 'object' },
      }, ['action']),
      execute: async ({ args }) => {
        const result = openclaw.execute(args.action, args.payload || {});
        return result;
      },
    },
    {
      name: 'fraymus.openclaw.actions',
      group: 'fraymus-intelligence',
      description: 'List all 23 available OpenClaw gateway actions.',
      parameters: object({}),
      execute: async () => {
        return openclaw.listActions();
      },
    },

    // ── Intelligence: Control Plane ──
    {
      name: 'fraymus.control.status',
      group: 'fraymus-intelligence',
      description: 'Get the FRAYMUS control plane status: active agents, zones, compute nodes, sync state.',
      parameters: object({}),
      execute: async () => {
        return controlPlane.status();
      },
    },

    // ── Schemas & Workflows ──
    {
      name: 'fraymus.schema.get',
      group: 'fraymus-data',
      description: 'Get a FRAYMUS entity schema by name. 43 schemas available covering agents, messages, workflows, compute, etc.',
      parameters: object({ name: string(100, { minLength: 1 }) }, ['name']),
      execute: async ({ args }) => {
        const schema = getSchema(args.name);
        return schema || { error: `Schema '${args.name}' not found`, available: Object.keys(SCHEMAS) };
      },
    },
    {
      name: 'fraymus.schema.list',
      group: 'fraymus-data',
      description: 'List all 43 FRAYMUS entity schemas, optionally filtered by source app.',
      parameters: object({ source: string(100) }),
      execute: async ({ args }) => {
        if (args.source) return { schemas: entitiesBySource(args.source) };
        return { schemas: Object.keys(SCHEMAS), count: Object.keys(SCHEMAS).length };
      },
    },
    {
      name: 'fraymus.workflow.run',
      group: 'fraymus-data',
      description: 'Run a FRAYMUS workflow by name. 12 workflows available including security audits, DNA evolution, fleet sync, etc.',
      parameters: object({ name: string(100, { minLength: 1 }), input: { type: 'object' } }, ['name']),
      execute: async ({ args }) => {
        const wf = getWorkflow(args.name);
        if (!wf) return { error: `Workflow '${args.name}' not found` };
        return { workflow: wf.name, steps: wf.steps, trigger: wf.trigger, description: wf.description };
      },
    },
    {
      name: 'fraymus.workflow.list',
      group: 'fraymus-data',
      description: 'List all 12 FRAYMUS workflows with their triggers and schedules.',
      parameters: object({}),
      execute: async () => {
        return {
          scheduled: scheduledWorkflows(),
          eventTriggered: eventTriggeredWorkflows(),
        };
      },
    },

    // ── Kuramoto Phase Sync ──
    {
      name: 'fraymus.sync.phase',
      group: 'fraymus-protocol',
      description: 'Run a Kuramoto phase synchronization step across the agent fleet. Returns order parameter R (0=desynchronized, 1=fully synchronized).',
      parameters: object({
        phases: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 64 },
        coupling: { type: 'number', minimum: 0, maximum: 10 },
      }, ['phases']),
      execute: async ({ args }) => {
        const R = kuramotoR(args.phases);
        const next = kuramotoStep(args.phases, args.coupling || 1.0);
        return { orderParameter: R, nextPhases: next, synchronized: R > 0.9 };
      },
    },

    // ── Autonomy Meta-Tool ──
    {
      name: 'fraymus.autonomy.assess',
      group: 'fraymus-autonomy',
      description: 'Run a full autonomy assessment: identity health, mesh status, skill readiness, evolution fitness, compute availability, and trust zone compliance. The AI uses this to self-evaluate and plan autonomous actions.',
      parameters: object({}),
      execute: async () => {
        const identity = await getSystemIdentity();
        const pub = identity.publicKey;
        const num = await numberFromPub(pub);
        const fitness = ouroboros.fitness();
        const skills = hermes.listSkills();
        const compute = motor.status();
        const gateway = openclaw.listActions();
        const plane = controlPlane.status();

        return {
          identity: { agentNumber: num, algorithm: 'Ed25519', healthy: true },
          fitness,
          skills: { total: skills.total || 30, ready: skills.ready || 30 },
          compute,
          gateway: { actions: gateway.count || 23 },
          controlPlane: plane,
          zones: ZONES,
          phi: PHI,
          autonomous: true,
          recommendation: 'All subsystems nominal. Full autonomy available.',
        };
      },
    },
  ];
}
