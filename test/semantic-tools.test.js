import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createArtifactStore } from '../server/artifacts.js';
import { createSemanticTools, semanticChunks, CHUNK_POLICY } from '../server/retrieval/tools.js';
import { createSemanticIndexStore } from '../server/retrieval/index-store.js';
import { createAgentService } from '../server/agent/service.js';
import { hash } from '../server/agent/schema.js';
import { zipFixture } from './document-fixtures.js';

const identity = () => ({ provider: 'ollama', model: 'nomic-embed-text:latest', digest: hash('pinned-model'),
  documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
const error = (code, properties = {}) => Object.assign(new Error(code), { code, ...properties });
const code = expected => caught => caught?.code === expected;

// This fake tests the tool-to-ledger protocol. The durable ledger itself has its
// own real SQLite tests; each invocation here must own exactly one opaque ticket.
function meter({ maximum = Infinity } = {}) {
  const tickets = new Map(), events = [];
  let actual = 0, held = 0;
  return {
    events, get actual() { return actual; }, get held() { return held; },
    reserve(estimated) {
      assert.ok(Number.isSafeInteger(estimated) && estimated >= 0);
      if (actual + held + estimated > maximum) throw error('budget_tokens');
      const ticket = Object.freeze({}); tickets.set(ticket, { estimated, status: 'reserved' }); held += estimated;
      events.push({ type: 'reserve', estimated }); return ticket;
    },
    settle(ticket, count) {
      const entry = tickets.get(ticket); assert.equal(entry?.status, 'reserved');
      assert.ok(Number.isSafeInteger(count) && count >= 0);
      entry.status = 'settled'; held -= entry.estimated; actual += count;
      events.push({ type: 'settle', count }); return { overBudget: actual + held > maximum };
    },
    unknown(ticket) {
      const entry = tickets.get(ticket); assert.equal(entry?.status, 'reserved'); entry.status = 'unknown';
      events.push({ type: 'unknown' });
    },
    notDispatched(ticket) {
      const entry = tickets.get(ticket); assert.equal(entry?.status, 'reserved'); entry.status = 'not_dispatched';
      held -= entry.estimated; events.push({ type: 'not_dispatched' });
    },
    track(promise) { events.push({ type: 'track' }); return promise; },
  };
}

function provider(options = {}) {
  const calls = [], inspections = [];
  return {
    calls, inspections,
    async inspect({ signal } = {}) {
      inspections.push({ signal }); signal?.throwIfAborted();
      return options.inspect ? options.inspect({ signal }) : identity();
    },
    async embed(texts, invocation) {
      const call = { texts: [...texts], kind: invocation.kind, expectedIdentity: invocation.expectedIdentity, dispatched: false };
      calls.push(call);
      const estimatedInputTokens = options.estimate ?? texts.reduce((sum, value) => sum + Buffer.byteLength(value) + 64, 32);
      try { await invocation.beforeRequest({ estimatedInputTokens }); }
      catch (caught) { caught.dispatched = false; throw caught; }
      call.dispatched = true;
      if (options.embed) return options.embed(texts, invocation, calls.length);
      return { identity: identity(), inputTokens: texts.length * 7,
        vectors: texts.map(value => new Float32Array(invocation.kind === 'query' || value.includes('needle') ? [1, 0] : [0, 1])) };
    },
  };
}

function fixture(t, options = {}) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'fraymus-semantic-tools-'));
  const resolved = realpathSync(root), db = new DatabaseSync(':memory:'), services = [];
  const artifacts = createArtifactStore(root), store = createSemanticIndexStore({ db }), embedder = options.embedder ?? provider();
  const tools = Object.fromEntries(createSemanticTools({ artifacts, store, embedder }).map(tool => [tool.name, tool]));
  t.after(async () => {
    for (const service of services) await service.close();
    db.close();
    const target = realpathSync(root);
    assert.equal(target, resolved); assert.equal(dirname(target), parent); assert.ok(basename(target).startsWith('fraymus-semantic-tools-'));
    rmSync(target, { recursive: true, force: true });
  });
  const text = (value = 'needle evidence', name = 'source.txt') => artifacts.put({ name, mimeType: 'text/plain', dataBase64: Buffer.from(value).toString('base64') });
  const context = (args, overrides = {}) => ({ args, signal: new AbortController().signal, run: { attachments: [args.assetId] }, auxiliaryInput: meter(), ...overrides });
  const execute = (name, args, overrides) => tools[`artifact.semantic${name}`].execute(context(args, overrides));
  // A trusted extraction-sidecar fixture exercises the real artifact scope and
  // integrity API without launching the native PDF parser. ZIP parsing is also
  // exercised separately with an actual ZIP upload below.
  function document(kind, sections) {
    const id = randomUUID(), data = Buffer.from(`original ${kind} fixture ${id}`), spans = [];
    let value = '';
    for (const section of sections) {
      if (value) value += '\n\n';
      const start = value.length; value += section.text;
      spans.push({ ...(kind === 'pdf' ? { page: section.page } : { entry: section.entry }), start, end: value.length });
    }
    const sidecar = Buffer.from(JSON.stringify({ version: 1, kind, sourceSha256: hash(data), text: value, spans, warnings: ['Untrusted extraction fixture'] }));
    writeFileSync(join(root, id + '.bin'), data);
    writeFileSync(join(root, id + '.document.json'), sidecar);
    writeFileSync(join(root, id + '.json'), JSON.stringify({ id, name: `source.${kind}`, mimeType: `application/${kind}`, size: data.length, sha256: hash(data), documentSha256: hash(sidecar) }));
    return { id, text: value, spans };
  }
  return { root, db, artifacts, store, embedder, tools, text, context, execute, document, services };
}

