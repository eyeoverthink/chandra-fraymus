/**
 * One text/voice command loop.
 * Routine tools run immediately. Publishing and skill installation stop for a person,
 * and the MVP still refuses to execute them after approval.
 */

import { randomUUID } from 'node:crypto';
import { isAbort } from './http-error.js';

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

export function createCommandService({ db, registry, graph, recipes, voice, broadcast }) {
  const controllers = new Map();

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

  async function execute(turnId, sessionId, text, signal) {
    const intent = classify(text);
    let sources = [];
    try {
      throwIfAborted(signal);
      sources = await sourcesFor(text);
      throwIfAborted(signal);
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

  function start({ text, sessionId }) {
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
    execute(assistantTurn, sid, clean, controller.signal).catch(error => {
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

  return { start, cancel, decide, session, suggest: SUGGESTED_PROMPTS, classify, proposeSkill };
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
