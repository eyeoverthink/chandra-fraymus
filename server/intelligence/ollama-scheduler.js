/**
 * Ollama Scheduler — Phase V: one GPU, one queue, priorities.
 *
 * Why: every autonomous subsystem (reflection, debate, verifier, goal engine, dreams)
 * and every agent run call the same local Ollama. Measured 2026-11-09: motor-driven
 * reflections fired every ~90 s and each ran ~5 min of debates/verifier loops inline,
 * so 3–4 reflections overlapped and 100 % of agent-run errors were "aborted due to
 * timeout". Cognition was starving action. Ollama itself serves requests roughly
 * FIFO, so the fix has to live on this side: admit at most MAX_CONCURRENT requests,
 * order the waiting ones by priority class, and DROP low-priority work that has waited
 * too long — a reflection that waits five minutes is a stale thought, not a backlog.
 *
 * Priority classes (lower = sooner):
 *   0 interactive  — user-facing chat / brain
 *   1 agent_run    — fleet agent runs (the only thing that produces outcomes)
 *   2 scoring      — outcome judge, perspective assessment
 *   3 goal         — goal generation; default for untagged callers
 *   4 forge/debate/swarm
 *   5 verifier
 *   6 reflection
 *   7 dream/background
 *
 * Usage: `await withOllama('reflection', () => fetch(...), { label })`. The slot is held
 * for the whole callback — for streaming calls, read the stream inside the callback.
 */

import { publish } from '../fleet/bus.js';
import { tunable } from './tunables.js';

const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const PRIORITY = Object.freeze({
  interactive: 0, agent_run: 1, scoring: 2, goal: 3,
  forge: 4, debate: 4, swarm: 4, synthesize: 4,
  verifier: 5, reflection: 6, dream: 7, background: 7,
});
const CLASS_NAMES = ['interactive', 'agent_run', 'scoring', 'goal', 'forge/debate', 'verifier', 'reflection', 'background'];

// How long each class may wait before being dropped. Interactive and agent runs are
// never dropped by the scheduler (their own request timeouts still apply).
const MAX_WAIT_MS = { 0: Infinity, 1: 10 * 60_000, 2: 5 * 60_000, 3: 3 * 60_000, 4: 2 * 60_000, 5: 2 * 60_000, 6: 90_000, 7: 60_000 };
const DEFAULT_MAX_CONCURRENT = clamp(parseInt(process.env.OLLAMA_MAX_CONCURRENT, 10) || 2, 1, 8);
const maxConcurrent = () => clamp(Math.round(tunable('ollama.max_concurrent', DEFAULT_MAX_CONCURRENT)), 1, 8); // Phase Y: live tunable
const MAX_QUEUE = clamp(parseInt(process.env.OLLAMA_MAX_QUEUE, 10) || 24, 4, 500);
const DROP_EVENT_COOLDOWN_MS = 30_000;

let running = 0;
const runningJobs = new Map(); // id -> { label, prio, startedAt }
const queue = [];              // { id, prio, label, enqueuedAt, resolve, reject, timer }
let nextId = 1;
let lastDropEventAt = 0;
const stats = {
  admitted: 0, completed: 0, failed: 0, dropped: 0,
  totalWaitMs: 0, maxWaitMs: 0, maxQueueDepth: 0,
  byClass: {}, droppedByClass: {},
};
const recent = []; // last 30 jobs: { label, prio, waitMs, durMs, outcome }

function resolvePriority(p) {
  if (typeof p === 'number' && Number.isFinite(p)) return clamp(Math.round(p), 0, 7);
  if (typeof p === 'string' && p in PRIORITY) return PRIORITY[p];
  return PRIORITY.goal;
}

function bump(obj, key) { obj[key] = (obj[key] || 0) + 1; }

function pushRecent(entry) {
  recent.push(entry);
  if (recent.length > 30) recent.shift();
}

// GPU lease support (media/gpu-lease.js): while paused nothing new is admitted. Jobs already running
// finish; queued jobs keep their normal max-wait, so low-priority work is dropped rather than piling
// up behind a long render, and interactive requests wait for the lease to end.
let pausedBy = null;
let pausedAt = 0;
export function pauseOllama(reason) { if (!pausedBy) pausedAt = now(); pausedBy = String(reason || 'paused').slice(0, 80); return { paused: true, by: pausedBy }; }
export function resumeOllama() { const was = pausedBy; pausedBy = null; pausedAt = 0; pump(); return { resumed: true, was }; }
export function ollamaPaused() { return pausedBy ? { by: pausedBy, forMs: now() - pausedAt } : null; }
/** Resolves true once no Ollama job is running, or false at the deadline. */
export async function waitForOllamaIdle(timeoutMs = 120_000) {
  const deadline = now() + timeoutMs;
  while (running > 0 && now() < deadline) await new Promise(r => setTimeout(r, Math.max(10, Math.min(500, deadline - now()))));
  return running === 0;
}

function pump() {
  if (pausedBy) return;
  while (running < maxConcurrent() && queue.length) {
    queue.sort((a, b) => a.prio - b.prio || a.enqueuedAt - b.enqueuedAt);
    const job = queue.shift();
    clearTimeout(job.timer);
    const waited = now() - job.enqueuedAt;
    running++;
    runningJobs.set(job.id, { label: job.label, prio: job.prio, startedAt: now(), waitMs: waited });
    stats.admitted++;
    stats.totalWaitMs += waited;
    if (waited > stats.maxWaitMs) stats.maxWaitMs = waited;
    bump(stats.byClass, CLASS_NAMES[job.prio]);
    job.resolve({ waited, id: job.id });   // the job's own id: withOllama must never guess which running job is its own
  }
}

