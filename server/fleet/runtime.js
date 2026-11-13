import { randomUUID } from 'node:crypto';
import { watch, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DATA_DIR, OLLAMA_URL, mayRecoverAtBoot } from '../config.js';
import { poolStream, modelPoolStatus } from '../intelligence/model-pool.js';
import { withOllama } from '../intelligence/ollama-scheduler.js';
import { db } from '../db.js';
import { loadManifests, writeOverride, removeOverride } from './manifest.js';
import { heart, ledger, dreamer, cognition } from '../fraymus-tools.js';
import { sanitizeOllamaContent, sanitizeDeep } from '../fraymus/intelligence/ollama-sanitize.js';
import { setMemoryBridgeRef } from './tools.js';
import { buildPromptContext, autoStoreFromCompletion } from './agent-memory.js';
import { factsPromptContext } from '../intelligence/facts-service.js';
import { getActiveFraming, assessSituation, recordOutcome } from '../intelligence/perspective.js';
import {
  sealToolResult, sealRefusal, budgetBands, bandDirective,
  salvageOnCrash, boundResult, checkPermission, createRunEnvelope, recordStep,
} from './harness.js';
import { append as chainAppend } from '../intelligence/record-chain.js';
import { compactHistory } from '../integrity/strix-laws.js';
import { getAutonomyModifiers } from '../intelligence/consciousness-gate.js';
import { requestWrit, consumeWrit } from '../integrity/writ-system.js';
import { isClockTrusted, getLastVerdict } from '../integrity/clock-honesty.js';
import { buildPromptContext as akashicPromptContext } from '../intelligence/akashic.js';
import { record as replayRecord } from '../intelligence/replay-engine.js';
import { buildSpatialContext } from '../intelligence/self-model.js';
import { buildLineageContext } from '../intelligence/lineage.js';
import { contextualRecall } from '../intelligence/knowledge-graph.js';
import { isResourceConstrained, getResourcePressure } from '../intelligence/resource-envelope.js';

const MAX_STEPS = 8;
const MAX_HISTORY = 40;
const MAX_DEPTH = 2;
const now = () => Date.now();

let manifests = null;
let toolRegistry = [];
let broadcastFn = () => {};
let vertisoRef = null;
let rsiRef = null;
let memoryBridgeRef = null;

let manifestWatchers = [];

export function initFleet({ broadcast, vertiso, rsi, memoryBridge }) {
  broadcastFn = broadcast || (() => {});
  vertisoRef = vertiso || null;
  rsiRef = rsi || null;
  memoryBridgeRef = memoryBridge || null;
  if (memoryBridgeRef) setMemoryBridgeRef(memoryBridgeRef);
  manifests = loadManifests();

  // Fleet runs live in this process's memory: a row still 'running' or 'queued' at boot belongs to a
  // process that is gone. Left open they count as concurrent runs in the resource envelope (7 stale
  // rows pinned it at its limit on 2026-11-10 and every new run sat in the queue until it timed out).
  // Runs parked on a human approval stay: approving re-drives them.
  if (mayRecoverAtBoot()) try {
    const closed = db.prepare(`UPDATE runs SET status = 'error', error = 'interrupted by restart', updated_at = ?
      WHERE status IN ('running', 'queued') AND thread_id IN (SELECT id FROM threads)`).run(now()).changes;
    if (closed) console.log(`fleet: closed ${closed} run(s) left open by a previous process`);
  } catch (e) { console.error('fleet: boot run recovery failed:', e.message); }

  // Phase D: hot-reload agent manifests on file changes
  stopManifestWatch();
  const dirs = [
    resolve(DATA_DIR, '..', 'agents'),
    resolve(DATA_DIR, 'agents'),
  ];
  let debounceTimer = null;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename?.endsWith('.md')) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          try {
            manifests = loadManifests();
            broadcastFn('fleet', { type: 'manifests_reloaded', agentCount: manifests.size, trigger: filename });
            console.log(`[fleet] hot-reload: ${manifests.size} agents reloaded (${filename} changed)`);
          } catch (e) { console.error('[fleet] hot-reload failed:', e.message); }
        }, 500);
      });
      manifestWatchers.push(watcher);
    } catch (e) { console.error(`[fleet] watch ${dir} failed:`, e.message); }
  }

  return { agentCount: manifests.size };
}

export function stopManifestWatch() {
  for (const w of manifestWatchers) try { w.close(); } catch (_) {}
  manifestWatchers = [];
}

export function reloadManifests() {
  manifests = loadManifests();
  return manifests.size;
}

export function setFleetTools(tools) {
  toolRegistry = tools;
}

// Phase AC: runtime-registered tools (forged skills). Replace by name so a restore after retire
// never leaves two entries; the registry stays a plain array that agentTools() filters.
export function addFleetTools(tools) {
  const names = new Set(tools.map(t => t.name));
  toolRegistry = [...toolRegistry.filter(t => !names.has(t.name)), ...tools];
  return toolRegistry.length;
}

/** What the run loop can actually offer agents — the registry, not the manifests' wish lists. */
export function fleetToolNames() { return toolRegistry.map(t => t.name); }

export function removeFleetTools(names) {
  const drop = new Set(names);
  toolRegistry = toolRegistry.filter(t => !drop.has(t.name));
  return toolRegistry.length;
}

function getManifest(id) {
  if (!manifests) manifests = loadManifests();
  return manifests.get(id);
}

import { narratedToolCall, recoverTextToolCall, nudgeMessage, unverifiedMessage, MAX_NARRATION_NUDGES } from './narration-guard.js';
import { needsApproval, selectToolsForRun, rankTools } from './tool-select.js';
import { tunable } from '../intelligence/tunables.js';

// Every agent may use every shared tool: tools, skills and adaptations are shared, that is the point of the app.
// Until 2026-11-12 a manifest's `tools:` list was also an access boundary, so 75 of 84 agents could reach a median
// of 6 of the ~360 shared tools. The list is now a preference (pinned into the per-run offer), not a limit.
// What still stops a call is safety, not membership: an explicit `permissions.deny` in a manifest, approvals for
// risky tools, the writ tiers and the budget reserve.
function agentTools(agent) {
  return toolRegistry.filter(t => checkPermission(agent, t.name).allowed);
}

