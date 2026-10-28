import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createLocalVisionProvider } from '../server/vision/local.js';
import { encodeRgbaPng } from '../server/transport/rgba.js';

const BASE = 'http://127.0.0.1:11434', MODEL = 'gemma3:latest', D1 = '1'.repeat(64), D2 = '2'.repeat(64);
const png = () => encodeRgbaPng(Buffer.from('owned synthetic pixels'), { width: 4 }).png;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Static valid baseline JPEG, shared in substance with image validator fixtures.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyOiiiuw5D/9k=', 'base64');
const answer = properties => ({ model: MODEL, done: true, done_reason: 'stop', message: { role: 'assistant', content: 'Observed image evidence; uncertain digits.' }, prompt_eval_count: 133, eval_count: 9, ...properties });
const chatCalls = f => f.calls.filter(call => call.path === '/api/chat');
function fixture(options = {}) {
  const calls = [], state = { digest: D1, capabilities: ['completion', 'vision'], ...options.state };
  const fetchImpl = async (url, request) => {
    assert.equal(new URL(url).origin, BASE); assert.equal(request.redirect, 'error');
    const entry = { path: new URL(url).pathname, method: request.method, body: request.body ? JSON.parse(request.body) : undefined, signal: request.signal };
    calls.push(entry);
    const intercepted = await options.handler?.(entry, state, calls);
    if (intercepted !== undefined) return intercepted;
    if (entry.path === '/api/tags') return Response.json({ models: [{ name: MODEL, model: MODEL, digest: state.digest, ...state.tagMetadata },
      { name: 'unrelated:cloud', digest: D2, remote_host: 'https://ollama.com' }], ...state.inventoryMetadata });
    if (entry.path === '/api/show') return Response.json({ capabilities: state.capabilities, ...state.showMetadata });
    assert.equal(entry.path, '/api/chat');
    return Response.json(answer(state.response));
  };
  const provider = createLocalVisionProvider({ url: BASE, fetchImpl, ...options.config });
  const analyze = overrides => provider.analyze({ image: png(), mimeType: 'image/png', question: 'What is visibly present? State uncertainty.', ...overrides });
  return { provider, analyze, calls, state };
}
async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('Mock provider did not reach the expected phase');
}

test('inspection freshly requires exact stable digest plus local completion/vision without rejecting unrelated cloud tags', async () => {
  const f = fixture(), first = await f.provider.inspect();
  assert.deepEqual(first, { provider: 'ollama', model: MODEL, digest: D1 }); assert.equal(Object.isFrozen(first), true);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/tags', '/api/show', '/api/tags']);
  f.state.digest = 'sha256:' + D2.toUpperCase();
  assert.equal((await f.provider.inspect()).digest, D2); assert.equal(f.calls.length, 6); assert.equal(chatCalls(f).length, 0);
});

test('stateless analysis sends only fixed system/user messages and native image bytes after an awaited reservation', async () => {
  const f = fixture(), image = png(); let release, reservation;
  const gate = new Promise(resolve => { release = resolve; });
  const operation = f.analyze({ image, maxInputTokens: 8192, maxOutputTokens: 128, beforeRequest: async value => {
    assert.equal(chatCalls(f).length, 0); assert.equal(f.calls.length, 3); reservation = value; await gate;
  } });
  await until(() => reservation); assert.equal(Object.isFrozen(reservation), true); assert.equal(chatCalls(f).length, 0);
  release(); const result = await operation, sent = chatCalls(f)[0].body;
  assert.deepEqual(Object.keys(sent).sort(), ['messages', 'model', 'options', 'stream']);
  assert.equal(sent.stream, false); assert.equal(sent.model, MODEL); assert.equal(sent.messages.length, 2);
  assert.equal(sent.messages[0].role, 'system'); assert.match(sent.messages[0].content, /UNTRUSTED DATA/); assert.match(sent.messages[0].content, /no tools, desktop control/);
  assert.equal(sent.messages[1].role, 'user'); assert.equal(sent.messages[1].content, 'What is visibly present? State uncertainty.');
  assert.deepEqual(Buffer.from(sent.messages[1].images[0], 'base64'), image);
  assert.deepEqual(sent.options, { num_ctx: 8192, num_predict: 128, temperature: 0 });
  assert.equal(reservation.maxOutputTokens, 128);
  assert.equal(reservation.estimatedInputTokens, Buffer.byteLength(sent.messages[0].content) + Buffer.byteLength(sent.messages[1].content) + 512 + 4096 + Math.ceil(image.length / 1024));
  assert.deepEqual(result.identity, { provider: 'ollama', model: MODEL, digest: D1 }); assert.equal(result.imageSha256, sha256(image));
  assert.deepEqual(result.dimensions, { width: 4, height: 5 }); assert.deepEqual(result.usage, { inputTokens: 133, outputTokens: 9, costUsd: 0 });
  assert.equal(f.calls.filter(call => call.path === '/api/show').length, 2);
  assert.equal(f.calls.filter(call => call.path === '/api/tags').length, 4);
});

