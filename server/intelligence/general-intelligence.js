/**
 * General Intelligence Core — Phase AD.
 *
 * Runs the capability benchmark (capability-bench.js) through the reasoner (reasoner.js), stores
 * every item, and reports a g-score: the unweighted mean of per-family accuracy on freshly generated,
 * machine-graded problems. Nothing here is graded by an LLM.
 *
 * Learning loop: after a benchmark, one family with failures gets a short lesson distilled from its
 * failed items; the lesson is A/B-tested on fresh seeds (same seeds with and without it, fixed
 * strategy) and kept only on measured gain. Kept lessons are injected by the reasoner.
 *
 * Daemon Step 5.95 calls generalIntelligenceCycle(); long work is started in the background and is
 * single-flight. See docs/AGI-BLUEPRINT.md for why this exists and what comes after it.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { isResourceConstrained } from './resource-envelope.js';
import { tunable } from './tunables.js';
import { FAMILIES, generateTask, publicView, scoreItems } from './capability-bench.js';
import { solve, recordOutcome, runProgram, applicableStrategies, getArms, reasonerStats, STRATEGIES } from './reasoner.js';

const ENABLED = process.env.AGI_BENCH_ENABLED !== '0';
const H = 3_600_000, DAY = 24 * H;
const LESSON_AB_N = Math.max(4, Math.min(12, parseInt(process.env.AGI_LESSON_AB_N, 10) || 6));
const LESSON_KEEP_MARGIN = 2;
const LESSON_MODEL = process.env.REASONER_MODEL || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';

const perFamily = () => Math.round(tunable('agi.bench_per_family', 2));
const benchInterval = () => tunable('agi.bench_interval_ms', 6 * H);
const lessonsPerDay = () => Math.round(tunable('agi.lessons_per_day', 2));

const now = () => Date.now();
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const qa = (sql, ...p) => db.prepare(sql).all(...p);
const parse = (s, fb = null) => { try { return JSON.parse(s); } catch (_) { return fb; } };

const state = { running: false, benchInFlight: null, lessonInFlight: null, lastCycle: null, lastError: null, cycles: 0 };

function ensureTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS capability_runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'running', trigger TEXT, strategy_mode TEXT, level INTEGER DEFAULT 1,
      base_seed INTEGER, planned INTEGER, n INTEGER, correct INTEGER, skipped INTEGER, g_score REAL, brier REAL,
      by_family TEXT, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_capability_runs_created ON capability_runs(created_at);
    CREATE TABLE IF NOT EXISTS capability_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, family TEXT NOT NULL, seed INTEGER NOT NULL, level INTEGER NOT NULL,
      strategy TEXT, correct INTEGER, skipped INTEGER DEFAULT 0, confidence REAL, answer TEXT, expected TEXT, error TEXT, ms INTEGER, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_capability_items_run ON capability_items(run_id);
  `);
}
try { ensureTables(); } catch (e) { console.error('[general-intelligence] table setup failed:', e.message); }

const emit = payload => { try { publish('general-intelligence', 'system.capability', JSON.stringify(payload)); } catch (e) { console.error('[general-intelligence] publish:', e.message); } };

// ── benchmark ────────────────────────────────────────────────────────────────
async function gradeTask(task, strategy, lessons) {
  const r = await solve(publicView(task), { strategy, lessons });
  if (r.skipped) return { ...r, correct: false };
  let correct = false;
  try { correct = !!(await task.check(r.answer, { run: runProgram })); }
  catch (e) { console.error('[general-intelligence] checker threw:', e.message); }
  return { ...r, correct };
}

async function executeBenchmark(runId, { tasks, strategy }) {
  const items = [];
  for (const task of tasks) {
    const r = await gradeTask(task, strategy, undefined);
    if (!r.skipped) recordOutcome(task.family, r.strategy, r.correct, r.ms);
    items.push({ family: task.family, correct: r.correct, skipped: !!r.skipped, confidence: r.skipped ? null : r.confidence });
    db.prepare(`INSERT INTO capability_items (run_id, family, seed, level, strategy, correct, skipped, confidence, answer, expected, error, ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, task.family, task.seed, task.level, r.strategy, r.skipped ? null : (r.correct ? 1 : 0), r.skipped ? 1 : 0, r.skipped ? null : r.confidence,
        clip(typeof r.answer === 'string' ? r.answer : JSON.stringify(r.answer), 600), clip(typeof task.expected === 'string' ? task.expected : JSON.stringify(task.expected), 600), r.error || null, r.ms, now());
  }
  const s = scoreItems(items);
  db.prepare(`UPDATE capability_runs SET status = 'completed', n = ?, correct = ?, skipped = ?, g_score = ?, brier = ?, by_family = ?, completed_at = ? WHERE id = ?`)
    .run(s.n, s.correct, s.skipped, s.g, s.brier, JSON.stringify(s.byFamily), now(), runId);
  const ranked = Object.entries(s.byFamily).filter(([, f]) => f.accuracy != null).sort((a, b) => b[1].accuracy - a[1].accuracy);
  emit({ action: 'benchmark_completed', runId, strategy, g: s.g, brier: s.brier, n: s.n, correct: s.correct, skipped: s.skipped, strongest: ranked[0]?.[0] || null, weakest: ranked[ranked.length - 1]?.[0] || null });
  return getRun(runId);
}

/**
 * Start a benchmark. Single-flight. Returns { started, runId } immediately unless wait is true.
 * strategy 'auto' = bandit-chosen per item; a named strategy measures that strategy alone
 * ('direct' is the raw-model baseline).
 */