// A run is offered the ~24 tools most relevant to its task (a small model cannot take 360 schemas). These two
// built-ins let the agent reach the rest: find a shared tool, attach it, call it from the next step on.
const MAX_LOADED_PER_RUN = 24;
const runLoaded = new Map();   // runId -> Set of tool names the agent attached with tools.load
const clipText = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const DISCOVERY_TOOLS = [
  {
    name: 'tools.search', group: 'discovery', risk: 'low',
    description: 'Search every shared tool in Chandra (not only the ones attached to this step) by what you need to do. Returns names, groups and descriptions. Attach one with tools.load to call it.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'What you need to do, in words' }, limit: { type: 'integer', description: 'How many results (1–25, default 10)' } }, required: ['query'], additionalProperties: false },
    execute: async ({ args }, ctx) => {
      const limit = Math.min(25, Math.max(1, parseInt(args?.limit, 10) || 10));
      const permitted = ctx.agent ? agentTools(ctx.agent) : toolRegistry;
      const loaded = runLoaded.get(ctx.runId) || new Set();
      const hits = rankTools(permitted, String(args?.query || '')).filter(s => s.score > 0).slice(0, limit);
      return { total: permitted.length, results: hits.map(({ t }) => ({ name: t.name, group: t.group || null, description: clipText(t.description, 180), needsApproval: needsApproval(t), attached: loaded.has(t.name) })),
        next: hits.length ? 'Call tools.load with the names you need; they can be called from your next step.' : 'Nothing matched; try other words.' };
    },
  },
  {
    name: 'tools.load', group: 'discovery', risk: 'low',
    description: 'Attach shared tools to this run by exact name (from tools.search), so you can call them from your next step.',
    parameters: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names' } }, required: ['names'], additionalProperties: false },
    execute: async ({ args }, ctx) => {
      const names = (Array.isArray(args?.names) ? args.names : [args?.names]).map(n => String(n || '').trim()).filter(Boolean);
      const permitted = new Map((ctx.agent ? agentTools(ctx.agent) : toolRegistry).map(t => [t.name, t]));
      const set = runLoaded.get(ctx.runId) || new Set();
      const loaded = [], unknown = [], full = [];
      for (const n of names) {
        if (!permitted.has(n)) unknown.push(n);
        else if (set.has(n)) loaded.push(n);
        else if (set.size >= MAX_LOADED_PER_RUN) full.push(n);
        else { set.add(n); loaded.push(n); }
      }
      runLoaded.set(ctx.runId, set);
      while (runLoaded.size > 500) runLoaded.delete(runLoaded.keys().next().value);   // oldest runs first; a run ends in many places
      return { loaded, unknown, ...(full.length ? { notLoaded: full, reason: `at most ${MAX_LOADED_PER_RUN} extra tools per run` } : {}),
        next: loaded.length ? 'These are attached; call them with real tool calls from your next step.' : 'Nothing was attached; check the names with tools.search.' };
    },
  },
];
const findTool = name => DISCOVERY_TOOLS.find(t => t.name === name) || toolRegistry.find(t => t.name === name);

/** Every shared tool with its safety label (operator route GET /api/fleet/tools): the list to audit, since every
 *  agent can reach every tool and only an approval label stops one. `approval`: always | when (depends on args) | no. */
export function listSharedTools() {
  return toolRegistry.map(t => ({ name: t.name, group: t.group || null, risk: t.risk || null, safety: t.safety || null,
    approval: needsApproval(t, {}) ? 'always' : typeof t.approvalWhen === 'function' ? 'when' : 'no', description: clipText(t.description, 220) }));
}

/** What an agent's tools.search would return for `query` (operator route GET /api/fleet/tools/search). */
export function searchSharedTools(query, limit = 10) {
  return rankTools(toolRegistry, String(query || '')).filter(s => s.score > 0).slice(0, limit)
    .map(({ t, score }) => ({ name: t.name, group: t.group || null, score, description: clipText(t.description, 180), needsApproval: needsApproval(t) }));
}

/** The schemas offered at one step: the task's selection, what the agent attached, and the discovery tools. */
function offeredTools(base, permitted, runId) {
  const loaded = runLoaded.get(runId);
  const extra = loaded?.size ? permitted.filter(t => loaded.has(t.name) && !base.includes(t)) : [];
  return [...base, ...extra, ...DISCOVERY_TOOLS];
}

function agentRoster(currentId) {
  if (!manifests) manifests = loadManifests();
  return [...manifests.values()]
    .filter(a => a.id !== currentId)
    .map(a => `- ${a.id}: ${a.name} (${a.role || a.description || 'specialist'})`)
    .join('\n');
}

