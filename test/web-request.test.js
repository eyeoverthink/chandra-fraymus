import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { requestPublicPage, publicUrl, isPublicAddress } from '../server/web/request.js';
const lookupImpl = async () => [{ address: '8.8.8.8', family: 4 }];
function transport({ body = 'bounded text φ', status = 200, headers = {}, complete = true, inspect } = {}) {
  let calls = 0, request, response;
  return { get calls() { return calls; }, get request() { return request; }, get response() { return response; },
    getImpl(url, options, callback) {
      calls++; inspect?.(url, options);
      request = new EventEmitter(); request.destroy = () => { request.destroyed = true; };
      queueMicrotask(() => {
        response = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]);
        response.statusCode = status; response.headers = { 'content-type': 'text/plain; charset=utf-8', ...headers }; response.complete = complete;
        callback(response);
      });
      return request;
    } };
}

test('web request pins the checked DNS address and returns exact bytes/hash without ambient credentials', async () => {
  let checked = false;
  const t = transport({ inspect: (url, options) => {
    assert.equal(url.href, 'https://example.com/page'); assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.autoSelectFamily, false); assert.equal(options.headers['Accept-Encoding'], 'identity');
    assert.ok(!('Cookie' in options.headers)); assert.ok(!('Authorization' in options.headers));
    options.lookup('example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); checked = true; });
  } });
  const result = await requestPublicPage('https://example.com/page#section', { lookupImpl, getImpl: t.getImpl });
  assert.equal(result.text, 'bounded text φ'); assert.equal(result.bytes, Buffer.byteLength(result.text)); assert.equal(result.untrusted, true);
  assert.equal(result.rawSha256, createHash('sha256').update(result.text).digest('hex')); assert.equal(checked, true);
  assert.equal(t.request.destroyed, true); assert.equal(t.calls, 1);
});

test('web public policy rejects private literals, mixed DNS, credentials and nondefault ports before dialing', async () => {
  const t = transport();
  for (const url of ['http://127.1/', 'http://0x7f000001/', 'http://2130706433/', 'https://[::1]/', 'http://169.254.169.254/', 'file:///secret', 'https://user:secret@example.com/', 'https://example.com:80/']) {
    await assert.rejects(requestPublicPage(url, { lookupImpl, getImpl: t.getImpl }));
  }
  await assert.rejects(requestPublicPage('https://example.com/', { lookupImpl: async () => [...await lookupImpl(), { address: '10.0.0.1', family: 4 }], getImpl: t.getImpl }), /blocked/);
  assert.equal(t.calls, 0); assert.equal(isPublicAddress('192.88.99.1'), false);
  assert.throws(() => publicUrl('https://example.com/\npath'), /ordinary/);
});

test('web redirects are reported without following and private/missing locations expose no followable target', async () => {
  const t = transport({ status: 302, headers: { location: '/next#part' } });
  const result = await requestPublicPage('https://example.com/start', { lookupImpl, getImpl: t.getImpl });
  assert.equal(result.followed, false); assert.equal(result.redirect, 'https://example.com/next'); assert.equal(t.calls, 1);
  for (const headers of [{ location: 'http://127.0.0.1/secret' }, {}]) {
    const blocked = await requestPublicPage('https://example.com/', { lookupImpl, getImpl: transport({ status: 301, headers }).getImpl });
    assert.equal(blocked.redirectBlocked, true); assert.equal(blocked.redirect, undefined);
  }
});

test('web transfer bounds reject oversized, compressed, malformed and truncated responses', async () => {
  for (const options of [
    { headers: { 'content-length': 1048577 } }, { body: Buffer.alloc(1048577) },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-type': 'application/pdf' } },
    { headers: { 'content-length': '999' } }, { complete: false },
    { body: Buffer.from([255]), headers: { 'content-type': 'text/plain;charset=utf-8' } },
  ]) await assert.rejects(requestPublicPage('https://example.com/', { lookupImpl, getImpl: transport(options).getImpl }));
  const latin = await requestPublicPage('https://example.com/', { lookupImpl, getImpl: transport({ body: Buffer.from([0xe9]), headers: { 'content-type': 'text/plain;charset=windows-1252' } }).getImpl });
  assert.equal(latin.text, 'é');
});

test('HTTP rate-limit errors retain bounded retry metadata without retrying a request', async () => {
  const t = transport({ status: 429, headers: { 'retry-after': '999999' } });
  await assert.rejects(requestPublicPage('https://example.com/', { lookupImpl, getImpl: t.getImpl }), error => {
    assert.equal(error.httpStatus, 429); assert.equal(error.retryAfterSeconds, 86400); return true;
  });
  assert.equal(t.calls, 1); assert.equal(t.request.destroyed, true);
  const dated = transport({ status: 429, headers: { 'retry-after': new Date(Date.now() + 120000).toUTCString() } });
  await assert.rejects(requestPublicPage('https://example.com/', { lookupImpl, getImpl: dated.getImpl }), error => {
    assert.ok(error.retryAfterSeconds >= 118 && error.retryAfterSeconds <= 120); return true;
  });
  assert.equal(dated.calls, 1);
});

test('DNS and in-flight web requests honor cancellation, and concurrency slots are recovered', async () => {
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map(controller => requestPublicPage('https://example.com/', { signal: controller.signal, lookupImpl: () => new Promise(() => {}) }));
  await assert.rejects(requestPublicPage('https://example.com/'), /busy/);
  controllers.forEach(controller => controller.abort(new Error('cancelled DNS')));
  const cancelled = await Promise.allSettled(requests);
  assert.ok(cancelled.every(result => result.status === 'rejected' && /cancelled DNS/.test(result.reason.message)));
  const controller = new AbortController();
  const t = transport({ inspect: () => queueMicrotask(() => controller.abort(new Error('cancelled HTTP'))) });
  await assert.rejects(requestPublicPage('https://example.com/', { lookupImpl, getImpl: t.getImpl, signal: controller.signal }), /cancelled HTTP/);
  assert.equal(t.request.destroyed, true);
  assert.equal((await requestPublicPage('https://example.com/', { lookupImpl, getImpl: transport().getImpl })).status, 200);
});