test('attachment authorization precedes metadata inspection and applies again to a complete persistent cache', async t => {
  const f = fixture(t), asset = f.text(), args = { assetId: asset.id, query: 'meaning' };
  await assert.rejects(f.execute('Search', args, { run: { attachments: [] } }), /not attached/);
  assert.equal(f.embedder.inspections.length, 0); assert.equal(f.embedder.calls.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM semantic_indexes').get().n, 0);
  const complete = await f.execute('Search', args);
  assert.equal(complete.ok, true);
  const calls = f.embedder.calls.length, inspections = f.embedder.inspections.length;
  for (const [name, value] of [['Status', { assetId: asset.id }], ['Search', args], ['Forget', { assetId: asset.id, indexId: complete.index.id }]])
    await assert.rejects(f.execute(name, value, { run: { attachments: [] } }), /not attached/);
  assert.equal(f.embedder.calls.length, calls); assert.equal(f.embedder.inspections.length, inspections);
  assert.equal(f.store.get(complete.index.id).complete, true);
});

test('PDF page scopes retain exact offsets, references and distinct whole-document/cache identities', async t => {
  const f = fixture(t), asset = f.document('pdf', [{ page: 1, text: 'first-page sentinel' }, { page: 2, text: 'needle second-page evidence' }]);
  const result = await f.execute('Search', { assetId: asset.id, page: 2, query: 'second evidence' });
  assert.equal(result.ok, true); assert.deepEqual(result.index.scope, { page: 2 });
  assert.equal(result.index.baseOffset, asset.spans[1].start);
  assert.equal(result.hits[0].text, 'needle second-page evidence'); assert.equal(result.hits[0].offset, asset.spans[1].start);
  assert.equal(result.hits[0].sourceOffset, 0); assert.equal(result.hits[0].endOffset, asset.spans[1].end);
  assert.deepEqual(result.hits[0].references, [asset.spans[1]]);
  assert.equal(result.index.sourceHash, hash(result.hits[0].text)); assert.equal(result.untrusted, true);
  assert.match(result.meaning, /not proof/);
  assert.ok(f.embedder.calls.every(call => call.texts.every(value => !value.includes('first-page sentinel'))));
  const whole = await f.execute('Status', { assetId: asset.id });
  assert.notEqual(whole.index.id, result.index.id);
  await assert.rejects(f.execute('Search', { assetId: asset.id, page: 3, query: 'missing' }), /not found/);
  await assert.rejects(f.execute('Status', { assetId: asset.id, page: 1, entry: 'fake' }), /either/);
});

test('real ZIP source scope is an exact readable entry, never a prefix, protected member or another file', async t => {
  const f = fixture(t), bytes = zipFixture([{ name: 'project/one.md', text: 'needle selected member' },
    { name: 'project/one.md.backup.txt', text: 'other-member sentinel' }, { name: 'project/.env', text: 'PRIVATE_SENTINEL' }]);
  const asset = await f.artifacts.put({ name: 'source.zip', mimeType: 'application/zip', dataBase64: bytes.toString('base64') });
  const result = await f.execute('Search', { assetId: asset.id, entry: 'project/one.md', query: 'selected' });
  assert.deepEqual(result.index.scope, { entry: 'project/one.md' });
  assert.equal(result.hits[0].text, 'needle selected member'); assert.equal(result.hits[0].references[0].entry, 'project/one.md');
  assert.ok(f.embedder.calls.every(call => call.texts.every(value => !/other-member|PRIVATE_SENTINEL/.test(value))));
  for (const entry of ['project/one', 'PROJECT/one.md', 'project/.env', '../project/one.md'])
    await assert.rejects(f.execute('Status', { assetId: asset.id, entry }), /not found/);
  await assert.rejects(f.execute('Status', { assetId: asset.id, page: 1 }), /PDF/);
});

test('incomplete indexing never issues a query or returns ranked partial hits; a new tool instance resumes persisted chunks', async t => {
  const f = fixture(t), asset = f.text('漢'.repeat(16000)), args = { assetId: asset.id, query: 'paraphrase', maxNewChunks: 17 };
  const partial = await f.execute('Search', args);
  assert.equal(partial.ok, false); assert.equal(partial.querySkipped, true); assert.deepEqual(partial.hits, []);
  assert.equal(partial.newChunks, 17); assert.equal(partial.index.storedChunks, 17); assert.equal(partial.embeddingInputTokens, 17 * 7);
  assert.deepEqual(f.embedder.calls.map(call => [call.kind, call.texts.length]), [['document', 8], ['document', 8], ['document', 1]]);
  for (const call of f.embedder.calls) assert.ok(call.texts.reduce((sum, value) => sum + Buffer.byteLength(identity().documentPrefix + value), 0) <= 32768);
  const cachedOnly = await f.execute('Search', { ...args, maxNewChunks: 0 });
  assert.equal(cachedOnly.querySkipped, true); assert.equal(cachedOnly.newChunks, 0); assert.equal(f.embedder.calls.length, 3);
  const restoredStore = createSemanticIndexStore({ db: f.db });
  const search = createSemanticTools({ artifacts: f.artifacts, store: restoredStore, embedder: f.embedder }).find(tool => tool.name === 'artifact.semanticSearch');
  const remaining = partial.index.totalChunks - 17, result = await search.execute(f.context({ ...args, maxNewChunks: 128, maxResults: 2 }));
  assert.equal(result.ok, true); assert.equal(result.newChunks, remaining); assert.equal(result.index.complete, true);
  assert.equal(result.embeddingInputTokens, (remaining + 1) * 7); assert.equal(result.hits.length, 2);
  assert.equal(result.index.storedChunks, result.index.totalChunks); assert.equal(result.index.dimensions, 2);
  assert.equal(result.index.vectorBytes, result.index.totalChunks * (64 + 2 * 4));
  assert.equal(f.embedder.calls.at(-1).kind, 'query');
  assert.ok(f.embedder.calls.every(call => JSON.stringify(call.expectedIdentity) === JSON.stringify(identity())));
  const calls = f.embedder.calls.length, existing = await f.execute('Search', { ...args, maxNewChunks: 0 });
  assert.equal(existing.newChunks, 0); assert.equal(f.embedder.calls.length, calls + 1); assert.equal(f.embedder.calls.at(-1).kind, 'query');
});

test('every document/query dispatch reserves and settles actual input exactly once; status does not embed', async t => {
  const f = fixture(t), asset = f.text('needle '.repeat(160)), accounting = meter();
  const status = await f.execute('Status', { assetId: asset.id });
  assert.equal(status.index.complete, false); assert.equal(f.embedder.calls.length, 0);
  const result = await f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting });
  assert.equal(result.newChunks, 2); assert.equal(result.embeddingInputTokens, 21); assert.equal(accounting.actual, 21); assert.equal(accounting.held, 0);
  assert.equal(accounting.events.filter(event => event.type === 'reserve').length, 2);
  assert.deepEqual(accounting.events.filter(event => event.type === 'settle').map(event => event.count), [14, 7]);
  assert.equal(accounting.events.filter(event => event.type === 'track').length, 2);
  const g = fixture(t), other = g.text();
  const noLedger = await g.execute('Search', { assetId: other.id, query: 'meaning' }, { auxiliaryInput: undefined });
  assert.equal(noLedger.stop.code, 'semantic_budget_unavailable'); assert.equal(g.embedder.calls.length, 0); assert.deepEqual(noLedger.hits, []);
});

