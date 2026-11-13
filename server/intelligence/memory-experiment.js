/**
 * Memory experiment — do better memories make better work?
 *
 * Retrieval measures (memory-bench, memory-gold) say the memories put in front of an agent are now about its
 * task. This asks the question those cannot: does the agent then do the task better? A paired trial:
 * the same real objective is run twice by the same agent, once with the memory block as it used to be (the
 * ten newest memories) and once as it is now (memories about the task first), in an order fixed by a seed.
 * Both replies are scored by the outcome scorer that already scores every goal. The difference within each
 * pair is the result; a paired sign-flip test says how likely it is to be chance.
 *
 * Each run leaves memories behind (the task, its outcome, anything the agent chose to remember), and the second
 * run of a pair must not "remember" the first. Nothing is deleted: for the length of the experiment the agent's
 * memory block is cut off at the newest memory that existed when the experiment began.
 *
 * One experiment at a time; rows left `running` by a dead process are closed at load and by the sweeper.
 */
import { mayRecoverAtBoot } from '../config.js';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { runAgentAndWait } from '../fleet/runtime.js';
import { setMemoryContextMode, memoryContextPreview } from '../fleet/agent-memory.js';
import { scoreOutcome } from './outcome-scorer.js';
import { signFlipP } from './memory-rank.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();
const RUN_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.MEMORY_EXPERIMENT_RUN_TIMEOUT_MS, 10) || 240_000);
const MODES = ['recent', 'relevant'];
const MAX_ATTEMPTS = Math.min(5, Math.max(1, parseInt(process.env.MEMORY_EXPERIMENT_ATTEMPTS, 10) || 3));
let stopAsked = false;

db.exec(`CREATE TABLE IF NOT EXISTS memory_experiments (id TEXT PRIMARY KEY, status TEXT NOT NULL, seed INTEGER, pairs_asked INTEGER, pairs TEXT, summary TEXT, error TEXT, started_at INTEGER NOT NULL, finished_at INTEGER)`);
if (mayRecoverAtBoot()) try { db.prepare(`UPDATE memory_experiments SET status = 'error', error = 'interrupted by a restart', finished_at = ? WHERE status = 'running'`).run(now()); } catch (e) { console.error('[memory-experiment] recover:', e.message); }

