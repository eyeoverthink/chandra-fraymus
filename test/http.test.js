import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { localBoundary } from '../server/local-http.js';
import { installRuntime, apiError } from '../server/runtime.js';
import { PORT } from '../server/config.js';
import { pdfFixture, zipFixture } from './document-fixtures.js';
import { wavFixture } from './audio-fixtures.js';
import { validateWav } from '../server/audio.js';

const MODEL = 'http-test:local';
const OLLAMA = 'http://127.0.0.1:49100';
const VOICE = 'http://127.0.0.1:49101';
const MAX_ASSET = 4 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const audioMetadata = bytes => { const { frames, ...metadata } = validateWav(bytes); return metadata; };
const completion = (text = 'HTTP verified: φ 🧠.') => ({
  done: true, done_reason: 'stop', message: { role: 'assistant', content: text },
  prompt_eval_count: 37, eval_count: 9,
});

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(5);
  }
  assert.fail('Timed out waiting for the HTTP integration state');
}

async function fixture(t, chatHandler = () => completion(), fixtureOptions = {}) {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(temporaryParent, 'fraymus-http-'));
  const originalTarget = await fs.realpath(folder);
  let db, runtime, server;
  const calls = [], chatCalls = [], broadcasts = [];
  t.after(async () => {
    if (runtime) {
      for (const run of runtime.agent.list()) if (!TERMINAL.has(run.status)) runtime.agent.cancel(run.id);
      await until(() => runtime.agent.list().every(run => TERMINAL.has(run.status)));
      await new Promise(resolve => setImmediate(resolve));
    }
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
    }
    db?.close();
    // Verify the resolved absolute target immediately before recursive deletion.
    const target = await fs.realpath(folder);
    assert.equal(target, originalTarget);
    assert.equal(path.dirname(target), temporaryParent);
    assert.ok(path.basename(target).startsWith('fraymus-http-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  const workspace = path.join(folder, 'workspace');
  const dataDir = path.join(folder, 'data');
  await fs.mkdir(workspace);
  db = new DatabaseSync(path.join(folder, 'runtime.sqlite'));
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.origin === VOICE && fixtureOptions.voiceHandler) return fixtureOptions.voiceHandler(parsed, options);
    // No fallback to global fetch: unexpected destinations fail this test immediately.
    assert.equal(parsed.origin, OLLAMA);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, body });
    if (parsed.pathname === '/api/tags') return Response.json({ models: [{ name: MODEL, size: 123 }] });
    if (parsed.pathname === '/api/show') return Response.json({ capabilities: fixtureOptions.modelCapabilities || ['completion'] });
    assert.equal(parsed.pathname, '/api/chat');
    chatCalls.push(body);
    const value = await chatHandler(body, chatCalls.length, options.signal);
    return value instanceof Response ? value : Response.json(value);
  };
  const app = express();
  app.use(localBoundary);
  app.use('/api/agent/assets', express.json({ limit: '6mb' }));
  app.use('/api/voice/listen', express.json({ limit: '6mb' }));
  app.use(express.json({ limit: '1mb' }));
  runtime = installRuntime(app, { db, broadcast: (...args) => broadcasts.push(args),
    workspace, dataDir, ollamaUrl: OLLAMA, voiceUrl: VOICE,
    cloud: { enabled: false }, fetchImpl, ...(fixtureOptions.webRequestImpl ? { webRequestImpl: fixtureOptions.webRequestImpl } : {}) });
  app.use('/api', (_request, response) => response.status(404).json({ error: 'Unknown API route' }));
  app.use(apiError);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  async function request(method, route, body, headers = {}) {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port,
        method, path: route,
        // The ephemeral socket is real; the application Host contract remains configured PORT.
        headers: { Host: `127.0.0.1:${PORT}`, Connection: 'close',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers } }, incoming => {
        const chunks = []; let length = 0;
        incoming.on('data', chunk => {
          length += chunk.length;
          if (length > 7 * 1024 * 1024) incoming.destroy(new Error('Unexpectedly oversized test response'));
          else chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json;
          try { if (incoming.headers['content-type']?.includes('application/json')) json = JSON.parse(bytes.toString('utf8')); }
          catch (error) { reject(error); return; }
          resolve({ status: incoming.statusCode, headers: incoming.headers, bytes, json });
        });
      });
      outgoing.setTimeout(15000, () => outgoing.destroy(new Error('HTTP integration request timed out')));
      outgoing.on('error', reject);
      outgoing.end(payload);
    });
  }
  const start = overrides => request('POST', '/api/agent/runs', {
    requestId: 'http-request', conversationId: 'http-conversation',
    goal: 'Return the bounded HTTP test answer.', model: MODEL, ...overrides,
  });
  const terminal = id => until(async () => {
    const response = await request('GET', `/api/agent/runs/${id}`);
    assert.equal(response.status, 200);
    return TERMINAL.has(response.json.status) && response.json;
  });
  return { request, start, terminal, calls, chatCalls, broadcasts };
}

