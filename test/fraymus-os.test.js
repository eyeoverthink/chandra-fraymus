import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import { createFraymusOs, installFraymusOsRoutes, classifyHost, selectInstalledModel } from '../server/fraymus-os/index.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

async function until(fn, timeout = 2500) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await delay(15);
  }
  assert.fail(`timed out; last=${JSON.stringify(last)}`);
}

async function harness(t, options = {}) {
  const db = new Database(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'fraymus-os-'));
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const os = createFraymusOs({
    db,
    audioDir: directory,
    ollamaUrl: 'http://127.0.0.1:11434',
    voiceStudioUrl: '',
    allowPublicCloud: false,
    listAgents: () => [],
    piperAvailable: async () => false,
    fetchImpl: async () => { throw new Error('unexpected network'); },
    ...options,
  });
  installFraymusOsRoutes(app, { os });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    db.close();
  }));
  const port = server.address().port;
  async function request(method, path, body) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: response.status, json };
  }
  return { db, os, request, directory };
}

test('route class follows the actual host', () => {
  assert.equal(classifyHost('127.0.0.1'), 'local');
  assert.equal(classifyHost('localhost'), 'local');
  assert.equal(classifyHost('10.1.2.3'), 'private');
  assert.equal(classifyHost('192.168.1.9'), 'private');
  assert.equal(classifyHost('100.64.0.2'), 'private');
  assert.equal(classifyHost('8.8.8.8'), 'public');
  assert.equal(classifyHost('ollama.example.com'), 'public');
});

test('reasoning prefers an installed fraynix-gpt and never invents one', () => {
  assert.equal(selectInstalledModel([{ name: 'llama3.1:8b' }, { name: 'fraynix-gpt:latest' }], 'reasoning'), 'fraynix-gpt:latest');
  assert.equal(selectInstalledModel([{ name: 'fraynix-dna:8b' }], 'fast'), 'fraynix-dna:8b');
  assert.equal(selectInstalledModel([{ name: 'llama3.1:8b' }], 'reasoning'), 'llama3.1:8b');
  assert.equal(selectInstalledModel([], 'reasoning'), null);
});

test('graph reads real records without writing them', async t => {
  const { db, request } = await harness(t, {
    listAgents: () => [{ id: 'solon', name: 'Solon', role: 'policy', description: 'Reviews permissions' }],
  });
  db.exec(`
    CREATE TABLE memory (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE agent_memories (
      id INTEGER PRIMARY KEY, agent_id TEXT, category TEXT, key TEXT, value TEXT,
      confidence REAL, source TEXT, verified_at INTEGER, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE vertiso_memories (
      id TEXT PRIMARY KEY, agent_id TEXT, namespace TEXT, content TEXT, summary TEXT,
      importance REAL, provenance TEXT, confidence REAL, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, name TEXT, nodes TEXT, user_id TEXT, created_at INTEGER, updated_at INTEGER
    );
    INSERT INTO memory VALUES ('studio', 'local voice bench', 10);
    INSERT INTO agent_memories VALUES (7, 'solon', 'policy', 'approval', 'Publishing needs a person', 0.9, 'agent', NULL, 10, 11);
    INSERT INTO vertiso_memories VALUES ('v1', 'solon', 'global', 'Measured note about provenance', 'provenance', 0.5, 'measured', 1, 10, 12);
    INSERT INTO workflows VALUES ('wf1', 'Brief pipeline', '[{"id":"a"}]', 'local', 10, 13);
  `);
  const before = {
    memory: db.prepare('SELECT * FROM memory').all(),
    agent: db.prepare('SELECT * FROM agent_memories').all(),
    vertiso: db.prepare('SELECT * FROM vertiso_memories').all(),
    workflows: db.prepare('SELECT * FROM workflows').all(),
  };
  const graph = await request('GET', '/api/fraymus-os/graph');
  assert.equal(graph.status, 200);
  assert.equal(graph.json.counts.memory, 3);
  assert.equal(graph.json.counts.agent, 1);
  assert.equal(graph.json.counts.workflow, 1);
  assert.equal(graph.json.total, 5);
  const memory = graph.json.nodes.find(node => node.source === 'vertiso_memories');
  assert.equal(memory.provenance.provenance, 'measured');
  assert.equal(memory.provenance.agentId, 'solon');
  const filtered = await request('GET', '/api/fraymus-os/graph?q=provenance&kind=memory');
  assert.equal(filtered.json.matched, 1);
  assert.equal(filtered.json.nodes[0].sourceId, 'v1');
  const joined = await request('GET', `/api/fraymus-os/graph/path?from=${encodeURIComponent(memory.id)}&to=${encodeURIComponent('agent:solon')}`);
  assert.equal(joined.json.found, true);
  assert.deepEqual(joined.json.path, [memory.id, 'agent:solon']);
  const opened = await request('GET', `/api/fraymus-os/graph/node/${encodeURIComponent(memory.id)}`);
  assert.equal(opened.status, 200);
  assert.equal(opened.json.sourceId, 'v1');
  assert.deepEqual(db.prepare('SELECT * FROM memory').all(), before.memory);
  assert.deepEqual(db.prepare('SELECT * FROM agent_memories').all(), before.agent);
  assert.deepEqual(db.prepare('SELECT * FROM vertiso_memories').all(), before.vertiso);
  assert.deepEqual(db.prepare('SELECT * FROM workflows').all(), before.workflows);
});