let current = null;
function rng(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Paired statistics over [{recent, relevant}] quality scores. Pure. */
export function summarisePairs(pairs) {
  // a run that timed out or errored produced no work to judge: such a pair is set aside, not scored as a tie at the floor
  const done = pairs.filter(p => p.recent?.status === 'done' && p.relevant?.status === 'done' && Number.isFinite(p.recent.quality) && Number.isFinite(p.relevant.quality));
  const a = done.map(p => p.relevant.quality), b = done.map(p => p.recent.quality), d = a.map((x, i) => x - b[i]);
  const mean = x => (x.length ? +(x.reduce((s, v) => s + v, 0) / x.length).toFixed(4) : null);
  const judge = k => mean(done.map(p => p[k].judge).filter(Number.isFinite)), det = k => mean(done.map(p => p[k].deterministic).filter(Number.isFinite));
  const attempts = pairs.flatMap(p => [p.recent, p.relevant]).filter(Boolean), failed = attempts.reduce((n, r) => n + (r.failedAttempts || 0), 0);
  return { pairs: done.length, incomplete: pairs.length - done.length, runsThatDidNotFinish: failed, runAttempts: attempts.reduce((n, r) => n + 1 + (r.failedAttempts || 0), 0), meanQuality: { recent: mean(b), relevant: mean(a) }, meanDifference: mean(d),
    wins: d.filter(x => x > 0.02).length, losses: d.filter(x => x < -0.02).length, ties: d.filter(x => Math.abs(x) <= 0.02).length,
    p: done.length >= 4 ? signFlipP(a, b) : null, judgeOnly: { recent: judge('recent'), relevant: judge('relevant') }, deterministicOnly: { recent: det('recent'), relevant: det('relevant') },
    relevantMemoriesShown: mean(done.map(p => p.relevant.aboutTask).filter(Number.isFinite)),
    verdict: done.length < 6 ? 'too few pairs to say anything' : null };
}

function pickTasks(n, seed) {
  // real objectives an agent has already been given, from agents with enough memories for the two blocks to differ
  const rows = db.prepare(`SELECT e.agent_id AS agent, g.objective, g.priority, g.complexity, MAX(e.started_at) t FROM goal_executions e JOIN goal_proposals g ON g.id = e.goal_id
    WHERE e.status = 'completed' AND LENGTH(g.objective) BETWEEN 40 AND 400 AND (SELECT COUNT(*) FROM agent_memories m WHERE m.agent_id = e.agent_id) >= 100
    GROUP BY e.agent_id, g.objective ORDER BY t DESC LIMIT 400`).all();
  const r = rng(seed), pool = [...rows]; for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const out = [], perAgent = {};
  for (const x of pool) { if (out.length >= n) break; if ((perAgent[x.agent] || 0) >= Math.ceil(n / 3)) continue; perAgent[x.agent] = (perAgent[x.agent] || 0) + 1; out.push(x); }
  return out;
}
const taskText = t => [`Autonomous objective (${t.priority || 'medium'} priority, ${t.complexity || 'moderate'} complexity):`, t.objective, '\nProduce a concrete result: findings, a decision, or an artifact. Be specific and verifiable.', 'If the objective is not actionable as stated, say so plainly and state what would make it actionable.'].join('\n');

async function oneRun(task, mode, maxId) {
  const text = taskText(task), t0 = now();
  const preview = memoryContextPreview(task.agent, text, mode, { maxId });
  setMemoryContextMode(task.agent, mode, { maxId });
  let res, failedAttempts = 0;
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (stopAsked) { res = { status: 'stopped', lastReply: '' }; break; }
      try { res = await runAgentAndWait('local', task.agent, text, null, RUN_TIMEOUT_MS); } catch (e) { res = { status: 'error', error: e.message, lastReply: '' }; }
      if (res.status === 'done') break;
      failedAttempts++;
    }
  } finally { setMemoryContextMode(task.agent, null); }
  let scored = { quality: null, detail: null };
  try { scored = await scoreOutcome({ execId: null, objective: task.objective, threadId: res.threadId, reply: res.lastReply || '', runStatus: res.status }); } catch (e) { console.error('[memory-experiment] score:', e.message); }
  return { mode, status: res.status, failedAttempts, runId: res.runId || null, seconds: +((now() - t0) / 1000).toFixed(1), quality: scored.quality, judge: scored.detail?.judge?.overall ?? null, deterministic: scored.detail?.deterministic?.score ?? null,
    aboutTask: preview.aboutTask, shown: preview.shown, replyChars: (res.lastReply || '').length };
}

