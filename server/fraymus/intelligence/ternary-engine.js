// ═══════════════════════════════════════════════════════════════════════════
// Trust-Gated Ternary Physarum Engine
// Vaughn D. Scott | EYEOVERTHINK® #6098807 | ephless llc
//
// Balanced ternary {-1, 0, +1} applied to Physarum agent decisions.
// 27-key ordinal signature, deterministic PRNG, A/B correctness proof.
//
// The trust engine caches decisions by the ordinal relationship of the
// three sensor readings (L, C, R). There are exactly 27 possible orderings.
// Each key maps to exactly one decision — no collisions, no heuristics.
// ═══════════════════════════════════════════════════════════════════════════

// ── Physics constants ────────────────────────────────────────────────────
const COLS = 120, ROWS = 80, N = COLS * ROWS, CELL = 4;
const SENSE_ANGLE = Math.PI * 0.2;
const TURN_ANGLE  = Math.PI * 0.2;
const SENSE_LEN   = 8 * CELL;
const SPEED       = CELL * 0.5;
const DEPOSIT     = 1.6;
const FADE        = 0.94;
const MAX_SCENT   = 30;

// ── Seeded PRNG (splitmix-style) ─────────────────────────────────────────
// Deterministic: same seed → same run. Both baseline and ternary use the
// same seed so correctness can be proved by comparing final state.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (x, n) => ((x % n) + n) % n;
const cmp  = (a, b) => a > b ? 1 : a < b ? -1 : 0;

// ── Baseline decision (no trust, no caching) ─────────────────────────────
// L > R and L > C  →  +1 (turn left)
// R > L and R > C  →  −1 (turn right)
// otherwise        →   0 (straight)
function baselineDecision(L, C, R) {
  return L > R && L > C ? 1 : R > L && R > C ? -1 : 0;
}

// ── Trust engine ─────────────────────────────────────────────────────────
// Ordinal signature: cmp(L,R), cmp(L,C), cmp(R,C) → key 0..26.
// This is mathematically complete — every possible (L, C, R) ordering maps
// to exactly one of 27 keys, and each key produces exactly one decision.
//
// threshold: how many consistent hits before a pattern is trusted.
// auditEvery: deterministic audit interval (every Nth trusted reuse).
function newTrustEngine(threshold, auditEvery) {
  return {
    entries: new Map(),
    threshold,
    auditEvery,
    queries: 0,
    reused: 0,
    trained: 0,
    audits: 0,
    disagreements: 0,

    decide(L, C, R) {
      const a = cmp(L, R), b = cmp(L, C), c = cmp(R, C);
      const key = (a + 1) * 9 + (b + 1) * 3 + (c + 1);
      let e = this.entries.get(key);
      this.queries++;

      if (e && e.count >= this.threshold) {
        this.reused++;
        // Deterministic audit: every Nth trusted reuse
        if (this.reused % this.auditEvery === 0) {
          this.audits++;
          const check = baselineDecision(L, C, R);
          if (check !== e.choice) {
            this.disagreements++;
            this.entries.delete(key);
            return check;
          }
        }
        return e.choice;
      }

      const choice = baselineDecision(L, C, R);
      if (!e) {
        e = { choice, count: 0 };
        this.entries.set(key, e);
      }
      if (e.choice !== choice) {
        this.disagreements++;
        e.choice = choice;
        e.count = 0;
      }
      e.count++;
      this.trained++;
      return choice;
    },
  };
}

// ── World factory ────────────────────────────────────────────────────────
function newWorld(count, seed, mode, threshold = 3, auditEvery = 25) {
  const random = rng(seed);
  const x     = new Float64Array(count);
  const y     = new Float64Array(count);
  const angle = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    x[i]     = random() * COLS * CELL;
    y[i]     = random() * ROWS * CELL;
    angle[i] = random() * Math.PI * 2;
  }

  return {
    x, y, angle,
    field:   new Float64Array(N),
    scratch: new Float64Array(N),
    count,
    engine: mode === 'ternary' ? newTrustEngine(threshold, auditEvery) : null,
    turns: [0, 0, 0],  // [-1, 0, +1] counters
    steps: 0,
  };
}

// ── Sensor sample ────────────────────────────────────────────────────────
function sample(w, px, py, a) {
  const sx = wrap(Math.floor((px + SENSE_LEN * Math.cos(a)) / CELL), COLS);
  const sy = wrap(Math.floor((py + SENSE_LEN * Math.sin(a)) / CELL), ROWS);
  return w.field[sy * COLS + sx];
}