test('empty graph reports zero instead of sample notes', async t => {
  const { request } = await harness(t);
  const graph = await request('GET', '/api/fraymus-os/graph');
  assert.equal(graph.json.total, 0);
  assert.equal(graph.json.counts.note, 0);
  assert.deepEqual(graph.json.nodes, []);
});

test('a saved note shows up with provenance', async t => {
  const { request } = await harness(t);
  const created = await request('POST', '/api/fraymus-os/notes', { title: 'Bench', body: 'Voice bench lives on the local machine', tags: ['voice'] });
  assert.equal(created.status, 201);
  const graph = await request('GET', '/api/fraymus-os/graph?q=bench');
  assert.equal(graph.json.matched, 1);
  assert.equal(graph.json.nodes[0].kind, 'note');
  assert.equal(graph.json.nodes[0].provenance.writer, 'user');
  assert.equal(graph.json.counts.note, 1);
});

test('text command answers from the named installed model and records real token counts', async t => {
  let chatBody = null;
  const { request } = await harness(t, {
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/api/tags')) {
        return Response.json({ models: [{ name: 'llama3.1:8b', size: 4 }, { name: 'fraynix-gpt:latest', size: 9 }] });
      }
      if (String(url).endsWith('/api/chat')) {
        chatBody = init.body;
        await delay(40);
        return Response.json({
          message: { content: 'Provenance is the recorded source of a memory.' },
          prompt_eval_count: 11,
          eval_count: 5,
          eval_duration: 2_000_000_000,
        });
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const started = await request('POST', '/api/fraymus-os/command', { text: 'Explain provenance in one sentence.' });
  assert.equal(started.status, 202);
  const session = await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${started.json.sessionId}`);
    return row.json.state === 'idle' ? row.json : null;
  });
  const answer = session.turns.find(turn => turn.role === 'assistant');
  assert.equal(answer.model, 'fraynix-gpt:latest');
  assert.equal(answer.routeClass, 'local');
  assert.match(answer.answer, /Provenance is the recorded source/);
  assert.match(chatBody, /fraynix-gpt:latest/);
  const telemetry = await request('GET', '/api/fraymus-os/telemetry');
  assert.equal(telemetry.json.tokensMeasured, true);
  assert.equal(telemetry.json.tokensIn, 11);
  assert.equal(telemetry.json.tokensOut, 5);
  assert.equal(telemetry.json.tokensPerSec, 2.5);
  assert.equal(telemetry.json.publicCalls, 0);
  assert.ok(telemetry.json.dataSentBytes >= Buffer.byteLength(chatBody));
  const log = await request('GET', '/api/fraymus-os/telemetry/log');
  const chat = log.json.requests.find(row => row.kind === 'ollama_chat');
  assert.equal(chat.bytesSent, Buffer.byteLength(chatBody));
  assert.equal(chat.routeClass, 'local');
  assert.ok(chat.durationMs >= 40);
});

test('unavailable Ollama does not invent an answer', async t => {
  let chats = 0;
  const { request } = await harness(t, {
    fetchImpl: async url => {
      if (String(url).endsWith('/api/chat')) chats += 1;
      throw new Error('connect ECONNREFUSED');
    },
  });
  const started = await request('POST', '/api/fraymus-os/command', { text: 'Explain provenance in one sentence.' });
  const session = await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${started.json.sessionId}`);
    return row.json.state === 'error' ? row.json : null;
  });
  const answer = session.turns.find(turn => turn.role === 'assistant');
  assert.equal(answer.answer, null);
  assert.match(answer.error, /No installed model/);
  assert.equal(chats, 0);
  const status = await request('GET', '/api/fraymus-os/status');
  assert.deepEqual(status.json.ollama.models, []);
  assert.equal(status.json.ollama.selectedReasoning, null);
});

