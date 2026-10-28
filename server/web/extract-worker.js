import { parentPort, workerData } from 'node:worker_threads';
import { extractPage } from './extract.js';
try { parentPort.postMessage({ ok: true, page: workerData.kind === 'search' ? (await import('./search.js')).extractSearchPage(workerData) : extractPage(workerData) }); }
catch (error) { parentPort.postMessage({ ok: false, error: workerData.kind === 'search' ? String(error.message).slice(0, 300) : 'Web page text extraction failed' }); }
