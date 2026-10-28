import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { createPdfRenderer } from '../server/ocr/pdf.js';
import { PDF_RENDER_LIMITS as LIMITS, PDF_RENDERER_IDENTITY, validatePdfInput, validatePdfRenderRequest,
  pdfPageGeometry, createPdfRenderPolicy, assertStaticPdfDocument, assertStaticPdfPage } from '../server/ocr/limits.mjs';

// Process-seam framing only: these are not authored/parsed PDF fixtures.
const source = Buffer.from('%PDF-owned-input-sentinel');
const sha = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a7cAAAAASUVORK5CYII=', 'base64');
const result = () => ({ ok: true, sourceSha256: sha(source), sourceBytes: source.length, page: 1, pageCount: 2,
  image: { mimeType: 'image/png', sha256: sha(png), bytes: png.length, width: 1, height: 1, pixels: 1, dpi: 150, requestedDpi: 150, downscaled: false, dataBase64: png.toString('base64') },
  renderer: { ...PDF_RENDERER_IDENTITY, peakCanvasPixels: 1, externalRequests: 0 }, warnings: ['Static page pixels only.'] });

function harness(options = {}) {
  const calls = [], timers = new Set();
  const renderer = createPdfRenderer({ platform: 'win32', now: () => 100,
    setTimeoutImpl: (callback, ms) => { const timer = { callback, ms }; timers.add(timer); return timer; },
    clearTimeoutImpl: timer => timers.delete(timer),
    spawnImpl: (file, args, spawnOptions) => {
      const child = new EventEmitter(); child.pid = 100 + calls.length;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0;
      child.kill = () => { child.kills++; return true; };
      child.finish = (value = result(), code = 0) => { if (value !== null) child.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); child.emit('close', code); };
      calls.push({ file, args, options: spawnOptions, child }); return child;
    }, ...options });
  return { renderer, calls, timers, fire: ms => {
    for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.callback(); }
  } };
}

test('PDF byte/page framing rejects oversized, malformed, implicit, URL and option overrides before launch', async () => {
  const h = harness();
  for (const page of [0, -1, 301, 1.5, '1', undefined]) await assert.rejects(h.renderer.renderPdfPage(source, page), { code: 'pdf_render_input' });
  await assert.rejects(h.renderer.renderPdfPage(Buffer.alloc(LIMITS.maxBytes + 1), 1), { code: 'pdf_render_input' });
  await assert.rejects(h.renderer.renderPdfPage(Buffer.from('not PDF'), 1), { code: 'pdf_render_input' });
  assert.equal(h.calls.length, 0);
  const request = { version: 1, dataBase64: source.toString('base64'), page: 1 };
  assert.deepEqual(validatePdfRenderRequest(request), { data: source, page: 1 });
  for (const extra of [{ url: 'https://example.invalid/' }, { path: 'private.pdf' }, { enableXfa: true }, { isEvalSupported: true }, { dataBase64: request.dataBase64 + '\n' }]) assert.throws(() => validatePdfRenderRequest({ ...request, ...extra }));
  assert.throws(() => validatePdfInput(new Uint8Array(), 1));
});