test('a public endpoint is not called when public cloud is disabled', async t => {
  let fetched = false;
  const { request } = await harness(t, {
    ollamaUrl: 'https://ollama.example.com',
    fetchImpl: async () => { fetched = true; throw new Error('should not send'); },
  });
  const status = await request('GET', '/api/fraymus-os/status');
  assert.equal(status.json.ollama.routeClass, 'public');
  assert.match(status.json.ollama.error, /No data was sent/);
  assert.equal(fetched, false);
  const telemetry = await request('GET', '/api/fraymus-os/telemetry');
  assert.equal(telemetry.json.publicCalls, 0);
  assert.equal(telemetry.json.dataSentBytes, 0);
  assert.ok(telemetry.json.blockedPublicAttempts >= 1);
});

test('cancellation stops the turn before a later tool or draft is saved', async t => {
  let drafts = 0;
  const { db, request } = await harness(t, {
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'fraynix-gpt:latest' }] });
      await new Promise((resolve, reject) => {
        if (init.signal?.aborted) reject(abortError());
        else init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      return Response.json({ message: { content: 'too late' } });
    },
    runCreativeBrief: async (_input, ctx) => {
      drafts += 1;
      await new Promise((resolve, reject) => {
        if (ctx.signal?.aborted) reject(abortError());
        else ctx.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
      drafts += 10;
      return { brief: { title: 'should not save' } };
    },
  });
  const chat = await request('POST', '/api/fraymus-os/command', { text: 'Explain provenance in one sentence.' });
  await delay(30);
  const cancelled = await request('POST', `/api/fraymus-os/runs/${chat.json.turnId}/cancel`, {});
  assert.equal(cancelled.json.cancelled, true);
  const session = await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${chat.json.sessionId}`);
    return row.json.state === 'cancelled' ? row.json : null;
  });
  assert.match(session.turns.at(-1).error, /No further action/);
  assert.equal(session.tools.length, 0);

  const draft = await request('POST', '/api/fraymus-os/command', { text: 'Draft a research brief about rivers' });
  await until(async () => drafts >= 1);
  await request('POST', `/api/fraymus-os/runs/${draft.json.turnId}/cancel`, {});
  await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${draft.json.sessionId}`);
    return row.json.state === 'cancelled' ? row.json : null;
  });
  assert.equal(drafts, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM fraymus_os_artifacts').get().c, 0);
});

test('risky tools wait for a person and still do not execute', async t => {
  const { request } = await harness(t);
  const started = await request('POST', '/api/fraymus-os/command', { text: 'publish this to shopify' });
  const session = await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${started.json.sessionId}`);
    return row.json.tools[0]?.status === 'awaiting_approval' ? row.json : null;
  });
  const denied = await request('POST', `/api/fraymus-os/approvals/${session.tools[0].id}`, { decision: 'deny' });
  assert.equal(denied.json.status, 'denied');
  assert.equal(denied.json.executed, false);

  const again = await request('POST', '/api/fraymus-os/command', { text: 'enable the generated skill now' });
  const pending = await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${again.json.sessionId}`);
    return row.json.tools[0]?.status === 'awaiting_approval' ? row.json : null;
  });
  const approved = await request('POST', `/api/fraymus-os/approvals/${pending.tools[0].id}`, { decision: 'approve' });
  assert.equal(approved.json.status, 'blocked');
  assert.equal(approved.json.executed, false);
  assert.match(approved.json.reason, /Nothing was installed/);
});

