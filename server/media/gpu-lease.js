/**
 * GPU lease — one owner of the graphics card at a time.
 *
 * This machine has one 8 GB card. Ollama normally holds ~6 GB of it for the language model, and the
 * autonomy daemon calls it around the clock, so a media engine (ComfyUI, later music and video
 * models) cannot share the card: it has to borrow it. Taking the lease
 *   1. pauses the Ollama scheduler (nothing new is admitted; running calls finish),
 *   2. asks Ollama to unload every loaded model (keep_alive: 0) and checks the memory came back,
 *   3. records who holds the card and until when.
 * Releasing resumes the scheduler; Ollama reloads its model on the next call by itself.
 *
 * A lease cannot be lost: it has a deadline that the holder extends by heartbeat, a watchdog releases
 * it when the deadline passes, and nothing survives a restart (the lease is process memory; rows left
 * 'held' by a dead process are closed at load). The operator can always force a release.
 *
 * Known limit: callers that reach Ollama without the scheduler (a few direct fetches) can reload a
 * model during a lease. vramSnapshot() in the status makes that visible; it is not prevented.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { OLLAMA_URL, mayRecoverAtBoot } from '../config.js';
import { publish } from '../fleet/bus.js';
import { pauseOllama, resumeOllama, waitForOllamaIdle, ollamaPaused } from '../intelligence/ollama-scheduler.js';
import { recordCard, currentOrigin, originOf } from '../intelligence/card-ledger.js';

const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 6 * 3_600_000;
const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);

let lease = null; // { id, owner, purpose, acquiredAt, expiresAt, freedMB, timer }

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_leases (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, purpose TEXT, status TEXT NOT NULL,
      vram_before_mb INTEGER, vram_after_mb INTEGER, unloaded TEXT, release_reason TEXT,
      acquired_at INTEGER NOT NULL, released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gpu_leases_acquired ON gpu_leases(acquired_at);
  `);
  const closed = !mayRecoverAtBoot() ? 0 : db.prepare(`UPDATE gpu_leases SET status = 'released', release_reason = 'process restarted', released_at = ? WHERE status = 'held'`).run(now()).changes;
  if (closed) console.log(`[gpu-lease] closed ${closed} lease(s) left by a previous process`);
} catch (e) { console.error('[gpu-lease] table setup failed:', e.message); }

const emit = payload => { try { publish('gpu-lease', 'system.gpu', JSON.stringify(payload)); } catch (e) { console.error('[gpu-lease] publish:', e.message); } };

/** { usedMB, totalMB, temperatureC } from nvidia-smi, or null when it cannot be read. */
export function vramSnapshot() {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const [used, total, temp] = String(stdout).trim().split('\n')[0].split(',').map(x => parseInt(x, 10));
      resolve(Number.isFinite(used) ? { usedMB: used, totalMB: total, temperatureC: temp } : null);
    });
  });
}

async function ollamaLoaded() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return ((await res.json()).models || []).map(m => m.name || m.model).filter(Boolean);
  } catch (e) { return []; }
}