test('normal fixed wrapper response binds source/page/pixels/renderer identity and confirms only trusted normal cleanup', async () => {
  const h = harness(), bytes = Buffer.from(source), pending = h.renderer.renderPdfPage(bytes, 1);
  bytes.fill(0); h.calls[0].child.finish();
  const value = await pending;
  assert.equal(value.sourceSha256, sha(source)); assert.deepEqual(value.png, png);
  assert.equal(value.renderer.identityHash, PDF_RENDERER_IDENTITY.identityHash);
  assert.equal(Object.hasOwn(value.image, 'dataBase64'), false);
  assert.equal(value.resourceBoundary.memoryBytes, 384 * 1024 * 1024);
  assert.deepEqual(value.resourceBoundary.cleanup, { confirmed: true, forced: false, launcherExited: true, directNodeExitConfirmed: true,
    evidence: 'trusted-wrapper-normal-exit-and-direct-child-wait', launcherExitCode: 0 });
  assert.deepEqual(h.renderer.state(), { active: 0, quarantined: false });
  const call = h.calls[0], sent = JSON.parse(call.child.stdin.read().toString());
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.match(call.args[0], /documents[\\/]bounded-process\.py$/); assert.match(call.args[2], /ocr[\\/]pdf-child\.mjs$/);
  assert.equal(call.args[3], String(384 * 1024 * 1024));
  assert.deepEqual(sent, { version: 1, dataBase64: source.toString('base64'), page: 1 });
  assert.ok(Object.keys(call.options.env).every(key => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG'].includes(key)));
  assert.equal(h.timers.size, 0);
});

test('bad source/page/PNG/options receipts fail closed after confirmed normal process exit without a hidden retry', async () => {
  for (const alter of [
    value => { value.sourceSha256 = 'a'.repeat(64); }, value => { value.page = 2; }, value => { value.pageCount = 301; },
    value => { value.image.width = 2601; }, value => { value.image.pixels = 2; }, value => { value.image.dpi = 151; },
    value => { value.image.dataBase64 += '\n'; }, value => { value.image.sha256 = 'b'.repeat(64); },
    value => { value.renderer.identityHash = 'c'.repeat(64); }, value => { value.renderer.xfa = true; },
    value => { value.renderer.externalRequests = 1; }, value => { value.warnings = ['x'.repeat(301)]; }
  ]) {
    const h = harness(), pending = h.renderer.renderPdfPage(source, 1), reply = result(); alter(reply); h.calls[0].child.finish(reply);
    await assert.rejects(pending, error => error.code === 'pdf_render_receipt' && error.render.resourceBoundary.cleanup.confirmed === true);
    assert.equal(h.calls.length, 1); assert.equal(h.renderer.state().quarantined, false);
  }
});

test('child rejection/invalid JSON with normal wrapper exit proves cleanup, never image success', async () => {
  for (const reply of [{ ok: false, error: 'Selected page is outside this PDF.' }, 'not JSON']) {
    const h = harness(), pending = h.renderer.renderPdfPage(source, 1); h.calls[0].child.finish(reply);
    await assert.rejects(pending, error => error.render.resourceBoundary.cleanup.confirmed === true);
    assert.equal(h.renderer.state().quarantined, false); assert.equal(h.calls.length, 1);
  }
});

test('concurrency2 rejects excess calls without queuing, launching or copying another source into execution', async () => {
  const h = harness(), first = h.renderer.renderPdfPage(source, 1), second = h.renderer.renderPdfPage(source, 1);
  await assert.rejects(h.renderer.renderPdfPage(source, 1), { code: 'pdf_render_busy', status: 429 });
  assert.equal(h.calls.length, 2); assert.equal(h.renderer.state().active, 2);
  h.calls[0].child.finish(); h.calls[1].child.finish(); await Promise.all([first, second]);
  assert.equal(h.renderer.state().active, 0);
});

test('pre-aborted and unsupported-platform requests never launch and never select a fallback', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(new Error('Operator cancelled'));
  await assert.rejects(h.renderer.renderPdfPage(source, 1, { signal: controller.signal }), /Operator cancelled/);
  const other = harness({ platform: 'linux' });
  await assert.rejects(other.renderer.renderPdfPage(source, 1), { code: 'pdf_render_platform' });
  assert.equal(h.calls.length + other.calls.length, 0);
  assert.equal(h.renderer.state().quarantined, false);
});

test('cancellation waits for exact wrapper closure but never calls forced termination confirmed Node cleanup', async () => {
  const h = harness(), controller = new AbortController(), pending = h.renderer.renderPdfPage(source, 1, { signal: controller.signal });
  let settled = false; pending.catch(() => { settled = true; });
  controller.abort(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(h.calls[0].child.kills, 1); assert.equal(h.renderer.state().quarantined, true);
  h.calls[0].child.finish(null, 1);
  await assert.rejects(pending, error => error.code === 'pdf_render_cancelled'
    && error.render.resourceBoundary.cleanup.confirmed === false && error.render.resourceBoundary.cleanup.launcherExited === true
    && error.render.resourceBoundary.cleanup.directNodeExitConfirmed === false);
  await assert.rejects(h.renderer.renderPdfPage(source, 1), { code: 'pdf_render_quarantined' });
  assert.equal(h.calls.length, 1); assert.equal(h.renderer.state().active, 0); assert.equal(h.timers.size, 0);
});

test('15sdeadline plus2scleanupwait bounds an unresponsive wrapper and late close cannot clear quarantine', async () => {
  const h = harness(), pending = h.renderer.renderPdfPage(source, 1);
  h.fire(15000); assert.equal(h.calls[0].child.kills, 1);
  h.fire(2000);
  await assert.rejects(pending, error => error.code === 'pdf_render_timeout'
    && error.render.resourceBoundary.cleanup.confirmed === false && error.render.resourceBoundary.cleanup.launcherExited === false);
  assert.deepEqual(h.renderer.state(), { active: 0, quarantined: true });
  h.calls[0].child.finish();
  await assert.rejects(h.renderer.renderPdfPage(source, 1), { code: 'pdf_render_quarantined' });
  assert.equal(h.calls.length, 1);
});

test('outputoverflow and abnormal wrapperexit both quarantine rather than infer childabsence or retry', async () => {
  const h = harness(), pending = h.renderer.renderPdfPage(source, 1);
  h.calls[0].child.stdout.write(Buffer.alloc(LIMITS.maxResponseBytes + 1, 120));
  h.calls[0].child.finish(null, 1);
  await assert.rejects(pending, error => error.code === 'pdf_render_output' && error.render.resourceBoundary.cleanup.confirmed === false);
  assert.equal(h.renderer.state().quarantined, true);
  const abnormal = harness(), other = abnormal.renderer.renderPdfPage(source, 1); abnormal.calls[0].child.finish(null, 1);
  await assert.rejects(other, error => error.code === 'pdf_render_process' && error.render.resourceBoundary.cleanup.confirmed === false);
  assert.equal(abnormal.renderer.state().quarantined, true);
});

test('known spawnfailure before launch releases the slot without exposing process errors or claiming memory enforcement', async () => {
  const h = harness({ spawnImpl: () => { throw new Error('SECRET_SPAWN_DETAIL'); } });
  await assert.rejects(h.renderer.renderPdfPage(source, 1), error => error.code === 'pdf_render_unavailable'
    && !error.message.includes('SECRET') && error.render.resourceBoundary.cleanup.notLaunched === true);
  assert.deepEqual(h.renderer.state(), { active: 0, quarantined: false });
});

test('uniform geometry is bounded at150DPI/2600edge/4Mp, including extreme aspect and large pages', () => {
  for (const [width, height] of [[612, 792], [792, 612], [2000, 3000], [1e6, 1e6], [100, 1e6]]) {
    const value = pdfPageGeometry(width, height);
    assert.ok(value.width > 0 && value.height > 0 && Math.max(value.width, value.height) <= 2600);
    assert.ok(value.pixels <= 4_000_000 && value.dpi <= 150);
    assert.ok(Math.abs(width * value.scale - value.width) < 1.001);
    assert.ok(Math.abs(height * value.scale - value.height) < 1.001);
  }
  for (const dimensions of [[0, 10], [-1, 2], [Infinity, 10], [NaN, 10]]) assert.throws(() => pdfPageGeometry(...dimensions));
});

test('actual deployed canvas/resource policy rejects every oversized allocation and all external resource kinds', async () => {
  let allocated = 0;
  const policy = createPdfRenderPolicy({ createCanvas: (width, height) => { allocated++; return { width, height, getContext: () => ({}) }; } });
  const factory = new policy.CanvasFactory(), first = factory.create(2000, 2000), second = factory.create(2000, 2000);
  assert.throws(() => factory.create(1, 1)); assert.equal(allocated, 2);
  factory.destroy(first); factory.reset(second, 10, 10); factory.destroy(second);
  assert.equal(policy.metrics().activePixels, 0); assert.equal(policy.metrics().peakCanvasPixels, 8_000_000);
  for (const pair of [[2601, 1], [2100, 2100], [0, 1]]) assert.throws(() => factory.create(...pair));
  const resources = new policy.BinaryDataFactory();
  for (const input of [{ url: 'https://example.invalid/a' }, { url: 'file:///private' }, { kind: 'cMapUrl' }, { kind: 'standardFontDataUrl' }, { kind: 'wasmUrl' }]) await assert.rejects(resources.fetch(input), /disabled/);
  await assert.rejects(policy.denyFetch('https://example.invalid'), /disabled/);
  assert.equal(policy.metrics().deniedResourceRequests, 6);
});

test('document/form/selectedpage JSactions and XFA are rejected as data, never executed or enabled', async () => {
  const document = extra => ({ numPages: 2, isPureXfa: false, getMetadata: async () => ({ info: { IsXFAPresent: false } }),
    hasJSActions: async () => false, getJSActions: async () => null, ...extra });
  await assertStaticPdfDocument(document()); await assertStaticPdfPage({ getJSActions: async () => null });
  for (const value of [document({ numPages: 301 }), document({ isPureXfa: true }), document({ getMetadata: async () => ({ info: { IsXFAPresent: true } }) }),
    document({ hasJSActions: async () => true }), document({ getJSActions: async () => new Map([['OpenAction', ['UNEXECUTED_SCRIPT_SENTINEL']]]) })]) await assert.rejects(assertStaticPdfDocument(value));
  await assert.rejects(assertStaticPdfPage({ getJSActions: async () => ({ OpenAction: 'UNEXECUTED_SCRIPT_SENTINEL' }) }), /JavaScript/);
});