test('voice input falls back to text, and a transcript uses the same command path', async t => {
  const { request } = await harness(t, {
    transcribe: async () => { throw new Error('faster-whisper is not installed'); },
    fetchImpl: async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'fraynix-gpt:latest' }] });
      return Response.json({ message: { content: 'Heard you.' }, prompt_eval_count: 3, eval_count: 2, eval_duration: 1_000_000_000 });
    },
  });
  const missing = await request('POST', '/api/fraymus-os/command/voice', { audioBase64: Buffer.from('not-audio').toString('base64') });
  assert.equal(missing.status, 503);
  assert.equal(missing.json.fallback, 'text');
  assert.match(missing.json.error, /Type your request/);

  const { request: requestOk } = await harness(t, {
    transcribe: async () => ({ text: 'Explain provenance in one sentence.', engine: 'faster-whisper', routeClass: 'local' }),
    fetchImpl: async url => {
      if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'fraynix-gpt:latest' }] });
      return Response.json({ message: { content: 'Heard you.' }, prompt_eval_count: 3, eval_count: 2, eval_duration: 1_000_000_000 });
    },
  });
  const heard = await requestOk('POST', '/api/fraymus-os/command/voice', { audioBase64: Buffer.from('RIFFfake').toString('base64') });
  assert.equal(heard.status, 202);
  assert.equal(heard.json.transcript, 'Explain provenance in one sentence.');
  const session = await until(async () => {
    const row = await requestOk('GET', `/api/fraymus-os/sessions/${heard.json.sessionId}`);
    return row.json.state === 'idle' ? row.json : null;
  });
  assert.equal(session.turns.find(turn => turn.role === 'assistant').model, 'fraynix-gpt:latest');
  assert.match(session.turns.find(turn => turn.role === 'assistant').answer, /Heard you/);
});

test('speech uses VoiceStudio, falls back to Piper, and does not fall back after cancel', async t => {
  let piperCalls = 0;
  const { request, os } = await harness(t, {
    voiceStudioUrl: 'http://127.0.0.1:9',
    fetchImpl: async () => new Response('no', { status: 503, headers: { 'content-type': 'text/plain' } }),
    speakPiper: async () => {
      piperCalls += 1;
      return { buffer: Buffer.from('RIFF'), format: 'wav', durationMs: 4 };
    },
  });
  const spoken = await request('POST', '/api/fraymus-os/speak', { text: 'Hello from F.R.A.Y.M.U.S.', voice: 'vaughn-one' });
  assert.equal(spoken.status, 200);
  assert.equal(spoken.json.engine, 'piper');
  assert.equal(spoken.json.voiceRequested, 'vaughn-one');
  assert.equal(piperCalls, 1);
  assert.match(spoken.json.voiceStudioError, /503/);

  const rejected = await request('POST', '/api/fraymus-os/speak', { text: 'Hello', voice: 'aria' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.json.error, /vaughn-one or overlord/);

  let fallbackCalls = 0;
  const hanging = await harness(t, {
    voiceStudioUrl: 'http://127.0.0.1:9',
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(abortError());
      else init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    }),
    speakPiper: async () => { fallbackCalls += 1; return { buffer: Buffer.from('RIFF') }; },
  });
  const controller = new AbortController();
  const pending = hanging.os.voice.speak('Stop', { voice: 'overlord', signal: controller.signal });
  await delay(20);
  controller.abort();
  await assert.rejects(pending, /cancelled|aborted/i);
  assert.equal(fallbackCalls, 0);
  assert.equal(os.voice.audioDir.length > 0, true);
});