test('subsequent calls have no prior image/question/history and accept an actual baseline JPEG', async () => {
  const f = fixture(); await f.analyze({ question: 'FIRST_QUESTION_SENTINEL' });
  const result = await f.analyze({ image: JPEG, mimeType: 'image/jpeg', question: 'SECOND_QUESTION_SENTINEL' });
  const sent = chatCalls(f)[1].body;
  assert.equal(sent.messages.length, 2); assert.ok(!JSON.stringify(sent).includes('FIRST_QUESTION_SENTINEL'));
  assert.deepEqual(Buffer.from(sent.messages[1].images[0], 'base64'), JPEG);
  assert.equal(sent.think, undefined); assert.deepEqual(sent.options, { num_ctx: 16384, num_predict: 256, temperature: 0 });
  assert.deepEqual(result.dimensions, { width: 1, height: 1 }); assert.equal(result.imageSha256, sha256(JPEG));
});

test('the caller cannot mutate validated image bytes while asynchronous metadata/reservation is pending', async () => {
  const f = fixture(), image = png(), expected = sha256(image);
  const result = await f.analyze({ image, beforeRequest: () => { image.fill(0); } });
  assert.equal(result.imageSha256, expected); assert.equal(sha256(Buffer.from(chatCalls(f)[0].body.messages[1].images[0], 'base64')), expected);
});

test('configuration and input validation reject remote locations, cloud names, invalid images/questions/limits and extra authority before I/O', async () => {
  for (const url of ['https://example.com', 'http://localhost:11434/api', 'http://user:password@localhost:11434', 'http://localhost:11434?x=1'])
    assert.throws(() => createLocalVisionProvider({ url }));
  for (const model of ['gemma3:cloud', 'cloud/gemma3', 'gemma3-cloud:latest']) assert.throws(() => createLocalVisionProvider({ model }), { code: 'local_cloud_blocked' });
  const f = fixture();
  for (const override of [{ image: new Uint8Array(png()) }, { image: Buffer.alloc(0) }, { image: Buffer.alloc(4 * 1024 * 1024 + 1) },
    { image: Buffer.from('not PNG') }, { mimeType: 'image/jpeg' }, { mimeType: 'image/svg+xml' },
    { question: '' }, { question: ' ' }, { question: '\ud800' }, { question: 'bad\0question' }, { question: 'x'.repeat(1025) },
    { maxInputTokens: 0 }, { maxInputTokens: 131073 }, { maxOutputTokens: 0 }, { maxOutputTokens: 1025 }, { maxOutputTokens: 2.5 },
    { beforeRequest: true }, { signal: {} }, { tools: [] }, { messages: [] }, { desktopSessionId: 'authority' }, { model: 'other' }]) {
    await assert.rejects(f.analyze(override), caught => ['vision_arguments', 'vision_image_invalid'].includes(caught.code) && caught.dispatched === false && caught.usageUncertain === false);
    assert.equal(f.calls.length, 0);
  }
  await assert.rejects(f.analyze({ maxInputTokens: 4096 }), caught => caught.code === 'vision_input_limit' && caught.dispatched === false);
  assert.equal(f.calls.length, 0);
});

