/**
 * Workers — other machines on the private network that paint and render for this hub.
 *
 * The hub never listens beyond loopback; it calls out to scripts/worker/chandra_worker.py running on a
 * machine with a graphics card. Three contracts (see docs/UNIFIED-SYSTEM-AND-DREAM.md §4):
 *
 *   capability  GET /health        — what the machine has and which kinds of work are ready
 *   work        POST /jobs         — {id, nonce, kind, spec, files}; the same id + content is the same job,
 *               GET /jobs/:id        so a retry never runs twice; the result carries a receipt bound to the nonce
 *               POST /jobs/:id/ack — the hub confirms it holds the outputs
 *   artifact    every output file is checked against the SHA-256 in the receipt before it is used
 *
 * Configuration: CHANDRA_WORKERS="home=http://100.x.y.z:47210,other=http://…" (private hosts only) and a
 * worker may instead be written name=ssh://user@host:port — the hub then opens an SSH tunnel to it and talks to
 * the worker over that. The worker listens on its own 127.0.0.1 only: nothing new is exposed on the network and no
 * firewall rule is added on the worker's machine. Key login (no password) to that host must already work.
 *
 * shared token in CHANDRA_WORKER_TOKEN_FILE (default data/worker-token.txt, created on first use; copy it
 * to the worker). CHANDRA_WORKERS unset = everything runs on this machine, as before.
 *
 * Every remote job is a row in worker_jobs with its receipt. A worker that fails or is busy is never
 * fatal: callers fall back to local work and record why.
 */
import { setHostGuard } from '../intelligence/model-pool.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { db } from '../db.js';
import { DATA_DIR } from '../config.js';
import { classifyUrl } from '../fraymus-os/registry.js';

const TOKEN_FILE = process.env.CHANDRA_WORKER_TOKEN_FILE || join(DATA_DIR, 'worker-token.txt');
const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** Parse "name=url,name=url"; hosts on the public internet are dropped with a reason. */
export function parseWorkers(spec) {
  const out = [], refused = [];
  for (const part of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const name = (i > 0 ? part.slice(0, i) : '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const viaSsh = /^ssh:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(\d{2,5})$/.exec(i > 0 ? part.slice(i + 1).trim() : '');
    if (viaSsh) {
      const h = classifyUrl(`http://${viaSsh[2]}`);
      if (!name || !h.url) { refused.push({ entry: clip(part, 60), reason: 'expected name=ssh://user@host:port' }); continue; }
      if (h.routeClass === 'public') { refused.push({ entry: name, reason: 'public host: workers must be on the private network' }); continue; }
      if (out.some(w => w.name === name)) { refused.push({ entry: name, reason: 'duplicate name' }); continue; }
      const localPort = 47300 + out.length;
      out.push({ name, url: `http://127.0.0.1:${localPort}`, host: viaSsh[2], routeClass: h.routeClass, tunnel: { user: viaSsh[1], host: viaSsh[2], remotePort: Number(viaSsh[3]), localPort } });
      continue;
    }
    const target = i > 0 ? part.slice(i + 1).trim() : '';
    const c = /^https?:\/\//i.test(target) ? classifyUrl(target) : { url: null };   // only http(s) here; ssh:// was handled above, anything else is a mistake
    if (!name || !c.url) { refused.push({ entry: clip(part, 60), reason: 'expected name=http://host:port' }); continue; }
    if (c.routeClass === 'public') { refused.push({ entry: name, reason: 'public host: workers must be on the private network' }); continue; }
    if (out.some(w => w.name === name)) { refused.push({ entry: name, reason: 'duplicate name' }); continue; }
    out.push({ name, url: c.url, host: c.host, routeClass: c.routeClass });
  }
  return { workers: out, refused };
}

/** The content identity the worker computes too: kind + spec + the hash of every input file, key order irrelevant. */
export function jobDigest(kind, spec, files) {
  const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted(v[k])])) : v;
  const hashes = Object.fromEntries(Object.keys(files).sort().map(k => [k, sha256(files[k])]));
  return sha256(Buffer.from(pyJson(sorted({ kind, spec, files: hashes }))));
}