// ── Tick: agents decide → move → deposit → diffuse → fade ───────────────
function tick(w) {
  const { x, y, angle, field, scratch, engine, count } = w;

  for (let i = 0; i < count; i++) {
    const h = angle[i];
    const L = sample(w, x[i], y[i], h + SENSE_ANGLE);
    const R = sample(w, x[i], y[i], h - SENSE_ANGLE);
    const C = sample(w, x[i], y[i], h);

    const turn = engine ? engine.decide(L, C, R) : baselineDecision(L, C, R);
    w.turns[turn + 1]++;

    const nh = h + turn * TURN_ANGLE;
    angle[i] = nh;

    const nx = wrap(x[i] + SPEED * Math.cos(nh), COLS * CELL);
    const ny = wrap(y[i] + SPEED * Math.sin(nh), ROWS * CELL);
    x[i] = nx;
    y[i] = ny;

    field[Math.floor(ny / CELL) * COLS + Math.floor(nx / CELL)] += DEPOSIT;
  }

  // 3×3 weighted diffusion kernel (center=4, neighbors=1, sum=12)
  for (let yy = 0; yy < ROWS; yy++) {
    for (let xx = 0; xx < COLS; xx++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = (dx === 0 && dy === 0) ? 4 : 1;
          sum += k * field[wrap(yy + dy, ROWS) * COLS + wrap(xx + dx, COLS)];
        }
      }
      scratch[yy * COLS + xx] = Math.min(MAX_SCENT, FADE * sum / 12);
    }
  }

  w.field = scratch;
  w.scratch = field;
  w.steps++;
}

// ── Correctness proof ────────────────────────────────────────────────────
// Compares two worlds state by state. If changed === 0, the trust engine
// produces the exact same simulation as the baseline.
function compareWorlds(a, b) {
  let maxErr = 0, changed = 0;
  function check(x, y) {
    for (let i = 0; i < x.length; i++) {
      const e = Math.abs(x[i] - y[i]);
      if (e > maxErr) maxErr = e;
      if (e !== 0) changed++;
    }
  }
  check(a.x, b.x);
  check(a.y, b.y);
  check(a.angle, b.angle);
  check(a.field, b.field);
  return { maxErr, changed, equal: changed === 0 };
}

// ── Benchmark runner ─────────────────────────────────────────────────────
function runWorld(agents, steps, seed, mode, threshold, audit) {
  const w = newWorld(agents, seed, mode, threshold, audit);
  const start = performance.now();
  for (let t = 0; t < steps; t++) tick(w);
  return { w, ms: performance.now() - start };
}

// ═══════════════════════════════════════════════════════════════════════════
// ESM exports for FRAYMUS intelligence stack integration
// ═══════════════════════════════════════════════════════════════════════════

export { rng, baselineDecision, newTrustEngine, newWorld, tick, sample };
export { compareWorlds, runWorld };
export { COLS, ROWS, N, CELL, SENSE_ANGLE, TURN_ANGLE, SENSE_LEN };
export { SPEED, DEPOSIT, FADE, MAX_SCENT };

// Factory: create a ternary world ready for stepping
export function createTernaryEngine(config = {}) {
  const {
    agents    = 600,
    seed      = 1979,
    threshold = 3,
    auditEvery = 25,
    mode      = 'ternary',
  } = config;
  return newWorld(agents, seed, mode, threshold, auditEvery);
}

// Step a world forward and return its state
export function stepEngine(world, n = 1) {
  for (let i = 0; i < n; i++) tick(world);
  return {
    steps: world.steps,
    turns: [...world.turns],
    engine: world.engine ? {
      patterns:      world.engine.entries.size,
      queries:       world.engine.queries,
      reused:        world.engine.reused,
      trained:       world.engine.trained,
      audits:        world.engine.audits,
      disagreements: world.engine.disagreements,
      reuseRate:     world.engine.queries > 0
        ? (world.engine.reused / world.engine.queries * 100).toFixed(1) + '%'
        : '0%',
    } : null,
  };
}

// ── Self-test: correctness proof + benchmark ─────────────────────────────
// Runs baseline and ternary with the same seed, proves exact equivalence,
// measures wall-clock speedup.
export function selfTest(config = {}) {
  const {
    agents    = 600,
    steps     = 100,
    seed      = 1979,
    threshold = 3,
    auditEvery = 25,
  } = config;

  // JIT warmup (same code paths, small input)
  runWorld(40, 3, seed, 'baseline', threshold, auditEvery);
  runWorld(40, 3, seed, 'ternary',  threshold, auditEvery);

  // Real benchmark
  const base = runWorld(agents, steps, seed, 'baseline', threshold, auditEvery);
  const tern = runWorld(agents, steps, seed, 'ternary',  threshold, auditEvery);

  const eq  = compareWorlds(base.w, tern.w);
  const eng = tern.w.engine;

  return {
    passed: eq.equal,
    agents,
    steps,
    seed,
    threshold,
    auditEvery,
    correctness: {
      exactEqual:    eq.equal,
      changedValues: eq.changed,
      maxAbsError:   eq.maxErr,
    },
    benchmark: {
      baselineMs: +base.ms.toFixed(3),
      ternaryMs:  +tern.ms.toFixed(3),
      speedRatio: +(base.ms / tern.ms).toFixed(3),
    },
    trustEngine: {
      decisions:     eng.queries,
      trustedReuse:  eng.reused,
      trained:       eng.trained,
      audits:        eng.audits,
      disagreements: eng.disagreements,
      patterns:      eng.entries.size,
      reuseRate:     (100 * eng.reused / eng.queries).toFixed(1) + '%',
    },
    turns: {
      baseline: base.w.turns,
      ternary:  tern.w.turns,
    },
  };
}

// Headless test access (same exports the testbench HTML provides)
if (typeof globalThis !== 'undefined') {
  globalThis.FRAYMUS_TEST = {
    newWorld, tick, runWorld, compareWorlds, baselineDecision, newTrustEngine,
  };
}