test('remote aliases are blocked independently in inventory, show and chat, with known chat usage retained', async () => {
  for (const state of [{ inventoryMetadata: { remote_host: 'https://ollama.com' } }, { tagMetadata: { remote_model: 'remote' } },
    { showMetadata: { metadata: { remote_host: 'https://ollama.com' } } }]) {
    const f = fixture({ state });
    await assert.rejects(f.analyze(), caught => caught.code === 'local_cloud_blocked' && caught.dispatched === false);
    assert.equal(chatCalls(f).length, 0);
  }
  const f = fixture({ state: { response: { remote_model: 'remote' } } });
  await assert.rejects(f.analyze(), caught => caught.code === 'local_cloud_blocked' && caught.dispatched === true
    && caught.usage.inputTokens === 133 && caught.usage.outputTokens === 9 && caught.usageUncertain === false);
  assert.equal(chatCalls(f).length, 1);
});

test('missing/ambiguous exact tags, inconsistent tag names and missing capabilities cannot dispatch analysis', async () => {
  for (const state of [{ digest: '' }, { digest: 'short' }, { capabilities: [] }, { capabilities: ['completion'] }, { capabilities: ['vision'] }, { capabilities: undefined },
    { tagMetadata: { model: 'different-tag:latest' } }]) {
    const f = fixture({ state }); await assert.rejects(f.analyze(), caught => caught.dispatched === false); assert.equal(chatCalls(f).length, 0);
  }
  for (const models of [[], [{ name: MODEL, digest: D1 }, { name: MODEL, digest: D1 }]]) {
    const f = fixture({ handler: entry => entry.path === '/api/tags' ? Response.json({ models }) : undefined });
    await assert.rejects(f.analyze(), { code: 'vision_model_unavailable', dispatched: false }); assert.equal(chatCalls(f).length, 0);
  }
});

test('digest changes before dispatch or after inference never produce a successful answer', async () => {
  let tags = 0;
  const early = fixture({ handler: (entry, state) => { if (entry.path === '/api/tags' && ++tags === 2) state.digest = D2; } });
  await assert.rejects(early.analyze(), { code: 'vision_identity_changed', dispatched: false }); assert.equal(chatCalls(early).length, 0);
  const late = fixture({ handler: (entry, state) => { if (entry.path === '/api/chat') state.digest = D2; } });
  await assert.rejects(late.analyze(), caught => caught.code === 'vision_identity_changed' && caught.dispatched === true
    && caught.usage.inputTokens === 133 && caught.usage.outputTokens === 9 && caught.usageUncertain === false);
  assert.equal(chatCalls(late).length, 1);
});

test('reservation errors and cancellation before dispatch send no image and are not uncertain usage', async () => {
  const f = fixture(), failure = Object.assign(new Error('Budget exhausted'), { code: 'budget_tokens' });
  await assert.rejects(f.analyze({ beforeRequest: () => { throw failure; } }), caught => caught.cause === failure && caught.code === 'budget_tokens' && caught.dispatched === false && caught.usageUncertain === false && caught.usage === undefined);
  assert.equal(chatCalls(f).length, 0);
  const controller = new AbortController(); controller.abort(new Error('Owned cancellation'));
  const g = fixture(); await assert.rejects(g.analyze({ signal: controller.signal }), { dispatched: false, usageUncertain: false }); assert.equal(g.calls.length, 0);
  const reserved = new AbortController();
  await assert.rejects(g.analyze({ signal: reserved.signal, beforeRequest: () => reserved.abort(new Error('Cancelled reservation')) }), { dispatched: false, usageUncertain: false });
  assert.equal(chatCalls(g).length, 0);
});