/** JSON exactly as Python's json.dumps(sort_keys=True, separators=(",", ":")) writes it (non-ASCII escaped), so both sides hash the same bytes. */
function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u0080-\uffff]/g, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => `${pyJson(k)}:${pyJson(v[k])}`).join(',') + '}';
}

const CONFIG = parseWorkers(process.env.CREATION_WORKERS === 'off' ? '' : process.env.CHANDRA_WORKERS);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_jobs (
      id TEXT PRIMARY KEY, worker TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, digest TEXT, receipt TEXT, error TEXT,
      purpose TEXT, seconds REAL, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_worker_jobs_created ON worker_jobs(created_at);
  `);
  const closed = db.prepare(`UPDATE worker_jobs SET state = 'error', error = 'interrupted by restart', completed_at = ? WHERE state = 'running'`).run(now()).changes;
  if (closed) console.log(`[workers] closed ${closed} remote job(s) left open by a previous process`);
} catch (e) { console.error('[workers] table setup failed:', e.message); }

function token() {
  if (!existsSync(TOKEN_FILE)) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(TOKEN_FILE, randomBytes(32).toString('hex') + '\n', { mode: 0o600 }); }
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}

const tunnels = new Map(); // worker name → ssh child
process.once('exit', () => { for (const c of tunnels.values()) { try { c.kill(); } catch (_) { /* process is ending */ } } });

const portOpen = port => new Promise(res => { const sock = connect({ host: '127.0.0.1', port }); const done = ok => { sock.destroy(); res(ok); }; sock.once('connect', () => done(true)); sock.once('error', () => done(false)); sock.setTimeout(1500, () => done(false)); });

/** Make sure the SSH tunnel to a worker is up. The tunnel is this process's child; it is restarted when it has died. */
async function ensureTunnel(worker) {
  const t = worker.tunnel;
  if (tunnels.has(worker.name) && await portOpen(t.localPort)) return;
  if (!tunnels.has(worker.name)) {
    const child = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=8',
      '-L', `127.0.0.1:${t.localPort}:127.0.0.1:${t.remotePort}`, `${t.user}@${t.host}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d).slice(-300); });
    child.on('exit', code => { tunnels.delete(worker.name); if (code) console.error(`[workers] tunnel to ${worker.name} closed (${code}): ${err.trim().split('\n').pop() || ''}`); });
    child.on('error', e => { tunnels.delete(worker.name); console.error(`[workers] tunnel to ${worker.name}: ${e.message}`); });
    tunnels.set(worker.name, child);
  }
  for (let i = 0; i < 20; i++) { if (await portOpen(t.localPort)) return; if (!tunnels.has(worker.name)) break; await new Promise(r => setTimeout(r, 400)); }
  throw new Error(`no SSH tunnel to ${t.user}@${t.host} (is key login set up, and is the worker running on port ${t.remotePort}?)`);
}

