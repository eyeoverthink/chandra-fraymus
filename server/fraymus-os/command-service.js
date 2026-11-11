/**
 * One text/voice command loop.
 * Routine tools run immediately. Publishing and skill installation stop for a person,
 * and the MVP still refuses to execute them after approval.
 */

import { randomUUID } from 'node:crypto';
import { isAbort } from './http-error.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SUGGESTED_PROMPTS = [
  { id: 'health', label: 'System health', text: 'How is the system holding up?' },
  { id: 'recall', label: 'Recall notes', text: 'Recall notes about creation' },
  { id: 'brief', label: 'Research brief', text: 'Draft a research brief about local-first agents' },
  { id: 'script', label: 'Short script', text: 'Draft a 60-second script about F.R.A.Y.M.U.S.' },
  { id: 'memory', label: 'What I know', text: 'What do you remember?' },
];

const RISKY = [
  { tool: 'external_publish', risk: 'approval', test: /\b(publish|shopify|deploy|post this|send (an )?email|purchase|buy|delete the file)\b/i },
  { tool: 'enable_generated_skill', risk: 'approval', test: /\b(enable|install)\b.+\b(skill|plugin)\b/i },
];

function classify(text) {
  for (const risky of RISKY) {
    if (risky.test.test(text)) return { type: 'risky', ...risky };
  }
  if (/\bpropose (a )?skill\b/i.test(text)) return { type: 'propose_skill', tool: 'propose_skill' };
  if (/\b(health|holding up|what models|system status)\b/i.test(text)) return { type: 'health', tool: 'inspect_health' };
  if (/\b(recall|remember|notes about|what do you know)\b/i.test(text)) return { type: 'recall', tool: 'recall_notes' };
  if (/\b(brief|script|draft)\b/i.test(text)) return { type: 'draft', tool: 'draft_creation' };
  return { type: 'chat', tool: null };
}