export async function runBenchmark({ perFamily: pf, strategy = 'auto', trigger = 'api', level = 1, families, baseSeed, wait = false } = {}) {
  if (state.benchInFlight) return { started: false, reason: 'benchmark_in_progress', runId: state.benchInFlight.runId };
  const mode = strategy === 'auto' || STRATEGIES.includes(strategy) ? strategy : 'auto';
  const fams = (Array.isArray(families) && families.length ? families : FAMILIES).filter(f => FAMILIES.includes(f));
  if (!fams.length) return { started: false, reason: 'no_valid_families' };
  const count = Math.max(1, Math.min(6, parseInt(pf, 10) || perFamily()));
  const lv = Math.max(1, Math.min(2, parseInt(level, 10) || 1));
  const seed = Number.isInteger(baseSeed) ? baseSeed : (now() % 2_000_000_000);
  const tasks = [];
  for (const f of fams) for (let i = 0; i < count; i++) tasks.push(generateTask(f, seed + i * 7919, lv));
  const runId = `cap-${randomUUID().slice(0, 12)}`;
  db.prepare(`INSERT INTO capability_runs (id, status, trigger, strategy_mode, level, base_seed, planned, created_at) VALUES (?, 'running', ?, ?, ?, ?, ?, ?)`)
    .run(runId, clip(trigger, 40), mode, lv, seed, tasks.length, now());
  const promise = executeBenchmark(runId, { tasks, strategy: mode })
    .catch(e => {
      state.lastError = e.message;
      console.error('[general-intelligence] benchmark failed:', e.message);
      db.prepare(`UPDATE capability_runs SET status = 'error', error = ?, completed_at = ? WHERE id = ?`).run(clip(e.message, 300), now(), runId);
      return getRun(runId);
    })
    .finally(() => { state.benchInFlight = null; });
  state.benchInFlight = { runId, startedAt: now(), planned: tasks.length, strategy: mode, promise };
  if (wait) return { started: true, runId, run: await promise };
  return { started: true, runId, planned: tasks.length, strategy: mode };
}

export function getRun(id) {
  const run = q1(`SELECT * FROM capability_runs WHERE id = ?`, id);
  if (!run) return null;
  return { ...run, by_family: parse(run.by_family, {}), items: qa(`SELECT family, seed, level, strategy, correct, skipped, confidence, answer, expected, error, ms FROM capability_items WHERE run_id = ? ORDER BY id`, id) };
}
export function listRuns({ limit = 20 } = {}) {
  return qa(`SELECT * FROM capability_runs ORDER BY created_at DESC LIMIT ?`, limit).map(r => ({ ...r, by_family: parse(r.by_family, {}) }));
}

// ── lessons: distil → A/B on fresh seeds → keep only on gain ─────────────────
const tokens = s => new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []);
function jaccard(a, b) { const A = tokens(a), B = tokens(b); let inter = 0; for (const t of A) if (B.has(t)) inter++; return A.size + B.size - inter ? inter / (A.size + B.size - inter) : 0; }

function lessonCandidateFamily() {
  const rows = qa(`SELECT i.family, COUNT(*) fails FROM capability_items i JOIN capability_runs r ON r.id = i.run_id
    WHERE r.status = 'completed' AND i.correct = 0 AND i.skipped = 0 AND i.created_at > ? GROUP BY i.family ORDER BY fails DESC`, now() - 7 * DAY);
  for (const r of rows) {
    if (r.fails < 2) continue;
    const recent = q1(`SELECT 1 FROM reasoner_lessons WHERE family = ? AND created_at > ?`, r.family, now() - DAY);
    if (!recent) return r.family;
  }
  return null;
}