function drop(job, reason) {
  const idx = queue.indexOf(job);
  if (idx >= 0) queue.splice(idx, 1);
  clearTimeout(job.timer);
  stats.dropped++;
  bump(stats.droppedByClass, CLASS_NAMES[job.prio]);
  const waited = now() - job.enqueuedAt;
  pushRecent({ label: job.label, prio: job.prio, waitMs: waited, durMs: 0, outcome: `dropped:${reason}`, at: now() });
  if (now() - lastDropEventAt > DROP_EVENT_COOLDOWN_MS) {
    lastDropEventAt = now();
    try { publish('ollama-scheduler', 'system.ollama.dropped', JSON.stringify({ label: job.label, priority: job.prio, class: CLASS_NAMES[job.prio], reason, waitedMs: waited, queued: queue.length, running })); } catch (_) {}
  }
  const err = new Error(`ollama scheduler dropped "${job.label}" (${CLASS_NAMES[job.prio]}): ${reason} after ${Math.round(waited / 1000)}s with ${queue.length} queued, ${running} running`);
  err.code = 'scheduler_dropped';
  err.reason = reason;
  job.reject(err);
}

function acquire(prio, label, signal) {
  return new Promise((resolve, reject) => {
    const job = { id: nextId++, prio, label, enqueuedAt: now(), resolve, reject, timer: null };
    // aborted while waiting: leave the queue now, not when the class limit runs out
    if (signal) signal.addEventListener('abort', () => { if (queue.includes(job)) drop(job, 'aborted'); }, { once: true });
    // Overflow: low-priority work does not even queue when the line is already long.
    if (prio >= 4 && queue.length >= MAX_QUEUE) {
      queue.push(job); // so drop() can account for it uniformly
      return drop(job, 'queue_full');
    }
    queue.push(job);
    if (queue.length > stats.maxQueueDepth) stats.maxQueueDepth = queue.length;
    const maxWait = MAX_WAIT_MS[prio];
    if (Number.isFinite(maxWait)) job.timer = setTimeout(() => drop(job, 'max_wait'), maxWait);
    pump();
  });
}

function release(id, outcome, waitMs) {
  if (!runningJobs.has(id)) return;   // never twice, never another job's slot
  const r = runningJobs.get(id);
  runningJobs.delete(id);
  running = Math.max(0, running - 1);
  if (outcome === 'ok') stats.completed++; else stats.failed++;
  pushRecent({ label: r?.label, prio: r?.prio, waitMs, durMs: r ? now() - r.startedAt : 0, outcome, at: now() });
  pump();
}

/**
 * Run `fn` when a slot is free, in priority order. Rejects with code 'scheduler_dropped'
 * when the job waited past its class limit or the queue is full.
 */
export async function withOllama(priority, fn, { label = 'ollama', signal = null } = {}) {
  const prio = resolvePriority(priority);
  signal?.throwIfAborted?.();
  const { waited: waitMs, id } = await acquire(prio, String(label).slice(0, 80), signal);
  // Cancellation frees the slot at once. Before 2026-11-12 the slot was held until fn() settled, so one call that ignored
  // its abort (a stuck socket, an uncooperative provider) kept the single GPU slot forever — "0 queued, 1 running" —
  // and every later model call waited out its class limit (35 agent tests timed out on exactly that).
  let onAbort = null;
  const aborted = signal ? new Promise((_, reject) => {
    onAbort = () => { release(id, 'aborted', waitMs); reject(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }) : null;
  aborted?.catch(() => {});   // settled by the race below; never an unhandled rejection
  try {
    const result = await (aborted ? Promise.race([fn(), aborted]) : fn());
    release(id, 'ok', waitMs);
    return result;
  } catch (e) {
    release(id, e?.name === 'TimeoutError' || /timeout|aborted/i.test(e?.message || '') ? 'timeout' : 'error', waitMs);
    throw e;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function getSchedulerStatus() {
  const queuedByClass = {};
  for (const j of queue) bump(queuedByClass, CLASS_NAMES[j.prio]);
  const oldestQueuedMs = queue.length ? now() - Math.min(...queue.map(j => j.enqueuedAt)) : 0;
  return {
    maxConcurrent: maxConcurrent(),
    maxQueue: MAX_QUEUE,
    paused: ollamaPaused(),
    running,
    runningJobs: [...runningJobs.values()].map(r => ({ label: r.label, class: CLASS_NAMES[r.prio], runningMs: now() - r.startedAt })),
    queued: queue.length,
    queuedByClass,
    oldestQueuedMs,
    pressure: schedulerPressure(),
    maxWaitMs: MAX_WAIT_MS,
    stats: { ...stats, avgWaitMs: stats.admitted ? Math.round(stats.totalWaitMs / stats.admitted) : 0 },
    recent: recent.slice(-20),
  };
}

/** 0..1 — how loaded the inference path is; the resource envelope reads this as a sensor. */
export function schedulerPressure() {
  return clamp((running + queue.length) / (maxConcurrent() * 3), 0, 1);
}

export function installOllamaSchedulerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/ollama-scheduler', route((_req, res) => res.json(getSchedulerStatus())));
}
