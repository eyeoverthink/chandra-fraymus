// ═══════════════════════════════════════════════════════════════════════════
// Trust-Gated Ternary Computation Engine
// Architect: Vaughn D. Scott | EYEOVERTHINK® #6098807 | ephless llc
//
// Balanced ternary logic {-1, 0, +1} with:
//   - Physarum-inspired agent substrate (sense → decide → deposit)
//   - Temporal pattern recognition across the ternary grid
//   - Trust-gated selective recomputation (skip trusted patterns)
//   - Pattern dictionary that grows through observation
//
// T_{t,l,i,j} ∈ {-1, 0, +1}  — ternary tensor indexed by time, layer, position
// ═══════════════════════════════════════════════════════════════════════════

// ── Ternary Quantizer ─────────────────────────────────────────────────────
// Maps continuous values to {-1, 0, +1} with explicit semantic thresholds.
// The gap between inhibitBelow and activateAbove is the "neutral" zone —
// the region of uncertainty where the system defers judgment.

function quantize(value, inhibitBelow = -0.3, activateAbove = 0.3) {
  if (value <= inhibitBelow) return -1;
  if (value >= activateAbove) return +1;
  return 0;
}

// ── FNV-1a hash for pattern fingerprinting ────────────────────────────────
function fnv1aTrits(trits) {
  let h = 0x811c9dc5;
  for (let i = 0; i < trits.length; i++) {
    h ^= (trits[i] + 1); // map {-1,0,+1} to {0,1,2}
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}

// ── Pattern: a fingerprinted snapshot of a grid region ────────────────────
class TernaryPattern {
  constructor(trits, outcome, context = {}) {
    this.fingerprint = fnv1aTrits(trits);
    this.trits = Int8Array.from(trits);
    this.outcome = outcome;       // the result when this pattern was computed
    this.trustScore = 0.5;        // starts uncertain
    this.hitCount = 0;            // times recognized
    this.matchCount = 0;          // times outcome matched prediction
    this.missCount = 0;           // times outcome diverged
    this.firstSeen = Date.now();
    this.lastSeen = Date.now();
    this.context = context;       // optional metadata (layer, position, etc.)
  }

  recordHit(outcomeMatched) {
    this.hitCount++;
    this.lastSeen = Date.now();
    if (outcomeMatched) {
      this.matchCount++;
    } else {
      this.missCount++;
    }
    // Trust evolves: exponential moving average biased toward recent evidence
    const alpha = 0.15;
    this.trustScore = this.trustScore * (1 - alpha) + (outcomeMatched ? 1 : 0) * alpha;
  }

  get reliable() {
    return this.hitCount >= 3 && this.trustScore >= 0.7;
  }

  get stale() {
    return (Date.now() - this.lastSeen) > 60_000; // 1 minute without a hit
  }
}

// ── Pattern Dictionary ────────────────────────────────────────────────────
// The "shared decoding convention" — sender (grid) and receiver (engine)
// agree on what patterns mean. Grows through observation, prunes stale entries.

class PatternDictionary {
  constructor(maxEntries = 1024) {
    this.patterns = new Map(); // fingerprint → TernaryPattern
    this.maxEntries = maxEntries;
    this.lookups = 0;
    this.hits = 0;
    this.reuses = 0;
    this.recomputes = 0;
  }

  lookup(trits) {
    this.lookups++;
    const fp = fnv1aTrits(trits);
    const pat = this.patterns.get(fp);
    if (pat && this._tritsMatch(pat.trits, trits)) {
      this.hits++;
      return pat;
    }
    return null;
  }

  store(trits, outcome, context) {
    const fp = fnv1aTrits(trits);
    if (this.patterns.has(fp)) {
      return this.patterns.get(fp); // already known
    }
    if (this.patterns.size >= this.maxEntries) {
      this._pruneStale();
    }
    const pat = new TernaryPattern(trits, outcome, context);
    this.patterns.set(fp, pat);
    return pat;
  }

  recordReuse() { this.reuses++; }
  recordRecompute() { this.recomputes++; }

  get efficiency() {
    const total = this.reuses + this.recomputes;
    return total > 0 ? this.reuses / total : 0;
  }

  get stats() {
    let trustedCount = 0;
    for (const p of this.patterns.values()) {
      if (p.reliable) trustedCount++;
    }
    return {
      totalPatterns: this.patterns.size,
      trustedPatterns: trustedCount,
      lookups: this.lookups,
      hits: this.hits,
      hitRate: this.lookups > 0 ? this.hits / this.lookups : 0,
      reuses: this.reuses,
      recomputes: this.recomputes,
      efficiency: this.efficiency,
    };
  }

  _tritsMatch(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  _pruneStale() {
    const entries = [...this.patterns.entries()];
    entries.sort((a, b) => a[1].trustScore - b[1].trustScore);
    const toPrune = Math.max(1, Math.floor(entries.length * 0.1));
    for (let i = 0; i < toPrune; i++) {
      this.patterns.delete(entries[i][0]);
    }
  }
}

// ── Physarum Agent (ternary-aware) ────────────────────────────────────────
// Each agent senses the ternary grid in 3 directions, makes a ternary
// turn decision {-1 left, 0 straight, +1 right}, and deposits scent.
// The agent itself is a trust-aware entity: it tracks whether its decisions
// led to higher scent values (positive feedback = validated pattern).

class TernaryAgent {
  constructor(gridW, gridH, cellSize = 1) {
    this.x = Math.random() * gridW;
    this.y = Math.random() * gridH;
    this.heading = Math.random() * 2 * Math.PI;
    this.speed = 1;
    this.senseAngle = 0.2 * Math.PI;  // ~36 degrees
    this.senseDistance = 8;
    this.turnAngle = 0.2 * Math.PI;
    this.gridW = gridW;
    this.gridH = gridH;
    this.lastDecision = 0;  // ternary: {-1, 0, +1}
    this.decisionsReused = 0;
    this.decisionsComputed = 0;
  }

  sense(grid, angleOffset) {
    const sx = this.x + this.senseDistance * Math.cos(this.heading + angleOffset);
    const sy = this.y + this.senseDistance * Math.sin(this.heading + angleOffset);
    const gx = ((Math.floor(sx) % this.gridW) + this.gridW) % this.gridW;
    const gy = ((Math.floor(sy) % this.gridH) + this.gridH) % this.gridH;
    return grid[gy][gx];
  }

  // Returns the ternary decision: -1 (turn left), 0 (straight), +1 (turn right)
  decide(grid) {
    const left   = this.sense(grid, this.senseAngle);
    const center = this.sense(grid, 0);
    const right  = this.sense(grid, -this.senseAngle);

    if (left > right && left > center)  return -1;  // inhibit rightward = turn left
    if (right > left && right > center) return +1;  // activate rightward = turn right
    return 0;  // neutral = go straight
  }

  update(grid, decision) {
    this.lastDecision = decision;
    if (decision === -1) {
      this.heading += this.turnAngle;
    } else if (decision === +1) {
      this.heading -= this.turnAngle;
    }
    // random jitter on neutral (prevents deadlocks)
    if (decision === 0 && Math.random() < 0.05) {
      this.heading += (Math.random() - 0.5) * this.turnAngle * 0.5;
    }

    this.x = ((this.x + this.speed * Math.cos(this.heading)) % this.gridW + this.gridW) % this.gridW;
    this.y = ((this.y + this.speed * Math.sin(this.heading)) % this.gridH + this.gridH) % this.gridH;
  }

  deposit(grid, amount = 1.0) {
    const gx = ((Math.floor(this.x) % this.gridW) + this.gridW) % this.gridW;
    const gy = ((Math.floor(this.y) % this.gridH) + this.gridH) % this.gridH;
    grid[gy][gx] += amount;
  }
}

// ── Trust-Gated Ternary Computation Engine ────────────────────────────────
// The main engine. Runs a Physarum-like simulation on a ternary grid with
// trust-gated pattern reuse.
//
// Each tick:
//   1. Quantize the continuous scent grid → ternary grid
//   2. For each agent, extract its local ternary neighborhood
//   3. Look up the neighborhood in the pattern dictionary
//   4. If trusted pattern found → REUSE cached decision (skip computation)
//   5. If not → COMPUTE decision normally, store the pattern
//   6. Update agents, deposit scent, diffuse, fade
//   7. Track metrics: operations saved, trust evolution

export class TernaryEngine {
  constructor(config = {}) {
    this.width = config.width || 64;
    this.height = config.height || 64;
    this.agentCount = config.agents || Math.floor(this.width * this.height * 0.3);
    this.scentAmount = config.scentAmount || 5.0;
    this.scentFade = config.scentFade || 0.94;
    this.trustThreshold = config.trustThreshold || 0.7;
    this.neighborhoodRadius = config.neighborhoodRadius || 2; // 5x5 patch
    this.inhibitThreshold = config.inhibitThreshold || -0.3;
    this.activateThreshold = config.activateThreshold || 0.3;

    // Diffusion kernel (same as Physarum: center-weighted 3x3)
    this.kernel = [[1, 1, 1], [1, 4, 1], [1, 1, 1]];
    this.kernelSum = 12;

    // State
    this.scent = [];          // continuous scent grid (float)
    this.ternary = [];        // quantized ternary grid (int8: -1, 0, +1)
    this.agents = [];
    this.dictionary = new PatternDictionary(config.maxPatterns || 2048);
    this.tick = 0;
    this.generation = 0;

    // Metrics
    this.metrics = {
      totalDecisions: 0,
      reusedDecisions: 0,
      computedDecisions: 0,
      trustGateHistory: [],   // per-tick efficiency snapshots
    };

    this._init();
  }

  _init() {
    // Initialize scent grid with small random values
    for (let r = 0; r < this.height; r++) {
      this.scent[r] = new Float64Array(this.width);
      this.ternary[r] = new Int8Array(this.width);
      for (let c = 0; c < this.width; c++) {
        this.scent[r][c] = (Math.random() - 0.5) * 2; // [-1, 1]
      }
    }

    // Spawn agents
    for (let i = 0; i < this.agentCount; i++) {
      this.agents.push(new TernaryAgent(this.width, this.height));
    }

    // Initial quantization
    this._quantizeGrid();
  }

  // ── Core tick ───────────────────────────────────────────────────────────
  step() {
    this.tick++;

    // 1. Quantize scent → ternary
    this._quantizeGrid();

    // 2. For each agent: trust-gated decision
    let tickReused = 0;
    let tickComputed = 0;

    for (const agent of this.agents) {
      const neighborhood = this._extractNeighborhood(
        Math.floor(agent.x), Math.floor(agent.y)
      );

      const pattern = this.dictionary.lookup(neighborhood);
      let decision;

      if (pattern && pattern.reliable) {
        // TRUST GATE: reuse cached decision
        decision = pattern.outcome;
        tickReused++;
        this.dictionary.recordReuse();
        agent.decisionsReused++;

        // Verify occasionally (10% spot-check to maintain trust accuracy)
        if (Math.random() < 0.1) {
          const actual = agent.decide(this.scent);
          pattern.recordHit(actual === decision);
        }
      } else {
        // COMPUTE normally
        decision = agent.decide(this.scent);
        tickComputed++;
        this.dictionary.recordRecompute();
        agent.decisionsComputed++;

        // Store or update pattern
        if (pattern) {
          const actual = decision;
          pattern.recordHit(actual === pattern.outcome);
        } else {
          this.dictionary.store(neighborhood, decision, {
            tick: this.tick,
            agentX: Math.floor(agent.x),
            agentY: Math.floor(agent.y),
          });
        }
      }

      // 3. Update agent state
      agent.update(this.scent, decision);
      agent.deposit(this.scent, this.scentAmount);

      this.metrics.totalDecisions++;
    }

    this.metrics.reusedDecisions += tickReused;
    this.metrics.computedDecisions += tickComputed;

    // 4. Diffuse and fade scent
    this._diffuse();
    this._fade();

    // 5. Record efficiency snapshot every 10 ticks
    if (this.tick % 10 === 0) {
      const total = tickReused + tickComputed;
      this.metrics.trustGateHistory.push({
        tick: this.tick,
        reused: tickReused,
        computed: tickComputed,
        efficiency: total > 0 ? tickReused / total : 0,
        trustedPatterns: this.dictionary.stats.trustedPatterns,
        totalPatterns: this.dictionary.stats.totalPatterns,
      });
    }

    return this.getSnapshot();
  }

  // Run N ticks, return final snapshot
  run(ticks = 100) {
    for (let i = 0; i < ticks; i++) {
      this.step();
    }
    return this.getSnapshot();
  }

  // ── Grid operations ─────────────────────────────────────────────────────

  _quantizeGrid() {
    // Normalize scent to [-1, 1] range, then quantize
    let maxAbs = 0;
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        maxAbs = Math.max(maxAbs, Math.abs(this.scent[r][c]));
      }
    }
    const scale = maxAbs > 0 ? 1 / maxAbs : 1;

    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        this.ternary[r][c] = quantize(
          this.scent[r][c] * scale,
          this.inhibitThreshold,
          this.activateThreshold
        );
      }
    }
  }

  _extractNeighborhood(cx, cy) {
    const r = this.neighborhoodRadius;
    const size = (2 * r + 1) * (2 * r + 1);
    const patch = new Int8Array(size);
    let idx = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const gy = ((cy + dy) % this.height + this.height) % this.height;
        const gx = ((cx + dx) % this.width + this.width) % this.width;
        patch[idx++] = this.ternary[gy][gx];
      }
    }
    return patch;
  }

  _diffuse() {
    const temp = [];
    for (let r = 0; r < this.height; r++) {
      temp[r] = new Float64Array(this.width);
    }
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        let sum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = ((r + dr) % this.height + this.height) % this.height;
            const nc = ((c + dc) % this.width + this.width) % this.width;
            sum += this.scent[nr][nc] * this.kernel[dr + 1][dc + 1];
          }
        }
        temp[r][c] = sum / this.kernelSum;
      }
    }
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        this.scent[r][c] = temp[r][c];
      }
    }
  }

  _fade() {
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        this.scent[r][c] *= this.scentFade;
      }
    }
  }

  // ── Snapshot / stats ────────────────────────────────────────────────────

  getSnapshot() {
    const total = this.metrics.reusedDecisions + this.metrics.computedDecisions;
    return {
      tick: this.tick,
      gridSize: [this.width, this.height],
      agentCount: this.agents.length,
      efficiency: total > 0 ? this.metrics.reusedDecisions / total : 0,
      dictionary: this.dictionary.stats,
      metrics: {
        totalDecisions: this.metrics.totalDecisions,
        reused: this.metrics.reusedDecisions,
        computed: this.metrics.computedDecisions,
        savingsPercent: total > 0
          ? ((this.metrics.reusedDecisions / total) * 100).toFixed(1) + '%'
          : '0%',
      },
      recentHistory: this.metrics.trustGateHistory.slice(-10),
    };
  }

  // Export the ternary grid as a flat array for visualization
  getTernaryFlat() {
    const flat = new Int8Array(this.width * this.height);
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        flat[r * this.width + c] = this.ternary[r][c];
      }
    }
    return flat;
  }

  // Export agent positions for visualization
  getAgentPositions() {
    return this.agents.map(a => ({
      x: a.x,
      y: a.y,
      heading: a.heading,
      lastDecision: a.lastDecision,
      reused: a.decisionsReused,
      computed: a.decisionsComputed,
    }));
  }

  // Mutate: change one parameter and see how the trust gate adapts
  mutate(param, value) {
    if (param === 'trustThreshold') this.trustThreshold = value;
    if (param === 'scentFade') this.scentFade = value;
    if (param === 'scentAmount') this.scentAmount = value;
    if (param === 'inhibitThreshold') this.inhibitThreshold = value;
    if (param === 'activateThreshold') this.activateThreshold = value;
    this.generation++;
    return { generation: this.generation, param, value };
  }

  // Reset the pattern dictionary (force full recompute, trust rebuilds)
  resetTrust() {
    this.dictionary = new PatternDictionary(this.dictionary.maxEntries);
    this.generation++;
    return { generation: this.generation, message: 'Trust reset — all patterns must be re-earned' };
  }
}

// ── Factory for fleet tool integration ────────────────────────────────────

export function createTernaryEngine(config) {
  return new TernaryEngine(config);
}

// ── Quick self-test (run with: node --experimental-vm-modules ternary-engine.js) ──
export function selfTest() {
  const engine = new TernaryEngine({ width: 32, height: 32, agents: 200 });
  const result = engine.run(200);
  return {
    passed: result.efficiency > 0,
    ...result,
    message: result.efficiency > 0.1
      ? `Trust gate working: ${result.metrics.savingsPercent} of decisions reused`
      : 'Trust gate warming up — patterns not yet reliable (normal for small grids)',
  };
}