const DISTIL_SYSTEM = `You study a solver's mistakes and write ONE general lesson that would prevent them.
The lesson must be a method or check that applies to every problem of this kind — never mention the
specific numbers, names or answers of the examples. At most 2 sentences.
Reply as JSON: {"lesson": "…"}`;

async function distilLesson(family) {
  const fails = qa(`SELECT i.seed, i.level, i.answer, i.expected, i.strategy FROM capability_items i JOIN capability_runs r ON r.id = i.run_id
    WHERE r.status = 'completed' AND i.family = ? AND i.correct = 0 AND i.skipped = 0 ORDER BY i.id DESC LIMIT 4`, family);
  if (fails.length < 2) return { lesson: null, reason: 'too_few_failures' };
  const cases = fails.map((f, i) => `Case ${i + 1}:\n${clip(generateTask(family, f.seed, f.level).prompt, 700)}\nSolver answered: ${clip(f.answer, 200) || '(nothing)'}\nCorrect answer: ${clip(f.expected, 200)}`).join('\n\n');
  const raw = await chatOllama([{ role: 'system', content: DISTIL_SYSTEM }, { role: 'user', content: `Problem kind: ${family}\n\n${cases}` }],
    { priority: 'goal', label: 'agi:distil', model: LESSON_MODEL, temperature: 0.3, maxTokens: 300, format: 'json', timeoutMs: 150_000 });
  const lesson = clip(parse(raw, {})?.lesson, 320);
  if (!lesson || lesson.length < 20) return { lesson: null, reason: 'no_lesson_produced' };
  const existing = qa(`SELECT text FROM reasoner_lessons WHERE family = ?`, family);
  if (existing.some(e => jaccard(e.text, lesson) >= 0.7)) return { lesson: null, reason: 'duplicate_lesson' };
  return { lesson, from: fails.length };
}

async function executeLessonTest(lessonId, family, text) {
  const kept = qa(`SELECT text FROM reasoner_lessons WHERE family = ? AND status = 'kept' ORDER BY created_at DESC LIMIT 2`, family).map(r => r.text);
  const seed = now() % 2_000_000_000;
  const strategy = applicableStrategies(publicView(generateTask(family, seed, 1))).includes('cot') ? 'cot' : 'direct';
  let base = 0, withLesson = 0, wins = 0, losses = 0, n = 0;
  for (let i = 0; i < LESSON_AB_N; i++) {
    const task = generateTask(family, seed + i * 104729, 1);
    const a = await gradeTask(task, strategy, kept);
    const b = await gradeTask(task, strategy, [text, ...kept]);
    if (a.skipped || b.skipped) continue; // a pair only counts when both arms actually answered
    n++; if (a.correct) base++; if (b.correct) withLesson++;
    if (b.correct && !a.correct) wins++; else if (a.correct && !b.correct) losses++;
  }
  const status = n >= Math.ceil(LESSON_AB_N / 2) && wins - losses >= LESSON_KEEP_MARGIN ? 'kept' : 'reverted';
  const note = n < Math.ceil(LESSON_AB_N / 2) ? 'too few scored pairs' : `wins ${wins}, losses ${losses} (need margin ≥ ${LESSON_KEEP_MARGIN})`;
  db.prepare(`UPDATE reasoner_lessons SET status = ?, base_correct = ?, lesson_correct = ?, wins = ?, losses = ?, n = ?, note = ?, completed_at = ? WHERE id = ?`)
    .run(status, base, withLesson, wins, losses, n, note, now(), lessonId);
  emit({ action: status === 'kept' ? 'lesson_kept' : 'lesson_reverted', lessonId, family, base, withLesson, n, wins, losses, lesson: clip(text, 160) });
  return q1(`SELECT * FROM reasoner_lessons WHERE id = ?`, lessonId);
}