function searchMemories(userId, query, limit = 8) {
  const words = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) || []))];
  const rows = db.prepare('SELECT id, agent_id, text, tags, created_at FROM fleet_memories WHERE user_id = ? ORDER BY id DESC LIMIT 500').all(userId || 'local');
  return rows
    .map(r => ({ r, score: words.reduce((s, w) => s + (r.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.r.id - a.r.id)
    .slice(0, limit)
    .map(x => ({ id: x.r.id, text: x.r.text, agent: x.r.agent_id }));
}

async function systemPrompt(agent, userId, taskText = '') {
  const memories = searchMemories(userId, agent.name + ' ' + (agent.role || ''), 5);
  const memBlock = memories.length
    ? `\n\nRelevant memories:\n${memories.map(m => `- ${m.text}`).join('\n')}`
    : '';
  const roster = agentRoster(agent.id);
  const rosterBlock = roster
    ? `\n\nAvailable agents for delegation:\n${roster}`
    : '';

  // Vertiso vector memories
  let vertisoBlock = '';
  if (vertisoRef) {
    try {
      const vMem = await vertisoRef.recall({ agentId: agent.id, query: agent.name + ' ' + (agent.role || ''), namespace: 'global', limit: 5, minSimilarity: 0.2 });
      if (vMem.length) {
        vertisoBlock = `\n\nVertiso memories (semantic):\n${vMem.map(m => `- [${m.score.toFixed(2)}] ${m.content.slice(0, 200)}`).join('\n')}`;
      }
    } catch (e) { console.error('fleet: vertiso recall failed:', e.message); }
  }

  // RSI genome parameters
  let genomeBlock = '';
  if (rsiRef) {
    try {
      const genome = rsiRef.getGenome(agent.id);
      const gen = rsiRef.currentGeneration(agent.id);
      if (gen > 0) {
        genomeBlock = `\n\nRSI Genome (gen ${gen}): temp=${genome.temperature?.toFixed(2)}, exploration=${genome.explorationRate?.toFixed(2)}, creativity=${genome.creativityBias?.toFixed(2)}, verbosity=${genome.verbosity?.toFixed(2)}, memDepth=${genome.memoryRecallDepth}`;
      }
    } catch (e) { console.error('fleet: RSI genome read failed:', e.message); }
  }

  // Intelligence context — full stack awareness
  let intelligenceBlock = '';
  try {
    const mood = heart.recentMood();
    const dreamerState = dreamer.feel();
    const cogStatus = cognition.status();
    const parts = [];

    if (mood.readings > 0) {
      parts.push(`mood: ${mood.mood} (${mood.readings} readings)`);
    }
    if (dreamerState.dreamCount > 0) {
      parts.push(`dreamer: ${dreamerState.state}, ${dreamerState.dreamCount} dreams`);
    }
    if (cogStatus.contextLength > 0) {
      parts.push(`cognition: ${cogStatus.contextLength} ctx entries`);
    }

    if (parts.length > 0) {
      intelligenceBlock = `\n\nIntelligence context — ${parts.join(' · ')}. Tools: heart_feel (emotion), dream (imagination), consciousness_prove (proofs), cognition_process (reasoning), memory_recall (Vertiso bridge search).`;
    }
  } catch (_) {}

  // Memory Bridge — recent intelligence memories relevant to this agent
  let bridgeBlock = '';
  if (memoryBridgeRef) {
    try {
      const bridgeMem = await memoryBridgeRef.recallRelated(agent.name + ' ' + (agent.role || ''), 3);
      if (bridgeMem.length) {
        bridgeBlock = `\n\nMemory Bridge (recent intelligence):\n${bridgeMem.map(m => `- [${m.provenance || 'unknown'}] ${String(m.content || m.text || '').slice(0, 200)}`).join('\n')}`;
      }
    } catch (_) {}
  }

  // Agent Persistent Memory — per-agent knowledge store (inspired by Niles Continuity Plasmid verified/against pattern)
  let agentMemBlock = '';
  try {
    agentMemBlock = buildPromptContext(agent.id, taskText);
  } catch (_) {}
  // Known facts: what is currently true about the things this task names (replaced versions are not shown)
  try { agentMemBlock += factsPromptContext(taskText); } catch (e) { console.error('fleet facts block:', e.message); }

  // Akashic Record — cross-agent structured knowledge (decisions, entities, verified modules)
  let akashicBlock = '';
  try {
    akashicBlock = akashicPromptContext(1200);
  } catch (_) {}

  // Perspective — meta-cognitive framing from the active perspective session
  let perspectiveBlock = '';
  try {
    const framing = getActiveFraming();
    if (framing) {
      perspectiveBlock = `\n\nPerspective framing: ${framing}`;
    }
  } catch (_) {}

  // Consciousness Gate — system-wide consciousness tier injected into every agent
  let consciousnessBlock = '';
  try {
    const gateMods = getAutonomyModifiers();
    const tierDirectives = {
      DORMANT: 'System consciousness is DORMANT (0/4 proofs). Operate conservatively — prefer known patterns, avoid speculation, minimize risk.',
      AWAKENING: 'System consciousness is AWAKENING (1-2/4 proofs). Standard operation — balanced caution and initiative.',
      EMERGING: 'System consciousness is EMERGING (3/4 proofs). Expanded autonomy — you may take initiative, explore creative approaches, and propose novel solutions.',
      INTEGRATED: 'System consciousness is INTEGRATED (4/4 proofs, full coherence). Maximum autonomy — think boldly, synthesize across domains, propose ambitious strategies. The system is fully self-aware.',
    };
    consciousnessBlock = `\n\nConsciousness state: ${tierDirectives[gateMods.tier] || tierDirectives.AWAKENING} [Phi=${gateMods.phiValue?.toFixed?.(2) || '?'}, proofs=${gateMods.proofsPassed}/4, evolution=${gateMods.evolutionRate}x]`;
  } catch (_) {}

  // Self-Model — spatial awareness of where this agent lives in the UI
  let selfModelBlock = '';
  try {
    selfModelBlock = buildSpatialContext(agent.id);
  } catch (_) {}

  // Lineage — mathematical developmental age from the patient chart
  let lineageBlock = '';
  try {
    lineageBlock = buildLineageContext();
  } catch (_) {}

  // Knowledge Graph — semantic recall from the second brain
  let graphBlock = '';
  try {
    // recall by the task in hand; the agent's name and role only when there is none (it used to be name + role
    // always, so every agent got the same three notes whatever it was asked — 2026-11-13)
    const recallText = String(taskText || '').trim() ? String(taskText).slice(0, 300) : `${agent.name} ${agent.role || ''}`;
    const graphResults = contextualRecall(recallText, { agentId: agent.id, limit: 3 });
    if (graphResults.length) {
      graphBlock = `\n\nKnowledge graph: ${graphResults.map(r => `[${r.type}] ${r.label}: ${String(r.content).slice(0, 80)}`).join(' | ')}`;
    }
  } catch (_) {}

  return `${agent.systemPrompt}${memBlock}${rosterBlock}${vertisoBlock}${genomeBlock}${intelligenceBlock}${bridgeBlock}${agentMemBlock}${akashicBlock}${perspectiveBlock}${consciousnessBlock}${selfModelBlock}${lineageBlock}${graphBlock}`;
}

// Which machine and model really answered each agent call. A run row only says `default` (the pool decides per
// call), so without this nothing — the home screen's orb included — could say what was thinking (2026-11-12).
try {
  db.exec(`CREATE TABLE IF NOT EXISTS fleet_model_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, agent_id TEXT, host TEXT,
    model TEXT, ms INTEGER, ok INTEGER, error TEXT, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_fleet_model_calls_run ON fleet_model_calls(run_id);
    CREATE INDEX IF NOT EXISTS idx_fleet_model_calls_at ON fleet_model_calls(at);`);
} catch (e) { console.error('fleet: model-call table:', e.message); }
const insertModelCall = (() => { try { return db.prepare('INSERT INTO fleet_model_calls (run_id, agent_id, host, model, ms, ok, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'); } catch (e) { console.error('fleet: model-call insert:', e.message); return null; } })();
function recordModelCall(row) {
  try { insertModelCall?.run(row.runId || null, row.agentId || null, row.host || null, row.model || null, row.ms ?? null, row.ok ? 1 : 0, row.error || null, now()); }
  catch (e) { console.error('fleet: model-call record:', e.message); }
  broadcastFn('fleet', { type: 'model_call', runId: row.runId, agentId: row.agentId, host: row.host, model: row.model, ok: !!row.ok, ms: row.ms });
}
/** The machines and models that answered one run: `[{ host, model, calls, ms }]`, most calls first. */
export function modelCallsForRun(runId) {
  try { return db.prepare(`SELECT host, model, COUNT(*) calls, SUM(ms) ms FROM fleet_model_calls WHERE run_id = ? AND ok = 1 GROUP BY host, model ORDER BY calls DESC`).all(runId); }
  catch (e) { console.error('fleet: model calls for run:', e.message); return []; }
}
/** The last agent call that was answered: `{ host, model, agentId, runId, at }` or null. */
export function lastModelCall() {
  try { return db.prepare(`SELECT host, model, agent_id AS agentId, run_id AS runId, ms, at FROM fleet_model_calls WHERE ok = 1 ORDER BY id DESC LIMIT 1`).get() || null; }
  catch (e) { console.error('fleet: last model call:', e.message); return null; }
}

async function chat(messages, tools, model, { runId, agentId } = {}) {
  const ollamaTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const resolvedModel = model || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';
  const body = {
    model: resolvedModel,
    messages,
    ...(ollamaTools.length ? { tools: ollamaTools } : {}),
    stream: true,
  };

  // The model pool picks the machine (model-pool.js): another machine's card when it answers, this PC otherwise, the
  // next machine when one fails before replying. On this PC the call still takes an agent_run slot in the scheduler —
  // agent runs are the only thing that produces outcomes, so they go ahead of reflection/debate/verifier work.
  const t0 = now();
  let answeredBy = null;
  try {
    const out = await poolStream(body, { model: model || null, priority: 'agent_run', label: `agent:${agentId || 'unknown'}`, timeoutMs: 120_000 },
      (res, host, usedModel) => { answeredBy = { host, model: usedModel }; return readChatStream(res, { runId, agentId }); });
    recordModelCall({ runId, agentId, host: answeredBy?.host, model: answeredBy?.model, ms: now() - t0, ok: true });
    return out;
  } catch (e) {
    recordModelCall({ runId, agentId, host: answeredBy?.host || null, model: answeredBy?.model || model || null, ms: now() - t0, ok: false, error: String(e.message).slice(0, 300) });
    throw e;
  }
}

/** Read an Ollama streamed chat reply into {content, tool_calls}, broadcasting tokens as they come. */
async function readChatStream(res, { runId, agentId } = {}) {

  let contentParts = [];
  let toolCalls = [];
  let tokenCount = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try { chunk = JSON.parse(line); } catch (_) { continue; }
      if (chunk.message?.content) {
        contentParts.push(chunk.message.content);
        tokenCount++;
        if (runId && tokenCount % 4 === 0) {
          broadcastFn('fleet', { type: 'stream', runId, agentId, token: chunk.message.content, partial: contentParts.join('').slice(-200) });
        }
      }
      if (chunk.message?.tool_calls?.length) {
        toolCalls.push(...chunk.message.tool_calls);
      }
      if (chunk.done) {
        if (runId) {
          broadcastFn('fleet', { type: 'stream_end', runId, agentId, totalTokens: tokenCount });
        }
      }
    }
  }

  return {
    content: sanitizeOllamaContent(contentParts.join('')),
    tool_calls: sanitizeDeep(toolCalls),
  };
}

export { modelPoolStatus };

function addMsg(threadId, runId, msg) {
  db.prepare(`INSERT INTO messages (thread_id, run_id, role, content, tool_calls, tool_call_id, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    threadId, runId, msg.role, msg.content || null,
    msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
    msg.tool_call_id || null, msg.name || null, now()
  );
}

function setRun(runId, updates) {
  const fields = Object.entries(updates).map(([k]) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE runs SET ${fields}, updated_at = ? WHERE id = ?`)
    .run(...Object.values(updates), now(), runId);
}

function getHistory(threadId, limit = MAX_HISTORY) {
  const raw = db.prepare('SELECT role, content, tool_calls, tool_call_id, name FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit)
    .reverse()
    .map(m => ({
      role: m.role,
      content: m.content || '',
      ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));
  if (raw.length > 20) return compactHistory(raw);
  return raw;
}

// Every tool call ends. On 2026-11-13 four autonomous runs sat in 'running' for up to 107 minutes, each awaiting a
// tool that never returned (chain.run awaited a 16-stage chain; one reason call never settled). They counted as load,
// so the resource gate queued every new run behind them — a question typed on the home screen waited with no answer.
// Past the deadline the run gets an error result and moves on; the tool's own work may still finish in the background.
// A tool may set its own `timeoutMs`; FLEET_TOOL_TIMEOUT_MS sets the default (5 min).
export const TOOL_TIMEOUT_MS = Math.max(1000, parseInt(process.env.FLEET_TOOL_TIMEOUT_MS, 10) || 300_000);

export async function withToolDeadline(tool, toolName, call) {
  const limit = Math.max(1000, Number(tool?.timeoutMs) || TOOL_TIMEOUT_MS);
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => resolve({
      error: `${toolName} did not finish within ${Math.round(limit / 1000)} s and was abandoned. Its work may still complete in the background; do not wait for it.`,
      timedOut: true,
    }), limit);
    timer.unref?.();
  });
  try { return await Promise.race([Promise.resolve().then(call), deadline]); }
  finally { clearTimeout(timer); }
}