function topicFrom(text) {
  const match = text.match(/\b(?:about|on|for)\s+(.+)$/i);
  return (match ? match[1] : text).replace(/^draft\s+/i, '').trim().slice(0, 500);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

export function createCommandService({ db, registry, graph, recipes, voice, broadcast, fleet = null }) {
  const controllers = new Map();

  // ── the brain: fleet-agent bridge ─────────────────────────────────────────
  // Home commands that are not instant lookups run as a real fleet agent (default fraymus_prime,
  // which holds every registered tool). Its tool calls are mirrored into fraymus_os_tool_steps so the
  // "Transcript and tools" panel shows what actually ran; approval-labelled tools pause for a person
  // and Approve executes the exact call that was shown.
  const AGENT_ID = process.env.FRAYMUS_HOME_AGENT || 'fraymus_prime';
  const AGENT_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.FRAYMUS_HOME_AGENT_TIMEOUT_MS, 10) || 600_000);
  const RECORD_FILE = join(resolve(process.env.CHANDRA_DATA_DIR || 'data'), 'record.jsonl');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fraymus_os_agent_threads (session_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fraymus_os_agent_approvals (step_id TEXT PRIMARY KEY, approval_id TEXT NOT NULL, run_id TEXT, created_at INTEGER NOT NULL);
    `);
  } catch (error) { console.error('fraymus-os bridge tables:', error.message); }

  const CAPABILITY_DECK = [
    { id: 'create', label: 'Create', items: [
      { id: 'brief', label: 'Research brief', text: 'Draft a research brief about local-first agents' },
      { id: 'script', label: 'Short script', text: 'Draft a 60-second script about F.R.A.Y.M.U.S.' },
      { id: 'page', label: 'Landing page', text: 'Build a scroll landing page with hermes.scrollpage: slug "fraymus-intro", title "F.R.A.Y.M.U.S.", a one-sentence tagline, and four sections about what this system can do. Then give me the local URL.', fill: true },
      { id: 'image', label: 'Image', text: 'Generate an image of ', fill: true },
      { id: 'pixelshort', label: '8-bit short', text: 'Use studio.create to make a 30 second 8-bit short about ', fill: true },
      { id: 'pixelstill', label: '2-bit still', text: 'Use studio.create to make a 2-bit still of ', fill: true },
      { id: 'cartoon', label: 'Cartoon', text: 'Use studio.create to make a 30 second cartoon about ', fill: true },
      { id: 'comic', label: 'Comic strip', text: 'Use studio.create to make a comic about ', fill: true },
      { id: 'explainer', label: 'Explainer', text: 'Use studio.create to make a 45 second explainer video about ', fill: true },
    ] },
    { id: 'research', label: 'Research', items: [
      { id: 'hn', label: 'Read the news', text: 'Use hermes.rss_read on https://hnrss.org/frontpage and tell me the three most relevant stories for someone building local AI agents.' },
      { id: 'papers', label: 'New papers', text: 'Use hermes.rss_read on https://rss.arxiv.org/rss/cs.AI with limit 8 and summarise what is new in one paragraph.' },
      { id: 'handle', label: 'Is a name free?', text: 'Use hermes.username_check to see where the handle "" is taken.', fill: true },
      { id: 'contracts', label: 'Public records', text: 'Use hermes.osint with source "usaspending" to find federal contracts mentioning ""', fill: true },
    ] },
    { id: 'build', label: 'Build', items: [
      { id: 'wiki', label: 'Code wiki', text: 'Use hermes.code_wiki on F:/Fraymus-Skill-Lab/chandra-fraymus/server/fleet and tell me the three most depended-on modules.' },
      { id: 'review', label: 'Review my changes', text: 'Use hermes.pr_lens on F:/Fraymus-Skill-Lab/chandra-fraymus (base HEAD~1, head HEAD) and tell me the blast radius and the risk notes.' },
      { id: 'pkg', label: 'Vet a package', text: 'Use hermes.pkg_audit to check the npm package "" before I install it.', fill: true },
      { id: 'grill', label: 'Grill my plan', text: 'Use hermes.grill_me on this plan: ', fill: true },
    ] },
    { id: 'reason', label: 'Reason', items: [
      { id: 'math', label: 'Exact answer', text: 'Use the reason tool with kind "number": compute 58 x 73 + 1204 - 17 x 29' },
      { id: 'audit', label: 'What is broken?', text: 'Use self_audit_status and tell me the open REAL findings and what each means.' },
    ] },
    { id: 'operate', label: 'Operate', items: [
      { id: 'health', label: 'System health', text: 'How is the system holding up?' },
      { id: 'brief2', label: 'Morning brief', text: 'Use hermes.morning_brief and read it back to me.' },
      { id: 'recall', label: 'What I know', text: 'What do you remember?' },
    ] },
  ];

  function appendRecord(line) {
    // External continuity (Vaughn's FRAYMUS/DOC-SEAL/1 note): one appended line per finished command.
    try { mkdirSync(resolve(RECORD_FILE, '..'), { recursive: true }); appendFileSync(RECORD_FILE, JSON.stringify(line) + '\n'); }
    catch (error) { console.error('fraymus-os record.jsonl:', error.message); }
  }

  function brain() {
    const count = (sql, ...params) => { try { return db.prepare(sql).get(...params)?.c ?? 0; } catch { return null; } };
    const names = fleet?.toolNames ? fleet.toolNames() : [];
    const groups = {};
    for (const name of names) { const key = name.includes('.') ? name.split('.')[0] : name.split('_')[0]; groups[key] = (groups[key] || 0) + 1; }
    let g = null;
    try { g = db.prepare(`SELECT g_score FROM capability_runs WHERE status = 'completed' AND strategy_mode = 'auto' ORDER BY created_at DESC LIMIT 1`).get()?.g_score ?? null; } catch { /* benchmark table not created yet */ }
    return {
      connected: !!fleet,
      agentId: AGENT_ID,
      tools: names.length,
      toolGroups: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([group, n]) => ({ group, n })),
      hermesTools: names.filter(name => name.startsWith('hermes.') || name === 'spore.read').length,
      agents: fleet?.listAgents ? fleet.listAgents('local').length : null,
      skills: count(`SELECT COUNT(*) c FROM forged_skills WHERE status = 'active'`),
      pendingApprovals: count(`SELECT COUNT(*) c FROM approvals WHERE status = 'pending'`),
      agentRuns24h: count(`SELECT COUNT(*) c FROM runs WHERE created_at > ?`, Date.now() - 86_400_000),
      gScore: g,
    };
  }

  function parseToolContent(content) {
    const text = String(content || '');
    const at = text.indexOf('{');
    if (at < 0) return { parsed: null, preview: text.slice(0, 700) };
    try { const parsed = JSON.parse(text.slice(at)); return { parsed, preview: JSON.stringify(parsed.result ?? parsed).slice(0, 700) }; }
    catch { return { parsed: null, preview: text.slice(0, 700) }; }
  }

  async function runAgent(turnId, sessionId, text, signal, sources) {
    const existing = db.prepare('SELECT thread_id FROM fraymus_os_agent_threads WHERE session_id = ?').get(sessionId);
    const started = fleet.startRun('local', AGENT_ID, text, existing?.thread_id);
    if (!existing) db.prepare('INSERT OR REPLACE INTO fraymus_os_agent_threads (session_id, thread_id, created_at) VALUES (?, ?, ?)').run(sessionId, started.threadId, Date.now());
    const callSteps = new Map();      // model tool-call key → step id
    const openByTool = new Map();     // tool name → [step ids still running]
    const handled = new Set();        // message ids already mirrored
    const began = Date.now();
    let run = null;
    for (;;) {
      if (signal?.aborted) {
        db.prepare(`UPDATE fraymus_os_tool_steps SET status = 'cancelled', updated_at = ? WHERE turn_id = ? AND status = 'running'`).run(Date.now(), turnId);
        finish(turnId, { state: 'cancelled', sources, answer: null, error: `Stopped watching. Agent run ${started.runId} may still finish in the background.`, model: `${AGENT_ID} (agent)`, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
        return;
      }
      run = db.prepare('SELECT status, error, steps FROM runs WHERE id = ?').get(started.runId);
      const messages = db.prepare('SELECT id, role, name, content, tool_calls FROM messages WHERE run_id = ? ORDER BY id').all(started.runId);
      for (const message of messages) {
        if (handled.has(message.id)) continue;
        handled.add(message.id);
        if (message.role === 'assistant' && message.tool_calls) {
          let calls = [];
          try { calls = JSON.parse(message.tool_calls) || []; } catch (error) { console.error('fraymus-os bridge tool_calls:', error.message); }
          calls.forEach((call, index) => {
            const name = call.function?.name || 'tool';
            const stepId = randomUUID();
            const now = Date.now();
            insertTool.run(stepId, sessionId, turnId, name, JSON.stringify(call.function?.arguments ?? {}).slice(0, 4000), 'running', null, 'routine', now, now);
            callSteps.set(`${message.id}:${index}`, stepId);
            if (!openByTool.has(name)) openByTool.set(name, []);
            openByTool.get(name).push(stepId);
            emit({ type: 'tool', sessionId, turnId, stepId, tool: name, status: 'running' });
          });
        } else if (message.role === 'tool') {
          const stepId = (openByTool.get(message.name) || []).shift();
          if (!stepId) continue;
          const { parsed, preview } = parseToolContent(message.content);
          const failed = !!(parsed?.result?.error || parsed?.error || parsed?.evidence?.refused);
          updateTool.run(failed ? 'error' : 'ok', JSON.stringify({ preview, executed: parsed?.evidence?.executed !== false, approvedByHuman: parsed?.evidence?.approved_by_human === true, reason: failed ? String(parsed?.result?.error || parsed?.error || parsed?.result?.reason || 'refused').slice(0, 300) : undefined }), Date.now(), stepId);
          emit({ type: 'tool', sessionId, turnId, stepId, tool: message.name, status: failed ? 'error' : 'ok' });
        }
      }
      // a tool that needs approval writes no tool message: the run parks and an approvals row appears
      const pending = db.prepare(`SELECT id, tool, args FROM approvals WHERE run_id = ? AND status = 'pending'`).all(started.runId);
      for (const approval of pending) {
        if (db.prepare('SELECT 1 FROM fraymus_os_agent_approvals WHERE approval_id = ?').get(approval.id)) continue;
        const stepId = (openByTool.get(approval.tool) || []).shift() || randomUUID();
        const exists = db.prepare('SELECT id FROM fraymus_os_tool_steps WHERE id = ?').get(stepId);
        if (exists) db.prepare(`UPDATE fraymus_os_tool_steps SET status = 'awaiting_approval', risk = 'approval', result = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify({ reason: 'This tool changes something outside the agent. It runs only if you approve.' }), Date.now(), stepId);
        else insertTool.run(stepId, sessionId, turnId, approval.tool, String(approval.args || '{}').slice(0, 4000), 'awaiting_approval', JSON.stringify({ reason: 'This tool changes something outside the agent. It runs only if you approve.' }), 'approval', Date.now(), Date.now());
        db.prepare('INSERT OR REPLACE INTO fraymus_os_agent_approvals (step_id, approval_id, run_id, created_at) VALUES (?, ?, ?, ?)').run(stepId, approval.id, started.runId, Date.now());
        emit({ type: 'approval_required', sessionId, turnId, stepId, tool: approval.tool });
      }
      if (!run || !['running', 'queued'].includes(run.status)) break;
      if (Date.now() - began > AGENT_TIMEOUT_MS) {
        finish(turnId, { state: 'error', sources, answer: null, error: `The agent did not finish within ${Math.round(AGENT_TIMEOUT_MS / 60000)} minutes. Run ${started.runId} is still in the fleet.`, model: `${AGENT_ID} (agent)`, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
        return;
      }
      await new Promise(done => setTimeout(done, 700));
    }
    const all = db.prepare('SELECT role, content, tool_calls FROM messages WHERE run_id = ? ORDER BY id').all(started.runId);
    const last = [...all].reverse().find(message => message.role === 'assistant' && !message.tool_calls && String(message.content || '').trim());
    const unverified = all.some(message => message.role === 'system' && /^\[harness\] The reply above describes output/.test(message.content || ''));
    const toolCount = callSteps.size;
    let answer = last ? String(last.content).trim() : '';
    if (run?.status === 'awaiting_approval') answer = `${answer ? `${answer}\n\n` : ''}I need your approval for the step marked below before I can continue.`;
    if (unverified) answer += '\n\n⚠ The agent described a tool result without calling the tool. Treat that part as unverified.';
    const failed = !run || run.status === 'error';
    finish(turnId, {
      state: failed ? 'error' : 'idle', sources,
      answer: answer || null,
      error: failed ? (run?.error || 'The agent run failed.') : (!answer ? 'The agent finished without a reply.' : null),
      model: `${AGENT_ID} (agent · ${toolCount} tool call${toolCount === 1 ? '' : 's'})`, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass,
    });
    appendRecord({ ts: new Date().toISOString(), model: AGENT_ID, slot: sessionId, kind: 'home_command', artifact: started.runId, tools: toolCount, self_verified: toolCount > 0 && !unverified, status: run?.status || 'unknown' });
  }

  // The agent resumes after a decision (it sees the tool result, or that the action was declined).
  // Its closing reply becomes a new assistant turn in the same session, up to 5 minutes later.
  async function followUpAfterDecision(stepId, runId) {
    const step = db.prepare('SELECT session_id AS sessionId FROM fraymus_os_tool_steps WHERE id = ?').get(stepId);
    if (!step || !runId) return;
    const before = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE run_id = ?').get(runId).id;
    const turn = randomUUID();
    const now = Date.now();
    insertTurn.run(turn, step.sessionId, 'assistant', '', 'thinking', null, null, null, '[]', null, null, now, now);
    emit({ type: 'state', sessionId: step.sessionId, turnId: turn, state: 'thinking' });
    const deadline = Date.now() + 300_000;
    let run = null;
    for (;;) {
      await new Promise(done => setTimeout(done, 1000));
      run = db.prepare('SELECT status, error FROM runs WHERE id = ?').get(runId);
      if (!run || !['running', 'queued'].includes(run.status) || Date.now() > deadline) break;
    }
    const reply = db.prepare(`SELECT content FROM messages WHERE run_id = ? AND id > ? AND role = 'assistant' AND tool_calls IS NULL AND TRIM(COALESCE(content, '')) != '' ORDER BY id DESC LIMIT 1`).get(runId, before);
    const model = `${AGENT_ID} (agent · after your decision)`;
    if (run?.status === 'awaiting_approval') finish(turn, { state: 'idle', sources: [], answer: `${reply ? `${String(reply.content).trim()}\n\n` : ''}Another step is waiting for your approval.`, model, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
    else if (reply) finish(turn, { state: 'idle', sources: [], answer: String(reply.content).trim(), model, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
    else finish(turn, { state: run?.status === 'error' ? 'error' : 'idle', sources: [], answer: run?.status === 'error' ? null : 'The step is done. The agent added nothing further.', error: run?.status === 'error' ? (run.error || 'The agent run failed after the decision.') : null, model, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
  }

  const agentApprovalFor = stepId => { try { return db.prepare('SELECT approval_id AS approvalId, run_id AS runId FROM fraymus_os_agent_approvals WHERE step_id = ?').get(stepId) || null; } catch { return null; } };

  async function decideAgentApproval(stepId, approval, decision) {
    if (!['approve', 'deny'].includes(decision)) { const error = new Error('decision must be approve or deny'); error.status = 400; throw error; }
    const outcome = await fleet.decideApproval('local', approval.approvalId, decision === 'approve');
    followUpAfterDecision(stepId, approval.runId).catch(error => console.error('fraymus-os follow-up:', error.message));
    if (decision === 'deny') {
      updateTool.run('denied', JSON.stringify({ executed: false, reason: 'You declined. Nothing ran.' }), Date.now(), stepId);
      return { id: stepId, status: 'denied', executed: false };
    }
    const failed = !!outcome.error;
    updateTool.run(failed ? 'error' : 'ok', JSON.stringify({ executed: true, approvedByHuman: true, reason: failed ? String(outcome.error).slice(0, 300) : undefined, preview: JSON.stringify(outcome.result ?? null).slice(0, 700) }), Date.now(), stepId);
    return { id: stepId, status: failed ? 'error' : 'ok', executed: true, result: outcome.result ?? null };
  }


  const insertSession = db.prepare('INSERT INTO fraymus_os_sessions (id, created_at, updated_at) VALUES (?, ?, ?)');
  const touchSession = db.prepare('UPDATE fraymus_os_sessions SET updated_at = ? WHERE id = ?');
  const insertTurn = db.prepare(`INSERT INTO fraymus_os_turns
    (id, session_id, role, text, state, model, endpoint, route_class, sources, answer, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateTurn = db.prepare(`UPDATE fraymus_os_turns
    SET state = ?, model = ?, endpoint = ?, route_class = ?, sources = ?, answer = ?, error = ?, updated_at = ?
    WHERE id = ?`);
  const insertTool = db.prepare(`INSERT INTO fraymus_os_tool_steps
    (id, session_id, turn_id, tool, args, status, result, risk, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateTool = db.prepare('UPDATE fraymus_os_tool_steps SET status = ?, result = ?, updated_at = ? WHERE id = ?');

  function emit(payload) {
    try { broadcast?.('fraymus-os', payload); } catch (error) { console.error('fraymus-os broadcast:', error.message); }
  }

  function session(id) {
    const row = db.prepare('SELECT id, created_at AS createdAt, updated_at AS updatedAt FROM fraymus_os_sessions WHERE id = ?').get(id);
    if (!row) return null;
    const turns = db.prepare(`SELECT id, session_id AS sessionId, role, text, state, model, endpoint,
      route_class AS routeClass, sources, answer, error, created_at AS createdAt, updated_at AS updatedAt
      FROM fraymus_os_turns WHERE session_id = ? ORDER BY created_at ASC`).all(id).map(turn => ({
      ...turn,
      sources: turn.sources ? JSON.parse(turn.sources) : [],
    }));
    const tools = db.prepare(`SELECT id, session_id AS sessionId, turn_id AS turnId, tool, args, status, result, risk,
      created_at AS createdAt, updated_at AS updatedAt
      FROM fraymus_os_tool_steps WHERE session_id = ? ORDER BY created_at ASC`).all(id).map(step => ({
      ...step,
      args: step.args ? JSON.parse(step.args) : {},
      result: step.result ? JSON.parse(step.result) : null,
    }));
    const latest = [...turns].reverse().find(turn => turn.role === 'assistant');
    return { ...row, state: latest?.state || 'idle', turns, tools };
  }

  function sourcesFor(text) {
    return graph.search(text, 4);
  }

  async function proposeSkill(goal) {
    const id = randomUUID();
    const manifest = {
      id: `skill-${id.slice(0, 8)}`,
      name: goal.slice(0, 80),
      goal,
      inputs: ['text'],
      steps: ['Review this description.', 'Decide whether a person should write the skill later.'],
      implementation: null,
      tests: null,
      execution: 'blocked',
      install: 'blocked',
      note: 'MVP stores a reviewable spec only. No code is generated, executed, or installed.',
    };
    db.prepare('INSERT INTO fraymus_os_skill_proposals (id, goal, manifest, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, goal, JSON.stringify(manifest), 'review', Date.now());
    return { id, manifest, status: 'review' };
  }

  async function execute(turnId, sessionId, text, signal, mode = 'auto') {
    const intent = classify(text);
    let sources = [];
    try {
      throwIfAborted(signal);
      sources = await sourcesFor(text);
      throwIfAborted(signal);
      // The brain: anything that is not an instant lookup goes to a tool-holding fleet agent. Its real
      // tool calls are mirrored into this session, and approval-labelled tools pause for a person.
      if (fleet && mode !== 'quick' && (mode === 'agent' || ['chat', 'risky', 'propose_skill'].includes(intent.type))) {
        await runAgent(turnId, sessionId, text, signal, sources);
        return;
      }
      if (intent.type === 'risky') {
        const stepId = randomUUID();
        const now = Date.now();
        insertTool.run(stepId, sessionId, turnId, intent.tool, JSON.stringify({ text }), 'awaiting_approval', null, 'approval', now, now);
        const answer = intent.tool === 'external_publish'
          ? 'That would publish, send, or spend outside this machine. I paused it for approval. Approving still will not run it: publishing is outside the F.R.A.Y.M.U.S. MVP permissions.'
          : 'Enabling a generated skill needs approval. The MVP does not execute or install generated code, so approval records the decision and leaves the skill blocked.';
        finish(turnId, { state: 'idle', sources, answer, model: null, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
        emit({ type: 'approval_required', sessionId, turnId, stepId, tool: intent.tool });
        return;
      }
      if (intent.type === 'health') {
        const stepId = randomUUID();
        const now = Date.now();
        insertTool.run(stepId, sessionId, turnId, 'inspect_health', '{}', 'running', null, 'routine', now, now);
        const snap = await registry.snapshot();
        throwIfAborted(signal);
        const voiceStatus = voice ? await voice.status() : null;
        const answer = renderHealth(snap, voiceStatus);
        updateTool.run('ok', JSON.stringify({ routeClass: snap.ollama.routeClass, models: snap.ollama.models.map(model => model.name) }), Date.now(), stepId);
        finish(turnId, { state: 'idle', sources, answer, model: snap.ollama.selectedReasoning, endpoint: snap.ollama.url, routeClass: snap.ollama.routeClass });
        return;
      }
      if (intent.type === 'recall') {
        const stepId = randomUUID();
        const now = Date.now();
        insertTool.run(stepId, sessionId, turnId, 'recall_notes', JSON.stringify({ q: text }), 'running', null, 'routine', now, now);
        const found = await graph.query({ q: text.replace(/recall|remember|notes about|what do you know/ig, '').trim() || text, limit: 8 });
        throwIfAborted(signal);
        updateTool.run('ok', JSON.stringify({ count: found.matched }), Date.now(), stepId);
        const answer = found.nodes.length
          ? `I found ${found.matched} matching record${found.matched === 1 ? '' : 's'}:\n${found.nodes.map(node => `• ${node.title} (${node.kind}, ${node.sourceId})`).join('\n')}`
          : 'I looked through notes, memories, agents, workflows, and artifacts, and nothing matched that request.';
        finish(turnId, { state: 'idle', sources: found.nodes.slice(0, 4), answer, model: null, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
        return;
      }
      if (intent.type === 'propose_skill') {
        const stepId = randomUUID();
        const now = Date.now();
        const goal = text.replace(/.*propose (a )?skill( for| to|:)?/i, '').trim() || text;
        insertTool.run(stepId, sessionId, turnId, 'propose_skill', JSON.stringify({ goal }), 'running', null, 'routine', now, now);
        const proposal = await proposeSkill(goal);
        throwIfAborted(signal);
        updateTool.run('ok', JSON.stringify({ id: proposal.id, execution: 'blocked' }), Date.now(), stepId);
        finish(turnId, {
          state: 'idle',
          sources,
          answer: `I saved a reviewable skill spec (${proposal.id}). It has no implementation. Execution and installation stay blocked.`,
          model: null,
          endpoint: registry.ollama.url,
          routeClass: registry.ollama.routeClass,
        });
        return;
      }
      if (intent.type === 'draft') {
        const stepId = randomUUID();
        const now = Date.now();
        const topic = topicFrom(text);
        const preset = /\bscript\b/i.test(text) ? 'short-video-script' : 'research-brief';
        insertTool.run(stepId, sessionId, turnId, 'draft_creation', JSON.stringify({ preset, topic }), 'running', null, 'routine', now, now);
        throwIfAborted(signal);
        const artifact = await recipes.run(preset, { topic }, { signal });
        throwIfAborted(signal);
        updateTool.run('ok', JSON.stringify({ artifactId: artifact.id, creationRunId: artifact.creationRunId, status: artifact.status }), Date.now(), stepId);
        const title = artifact.payload?.brief?.title || artifact.topic;
        finish(turnId, {
          state: 'idle',
          sources,
          answer: `Saved ${preset.replaceAll('-', ' ')} “${title}”. Artifact ${artifact.id}. Nothing was published.`,
          model: artifact.provenance?.model || null,
          endpoint: registry.ollama.url,
          routeClass: registry.ollama.routeClass,
        });
        return;
      }

      const models = await registry.listModels();
      const model = registry.selectInstalledModel(models.models, 'reasoning');
      if (!model) {
        finish(turnId, {
          state: 'error',
          sources,
          answer: null,
          error: `No installed model is available at ${models.url || 'the configured Ollama endpoint'} (${models.routeClass}). ${models.error || 'Pull a model, or install fraynix-gpt for reasoning.'} You can still browse the second brain and save a note.`,
          model: null,
          endpoint: models.url,
          routeClass: models.routeClass,
        });
        return;
      }
      throwIfAborted(signal);
      const recalled = sources.slice(0, 3).map(source => `- ${source.id}: ${source.title} — ${source.summary}`).join('\n');
      const reply = await registry.chat({
        model,
        signal,
        messages: [
          { role: 'system', content: 'You are F.R.A.Y.M.U.S., the local command surface for Chandra. Do not claim to be any other assistant. Use the recalled sources when they apply and mention their ids. If you do not know, say so. Do not claim that a tool ran.' },
          { role: 'user', content: recalled ? `Recalled sources:\n${recalled}\n\nRequest: ${text}` : text },
        ],
      });
      throwIfAborted(signal);
      const answer = String(reply.text || '').trim();
      if (!answer) {
        finish(turnId, {
          state: 'error', sources, answer: null, model, endpoint: reply.endpoint, routeClass: reply.routeClass,
          error: `${model} returned an empty response.`,
        });
        return;
      }
      finish(turnId, { state: 'idle', sources, answer, model, endpoint: reply.endpoint, routeClass: reply.routeClass });
    } catch (error) {
      if (isAbort(error, signal)) {
        db.prepare(`UPDATE fraymus_os_tool_steps SET status = 'cancelled', updated_at = ? WHERE turn_id = ? AND status = 'running'`).run(Date.now(), turnId);
        finish(turnId, { state: 'cancelled', sources, answer: null, error: 'Cancelled. No further action was run.', model: null, endpoint: registry.ollama.url, routeClass: registry.ollama.routeClass });
        return;
      }
      console.error('fraymus-os command:', error.message);
      db.prepare(`UPDATE fraymus_os_tool_steps SET status = 'error', result = ?, updated_at = ? WHERE turn_id = ? AND status = 'running'`)
        .run(JSON.stringify({ error: error.message }), Date.now(), turnId);
      const artifact = error.artifact || null;
      finish(turnId, {
        state: 'error',
        sources,
        answer: artifact ? `The creation stage failed and the attempt was saved as ${artifact.id}.` : null,
        error: error.message,
        model: null,
        endpoint: registry.ollama.url,
        routeClass: registry.ollama.routeClass,
      });
    } finally {
      controllers.delete(turnId);
    }
  }

  function finish(turnId, fields) {
    updateTurn.run(
      fields.state,
      fields.model || null,
      fields.endpoint || null,
      fields.routeClass || null,
      JSON.stringify(fields.sources || []),
      fields.answer || null,
      fields.error || null,
      Date.now(),
      turnId,
    );
    const turn = db.prepare('SELECT session_id FROM fraymus_os_turns WHERE id = ?').get(turnId);
    if (turn) touchSession.run(Date.now(), turn.session_id);
    emit({ type: 'turn', turnId, state: fields.state });
  }

  function start({ text, sessionId, mode }) {
    const clean = String(text || '').trim();
    if (!clean) {
      const error = new Error('text is required');
      error.status = 400;
      throw error;
    }
    if (clean.length > 8000) {
      const error = new Error('text is too long (max 8000 characters)');
      error.status = 400;
      throw error;
    }
    const now = Date.now();
    let sid = sessionId;
    if (sid) {
      const existing = db.prepare('SELECT id FROM fraymus_os_sessions WHERE id = ?').get(sid);
      if (!existing) {
        const error = new Error('session not found');
        error.status = 404;
        throw error;
      }
      touchSession.run(now, sid);
    } else {
      sid = randomUUID();
      insertSession.run(sid, now, now);
    }
    const userTurn = randomUUID();
    const assistantTurn = randomUUID();
    insertTurn.run(userTurn, sid, 'user', clean, 'idle', null, null, null, null, null, null, now, now);
    insertTurn.run(assistantTurn, sid, 'assistant', '', 'thinking', null, null, null, '[]', null, null, now + 1, now + 1);
    const controller = new AbortController();
    controllers.set(assistantTurn, controller);
    emit({ type: 'state', sessionId: sid, turnId: assistantTurn, state: 'thinking' });
    execute(assistantTurn, sid, clean, controller.signal, ['agent', 'quick'].includes(mode) ? mode : 'auto').catch(error => {
      console.error('fraymus-os command escaped:', error.message);
    });
    return { sessionId: sid, turnId: assistantTurn, state: 'thinking' };
  }

  function cancel(turnId) {
    const controller = controllers.get(turnId);
    if (!controller) {
      const turn = db.prepare('SELECT state FROM fraymus_os_turns WHERE id = ?').get(turnId);
      if (!turn) {
        const error = new Error('run not found');
        error.status = 404;
        throw error;
      }
      return { cancelled: false, state: turn.state, reason: 'not_running' };
    }
    controller.abort();
    return { cancelled: true, turnId };
  }

  function decide(stepId, decision) {
    const step = db.prepare('SELECT id, tool, status FROM fraymus_os_tool_steps WHERE id = ?').get(stepId);
    if (!step) {
      const error = new Error('approval not found');
      error.status = 404;
      throw error;
    }
    if (step.status !== 'awaiting_approval') {
      const error = new Error(`This step is already ${step.status}`);
      error.status = 409;
      throw error;
    }
    const agentApproval = agentApprovalFor(stepId);
    if (agentApproval) return decideAgentApproval(stepId, agentApproval, decision);
    if (decision === 'deny') {
      updateTool.run('denied', JSON.stringify({ executed: false }), Date.now(), stepId);
      return { id: stepId, status: 'denied', executed: false };
    }
    if (decision !== 'approve') {
      const error = new Error('decision must be approve or deny');
      error.status = 400;
      throw error;
    }
    const reason = step.tool === 'enable_generated_skill'
      ? 'Execution and installation of generated skills are blocked in this MVP. Nothing was installed.'
      : 'Publishing, sending, and spending are outside the F.R.A.Y.M.U.S. MVP permission set. Nothing was sent.';
    updateTool.run('blocked', JSON.stringify({ executed: false, reason }), Date.now(), stepId);
    return { id: stepId, status: 'blocked', executed: false, reason };
  }

  return { start, cancel, decide, session, suggest: SUGGESTED_PROMPTS, classify, proposeSkill, brain, deck: CAPABILITY_DECK, agentId: AGENT_ID };
}

function renderHealth(snap, voice) {
  const names = snap.ollama.models.map(model => model.name);
  const lines = [
    `Ollama endpoint ${snap.ollama.url || 'unset'} is ${snap.ollama.routeClass}.`,
    names.length ? `Installed models: ${names.join(', ')}.` : 'No models are installed at that endpoint.',
    snap.ollama.reasoningInstalled
      ? `Reasoning will use ${snap.ollama.selectedReasoning}.`
      : 'Preferred reasoning model fraynix-gpt is not installed. A chat will use another installed model if one exists.',
    voice?.voiceStudio?.configured
      ? `VoiceStudio is configured at ${voice.voiceStudio.url} (${voice.voiceStudio.routeClass}) with voice ${voice.voiceId}.`
      : 'VoiceStudio is not configured. Set FRAYMUS_VOICESTUDIO_URL to enable vaughn-one or overlord.',
    voice?.piper?.available ? 'Piper is available as the local speech fallback.' : 'Piper is not available on this machine.',
    snap.policy.label + '.',
  ];
  if (snap.ollama.error) lines.push(snap.ollama.error);
  return lines.join('\n');
}