/** Distil one lesson and A/B-test it. Single-flight. Returns immediately unless wait is true. */
export async function runLessonTest({ family = null, trigger = 'api', wait = false } = {}) {
  if (state.lessonInFlight) return { started: false, reason: 'lesson_test_in_progress', lessonId: state.lessonInFlight.lessonId };
  const fam = family && FAMILIES.includes(family) ? family : lessonCandidateFamily();
  if (!fam) return { started: false, reason: 'no_family_with_failures' };
  state.lessonInFlight = { lessonId: null, family: fam, startedAt: now() };
  const promise = (async () => {
    const d = await distilLesson(fam);
    if (!d.lesson) return { started: false, reason: d.reason, family: fam };
    const id = `les-${randomUUID().slice(0, 12)}`;
    const sourceRun = q1(`SELECT id FROM capability_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`)?.id || null;
    db.prepare(`INSERT INTO reasoner_lessons (id, family, text, status, source_run, note, created_at) VALUES (?, ?, ?, 'testing', ?, ?, ?)`).run(id, fam, d.lesson, sourceRun, clip(trigger, 40), now());
    state.lessonInFlight.lessonId = id;
    return { started: true, lesson: await executeLessonTest(id, fam, d.lesson) };
  })()
    .catch(e => {
      state.lastError = e.message;
      console.error('[general-intelligence] lesson test failed:', e.message);
      if (state.lessonInFlight?.lessonId) db.prepare(`UPDATE reasoner_lessons SET status = 'reverted', note = ?, completed_at = ? WHERE id = ? AND status = 'testing'`).run(clip(`error: ${e.message}`, 200), now(), state.lessonInFlight.lessonId);
      return { started: false, reason: 'error', error: clip(e.message, 200) };
    })
    .finally(() => { state.lessonInFlight = null; });
  state.lessonInFlight.promise = promise;
  if (wait) return promise;
  return { started: true, family: fam, async: true };
}