test('reservation failure is pre-dispatch and cannot populate a partial index', async t => {
  const f = fixture(t), asset = f.text(), accounting = meter({ maximum: 0 });
  const result = await f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting });
  assert.equal(result.stop.code, 'budget_tokens'); assert.equal(result.querySkipped, true); assert.equal(result.index.storedChunks, 0);
  assert.equal(accounting.actual, 0); assert.equal(accounting.held, 0);
  assert.equal(f.embedder.calls.length, 1); assert.equal(f.embedder.calls[0].dispatched, false);
});

test('an embedding adapter cannot populate vectors without invoking the input reservation hook', async t => {
  const embedder = provider();
  embedder.embed = async () => ({ inputTokens: 7, vectors: [new Float32Array([1, 0])] });
  const f = fixture(t, { embedder }), asset = f.text(), accounting = meter();
  const result = await f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting });
  assert.equal(result.stop.code, 'semantic_budget_unavailable'); assert.equal(result.querySkipped, true);
  assert.equal(result.index.storedChunks, 0); assert.equal(accounting.actual, 0); assert.equal(accounting.held, 0);
});

for (const [name, failure, expectedActual, expectedHeld, ticketEvent] of [
  ['known post-dispatch usage', { inputTokens: 19, dispatched: true }, 19, 0, 'settle'],
  ['uncertain post-dispatch usage', { dispatched: true }, 0, 10, 'unknown'],
  ['proven non-dispatch', { dispatched: false }, 0, 0, 'not_dispatched'],
]) test(`${name} is accounted without ranking an incomplete cache`, async t => {
  const f = fixture(t, { embedder: provider({ estimate: 10, embed: async () => { throw error('embedding_failed', failure); } }) }), asset = f.text(), accounting = meter();
  const result = await f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting });
  assert.equal(result.ok, false); assert.equal(result.querySkipped, true); assert.deepEqual(result.hits, []); assert.equal(result.index.storedChunks, 0);
  assert.equal(accounting.actual, expectedActual); assert.equal(accounting.held, expectedHeld);
  assert.equal(result.embeddingInputTokens, expectedActual); assert.ok(accounting.events.some(event => event.type === ticketEvent));
  assert.equal(f.embedder.calls.length, 1);
});