async function call(worker, path, { method = 'GET', body, timeoutMs = 15_000, raw = false } = {}) {
  if (worker.tunnel) await ensureTunnel(worker);
  const res = await fetch(`${worker.url}${path}`, { method, headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (raw) { if (!res.ok) throw new Error(`HTTP ${res.status}`); return Buffer.from(await res.arrayBuffer()); }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

let healthCache = { at: 0, list: [] };

/** Health and capabilities of every configured worker (cached 20 s). Unreachable workers are listed with the reason. */
export async function workersStatus({ fresh = false } = {}) {
  if (!fresh && now() - healthCache.at < 20_000) return healthCache.list;
  const list = await Promise.all(CONFIG.workers.map(async w => {
    try {
      const r = await call(w, '/health', { timeoutMs: 6000 });
      if (r.status === 401) return { ...w, reachable: true, ok: false, error: 'the worker refused the token (copy data/worker-token.txt to it)' };
      if (!r.ok) return { ...w, reachable: true, ok: false, error: `HTTP ${r.status}` };
      return { ...w, reachable: true, ok: true, host: r.json.host, version: r.json.version, platform: r.json.platform, gpus: r.json.gpus, capabilities: r.json.capabilities, busy: r.json.busy };
    } catch (e) { return { ...w, reachable: false, ok: false, error: clip(e.cause?.code || e.message, 80) }; }
  }));
  healthCache = { at: now(), list };
  return list;
}

/** The first worker that is up, idle and ready for this kind of work, or null with the reasons. */
export async function pickWorker(kind) {
  if (!CONFIG.workers.length) return { worker: null, why: 'no workers are configured' };
  const list = await workersStatus({ fresh: true });
  const ready = list.find(w => w.ok && !w.busy && w.capabilities?.[kind]?.ready);
  if (ready) return { worker: ready, why: `${ready.name} is ready` };
  return { worker: null, why: list.map(w => `${w.name}: ${!w.ok ? w.error : w.busy ? 'busy' : (w.capabilities?.[kind]?.problems || ['not ready']).join('; ')}`).join(' | ') };
}

/**
 * Run one job on a worker and bring its outputs home.
 * @param files   { name: Buffer } inputs
 * @returns {{ receipt, outputs: [{ name, path, bytes, sha256 }], seconds }}
 * Throws on any failure; the worker_jobs row keeps the reason.
 */
export async function runOnWorker(worker, { id, kind, spec, files = {}, purpose = '' }, { outDir, onProgress, timeoutMs = 3_600_000 } = {}) {
  runningOn.set(worker.name, (runningOn.get(worker.name) || 0) + 1);
  try { return await runOnWorkerInner(worker, { id, kind, spec, files, purpose }, { outDir, onProgress, timeoutMs }); }
  finally { runningOn.set(worker.name, Math.max(0, (runningOn.get(worker.name) || 1) - 1)); }
}
async function runOnWorkerInner(worker, { id, kind, spec, files = {}, purpose = '' }, { outDir, onProgress, timeoutMs = 3_600_000 } = {}) {
  const nonce = randomBytes(16).toString('hex');
  const digest = jobDigest(kind, spec, files);
  const t0 = now();
  db.prepare(`INSERT OR REPLACE INTO worker_jobs (id, worker, kind, state, digest, purpose, created_at) VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(id, worker.name, kind, digest, clip(purpose, 200), t0);
  const fail = msg => { db.prepare(`UPDATE worker_jobs SET state = 'error', error = ?, seconds = ?, completed_at = ? WHERE id = ?`).run(clip(msg, 500), +((now() - t0) / 1000).toFixed(1), now(), id); return new Error(`worker ${worker.name}: ${msg}`); };
  try {
    const sent = await call(worker, '/jobs', { method: 'POST', timeoutMs: 120_000, body: { id, nonce, kind, spec, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])) } });
    if (!sent.ok) throw new Error(sent.json.error || `HTTP ${sent.status}`);
    if (sent.json.digest !== digest) throw new Error('the worker computed a different content digest: hub and worker disagree about what was asked');
    const deadline = now() + timeoutMs;
    let job = sent.json, misses = 0;
    while (job.state === 'running') {
      if (now() > deadline) throw new Error(`no result after ${Math.round(timeoutMs / 60000)} min`);
      await new Promise(r => setTimeout(r, 2000));
      try { const r = await call(worker, `/jobs/${id}`); if (!r.ok) throw new Error(r.json.error || `HTTP ${r.status}`); job = r.json; misses = 0; onProgress?.(job.stage, job.progress); }
      catch (e) { if (++misses >= 8) throw new Error(`lost contact while it worked: ${clip(e.message, 100)}`); }
    }
    if (job.state !== 'done') throw new Error(job.error || 'the job failed');
    const receipt = job.receipt;
    if (!receipt || receipt.nonce !== nonce || receipt.digest !== digest || receipt.id !== id) throw new Error('the receipt does not match this request');
    mkdirSync(outDir, { recursive: true });
    const outputs = [];
    for (const f of job.files || []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(f.name)) throw new Error('the worker returned an unsafe file name');
      const buf = await call(worker, `/jobs/${id}/files/${f.name}`, { raw: true, timeoutMs: 300_000 });
      if (sha256(buf) !== f.sha256 || receipt.outputs?.[f.name] !== f.sha256) throw new Error(`${f.name} does not match the hash in the receipt`);
      const path = join(outDir, basename(f.name));
      writeFileSync(path, buf);
      outputs.push({ name: f.name, path, bytes: buf.length, sha256: f.sha256 });
    }
    try { await call(worker, `/jobs/${id}/ack`, { method: 'POST', body: { nonce } }); } catch (e) { console.error('[workers] ack:', e.message); }
    const seconds = +((now() - t0) / 1000).toFixed(1);
    db.prepare(`UPDATE worker_jobs SET state = 'done', receipt = ?, seconds = ?, completed_at = ? WHERE id = ?`).run(JSON.stringify(receipt), seconds, now(), id);
    return { receipt, outputs, seconds };
  } catch (e) { throw fail(e.message); }
}

export function workerJobs(limit = 20) {
  try { return db.prepare(`SELECT id, worker, kind, state, purpose, seconds, error, created_at FROM worker_jobs ORDER BY created_at DESC LIMIT ?`).all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20))); }
  catch (e) { console.error('[workers] list:', e.message); return []; }
}

export function workersConfigured() { return CONFIG.workers.length; }

// ── is a worker's card busy? (read by the model pool, so a language model is not loaded onto it mid-render) ──
const runningOn = new Map();                       // worker name → jobs this hub is running there
const cardSeen = new Map();                         // worker address → { at, busy, usedMB, ollamaMB }
const OTHER_USE_MB = Math.max(256, parseInt(process.env.MODEL_POOL_OTHER_GPU_MB, 10) || 2048);
let refreshing = false;
async function refreshCards() {
  if (refreshing) return; refreshing = true;
  try {
    for (const w of await workersStatus({ fresh: true })) {
      const addr = w.tunnel?.host || w.host; if (!addr) continue;
      let ollamaMB = 0;
      try { const r = await fetch(`http://${addr}:11434/api/ps`, { signal: AbortSignal.timeout(3000) }); if (r.ok) ollamaMB = Math.round(((await r.json()).models || []).reduce((n, m) => n + (m.size_vram || 0), 0) / 2 ** 20); } catch (e) { /* no Ollama there, or not reachable: count none */ }
      const g = (w.gpus || [])[0];
      cardSeen.set(addr, { at: now(), busy: !!w.busy, usedMB: g?.usedMB ?? null, ollamaMB, reachable: !!w.reachable, name: w.name });
    }
  } catch (e) { console.error('[workers] card check:', e.message); }
  finally { refreshing = false; }
}
/**
 * Why a model machine should not be used right now, or null. Matches a pool machine to a worker by address.
 * Synchronous: answers from what was last seen (≤ 20 s old) and starts a fresh look in the background.
 */
export function workerCardGuard({ host }) {
  const w = CONFIG.workers.find(x => (x.tunnel?.host || x.host) === host); if (!w) return null;
  if ((runningOn.get(w.name) || 0) > 0) return `${w.name} is rendering for the hub`;
  const seen = cardSeen.get(host);
  if (!seen || now() - seen.at > 20_000) refreshCards().catch(() => {});
  if (!seen) return null;
  if (seen.busy) return `${w.name}'s worker is busy`;
  if (seen.usedMB != null && seen.usedMB - seen.ollamaMB > OTHER_USE_MB) return `something else is using ${w.name}'s card (${seen.usedMB - seen.ollamaMB} MB that are not a language model)`;
  return null;
}

export function installWorkerRoutes(app) {
  // the model pool skips a machine whose card is rendering for us, or is held by something that is not a language model
  if (CONFIG.workers.length) setHostGuard(workerCardGuard);
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/studio/workers', route(async (req, res) => res.json({
    configured: CONFIG.workers.map(w => ({ name: w.name, url: w.url, host: w.host, routeClass: w.routeClass, via: w.tunnel ? `ssh tunnel to ${w.tunnel.user}@${w.tunnel.host}:${w.tunnel.remotePort}` : 'direct' })), refused: CONFIG.refused,
    tokenFile: TOKEN_FILE, status: await workersStatus({ fresh: req.query.fresh === '1' }), jobs: workerJobs(req.query.limit),
  })));
}
