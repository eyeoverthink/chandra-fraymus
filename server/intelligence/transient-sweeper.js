/**
 * Transient Sweeper — rows a crash or restart left mid-flight.
 *
 * The self-audit's `stuck_transient` check found 4 agent runs, 11 verifier loops and 12 OPEG
 * proposals sitting in running / S1–S3 for 4–68 hours on 2026-11-09 after a day of restarts.
 * Goal executions and debates already had sweepers; these three did not. A row that says
 * "running" for 17 hours is a lie the organism tells itself (metacognition counts it, the
 * self-audit flags it, reflection reasons over it), so each table gets closed out honestly:
 *
 *   runs                running/queued  → status 'error',  error 'swept: interrupted by restart'
 *   verification_loops  running         → status 'error',  error 'swept: never finished', completed_at
 *   opeg_proposals      S1/S2/S3        → state S4_UPDATE, sanitize_verdict {decision:'ABANDONED'}, completed_at
 *
 * Runs at daemon start and hourly; MAX_AGE (2 h) is far above any legitimate duration here
 * (agent runs cap at 4 min, verifier loops at ~10 model calls, OPEG at one execute).
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();
const MAX_AGE_MS = Math.max(15 * 60_000, parseInt(process.env.SWEEP_MAX_AGE_MS, 10) || 2 * 60 * 60_000);
const INTERVAL_MS = 60 * 60_000;

let timer = null;
const state = { running: false, sweeps: 0, lastAt: 0, lastResult: null, totals: { runs: 0, verification_loops: 0, opeg_proposals: 0 } };

export function sweepStaleTransients({ maxAgeMs = MAX_AGE_MS, trigger = 'manual' } = {}) {
  const cutoff = now() - maxAgeMs;
  const t = now();
  const result = { trigger, maxAgeMs, runs: 0, verification_loops: 0, opeg_proposals: 0, errors: [] };
  try {
    result.runs = db.prepare(`UPDATE runs SET status = 'error', error = COALESCE(error, 'swept: interrupted by restart'), updated_at = ? WHERE status IN ('running', 'queued') AND created_at < ?`).run(t, cutoff).changes;
  } catch (e) { result.errors.push(`runs: ${e.message.slice(0, 100)}`); }
  try {
    result.verification_loops = db.prepare(`UPDATE verification_loops SET status = 'error', error = COALESCE(error, 'swept: never finished'), completed_at = ? WHERE status = 'running' AND created_at < ?`).run(t, cutoff).changes;
  } catch (e) { result.errors.push(`verification_loops: ${e.message.slice(0, 100)}`); }
  try {
    const verdict = JSON.stringify({ decision: 'ABANDONED', reason: 'swept: proposal never left S1–S3 (process restarted mid-pipeline)', sweptAt: t });
    result.opeg_proposals = db.prepare(`UPDATE opeg_proposals SET state = 'S4_UPDATE', sanitize_verdict = COALESCE(sanitize_verdict, ?), completed_at = ?, updated_at = ? WHERE state IN ('S1_HYPOTHESIS', 'S2_EXECUTE', 'S3_SANITIZE') AND created_at < ?`).run(verdict, t, t, cutoff).changes;
  } catch (e) { result.errors.push(`opeg_proposals: ${e.message.slice(0, 100)}`); }
  // debates (2026-11-09): sweepStaleDebates() only ran at boot; a debate left 'running' mid-day sat for hours
  // and the self-audit flagged it as stuck_transient (occurrences 46) — now swept hourly like the others
  try {
    result.debates = db.prepare(`UPDATE debates SET status = 'failed', verdict = COALESCE(verdict, 'abandoned'), verdict_reasoning = COALESCE(verdict_reasoning, 'swept: never finished'), confidence = COALESCE(confidence, 0) WHERE status = 'running' AND created_at < ?`).run(cutoff).changes;
  } catch (e) { result.errors.push(`debates: ${e.message.slice(0, 100)}`); result.debates = 0; }
  // Phase AD: capability benchmarks and lesson A/B tests are single-flight in memory; a row still open after the cutoff is dead
  try {
    result.capability_runs = db.prepare(`UPDATE capability_runs SET status = 'error', error = 'swept: never finished', completed_at = ? WHERE status = 'running' AND created_at < ?`).run(Date.now(), cutoff).changes;
  } catch (e) { result.errors.push(`capability_runs: ${e.message.slice(0, 100)}`); result.capability_runs = 0; }
  try {
    result.reasoner_lessons = db.prepare(`UPDATE reasoner_lessons SET status = 'reverted', note = 'swept: test never finished', completed_at = ? WHERE status = 'testing' AND created_at < ?`).run(Date.now(), cutoff).changes;
  } catch (e) { result.errors.push(`reasoner_lessons: ${e.message.slice(0, 100)}`); result.reasoner_lessons = 0; }
  // Creation jobs run one at a time with a 40-minute render limit; a row still 'running' after the cutoff has no process behind it
  try {
    result.creation_jobs = db.prepare(`UPDATE creation_jobs SET status = 'error', error = 'swept: never finished', completed_at = ? WHERE status = 'running' AND COALESCE(started_at, created_at) < ?`).run(Date.now(), cutoff).changes;
  } catch (e) { result.errors.push(`creation_jobs: ${e.message.slice(0, 100)}`); result.creation_jobs = 0; }
  // Remote jobs are polled by one in-memory loop; a row still 'running' after the cutoff has nobody waiting for it
  try {
    result.worker_jobs = db.prepare().run(Date.now(), cutoff).changes;
  } catch (e) { result.errors.push(); result.worker_jobs = 0; }
  state.totals.worker_jobs = (state.totals.worker_jobs || 0) + (result.worker_jobs || 0);
  for (const k of ['capability_runs', 'reasoner_lessons', 'creation_jobs']) state.totals[k] = (state.totals[k] || 0) + (result[k] || 0);
  const total = result.runs + result.verification_loops + result.opeg_proposals + (result.debates || 0) + (result.capability_runs || 0) + (result.reasoner_lessons || 0) + (result.creation_jobs || 0) + (result.worker_jobs || 0);
  state.sweeps++; state.lastAt = t; state.lastResult = result;
  state.totals.debates = state.totals.debates || 0;
  for (const k of ['runs', 'verification_loops', 'opeg_proposals', 'debates']) state.totals[k] += result[k] || 0;
  if (total) {
    console.log(`[sweeper] closed ${total} stale transient row(s): runs ${result.runs}, verifier ${result.verification_loops}, opeg ${result.opeg_proposals}, debates ${result.debates || 0} (> ${Math.round(maxAgeMs / 60000)} min, ${trigger})`);
    try { publish('sweeper', 'system.sweeper', JSON.stringify({ ...result, total })); } catch (_) {}
  }
  return { ...result, total };
}

export function startTransientSweeper() {
  stopTransientSweeper();
  state.running = true;
  const boot = sweepStaleTransients({ trigger: 'boot' });
  timer = setInterval(() => { try { sweepStaleTransients({ trigger: 'interval' }); } catch (e) { console.error('[sweeper]', e.message); } }, INTERVAL_MS);
  return { started: true, intervalMs: INTERVAL_MS, maxAgeMs: MAX_AGE_MS, boot };
}

export function stopTransientSweeper() {
  if (timer) { clearInterval(timer); timer = null; }
  state.running = false;
  return { stopped: true };
}

export function getSweeperStatus() {
  const stuck = {};
  try { stuck.runs = db.prepare(`SELECT COUNT(*) c FROM runs WHERE status IN ('running','queued') AND created_at < ?`).get(now() - MAX_AGE_MS).c; } catch (_) {}
  try { stuck.verification_loops = db.prepare(`SELECT COUNT(*) c FROM verification_loops WHERE status = 'running' AND created_at < ?`).get(now() - MAX_AGE_MS).c; } catch (_) {}
  try { stuck.opeg_proposals = db.prepare(`SELECT COUNT(*) c FROM opeg_proposals WHERE state IN ('S1_HYPOTHESIS','S2_EXECUTE','S3_SANITIZE') AND created_at < ?`).get(now() - MAX_AGE_MS).c; } catch (_) {}
  try { stuck.debates = db.prepare(`SELECT COUNT(*) c FROM debates WHERE status = 'running' AND created_at < ?`).get(now() - MAX_AGE_MS).c; } catch (_) {}
  try { stuck.capability_runs = db.prepare(`SELECT COUNT(*) c FROM capability_runs WHERE status = 'running' AND created_at < ?`).get(now() - MAX_AGE_MS).c; } catch (e) { stuck.capability_runs = null; }
  try { stuck.reasoner_lessons = db.prepare(`SELECT COUNT(*) c FROM reasoner_lessons WHERE status = 'testing' AND created_at < ?`).get(now() - MAX_AGE_MS).c; } catch (e) { stuck.reasoner_lessons = null; }
  return { ...state, intervalMs: INTERVAL_MS, maxAgeMs: MAX_AGE_MS, currentlyStuck: stuck };
}

export function installSweeperRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/sweeper', route((_req, res) => res.json(getSweeperStatus())));
  app.post('/api/intelligence/sweeper/run', route((req, res) => res.json(sweepStaleTransients({ trigger: 'api', maxAgeMs: Math.max(15 * 60_000, parseInt(req.body?.maxAgeMs, 10) || MAX_AGE_MS) }))));
}