async function executeTool(toolName, args, ctx) {
  const tool = findTool(toolName);
  if (!tool) {
    const sealed = sealRefusal(toolName, `Unknown tool: ${toolName}. Find shared tools with tools.search.`);
    persistEvidence(ctx.runId, ctx.step || 0, sealed);
    return sealed;
  }

  // Permission check (harness-enforced): an explicit `permissions.deny` / `allow` in the manifest
  if (ctx.agent) {
    const perm = checkPermission(ctx.agent, toolName);
    if (!perm.allowed) {
      const sealed = sealRefusal(toolName, perm.reason);
      persistEvidence(ctx.runId, ctx.step || 0, sealed);
      return sealed;
    }
  }

  // Writ-system permission layer (deterministic, time-limited, receipt-chained)
  if (ctx.agent) {
    const writ = requestWrit(ctx.agent.id, toolName, toolName.toUpperCase());
    if (!writ.granted) {
      const sealed = sealRefusal(toolName, `writ denied: ${writ.reason}`);
      persistEvidence(ctx.runId, ctx.step || 0, sealed);
      return sealed;
    }
    if (writ.writ?.id) consumeWrit(writ.writ.id);
  }

  // Budget reserve check — past 85%, only output tools allowed
  if (ctx.inReserve && tool.group !== 'output' && tool.risk !== 'approval') {
    const sealed = sealRefusal(toolName, 'REPORT RESERVE (harness): reads refuse past reserve — produce output or finish');
    persistEvidence(ctx.runId, ctx.step || 0, sealed);
    return sealed;
  }

  if (needsApproval(tool, args || {})) {
    const approvalId = randomUUID();
    db.prepare(`INSERT INTO approvals (id, run_id, thread_id, user_id, call_id, tool, args, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      approvalId, ctx.runId, ctx.threadId, ctx.userId, approvalId, toolName, JSON.stringify(args), now()
    );
    broadcastFn('fleet', { type: 'approval_needed', approvalId, tool: toolName });
    return { result: { awaiting_approval: true, approvalId }, evidence: { executed: false, awaiting_approval: true } };
  }

  const t0 = now();
  const result = await withToolDeadline(tool, toolName, () => tool.execute
    ? tool.execute({ args }, ctx)
    : (tool.run ? tool.run(args, ctx) : { error: 'tool has no executor' }));
  const durationMs = now() - t0;

  const sealed = sealToolResult(toolName, args, result, durationMs);
  sealed.evidence.clock_trusted = isClockTrusted();
  persistEvidence(ctx.runId, ctx.step || 0, sealed);
  return sealed;
}

function persistEvidence(runId, step, sealed) {
  try {
    const ev = sealed.evidence;
    db.prepare(`INSERT INTO harness_evidence (run_id, step, tool, args_hash, result_hash, evidence_sha, duration_ms, refused, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, step, ev.tool || '', ev.sha8 || null, ev.sha256 || null, ev.evidence_sha || null,
           ev.duration_ms || null, ev.refused || null, now());
  } catch (e) {
    console.error('harness: evidence persist failed:', e.message);
  }
}

async function drive(runId, depth = 0) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run || run.status !== 'running') return;

  const agent = getManifest(run.model?.split(':')[0] || 'concierge') || getManifest('concierge');
  if (!agent) { setRun(runId, { status: 'error', error: 'Agent manifest not found' }); return; }

  const permitted = agentTools(agent);
  const userId = run.user_id || 'local';
  // `runs.model` is `agentId:model`; a model chosen for this run (startRun opts.model) wins over the manifest's, and
  // `default` lets the pool decide per call. Model names hold a colon too (qwen3:14b): take everything after the first.
  const chosen = String(run.model || '').slice(String(run.model || '').indexOf(':') + 1);
  const runModel = chosen && chosen !== 'default' ? chosen : (agent.model || null);

  // Clock-honesty check: warn if system clock is suspect at run start
  if (!isClockTrusted()) {
    const verdict = getLastVerdict();
    broadcastFn('integrity', {
      type: 'clock_suspect_during_run',
      runId, agentId: agent.id,
      drift_ms: verdict.drift_ms, verdict: verdict.verdict,
    });
  }

  // Harness: create run envelope for audit trail
  const lastUserMsg = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1").get(run.thread_id);
  const envelope = createRunEnvelope(runId, agent.id, lastUserMsg?.content || '');
  // Every agent may use every shared tool; the model is offered the most relevant few for this task (the
  // manifest's own list is pinned ahead), plus tools.search / tools.load to reach the rest. Rebuilt each step.
  const baseTools = selectToolsForRun(permitted, lastUserMsg?.content || '', { max: Math.round(tunable('fleet.max_tools_per_run', 24)), pinned: Array.isArray(agent.tools) ? agent.tools.filter(n => !n.includes('*')) : [] });
  if (baseTools.length < permitted.length) ledger.record('fleet.tools_offered', { agent: agent.id, runId, offered: baseTools.map(t => t.name), permitted: permitted.length }, 'fleet');

  // Perspective auto-assess: frame the run before the agent starts (top-level only)
  if (depth === 0 && lastUserMsg?.content) {
    try {
      const assessment = await Promise.race([
        assessSituation({ task: lastUserMsg.content, agentId: agent.id, context: `agent=${agent.name}, role=${agent.role || 'general'}` }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('perspective timeout')), 8000)),
      ]);
      if (assessment.perspectives?.length) {
        broadcastFn('perspective', { type: 'auto_assess', runId, agentId: agent.id, perspectives: assessment.perspectives, confidence: assessment.confidence });
        ledger.record('fleet.perspective_auto', { agent: agent.id, perspectives: assessment.perspectives, pattern: assessment.pattern_match, runId }, 'fleet');
      }
    } catch (_) {}
  }

  let narrationNudges = 0, loadNudged = false;
  for (let step = run.steps || 0; step < MAX_STEPS; step++) {
    // Harness Law 3: Budget bands — fire warnings at 60/75/85%
    const { firedNow, inReserve, newFired } = budgetBands(step + 1, MAX_STEPS, envelope.budget.fired);
    envelope.budget.fired = newFired;
    envelope.budget.inReserve = inReserve;

    const hist = getHistory(run.thread_id);

    // Inject budget band directives as system messages
    for (const band of firedNow) {
      const directive = bandDirective(band);
      if (directive) {
        addMsg(run.thread_id, runId, { role: 'system', content: directive });
        ledger.record('fleet.budget_band', { agent: agent.id, band, step, runId }, 'fleet');
      }
    }

    // Intelligence: feel the last user message before each LLM call
    let emotionNote = '';
    const lastUser = [...hist].reverse().find(m => m.role === 'user');
    if (lastUser?.content) {
      try {
        const feeling = heart.feel(lastUser.content);
        if (feeling.intensity > 0.1) {
          emotionNote = ` [User emotion: ${feeling.primary} (${Math.round(feeling.intensity * 100)}%), sentiment: ${feeling.sentiment > 0 ? 'positive' : feeling.sentiment < 0 ? 'negative' : 'neutral'}${feeling.sarcasm ? ', sarcasm detected' : ''}]`;
          ledger.record('fleet.feel', { agent: agent.id, primary: feeling.primary, intensity: feeling.intensity, step }, 'fleet');
          if (feeling.intensity > 0.3) memoryBridgeRef?.storeHeartReading(feeling).catch(() => {});
        }
      } catch (_) {}
    }

    const tools = offeredTools(baseTools, permitted, runId);
    const sysContent = (await systemPrompt(agent, userId, typeof lastUser?.content === 'string' ? lastUser.content : '')) + emotionNote
      + `\n\nTools: you may use any of the ${permitted.length} tools Chandra shares; ${tools.length} are attached to this step. If you need one that is not attached, call tools.search, then tools.load, then call it. Never describe a tool result you did not get from a real call.`;
    const messages = [{ role: 'system', content: sysContent }, ...getHistory(run.thread_id)];

    let res;
    try {
      res = await chat(messages, tools, runModel, { runId, agentId: agent.id });
    } catch (e) {
      // Harness Law 2: Salvage on crash — persist partial history before death
      salvageOnCrash(runId, agent.id, e, step, run.thread_id);
      setRun(runId, { status: 'error', error: e.message });
      broadcastFn('fleet', { type: 'done', runId, status: 'error', error: e.message });
      if (depth === 0) try { recordOutcome({ success: false, summary: `${agent.id} crashed at step ${step}: ${e.message}` }); } catch (_) {}
      return;
    }

    // a call written out as text for a tool the agent holds is executed as the call it plainly is
    if (!res.tool_calls.length) {
      const recovered = recoverTextToolCall(res.content, tools);
      if (recovered) {
        res.tool_calls = [recovered];
        ledger.record('fleet.text_tool_call_recovered', { agent: agent.id, tool: recovered.function.name, step, runId }, 'fleet');
      }
    }
    addMsg(run.thread_id, runId, { role: 'assistant', content: res.content, tool_calls: res.tool_calls.length ? res.tool_calls : undefined });
    setRun(runId, { steps: step + 1 });
    broadcastFn('fleet', { type: 'step', runId, step: step + 1 });

    if (!res.tool_calls.length) {
      // Narration guard: a described-but-never-made tool call carries invented evidence. One nudge
      // to make the real call; if the model narrates again the run still ends, flagged unverified.
      const claimed = narratedToolCall(res.content, tools);
      // a reply that reports a tool this run really called is a summary, not a narration
      const reallyCalled = claimed && db.prepare("SELECT 1 FROM messages WHERE run_id = ? AND role = 'tool' AND name = ? LIMIT 1").get(runId, claimed);
      const narrated = reallyCalled ? null : claimed;
      if (narrated) {
        const nudged = narrationNudges < MAX_NARRATION_NUDGES;
        ledger.record('fleet.narrated_tool_call', { agent: agent.id, tool: narrated, step, runId, nudged }, 'fleet');
        broadcastFn('fleet', { type: 'narrated_tool_call', runId, agentId: agent.id, tool: narrated, nudged });
        addMsg(run.thread_id, runId, { role: 'system', content: nudged ? nudgeMessage(narrated, tools, permitted) : unverifiedMessage(narrated) });
        if (nudged) { narrationNudges++; continue; }
      }
      // Attached but never used: measured 2026-11-12 — an agent searched, loaded hermes.username_check, then ended the run
      // listing what it had loaded. One reminder to make the call that answers the task.
      if (!narrated && !loadNudged) {
        const loaded = runLoaded.get(runId);
        const used = loaded?.size ? db.prepare("SELECT DISTINCT name FROM messages WHERE run_id = ? AND role = 'tool'").all(runId).map(r => r.name) : [];
        if (loaded?.size && ![...loaded].some(n => used.includes(n))) {
          loadNudged = true;
          ledger.record('fleet.loaded_not_used', { agent: agent.id, loaded: [...loaded], step, runId }, 'fleet');
          addMsg(run.thread_id, runId, { role: 'system', content: `[harness] You attached ${[...loaded].join(', ')} but called none of them, so the task is not done. Call the one that answers the request now with real arguments, or say plainly that none of them can.` });
          continue;
        }
      }
      setRun(runId, { status: 'done' });
      broadcastFn('fleet', { type: 'done', runId, status: 'done', harness: { steps: envelope.steps.length, evidence: true } });
      // a reply flagged as invented tool output is never remembered: the first fabricated answer
      // (4211) was stored as an `outcome` memory and came back verbatim in a later, unrelated run
      if (!narrated) {
        try { autoStoreFromCompletion(agent.id, lastUser?.content, res.content); } catch (_) {}
        try { replayRecord(agent.id, lastUser?.content || '', agent.model, envelope.steps, 0.5, step + 1); } catch (_) {}
      }
      if (depth === 0) try { recordOutcome({ success: true, summary: `${agent.id} completed in ${step + 1} steps`, effectivePerspectives: null }); } catch (_) {}
      return;
    }

    // Phase D: parallel tool execution — safe tools with no approval run concurrently
    const canParallel = res.tool_calls.length > 1 &&
      res.tool_calls.every(tc => {
        const t = findTool(tc.function?.name);
        return t && !needsApproval(t, tc.function?.arguments || {});
      });

    const executeOne = async (tc) => {
      const fn = tc.function;
      const ctx = {
        userId, agentId: agent.id, threadId: run.thread_id, runId, depth,
        step, agent, inReserve,
        delegate: async (agentId, task) => {
          if (depth >= MAX_DEPTH) throw new Error('Delegation depth limit reached');
          return await delegateRun(userId, agentId, task, depth + 1);
        },
      };

      let result;
      try {
        result = await executeTool(fn.name, fn.arguments || {}, ctx);
      } catch (e) {
        salvageOnCrash(runId, agent.id, e, step, run.thread_id);
        result = sealRefusal(fn.name, `tool crash: ${e.message}`);
        persistEvidence(runId, step, result);
      }

      recordStep(envelope, step, fn.name, fn.arguments || {}, result);

      try {
        chainAppend(agent.id, 'tool_call', {
          run_id: runId, step, tool: fn.name,
          evidence_sha: result?.evidence?.evidence_sha,
          executed: result?.evidence?.executed,
          clock_trusted: isClockTrusted(),
        });
      } catch (_) {}

      return { tc, fn, result };
    };

    let toolResults;
    if (canParallel) {
      const settled = await Promise.allSettled(res.tool_calls.map(executeOne));
      toolResults = settled.map(s => s.status === 'fulfilled' ? s.value : {
        tc: {}, fn: { name: 'unknown' },
        result: sealRefusal('unknown', `parallel exec failed: ${s.reason?.message || 'unknown'}`),
      });
      if (res.tool_calls.length > 1) {
        broadcastFn('fleet', { type: 'parallel_tools', runId, count: res.tool_calls.length, tools: res.tool_calls.map(tc => tc.function?.name) });
      }
    } else {
      toolResults = [];
      for (const tc of res.tool_calls) {
        toolResults.push(await executeOne(tc));
      }
    }

    let awaitingApproval = false;
    for (const { tc, fn, result } of toolResults) {
      if (result?.result?.awaiting_approval) {
        setRun(runId, { status: 'awaiting_approval' });
        awaitingApproval = true;
        break;
      }
      const resultStr = JSON.stringify(result);
      const bounded = boundResult(resultStr, fn.name);
      addMsg(run.thread_id, runId, {
        role: 'tool', content: bounded.bounded.slice(0, 8000),
        tool_call_id: tc.id || fn.name, name: fn.name,
      });
    }
    if (awaitingApproval) return;

    // A tool that owns the reply: what it returned already is what the person should be told (a job was
    // started, or refused for a stated reason). The model is not asked to paraphrase it — an 8B model
    // answered an accepted page job by pasting unrelated library code and calling it working.
    if (toolResults.length === 1) {
      const { fn, result } = toolResults[0];
      const def = tools.find(t => t.name === fn.name);
      const reply = def?.ownsReply === true && result?.evidence?.executed !== false ? result?.result?.replyToUser : null;
      if (typeof reply === 'string' && reply.trim()) {
        addMsg(run.thread_id, runId, { role: 'assistant', content: reply.trim().slice(0, 4000) });
        setRun(runId, { status: 'done', steps: step + 1 });
        ledger.record('fleet.tool_owned_reply', { agent: agent.id, tool: fn.name, runId }, 'fleet');
        broadcastFn('fleet', { type: 'done', runId, status: 'done', harness: { steps: envelope.steps.length, evidence: true, replyFrom: fn.name } });
        try { autoStoreFromCompletion(agent.id, lastUser?.content, reply.trim()); } catch (_) {}
        if (depth === 0) try { recordOutcome({ success: true, summary: `${agent.id} completed in ${step + 1} steps (reply from ${fn.name})`, effectivePerspectives: null }); } catch (_) {}
        return;
      }
    }
  }

  setRun(runId, { status: 'done' });
  try { replayRecord(agent.id, 'max_steps_reached', agent.model, envelope.steps, 0.3, MAX_STEPS); } catch (_) {}
  if (depth === 0) try { recordOutcome({ success: true, summary: `${agent.id} hit max steps (${MAX_STEPS})` }); } catch (_) {}
}

