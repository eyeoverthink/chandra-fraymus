/**
 * The consumer synthesized workflows never had (self-audit, open since 2026-11-08: 195 synthesized, 0 ever ran).
 *
 * 1. Triage, without running anything: each synthesized workflow is
 *      needs_operator  — it contains a step that acts outside Chandra or is unsafe to run unattended (the live store,
 *                        generated code, the GPU, commerce records); the reasons are recorded, it is never run here
 *      duplicate       — another synthesized workflow with the same set of steps was already taken for trial
 *      queued          — safe: every step only thinks, reads public pages, or works on local files
 * 2. Trial, one at a time: a queued workflow runs once through the engine with its own goal as the input, under a
 *    time limit; the result is a real workflow_runs row (user 'trial') and the workflow is marked passed or failed.
 *
 * The same rule (classifyNodes) gates autonomous synthesis in synthesizer.js, so the organism stops producing
 * workflows nothing may run. Operators can still synthesize and run anything through the normal routes.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { runPipeline } from './engine.js';
import { publish } from '../fleet/bus.js';
import { isResourceConstrained } from '../intelligence/resource-envelope.js';

const now = () => Date.now();
const TRIAL_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.WORKFLOW_TRIAL_TIMEOUT_MS, 10) || 300_000);
const TRIAL_INTERVAL_MS = Math.max(60_000, parseInt(process.env.WORKFLOW_TRIAL_INTERVAL_MS, 10) || 600_000);

// steps that only think (local model), read public pages, or transform local files
export const SAFE_NODES = new Set([
  'cognition', 'heart_feel', 'dream', 'consciousness_prove', 'memory_recall', 'intelligence_cycle', 'llm',
  'researcher', 'copywriter', 'reviewer', 'trend_scout', 'apparel_designer', 'price_analyst', 'ux_auditor',
  'web_search', 'preview', 'fraymus_tool',
  'image_convert', 'image_resize', 'image_crop', 'image_watermark', 'image_thumbnail', 'image_effects',
  'ocr_recognize', 'stt_transcribe', 'tts_speak', 'video_trim', 'video_thumbnail', 'video_convert', 'video_resize', 'video_gif',
]);
// why the rest are never run unattended
export const UNSAFE_REASONS = {
  shopify_publish: 'changes the live store', shopify_sync: 'changes the live store', shopify_applier: 'changes the live store',
  printify_push: 'sends products to Printify', shopper_report: 'can apply fixes to the live store', pricing_engine: 'reads and prices the live store',
  code: 'runs generated code', image_gen: 'needs the GPU', upscale: 'needs the GPU', bg_remove: 'needs the GPU',
  ceo_logger: 'writes commerce records',
};

/** { safe, reasons: ['shopify_publish: changes the live store', …], signature } for a list of nodes. */
export function classifyNodes(nodes) {
  const types = (Array.isArray(nodes) ? nodes : []).map(n => String(n?.type || ''));
  const reasons = [...new Set(types.filter(t => !SAFE_NODES.has(t)).map(t => `${t}: ${UNSAFE_REASONS[t] || 'unknown step'}`))];
  return { safe: types.length > 0 && reasons.length === 0, reasons, signature: [...new Set(types)].sort().join(',') };
}