test('actual embedding overage remains charged and reported, and stops before vector commit/query', async t => {
  const f = fixture(t, { embedder: provider({ estimate: 10, embed: async () => ({ inputTokens: 19, vectors: [new Float32Array([1, 0])] }) }) });
  const asset = f.text(), accounting = meter({ maximum: 15 });
  const result = await f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting });
  assert.equal(result.stop.code, 'budget_tokens'); assert.equal(result.embeddingInputTokens, 19); assert.equal(accounting.actual, 19);
  assert.equal(result.index.storedChunks, 0); assert.equal(f.embedder.calls.length, 1); assert.equal(accounting.held, 0);
});

test('cancellation before inspection, after inspection and after paid work never commits new vectors or queries', async t => {
  const pre = new AbortController(); pre.abort(error('cancelled_test'));
  const f = fixture(t), asset = f.text();
  await assert.rejects(f.execute('Search', { assetId: asset.id, query: 'meaning' }, { signal: pre.signal }), code('cancelled_test'));
  assert.equal(f.embedder.inspections.length, 0);
  const inspecting = new AbortController();
  const g = fixture(t, { embedder: provider({ inspect: () => { inspecting.abort(error('cancelled_inspect')); return identity(); } }) }), second = g.text();
  await assert.rejects(g.execute('Status', { assetId: second.id }, { signal: inspecting.signal }), code('cancelled_inspect'));
  assert.equal(g.db.prepare('SELECT count(*) AS n FROM semantic_indexes').get().n, 0);
  const working = new AbortController(), accounting = meter();
  const h = fixture(t, { embedder: provider({ embed: async () => { working.abort(error('cancelled_work')); return { inputTokens: 13, vectors: [new Float32Array([1, 0])] }; } }) }), third = h.text();
  await assert.rejects(h.execute('Search', { assetId: third.id, query: 'meaning' }, { signal: working.signal, auxiliaryInput: accounting }), code('cancelled_work'));
  assert.equal(accounting.actual, 13); assert.equal(accounting.held, 0); assert.equal(h.embedder.calls.length, 1);
  assert.equal(h.db.prepare('SELECT stored_chunks FROM semantic_indexes').get().stored_chunks, 0);
});