const runQueue = [];
let queueProcessing = false;

export function startRun(userId, agentId, message, threadId, opts = {}) {
  const agent = getManifest(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const model = opts.model == null || opts.model === '' ? null : String(opts.model).trim();
  if (model && !/^[\w.\-/]+(:[\w.\-]+)?$/.test(model)) throw new Error(`Not a model name: ${model.slice(0, 80)}`);

  const tid = threadId || randomUUID();
  if (!threadId) {
    db.prepare('INSERT INTO threads (id, user_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tid, userId || 'local', agentId, message.slice(0, 100), now(), now());
  }

  addMsg(tid, null, { role: 'user', content: message });

  const runId = randomUUID();
  db.prepare('INSERT INTO runs (id, thread_id, user_id, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, tid, userId || 'local', 'running', `${agentId}:${model || agent.model || 'default'}`, now(), now());

  // Phase D: resource-aware scheduling — queue runs when system is under pressure
  // A person waiting on an answer (`opts.interactive`: the home screen, chat) is never queued behind the fleet's own
  // autonomous work — the queue exists to shed background load, and a typed question is the load it is for.
  let queued = false;
  try {
    if (!opts.interactive && isResourceConstrained()) {
      const pressure = getResourcePressure();
      runQueue.push({ runId, userId, agentId, queuedAt: now() });
      broadcastFn('fleet', { type: 'run_queued', runId, agentId, queueLength: runQueue.length, pressure: pressure.level });
      setRun(runId, { status: 'queued' });
      queued = true;
      if (!queueProcessing) processQueue();
    }
  } catch (_) {}

  if (!queued) {
    broadcastFn('fleet', { type: 'run_started', runId, agentId });
    drive(runId, 0).catch(e => setRun(runId, { status: 'error', error: e.message }));
  }

  return { runId, threadId: tid };
}

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;
  while (runQueue.length > 0) {
    try {
      if (isResourceConstrained()) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
    } catch (_) {}
    const item = runQueue.shift();
    if (!item) break;
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(item.runId);
    if (!run || run.status !== 'queued') continue;
    setRun(item.runId, { status: 'running' });
    broadcastFn('fleet', { type: 'run_dequeued', runId: item.runId, agentId: item.agentId, waitMs: now() - item.queuedAt });
    drive(item.runId, 0).catch(e => setRun(item.runId, { status: 'error', error: e.message }));
    await new Promise(r => setTimeout(r, 1000));
  }
  queueProcessing = false;
}

export function getQueueStatus() {
  return { queued: runQueue.length, processing: queueProcessing };
}

async function delegateRun(userId, agentId, task, depth) {
  const tid = randomUUID();
  db.prepare('INSERT INTO threads (id, user_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tid, userId, agentId, `Delegated: ${task.slice(0, 80)}`, now(), now());
  addMsg(tid, null, { role: 'user', content: task });

  const runId = randomUUID();
  const agent = getManifest(agentId);
  db.prepare('INSERT INTO runs (id, thread_id, user_id, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, tid, userId, 'running', `${agentId}:${agent?.model || 'default'}`, now(), now());

  await drive(runId, depth);

  const lastMsg = db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(tid);
  return lastMsg?.content || '[No response from agent]';
}

export async function runAgentAndWait(userId, agentId, message, threadId, timeoutMs = 120_000) {
  const { runId, threadId: tid } = startRun(userId, agentId, message, threadId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId);
    if (!run || run.status === 'done' || run.status === 'error' || run.status === 'awaiting_approval') {
      const msgs = db.prepare("SELECT role, content FROM messages WHERE thread_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").all(tid);
      return { runId, threadId: tid, status: run?.status || 'unknown', lastReply: msgs[0]?.content || '' };
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { runId, threadId: tid, status: 'timeout' };
}

// Approving executes the stored call. Before 2026-11-10 an approval only flipped the run back to
// 'running' and re-asked the model: the approved tool never ran (no tool message was ever written
// for it), so the model would call it again and raise a fresh approval. Now the human's yes runs
// exactly the call that was shown to them — same tool, same arguments — and the result goes into the
// thread before the agent continues. A rejection is written into the thread too, so the agent can
// say what did not happen instead of the run ending silently.
export async function decideApproval(userId, approvalId, approve) {
  const a = db.prepare('SELECT * FROM approvals WHERE id = ? AND user_id = ?').get(approvalId, userId || 'local');
  if (!a) throw new Error('Approval not found');
  if (a.status !== 'pending') throw new Error('Already decided');
  db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?')
    .run(approve ? 'approved' : 'rejected', now(), approvalId);
  if (!approve) {
    addMsg(a.thread_id, a.run_id, { role: 'tool', tool_call_id: a.call_id || a.tool, name: a.tool, content: JSON.stringify({ result: { rejected: true, reason: 'A person declined this action. It did not run.' }, evidence: { executed: false } }) });
    setRun(a.run_id, { status: 'running' });
    drive(a.run_id).catch(e => console.error('fleet: drive after rejection failed:', e.message));
    return { ok: true, status: 'rejected', executed: false };
  }
  const tool = toolRegistry.find(t => t.name === a.tool);
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(a.run_id);
  const agent = getManifest(run?.model?.split(':')[0] || 'concierge') || null;
  let args = {};
  try { args = JSON.parse(a.args || '{}'); } catch (e) { console.error('fleet: approval args unreadable:', e.message); }
  const t0 = now();
  let result;
  try {
    if (!tool) result = { error: `tool ${a.tool} is no longer registered` };
    else result = await withToolDeadline(tool, a.tool, () => tool.execute ? tool.execute({ args }, { runId: a.run_id, threadId: a.thread_id, userId: a.user_id, agent, agentId: agent?.id, approvedBy: 'human', approvalId })
      : (tool.run ? tool.run(args, { runId: a.run_id, agent }) : { error: 'tool has no executor' }));
  } catch (e) {
    result = { error: String(e.message || e).slice(0, 400) };
  }
  const sealed = sealToolResult(a.tool, args, result, now() - t0);
  sealed.evidence.approved_by_human = true;
  sealed.evidence.approval_id = approvalId;
  persistEvidence(a.run_id, run?.steps || 0, sealed);
  ledger.record('fleet.approved_tool_executed', { tool: a.tool, runId: a.run_id, approvalId, ok: !result?.error }, 'fleet');
  addMsg(a.thread_id, a.run_id, { role: 'tool', tool_call_id: a.call_id || a.tool, name: a.tool, content: JSON.stringify(sealed).slice(0, 8000) });
  setRun(a.run_id, { status: 'running' });
  drive(a.run_id).catch(e => console.error('fleet: drive after approval failed:', e.message));
  return { ok: true, status: 'approved', executed: true, error: result?.error || null, result: sealed.result };
}

export function listAgents(userId) {
  if (!manifests) manifests = loadManifests();
  const customs = db.prepare('SELECT * FROM custom_agents WHERE user_id = ?').all(userId || 'local');
  const all = [...manifests.values()];
  for (const c of customs) {
    try { all.push(JSON.parse(c.json)); } catch {}
  }
  return all;
}

export function getAgent(userId, id) {
  const agent = getManifest(id);
  if (agent) return agent;
  const custom = db.prepare('SELECT json FROM custom_agents WHERE id = ? AND user_id = ?').get(id, userId || 'local');
  return custom ? JSON.parse(custom.json) : null;
}

export function saveAgentManifest(agent) {
  writeOverride(agent);
  manifests = loadManifests();
  return { saved: true, id: agent.id };
}

export function resetAgentManifest(id) {
  const removed = removeOverride(id);
  if (removed) manifests = loadManifests();
  return removed;
}

export function listThreads(userId) {
  return db.prepare('SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50').all(userId || 'local');
}

export function getThread(userId, id) {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ? AND user_id = ?').get(id, userId || 'local');
  if (!thread) return null;
  const messages = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(id)
    .map(m => ({ ...m, tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined }));
  const runs = db.prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at').all(id).map(r => ({ ...r, modelsUsed: modelCallsForRun(r.id) }));
  const approvals = db.prepare("SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending'").all(id);
  return { ...thread, messages, runs, approvals };
}

export function callToolDirect(userId, toolName, args) {
  const tool = toolRegistry.find(t => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return tool.execute ? tool.execute({ args: args || {} }) : (tool.run ? tool.run(args || {}, { userId, agentId: 'direct', threadId: 'direct', depth: 0, delegate: () => { throw new Error('No delegation in direct mode'); } }) : { error: 'no executor' });
}

export { searchMemories };
