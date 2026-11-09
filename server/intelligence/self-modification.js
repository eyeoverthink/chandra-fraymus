/**
 * Self-Modification Kernel (SMK) — Phase Y.
 *
 * Until now every "self-improvement" loop in this organism produced text about itself:
 * Ouroboros ran 187 cycles and "accepted" 395 code proposals with 0 implemented, the
 * verifier never passed, prompts evolved but the machine that runs them never moved.
 * This module is the part that touches the system and is held to account for it.
 *
 * Two tiers, deliberately different in autonomy:
 *
 *  TIER A — parameter experiments (autonomous, bounded, reversible)
 *    One experiment at a time: pick a live tunable (tunables.js REGISTRY), move it inside
 *    its bounds with a stated hypothesis, measure the same objective over the window
 *    BEFORE the change and the window AFTER it, keep if not worse, revert otherwise.
 *    The objective is computed from the DB only (goal quality, metacognitive effectiveness,
 *    run error rate, goal throughput) so both windows are measured identically.
 *    Proposers: deterministic rules first (cited, cheap), an LLM proposer second (at most
 *    one call per 2 h, `background` priority). OPEG gates the apply; the kernel owns the
 *    keep/revert. Adopted values persist (tunables table) — a restart does not undo learning.
 *
 *  TIER B — code changes (autonomous build, HUMAN merge)
 *    Take a concrete proposal (Ouroboros backlog, operator, an agent), have a coding model
 *    rewrite ONE existing file in a fresh git worktree on branch rsi/<id>, run `node --check`
 *    and the test files that reference the target, compare failures against master when
 *    needed, commit only if green, and leave the branch for review. The kernel never merges
 *    on its own: POST …/code/:id/approve is the operator's. Rejected or red builds delete
 *    their branch so nothing accumulates. A bounded ready-backlog (SMK_MAX_READY) is the
 *    consumer gate — no unreviewed pile.
 *
 * Self-audit asks of every autonomous action: does it dedup (same tunable not re-tested
 * for 24 h; same Ouroboros proposal built once), does it have a consumer (tier A consumes
 * itself via keep/revert; tier B's consumer is the operator, and the backlog cap stops
 * producing when they are not consuming), does it leave rows transient on crash (boot
 * evaluates or aborts anything left 'running'/'building').
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, lstatSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative, basename, dirname, extname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { builtinModules } from 'node:module';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { REGISTRY, TUNABLE_NAMES, tunable, setTunable, listTunables } from './tunables.js';
import { runPipeline as opegPipeline } from './opeg.js';
import { isActionSuppressed } from './adaptive-strategy.js';
import { isResourceConstrained } from './resource-envelope.js';
import { getOpenFindingCounts } from './self-audit.js';
import { scanConventions, nextConventionCandidate, markFinding, getConventionStatus, listConventionFindings } from './convention-scan.js';

const BOOT_AT = Date.now();   // code merged before this boot is live now; merged after it is not

const now = () => Date.now();
const MIN = 60_000, H = 3_600_000;
const REPO_ROOT = resolve(process.cwd());
const DATA_DIR = process.env.CHANDRA_DATA_DIR || join(REPO_ROOT, 'data');
const SMK_DIR = join(DATA_DIR, 'smk');

// ─── Config (env) ────────────────────────────────────────────────
const ENABLED = process.env.SMK_ENABLED !== '0';
const WINDOW_MS = Math.max(5 * MIN, parseInt(process.env.SMK_WINDOW_MS, 10) || 60 * MIN);          // measure this long before and after
const EXPERIMENT_GAP_MS = Math.max(MIN, parseInt(process.env.SMK_EXPERIMENT_GAP_MS, 10) || 30 * MIN); // rest between experiments
const RETEST_MS = Math.max(H, parseInt(process.env.SMK_RETEST_MS, 10) || 24 * H);                   // same tunable not re-tested sooner
const TOLERANCE = Math.max(0, parseFloat(process.env.SMK_TOLERANCE) || 0.02);                       // keep if objective fell by less than this
const LLM_PROPOSE_EVERY_MS = Math.max(15 * MIN, parseInt(process.env.SMK_LLM_EVERY_MS, 10) || 2 * H);
const MIN_COVERAGE = 0.5;                                                                            // objective terms with data must weigh ≥ this
const EXPECTED_GOALS_PER_HOUR = 6;
const CODE_MODEL = process.env.SMK_CODE_MODEL || 'qwen2.5-coder:7b';
const MAX_READY = Math.max(1, parseInt(process.env.SMK_MAX_READY, 10) || 3);
const MAX_BUILDS_PER_DAY = Math.max(1, parseInt(process.env.SMK_MAX_BUILDS_PER_DAY, 10) || 6);
const MAX_TARGET_LINES = Math.max(100, parseInt(process.env.SMK_MAX_TARGET_LINES, 10) || 600);
const TEST_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.SMK_TEST_TIMEOUT_MS, 10) || 240_000);
const OUROBOROS_BACKLOG_MAX = Math.max(5, parseInt(process.env.SMK_OUROBOROS_BACKLOG_MAX, 10) || 50);
const ALLOWED_ROOTS = ['server', 'client/src', 'scripts'];
const DENIED = new Set(['server/db.js', 'server/db-migrate.js', 'server/config.js', 'server/index.js', 'server/app.js', 'server/runtime.js', 'server/lifecycle.js', 'server/local-http.js', 'server/mcp/auth.js', 'server/data-lock.js', 'server/intelligence/self-modification.js', 'server/intelligence/tunables.js', 'server/intelligence/opeg.js']);

// ─── Schema ──────────────────────────────────────────────────────
function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS smk_experiments (
    id TEXT PRIMARY KEY,
    tunable TEXT NOT NULL,
    before_value REAL NOT NULL,
    after_value REAL NOT NULL,
    hypothesis TEXT,
    source TEXT,
    rule TEXT,
    window_ms INTEGER NOT NULL,
    baseline TEXT,
    post TEXT,
    baseline_blocking INTEGER DEFAULT 0,
    verdict TEXT NOT NULL DEFAULT 'running',
    delta REAL,
    reason TEXT,
    opeg_id TEXT,
    started_at INTEGER NOT NULL,
    evaluated_at INTEGER
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_smk_exp_verdict ON smk_experiments(verdict)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_smk_exp_tunable ON smk_experiments(tunable, started_at)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS smk_code_proposals (
    id TEXT PRIMARY KEY,
    source TEXT,
    origin_id TEXT,
    title TEXT NOT NULL,
    target_file TEXT NOT NULL,
    sketch TEXT,
    rationale TEXT,
    model TEXT,
    branch TEXT,
    status TEXT NOT NULL DEFAULT 'building',
    check_passed INTEGER,
    tests_selected INTEGER DEFAULT 0,
    tests_passed INTEGER,
    test_output TEXT,
    diff_stat TEXT,
    lines_before INTEGER,
    lines_after INTEGER,
    failure TEXT,
    merge_sha TEXT,
    decided_by TEXT,
    opeg_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_smk_code_status ON smk_code_proposals(status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_smk_code_origin ON smk_code_proposals(origin_id)`).run();
  // Phase Z columns (additive; ignore "duplicate column" on existing DBs)
  for (const col of ['mode TEXT', 'span_start INTEGER', 'span_end INTEGER', 'summary TEXT', 'outcome_delta REAL', 'outcome_at INTEGER']) {
    try { db.prepare(`ALTER TABLE smk_code_proposals ADD COLUMN ${col}`).run(); } catch (_) {}
  }
}
try { ensureTables(); } catch (e) { console.error('[smk] schema:', e.message); }

const q1 = (s, ...p) => { try { return db.prepare(s).get(...p); } catch (e) { return { _error: e.message }; } };
const qa = (s, ...p) => { try { return db.prepare(s).all(...p); } catch (e) { return []; } };
const safeJson = (s, d = null) => { try { return JSON.parse(s); } catch { return d; } };
const round = (x, n = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);

const state = {
  enabled: ENABLED,
  running: false,
  timer: null,
  cycles: 0,
  lastCycleAt: 0,
  lastCycle: null,
  lastLlmProposeAt: 0,
  llmProposals: 0,
  llmDeclined: 0,
  ruleProposals: 0,
  skipped: {},
  builds: 0,
  lastBuild: null,
  building: false,
};
const skip = (reason) => { state.skipped[reason] = (state.skipped[reason] || 0) + 1; return { acted: false, reason }; };

// ─── Objective: the same measurement over any window ─────────────
export function windowMetrics(from, to) {
  const hours = Math.max(0.01, (to - from) / H);
  const ge = q1(`SELECT COUNT(*) AS n, AVG(quality) AS q, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done
                 FROM goal_executions WHERE finished_at > ? AND finished_at <= ? AND quality IS NOT NULL`, from, to) || {};
  const runs = q1(`SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('error','failed') THEN 1 ELSE 0 END) AS err
                   FROM runs WHERE created_at > ? AND created_at <= ?`, from, to) || {};
  const mc = q1(`SELECT AVG(effectiveness) AS e, COUNT(*) AS n FROM metacognitive_events WHERE created_at > ? AND created_at <= ?`, from, to) || {};
  const drops = q1(`SELECT COUNT(*) AS n FROM bus_messages WHERE topic = 'system.ollama.dropped' AND created_at > ? AND created_at <= ?`, from, to)?.n || 0;
  const refl = q1(`SELECT COUNT(*) AS n FROM reflections WHERE created_at > ? AND created_at <= ?`, from, to)?.n || 0;

  const terms = [];
  if (ge.n > 0) terms.push({ k: 'goalQuality', w: 0.35, v: ge.q });
  if (mc.n > 0) terms.push({ k: 'effectiveness', w: 0.30, v: mc.e });
  if (runs.n > 0) terms.push({ k: 'runSuccess', w: 0.20, v: 1 - (runs.err || 0) / runs.n });
  if (ge.n > 0 || runs.n > 0) terms.push({ k: 'goalThroughput', w: 0.15, v: Math.min(1, (ge.done || 0) / (hours * EXPECTED_GOALS_PER_HOUR)) });
  const coverage = terms.reduce((s, t) => s + t.w, 0);
  const objective = coverage > 0 ? terms.reduce((s, t) => s + t.w * t.v, 0) / coverage : null;
  return {
    from, to, hours: round(hours, 2),
    goalQuality: round(ge.q), goalsScored: ge.n || 0, goalsDone: ge.done || 0,
    effectiveness: round(mc.e), metacogSamples: mc.n || 0,
    runs: runs.n || 0, runErrors: runs.err || 0, runErrorRate: runs.n ? round((runs.err || 0) / runs.n) : null,
    schedulerDrops: drops, reflections: refl,
    coverage: round(coverage, 2), objective: round(objective, 4),
  };
}

// ─── Tier A: experiments ─────────────────────────────────────────
export function runningExperiment() {
  return q1(`SELECT * FROM smk_experiments WHERE verdict = 'running' ORDER BY started_at DESC LIMIT 1`) || null;
}
function hydrate(row) {
  if (!row || row._error) return row;
  return { ...row, baseline: safeJson(row.baseline), post: safeJson(row.post) };
}
export function listExperiments({ limit = 30 } = {}) {
  return qa(`SELECT * FROM smk_experiments ORDER BY started_at DESC LIMIT ?`, Math.min(200, Math.max(1, limit))).map(hydrate);
}
export function getExperiment(id) { return hydrate(q1(`SELECT * FROM smk_experiments WHERE id = ?`, id)); }

function recentlyTested(name) {
  return q1(`SELECT id, verdict, started_at FROM smk_experiments WHERE tunable = ? AND started_at > ? ORDER BY started_at DESC LIMIT 1`, name, now() - RETEST_MS) || null;
}

/**
 * Start one bounded experiment. Returns { started, id } or { started:false, reason }.
 */
