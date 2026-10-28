// Trusted bootstrap: do not load a parser or consume document bytes until the
// launcher has assigned this process to its hard memory-limited Windows Job.
import { Worker } from 'node:worker_threads';
let worker;
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 6 * 1024 * 1024) throw new Error('Document parser input exceeds its limit');
    chunks.push(chunk);
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (request.mimeType !== 'application/pdf' || typeof request.dataBase64 !== 'string') throw new Error('Invalid PDF parser request');
  const result = await new Promise((resolve, reject) => {
    worker = new Worker(new URL('./worker.js', import.meta.url), { execArgv: [],
      workerData: { data: new Uint8Array(Buffer.from(request.dataBase64, 'base64')), mimeType: request.mimeType, limits: request.limits },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    worker.once('message', resolve); worker.once('error', reject);
    worker.once('exit', () => reject(new Error('PDF worker exited without a result')));
  });
  await worker.terminate();
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 16 * 1024 * 1024) throw new Error('PDF parser output exceeds its limit');
  process.stdout.write(output);
} catch (error) {
  await worker?.terminate();
  process.stdout.write(JSON.stringify({ ok: false, error: String(error.message || 'PDF parser failed').slice(0, 300) }));
  process.exitCode = 1;
}