/** Start an experiment. Returns at once; follow it with `memoryExperimentStatus()`. */
export function startMemoryExperiment({ pairs = 10, seed = 7 } = {}) {
  if (current) return { started: false, reason: 'an experiment is already running', id: current.id };
  const n = Math.min(30, Math.max(2, parseInt(pairs, 10) || 10)), tasks = pickTasks(n, seed);
  if (tasks.length < 2) return { started: false, reason: 'fewer than two real tasks with enough memories to test on' };
  const id = `mx-${randomUUID().slice(0, 8)}`, r = rng(seed * 31 + 5);
  db.prepare(`INSERT INTO memory_experiments (id, status, seed, pairs_asked, pairs, started_at) VALUES (?, 'running', ?, ?, '[]', ?)`).run(id, seed, tasks.length, now());
  current = { id, done: 0, of: tasks.length, stage: 'starting' }; stopAsked = false;
  // every run of the experiment reads the store as it stood at the start: what one run stores, the next cannot see
  const maxId = db.prepare(`SELECT COALESCE(MAX(id), 0) m FROM agent_memories`).get().m;
  (async () => {
    const results = [];
    try {
      for (const [i, task] of tasks.entries()) {
        if (stopAsked) break;
        const order = r() < 0.5 ? MODES : [...MODES].reverse(), pair = { agent: task.agent, objective: task.objective, order };
        for (const mode of order) { current.stage = `pair ${i + 1} of ${tasks.length}: ${mode}`; pair[mode] = await oneRun(task, mode, maxId); }
        results.push(pair); current.done = i + 1;
        db.prepare(`UPDATE memory_experiments SET pairs = ? WHERE id = ?`).run(JSON.stringify(results), id);
      }
      const summary = { ...summarisePairs(results), stoppedEarly: stopAsked };
      db.prepare(`UPDATE memory_experiments SET status = 'completed', pairs = ?, summary = ?, finished_at = ? WHERE id = ?`).run(JSON.stringify(results), JSON.stringify(summary), now(), id);
      try { publish('memory-experiment', 'system.memory', JSON.stringify({ action: 'experiment_completed', id, ...summary })); } catch (e) { console.error('[memory-experiment] publish:', e.message); }
    } catch (e) {
      db.prepare(`UPDATE memory_experiments SET status = 'error', error = ?, pairs = ?, summary = ?, finished_at = ? WHERE id = ?`).run(String(e.message).slice(0, 300), JSON.stringify(results), JSON.stringify(summarisePairs(results)), now(), id);
    } finally { current = null; }
  })();
  return { started: true, id, pairs: tasks.length, seed, note: `two agent runs per pair, up to ${Math.round(RUN_TIMEOUT_MS / 1000)} s each` };
}

/** Ask a running experiment to end after the run in hand; what it has is kept and summarised. */
export function stopMemoryExperiment() { if (!current) return { stopping: false, reason: 'nothing is running' }; stopAsked = true; return { stopping: true, id: current.id }; }

export function memoryExperimentStatus(id = null) {
  const row = id ? db.prepare(`SELECT * FROM memory_experiments WHERE id = ?`).get(String(id)) : db.prepare(`SELECT * FROM memory_experiments ORDER BY started_at DESC LIMIT 1`).get();
  if (!row) return { running: !!current, latest: null };
  const pairs = JSON.parse(row.pairs || '[]');
  return { running: !!current, progress: current, latest: { id: row.id, status: row.status, seed: row.seed, pairsAsked: row.pairs_asked, error: row.error, startedAt: row.started_at, finishedAt: row.finished_at, minutes: row.finished_at ? +((row.finished_at - row.started_at) / 60000).toFixed(1) : null,
    summary: row.summary ? JSON.parse(row.summary) : summarisePairs(pairs),
    pairs: pairs.map(p => ({ agent: p.agent, objective: p.objective.slice(0, 110), order: p.order, recent: p.recent && { quality: p.recent.quality, status: p.recent.status, seconds: p.recent.seconds, failedAttempts: p.recent.failedAttempts }, relevant: p.relevant && { quality: p.relevant.quality, status: p.relevant.status, seconds: p.relevant.seconds, failedAttempts: p.relevant.failedAttempts, aboutTask: p.relevant.aboutTask } })) } };
}

export function installMemoryExperimentRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/memory-search/experiment', route((req, res) => res.json(memoryExperimentStatus(req.query.id || null))));
  app.post('/api/intelligence/memory-search/experiment', route((req, res) => {
    const out = startMemoryExperiment({ pairs: req.body?.pairs, seed: Math.min(1_000_000, Math.max(1, parseInt(req.body?.seed, 10) || 7)) });
    res.status(out.started ? 202 : 409).json(out);
  }));
  app.post('/api/intelligence/memory-search/experiment/stop', route((_req, res) => res.json(stopMemoryExperiment())));
}