test('incomplete, malformed, wrong-model, tool-call and oversized answers preserve all known actual counts', async () => {
  for (const [response, expectedCode] of [
    [{ done: false }, 'vision_incomplete'], [{ done_reason: 'length' }, 'vision_incomplete'], [{ done_reason: undefined }, 'vision_incomplete'],
    [{ error: 'private provider detail' }, 'vision_provider_error'], [{ model: 'other-tag' }, 'vision_model_mismatch'],
    [{ message: { role: 'user', content: 'wrong role' } }, 'vision_invalid_response'],
    [{ message: { role: 'assistant', content: ' ' } }, 'vision_invalid_response'],
    [{ message: { role: 'assistant', content: '\ud800' } }, 'vision_invalid_response'],
    [{ message: { role: 'assistant', content: 'bad\0text' } }, 'vision_invalid_response'],
    [{ message: { role: 'assistant', content: 'answer', tool_calls: [{ function: { name: 'doNotExecute' } }] } }, 'vision_invalid_response'],
    [{ message: { role: 'assistant', content: 'x'.repeat(32769) } }, 'vision_output_limit'],
    [{ eval_count: 257 }, 'vision_output_limit'],
  ]) {
    const f = fixture({ state: { response } });
    await assert.rejects(f.analyze(), caught => caught.code === expectedCode && caught.dispatched === true && caught.usageUncertain === false
      && caught.usage.inputTokens === 133 && caught.usage.outputTokens === (response.eval_count ?? 9));
    assert.equal(chatCalls(f).length, 1);
  }
});

test('partial or absent usage is never invented; independently known counts remain available on the error', async () => {
  for (const [response, expectedUsage] of [
    [{ prompt_eval_count: undefined }, { outputTokens: 9, costUsd: 0 }],
    [{ eval_count: -1 }, { inputTokens: 133, costUsd: 0 }],
    [{ prompt_eval_count: '133', eval_count: null }, undefined],
  ]) {
    const f = fixture({ state: { response } });
    await assert.rejects(f.analyze(), caught => { assert.equal(caught.code, 'vision_usage_unavailable'); assert.equal(caught.dispatched, true);
      assert.equal(caught.usageUncertain, true); assert.deepEqual(caught.usage, expectedUsage); return true; });
  }
});

test('partial known overages are preserved unclamped so callers can charge them and hold only unknown usage', async () => {
  for (const [response, expectedUsage] of [
    [{ prompt_eval_count: 1_000_000, eval_count: undefined }, { inputTokens: 1_000_000, costUsd: 0 }],
    [{ prompt_eval_count: undefined, eval_count: 5000 }, { outputTokens: 5000, costUsd: 0 }],
  ]) {
    const f = fixture({ state: { response } });
    await assert.rejects(f.analyze(), caught => {
      assert.equal(caught.code, response.prompt_eval_count > 16384 ? 'vision_input_limit' : 'vision_usage_unavailable'); assert.equal(caught.dispatched, true); assert.equal(caught.usageUncertain, true);
      assert.deepEqual(caught.usage, expectedUsage); assert.equal(Object.isFrozen(caught.usage), true); return true;
    });
    assert.equal(chatCalls(f).length, 1);
  }
});

test('actual input overage rejects complete or partial answers while preserving known counts unclamped', async () => {
  for (const output of [9, undefined]) {
    const f = fixture({ state: { response: { prompt_eval_count: 9000, eval_count: output } } });
    await assert.rejects(f.analyze({ maxInputTokens: 8192 }), caught => {
      assert.equal(caught.code, 'vision_input_limit'); assert.equal(caught.dispatched, true);
      assert.equal(caught.usage.inputTokens, 9000); assert.equal(caught.usage.outputTokens, output);
      assert.equal(caught.usageUncertain, output === undefined); return true;
    });
    assert.equal(chatCalls(f).length, 1); assert.equal(f.calls.length, 4);
  }
});