export function migrateTrials() {
  for (const col of ['trial_status TEXT', 'trial_reason TEXT', 'trial_run_id TEXT', 'trial_at INTEGER']) {
    try { db.exec(`ALTER TABLE synthesized_workflows ADD COLUMN ${col}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) console.error('[trials] migrate:', e.message); }
  }
  // a trial a dead process left running goes back in the queue
  try { db.prepare("UPDATE synthesized_workflows SET trial_status = 'queued' WHERE trial_status = 'running'").run(); }
  catch (e) { console.error('[trials] recover:', e.message); }
}

const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

/** Mark every untriaged synthesized workflow; returns counts. Runs nothing. */
export function triage() {
  const counts = { needs_operator: 0, duplicate: 0, queued: 0 };
  let rows;
  try {
    rows = db.prepare(`SELECT s.id, s.workflow_id, w.nodes FROM synthesized_workflows s JOIN workflows w ON w.id = s.workflow_id
      WHERE s.trial_status IS NULL ORDER BY s.created_at`).all();
  } catch (e) { console.error('[trials] triage read:', e.message); return counts; }
  const taken = new Set();
  try {
    for (const r of db.prepare(`SELECT w.nodes FROM synthesized_workflows s JOIN workflows w ON w.id = s.workflow_id
      WHERE s.trial_status IN ('queued', 'running', 'passed', 'failed')`).all()) taken.add(classifyNodes(parse(r.nodes, [])).signature);
  } catch (e) { console.error('[trials] triage taken:', e.message); }
  const mark = db.prepare('UPDATE synthesized_workflows SET trial_status = ?, trial_reason = ?, trial_at = ? WHERE id = ?');
  for (const r of rows) {
    const c = classifyNodes(parse(r.nodes, []));
    let status, reason;
    if (!c.safe) { status = 'needs_operator'; reason = c.reasons.join('; ') || 'no steps'; }
    else if (taken.has(c.signature)) { status = 'duplicate'; reason = `same steps as an earlier workflow: ${c.signature}`; }
    else { status = 'queued'; reason = null; taken.add(c.signature); }
    mark.run(status, reason, now(), r.id);
    counts[status]++;
  }
  return counts;
}

let running = false;
/** Run the oldest queued workflow once. Returns what happened, or why nothing ran. */
export async function runNextTrial({ force = false } = {}) {
  if (running) return { ran: false, reason: 'a trial is already running' };
  if (!force && isResourceConstrained()) return { ran: false, reason: 'resource_constrained' };
  const next = db.prepare(`SELECT s.id, s.workflow_id, s.goal, w.nodes, w.edges, w.name FROM synthesized_workflows s JOIN workflows w ON w.id = s.workflow_id
    WHERE s.trial_status = 'queued' ORDER BY s.created_at LIMIT 1`).get();
  if (!next) return { ran: false, reason: 'nothing queued' };
  running = true;
  db.prepare("UPDATE synthesized_workflows SET trial_status = 'running', trial_at = ? WHERE id = ?").run(now(), next.id);
  const t0 = now(), runId = randomUUID();
  let result, error = null;
  try {
    result = await Promise.race([
      runPipeline(parse(next.nodes, []), parse(next.edges, []), { prompt: next.goal }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no result after ${Math.round(TRIAL_TIMEOUT_MS / 1000)} s`)), TRIAL_TIMEOUT_MS).unref?.()),
    ]);
  } catch (e) { error = e.message; }
  const failedSteps = Object.entries(result?.results || {}).filter(([, r]) => r?.error).map(([id, r]) => `${id}: ${String(r.error).slice(0, 120)}`);
  const ok = !error && result?.status === 'success' && failedSteps.length === 0;
  const ms = now() - t0;
  try {
    db.prepare(`INSERT INTO workflow_runs (id, workflow_id, user_id, status, input_prompt, results, final_image_url, final_html, duration_ms, created_at)
      VALUES (?, ?, 'trial', ?, ?, ?, ?, ?, ?, ?)`).run(runId, next.workflow_id, ok ? 'completed' : 'failed', String(next.goal || '').slice(0, 2000),
      JSON.stringify(result?.results || { error }).slice(0, 200_000), result?.imageUrl || null, result?.html || null, ms, now());
    db.prepare('UPDATE synthesized_workflows SET trial_status = ?, trial_reason = ?, trial_run_id = ?, trial_at = ? WHERE id = ?')
      .run(ok ? 'passed' : 'failed', ok ? null : (error || failedSteps.join('; ') || 'the pipeline reported a failure').slice(0, 500), runId, now(), next.id);
  } catch (e) { console.error('[trials] record:', e.message); }
  running = false;
  try { publish('system', 'system.workflows', JSON.stringify({ action: 'workflow_trial', workflowId: next.workflow_id, name: next.name, ok, ms, error: error || failedSteps[0] || null })); }
  catch (e) { console.error('[trials] publish:', e.message); }
  return { ran: true, workflowId: next.workflow_id, name: next.name, ok, ms, runId, error, failedSteps };
}

export function trialStats() {
  try {
    const by = Object.fromEntries(db.prepare("SELECT COALESCE(trial_status, 'untriaged') s, COUNT(*) n FROM synthesized_workflows GROUP BY s").all().map(r => [r.s, r.n]));
    const reasons = db.prepare(`SELECT trial_reason r, COUNT(*) n FROM synthesized_workflows WHERE trial_status = 'needs_operator' GROUP BY r ORDER BY n DESC LIMIT 8`).all();
    const recent = db.prepare(`SELECT s.workflow_id, w.name, s.trial_status, s.trial_reason, s.trial_at FROM synthesized_workflows s JOIN workflows w ON w.id = s.workflow_id
      WHERE s.trial_status IN ('passed', 'failed') ORDER BY s.trial_at DESC LIMIT 10`).all();
    return { byStatus: by, needsOperatorReasons: reasons, recent, running, intervalMs: TRIAL_INTERVAL_MS };
  } catch (e) { return { error: e.message }; }
}

let timer = null;
export function startWorkflowTrials() {
  if (timer) return;
  migrateTrials();
  try { const c = triage(); if (c.queued + c.needs_operator + c.duplicate) console.log('[trials] triaged', JSON.stringify(c)); } catch (e) { console.error('[trials] triage:', e.message); }
  timer = setInterval(() => { try { triage(); } catch (e) { console.error('[trials] triage:', e.message); } runNextTrial().catch(e => console.error('[trials] run:', e.message)); }, TRIAL_INTERVAL_MS);
  timer.unref?.();
}
export function stopWorkflowTrials() { if (timer) clearInterval(timer); timer = null; }

// own prefix: /api/workflows/:id is a param route and would swallow /api/workflows/trials
export function installWorkflowTrialRoutes(app) {
  app.get('/api/workflow-trials', (_req, res) => res.json(trialStats()));
  app.post('/api/workflow-trials/triage', (_req, res, next) => { try { migrateTrials(); res.json(triage()); } catch (e) { next(e); } });
  app.post('/api/workflow-trials/run', async (_req, res, next) => { try { migrateTrials(); triage(); res.json(await runNextTrial({ force: true })); } catch (e) { next(e); } });
}
