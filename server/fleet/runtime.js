import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { loadManifests, writeOverride, removeOverride } from './manifest.js';
import { OLLAMA_URL } from '../config.js';
import { heart, ledger, dreamer, cognition } from '../fraymus-tools.js';
import { setMemoryBridgeRef } from './tools.js';
import { buildPromptContext, autoStoreFromCompletion } from './agent-memory.js';
import { getActiveFraming } from '../intelligence/perspective.js';
import {
  sealToolResult, sealRefusal, budgetBands, bandDirective,
  salvageOnCrash, boundResult, checkPermission, createRunEnvelope, recordStep,
} from './harness.js';
import { append as chainAppend } from '../intelligence/record-chain.js';
import { compactHistory } from '../integrity/strix-laws.js';
import { requestWrit, consumeWrit } from '../integrity/writ-system.js';
import { isClockTrusted, getLastVerdict } from '../integrity/clock-honesty.js';
import { buildPromptContext as akashicPromptContext } from '../intelligence/akashic.js';
import { record as replayRecord } from '../intelligence/replay-engine.js';

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

export function initFleet({ broadcast, vertiso, rsi, memoryBridge }) {
  broadcastFn = broadcast || (() => {});
  vertisoRef = vertiso || null;
  rsiRef = rsi || null;
  memoryBridgeRef = memoryBridge || null;
  if (memoryBridgeRef) setMemoryBridgeRef(memoryBridgeRef);
  manifests = loadManifests();
  return { agentCount: manifests.size };
}

export function reloadManifests() {
  manifests = loadManifests();
  return manifests.size;
}

export function setFleetTools(tools) {
  toolRegistry = tools;
}

function getManifest(id) {
  if (!manifests) manifests = loadManifests();
  return manifests.get(id);
}

function matchesTool(allow, name) {
  if (allow === '*') return true;
  if (!Array.isArray(allow)) return true;
  return allow.some(p => p === name || (p.endsWith('*') && name.startsWith(p.slice(0, -1))));
}

function agentTools(agent) {
  return toolRegistry.filter(t => matchesTool(agent.tools, t.name));
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

async function systemPrompt(agent, userId) {
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
    agentMemBlock = buildPromptContext(agent.id);
  } catch (_) {}

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

  return `${agent.systemPrompt}${memBlock}${rosterBlock}${vertisoBlock}${genomeBlock}${intelligenceBlock}${bridgeBlock}${agentMemBlock}${akashicBlock}${perspectiveBlock}`;
}