test('both presets persist structured artifacts and honest failures', async t => {
  const { db, request } = await harness(t, {
    runCreativeBrief: async ({ topic }) => ({ brief: { title: `Brief: ${topic}`, hook: 'Open on the bench', shots: [{}] }, model: 'fraynix-gpt:latest' }),
    runScriptWriter: async () => ({ script: { narration_script: 'A one minute script.', shot_list: [{ shot_number: 1 }] } }),
  });
  db.exec(`CREATE TABLE creation_pipeline_runs (
    id TEXT PRIMARY KEY, topic TEXT, format TEXT, status TEXT, stages TEXT,
    shot_count INTEGER, channels TEXT, created_at INTEGER
  )`);
  const brief = await request('POST', '/api/fraymus-os/recipes/research-brief/run', { topic: 'local memory' });
  assert.equal(brief.status, 201);
  assert.equal(brief.json.artifact.status, 'completed');
  assert.equal(brief.json.artifact.payload.brief.title, 'Brief: local memory');
  assert.equal(brief.json.artifact.provenance.publishes, false);
  assert.ok(brief.json.artifact.creationRunId);
  const run = db.prepare('SELECT * FROM creation_pipeline_runs WHERE id = ?').get(brief.json.artifact.creationRunId);
  assert.equal(run.status, 'completed');

  const script = await request('POST', '/api/fraymus-os/recipes/short-video-script/run', { topic: 'second brain' });
  assert.equal(script.json.artifact.payload.script.narration_script, 'A one minute script.');
  const graph = await request('GET', '/api/fraymus-os/graph?kind=artifact');
  assert.ok(graph.json.counts.artifact >= 2);

  const { request: failing } = await harness(t, {
    runCreativeBrief: async () => { throw new Error('Ollama is not reachable'); },
  });
  const failed = await failing('POST', '/api/fraymus-os/recipes/research-brief/run', { topic: 'offline' });
  assert.equal(failed.status, 503);
  assert.match(failed.json.error, /not reachable/);
  assert.equal(failed.json.artifact.status, 'failed');
});

test('skill proposals stay reviewable and blocked', async t => {
  const { request } = await harness(t);
  const created = await request('POST', '/api/fraymus-os/skills/propose', { goal: 'Summarize a note without sending it' });
  assert.equal(created.status, 201);
  assert.equal(created.json.manifest.implementation, null);
  assert.equal(created.json.manifest.execution, 'blocked');
  const enabled = await request('POST', `/api/fraymus-os/skills/${created.json.id}/enable`, {});
  assert.equal(enabled.status, 403);
  assert.equal(enabled.json.executed, false);
  const graph = await request('GET', '/api/fraymus-os/graph?kind=skill');
  assert.equal(graph.json.counts.skill, 1);
  assert.match(graph.json.nodes[0].summary, /execution blocked/);
});

test('an agent command runs on the chosen model and the turn names what really answered', async t => {
  let started = null;
  const fleet = {
    startRun: (_user, agentId, text, threadId, opts) => {
      started = { agentId, text, opts };
      db.prepare("INSERT INTO runs (id, status, error, steps) VALUES ('run-1', 'done', NULL, 2)").run();
      db.prepare("INSERT INTO messages (run_id, role, name, content, tool_calls) VALUES ('run-1', 'assistant', NULL, 'Five open findings, none blocking.', NULL)").run();
      return { runId: 'run-1', threadId: threadId || 'thread-1' };
    },
    toolNames: () => [], listAgents: () => [], decideApproval: async () => ({}),
    modelCallsForRun: runId => (runId === 'run-1' ? [{ host: 'home', model: 'qwen3:14b', calls: 2, ms: 900 }] : []),
    lastModelCall: () => ({ host: 'home', model: 'qwen3:14b', at: Date.now() }),
  };
  const { request, db } = await harness(t, { fleet });
  db.exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, status TEXT, error TEXT, steps INTEGER);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, role TEXT, name TEXT, content TEXT, tool_calls TEXT);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, run_id TEXT, tool TEXT, args TEXT, status TEXT, created_at INTEGER);`);
  const sent = await request('POST', '/api/fraymus-os/command', { text: 'How many findings are open?', mode: 'agent', model: 'qwen3:14b' });
  assert.equal(sent.status, 202);
  const session = await until(async () => {
    const row = await request('GET', `/api/fraymus-os/sessions/${sent.json.sessionId}`);
    return row.json.state === 'idle' ? row.json : null;
  });
  assert.deepEqual(started.opts, { model: 'qwen3:14b', interactive: true }, 'the chosen model reaches the fleet, and the run is marked as a person waiting (never queued behind autonomous work)');
  const answer = session.turns.find(turn => turn.role === 'assistant');
  assert.match(answer.answer, /Five open findings/);
  assert.match(answer.model, /qwen3:14b on home \(2 calls\)/, 'the turn names the machine and model that answered, not the local default');
  assert.equal(answer.routeClass, 'private');
});
