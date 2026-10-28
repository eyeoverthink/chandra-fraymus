import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PDF_RENDER_LIMITS as LIMITS, PDF_RENDERER_IDENTITY, validatePdfInput } from './limits.mjs';

const wrapper = fileURLToPath(new URL('../documents/bounded-process.py', import.meta.url));
const childScript = fileURLToPath(new URL('./pdf-child.mjs', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (code, message, status = 422) => Object.assign(new Error(message), { code, status });
const integer = value => Number.isSafeInteger(value) && value >= 0;

function acceptResult(value, snapshot, page) {
  if (!value || value.ok !== true) throw failure('pdf_render_failed', String(value?.error || 'PDF page rendering failed.').slice(0, 300));
  const image = value.image;
  if (!image || typeof image.dataBase64 !== 'string' || image.dataBase64.length > Math.ceil(LIMITS.maxPngBytes / 3) * 4
    || image.dataBase64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.dataBase64)) throw failure('pdf_render_receipt', 'PDF renderer returned invalid bounded PNG bytes.');
  const png = Buffer.from(image.dataBase64, 'base64');
  if (png.toString('base64') !== image.dataBase64 || png.length < 24 || png.length > LIMITS.maxPngBytes
    || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || png.subarray(12, 16).toString('ascii') !== 'IHDR' || image.mimeType !== 'image/png'
    || value.sourceSha256 !== hash(snapshot) || value.sourceBytes !== snapshot.length || value.page !== page
    || !Number.isSafeInteger(value.pageCount) || value.pageCount < page || value.pageCount > LIMITS.maxPages
    || image.sha256 !== hash(png) || image.bytes !== png.length
    || image.width !== png.readUInt32BE(16) || image.height !== png.readUInt32BE(20)
    || !integer(image.width) || !integer(image.height) || image.width < 1 || image.height < 1
    || image.width > LIMITS.maxEdge || image.height > LIMITS.maxEdge || image.width * image.height > LIMITS.maxPixels
    || image.pixels !== image.width * image.height || !Number.isFinite(image.dpi) || image.dpi <= 0 || image.dpi > LIMITS.targetDpi
    || image.requestedDpi !== LIMITS.targetDpi || typeof image.downscaled !== 'boolean'
    || image.downscaled !== (image.dpi < LIMITS.targetDpi)) throw failure('pdf_render_receipt', 'PDF source/page/image identity or output bounds did not match.');
  if (!value.renderer || Object.entries(PDF_RENDERER_IDENTITY).some(([key, expected]) => value.renderer[key] !== expected)
    || value.renderer.externalRequests !== 0 || !integer(value.renderer.peakCanvasPixels)
    || value.renderer.peakCanvasPixels < image.pixels || value.renderer.peakCanvasPixels > LIMITS.maxActiveCanvasPixels) throw failure('pdf_render_receipt', 'PDF renderer identity, options or resource facts did not match.');
  if (!Array.isArray(value.warnings) || value.warnings.length > 16 || value.warnings.some(message => typeof message !== 'string' || message.length > 300 || !message.isWellFormed())) throw failure('pdf_render_receipt', 'PDF renderer warnings are invalid or excessive.');
  return { png, sourceSha256: value.sourceSha256, sourceBytes: snapshot.length, page, pageCount: value.pageCount,
    image: { mimeType: 'image/png', sha256: image.sha256, bytes: png.length, width: image.width, height: image.height,
      dpi: image.dpi, requestedDpi: image.requestedDpi, pixels: image.pixels, downscaled: image.downscaled },
    renderer: { ...PDF_RENDERER_IDENTITY, peakCanvasPixels: value.renderer.peakCanvasPixels, externalRequests: 0 }, warnings: [...value.warnings] };
}

/** One explicit PDF page, resource-bounded in the existing Windows Job wrapper.
 * Construction seams are trusted tests/operator code, never HTTP/model options.
 * Forced wrapper termination cannot prove direct Node exit: quarantine persists
 * for this instance even if the wrapper subsequently reports process close.
 */
export function createPdfRenderer({ spawnImpl = spawn, platform = process.platform,
  pythonPath = process.env.FRAYMUS_DOCUMENT_PYTHON || 'python', nodePath = process.execPath,
  setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, now = Date.now } = {}) {
  let active = 0, quarantined = false;
  async function renderPdfPage(bytes, page, { signal } = {}) {
    try { validatePdfInput(bytes, page); } catch (error) { throw failure('pdf_render_input', error.message, 400); }
    signal?.throwIfAborted();
    if (platform !== 'win32') throw failure('pdf_render_platform', 'PDF rendering requires the verified Windows Job backend.', 503);
    if (quarantined) throw failure('pdf_render_quarantined', 'PDF rendering is disabled after unconfirmed process cleanup; operator review and restart are required.', 503);
    if (active >= LIMITS.maxConcurrent) throw failure('pdf_render_busy', 'PDF renderers are busy; wait for current work to finish.', 429);
    const snapshot = Buffer.from(bytes), sourceSha256 = hash(snapshot);
    const payload = JSON.stringify({ version: 1, dataBase64: snapshot.toString('base64'), page });
    if (Buffer.byteLength(payload) > LIMITS.maxRequestBytes) throw failure('pdf_render_input', 'PDF render request exceeds 6 MiB.', 400);
    const env = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    active++; const started = now();
    return new Promise((resolve, reject) => {
      let child, deadline, cleanupDeadline, done = false, forced = false, stopError;
      let outputBytes = 0; const chunks = [];
      const boundary = (confirmed, launcherExited, exitCode) => ({ backend: 'windows-job', memoryBytes: LIMITS.memoryBytes,
        deadlineMs: LIMITS.timeoutMs, cleanup: { confirmed, forced, launcherExited,
          directNodeExitConfirmed: confirmed, evidence: confirmed ? 'trusted-wrapper-normal-exit-and-direct-child-wait' : 'direct-child-exit-unconfirmed',
          ...(Number.isInteger(exitCode) ? { launcherExitCode: exitCode } : {}) },
        scope: 'Committed-memory and process-lifetime bounds only; this is not an AppContainer or filesystem/network security sandbox.' });
      const finish = (error, value, resourceBoundary) => {
        if (done) return; done = true;
        clearTimeoutImpl(deadline); clearTimeoutImpl(cleanupDeadline); signal?.removeEventListener('abort', abort);
        active--;
        if (error) {
          error.render = { sourceSha256, sourceBytes: snapshot.length, page, renderer: PDF_RENDERER_IDENTITY, resourceBoundary };
          reject(error);
        } else resolve({ ...value, elapsedMs: Math.max(0, now() - started), resourceBoundary });
      };
      const stop = error => {
        if (done || forced) return;
        forced = true; stopError = error; quarantined = true;
        cleanupDeadline = setTimeoutImpl(() => finish(stopError, null, boundary(false, false)), LIMITS.cleanupTimeoutMs);
        try { child?.kill(); } catch { /* Exact process cleanup remains unconfirmed. */ }
      };
      const abort = () => stop(failure('pdf_render_cancelled', 'PDF rendering was cancelled; direct child cleanup is unconfirmed.', 499));
      try {
        child = spawnImpl(pythonPath, [wrapper, nodePath, childScript, String(LIMITS.memoryBytes)],
          { shell: false, windowsHide: true, cwd: fileURLToPath(new URL('.', import.meta.url)), env, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stderr.resume(); child.stdin.on('error', () => {});
        child.stdout.on('data', chunk => {
          if (done || forced) return;
          outputBytes += chunk.length;
          if (outputBytes > LIMITS.maxResponseBytes) stop(failure('pdf_render_output', 'PDF renderer output exceeded 6 MiB; cleanup is unconfirmed.', 503));
          else chunks.push(Buffer.from(chunk));
        });
        child.once('error', () => {
          if (child.pid) stop(failure('pdf_render_process', 'PDF renderer process failed after launch; cleanup is unconfirmed.', 503));
          else finish(failure('pdf_render_unavailable', 'The memory-limited PDF launcher is unavailable.', 503), null,
            { backend: 'windows-job', memoryBytes: LIMITS.memoryBytes, cleanup: { confirmed: true, forced: false, notLaunched: true } });
        });
        child.once('close', exitCode => {
          if (done) return;
          if (forced) { finish(stopError, null, boundary(false, true, exitCode)); return; }
          if (exitCode !== 0) {
            quarantined = true;
            finish(failure('pdf_render_process', 'PDF renderer exited without a verified normal cleanup receipt; rendering is quarantined.', 503), null, boundary(false, true, exitCode));
            return;
          }
          const resourceBoundary = boundary(true, true, exitCode);
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(null, acceptResult(value, snapshot, page), resourceBoundary);
          } catch (error) { finish(error.code ? error : failure('pdf_render_receipt', 'PDF renderer returned invalid JSON.'), null, resourceBoundary); }
        });
        deadline = setTimeoutImpl(() => stop(failure('pdf_render_timeout', 'PDF rendering exceeded 15 seconds; direct child cleanup is unconfirmed.', 503)), LIMITS.timeoutMs);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        if (!forced && !done) child.stdin.end(payload);
      } catch {
        if (child) stop(failure('pdf_render_process', 'PDF launcher setup failed after process creation; cleanup is unconfirmed.', 503));
        else finish(failure('pdf_render_unavailable', 'The memory-limited PDF launcher could not start.', 503), null,
          { backend: 'windows-job', memoryBytes: LIMITS.memoryBytes, cleanup: { confirmed: true, forced: false, notLaunched: true } });
      }
    });
  }
  return Object.freeze({ renderPdfPage, state: () => ({ active, quarantined }) });
}

const renderer = createPdfRenderer();
export const renderPdfPage = (bytes, page, options) => renderer.renderPdfPage(bytes, page, options);
export const pdfRendererState = () => renderer.state();