test('HTTP local boundary denies hostile origins/hosts and permits the explicit development origin', async t => {
  const f = await fixture(t);
  const health = await f.request('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.localDefault, true);
  assert.equal(health.json.cloudConfigured, false);
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  for (const headers of [{ Origin: 'https://untrusted.example' }, { Host: 'attacker.example' },
    { Origin: 'http://127.0.0.1:5173', 'Sec-Fetch-Site': 'cross-site' }]) {
    const denied = await f.request('GET', '/api/health', undefined, headers);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  }
  const allowed = await f.request('GET', '/api/health', undefined, { Origin: 'http://127.0.0.1:5173' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
  const preflight = await f.request('OPTIONS', '/api/agent/runs', undefined, {
    Origin: 'http://localhost:4178', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type',
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:4178');
  assert.equal(f.calls.length, 0);
});

test('HTTP accepts an exact 4 MiB linear-base64 upload and downloads the same immutable bytes', async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(MAX_ASSET, 97);
  const uploaded = await f.request('POST', '/api/agent/assets', {
    name: 'large-text.txt', mimeType: 'text/plain', dataBase64: bytes.toString('base64'),
  });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.json.size, MAX_ASSET);
  assert.equal(uploaded.json.sha256, digest(bytes));
  const downloaded = await f.request('GET', `/api/agent/assets/${uploaded.json.id}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
  assert.equal(downloaded.bytes.length, MAX_ASSET);
  assert.equal(digest(downloaded.bytes), uploaded.json.sha256);
  assert.equal(f.calls.length, 0);
});

test('HTTP awaits PDF/ZIP indexing, preserves original downloads and supplies extracted reference data', async t => {
  const f = await fixture(t);
  const pdf = pdfFixture(['HTTP document reference needle']);
  const upload = await f.request('POST', '/api/agent/assets', { name: 'source.pdf', mimeType: 'application/pdf', dataBase64: pdf.toString('base64') });
  assert.equal(upload.status, 201); assert.equal(upload.json.document.pages, 1);
  const downloaded = await f.request('GET', `/api/agent/assets/${upload.json.id}`);
  assert.equal(downloaded.status, 200); assert.ok(downloaded.bytes.equals(pdf));
  assert.equal(downloaded.headers['content-type'], 'application/octet-stream');
  const zipped = await f.request('POST', '/api/agent/assets', { name: 'source.zip', mimeType: 'application/zip', dataBase64: zipFixture([{ name: 'source.md', text: 'archive reference' }]).toString('base64') });
  assert.equal(zipped.status, 201); assert.equal(zipped.json.document.entries.length, 1);
  const response = await f.start({ attachments: [upload.json.id, zipped.json.id] });
  assert.equal(response.status, 201);
  assert.equal((await f.terminal(response.json.id)).status, 'completed');
  const content = f.chatCalls[0].messages.at(-1).content;
  assert.match(content, /HTTP document reference needle/); assert.match(content, /archive reference/);
  assert.match(content, /UNTRUSTED_ATTACHMENT_DATA/); assert.match(content, /no OCR or visual inspection/);
  const rejected = await f.request('POST', '/api/agent/assets', { name: 'broken.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('broken').toString('base64') });
  assert.equal(rejected.status, 400); assert.match(rejected.json.error, /signature/);
  assert.equal((await f.request('GET', '/api/health')).status, 200);
});

test('HTTP rejects decoded assets above 4 MiB and PNG signatures without image structure', async t => {
  const f = await fixture(t);
  for (const upload of [
    { name: 'too-large.txt', mimeType: 'text/plain', dataBase64: Buffer.alloc(MAX_ASSET + 1, 98).toString('base64') },
    { name: 'signature-only.png', mimeType: 'image/png', dataBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') },
  ]) {
    const rejected = await f.request('POST', '/api/agent/assets', upload);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.code, 'invalid_request');
  }
  assert.equal((await f.request('GET', '/api/health')).status, 200);
  assert.equal(f.calls.length, 0);
});

test('HTTP WAV uploads transcribe only at the fixed voice bridge and expose text as untrusted attachments', async t => {
  const wave = wavFixture(), calls = [];
  const f = await fixture(t, undefined, { voiceHandler: async (url, options) => {
    assert.equal(url.pathname, '/listen'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); calls.push(body);
    assert.equal(Buffer.from(body.audioBase64, 'base64').compare(wave), 0);
    return Response.json({ ok: true, transcript: 'The secret color is blue.', engine: 'windows-system-speech-recognition', language: 'en-US', confidence: 0.8, audio: audioMetadata(wave) });
  } });
  const uploaded = await f.request('POST', '/api/agent/assets', { name: 'clip.wav', mimeType: 'audio/wav', dataBase64: wave.toString('base64') });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json)); assert.equal(uploaded.json.document.kind, 'audio');
  assert.equal(uploaded.json.document.transcript, 'The secret color is blue.'); assert.equal(calls.length, 1);
  const downloaded = await f.request('GET', `/api/agent/assets/${uploaded.json.id}`);
  assert.ok(downloaded.bytes.equals(wave)); assert.match(downloaded.headers['content-type'], /^audio\/wav/);
  const started = await f.start({ attachments: [uploaded.json.id] });
  assert.equal((await f.terminal(started.json.id)).status, 'completed');
  const content = f.chatCalls[0].messages.at(-1).content;
  assert.match(content, /WAV machine transcript/); assert.match(content, /The secret color is blue/); assert.match(content, /UNTRUSTED_ATTACHMENT_DATA/);
  const bad = await f.request('POST', '/api/agent/assets', { name: 'bad.wav', mimeType: 'audio/wav', dataBase64: Buffer.from('fake WAV').toString('base64') });
  assert.equal(bad.status, 400); assert.equal(calls.length, 1);
});

test('HTTP direct listening validates the body and backend receipt while other voice JSON limits remain unchanged', async t => {
  const wave = wavFixture({ frames: 600000, sampleRate: 16000 }), calls = [];
  const f = await fixture(t, undefined, { voiceHandler: async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json({ ok: true, transcript: 'A long bounded clip.', engine: 'windows-system-speech-recognition', language: 'en-US', confidence: 0.7, audio: audioMetadata(wave) });
  } });
  const response = await f.request('POST', '/api/voice/listen', { audioBase64: wave.toString('base64'), language: 'en-US' });
  assert.equal(response.status, 200, JSON.stringify(response.json)); assert.equal(response.json.transcript, 'A long bounded clip.'); assert.equal(calls.length, 1);
  const invalid = await f.request('POST', '/api/voice/listen', { audioBase64: wave.toString('base64'), url: 'https://other.example/' });
  assert.equal(invalid.status, 400); assert.equal(calls.length, 1);
  const other = await f.request('POST', '/api/voice/memory', { padding: 'x'.repeat(1024 * 1024) });
  assert.equal(other.status, 413); assert.equal(calls.length, 1);
});

test('HTTP applies the 1 MiB global/6 MiB asset parser limits and returns JSON parse errors', async t => {
  const f = await fixture(t);
  const global = await f.request('POST', '/api/lab/transport', { text: 'x'.repeat(1024 * 1024) });
  assert.equal(global.status, 413);
  assert.equal(global.json.code, 'entity.too.large');
  const asset = await f.request('POST', '/api/agent/assets', { padding: 'x'.repeat(6 * 1024 * 1024) });
  assert.equal(asset.status, 413);
  assert.equal(asset.json.code, 'entity.too.large');
  const malformed = await f.request('POST', '/api/agent/runs', '{broken');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json.code, 'entity.parse.failed');
  assert.equal(f.calls.length, 0);
});

test('HTTP idempotency preserves one run/inference and rejects changed input with 409', async t => {
  const f = await fixture(t);
  const [first, repeated] = await Promise.all([f.start(), f.start()]);
  assert.equal(first.status, 201); assert.equal(repeated.status, 201);
  assert.equal(first.json.id, repeated.json.id);
  const changed = await f.start({ goal: 'A changed request under the same key.' });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'idempotency_conflict');
  const final = await f.terminal(first.json.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.output, 'HTTP verified: φ 🧠.');
  assert.deepEqual(final.usage, { inputTokens: 37, outputTokens: 9, totalTokens: 46, costUsd: 0 });
  assert.equal(f.chatCalls.length, 1);
  assert.equal((await f.request('GET', '/api/agent/runs')).json.length, 1);
});

test('HTTP events replay actual final text/usage and obey the durable sequence cursor', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const final = await f.terminal(started.json.id);
  const response = await f.request('GET', `/api/agent/runs/${final.id}/events`);
  assert.equal(response.status, 200);
  const { events, run } = response.json;
  assert.equal(run.status, 'completed');
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1));
  const usage = events.find(event => event.type === 'usage');
  assert.equal(usage.data.actual, true);
  assert.equal(usage.data.inputTokens, 37); assert.equal(usage.data.outputTokens, 9);
  assert.equal(usage.data.totalTokens, 46); assert.equal(usage.data.costUsd, 0);
  assert.equal(events.at(-1).type, 'completed');
  assert.equal(events.at(-1).data.output, final.output);
  assert.equal(events.filter(event => event.type === 'text_delta').map(event => event.data.text).join(''), final.output);
  const cursor = usage.sequence;
  const after = await f.request('GET', `/api/agent/runs/${final.id}/events?afterSequence=${cursor}`);
  assert.deepEqual(after.json.events, events.filter(event => event.sequence > cursor));
  for (const invalid of ['-1', 'not-a-number']) {
    assert.equal((await f.request('GET', `/api/agent/runs/${final.id}/events?afterSequence=${invalid}`)).status, 400);
  }
});

test('HTTP unknown run endpoints consistently return 404 without invoking a provider', async t => {
  const f = await fixture(t);
  for (const [method, route, body] of [
    ['GET', '/api/agent/runs/unknown-run'], ['GET', '/api/agent/runs/unknown-run/events'],
    ['POST', '/api/agent/runs/unknown-run/cancel', {}],
    ['POST', '/api/agent/runs/unknown-run/approve', { approvalId: 'missing', approved: false }],
  ]) {
    const missing = await f.request(method, route, body);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'run_not_found');
  }
  assert.equal((await f.request('GET', '/api/not-a-route')).status, 404);
  assert.equal(f.calls.length, 0);
});

test('HTTP cancellation aborts a pending mock inference and persists exactly one cancelled event', async t => {
  let signalSeen, inferenceStarted = false;
  const f = await fixture(t, (_body, _index, signal) => {
    signalSeen = signal; inferenceStarted = true;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const started = await f.start();
  await until(() => inferenceStarted);
  const cancelled = await f.request('POST', `/api/agent/runs/${started.json.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.equal(signalSeen.aborted, true);
  const repeated = await f.request('POST', `/api/agent/runs/${started.json.id}/cancel`, {});
  assert.equal(repeated.json.status, 'cancelled');
  const events = (await f.request('GET', `/api/agent/runs/${started.json.id}/events`)).json.events;
  assert.equal(events.filter(event => event.type === 'cancelled').length, 1);
  assert.equal(events.filter(event => event.type === 'completed').length, 0);
  assert.equal(f.chatCalls.length, 1);
});

test('HTTP native web research pauses twice for exact URLs and reuses one retained source for find/read', async t => {
  const network = [];
  const native = (name, args) => ({ ...completion(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
  let sourceId;
  const f = await fixture(t, (body, index) => {
    if (index === 1) return native('web.fetch', { url: 'https://example.com/reference' });
    const result = JSON.parse(body.messages.at(-1).content.split('\n').slice(1).join('\n'));
    if (index === 2) { sourceId = result.sourceId; return native('web.find', { sourceId, query: 'HTTP needle' }); }
    if (index === 3) return native('web.read', { sourceId, startLine: result.matches[0].line, maxLines: 1 });
    if (index === 4) return native('web.follow', { sourceId, linkId: 1 });
    assert.equal(result.url, 'https://example.com/child');
    return completion('Read the approved source and its linked reference.');
  }, { modelCapabilities: ['completion', 'tools'], webRequestImpl: async url => {
    network.push(url);
    const html = '<title>HTTP source</title><p>HTTP needle</p><a href="/child">Child reference</a>';
    return { url, status: 200, contentType: 'text/html', bytes: Buffer.byteLength(html), fetchedAt: 123456789, rawSha256: digest(Buffer.from(html)), text: html };
  } });
  const created = await f.start({ goal: 'Research https://example.com/reference and its linked reference.', budget: { maxInputTokens: 32768, maxTotalTokens: 100000 } });
  assert.equal(created.status, 201);
  const id = created.json.id;
  const first = await until(async () => { const response = await f.request('GET', `/api/agent/runs/${id}`); assert.ok(!TERMINAL.has(response.json.status), JSON.stringify(response.json.error)); return response.json.status === 'awaiting_approval' && response.json; });
  assert.equal(first.pendingApproval.preview.url, 'https://example.com/reference'); assert.equal(network.length, 0);
  assert.equal((await f.request('POST', `/api/agent/runs/${id}/approve`, { approvalId: first.pendingApproval.approvalId, approved: true })).status, 200);
  const second = await until(async () => { const response = await f.request('GET', `/api/agent/runs/${id}`); assert.ok(!TERMINAL.has(response.json.status), JSON.stringify(response.json.error)); return response.json.status === 'awaiting_approval' && response.json.pendingApproval.approvalId !== first.pendingApproval.approvalId && response.json; });
  assert.equal(second.pendingApproval.name, 'web.follow'); assert.equal(second.pendingApproval.preview.url, 'https://example.com/child');
  assert.equal(second.pendingApproval.preview.parentSourceId, sourceId); assert.equal(second.pendingApproval.preview.parentSnapshotSha256.length, 64);
  assert.deepEqual(network, ['https://example.com/reference']);
  await f.request('POST', `/api/agent/runs/${id}/approve`, { approvalId: second.pendingApproval.approvalId, approved: true });
  const final = await f.terminal(id);
  assert.equal(final.status, 'completed'); assert.deepEqual(network, ['https://example.com/reference', 'https://example.com/child']);
  const events = (await f.request('GET', `/api/agent/runs/${id}/events`)).json.events;
  assert.deepEqual(events.filter(event => event.type === 'tool_started').map(event => event.data.name), ['web.fetch','web.find','web.read','web.follow']);
  assert.equal(events.filter(event => event.type === 'approval_required').length, 2);
});

test('HTTP native public search requires an exact approval and retains ranked results for offline reads', async t => {
  const query = 'CTranslate2 Windows installation';
  const queryUrl = 'https://lite.duckduckgo.com/lite/?q=CTranslate2+Windows+installation';
  const destinations = [
    'https://opennmt.net/CTranslate2/installation.html',
    'https://github.com/OpenNMT/CTranslate2',
    'https://pypi.org/project/ctranslate2/',
  ];
  const titles = ['CTranslate2 installation', 'CTranslate2 source', 'CTranslate2 Python wheels'];
  // DuckDuckGo Lite places each snippet in a following table row, not inside its link.
  const html = '<!doctype html><html><head><title>CTranslate2 Windows installation at DuckDuckGo</title></head><body>' +
    '<form action="/lite/" method="post"><input name="q" value="CTranslate2 Windows installation"></form><table>' +
    destinations.map((url, index) => `<tr><td>${index + 1}.</td><td><a rel="nofollow" class="result-link" href="${url}">${titles[index]}</a></td></tr>` +
      `<tr><td></td><td class="result-snippet">Installation reference ${index + 1} for Windows &amp; CPU inference.</td></tr>`).join('') +
    '</table></body></html>';
  const network = [];
  const native = (name, args) => ({ ...completion(''), message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } });
  const toolResult = body => {
    const message = body.messages.at(-1);
    assert.equal(message.role, 'tool');
    assert.match(message.content, /^UNTRUSTED TOOL OUTPUT/);
    return JSON.parse(message.content.split('\n').slice(1).join('\n'));
  };
  let sourceId, searchReceipt;
  const f = await fixture(t, (body, index) => {
    if (index <= 2) return native('web.search', { query, maxResults: 3 });
    const result = toolResult(body);
    if (index === 3) {
      searchReceipt = result; sourceId = result.sourceId;
      assert.match(sourceId, /^[a-zA-Z0-9-]+$/);
      assert.match(result.snapshotSha256, /^[a-f0-9]{64}$/);
      assert.deepEqual(result.results.map(item => item.rank), [1, 2, 3]);
      assert.deepEqual(result.results.map(item => item.url), destinations);
      assert.equal(result.search.query, query);
      assert.equal(result.untrusted, true);
      return native('web.results', { sourceId, offset: 1, maxResults: 2 });
    }
    if (index === 4) {
      assert.equal(result.sourceId, sourceId);
      assert.deepEqual(result.results.map(item => item.rank), [2, 3]);
      assert.equal(result.nextOffset, null);
      return native('web.read', { sourceId, startLine: 1, maxLines: 30, maxChars: 4000 });
    }
    assert.equal(index, 5);
    assert.equal(result.sourceId, sourceId);
    assert.match(result.lines.map(line => line.text).join('\n'), /Installation reference 1 for Windows & CPU inference\./);
    assert.deepEqual(network, [queryUrl]);
    return completion('Read three retained search snippets; no result pages were fetched.');
  }, { modelCapabilities: ['completion', 'tools'], webRequestImpl: async (url, options) => {
    assert.equal(url, queryUrl, 'only the approved fixed-provider query may be requested');
    assert.equal(options.signal.aborted, false);
    network.push(url);
    return { url, status: 200, contentType: 'text/html; charset=utf-8', bytes: Buffer.byteLength(html),
      fetchedAt: 123456789, rawSha256: digest(Buffer.from(html)), text: html };
  } });
  const awaiting = id => until(async () => {
    const response = await f.request('GET', `/api/agent/runs/${id}`);
    assert.equal(response.status, 200);
    assert.ok(!TERMINAL.has(response.json.status), JSON.stringify(response.json.error));
    return response.json.status === 'awaiting_approval' && response.json;
  });
  const checkPreview = run => {
    assert.equal(run.pendingApproval.name, 'web.search');
    assert.deepEqual(run.pendingApproval.arguments, { query, maxResults: 3 });
    const preview = run.pendingApproval.preview;
    assert.deepEqual(preview.provider, { id: 'duckduckgo-lite', label: 'DuckDuckGo Lite', url: 'https://lite.duckduckgo.com/lite/' });
    assert.equal(preview.query, query); assert.equal(preview.url, queryUrl);
    assert.equal(preview.method, 'GET'); assert.equal(preview.maxResults, 3);
    assert.equal(preview.sendsCookies, false); assert.equal(preview.redirectsFollowed, false);
    assert.equal(preview.fetchesResultPages, false);
    assert.deepEqual(network, []);
  };
  const overrides = { goal: `Search the public web for ${query} and read its retained snippets.`,
    budget: { maxInputTokens: 32768, maxTotalTokens: 100000 } };
  const declinedStart = await f.start({ ...overrides, requestId: 'search-declined', conversationId: 'search-declined' });
  assert.equal(declinedStart.status, 201);
  const declined = await awaiting(declinedStart.json.id); checkPreview(declined);
  const denial = await f.request('POST', `/api/agent/runs/${declined.id}/approve`, {
    approvalId: declined.pendingApproval.approvalId, approved: false,
  });
  assert.equal(denial.status, 200); assert.equal((await f.terminal(declined.id)).status, 'cancelled');
  assert.deepEqual(network, []);
  const deniedEvents = (await f.request('GET', `/api/agent/runs/${declined.id}/events`)).json.events;
  assert.equal(deniedEvents.filter(event => event.type === 'tool_started').length, 0);

  const approvedStart = await f.start({ ...overrides, requestId: 'search-approved', conversationId: 'search-approved' });
  assert.equal(approvedStart.status, 201);
  const approved = await awaiting(approvedStart.json.id); checkPreview(approved);
  assert.equal((await f.request('POST', `/api/agent/runs/${approved.id}/approve`, {
    approvalId: approved.pendingApproval.approvalId, approved: true,
  })).status, 200);
  const final = await f.terminal(approved.id);
  assert.equal(final.status, 'completed', JSON.stringify(final.error));
  assert.deepEqual(network, [queryUrl]);
  const firstReplay = (await f.request('GET', `/api/agent/runs/${approved.id}/events`)).json;
  const events = firstReplay.events;
  assert.equal(events.filter(event => event.type === 'approval_required').length, 1);
  assert.deepEqual(events.filter(event => event.type === 'tool_started').map(event => event.data.name), ['web.search', 'web.results', 'web.read']);
  const retained = events.find(event => event.type === 'tool_result' && event.data.name === 'web.search');
  assert.deepEqual(retained.data.result, searchReceipt);
  assert.equal(retained.data.result.rawSha256, digest(Buffer.from(html)));
  assert.deepEqual(retained.data.result.results.map(item => item.rank), [1, 2, 3]);
  assert.deepEqual((await f.request('GET', `/api/agent/runs/${approved.id}/events`)).json.events, events,
    'the ranked source receipt remains available through durable HTTP event replay');
  assert.equal(f.chatCalls.length, 5);
});
