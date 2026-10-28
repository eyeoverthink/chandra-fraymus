import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmbeddingProvider } from '../server/retrieval/embedding.js';

const MODEL = 'nomic-embed-text:latest', D1 = '1'.repeat(64), D2 = '2'.repeat(64);
const BASE = 'http://127.0.0.1:11434';
function fixture(options = {}) {
  const calls = [], state = { digest: D1, capabilities: ['embedding'], ...options.state };
  const fetchImpl = async (url, request = {}) => {
    assert.equal(new URL(url).origin, BASE); assert.equal(request.redirect, 'error');
    const entry = { path: new URL(url).pathname, method: request.method, body: request.body ? JSON.parse(request.body) : undefined, signal: request.signal }; calls.push(entry);
    if (options.handler) { const result = await options.handler(entry, state, calls); if (result !== undefined) return result; }
    if (entry.path === '/api/tags') return Response.json({ models: [{ name: MODEL, model: MODEL, digest: state.digest, ...state.tagMetadata }, { name: 'unrelated:cloud', model: 'unrelated:cloud', digest: D2, remote_host: 'https://ollama.com' }] });
    if (entry.path === '/api/show') return Response.json({ capabilities: state.capabilities, ...state.showMetadata });
    assert.equal(entry.path, '/api/embed');
    return Response.json({ model: MODEL, embeddings: entry.body.input.map(() => [3, 4]), prompt_eval_count: 17, ...state.response });
  };
  return { provider: createEmbeddingProvider({ url: BASE, fetchImpl, ...options.config }), calls, state };
}
const embeds = fixture => fixture.calls.filter(call => call.path === '/api/embed');