/** Ask Ollama to drop every loaded model from memory. Returns the names it was asked to unload. */
export async function unloadOllamaModels() {
  const names = await ollamaLoaded();
  for (const model of names) {
    try {
      // an empty generate with keep_alive 0 is Ollama's documented way to unload a model now
      await fetch(`${OLLAMA_URL}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(15_000) });
    } catch (e) { console.error(`[gpu-lease] unload ${model}:`, e.message); }
  }
  for (let i = 0; i < 20 && (await ollamaLoaded()).length; i++) await new Promise(r => setTimeout(r, 500));
  return names;
}

function arm(ttlMs) {
  clearTimeout(lease.timer);
  lease.expiresAt = now() + ttlMs;
  lease.timer = setTimeout(() => { releaseGpuLease(lease?.owner, { reason: 'deadline passed without a heartbeat', force: true }).catch(e => console.error('[gpu-lease] watchdog:', e.message)); }, ttlMs);
  lease.timer.unref?.();
}

/**
 * Take the card. Resolves { ok: true, leaseId, freedMB, vram } or { ok: false, reason, heldBy }.
 * Never throws for "busy": callers queue or report.
 */
export async function acquireGpuLease(owner, { purpose = '', ttlMs = DEFAULT_TTL_MS, idleTimeoutMs = 120_000 } = {}) {
  if (!owner) return { ok: false, reason: 'owner required' };
  if (lease) return { ok: false, reason: 'held', heldBy: lease.owner, purpose: lease.purpose, expiresInMs: Math.max(0, lease.expiresAt - now()) };
  const ttl = Math.min(MAX_TTL_MS, Math.max(30_000, ttlMs));
  // who it is charged to is decided now: the release may come from the watchdog, outside the caller's context
  lease = { id: `gpu-${randomUUID().slice(0, 10)}`, owner: clip(owner, 60), purpose: clip(purpose, 160), acquiredAt: now(), expiresAt: now() + ttl, freedMB: null, timer: null, origin: originOf(currentOrigin(), owner) };
  const mine = lease;
  try {
    const before = await vramSnapshot();
    pauseOllama(`gpu lease: ${mine.owner}`);
    const idle = await waitForOllamaIdle(idleTimeoutMs);
    if (!idle) { lease = null; resumeOllama(); return { ok: false, reason: 'ollama_busy', detail: `a model call was still running after ${Math.round(idleTimeoutMs / 1000)} s` }; }
    const unloaded = await unloadOllamaModels();
    const after = await vramSnapshot();
    mine.freedMB = before && after ? before.usedMB - after.usedMB : null;
    arm(ttl);
    db.prepare(`INSERT INTO gpu_leases (id, owner, purpose, status, vram_before_mb, vram_after_mb, unloaded, acquired_at) VALUES (?, ?, ?, 'held', ?, ?, ?, ?)`)
      .run(mine.id, mine.owner, mine.purpose, before?.usedMB ?? null, after?.usedMB ?? null, JSON.stringify(unloaded), mine.acquiredAt);
    emit({ action: 'acquired', leaseId: mine.id, owner: mine.owner, purpose: mine.purpose, freedMB: mine.freedMB, usedMB: after?.usedMB ?? null });
    return { ok: true, leaseId: mine.id, owner: mine.owner, unloaded, freedMB: mine.freedMB, vram: after, expiresAt: mine.expiresAt };
  } catch (e) {
    // never leave the scheduler paused because the lease itself failed
    if (lease === mine) lease = null;
    resumeOllama();
    console.error('[gpu-lease] acquire failed:', e.message);
    return { ok: false, reason: 'error', detail: clip(e.message, 200) };
  }
}

/** Keep the lease alive while work continues. */
export function heartbeatGpuLease(owner, ttlMs = DEFAULT_TTL_MS) {
  if (!lease || lease.owner !== owner) return { ok: false, reason: lease ? 'not_owner' : 'no_lease' };
  arm(Math.min(MAX_TTL_MS, Math.max(30_000, ttlMs)));
  return { ok: true, expiresAt: lease.expiresAt };
}

/** Give the card back. `force` lets the watchdog or the operator release someone else's lease. */
export async function releaseGpuLease(owner, { reason = 'done', force = false } = {}) {
  if (!lease) { if (ollamaPaused()) resumeOllama(); return { ok: true, released: false, reason: 'no_lease' }; }
  if (!force && lease.owner !== owner) return { ok: false, reason: 'not_owner', heldBy: lease.owner };
  const done = lease;
  clearTimeout(done.timer);
  lease = null;
  resumeOllama();
  const vram = await vramSnapshot();
  try { db.prepare(`UPDATE gpu_leases SET status = 'released', release_reason = ?, released_at = ? WHERE id = ?`).run(clip(reason, 160), now(), done.id); }
  catch (e) { console.error('[gpu-lease] release record:', e.message); }
  recordCard({ machine: 'this PC', card: 'gpu', kind: 'lease', seconds: (now() - done.acquiredAt) / 1000, job: done.id, label: `${done.owner}: ${done.purpose}`, origin: done.origin, ok: reason !== 'expired' });
  emit({ action: 'released', leaseId: done.id, owner: done.owner, reason, heldMs: now() - done.acquiredAt });
  return { ok: true, released: true, leaseId: done.id, heldMs: now() - done.acquiredAt, vram };
}

/** Run `fn` holding the lease; always releases, whatever `fn` does. */
export async function withGpuLease(owner, opts, fn) {
  const got = await acquireGpuLease(owner, opts);
  if (!got.ok) { const err = new Error(`GPU is not available: ${got.reason}${got.heldBy ? ` (held by ${got.heldBy})` : ''}`); err.code = 'gpu_unavailable'; err.detail = got; throw err; }
  try { return await fn(got); }
  finally { await releaseGpuLease(owner, { reason: 'job finished' }).catch(e => console.error('[gpu-lease] release after job:', e.message)); }
}

export async function gpuStatus() {
  const vram = await vramSnapshot();
  let recent = [];
  try { recent = db.prepare(`SELECT id, owner, purpose, status, vram_before_mb, vram_after_mb, release_reason, acquired_at, released_at FROM gpu_leases ORDER BY acquired_at DESC LIMIT 10`).all(); } catch (e) { console.error('[gpu-lease] status:', e.message); }
  return {
    holder: lease ? { leaseId: lease.id, owner: lease.owner, purpose: lease.purpose, heldMs: now() - lease.acquiredAt, expiresInMs: Math.max(0, lease.expiresAt - now()), freedMB: lease.freedMB } : null,
    owner: lease ? lease.owner : 'ollama',
    ollamaPaused: ollamaPaused(),
    ollamaLoaded: await ollamaLoaded(),
    vram,
    recent,
  };
}

export function installGpuLeaseRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/media/gpu', route(async (req, res) => res.json(await gpuStatus())));
  // operator override: always allowed, because a stuck lease silences every agent
  app.post('/api/media/gpu/release', route(async (req, res) => res.json(await releaseGpuLease('operator', { reason: clip(req.body?.reason || 'released by operator', 160), force: true }))));
}
