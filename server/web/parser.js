import { Worker } from 'node:worker_threads';
let active = 0;
export function extractWebPage(input, signal) {
  if (typeof input?.text !== 'string' || Buffer.byteLength(input.text) > 4 * 1024 * 1024) return Promise.reject(new Error('Web parser input limit exceeded'));
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (active >= 2) return Promise.reject(new Error('Web text parsers are busy; retry later'));
  active++;
  return new Promise((resolve, reject) => {
    let worker, timer, finished = false;
    const finish = async (error, value) => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { await worker?.terminate(); } catch { error ||= new Error('Web text parser cleanup failed'); }
      active--;
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason || new Error('Web text parsing cancelled'));
    try {
      worker = new Worker(new URL('./extract-worker.js', import.meta.url), { execArgv: [], workerData: input,
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true });
      worker.stdout.resume(); worker.stderr.resume();
      worker.once('error', () => finish(new Error('Web text parser exceeded its limits or failed')));
      worker.once('exit', () => { if (!finished) finish(new Error('Web text parser exited without a result')); });
      worker.once('message', result => result?.ok ? finish(null, result.page) : finish(new Error(input.kind === 'search' ? result?.error || 'Web search parsing failed' : 'Web page text extraction failed')));
      timer = setTimeout(() => finish(new Error('Web text parsing exceeded 3 seconds')), 3000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}