test('mismatched query dimensions fail after accounting and a corrupt persistent vector is rejected before a query', async t => {
  const f = fixture(t, { embedder: provider({ embed: async (texts, options) => ({ inputTokens: 7, vectors: texts.map(() => new Float32Array(options.kind === 'query' ? [1, 0, 0] : [1, 0])) }) }) });
  const asset = f.text(), accounting = meter();
  await assert.rejects(f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting }), code('semantic_dimensions'));
  assert.equal(accounting.actual, 14); assert.equal(accounting.held, 0);
  const g = fixture(t), another = g.text(), result = await g.execute('Search', { assetId: another.id, query: 'meaning' });
  const calls = g.embedder.calls.length;
  g.db.prepare('UPDATE semantic_index_chunks SET vector_blob=? WHERE index_id=?').run(Buffer.alloc(72), result.index.id);
  await assert.rejects(g.execute('Search', { assetId: another.id, query: 'meaning', maxNewChunks: 0 }), code('semantic_index_corrupt'));
  assert.equal(g.embedder.calls.length, calls);
});

test('a mixed-dimension document batch commits no vectors and its actual input remains charged', async t => {
  const f = fixture(t, { embedder: provider({ embed: async () => ({ inputTokens: 14, vectors: [new Float32Array([1, 0]), new Float32Array([1, 0, 0])] }) }) });
  const asset = f.text('needle '.repeat(160)), accounting = meter();
  const result = await f.execute('Search', { assetId: asset.id, query: 'meaning' }, { auxiliaryInput: accounting });
  assert.equal(result.stop.code, 'semantic_index_conflict'); assert.equal(result.index.storedChunks, 0);
  assert.equal(result.embeddingInputTokens, 14); assert.equal(accounting.actual, 14); assert.equal(accounting.held, 0);
  assert.equal(result.querySkipped, true); assert.equal(f.embedder.calls.length, 1);
});

test('malformed queries and unknown source fields fail before metadata or embedding requests', async t => {
  const f = fixture(t), asset = f.text();
  for (const query of [' ', '\ud800', 'nul\0query', 'x'.repeat(513)])
    await assert.rejects(f.execute('Search', { assetId: asset.id, query }), code('invalid_arguments'));
  await assert.rejects(f.execute('Search', { assetId: asset.id, query: 'meaning', path: 'arbitrary-host-path' }), code('invalid_arguments'));
  assert.equal(f.embedder.inspections.length, 0); assert.equal(f.embedder.calls.length, 0);
});

test('source/sidecar integrity is rechecked even for a complete cache', async t => {
  const f = fixture(t), asset = f.text(), result = await f.execute('Search', { assetId: asset.id, query: 'meaning' });
  writeFileSync(join(f.root, asset.id + '.bin'), 'tampered bytes');
  const calls = f.embedder.calls.length;
  await assert.rejects(f.execute('Status', { assetId: asset.id }), /integrity/);
  assert.equal(f.embedder.calls.length, calls); assert.equal(f.store.get(result.index.id).complete, true);
  const pdf = f.document('pdf', [{ page: 1, text: 'needle evidence' }]);
  await f.execute('Search', { assetId: pdf.id, page: 1, query: 'meaning' });
  const path = join(f.root, pdf.id + '.document.json'); writeFileSync(path, readFileSync(path, 'utf8').replace('needle', 'changed'));
  await assert.rejects(f.execute('Status', { assetId: pdf.id, page: 1 }), /index integrity/);
});