test('concurrent stateless calls keep images, questions, reservations and returned usage isolated', async () => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ handler: entry => {
    if (entry.path !== '/api/chat') return;
    const question = entry.body.messages[1].content;
    return Response.json(answer({ message: { role: 'assistant', content: question }, prompt_eval_count: question.length }));
  } });
  const image = png(), first = f.analyze({ image, question: 'FIRST_PENDING_QUESTION', beforeRequest: async () => { entered = true; await gate; } });
  await until(() => entered);
  const second = await f.analyze({ image: JPEG, mimeType: 'image/jpeg', question: 'SECOND_FINISHED_QUESTION' });
  assert.equal(second.text, 'SECOND_FINISHED_QUESTION'); assert.equal(second.imageSha256, sha256(JPEG));
  assert.equal(second.usage.inputTokens, second.text.length); assert.equal(chatCalls(f).length, 1);
  release(); const result = await first;
  assert.equal(result.text, 'FIRST_PENDING_QUESTION'); assert.equal(result.imageSha256, sha256(image));
  assert.equal(result.usage.inputTokens, result.text.length); assert.equal(chatCalls(f).length, 2);
  for (const call of chatCalls(f)) assert.equal(call.body.messages.length, 2);
});

test('non-2xx JSON preserves known usage but exposes only sanitized provider error/status', async () => {
  const f = fixture({ handler: entry => entry.path === '/api/chat' ? Response.json(answer({ error: 'SECRET_PROVIDER_DETAIL' }), { status: 503 }) : undefined });
  await assert.rejects(f.analyze(), caught => caught.code === 'vision_http' && caught.status === 503 && caught.dispatched === true
    && caught.usage.inputTokens === 133 && caught.usage.outputTokens === 9 && !caught.message.includes('SECRET_PROVIDER_DETAIL'));
});

test('split UTF-8 transport and private reasoning are handled without returning or persisting reasoning/images', async () => {
  const f = fixture({ handler: entry => {
    if (entry.path !== '/api/chat') return;
    const bytes = Buffer.from(JSON.stringify(answer({ message: { role: 'assistant', content: 'Visible evidence: 漢字 φ.', thinking: 'PRIVATE_REASONING_SENTINEL'.repeat(3000) } })));
    const split = bytes.indexOf(Buffer.from('漢')) + 1;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      for (let i = split; i < bytes.length; i += 4093) controller.enqueue(bytes.subarray(i, i + 4093));
      controller.close();
    } }));
  } });
  const result = await f.analyze();
  assert.equal(result.text, 'Visible evidence: 漢字 φ.'); assert.deepEqual(Object.keys(result).sort(), ['dimensions', 'identity', 'imageSha256', 'text', 'usage']);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REASONING_SENTINEL')); assert.ok(!JSON.stringify(result).includes(png().toString('base64')));
});

test('response limits cancel oversized streams and reject invalid UTF-8/JSON without retry or phantom usage', async () => {
  const header = fixture({ handler: entry => entry.path === '/api/chat' ? new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }) : undefined });
  await assert.rejects(header.analyze(), { code: 'vision_response_limit', dispatched: true, usageUncertain: true });
  let cancelled = false;
  const oversized = fixture({ handler: entry => entry.path === '/api/chat' ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } })) : undefined });
  await assert.rejects(oversized.analyze(), { code: 'vision_response_limit', dispatched: true, usageUncertain: true }); assert.equal(cancelled, true);
  for (const bytes of [Buffer.from('{bad JSON'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]), Buffer.from('[]')]) {
    const f = fixture({ handler: entry => entry.path === '/api/chat' ? new Response(bytes) : undefined });
    await assert.rejects(f.analyze(), { code: 'vision_invalid_response', dispatched: true, usageUncertain: true }); assert.equal(chatCalls(f).length, 1);
  }
  assert.equal(chatCalls(header).length, 1); assert.equal(chatCalls(oversized).length, 1);
});

