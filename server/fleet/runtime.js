import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { loadManifests, writeOverride, removeOverride } from './manifest.js';
import { OLLAMA_URL } from '../config.js';

const MAX_STEPS = 8;
const MAX_HISTORY = 40;
const MAX_DEPTH = 2;
const now = () => Date.now();

let manifests = null;
let toolRegistry = [];
let broadcastFn = () => {};
let vertisoRef = null;
let rsiRef = null;

export function initFleet({ broadcast, vertiso, rsi }) {
  broadcastFn = broadcast || (() => {});
  vertisoRef = vertiso || null;
  rsiRef = rsi || null;
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

  return `${agent.systemPrompt}${memBlock}${rosterBlock}${vertisoBlock}${genomeBlock}`;
}

async function chat(messages, tools, model) {
  const ollamaTools = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const body = {
    model: model || process.env.FRAYMUS_DEFAULT_MODEL || 'llama3.2',
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
  return db.prepare('SELECT role, content, tool_calls, tool_call_id, name FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?')
    .all(threadId, limit)
    .reverse()
    .map(m => ({
      role: m.role,
      content: m.content || '',
      ...(m.tool_calls ? { tool_calls: JSON.parse(m.tool_calls) } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));
}

async function executeTool(toolName, args, ctx) {
  const tool = toolRegistry.find(t => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);
  if (tool.risk === 'approval') {
    const approvalId = randomUUID();
    db.prepare(`INSERT INTO approvals (id, run_id, thread_id, user_id, call_id, tool, args, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      approvalId, ctx.runId, ctx.threadId, ctx.userId, approvalId, toolName, JSON.stringify(args), now()
    );
    broadcastFn('fleet', { type: 'approval_needed', approvalId, tool: toolName });
    return { awaiting_approval: true, approvalId };
  }
  const result = tool.execute
    ? await tool.execute({ args })
    : (tool.run ? await tool.run(args, ctx) : { error: 'tool has no executor' });
  return result;
}

async function drive(runId, depth = 0) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run || run.status !== 'running') return;

  const agent = getManifest(run.model?.split(':')[0] || 'concierge') || getManifest('concierge');
  if (!agent) { setRun(runId, { status: 'error', error: 'Agent manifest not found' }); return; }

  const tools = agentTools(agent);
  const userId = run.user_id || 'local';

  for (let step = run.steps || 0; step < MAX_STEPS; step++) {
    const hist = getHistory(run.thread_id);
    const messages = [{ role: 'system', content: await systemPrompt(agent, userId) }, ...hist];

    let res;
    try {
      res = await chat(messages, tools, agent.model);
    } catch (e) {
      setRun(runId, { status: 'error', error: e.message });
      return;
    }

    addMsg(run.thread_id, runId, { role: 'assistant', content: res.content, tool_calls: res.tool_calls.length ? res.tool_calls : undefined });
    setRun(runId, { steps: step + 1 });
    broadcastFn('fleet', { type: 'step', runId, step: step + 1 });

    if (!res.tool_calls.length) {
      setRun(runId, { status: 'done' });
      broadcastFn('fleet', { type: 'done', runId });
      return;
    }

    for (const tc of res.tool_calls) {
      const fn = tc.function;
      const ctx = {
        userId, agentId: agent.id, threadId: run.thread_id, runId, depth,
        delegate: async (agentId, task) => {
          if (depth >= MAX_DEPTH) throw new Error('Delegation depth limit reached');
          return await delegateRun(userId, agentId, task, depth + 1);
        },
      };

      let result;
      try {
        result = await executeTool(fn.name, fn.arguments || {}, ctx);
      } catch (e) {
        result = { error: e.message };
      }

      if (result?.awaiting_approval) {
        setRun(runId, { status: 'awaiting_approval' });
        return;
      }

      addMsg(run.thread_id, runId, {
        role: 'tool', content: JSON.stringify(result).slice(0, 8000),
        tool_call_id: tc.id || fn.name, name: fn.name,
      });
    }
  }

  setRun(runId, { status: 'done' });
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