export function retireLesson(id, { by = 'operator' } = {}) {
  const r = db.prepare(`UPDATE reasoner_lessons SET status = 'reverted', note = ?, completed_at = ? WHERE id = ? AND status = 'kept'`).run(`retired by ${clip(by, 40)}`, now(), id);
  return { retired: r.changes > 0 };
}
export function listLessons({ status = null, limit = 50 } = {}) {
  return status ? qa(`SELECT * FROM reasoner_lessons WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit) : qa(`SELECT * FROM reasoner_lessons ORDER BY created_at DESC LIMIT ?`, limit);
}

// ── daemon step ──────────────────────────────────────────────────────────────
export async function generalIntelligenceCycle({ trigger = 'daemon' } = {}) {
  state.cycles++; state.lastCycle = now();
  if (!ENABLED) return { skipped: true, reason: 'disabled' };
  if (isResourceConstrained()) return { skipped: true, reason: 'resource_constrained' };
  if (state.benchInFlight || state.lessonInFlight) return { skipped: true, reason: 'in_progress' };
  const last = q1(`SELECT MAX(created_at) t FROM capability_runs WHERE status IN ('completed', 'running') AND strategy_mode = 'auto'`)?.t || 0;
  if (now() - last >= benchInterval()) {
    const r = await runBenchmark({ strategy: 'auto', trigger });
    return { action: 'benchmark', ...r };
  }
  const today = q1(`SELECT COUNT(*) c FROM reasoner_lessons WHERE created_at > ?`, now() - DAY).c;
  if (today < lessonsPerDay()) {
    const r = await runLessonTest({ trigger });
    return { action: 'lesson', ...r };
  }
  return { skipped: true, reason: 'nothing_due', nextBenchmarkInMs: Math.max(0, benchInterval() - (now() - last)) };
}

export function gTrend({ limit = 12, mode = 'auto' } = {}) {
  return qa(`SELECT id, g_score, brier, n, correct, skipped, created_at FROM capability_runs WHERE status = 'completed' AND strategy_mode = ? AND g_score IS NOT NULL ORDER BY created_at DESC LIMIT ?`, mode, limit).reverse();
}

export function getGeneralIntelligenceStatus() {
  try {
    const latest = q1(`SELECT * FROM capability_runs WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1`);
    const latestAuto = q1(`SELECT * FROM capability_runs WHERE status = 'completed' AND strategy_mode = 'auto' ORDER BY created_at DESC LIMIT 1`);
    const baseline = q1(`SELECT * FROM capability_runs WHERE status = 'completed' AND strategy_mode = 'direct' ORDER BY created_at DESC LIMIT 1`);
    const lessons = qa(`SELECT status, COUNT(*) c FROM reasoner_lessons GROUP BY status`);
    const slim = r => (r ? { id: r.id, g: r.g_score, brier: r.brier, n: r.n, correct: r.correct, skipped: r.skipped, strategy: r.strategy_mode, byFamily: parse(r.by_family, {}), at: r.created_at } : null);
    return {
      enabled: ENABLED, running: state.running,
      inFlight: { benchmark: state.benchInFlight ? { runId: state.benchInFlight.runId, planned: state.benchInFlight.planned, strategy: state.benchInFlight.strategy, startedAt: state.benchInFlight.startedAt, done: q1(`SELECT COUNT(*) c FROM capability_items WHERE run_id = ?`, state.benchInFlight.runId).c } : null, lesson: state.lessonInFlight ? { family: state.lessonInFlight.family, lessonId: state.lessonInFlight.lessonId, startedAt: state.lessonInFlight.startedAt } : null },
      latest: slim(latest), latestAuto: slim(latestAuto), baselineDirect: slim(baseline),
      upliftOverDirect: latestAuto?.g_score != null && baseline?.g_score != null ? latestAuto.g_score - baseline.g_score : null,
      trend: gTrend(),
      runs: q1(`SELECT COUNT(*) c FROM capability_runs WHERE status = 'completed'`).c,
      lessons: Object.fromEntries(lessons.map(l => [l.status, l.c])),
      reasoner: reasonerStats(),
      config: { families: FAMILIES, perFamily: perFamily(), benchIntervalMs: benchInterval(), lessonsPerDay: lessonsPerDay(), lessonAbN: LESSON_AB_N, keepMargin: LESSON_KEEP_MARGIN },
      cycles: state.cycles, lastCycle: state.lastCycle, lastError: state.lastError,
    };
  } catch (e) { return { enabled: ENABLED, error: e.message }; }
}

/** Rows left running/testing by a previous process are dead by definition — close them at boot. */
export function startGeneralIntelligence() {
  let closedRuns = 0, closedLessons = 0;
  try {
    closedRuns = db.prepare(`UPDATE capability_runs SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status = 'running'`).run(now()).changes;
    closedLessons = db.prepare(`UPDATE reasoner_lessons SET status = 'reverted', note = 'interrupted by restart', completed_at = ? WHERE status = 'testing'`).run(now()).changes;
  } catch (e) { console.error('[general-intelligence] boot recovery:', e.message); }
  state.running = true;
  return { started: true, enabled: ENABLED, closedRuns, closedLessons };
}
export function stopGeneralIntelligence() { state.running = false; return { stopped: true }; }

// ── routes ───────────────────────────────────────────────────────────────────
export function installGeneralIntelligenceRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const lim = (v, d, max) => Math.min(max, Math.max(1, parseInt(v, 10) || d));
  const base = '/api/intelligence/capability';

  app.get(base, route((req, res) => res.json(getGeneralIntelligenceStatus())));
  app.get(`${base}/runs`, route((req, res) => res.json({ runs: listRuns({ limit: lim(req.query.limit, 20, 100) }) })));
  app.get(`${base}/arms`, route((req, res) => res.json({ arms: getArms(typeof req.query.family === 'string' ? req.query.family : null) })));
  app.get(`${base}/lessons`, route((req, res) => res.json({ lessons: listLessons({ status: typeof req.query.status === 'string' ? req.query.status : null, limit: lim(req.query.limit, 50, 200) }) })));
  app.get(`${base}/sample`, route((req, res) => {
    const family = FAMILIES.includes(req.query.family) ? req.query.family : 'arithmetic';
    const t = generateTask(family, parseInt(req.query.seed, 10) || 1, lim(req.query.level, 1, 2));
    res.json({ seed: t.seed, level: t.level, ...publicView(t) }); // never the expected answer
  }));
  app.post(`${base}/run`, route(async (req, res) => {
    const b = req.body || {};
    res.json(await runBenchmark({ perFamily: b.perFamily, strategy: b.strategy, level: b.level, families: b.families, baseSeed: Number.isInteger(b.baseSeed) ? b.baseSeed : undefined, trigger: 'api', wait: b.wait === true }));
  }));
  app.post(`${base}/cycle`, route(async (req, res) => res.json(await generalIntelligenceCycle({ trigger: 'api' }))));
  app.post(`${base}/lessons/test`, route(async (req, res) => res.json(await runLessonTest({ family: req.body?.family, trigger: 'api', wait: req.body?.wait === true }))));
  app.post(`${base}/lessons/:id/retire`, route((req, res) => res.json(retireLesson(req.params.id))));
  app.post(`${base}/solve`, route(async (req, res) => {
    const b = req.body || {};
    if (!b.problem || typeof b.problem !== 'string') return res.status(400).json({ error: 'problem (string) is required' });
    res.json(await solve({ prompt: b.problem.slice(0, 6000), family: typeof b.family === 'string' ? b.family : 'general', answerType: b.kind, examples: Array.isArray(b.examples) ? b.examples.slice(0, 8) : undefined, query: b.query }, { strategy: b.strategy || 'auto' }));
  }));
  app.get(`${base}/runs/:id`, route((req, res) => { const r = getRun(req.params.id); return r ? res.json(r) : res.status(404).json({ error: 'run not found' }); }));
}
