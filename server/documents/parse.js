import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DOCUMENT_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxTextBytes: 2 * 1024 * 1024,
  maxPages: 300, maxEntries: 500, maxEntryBytes: 4 * 1024 * 1024, maxExpandedBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 200, timeoutMs: 15000, maxConcurrent: 2, pdfMemoryBytes: 384 * 1024 * 1024 });
let active = 0, quarantined = false;

// ZIP expansion has explicit byte bounds. PDF decompression also needs an OS
// process memory cap: V8 heap limits alone do not bound ArrayBuffer allocations.
export function parseDocument(data, mimeType, { signal } = {}) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > DOCUMENT_LIMITS.maxBytes) return Promise.reject(new Error('Document size must be 1 byte to 4 MiB'));
  if (!['application/pdf', 'application/zip'].includes(mimeType)) return Promise.reject(new Error('Unsupported document type'));
  if (quarantined) return Promise.reject(new Error('Document parsers are disabled after an unconfirmed cleanup; restart the service'));
  if (mimeType === 'application/pdf' && process.platform !== 'win32') return Promise.reject(new Error('PDF parsing requires the Windows memory-limited backend; ZIP/text attachments remain available'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (active >= DOCUMENT_LIMITS.maxConcurrent) return Promise.reject(Object.assign(new Error('Document parsers are busy; retry after the current uploads finish'), { status: 429 }));
  active++;
  return new Promise((resolve, reject) => {
    let worker, child, timer, finished = false;
    const finish = async (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        await worker?.terminate();
        if (child && child.exitCode === null && child.signalCode === null) await new Promise((resolve, reject) => {
          const cleanupTimer = setTimeout(() => reject(new Error('PDF parser cleanup could not be confirmed')), 2000);
          child.once('close', () => { clearTimeout(cleanupTimer); resolve(); });
          child.kill(); // Windows closes the launcher's noninherited Job handle and kills every assigned parser process.
        });
      }
      catch { quarantined = true; error ||= new Error('Document parser cleanup failed'); }
      finally { active--; }
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason || new Error('Document parsing cancelled'));
    try {
      const accept = message => {
        if (!message?.ok) finish(new Error(String(message?.error || 'Document parsing failed').slice(0, 300)));
        else finish(null, { ...message.document, ...(mimeType === 'application/pdf' ? { parsing: { backend: 'windows-job', memoryBytes: DOCUMENT_LIMITS.pdfMemoryBytes } } : {}) });
      };
      if (mimeType === 'application/pdf') {
        const env = {};
        for (const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','LANG']) if (process.env[key]) env[key] = process.env[key];
        child = spawn(process.env.FRAYMUS_DOCUMENT_PYTHON || 'python', [fileURLToPath(new URL('./bounded-process.py', import.meta.url)),
          process.execPath, fileURLToPath(new URL('./parser-child.js', import.meta.url)), String(DOCUMENT_LIMITS.pdfMemoryBytes)],
        { env, windowsHide: true, shell: false, stdio: ['pipe','pipe','pipe'] });
        const chunks = []; let outputBytes = 0;
        child.stderr.resume();
        child.stdin.on('error', () => {}); // Spawn/close reports the failure without an unhandled EPIPE.
        child.stdout.on('data', chunk => {
          outputBytes += chunk.length;
          if (outputBytes > 16 * 1024 * 1024) finish(new Error('PDF parser output exceeds its limit'));
          else chunks.push(chunk);
        });
        child.once('error', () => finish(new Error('Memory-limited PDF launcher unavailable; install Python 3 or configure FRAYMUS_DOCUMENT_PYTHON')));
        child.once('close', () => {
          if (finished) return;
          try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { finish(new Error('Memory-limited PDF parser failed or exceeded its memory limit')); }
        });
        child.stdin.end(JSON.stringify({ dataBase64: data.toString('base64'), mimeType, limits: DOCUMENT_LIMITS }));
      } else {
        worker = new Worker(new URL('./worker.js', import.meta.url), { execArgv: [], workerData: { data: new Uint8Array(data), mimeType, limits: DOCUMENT_LIMITS },
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true });
        worker.stdout.resume(); worker.stderr.resume();
        worker.once('error', error => finish(new Error(`Document parser failed: ${error.code || 'invalid document'}`)));
        worker.once('exit', () => { if (!finished) finish(new Error('Document parser exited without a result')); });
        worker.once('message', accept);
      }
      timer = setTimeout(() => finish(new Error('Document parsing exceeded its 15 second deadline')), DOCUMENT_LIMITS.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}