async function chat(messages, tools, model) {
  const ollamaTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const body = {
    model: model || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b',
    messages,
    ...(ollamaTools.length ? { tools: ollamaTools } : {}),
    stream: false,
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return {
    content: data.message?.content || '',
    tool_calls: data.message?.tool_calls || [],
  };
}

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

async function executeTool(toolName, args, ctx) {
  const tool = toolRegistry.find(t => t.name === toolName);
  if (!tool) {
    const sealed = sealRefusal(toolName, `Unknown tool: ${toolName}`);
    persistEvidence(ctx.runId, ctx.step || 0, sealed);
    return sealed;
  }

  // Permission check (harness-enforced)
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

  if (tool.risk === 'approval') {
    const approvalId = randomUUID();
    db.prepare(`INSERT INTO approvals (id, run_id, thread_id, user_id, call_id, tool, args, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      approvalId, ctx.runId, ctx.threadId, ctx.userId, approvalId, toolName, JSON.stringify(args), now()
    );
    broadcastFn('fleet', { type: 'approval_needed', approvalId, tool: toolName });
    return { result: { awaiting_approval: true, approvalId }, evidence: { executed: false, awaiting_approval: true } };
  }

  const t0 = now();
  const result = tool.execute
    ? await tool.execute({ args }, ctx)
    : (tool.run ? await tool.run(args, ctx) : { error: 'tool has no executor' });
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

  const tools = agentTools(agent);
  const userId = run.user_id || 'local';

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

    const sysContent = (await systemPrompt(agent, userId)) + emotionNote;
    const messages = [{ role: 'system', content: sysContent }, ...getHistory(run.thread_id)];

    let res;
    try {
      res = await chat(messages, tools, agent.model);
    } catch (e) {
      // Harness Law 2: Salvage on crash — persist partial history before death
      salvageOnCrash(runId, agent.id, e, step, run.thread_id);
      setRun(runId, { status: 'error', error: e.message });
      return;
    }

    addMsg(run.thread_id, runId, { role: 'assistant', content: res.content, tool_calls: res.tool_calls.length ? res.tool_calls : undefined });
    setRun(runId, { steps: step + 1 });
    broadcastFn('fleet', { type: 'step', runId, step: step + 1 });

    if (!res.tool_calls.length) {
      setRun(runId, { status: 'done' });
      broadcastFn('fleet', { type: 'done', runId, harness: { steps: envelope.steps.length, evidence: true } });
      try { autoStoreFromCompletion(agent.id, lastUser?.content, res.content); } catch (_) {}
      try { replayRecord(agent.id, lastUser?.content || '', agent.model, envelope.steps, 0.5, step + 1); } catch (_) {}
      return;
    }

    for (const tc of res.tool_calls) {
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
        // Harness Law 2: Salvage partial work on tool crash
        salvageOnCrash(runId, agent.id, e, step, run.thread_id);
        result = sealRefusal(fn.name, `tool crash: ${e.message}`);
        persistEvidence(runId, step, result);
      }

      // Record step in envelope for audit
      recordStep(envelope, step, fn.name, fn.arguments || {}, result);

      // Append to hash-chained record (Akashic audit trail)
      try {
        chainAppend(agent.id, 'tool_call', {
          run_id: runId, step, tool: fn.name,
          evidence_sha: result?.evidence?.evidence_sha,
          executed: result?.evidence?.executed,
          clock_trusted: isClockTrusted(),
        });
      } catch (_) {}

      if (result?.result?.awaiting_approval) {
        setRun(runId, { status: 'awaiting_approval' });
        return;
      }

      // Harness Law 4: Bound oversized results before storing
      const resultStr = JSON.stringify(result);
      const bounded = boundResult(resultStr, fn.name);

      addMsg(run.thread_id, runId, {
        role: 'tool', content: bounded.bounded.slice(0, 8000),
        tool_call_id: tc.id || fn.name, name: fn.name,
      });
    }
  }

  setRun(runId, { status: 'done' });
  try { replayRecord(agent.id, 'max_steps_reached', agent.model, envelope.steps, 0.3, MAX_STEPS); } catch (_) {}
}

export function startRun(userId, agentId, message, threadId) {
  const agent = getManifest(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);

  const tid = threadId || randomUUID();
  if (!threadId) {
    db.prepare('INSERT INTO threads (id, user_id, agent_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(tid, userId || 'local', agentId, message.slice(0, 100), now(), now());
  }

  addMsg(tid, null, { role: 'user', content: message });

  const runId = randomUUID();
  db.prepare('INSERT INTO runs (id, thread_id, user_id, status, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(runId, tid, userId || 'local', 'running', `${agentId}:${agent.model || 'default'}`, now(), now());

  broadcastFn('fleet', { type: 'run_started', runId, agentId });
  drive(runId, 0).catch(e => setRun(runId, { status: 'error', error: e.message }));

  return { runId, threadId: tid };
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

export function decideApproval(userId, approvalId, approve) {
  const a = db.prepare('SELECT * FROM approvals WHERE id = ? AND user_id = ?').get(approvalId, userId || 'local');
  if (!a) throw new Error('Approval not found');
  if (a.status !== 'pending') throw new Error('Already decided');
  db.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?')
    .run(approve ? 'approved' : 'rejected', now(), approvalId);
  if (approve) {
    setRun(a.run_id, { status: 'running' });
    drive(a.run_id).catch(() => {});
  } else {
    setRun(a.run_id, { status: 'rejected' });
  }
  return { ok: true, status: approve ? 'approved' : 'rejected' };
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
  const runs = db.prepare('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at').all(id);
  const approvals = db.prepare("SELECT * FROM approvals WHERE thread_id = ? AND status = 'pending'").all(id);
  return { ...thread, messages, runs, approvals };
}

export function callToolDirect(userId, toolName, args) {
  const tool = toolRegistry.find(t => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  return tool.execute ? tool.execute({ args: args || {} }) : (tool.run ? tool.run(args || {}, { userId, agentId: 'direct', threadId: 'direct', depth: 0, delegate: () => { throw new Error('No delegation in direct mode'); } }) : { error: 'no executor' });
}

export { searchMemories };
