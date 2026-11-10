/**
 * Tunables — Phase Y (self-modification kernel), layer 1.
 *
 * The knobs that shape autonomous behaviour (reflection cadence, motor floors, goal queue
 * depth, scheduler slots, retirement thresholds…) were module-load constants read from
 * process.env. Nothing running inside the organism could move them, so "recursive
 * self-improvement" could only ever mean prompts and memories. This registry makes a
 * curated set of them LIVE: modules call `tunable(name, fallback)` at use time, the
 * self-modification kernel changes a value inside declared bounds, measures the effect
 * over a window and keeps or reverts it, and the adopted value survives restarts in the
 * `tunables` table.
 *
 * Rules that keep this safe:
 *  - every tunable declares min/max; `setTunable` clamps and refuses NaN
 *  - env value (if set) is the boot default, DB value (if adopted) wins over env
 *  - nothing here imports a consumer module → no cycles; consumers import this
 *  - `source` records who moved it (operator | smk:<experimentId> | rule | llm)
 */
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

// name → { env, default, min, max, step, unit, module, effect }
// `effect` is a one-line statement of what raising the value does — the LLM proposer reads it.
export const REGISTRY = {
  'reflection.min_interval_ms': { env: 'REFLECTION_MIN_INTERVAL_MS', default: 10 * 60_000, min: 60_000, max: 3_600_000, step: 60_000, unit: 'ms', module: 'reflection.js', effect: 'raising it makes autonomous reflections rarer (fewer Ollama calls, slower adaptation)' },
  'motor.reflect_min_ms': { env: 'MOTOR_REFLECT_MIN_MS', default: 10 * 60_000, min: 60_000, max: 3_600_000, step: 60_000, unit: 'ms', module: 'motor-output.js', effect: 'raising it throttles the motor Reflect region' },
  'motor.goalseek_min_ms': { env: 'MOTOR_GOALSEEK_MIN_MS', default: 3 * 60_000, min: 60_000, max: 1_800_000, step: 60_000, unit: 'ms', module: 'motor-output.js', effect: 'raising it slows motor-driven goal execution/generation' },
  'motor.selfaudit_min_ms': { env: 'MOTOR_SELFAUDIT_MIN_MS', default: 10 * 60_000, min: 60_000, max: 3_600_000, step: 60_000, unit: 'ms', module: 'motor-output.js', effect: 'raising it makes consciousness audits from the motor region rarer' },
  'goals.max_pending': { env: 'GOAL_MAX_PENDING', default: 12, min: 2, max: 60, step: 1, unit: 'proposals', module: 'goal-engine.js', effect: 'raising it lets goal generation run with a deeper unexecuted queue' },
  'synth.max_unrun': { env: 'SYNTH_MAX_UNRUN', default: 3, min: 1, max: 20, step: 1, unit: 'workflows', module: 'synthesizer.js', effect: 'raising it allows more synthesized-but-never-run workflows before synthesis is refused' },
  'agent.retire_threshold': { env: 'AGENT_RETIRE_THRESHOLD', default: 0.2, min: 0.05, max: 0.5, step: 0.05, unit: 'quality', module: 'agent-quality.js', effect: 'raising it retires forged agents at a higher 7-day mean quality (more pressure)' },
  'agent.shelve_threshold': { env: 'AGENT_SHELVE_THRESHOLD', default: 0.15, min: 0.05, max: 0.5, step: 0.05, unit: 'quality', module: 'agent-quality.js', effect: 'raising it shelves more low-utility goals' },
  'ollama.max_concurrent': { env: 'OLLAMA_MAX_CONCURRENT', default: 2, min: 1, max: 4, step: 1, unit: 'slots', module: 'ollama-scheduler.js', effect: 'raising it admits more simultaneous inferences (more throughput, more GPU contention and timeouts)' },
  'narrator.min_gap_ms': { env: 'NARRATOR_MIN_GAP_MS', default: 45_000, min: 5_000, max: 300_000, step: 5_000, unit: 'ms', module: 'narrator.js', effect: 'raising it makes the overlay narrator speak less often' },
  // Added 2026-11-09 after a bridge peer flagged 76 digests in 24 h (one every 15 min — "≥ 2 outcomes" is always true at 18 goals/h)
  'hive.digest_min_gap_ms': { env: 'HIVE_DIGEST_MIN_GAP_MS', default: 2 * 3_600_000, min: 15 * 60_000, max: 12 * 3_600_000, step: 15 * 60_000, unit: 'ms', module: 'hive-peers.js', effect: 'raising it posts fewer digests to the shared fraymus-bridge' },
  'hive.digest_min_outcomes': { env: 'HIVE_DIGEST_MIN_OUTCOMES', default: 8, min: 2, max: 100, step: 1, unit: 'outcomes', module: 'hive-peers.js', effect: 'raising it requires more goal outcomes before a digest counts as worth posting' },
  // Phase AC (2026-11-10): how many proven programs may become callable skills per day
  'skills.crystallize_per_day': { env: 'SKILL_CRYSTALLIZE_PER_DAY', default: 3, min: 0, max: 12, step: 1, unit: 'skills', module: 'skill-forge.js', effect: 'raising it lets more verified fossils be crystallized into sandboxed agent tools each day (each costs ~2 coder-model calls)' },
  'agi.bench_per_family': { env: 'AGI_BENCH_PER_FAMILY', default: 2, min: 1, max: 6, step: 1, unit: 'tasks', module: 'general-intelligence.js', effect: 'raising it makes each capability benchmark less noisy (more fresh problems per family) at the cost of more model calls per run' },
  'agi.bench_interval_ms': { env: 'AGI_BENCH_INTERVAL_MS', default: 21600000, min: 3600000, max: 172800000, step: 3600000, unit: 'ms', module: 'general-intelligence.js', effect: 'lowering it measures the g-score more often (faster strategy learning, more GPU time taken from goals)' },
  'agi.lessons_per_day': { env: 'AGI_LESSONS_PER_DAY', default: 2, min: 0, max: 6, step: 1, unit: 'lessons', module: 'general-intelligence.js', effect: 'raising it lets more reasoning lessons be distilled from benchmark failures and A/B-tested each day (each test costs ~12 model calls)' },
};
export const TUNABLE_NAMES = Object.keys(REGISTRY);

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS tunables (
    name TEXT PRIMARY KEY,
    value REAL NOT NULL,
    default_value REAL,
    source TEXT,
    updated_at INTEGER NOT NULL
  )`).run();
}
try { ensureTable(); } catch (e) { console.error('[tunables] schema:', e.message); }

const cache = new Map();   // name → { value, source, updatedAt }

function bootDefault(name) {
  const r = REGISTRY[name];
  const envVal = r.env ? process.env[r.env] : undefined;
  return clampTo(name, envVal != null && envVal !== '' ? num(envVal, r.default) : r.default);
}

function clampTo(name, value) {
  const r = REGISTRY[name];
  const v = num(value, r.default);
  return Math.min(r.max, Math.max(r.min, v));
}

function load() {
  let rows = [];
  try { rows = db.prepare(`SELECT name, value, source, updated_at FROM tunables`).all(); } catch (e) { console.error('[tunables] load:', e.message); }
  const byName = new Map(rows.map(r => [r.name, r]));
  for (const name of TUNABLE_NAMES) {
    const row = byName.get(name);
    if (row && TUNABLE_NAMES.includes(row.name)) cache.set(name, { value: clampTo(name, row.value), source: row.source || 'db', updatedAt: row.updated_at });
    else cache.set(name, { value: bootDefault(name), source: 'default', updatedAt: 0 });
  }
}
load();

/** Live read. Unknown names fall back so a typo never throws inside a hot loop. */
export function tunable(name, fallback = undefined) {
  const c = cache.get(name);
  if (c) return c.value;
  return fallback !== undefined ? fallback : (REGISTRY[name]?.default ?? NaN);
}

export function describeTunable(name) {
  const r = REGISTRY[name];
  if (!r) return null;
  const c = cache.get(name);
  return { name, value: c.value, default: bootDefault(name), source: c.source, updatedAt: c.updatedAt, ...r };
}

export function listTunables() {
  return TUNABLE_NAMES.map(describeTunable);
}

/**
 * Set a tunable. Clamps to bounds; refuses unknown names / non-numbers. Persists so the
 * value survives restarts (an adopted experiment must not evaporate at the next boot).
 */
export function setTunable(name, value, { source = 'operator', persist = true } = {}) {
  if (!REGISTRY[name]) return { ok: false, error: `unknown tunable ${name}`, known: TUNABLE_NAMES };
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return { ok: false, error: 'value must be a finite number' };
  const before = tunable(name);
  const after = clampTo(name, n);
  const t = now();
  cache.set(name, { value: after, source, updatedAt: t });
  if (persist) {
    try {
      db.prepare(`INSERT INTO tunables (name, value, default_value, source, updated_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(name) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`)
        .run(name, after, bootDefault(name), source, t);
    } catch (e) { console.error('[tunables] persist:', e.message); }
  }
  try { publish('system', 'system.tunable.changed', JSON.stringify({ name, before, after, clamped: after !== n, source, at: t })); } catch (_) {}
  return { ok: true, name, before, after, clamped: after !== n, source };
}

/** Back to the boot default (env or registry) and forget the DB row. */
export function resetTunable(name, { source = 'operator' } = {}) {
  if (!REGISTRY[name]) return { ok: false, error: `unknown tunable ${name}` };
  const before = tunable(name);
  const after = bootDefault(name);
  cache.set(name, { value: after, source: 'default', updatedAt: now() });
  try { db.prepare(`DELETE FROM tunables WHERE name = ?`).run(name); } catch (e) { console.error('[tunables] reset:', e.message); }
  try { publish('system', 'system.tunable.changed', JSON.stringify({ name, before, after, reset: true, source, at: now() })); } catch (_) {}
  return { ok: true, name, before, after };
}

export function installTunableRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/tunables', route((_req, res) => res.json({ tunables: listTunables() })));
  app.get('/api/intelligence/tunables/:name', route((req, res) => {
    const d = describeTunable(req.params.name);
    if (!d) return res.status(404).json({ error: 'unknown tunable' });
    res.json(d);
  }));
  app.put('/api/intelligence/tunables/:name', route((req, res) => {
    const r = setTunable(req.params.name, req.body?.value, { source: 'operator' });
    res.status(r.ok ? 200 : 400).json(r);
  }));
  app.delete('/api/intelligence/tunables/:name', route((req, res) => {
    const r = resetTunable(req.params.name);
    res.status(r.ok ? 200 : 400).json(r);
  }));
}