export async function startExperiment({ tunable: name, value, hypothesis, source = 'manual', rule = null, windowMs = WINDOW_MS, force = false } = {}) {
  if (!ENABLED) return { started: false, reason: 'disabled' };
  if (!REGISTRY[name]) return { started: false, reason: 'unknown_tunable', known: TUNABLE_NAMES };
  const v = parseFloat(value);
  if (!Number.isFinite(v)) return { started: false, reason: 'value_not_numeric' };
  const r = REGISTRY[name];
  const target = Math.min(r.max, Math.max(r.min, v));
  const before = tunable(name);
  if (target === before) return { started: false, reason: 'no_change', value: before };
  if (runningExperiment()) return { started: false, reason: 'experiment_in_progress' };
  if (!force) {
    const recent = recentlyTested(name);
    if (recent) return { started: false, reason: 'recently_tested', lastVerdict: recent.verdict, lastAt: recent.started_at };
    const last = q1(`SELECT evaluated_at FROM smk_experiments WHERE evaluated_at IS NOT NULL ORDER BY evaluated_at DESC LIMIT 1`);
    if (last?.evaluated_at && now() - last.evaluated_at < EXPERIMENT_GAP_MS) return { started: false, reason: 'cooldown', nextInMs: EXPERIMENT_GAP_MS - (now() - last.evaluated_at) };
  }
  const t = now();
  const baseline = windowMetrics(t - windowMs, t);
  if ((baseline.coverage || 0) < MIN_COVERAGE) return { started: false, reason: 'baseline_too_thin', coverage: baseline.coverage };
  const id = 'exp_' + randomUUID().slice(0, 10);
  const blocking = getOpenFindingCounts().blocking || 0;

  // OPEG gates the apply (fail closed on new alerts); the kernel owns keep/revert after the window.
  const opeg = await opegPipeline({
    type: 'tune_parameter',
    hypothesis: `${name}: ${before} → ${target}. ${hypothesis || ''}`.slice(0, 500),
    params: { tunable: name, before, after: target, windowMs, experimentId: id },
    source: `smk:${source}`,
    executeFn: async () => {
      const set = setTunable(name, target, { source: `smk:${id}` });
      return set.ok ? { applied: true, tunable: name, before, after: set.after } : { applied: false, error: set.error };
    },
  });
  if (!opeg.approved) {
    // apply happened inside executeFn; OPEG rejected on sanity → put it back now
    setTunable(name, before, { source: `smk:${id}:opeg_reject` });
    db.prepare(`INSERT INTO smk_experiments (id, tunable, before_value, after_value, hypothesis, source, rule, window_ms, baseline, baseline_blocking, verdict, reason, opeg_id, started_at, evaluated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aborted', ?, ?, ?, ?)`)
      .run(id, name, before, target, hypothesis || null, source, rule, windowMs, JSON.stringify(baseline), blocking, `opeg: ${opeg.verdict?.reason || 'rejected'}`, opeg.proposalId || null, t, now());
    return { started: false, reason: 'opeg_rejected', id, opeg: opeg.verdict };
  }
  db.prepare(`INSERT INTO smk_experiments (id, tunable, before_value, after_value, hypothesis, source, rule, window_ms, baseline, baseline_blocking, verdict, opeg_id, started_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
    .run(id, name, before, target, hypothesis || null, source, rule, windowMs, JSON.stringify(baseline), blocking, opeg.proposalId || null, t);
  publish('smk', 'system.self_modification', JSON.stringify({ action: 'experiment_started', id, tunable: name, before, after: target, hypothesis, source, rule, windowMs, baselineObjective: baseline.objective }));
  return { started: true, id, tunable: name, before, after: target, windowMs, baseline, evaluateAt: t + windowMs };
}

/**
 * Evaluate the running (or a given) experiment once its window has elapsed.
 * keep: objective did not fall by more than TOLERANCE and no new BLOCKING finding.
 */
export function evaluateExperiment(id = null, { force = false } = {}) {
  const row = id ? q1(`SELECT * FROM smk_experiments WHERE id = ?`, id) : runningExperiment();
  if (!row || row._error) return { evaluated: false, reason: 'not_found' };
  if (row.verdict !== 'running') return { evaluated: false, reason: 'already_decided', verdict: row.verdict };
  const due = row.started_at + row.window_ms;
  if (now() < due && !force) return { evaluated: false, reason: 'window_open', remainingMs: due - now() };
  const to = Math.min(now(), force ? now() : due);
  const post = windowMetrics(row.started_at, to);
  const baseline = safeJson(row.baseline) || {};
  const blocking = getOpenFindingCounts().blocking || 0;
  let verdict, reason, delta = null;
  if (post.objective == null || baseline.objective == null || (post.coverage || 0) < MIN_COVERAGE) {
    verdict = 'inconclusive'; reason = `not enough data in the after-window (coverage ${post.coverage ?? 0})`;
  } else {
    delta = round(post.objective - baseline.objective, 4);
    if (blocking > (row.baseline_blocking || 0)) { verdict = 'reverted'; reason = `blocking findings rose ${row.baseline_blocking} → ${blocking}`; }
    else if (delta >= -TOLERANCE) { verdict = 'kept'; reason = delta >= 0 ? `objective improved ${baseline.objective} → ${post.objective}` : `objective held within tolerance (${delta})`; }
    else { verdict = 'reverted'; reason = `objective fell ${baseline.objective} → ${post.objective}`; }
  }
  if (verdict !== 'kept') setTunable(row.tunable, row.before_value, { source: `smk:${row.id}:${verdict}` });
  db.prepare(`UPDATE smk_experiments SET verdict = ?, reason = ?, delta = ?, post = ?, evaluated_at = ? WHERE id = ?`)
    .run(verdict, reason, delta, JSON.stringify(post), now(), row.id);
  const text = `[SMK ${verdict}] ${row.tunable} ${row.before_value} → ${row.after_value} (${row.rule || row.source}): ${reason}. Hypothesis: ${row.hypothesis || 'n/a'}`;
  try { storeMemory('system', 'outcome', `smk:${row.id}`, text.slice(0, 1200), { confidence: verdict === 'inconclusive' ? 0.5 : 0.9, source: 'smk' }); } catch (e) { console.error('[smk] memory:', e.message); }
  publish('smk', 'system.self_modification', JSON.stringify({ action: 'experiment_evaluated', id: row.id, tunable: row.tunable, before: row.before_value, after: row.after_value, verdict, delta, reason, baselineObjective: baseline.objective, postObjective: post.objective }));
  return { evaluated: true, id: row.id, tunable: row.tunable, verdict, delta, reason, baseline, post };
}

// ─── Proposers ───────────────────────────────────────────────────
function stepTo(name, target) {
  const r = REGISTRY[name];
  const v = Math.round(target / r.step) * r.step;
  return Math.min(r.max, Math.max(r.min, v));
}

/** Deterministic, cited rules. Each returns at most one proposal; first applicable wins. */
export function ruleProposals() {
  const t = now();
  const last1h = windowMetrics(t - H, t);
  const last2h = windowMetrics(t - 2 * H, t);
  const out = [];
  const cur = Object.fromEntries(TUNABLE_NAMES.map(n => [n, tunable(n)]));

  if (last1h.schedulerDrops >= 20 && cur['ollama.max_concurrent'] < REGISTRY['ollama.max_concurrent'].max && (last1h.runErrorRate ?? 0) < 0.2)
    out.push({ tunable: 'ollama.max_concurrent', value: stepTo('ollama.max_concurrent', cur['ollama.max_concurrent'] + 1), rule: 'drops_low_errors',
      hypothesis: `${last1h.schedulerDrops} jobs dropped in the last hour while run errors were ${Math.round((last1h.runErrorRate ?? 0) * 100)}%: one more inference slot should clear the queue without thrash` });
  if ((last1h.runErrorRate ?? 0) >= 0.35 && last1h.runs >= 6 && cur['ollama.max_concurrent'] > REGISTRY['ollama.max_concurrent'].min)
    out.push({ tunable: 'ollama.max_concurrent', value: stepTo('ollama.max_concurrent', cur['ollama.max_concurrent'] - 1), rule: 'high_errors',
      hypothesis: `${Math.round(last1h.runErrorRate * 100)}% of ${last1h.runs} runs errored in the last hour: fewer concurrent inferences should cut timeouts` });
  if (last2h.reflections === 0 && (last2h.effectiveness ?? 0) >= 0.6 && cur['reflection.min_interval_ms'] > REGISTRY['reflection.min_interval_ms'].min)
    out.push({ tunable: 'reflection.min_interval_ms', value: stepTo('reflection.min_interval_ms', cur['reflection.min_interval_ms'] * 0.75), rule: 'quiet_and_effective',
      hypothesis: `no reflection in 2 h while effectiveness is ${last2h.effectiveness}: a shorter floor lets the organism reflect while it is doing well` });
  if (last1h.reflections >= 5 && (last1h.effectiveness ?? 1) < 0.4)
    out.push({ tunable: 'reflection.min_interval_ms', value: stepTo('reflection.min_interval_ms', cur['reflection.min_interval_ms'] * 1.5), rule: 'reflecting_not_improving',
      hypothesis: `${last1h.reflections} reflections in the last hour with effectiveness ${last1h.effectiveness}: reflecting more is not helping, spend the GPU on execution` });
  const motorReflect = q1(`SELECT COUNT(*) AS n FROM motor_output_events WHERE region = 'reflect' AND created_at > ?`, t - H)?.n || 0;
  if (motorReflect >= 4)
    out.push({ tunable: 'motor.reflect_min_ms', value: stepTo('motor.reflect_min_ms', cur['motor.reflect_min_ms'] * 1.5), rule: 'motor_reflect_storm',
      hypothesis: `motor Reflect fired ${motorReflect}× in the last hour: raise its floor` });
  const pending = q1(`SELECT COUNT(*) AS n FROM goal_proposals WHERE status = 'proposed'`)?.n || 0;
  if (pending < 3 && (last2h.goalQuality ?? 0) >= 0.5 && cur['goals.max_pending'] < REGISTRY['goals.max_pending'].max)
    out.push({ tunable: 'goals.max_pending', value: stepTo('goals.max_pending', cur['goals.max_pending'] + 4), rule: 'queue_starved',
      hypothesis: `only ${pending} goals pending and recent quality is ${last2h.goalQuality}: let generation keep a deeper queue` });
  const poorForged = q1(`SELECT COUNT(*) AS n FROM (SELECT e.agent_id, AVG(e.quality) AS q, COUNT(*) AS c FROM goal_executions e JOIN forged_agents f ON f.agent_id = e.agent_id
                         WHERE e.quality IS NOT NULL AND e.finished_at > ? GROUP BY e.agent_id HAVING c >= 5 AND q < 0.3)`, t - 7 * 24 * H)?.n || 0;
  const retired7d = q1(`SELECT COUNT(*) AS n FROM agent_retirements WHERE retired_at > ?`, t - 7 * 24 * H)?.n || 0;
  if (poorForged >= 2 && retired7d === 0 && cur['agent.retire_threshold'] < REGISTRY['agent.retire_threshold'].max)
    out.push({ tunable: 'agent.retire_threshold', value: stepTo('agent.retire_threshold', cur['agent.retire_threshold'] + 0.05), rule: 'poor_agents_unretired',
      hypothesis: `${poorForged} forged agents average under 0.3 over ≥ 5 outcomes and none were retired this week: raise the bar` });

  return out.filter(p => p.value !== cur[p.tunable]);
}

const LLM_PROMPT = `You are the Self-Modification Kernel of Chandra-FRAYMUS, a local autonomous system. You may propose ONE change to ONE live tunable, inside its bounds, with a falsifiable hypothesis. The change will be applied for a fixed window and kept only if the objective (goal quality 0.35, metacognitive effectiveness 0.30, run success 0.20, goal throughput 0.15) does not fall. Prefer no change over a speculative one.
Return ONLY JSON: {"tunable": "<name>", "value": <number>, "hypothesis": "<one sentence stating the mechanism and the metric you expect to move>"} or {"none": true, "reason": "<why nothing should change now>"}.`;

export async function llmProposal() {
  const t = now();
  const summary = {
    tunables: listTunables().map(x => ({ name: x.name, value: x.value, min: x.min, max: x.max, unit: x.unit, effect: x.effect })),
    lastHour: windowMetrics(t - H, t),
    last6h: windowMetrics(t - 6 * H, t),
    recentExperiments: listExperiments({ limit: 8 }).map(e => ({ tunable: e.tunable, before: e.before_value, after: e.after_value, verdict: e.verdict, delta: e.delta, rule: e.rule })),
    openFindings: getOpenFindingCounts(),
  };
  const raw = await chatOllama([
    { role: 'system', content: LLM_PROMPT },
    { role: 'user', content: JSON.stringify(summary) },
  ], { priority: 'background', label: 'smk:propose', format: 'json', temperature: 0.2 });
  const j = parseJSON(raw) || {};
  state.lastLlmProposeAt = t;
  if (j.none || !j.tunable) { state.llmDeclined++; return null; }
  if (!REGISTRY[j.tunable]) return null;
  const v = parseFloat(j.value);
  if (!Number.isFinite(v)) return null;
  state.llmProposals++;
  return { tunable: j.tunable, value: stepTo(j.tunable, v), hypothesis: String(j.hypothesis || '').slice(0, 400), rule: 'llm' };
}

/** One kernel cycle: evaluate a due experiment, else propose and start one. */
export async function selfModificationCycle({ trigger = 'timer' } = {}) {
  state.cycles++; state.lastCycleAt = now();
  const result = { trigger, at: now() };
  if (!ENABLED) return Object.assign(result, skip('disabled'));
  const running = runningExperiment();
  if (running) {
    const ev = evaluateExperiment(running.id);
    result.evaluation = ev;
    if (!ev.evaluated) return Object.assign(result, { acted: false, reason: 'experiment_running', remainingMs: ev.remainingMs });
    state.lastCycle = result;
    return Object.assign(result, { acted: true });
  }
  if (isActionSuppressed('self_modify')) return Object.assign(result, skip('suppressed_by_strategy'));
  if (isResourceConstrained()) return Object.assign(result, skip('resource_constrained'));
  const last = q1(`SELECT evaluated_at FROM smk_experiments WHERE evaluated_at IS NOT NULL ORDER BY evaluated_at DESC LIMIT 1`);
  if (last?.evaluated_at && now() - last.evaluated_at < EXPERIMENT_GAP_MS) return Object.assign(result, skip('cooldown'));

  let proposals = ruleProposals().filter(p => !recentlyTested(p.tunable));
  if (proposals.length) state.ruleProposals++;
  if (!proposals.length && now() - state.lastLlmProposeAt >= LLM_PROPOSE_EVERY_MS) {
    try {
      const p = await llmProposal();
      if (p && !recentlyTested(p.tunable)) proposals = [p];
    } catch (e) { result.llmError = e.message; }
  }
  if (!proposals.length) return Object.assign(result, skip('nothing_to_propose'));
  const p = proposals[0];
  const started = await startExperiment({ ...p, source: trigger });
  result.started = started;
  state.lastCycle = result;
  return Object.assign(result, { acted: !!started.started, reason: started.started ? undefined : started.reason });
}

// ─── Tier B: code proposals ──────────────────────────────────────
function git(args, { cwd = REPO_ROOT, timeout = 120_000 } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const BUILTINS = new Set(builtinModules.flatMap(m => [m, 'node:' + m]));
function importSpecifiers(code) {
  const set = new Set();
  for (const m of String(code).matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*)['"]([^'"]+)['"]/g)) set.add(m[1]);
  return set;
}
function exportNames(code) {
  const set = new Set();
  for (const m of String(code).matchAll(/^export\s+(?:default\s+|async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) set.add(m[1]);
  for (const m of String(code).matchAll(/^export\s*\{([^}]+)\}/gm)) for (const n of m[1].split(',')) { const nm = n.trim().split(/\s+as\s+/).pop(); if (nm) set.add(nm); }
  if (/^export\s+default\b/m.test(code)) set.add('default');
  return set;
}
function resolveTarget(file) {
  const cands = [file, 'server/' + file, 'server/intelligence/' + file, 'client/src/' + file].map(f => f.replace(/\\/g, '/').replace(/^\.\//, ''));
  for (const c of cands) {
    const abs = resolve(REPO_ROOT, c);
    if (!abs.startsWith(REPO_ROOT + sep)) continue;
    const rel = relative(REPO_ROOT, abs).replace(/\\/g, '/');
    if (!ALLOWED_ROOTS.some(r => rel === r || rel.startsWith(r + '/'))) continue;
    if (DENIED.has(rel)) return { error: `refused: ${rel} is a protected file` };
    if (existsSync(abs) && statSync(abs).isFile()) return { abs, rel };
  }
  return { error: `target not found under ${ALLOWED_ROOTS.join(', ')}: ${file}` };
}
// Generic stems ("routes", "index", "tools") match half the test suite by accident; require the
// path (or parent/stem) for those, and allow a bare distinctive stem otherwise.
const GENERIC_STEMS = new Set(['routes', 'index', 'tools', 'shared', 'engine', 'utils', 'types', 'schema', 'service', 'runtime', 'config', 'server', 'client']);
function selectTests(rel) {
  const dir = join(REPO_ROOT, 'test');
  if (!existsSync(dir)) return [];
  const stem = basename(rel, extname(rel));
  const parentStem = `${dirname(rel).split('/').pop()}/${stem}`;
  const distinctive = stem.length >= 6 && !GENERIC_STEMS.has(stem);
  const picks = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.test.js')) continue;
    let src = '';
    try { src = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    if (src.includes(rel) || src.includes(parentStem) || (distinctive && src.includes(stem))) picks.push('test/' + f);
  }
  return picks;
}
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
function runTests(cwd, files) {
  if (!files.length) return { ran: 0, passed: true, failing: [], output: '(no test file references the target — syntax check only)' };
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd, encoding: 'utf8', timeout: TEST_TIMEOUT_MS, windowsHide: true, env: { ...process.env, CHANDRA_DATA_DIR: join(cwd, 'data-smk'), PORT: '0', NO_COLOR: '1', FORCE_COLOR: '0' } });
  const output = stripAnsi(((r.stdout || '') + '\n' + (r.stderr || '')).trim());
  const failing = [...output.matchAll(/^\s*(?:✖|not ok \d+ -)\s*(.+)$/gm)].map(m => m[1].replace(/\s*\([\d.]+ms\)\s*$/, '').trim()).filter(l => !/^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)/.test(l));
  return { ran: files.length, passed: r.status === 0, failing, timedOut: r.signal === 'SIGTERM', output: output.slice(-6000) };
}
// Worktrees live INSIDE the repo tree (data/smk/wt/<id>), so Node resolves `node_modules`
// upward to the repo's own install — no link of any kind is created. The first version put
// a `node_modules` junction in the worktree; `git worktree remove --force` on Windows walked
// through it and emptied the real node_modules/.bin before aborting on a locked native
// binary (2026-11-09). Never link into the worktree; and defensively unlink anything that
// looks like one before git touches the directory.
function makeWorktree(path, branch, base = 'master') {
  mkdirSync(dirname(path), { recursive: true });
  // Many tests mkdtemp inside `new URL('../../work/', import.meta.url)` — i.e. a `work` dir beside
  // the checkout (F:/Fraymus-Skill-Lab/work for the repo). For a worktree at data/smk/wt/<id> that
  // resolves to data/smk/wt/work, so keep that scratch parent present (it is gitignored under data/).
  mkdirSync(join(dirname(path), 'work'), { recursive: true });
  return branch ? git(['worktree', 'add', '-b', branch, path, base]) : git(['worktree', 'add', '--detach', path, base]);
}
function unlinkIfLink(p) {
  try { const st = lstatSync(p); if (st.isSymbolicLink()) { rmSync(p, { recursive: false, force: true }); return true; } } catch {}
  return false;
}
function dropWorktree(path, branch = null) {
  if (existsSync(path)) {
    unlinkIfLink(join(path, 'node_modules'));
    unlinkIfLink(join(path, 'client', 'node_modules'));
    git(['worktree', 'remove', '--force', path]);
    try { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); } catch {}
  }
  git(['worktree', 'prune']);
  if (branch) git(['branch', '-D', branch]);
}
const extractCode = (raw) => {
  const m = String(raw).match(/```(?:javascript|js|jsx|mjs|ts|tsx)?\s*\n([\s\S]*?)```/);
  if (m) return m[1];
  const s = String(raw).trim();
  return /^(import|export|\/\*|\/\/|'use strict'|const|let|function|class|async|static|\w+\s*\()/.test(s) ? s : null;
};

// ─── Function-level spans (Phase Z) ───────────────────────────────
// A 7B model rewrites a 40-line function reliably and a 700-line file unreliably. Given a
// line of interest, find the smallest enclosing function / method / arrow body: scan upward
// for a declaration start, brace-match forward (string- and comment-aware), keep the innermost
// span that contains the line and fits MAX_SPAN_LINES; widen once; else the whole file.
const WHOLE_FILE_MAX = Math.max(50, parseInt(process.env.SMK_WHOLE_FILE_MAX, 10) || 300);
const MAX_SPAN_LINES = Math.max(20, parseInt(process.env.SMK_MAX_SPAN_LINES, 10) || 160);
const DECL_START = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*\w*\s*\(|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{|(?:static\s+)?(?:async\s+)?\*?(?!(?:if|for|while|switch|catch|with|return|else|do|try|function)\b)\w+\s*\([^)]*\)\s*\{\s*$|\w+\s*:\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{\s*$|\w+\.(?:get|post|put|delete|patch|use|all)\([^,]+,\s*(?:\w+\()?\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$)/;
function matchBraces(lines, startLine) {
  // returns the 0-based line index where the brace opened on/after startLine closes, or -1
  let depth = 0, opened = false, inStr = null, inBlock = false;
  for (let i = startLine; i < lines.length; i++) {
    const s = lines[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j], n = s[j + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; j++; } continue; }
      if (inStr) { if (c === '\\') { j++; continue; } if (c === inStr) inStr = null; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; j++; continue; }
      if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
      if (c === '{') { depth++; opened = true; }
      else if (c === '}') { depth--; if (opened && depth === 0) return i; }
    }
  }
  return -1;
}
export function enclosingSpan(code, line1) {
  const lines = code.split('\n');
  const target = Math.min(lines.length, Math.max(1, line1)) - 1;
  const spans = [];
  for (let i = target; i >= 0; i--) {
    if (!DECL_START.test(lines[i])) continue;
    const end = matchBraces(lines, i);
    if (end >= target) spans.push({ start: i, end, lines: end - i + 1 });
    if (spans.length >= 6) break;
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a.lines - b.lines);
  const fit = spans.find(s => s.lines <= MAX_SPAN_LINES) || spans.find(s => s.lines <= MAX_SPAN_LINES * 2.5) || null;
  if (!fit) return null;
  return { start: fit.start + 1, end: fit.end + 1, text: lines.slice(fit.start, fit.end + 1).join('\n'), header: lines.slice(0, Math.min(40, fit.start)).filter(l => /^\s*import\b/.test(l)).join('\n') };
}
function spliceSpan(code, span, replacement) {
  const lines = code.split('\n');
  return [...lines.slice(0, span.start - 1), ...replacement.replace(/\n+$/, '').split('\n'), ...lines.slice(span.end)].join('\n');
}
const declName = (text) => (text.match(/(?:function\s*\*?\s*|(?:const|let|var)\s+|^\s*(?:static\s+)?(?:async\s+)?\*?)(\w+)\s*(?:=|\()/m) || [])[1] || null;

const CODE_SYSTEM = `You are a careful senior engineer modifying ONE file of a Node.js ESM codebase (Express server + SQLite via better-sqlite3). You will receive the proposal and the complete current file. Return the COMPLETE new file content in a single \`\`\`javascript fenced block and nothing else.
Hard constraints:
- keep every existing export (same names); you may add exports
- add NO new third-party dependencies; only imports the file already has or Node built-ins
- no network calls, no file writes outside what the file already does
- implement exactly the proposal; preserve all other behaviour; keep the diff minimal
- no placeholder comments like "// rest unchanged" — the block must be the whole file
If the proposal cannot be implemented safely in this file, return the original file unchanged.`;

const SPAN_SYSTEM = `You are a careful senior engineer fixing ONE function in a Node.js ESM codebase. You will receive the proposal, the file's imports for context, and the exact source of the function (or route handler) to change. Return the COMPLETE replacement for that function only, in a single \`\`\`javascript fenced block, and nothing else.
Hard constraints:
- same function name and signature; it must remain a drop-in replacement for the span you were given
- no import statements in your output; use only identifiers already visible in the file
- no network calls, no new dependencies, no placeholder comments like "// rest unchanged"
- implement exactly the proposal; preserve every other behaviour; keep the diff minimal
- after the code block you may add one line starting with "SUMMARY:" stating what changed`;

const isConvention = (src) => String(src || '').startsWith('convention');

export async function buildCodeProposal({ source = 'manual', originId = null, title, targetFile, line = null, sketch = '', rationale = '', model = CODE_MODEL } = {}) {
  if (!ENABLED) return { built: false, reason: 'disabled' };
  if (!title || !targetFile) return { built: false, reason: 'title_and_targetFile_required' };
  if (state.building) return { built: false, reason: 'build_in_progress' };
  const tgt = resolveTarget(targetFile);
  if (tgt.error) return { built: false, reason: tgt.error };
  const original = readFileSync(tgt.abs, 'utf8');
  const linesBefore = original.split('\n').length;
  // Span mode (Phase Z): a line of interest → patch only its enclosing function. Whole-file mode stays for small files.
  let span = null;
  const wantSpan = Number.isInteger(Number(line)) && Number(line) > 0;
  if (wantSpan) {
    span = enclosingSpan(original, Number(line));
    if (!span && linesBefore > WHOLE_FILE_MAX) return { built: false, reason: `no patchable function around line ${line} and the file is ${linesBefore} lines` };
  } else if (linesBefore > WHOLE_FILE_MAX) {
    return { built: false, reason: `target has ${linesBefore} lines (> ${WHOLE_FILE_MAX}); pass a line to patch one function` };
  }
  const mode = span ? 'span' : 'file';
  // an origin counts as built unless its only attempts died of infrastructure (scheduler drop, model timeout, worktree error)
  if (originId && q1(`SELECT id FROM smk_code_proposals WHERE origin_id = ? AND NOT (status = 'failed' AND (failure LIKE '%scheduler dropped%' OR failure LIKE '%aborted due to timeout%' OR failure LIKE '%worktree:%'))`, originId)?.id) return { built: false, reason: 'origin_already_built' };

  const id = 'code_' + randomUUID().slice(0, 10);
  const branch = `rsi/${id}`;
  const wt = join(SMK_DIR, 'wt', id);
  const t = now();
  state.building = true; state.builds++;
  db.prepare(`INSERT INTO smk_code_proposals (id, source, origin_id, title, target_file, sketch, rationale, model, branch, status, lines_before, mode, span_start, span_end, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', ?, ?, ?, ?, ?, ?)`)
    .run(id, source, originId, String(title).slice(0, 200), tgt.rel, String(sketch).slice(0, 2000), String(rationale).slice(0, 1000), model, branch, linesBefore, mode, span?.start ?? null, span?.end ?? null, t, t);
  if (originId && isConvention(source)) try { markFinding(originId, { status: 'building', proposalId: id }); } catch {}
  const fail = (failure, extra = {}) => {
    db.prepare(`UPDATE smk_code_proposals SET status = 'failed', failure = ?, check_passed = ?, tests_selected = ?, tests_passed = ?, test_output = ?, updated_at = ? WHERE id = ?`)
      .run(String(failure).slice(0, 1000), extra.checkPassed == null ? null : (extra.checkPassed ? 1 : 0), extra.testsSelected || 0, extra.testPassed == null ? null : (extra.testPassed ? 1 : 0), extra.testOutput || null, now(), id);
    dropWorktree(wt, branch);
    // infrastructure failures (scheduler drop, model timeout) are not the finding's fault → clear proposal_id so it is retried; real build failures keep it → never retried blindly
    const infra = /scheduler dropped|aborted due to timeout|worktree:/.test(String(failure));
    if (originId && isConvention(source)) try { markFinding(originId, { status: 'open', clearProposal: infra }); } catch {}
    if (originId && !isConvention(source)) try { db.prepare(`UPDATE ouroboros_proposals SET status = 'needs_revision', review_notes = COALESCE(review_notes,'') || ? WHERE id = ? AND status = 'accepted'`).run(`\n[smk ${id}] build failed: ${String(failure).slice(0, 200)}`, originId); } catch {}
    state.building = false; state.lastBuild = { id, status: 'failed', failure };
    publish('smk', 'system.self_modification', JSON.stringify({ action: 'code_build_failed', id, title, targetFile: tgt.rel, mode, failure: String(failure).slice(0, 300) }));
    return { built: false, id, reason: failure, mode, ...extra };
  };

  try {
    const budget = (chars) => Math.min(12_000, Math.max(768, Math.round(chars / 3.2 * 1.8) + 400));
    const messages = span
      ? [{ role: 'system', content: SPAN_SYSTEM },
         { role: 'user', content: `PROPOSAL: ${title}\n${sketch ? 'Sketch: ' + sketch + '\n' : ''}${rationale ? 'Why: ' + rationale + '\n' : ''}\nFILE ${tgt.rel} — imports for context:\n\`\`\`javascript\n${span.header || '(none)'}\n\`\`\`\n\nFUNCTION TO CHANGE (lines ${span.start}–${span.end}):\n\`\`\`javascript\n${span.text}\n\`\`\`` }]
      : [{ role: 'system', content: CODE_SYSTEM },
         { role: 'user', content: `PROPOSAL: ${title}\n${sketch ? 'Sketch: ' + sketch + '\n' : ''}${rationale ? 'Why: ' + rationale + '\n' : ''}\nFILE ${tgt.rel} (${linesBefore} lines):\n\`\`\`javascript\n${original}\n\`\`\`` }];
    // 'goal' class (3): queued behind interactive/agent/scoring work but never dropped while waiting —
    // the first convention build was dropped by the 'background' class's 60 s max wait with both slots busy.
    const raw = await chatOllama(messages, { model, priority: 'goal', label: `smk:code:${id}`, temperature: 0.1, maxTokens: budget(span ? span.text.length : original.length), timeoutMs: 600_000 });
    const summary = (String(raw).match(/^SUMMARY:\s*(.+)$/m) || [])[1]?.slice(0, 300) || null;
    const piece = extractCode(raw);
    if (!piece || piece.trim().length < (span ? 10 : 40)) return fail('model returned no code block');

    let code;
    if (span) {
      if (piece.trim() === span.text.trim()) return fail('model returned the function unchanged (declined)');
      if (/^\s*import\b/m.test(piece)) return fail('span replacement contains import statements');
      const ratio = piece.length / Math.max(1, span.text.length);
      if (ratio < 0.5 || ratio > 3.0) return fail(`span size ratio ${ratio.toFixed(2)} outside 0.5–3.0`);
      const n0 = declName(span.text), n1 = declName(piece);
      if (n0 && n1 && n0 !== n1) return fail(`function renamed ${n0} → ${n1}`);
      const probe = matchBraces(piece.split('\n'), 0);
      if (probe < 0) return fail('span replacement has unbalanced braces');
      code = spliceSpan(original, span, piece);
    } else {
      code = piece;
      if (code.trim() === original.trim()) return fail('model returned the file unchanged (declined)');
      const ratio = code.length / Math.max(1, original.length);
      if (ratio < 0.5 || ratio > 2.2) return fail(`size ratio ${ratio.toFixed(2)} outside 0.5–2.2 — likely truncated or padded`);
    }
    const linesAfter = code.split('\n').length;
    if (/\/\/\s*\.\.\.\s*(rest|unchanged|remaining)|\/\*\s*\.\.\.\s*\*\//i.test(code)) return fail('model elided part of the file');
    const lostExports = [...exportNames(original)].filter(n => !exportNames(code).has(n));
    if (lostExports.length) return fail(`exports removed: ${lostExports.join(', ')}`);
    const newImports = [...importSpecifiers(code)].filter(s => !importSpecifiers(original).has(s) && !BUILTINS.has(s) && !s.startsWith('.') && !s.startsWith('/'));
    if (newImports.length) return fail(`new third-party imports: ${newImports.join(', ')}`);
    if (summary) db.prepare(`UPDATE smk_code_proposals SET summary = ? WHERE id = ?`).run(summary, id);

    const mk = makeWorktree(wt, branch);
    if (!mk.ok) return fail(`worktree: ${mk.err || mk.out}`);
    writeFileSync(join(wt, tgt.rel), code, 'utf8');
    const chk = spawnSync(process.execPath, ['--check', join(wt, tgt.rel)], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const checkPassed = chk.status === 0;
    if (!checkPassed) return fail(`node --check failed: ${(chk.stderr || '').slice(0, 400)}`, { checkPassed });

    const tests = selectTests(tgt.rel);
    let tr = runTests(wt, tests);
    let compared = null;
    if (tests.length && !tr.passed) {
      // Only blame the change for failures master does not already have.
      const base = join(SMK_DIR, 'wt', id + '-base');
      const mb = makeWorktree(base, null);
      if (mb.ok) {
        const br = runTests(base, tests);
        const baselineFailing = new Set(br.failing);
        const newFailures = tr.failing.filter(f => !baselineFailing.has(f));
        compared = { baselineFailing: br.failing.length, baselinePassed: br.passed, newFailures };
        // rescued when master fails the same way: every named failure also fails on master, and master's run was red too
        const rescued = !tr.timedOut && !br.passed && newFailures.length === 0;
        if (rescued) tr = { ...tr, passed: true, output: tr.output + `\n\n[smk] ${tr.failing.length || 'the'} failure(s) also fail on master (${br.failing.length} named) — not caused by this change` };
      }
      dropWorktree(base);
    }
    if (!tr.passed) return fail(`tests failed${tr.timedOut ? ' (timeout)' : ''}: ${tr.failing.slice(0, 3).join(' | ') || 'see output'}`, { checkPassed, testsSelected: tests.length, testPassed: false, testOutput: tr.output, compared });

    const add = git(['add', '-A'], { cwd: wt });
    const commit = git(['-c', 'user.name=Chandra-FRAYMUS SMK', '-c', 'user.email=smk@chandra.local', 'commit', '-q', '-m', `rsi: ${String(title).slice(0, 72)}\n\nSelf-modification kernel ${id} (${source}${originId ? ', origin ' + originId : ''}).\nTarget: ${tgt.rel}\nTests: ${tests.length ? tests.join(', ') : 'none reference the target (syntax check only)'}\nModel: ${model}\n\nNot merged by the kernel — review and approve via POST /api/intelligence/self-modification/code/${id}/approve.`], { cwd: wt });
    if (!add.ok || !commit.ok) return fail(`commit failed: ${commit.err || add.err}`);
    const stat = git(['diff', '--stat', `master..${branch}`]).out;
    git(['worktree', 'remove', '--force', wt]); git(['worktree', 'prune']);
    db.prepare(`UPDATE smk_code_proposals SET status = 'ready', check_passed = 1, tests_selected = ?, tests_passed = 1, test_output = ?, diff_stat = ?, lines_after = ?, updated_at = ? WHERE id = ?`)
      .run(tests.length, tr.output.slice(-6000), stat.slice(0, 2000), linesAfter, now(), id);
    // OPEG record of the modification (for the audit trail / sanitize checks)
    try {
      const op = await opegPipeline({ type: 'code_change', hypothesis: `${title} (${tgt.rel})`.slice(0, 500), params: { id, branch, targetFile: tgt.rel, tests: tests.length }, source: `smk:${source}`,
        executeFn: async () => ({ ok: true, checkPassed: true, testPassed: true, branch, testsRun: tests.length }) });
      db.prepare(`UPDATE smk_code_proposals SET opeg_id = ? WHERE id = ?`).run(op.proposalId || null, id);
    } catch (e) { console.error('[smk] opeg code_change:', e.message); }
    if (originId && !isConvention(source)) try { db.prepare(`UPDATE ouroboros_proposals SET status = 'implemented', review_notes = COALESCE(review_notes,'') || ? WHERE id = ?`).run(`\n[smk ${id}] built on branch ${branch}, awaiting review`, originId); } catch {}
    if (originId && isConvention(source)) try { markFinding(originId, { status: 'ready', proposalId: id }); } catch {}
    try { storeMemory('system', 'outcome', `smk:${id}`, `[SMK code ready] ${title} → ${tgt.rel}${span ? ` (lines ${span.start}–${span.end})` : ''} on ${branch}; ${tests.length} test file(s) green; awaiting operator approval.`, { confidence: 0.8, source: 'smk' }); } catch {}
    state.building = false; state.lastBuild = { id, status: 'ready', branch, tests: tests.length, mode };
    publish('smk', 'system.self_modification', JSON.stringify({ action: 'code_ready', id, title, targetFile: tgt.rel, branch, mode, tests: tests.length, diffStat: stat.split('\n').pop() }));
    return { built: true, id, branch, targetFile: tgt.rel, mode, span: span ? { start: span.start, end: span.end } : null, summary, tests: tests.length, compared, diffStat: stat, linesBefore, linesAfter };
  } catch (e) {
    return fail(`exception: ${e.message}`);
  }
}

export function listCodeProposals({ status = null, limit = 30 } = {}) {
  return status
    ? qa(`SELECT * FROM smk_code_proposals WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, Math.min(200, limit))
    : qa(`SELECT * FROM smk_code_proposals ORDER BY created_at DESC LIMIT ?`, Math.min(200, limit));
}
export function getCodeProposal(id, { diff = false } = {}) {
  const row = q1(`SELECT * FROM smk_code_proposals WHERE id = ?`, id);
  if (!row || row._error) return null;
  if (diff && row.branch && git(['rev-parse', '--verify', '--quiet', row.branch]).ok) row.diff = git(['diff', `master...${row.branch}`]).out.slice(0, 60_000);
  return row;
}
export function approveCodeProposal(id, { by = 'operator' } = {}) {
  const row = q1(`SELECT * FROM smk_code_proposals WHERE id = ?`, id);
  if (!row || row._error) return { ok: false, error: 'not found' };
  if (row.status !== 'ready') return { ok: false, error: `status is ${row.status}, expected ready` };
  if (!git(['rev-parse', '--verify', '--quiet', row.branch]).ok) return { ok: false, error: `branch ${row.branch} no longer exists` };
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).out;
  if (dirty) return { ok: false, error: 'working tree has uncommitted tracked changes — commit or stash first', dirty: dirty.split('\n').slice(0, 10) };
  const merge = git(['-c', 'user.name=Chandra-FRAYMUS SMK', '-c', 'user.email=smk@chandra.local', 'merge', '--no-ff', '--no-edit', row.branch]);
  if (!merge.ok) { git(['merge', '--abort']); return { ok: false, error: `merge failed: ${(merge.err || merge.out).slice(0, 400)}` }; }
  const sha = git(['rev-parse', 'HEAD']).out;
  db.prepare(`UPDATE smk_code_proposals SET status = 'merged', merge_sha = ?, decided_by = ?, updated_at = ? WHERE id = ?`).run(sha, by, now(), id);
  if (row.origin_id && isConvention(row.source)) try { markFinding(row.origin_id, { status: 'fixed' }); } catch {}
  if (row.origin_id && !isConvention(row.source)) try { db.prepare(`UPDATE ouroboros_proposals SET status = 'implemented', review_notes = COALESCE(review_notes,'') || ? WHERE id = ?`).run(`\n[smk ${id}] merged ${sha.slice(0, 8)}`, row.origin_id); } catch {}
  try { storeMemory('system', 'outcome', `smk:${id}:merged`, `[SMK merged] ${row.title} → ${row.target_file} (${sha.slice(0, 8)}), approved by ${by}. Restart required for the change to run.`, { confidence: 1.0, source: 'smk' }); } catch {}
  publish('smk', 'system.self_modification', JSON.stringify({ action: 'code_merged', id, title: row.title, targetFile: row.target_file, sha, by }));
  return { ok: true, id, sha, restartRequired: true };
}
export function rejectCodeProposal(id, { by = 'operator', reason = '' } = {}) {
  const row = q1(`SELECT * FROM smk_code_proposals WHERE id = ?`, id);
  if (!row || row._error) return { ok: false, error: 'not found' };
  if (!['ready', 'failed'].includes(row.status)) return { ok: false, error: `status is ${row.status}` };
  if (row.branch) git(['branch', '-D', row.branch]);
  db.prepare(`UPDATE smk_code_proposals SET status = 'rejected', decided_by = ?, failure = COALESCE(failure, ?), updated_at = ? WHERE id = ?`).run(by, reason ? `rejected: ${reason}`.slice(0, 500) : null, now(), id);
  if (row.origin_id && isConvention(row.source)) try { markFinding(row.origin_id, { status: 'rejected' }); } catch {}
  if (row.origin_id && !isConvention(row.source)) try { db.prepare(`UPDATE ouroboros_proposals SET status = 'rejected', review_notes = COALESCE(review_notes,'') || ? WHERE id = ?`).run(`\n[smk ${id}] rejected by ${by}${reason ? ': ' + reason.slice(0, 200) : ''}`, row.origin_id); } catch {}
  publish('smk', 'system.self_modification', JSON.stringify({ action: 'code_rejected', id, title: row.title, by }));
  return { ok: true, id };
}

/** Buildable = exists under an allowed root, not protected, within the line cap. */
function buildableTarget(targetFilesJson) {
  const files = safeJson(targetFilesJson, []) || [];
  for (const f of files) {
    const t = resolveTarget(String(f));
    if (!t.abs) continue;
    const lines = readFileSync(t.abs, 'utf8').split('\n').length;
    if (lines <= MAX_TARGET_LINES) return { rel: t.rel, lines };
  }
  return null;
}

// A proposal the code tier can never satisfy by rewriting one source file: it wants a new
// dependency or framework, or it asks for tests (which live in test/, not in the target).
// Measured on the first live pick (2026-11-09): "Add unit tests for agent/workspace.js using
// Jest or Mocha" was the highest-priority buildable candidate.
const UNBUILDABLE_SKETCH = /\b(jest|mocha|vitest|redis|memcached|joi|express-validator|winston|morgan|yup|zod|lodash|axios|npm (?:i|install)|yarn add|new (?:npm )?(?:dependency|package|library)|library like|framework like)\b/i;
function proposalUnbuildable(r, targetRel) {
  const text = `${r.title || ''}\n${r.implementation_sketch || ''}`;
  if (UNBUILDABLE_SKETCH.test(text)) return 'requires a new dependency or framework';
  if (r.category === 'testing' && !/^test\//.test(targetRel) && /\btests?\b/i.test(r.title || '')) return 'asks for tests but targets a source file';
  return null;
}

/** Pick the next Ouroboros proposal whose target actually exists and has not been attempted. */
export function nextOuroborosCandidate() {
  const rows = qa(`SELECT id, title, category, priority, target_files, implementation_sketch, rationale FROM ouroboros_proposals WHERE status = 'accepted'
                   AND id NOT IN (SELECT origin_id FROM smk_code_proposals WHERE origin_id IS NOT NULL)
                   ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT 400`);
  for (const r of rows) {
    const b = buildableTarget(r.target_files);
    if (!b) continue;
    const why = proposalUnbuildable(r, b.rel);
    if (why) {
      // Retire it from the backlog honestly rather than skipping it forever.
      try { db.prepare(`UPDATE ouroboros_proposals SET status = 'rejected', review_notes = COALESCE(review_notes,'') || ? WHERE id = ? AND status = 'accepted'`).run(`\n[smk] rejected: ${why}`, r.id); } catch {}
      backlogCache.at = 0;
      continue;
    }
    return { originId: r.id, title: r.title, targetFile: b.rel, sketch: r.implementation_sketch, rationale: r.rationale, category: r.category, priority: r.priority };
  }
  return null;
}

/** Accepted-backlog breakdown (cached 60 s — it stats files). */
let backlogCache = { at: 0, value: null };
export function ouroborosBacklog() {
  if (now() - backlogCache.at < 60_000 && backlogCache.value) return backlogCache.value;
  const rows = qa(`SELECT id, target_files FROM ouroboros_proposals WHERE status = 'accepted' AND id NOT IN (SELECT origin_id FROM smk_code_proposals WHERE origin_id IS NOT NULL)`);
  let buildable = 0, oversized = 0, missing = 0;
  for (const r of rows) {
    if (buildableTarget(r.target_files)) { buildable++; continue; }
    const files = safeJson(r.target_files, []) || [];
    if (files.some(f => resolveTarget(String(f)).abs)) oversized++; else missing++;
  }
  backlogCache = { at: now(), value: { accepted: rows.length, buildable, oversizedOrProtected: oversized, missingTarget: missing } };
  return backlogCache.value;
}

/** Which proposers earn their keep? Experiments by rule/source, code by source family. */
export function proposerStats() {
  const exp = {};
  for (const r of qa(`SELECT COALESCE(rule, source) AS p, verdict, COUNT(*) AS c FROM smk_experiments WHERE verdict != 'running' GROUP BY p, verdict`)) {
    exp[r.p] = exp[r.p] || { kept: 0, reverted: 0, inconclusive: 0, aborted: 0 };
    exp[r.p][r.verdict] = (exp[r.p][r.verdict] || 0) + r.c;
  }
  for (const v of Object.values(exp)) { const d = v.kept + v.reverted; v.keepRate = d ? round(v.kept / d, 2) : null; }
  const code = {};
  for (const r of qa(`SELECT CASE WHEN source LIKE 'convention%' THEN 'convention' WHEN source LIKE 'ouroboros%' THEN 'ouroboros' WHEN source LIKE 'agent%' THEN 'agent' ELSE 'operator' END AS p, status, COUNT(*) AS c FROM smk_code_proposals GROUP BY p, status`)) {
    code[r.p] = code[r.p] || { ready: 0, failed: 0, merged: 0, rejected: 0, building: 0 };
    code[r.p][r.status] = (code[r.p][r.status] || 0) + r.c;
  }
  for (const v of Object.values(code)) { const built = v.ready + v.merged + v.rejected + v.failed; v.greenRate = built ? round((v.ready + v.merged + v.rejected) / built, 2) : null; v.mergeRate = (v.merged + v.rejected) ? round(v.merged / (v.merged + v.rejected), 2) : null; }
  return { experiments: exp, code };
}

/** Post-merge outcome: code merged before this boot is live now; compare the objective before the merge with the window after boot. */
export function measureMergedOutcomes() {
  const due = qa(`SELECT id, title, updated_at FROM smk_code_proposals WHERE status = 'merged' AND outcome_delta IS NULL AND updated_at < ?`, BOOT_AT);
  const out = [];
  if (now() < BOOT_AT + WINDOW_MS) return out;
  for (const r of due) {
    const before = windowMetrics(r.updated_at - WINDOW_MS, r.updated_at);
    const after = windowMetrics(BOOT_AT, BOOT_AT + WINDOW_MS);
    const delta = before.objective != null && after.objective != null ? round(after.objective - before.objective, 4) : null;
    db.prepare(`UPDATE smk_code_proposals SET outcome_delta = ?, outcome_at = ? WHERE id = ?`).run(delta, now(), r.id);
    publish('smk', 'system.self_modification', JSON.stringify({ action: 'code_outcome', id: r.id, title: r.title, delta, before: before.objective, after: after.objective }));
    out.push({ id: r.id, delta });
  }
  return out;
}

const testIndexCache = { at: 0, files: new Set() };
function fileHasTests(rel) {
  if (now() - testIndexCache.at > 10 * MIN) {
    testIndexCache.files = new Set(); testIndexCache.at = now();
    const dir = join(REPO_ROOT, 'test');
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.test.js')) { try { for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\.\.\/(server\/[\w./-]+\.js)/g)) testIndexCache.files.add(m[1]); } catch {} }
  }
  return testIndexCache.files.has(rel);
}

/** Daemon step: at most one autonomous code build per cycle, bounded by the review backlog. Convention findings first (deterministic, cited), Ouroboros after. */
export async function maybeBuildFromBacklog({ trigger = 'daemon' } = {}) {
  if (!ENABLED) return { built: false, reason: 'disabled' };
  if (state.building) return { built: false, reason: 'build_in_progress' };
  if (isActionSuppressed('self_modify')) return { built: false, reason: 'suppressed_by_strategy' };
  if (isResourceConstrained()) return { built: false, reason: 'resource_constrained' };
  const ready = q1(`SELECT COUNT(*) AS n FROM smk_code_proposals WHERE status = 'ready'`)?.n || 0;
  if (ready >= MAX_READY) return { built: false, reason: 'review_backlog_full', ready, max: MAX_READY };
  const today = q1(`SELECT COUNT(*) AS n FROM smk_code_proposals WHERE created_at > ?`, now() - 24 * H)?.n || 0;
  if (today >= MAX_BUILDS_PER_DAY) return { built: false, reason: 'daily_build_cap', today, max: MAX_BUILDS_PER_DAY };
  const conv = nextConventionCandidate({ preferTested: fileHasTests });
  if (conv) return buildCodeProposal({ source: `convention:${conv.rule}`, originId: conv.key, title: conv.title, targetFile: conv.targetFile, line: conv.line, sketch: conv.sketch, rationale: conv.rationale });
  const cand = nextOuroborosCandidate();
  if (!cand) return { built: false, reason: 'no_buildable_candidate' };
  return buildCodeProposal({ source: `ouroboros:${trigger}`, ...cand });
}

/**
 * Ouroboros may analyse again only when its backlog is being consumed: refused while the
 * kernel still has ≥ OUROBOROS_BACKLOG_MAX buildable proposals waiting, or while the total
 * accepted pile (buildable or not) is ≥ 4× that — a pile nobody can build is still a pile.
 */
export function checkOuroborosAllowed() {
  const b = ouroborosBacklog();
  if (b.buildable >= OUROBOROS_BACKLOG_MAX) return { allowed: false, reason: 'unconsumed_backlog', backlog: b.accepted, ...b, max: OUROBOROS_BACKLOG_MAX };
  if (b.accepted >= 4 * OUROBOROS_BACKLOG_MAX) return { allowed: false, reason: 'unbuildable_pile', backlog: b.accepted, ...b, max: 4 * OUROBOROS_BACKLOG_MAX };
  return { allowed: true, backlog: b.accepted, ...b, max: OUROBOROS_BACKLOG_MAX };
}

// ─── Lifecycle ───────────────────────────────────────────────────
function recoverAtBoot() {
  // experiments left running: evaluate if due (value is still applied — tunables persist), else keep waiting
  const run = runningExperiment();
  if (run && now() >= run.started_at + run.window_ms) { try { evaluateExperiment(run.id); } catch (e) { console.error('[smk] boot evaluate:', e.message); } }
  // builds interrupted by a restart: mark failed and clean their worktrees/branches
  for (const b of qa(`SELECT id, branch FROM smk_code_proposals WHERE status = 'building'`)) {
    db.prepare(`UPDATE smk_code_proposals SET status = 'failed', failure = 'interrupted by restart', updated_at = ? WHERE id = ?`).run(now(), b.id);
    dropWorktree(join(SMK_DIR, 'wt', b.id), b.branch);
    dropWorktree(join(SMK_DIR, 'wt', b.id + '-base'));
  }
}
export function startSelfModification({ intervalMs = 5 * MIN } = {}) {
  if (!ENABLED) return { started: false, reason: 'SMK_ENABLED=0' };
  if (state.running) return { started: false, reason: 'already running' };
  mkdirSync(SMK_DIR, { recursive: true });
  recoverAtBoot();
  state.running = true;
  state.timer = setInterval(() => {
    selfModificationCycle({ trigger: 'timer' }).catch(e => console.error('[smk] cycle:', e.message));
    try { const o = measureMergedOutcomes(); if (o.length) console.log('[smk] merged-code outcomes measured:', JSON.stringify(o)); } catch (e) { console.error('[smk] outcomes:', e.message); }
    try {
      const last = q1(`SELECT created_at FROM smk_convention_scans ORDER BY created_at DESC LIMIT 1`)?.created_at || 0;
      if (now() - last > 24 * H) { const r = scanConventions(); console.log(`[smk] convention scan: ${r.findings} findings (${r.newFindings} new, ${r.resolved} resolved) in ${r.durationMs} ms`); }
    } catch (e) { console.error('[smk] convention scan:', e.message); }
  }, intervalMs);
  // First convention scan shortly after boot (cheap: regex over ~360 files), so the code tier has grounded work from the first cycle.
  setTimeout(() => { try { const r = scanConventions(); console.log(`[smk] convention scan: ${r.findings} findings (${r.newFindings} new, ${r.resolved} resolved) in ${r.durationMs} ms`); } catch (e) { console.error('[smk] convention scan:', e.message); } }, 10_000);
  return { started: true, intervalMs, windowMs: WINDOW_MS, tunables: TUNABLE_NAMES.length, codeModel: CODE_MODEL };
}
export function stopSelfModification() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null; state.running = false;
  return { stopped: true };
}
export function getSelfModificationStatus() {
  const running = runningExperiment();
  const verdicts = Object.fromEntries(qa(`SELECT verdict, COUNT(*) AS c FROM smk_experiments GROUP BY verdict`).map(r => [r.verdict, r.c]));
  const code = Object.fromEntries(qa(`SELECT status, COUNT(*) AS c FROM smk_code_proposals GROUP BY status`).map(r => [r.status, r.c]));
  const kept = qa(`SELECT tunable, before_value, after_value, delta, evaluated_at FROM smk_experiments WHERE verdict = 'kept' ORDER BY evaluated_at DESC LIMIT 5`);
  return {
    enabled: ENABLED, running: state.running, cycles: state.cycles, lastCycleAt: state.lastCycleAt, lastCycle: state.lastCycle, skipped: state.skipped,
    config: { windowMs: WINDOW_MS, experimentGapMs: EXPERIMENT_GAP_MS, retestMs: RETEST_MS, tolerance: TOLERANCE, llmProposeEveryMs: LLM_PROPOSE_EVERY_MS, codeModel: CODE_MODEL, maxReady: MAX_READY, maxBuildsPerDay: MAX_BUILDS_PER_DAY, maxTargetLines: MAX_TARGET_LINES, ouroborosBacklogMax: OUROBOROS_BACKLOG_MAX },
    experiment: running ? { ...hydrate(running), remainingMs: Math.max(0, running.started_at + running.window_ms - now()) } : null,
    verdicts, kept, proposers: { rule: state.ruleProposals, llm: state.llmProposals, llmDeclined: state.llmDeclined, lastLlmProposeAt: state.lastLlmProposeAt },
    code: { counts: code, building: state.building, lastBuild: state.lastBuild, builds: state.builds, outcomes: qa(`SELECT id, title, outcome_delta FROM smk_code_proposals WHERE outcome_delta IS NOT NULL ORDER BY outcome_at DESC LIMIT 5`) },
    proposerStats: proposerStats(),
    conventions: (() => { try { const c = getConventionStatus(); return { open: c.open, statuses: c.statuses, fixedTotal: c.fixedTotal, protectedOpen: c.protectedOpen, lastScanAt: c.lastScan?.created_at || null }; } catch (e) { return { error: e.message }; } })(),
    ouroboros: checkOuroborosAllowed(),
    tunables: listTunables().map(t => ({ name: t.name, value: t.value, default: t.default, source: t.source })),
    objectiveNow: windowMetrics(now() - WINDOW_MS, now()),
  };
}

// ─── Routes ──────────────────────────────────────────────────────
export function installSelfModificationRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const B = '/api/intelligence/self-modification';
  app.get(B, route((_req, res) => res.json(getSelfModificationStatus())));
  app.post(`${B}/cycle`, route(async (_req, res) => res.json(await selfModificationCycle({ trigger: 'api' }))));
  app.get(`${B}/objective`, route((req, res) => { const w = Math.min(24 * H, Math.max(5 * MIN, parseInt(req.query.windowMs, 10) || WINDOW_MS)); res.json(windowMetrics(now() - w, now())); }));
  app.get(`${B}/experiments`, route((req, res) => res.json({ experiments: listExperiments({ limit: parseInt(req.query.limit, 10) || 30 }) })));
  app.get(`${B}/experiments/:id`, route((req, res) => { const e = getExperiment(req.params.id); e && !e._error ? res.json(e) : res.status(404).json({ error: 'not found' }); }));
  app.post(`${B}/experiments`, route(async (req, res) => {
    const { tunable: name, value, hypothesis, windowMs, force } = req.body || {};
    const r = await startExperiment({ tunable: name, value, hypothesis, windowMs: windowMs ? Math.max(5 * MIN, parseInt(windowMs, 10)) : undefined, force: !!force, source: 'api' });
    res.status(r.started ? 201 : 409).json(r);
  }));
  app.post(`${B}/experiments/:id/evaluate`, route((req, res) => res.json(evaluateExperiment(req.params.id, { force: req.body?.force !== false }))));
  app.get(`${B}/proposals`, route((_req, res) => res.json({ rules: ruleProposals(), nextConvention: nextConventionCandidate({ preferTested: fileHasTests }), nextOuroboros: nextOuroborosCandidate(), proposerStats: proposerStats() })));
  app.get(`${B}/conventions`, route((req, res) => res.json({ ...getConventionStatus(), findings: listConventionFindings({ rule: req.query.rule || null, status: req.query.status || 'open', limit: parseInt(req.query.limit, 10) || 50 }) })));
  app.post(`${B}/conventions/scan`, route((_req, res) => res.json(scanConventions())));
  app.get(`${B}/code`, route((req, res) => res.json({ proposals: listCodeProposals({ status: req.query.status || null, limit: parseInt(req.query.limit, 10) || 30 }) })));
  app.get(`${B}/code/:id`, route((req, res) => { const p = getCodeProposal(req.params.id, { diff: req.query.diff !== '0' }); p ? res.json(p) : res.status(404).json({ error: 'not found' }); }));
  app.post(`${B}/code/build`, route(async (req, res) => {
    const { title, targetFile, line, sketch, rationale, model } = req.body || {};
    const r = await buildCodeProposal({ source: 'api', title, targetFile, line: line ?? null, sketch, rationale, model });
    res.status(r.built ? 201 : 409).json(r);
  }));
  app.post(`${B}/code/backlog`, route(async (_req, res) => res.json(await maybeBuildFromBacklog({ trigger: 'api' }))));
  app.post(`${B}/code/:id/approve`, route((req, res) => { const r = approveCodeProposal(req.params.id, { by: req.body?.by || 'operator' }); res.status(r.ok ? 200 : 409).json(r); }));
  app.post(`${B}/code/:id/reject`, route((req, res) => { const r = rejectCodeProposal(req.params.id, { by: req.body?.by || 'operator', reason: req.body?.reason || '' }); res.status(r.ok ? 200 : 409).json(r); }));
}