test('fresh local identity includes exact tag digest and prefixes; batch posts untruncated inputs and returns actual normalized Float32 vectors', async () => {
  const f = fixture(), identity = await f.provider.inspect(); assert.ok(Object.isFrozen(identity));
  assert.deepEqual(identity, { provider: 'ollama', model: MODEL, digest: D1, documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
  let reservedAt, estimated;
  const result = await f.provider.embed(['first document', 'φ second'], { kind: 'document', expectedIdentity: identity, beforeRequest: reservation => { assert.ok(Object.isFrozen(reservation)); estimated = reservation.estimatedInputTokens; reservedAt = f.calls.length; assert.equal(embeds(f).length, 0); } });
  const sent = embeds(f)[0]; assert.ok(f.calls.indexOf(sent) >= reservedAt); assert.deepEqual(sent.body.input, ['search_document: first document', 'search_document: φ second']); assert.equal(sent.body.truncate, false);
  assert.equal(sent.body.dimensions, undefined); assert.equal(result.inputTokens, 17); assert.equal(result.estimatedInputTokens, Buffer.byteLength(sent.body.input.join('')) + 64 * sent.body.input.length + 32); assert.equal(estimated, result.estimatedInputTokens);
  assert.equal(result.dimensions, 2); assert.equal(result.vectors.length, 2); assert.ok(result.vectors.every(vector => vector instanceof Float32Array && Math.abs(Math.hypot(...vector) - 1) < 1e-6));
  assert.ok(f.calls.slice(f.calls.indexOf(sent) + 1).some(call => call.path === '/api/show')); assert.ok(f.calls.slice(f.calls.indexOf(sent) + 1).some(call => call.path === '/api/tags'));
  assert.deepEqual(result.identity, identity);
  const queried = await f.provider.embed(['question'], { kind: 'query', expectedIdentity: identity }); assert.equal(embeds(f).at(-1).body.input[0], 'search_query: question'); assert.equal(queried.inputTokens, 17);
});

test('expected identity rejects prefix/model changes before requests and digest changes before any POST', async () => {
  const f = fixture(), identity = await f.provider.inspect(); f.calls.length = 0;
  for (const changed of [{ ...identity, queryPrefix: 'different: ' }, { ...identity, model: 'other:latest' }, {}, { ...identity, extra: true }]) {
    await assert.rejects(f.provider.embed(['question'], { kind: 'query', expectedIdentity: changed }), caught => ['embedding_identity','embedding_identity_changed'].includes(caught.code) && caught.dispatched === false);
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(f.provider.embed(['question'], { kind: 'query', expectedIdentity: { ...identity, digest: D2 } }), caught => caught.code === 'embedding_identity_changed' && caught.dispatched === false);
  assert.ok(f.calls.length > 0); assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('local-only guards reject cloud names/URLs and remote alias metadata at inventory, show and embedding boundaries', async () => {
  for (const url of ['https://example.com','http://127.0.0.1:11434/api','http://user:secret@localhost:11434','http://localhost:11434?x=1']) assert.throws(() => createEmbeddingProvider({ url }));
  for (const model of ['m:cloud','cloud/model','m-cloud:latest']) assert.throws(() => createEmbeddingProvider({ model }), { code: 'local_cloud_blocked' });
  for (const state of [{ tagMetadata: { remote_host: 'https://ollama.com', remote_model: 'm' } }, { showMetadata: { remote_model: 'm', remote_host: 'https://ollama.com' } }]) {
    const f = fixture({ state }); await assert.rejects(f.provider.embed(['private text'], { kind: 'document' }), caught => caught.code === 'local_cloud_blocked' && caught.dispatched === false); assert.equal(embeds(f).length, 0);
  }
  const f = fixture({ state: { response: { remote_host: 'https://ollama.com' } } });
  await assert.rejects(f.provider.embed(['text'], { kind: 'query' }), caught => caught.code === 'local_cloud_blocked' && caught.dispatched === true && caught.inputTokens === 17);
});

test('inspect requires an exact unambiguous digest and explicit embedding capability without caching metadata', async () => {
  for (const state of [{ digest: '' }, { digest: 'short' }, { capabilities: ['completion'] }, { capabilities: [] }, { capabilities: undefined }]) {
    const f = fixture({ state }); await assert.rejects(f.provider.inspect()); assert.equal(embeds(f).length, 0);
  }
  const duplicate = fixture({ handler: entry => entry.path === '/api/tags' ? Response.json({ models: [{ name: MODEL, digest: D1 }, { name: MODEL, digest: D1 }] }) : undefined });
  await assert.rejects(duplicate.provider.inspect(), { code: 'embedding_model_unavailable' });
  const f = fixture(); assert.equal((await f.provider.inspect()).digest, D1); f.state.digest = D2; assert.equal((await f.provider.inspect()).digest, D2);
});

test('input count, dense strings and prefixed UTF-8 byte budgets are validated before any request', async () => {
  const f = fixture(); const sparse = new Array(2); sparse[1] = 'text';
  for (const input of [[], new Array(33).fill('x'), sparse, [1], [''], [' '], ['\ud800'], ['a\0b'], ['😀'.repeat(1024)], new Array(9).fill('x'.repeat(4080))]) {
    await assert.rejects(f.provider.embed(input, { kind: 'document' }), caught => ['embedding_arguments','embedding_input_limit'].includes(caught.code) && caught.dispatched === false);
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(f.provider.embed(['text'], { kind: 'query', dimensions: 2 }), { code: 'embedding_arguments' });
});

test('a reserving beforeRequest failure or cancellation is explicitly not dispatched', async () => {
  const f = fixture(), stopped = Object.assign(new Error('Owned budget exhausted'), { code: 'budget_tokens' }); let reservations = 0;
  await assert.rejects(f.provider.embed(['text'], { kind: 'document', beforeRequest: () => { reservations++; throw stopped; } }), caught => caught.cause === stopped && caught.code==='budget_tokens'&&caught.dispatched === false && caught.inputTokens === undefined);
  assert.equal(Object.hasOwn(stopped,'dispatched'),false);
  assert.equal(reservations, 1); assert.equal(embeds(f).length, 0);
  const controller = new AbortController(); controller.abort(new Error('Owned cancellation'));
  await assert.rejects(f.provider.embed(['text'], { kind: 'query', signal: controller.signal }), caught => caught.dispatched === false); assert.equal(embeds(f).length, 0);
});

test('observed identity changes during inspection or after inference reject vectors while retaining known usage', async () => {
  let tags = 0;
  const early = fixture({ handler: (entry, state) => { if (entry.path === '/api/tags' && ++tags === 2) state.digest = D2; } });
  await assert.rejects(early.provider.embed(['text'], { kind: 'query' }), caught => caught.code === 'embedding_identity_changed' && caught.dispatched === false); assert.equal(embeds(early).length, 0);
  const late = fixture({ handler: (entry, state) => { if (entry.path === '/api/embed') state.digest = D2; } });
  await assert.rejects(late.provider.embed(['text'], { kind: 'query' }), caught => caught.code === 'embedding_identity_changed' && caught.dispatched === true && caught.inputTokens === 17 && caught.usage.actual === true);
  assert.equal(embeds(late).length, 1);
});

test('invalid vector counts/dimensions/nonfinite/zero norms are rejected with actual consumed tokens', async () => {
  for (const embeddings of [[], [[0, 0]], [[]], [[1], [1]], [[1, '2']], [[1, null]], [new Array(4097).fill(1)]]) {
    const f = fixture({ state: { response: { embeddings } } });
    await assert.rejects(f.provider.embed(['text'], { kind: 'document' }), caught => caught.code === 'embedding_invalid_vectors' && caught.dispatched === true && caught.inputTokens === 17);
  }
  const varying = fixture({ state: { response: { embeddings: [[1, 0], [1, 0, 0]] } } }); await assert.rejects(varying.provider.embed(['a','b'], { kind: 'document' }), { code: 'embedding_invalid_vectors' });
  const infinity = fixture({ handler: entry => entry.path === '/api/embed' ? new Response(`{"model":"${MODEL}","embeddings":[[1e309,1]],"prompt_eval_count":3}`) : undefined });
  await assert.rejects(infinity.provider.embed(['a'], { kind: 'query' }), caught => caught.inputTokens === 3 && caught.code === 'embedding_invalid_vectors');
});

test('missing usage remains uncertain and same-identity dimension changes cannot mix index spaces', async () => {
  const missing = fixture({ state: { response: { prompt_eval_count: undefined } } });
  await assert.rejects(missing.provider.embed(['text'], { kind: 'query' }), caught => caught.code === 'embedding_usage_unavailable' && caught.dispatched === true && caught.usageUncertain === true && caught.inputTokens === undefined);
  const f = fixture(); await f.provider.embed(['one'], { kind: 'document' }); f.state.response = { embeddings: [[1, 0, 0]] };
  await assert.rejects(f.provider.embed(['two'], { kind: 'document' }), caught => caught.code === 'embedding_dimensions_changed' && caught.inputTokens === 17);
});

test('normalization handles extreme finite magnitudes without overflow or zero underflow', async () => {
  const f = fixture({ state: { response: { embeddings: [[1e308, 1e308], [Number.MIN_VALUE, 0]] } } });
  const result = await f.provider.embed(['large','tiny'], { kind: 'document' });
  for (const vector of result.vectors) assert.ok([...vector].every(Number.isFinite) && Math.abs(Math.hypot(...vector) - 1) < 1e-6);
  assert.deepEqual([...result.vectors[1]], [1,0]);
});

test('JSON response limits, redirects, split transport and cancellation fail closed without retries', async () => {
  const header = fixture({ handler: entry => entry.path === '/api/embed' ? new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }) : undefined });
  await assert.rejects(header.provider.embed(['a'], { kind: 'query' }), { code: 'embedding_response_limit' }); assert.equal(embeds(header).length, 1);
  let cancelled = false;
  const streamed = fixture({ handler: entry => entry.path === '/api/embed' ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } })) : undefined });
  await assert.rejects(streamed.provider.embed(['a'], { kind: 'query' }), { code: 'embedding_response_limit' }); assert.equal(cancelled, true);
  const redirect = fixture({ handler: entry => entry.path === '/api/embed' ? new Response('', { status: 302, headers: { location: 'https://example.com' } }) : undefined }); await assert.rejects(redirect.provider.embed(['a'], { kind: 'query' }), { code: 'embedding_redirect' });
  const split = fixture({ handler: entry => {
    if (entry.path !== '/api/embed') return;
    const text = JSON.stringify({ model: MODEL, embeddings: [[1,2,3]], prompt_eval_count: 5 });
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < text.length; i += 3) controller.enqueue(new TextEncoder().encode(text.slice(i, i + 3))); controller.close(); } }));
  } }); assert.equal((await split.provider.embed(['split'], { kind: 'query' })).inputTokens, 5);
  let started = false; const pending = fixture({ handler: entry => { if (entry.path === '/api/embed') { started = true; return new Promise(() => {}); } } }), controller = new AbortController();
  const operation = pending.provider.embed(['cancel'], { kind: 'query', signal: controller.signal });
  for (let i = 0; i < 100 && !started; i++) await Promise.resolve(); assert.equal(started, true); controller.abort(new Error('Owned in-flight cancellation'));
  await assert.rejects(operation, caught => caught.dispatched === true && caught.usageUncertain === true); assert.equal(embeds(pending).length, 1);
});

test('shared cancellation reasons cannot relabel concurrent embedding dispatch receipts',async()=>{
  const controller=new AbortController();let shows=0,secondInspecting=false;
  const f=fixture({handler:entry=>{
    if(entry.path==='/api/show'&&++shows===2){secondInspecting=true;return new Promise(()=>{});}
    if(entry.path==='/api/embed')return new Promise(()=>{});
  }});
  const until=async predicate=>{const deadline=Date.now()+2000;while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('Embedding dispatch fixture timed out');};
  const first=f.provider.embed(['first'],{kind:'query',signal:controller.signal});await until(()=>embeds(f).length===1);
  const second=f.provider.embed(['second'],{kind:'query',signal:controller.signal});await until(()=>secondInspecting);
  const reason=new Error('Shared owned cancellation');controller.abort(reason);
  const results=await Promise.allSettled([first,second]);assert.ok(results.every(result=>result.status==='rejected'));
  assert.notEqual(results[0].reason,results[1].reason);assert.equal(results[0].reason.dispatched,true);assert.equal(results[1].reason.dispatched,false);
  assert.equal(results[0].reason.cause,reason);assert.equal(results[1].reason.cause,reason);assert.equal(Object.hasOwn(reason,'dispatched'),false);
});