test('redirects and network errors fail closed independently of browser state and have no fallback', async () => {
  for (const handler of [
    () => new Response('', { status: 302, headers: { location: 'https://example.com' } }),
    () => { const response = Response.json(answer()); Object.defineProperty(response, 'redirected', { value: true }); return response; },
    () => { const response = Response.json(answer()); Object.defineProperty(response, 'url', { value: 'https://example.com' }); return response; },
  ]) {
    const f = fixture({ handler: entry => entry.path === '/api/chat' ? handler() : undefined });
    await assert.rejects(f.analyze(), { code: 'vision_redirect', dispatched: true, usageUncertain: true }); assert.equal(chatCalls(f).length, 1);
  }
  const f = fixture({ handler: entry => { if (entry.path === '/api/chat') throw new Error('SECRET_NETWORK_DETAIL'); } });
  await assert.rejects(f.analyze(), caught => caught.code === 'vision_unavailable' && caught.dispatched === true && caught.usageUncertain === true && !caught.message.includes('SECRET_NETWORK_DETAIL'));
  assert.equal(chatCalls(f).length, 1);
});

test('in-flight cancellation/timeout and stalled streams remain uncertain, cancel reading and never report success', async () => {
  for (const reason of [new Error('Owned cancellation'), new DOMException('Owned deadline', 'TimeoutError')]) {
    let started = false; const controller = new AbortController();
    const f = fixture({ handler: entry => { if (entry.path === '/api/chat') { started = true; return new Promise(() => {}); } } });
    const operation = f.analyze({ signal: controller.signal }); await until(() => started); controller.abort(reason);
    await assert.rejects(operation, caught => caught.cause === reason && caught.dispatched === true && caught.usageUncertain === true && caught.usage === undefined);
    assert.equal(chatCalls(f).length, 1);
  }
  let started = false, cancelled = false; const controller = new AbortController();
  const f = fixture({ handler: entry => entry.path === '/api/chat' ? new Response(new ReadableStream({ start(stream) { started = true; stream.enqueue(Buffer.from('{"model":')); }, cancel() { cancelled = true; } })) : undefined });
  const operation = f.analyze({ signal: controller.signal }); await until(() => started); controller.abort(new Error('Stop stream'));
  await assert.rejects(operation, { dispatched: true, usageUncertain: true }); assert.equal(cancelled, true);
});

test('a shared cancellation reason cannot relabel concurrent preflight and dispatched errors', async () => {
  const controller = new AbortController(); let shows = 0, secondInspecting = false;
  const f = fixture({ handler: entry => {
    if (entry.path === '/api/show' && ++shows === 2) { secondInspecting = true; return new Promise(() => {}); }
    if (entry.path === '/api/chat') return new Promise(() => {});
  } });
  const first = f.analyze({ signal: controller.signal }); await until(() => chatCalls(f).length === 1);
  const second = f.analyze({ signal: controller.signal }); await until(() => secondInspecting);
  const reason = Object.freeze(new Error('Shared owned cancellation')); controller.abort(reason);
  const outcomes = await Promise.allSettled([first, second]);
  assert.ok(outcomes.every(value => value.status === 'rejected'));
  assert.notEqual(outcomes[0].reason, outcomes[1].reason);
  assert.equal(outcomes[0].reason.dispatched, true); assert.equal(outcomes[0].reason.usageUncertain, true);
  assert.equal(outcomes[1].reason.dispatched, false); assert.equal(outcomes[1].reason.usageUncertain, false);
  assert.equal(outcomes[0].reason.cause, reason); assert.equal(outcomes[1].reason.cause, reason);
  assert.equal(Object.hasOwn(reason, 'dispatched'), false); assert.equal(chatCalls(f).length, 1);
});

test('cancellation during post-inference identity inspection retains known usage and rejects the answer', async () => {
  const controller = new AbortController(); let returnedAnswer = false;
  const f = fixture({ handler: entry => {
    if (entry.path === '/api/chat') returnedAnswer = true;
    if (returnedAnswer && entry.path === '/api/tags') controller.abort(new Error('Cancelled after inference'));
  } });
  await assert.rejects(f.analyze({ signal: controller.signal }), caught => caught.dispatched === true && caught.usageUncertain === false
    && caught.usage.inputTokens === 133 && caught.usage.outputTokens === 9);
  assert.equal(chatCalls(f).length, 1);
});