test('forget preview binds exact source, scope and model identity and preserves originals/other scopes', async t => {
  let current = identity();
  const f = fixture(t, { embedder: provider({ inspect: () => current }) }), asset = f.document('pdf', [{ page: 1, text: 'first evidence' }, { page: 2, text: 'needle second evidence' }]);
  const one = await f.execute('Search', { assetId: asset.id, page: 1, query: 'meaning' });
  const two = await f.execute('Search', { assetId: asset.id, page: 2, query: 'meaning' });
  const tool = f.tools['artifact.semanticForget'], args = { assetId: asset.id, page: 1, indexId: one.index.id };
  assert.equal(tool.approvalRequired, true);
  const preview = await tool.prepare(f.context(args));
  assert.equal(preview.kind, 'semantic_forget'); assert.equal(preview.index.id, one.index.id); assert.deepEqual(preview.index.scope, { page: 1 });
  assert.equal(preview.originalAssetPreserved, true);
  await assert.rejects(tool.execute(f.context({ ...args, page: 2 })), code('semantic_index_mismatch'));
  current = { ...identity(), digest: hash('replacement-model') };
  await assert.rejects(tool.execute(f.context(args)), code('semantic_index_mismatch'));
  current = identity();
  const removed = await tool.execute(f.context(args)); assert.equal(removed.removed, true); assert.equal(removed.originalAssetPreserved, true);
  assert.equal(f.store.get(one.index.id), null); assert.equal(f.store.get(two.index.id).complete, true);
  assert.equal(f.artifacts.textScope(asset.id, { page: 1 }, { attachments: [asset.id] }).text, 'first evidence');
});

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for isolated mock agent');
}

for (const tamper of [false, true]) test(`real agent approval ${tamper ? 'rejects tampered' : 'consumes exact'} semantic forget arguments`, async t => {
  const f = fixture(t), asset = f.text(), cached = await f.execute('Search', { assetId: asset.id, query: 'meaning' });
  const args = { assetId: asset.id, indexId: cached.index.id }; let rounds = 0;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/tags') return Response.json({ models: [{ name: 'test:local', size: 1 }] });
    if (pathname === '/api/show') return Response.json({ capabilities: ['completion', 'tools'] });
    assert.equal(pathname, '/api/chat'); assert.ok(JSON.parse(options.body).messages.length); rounds++;
    return Response.json({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2,
      message: rounds === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'forget-call', function: { name: 'artifact.semanticForget', arguments: args } }] }
        : { role: 'assistant', content: 'Derived cache removed; original retained.' } });
  };
  const service = createAgentService({ db: f.db, workspace: f.root, fetchImpl, extraTools: Object.values(f.tools), resolveAttachments: async () => ({ text: 'Attached reference data only', images: [] }) });
  f.services.push(service);
  const run = await service.start({ requestId: 'forget-request', conversationId: 'forget-conversation', goal: 'Forget this semantic cache.', model: 'test:local', attachments: [asset.id] });
  const approval = await until(() => service.get(run.id).approval);
  assert.equal(f.store.get(cached.index.id).complete, true); assert.equal(approval.name, 'artifact.semanticForget');
  assert.equal(approval.preview.index.id, cached.index.id);
  assert.throws(() => service.approve(run.id, { approvalId: 'not-this-preview', approved: true }), code('approval_mismatch'));
  if (tamper) f.db.prepare('UPDATE agent_approvals SET args_json=? WHERE id=?').run(JSON.stringify({ ...args, indexId: hash('different-scope') }), approval.approvalId);
  service.approve(run.id, { approvalId: approval.approvalId, approved: true });
  const terminal = await until(() => { const value = service.get(run.id); return ['completed', 'cancelled', 'failed'].includes(value.status) && value; });
  if (tamper) { assert.equal(terminal.error.code, 'approval_mismatch'); assert.equal(f.store.get(cached.index.id).complete, true); }
  else {
    assert.equal(terminal.status, 'completed'); assert.equal(f.store.get(cached.index.id), null);
    assert.equal(f.db.prepare('SELECT status FROM agent_approvals WHERE id=?').get(approval.approvalId).status, 'consumed');
    assert.throws(() => service.approve(run.id, { approvalId: approval.approvalId, approved: true }), code('approval_mismatch'));
  }
  assert.equal(f.artifacts.inspect(asset.id).data.toString(), 'needle evidence');
});

test('the real agent context persists document/query input tickets and combines actual chat/embedding usage', async t => {
  const f = fixture(t), asset = f.text('needle '.repeat(160)); let rounds = 0;
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/api/tags') return Response.json({ models: [{ name: 'test:local', size: 1 }] });
    if (pathname === '/api/show') return Response.json({ capabilities: ['completion', 'tools'] });
    assert.equal(pathname, '/api/chat'); rounds++;
    const body = JSON.parse(options.body);
    if (rounds === 2) assert.match(body.messages.at(-1).content, /Cosine-ranked candidate passages/);
    return Response.json({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2,
      message: rounds === 1 ? { role: 'assistant', content: '', tool_calls: [{ id: 'search-call', function: { name: 'artifact.semanticSearch', arguments: { assetId: asset.id, query: 'meaning' } } }] }
        : { role: 'assistant', content: 'Candidate passages found.' } });
  };
  const service = createAgentService({ db: f.db, workspace: f.root, fetchImpl, extraTools: Object.values(f.tools), resolveAttachments: async () => ({ text: 'Attached reference data only', images: [] }) });
  f.services.push(service);
  const run = await service.start({ requestId: 'semantic-request', conversationId: 'semantic-conversation', goal: 'Find semantic passages.', model: 'test:local', attachments: [asset.id] });
  const terminal = await until(() => { const value = service.get(run.id); return ['completed', 'failed', 'cancelled'].includes(value.status) && value; });
  assert.equal(terminal.status, 'completed'); assert.equal(rounds, 2);
  assert.equal(terminal.usage.inputTokens, 41); assert.equal(terminal.usage.outputTokens, 4); assert.equal(terminal.usage.totalTokens, 45);
  assert.equal(terminal.usage.auxiliaryInputTokens, 21); assert.equal(terminal.usage.reservedInputTokens, 0);
  const rows = f.db.prepare('SELECT status,actual_input_tokens FROM agent_auxiliary_inputs ORDER BY rowid').all();
  assert.deepEqual(rows.map(row => [row.status, row.actual_input_tokens]), [['settled', 14], ['settled', 7]]);
  const result = service.events(run.id).find(event => event.type === 'tool_result' && event.data.name === 'artifact.semanticSearch').data.result;
  assert.equal(result.embeddingInputTokens, 21); assert.equal(result.ok, true); assert.equal(result.index.complete, true);
});

test('Unicode and CRLF chunk boundaries retain exact hashes, offsets and every non-whitespace code unit', () => {
  const text = 'a'.repeat(999) + '😀\r\n漢字 '.repeat(600) + 'tail', chunks = semanticChunks(text), covered = new Uint8Array(text.length);
  assert.equal(CHUNK_POLICY.offsetUnits, 'UTF-16');
  chunks.forEach((chunk, ordinal) => {
    const value = text.slice(chunk.start, chunk.end);
    assert.equal(chunk.ordinal, ordinal); assert.equal(value.isWellFormed(), true); assert.ok(value.trim()); assert.ok(value.length <= 1000);
    assert.equal(chunk.textHash, hash(value)); assert.ok(!(text[chunk.start - 1] === '\r' && text[chunk.start] === '\n'));
    assert.ok(!(text[chunk.end - 1] === '\r' && text[chunk.end] === '\n'));
    covered.fill(1, chunk.start, chunk.end);
  });
  for (let i = 0; i < text.length; i++) if (text[i].trim()) assert.equal(covered[i], 1, `source offset ${i} is covered`);
});

test('whitespace-only windows are skipped with dense ordinals while source/window limits remain strict', () => {
  const text = 'start' + ' '.repeat(4500) + 'finish', chunks = semanticChunks(text), coverage = new Uint8Array(text.length);
  assert.equal(CHUNK_POLICY.skipWhitespaceOnly, true); assert.ok(chunks.length < 6);
  chunks.forEach((chunk, ordinal) => { assert.equal(chunk.ordinal, ordinal); assert.ok(text.slice(chunk.start, chunk.end).trim()); coverage.fill(1, chunk.start, chunk.end); });
  for (let i = 0; i < text.length; i++) if (text[i].trim()) assert.equal(coverage[i], 1);
  for (const input of ['', ' \r\n\t', 'nul\0text', '\ud800']) assert.throws(() => semanticChunks(input), code('semantic_empty_source'));
  assert.throws(() => semanticChunks('start' + ' '.repeat(902000) + 'finish'), code('semantic_source_limit'));
});
