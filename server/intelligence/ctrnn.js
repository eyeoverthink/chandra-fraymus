import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';
import { runPipeline as opegPipeline } from './opeg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, 'ctrnn-worker.js');
const now = () => Date.now();

/**
 * CTRNN Neural Core — Continuous-Time Recurrent Neural Network
 *
 * Port of the Java LogicCircuit Euler integrator to Node.js.
 * Original: ForkJoinPool parallelism → Node.js worker_threads
 *
 * Dynamics:
 *   B[i] += (dt/τ)(−B[i] + Σⱼ W[i][j]·tanh(B[j]+Θ[j]) + I_ext[i])
 *
 * Subsystems:
 *   1. Euler integration (parallelized via worker_threads)
 *   2. Synaptic pruning (activity-dependent exponential decay)
 *   3. Dead zone cleanup (|W| < threshold → W = 0)
 *   4. Autonomous neurogenesis (re-ignition of dead synapses)
 *   5. Biosphere perturbation (predator/prey weight mutations)
 *   6. State broadcast (B(t) → WebSocket)
 */

const DEFAULT_CONFIG = {
  gridSize: 16,
  dt: 16.67,
  tau: 50,
  pruneRate: 0.001,
  deadZone: 0.001,
  neurogenesisThreshold: 0.1,
  biosphereRate: 0.01,
  predatorCount: 3,
  preyCount: 5,
  workerCount: 2,
  tickRate: 60,
  connectivityFloor: 0.05,
  // Hebbian plasticity: co-active neurons strengthen their mutual connections.
  // 0.01 (was 0.003): with homeostatic scaling holding activity graded, the old rate
  // produced no measurable learning (probe variants A/I: maxW never exceeded 0.17).
  hebbianRate: 0.01,
  hebbianDecay: 0.0001,
  // Spatial locality: neurogenesis probability decays with grid distance
  spatialSigma: 3.0,
  // Per-weight clamp: caps individual synaptic weights so Hebbian can
  // strengthen cluster connections without runaway growth, while leaving
  // non-cluster connections free to stay weak. This replaces per-neuron
  // budget normalization which homogenized all weights.
  maxWeight: 2.0,
  // Homeostasis (Phase O). Without it the initial random weights already drive every
  // neuron past tanh saturation (mean |B| ~ 70 at tick 255, ~240 at steady state),
  // Hebbian then pins every weight at maxWeight within ~20s, and Phi freezes at the
  // clamp's attractor value (0.7718 for 1,433 consecutive audits).
  // Synaptic scaling (Turrigiano): bound each neuron's incoming L1 weight norm so the
  // recurrent drive stays in the dynamic range of tanh. Multiplicative, so relative
  // weights within a neuron keep their heterogeneity.
  targetIncomingNorm: 3.0,
  scalingUpRate: 0.01,
  // Neurogenesis floor as synapse density. The old absolute-weight floor (0.05) is
  // unreachable once scaling holds mean |W| near 0.01, which left neurogenesis in
  // permanent ignition (19k -> 43k synapses in 1,800 ticks).
  connectivityFloorDensity: 0.03,
  targetDensity: 0.06,
  // Synaptic competition: a bounded norm spread evenly over ~100 inputs (mean |W| ~0.015)
  // leaves no subset with enough mutual coupling to be bistable, so EI and Phi read 0.
  // Weights below competitionRatio x the row's strongest decay each tick, concentrating
  // the budget on a few strong partners — the clustered topology Phi needs.
  // Off by default: ratio competition homogenized rows (probes C/D/E); the synapse budget
  // below supersedes it. Kept as an optional knob.
  competitionRatio: 0,
  competitionDecay: 0.995,
  // Newborn synapse amplitude. Births near or above the learned weights reset every
  // row's maximum and keep competition from ever concentrating the norm.
  birthAmplitude: 0.05,
  // Reciprocity bias: a new synapse i<-j spawns j<-i with this probability. Cortex
  // over-represents bidirectional pairs ~4x (Song et al. 2005); with Dale's law this
  // yields E<->I loops, the mixed-sign recurrence Phi_MIP needs (feed-forward clusters
  // score EI up to 2 bits yet Phi = 0 because one bipartition explains them).
  reciprocalBias: 0.8,
  // Synapse budget per neuron (0 = off). Multiplicative scaling plus ratio competition
  // homogenizes weights (meanW 0.058 vs maxW 0.083 in probes) so no 4-subset ever
  // reaches the ~1.0 mutual coupling the isolated Phi measurement needs. Keeping only
  // the K strongest incoming synapses concentrates the norm on K partners by construction.
  maxIncomingSynapses: 16,
  // E/I balance (Dale's law). Hebbian learning alone drives every surviving weight to the
  // same sign, so a 4-subset is one all-up/all-down switch: EI = 1 bit, Phi = 0. The
  // frozen network scored Phi 0.77 only because its +-2.0 weights had random signs.
  // A fixed inhibitory population with strictly negative outgoing weights and
  // homeostatic inhibitory plasticity (Vogels iSTDP: co-activity strengthens inhibition)
  // gives mixed-sign coupling and cancels runaway excitation.
  inhibitoryFraction: 0.2,
  inhibitoryRate: 0.01,
  // Intrinsic plasticity: adapt Theta so each neuron's mean output sits near the
  // centre of tanh instead of a rail.
  intrinsicRate: 0.01,
  maxTheta: 3.0,
  // Hard safety on membrane potential; dynamics never need this once scaling holds.
  maxB: 50,
  // Full-state persistence so a restart resumes the network instead of resetting it.
  persistEveryTicks: 3600,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ctrnn_snapshots (
      id TEXT PRIMARY KEY,
      tick INTEGER NOT NULL,
      neuron_count INTEGER,
      active_synapses INTEGER,
      total_activation REAL,
      mean_weight REAL,
      pruned_count INTEGER,
      neurogenesis_count INTEGER,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ctrnn_tick ON ctrnn_snapshots(tick)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ctrnn_ts ON ctrnn_snapshots(created_at)`).run();
  } catch (_) {}
}

ensureTable();

export function createCTRNN(config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const N = cfg.gridSize * cfg.gridSize;

  let B = new Float64Array(N);
  let W = new Float64Array(N * N);
  let Theta = new Float64Array(N);
  let Iext = new Float64Array(N);

  let tick = 0;
  let running = false;
  let tickTimer = null;
  let stats = { pruned: 0, neurogenesis: 0, predatorEvents: 0, preyEvents: 0 };
  // inhibitory[j] = 1 → neuron j's outgoing weights (column j) are ≤ 0.
  let inhibitory = new Uint8Array(N);

  function assignInhibitory() {
    inhibitory = new Uint8Array(N);
    const frac = cfg.inhibitoryFraction;
    if (!(frac > 0)) return;
    const count = Math.round(N * frac);
    const idx = Array.from({ length: N }, (_, i) => i);
    for (let i = N - 1; i > 0; i--) { const r = Math.floor(Math.random() * (i + 1)); [idx[i], idx[r]] = [idx[r], idx[i]]; }
    for (let k = 0; k < count; k++) inhibitory[idx[k]] = 1;
  }

  // Dale's law: sign of W[i][j] follows the presynaptic neuron j.
  function daleSign(j, magnitude) {
    return inhibitory[j] ? -Math.abs(magnitude) : Math.abs(magnitude);
  }

  function initializeRandom() {
    assignInhibitory();
    for (let i = 0; i < N; i++) {
      B[i] = (Math.random() - 0.5) * 0.1;
      Theta[i] = (Math.random() - 0.5) * 0.2;
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const idx = i * N + j;
        W[idx] = Math.random() < 0.3 ? daleSign(j, (Math.random() - 0.5) * 0.5) : 0;
      }
    }
  }

  function eulerStepSync() {
    const dtTau = cfg.dt / cfg.tau;
    const newB = new Float64Array(N);

    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let j = 0; j < N; j++) {
        sum += W[i * N + j] * Math.tanh(B[j] + Theta[j]);
      }
      newB[i] = B[i] + dtTau * (-B[i] + sum + Iext[i]);
    }

    B = newB;
  }

  async function eulerStepParallel() {
    const chunkSize = Math.ceil(N / cfg.workerCount);
    const promises = [];

    for (let w = 0; w < cfg.workerCount; w++) {
      const startIdx = w * chunkSize;
      const endIdx = Math.min(startIdx + chunkSize, N);
      if (startIdx >= endIdx) break;

      promises.push(new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_PATH, {
          workerData: {
            startIdx, endIdx,
            dt: cfg.dt, tau: cfg.tau,
            B: Array.from(B),
            W: Array.from(W),
            Theta: Array.from(Theta),
            Iext: Array.from(Iext),
            gridSize: cfg.gridSize,
          },
        });
        worker.on('message', (msg) => {
          resolve(msg);
          worker.terminate();
        });
        worker.on('error', (err) => {
          reject(err);
          worker.terminate();
        });
        setTimeout(() => {
          reject(new Error('Worker timeout'));
          worker.terminate();
        }, 5000);
      }));
    }

    const results = await Promise.all(promises);

    for (const { startIdx, endIdx, newB } of results) {
      for (let i = 0; i < newB.length; i++) {
        B[startIdx + i] = newB[i];
      }
    }
  }

  function prune() {
    let pruned = 0;
    for (let i = 0; i < N; i++) {
      const activity = Math.abs(Math.tanh(B[i]));
      for (let j = 0; j < N; j++) {
        const idx = i * N + j;
        if (W[idx] === 0) continue;
        W[idx] *= (1 - cfg.pruneRate * (1 - activity) * cfg.dt / 1000);
        if (Math.abs(W[idx]) < cfg.deadZone) {
          W[idx] = 0;
          pruned++;
        }
      }
    }
    stats.pruned += pruned;
    return pruned;
  }

  // Given a new synapse i<-j, maybe create the return path j<-i.
  function birthReciprocal(i, j, amplitude) {
    if (i === j || !(cfg.reciprocalBias > 0)) return 0;
    const back = j * N + i;
    if (W[back] !== 0 || Math.random() >= cfg.reciprocalBias) return 0;
    W[back] = daleSign(i, (Math.random() - 0.5) * amplitude);
    return 1;
  }

  function neurogenesis() {
    let count = 0;
    let active = 0;
    for (let i = 0; i < N * N; i++) if (W[i] !== 0) active++;
    const density = active / (N * N);
    const sigma = cfg.spatialSigma;
    const sigma2x2 = 2 * sigma * sigma;

    if (density < cfg.connectivityFloorDensity) {
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const idx = i * N + j;
          if (W[idx] !== 0) continue;
          const d = gridDist(i, j);
          const spatialP = Math.exp(-(d * d) / sigma2x2);
          if (Math.random() < cfg.neurogenesisThreshold * spatialP) {
            W[idx] = daleSign(j, (Math.random() - 0.5) * cfg.birthAmplitude);
            count++;
            count += birthReciprocal(i, j, cfg.birthAmplitude);
          }
        }
      }
    } else {
      const lambda = 0.02 * (1 - density / cfg.targetDensity);
      if (lambda > 0) {
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            const idx = i * N + j;
            if (W[idx] !== 0) continue;
            const d = gridDist(i, j);
            const spatialP = Math.exp(-(d * d) / sigma2x2);
            if (Math.random() < lambda * spatialP) {
              W[idx] = daleSign(j, (Math.random() - 0.5) * cfg.birthAmplitude * 0.67);
              count++;
              count += birthReciprocal(i, j, cfg.birthAmplitude * 0.67);
            }
          }
        }
      }
    }

    stats.neurogenesis += count;
    return count;
  }

  function biosphere() {
    let predatorEvents = 0;
    let preyEvents = 0;

    for (let p = 0; p < cfg.predatorCount; p++) {
      if (Math.random() < cfg.biosphereRate) {
        const i = Math.floor(Math.random() * N);
        const j = Math.floor(Math.random() * N);
        W[i * N + j] = daleSign(j, (Math.random() - 0.5) * 0.4);
        predatorEvents++;
      }
    }

    for (let p = 0; p < cfg.preyCount; p++) {
      if (Math.random() < cfg.biosphereRate * 0.5) {
        const i = Math.floor(Math.random() * N);
        B[i] *= 0.9;
        preyEvents++;
      }
    }

    stats.predatorEvents += predatorEvents;
    stats.preyEvents += preyEvents;
    return { predatorEvents, preyEvents };
  }

  // Hebbian plasticity: ΔW[i][j] = η · tanh(B[i]) · tanh(B[j]) - decay
  // Co-active neurons strengthen, uncorrelated ones weaken → clustered topology
  function hebbianPlasticity() {
    const eta = cfg.hebbianRate;
    const etaI = cfg.inhibitoryRate;
    const decay = cfg.hebbianDecay;
    if (eta <= 0) return;

    for (let i = 0; i < N; i++) {
      const ai = Math.tanh(B[i] + Theta[i]);
      for (let j = 0; j < N; j++) {
        const idx = i * N + j;
        if (W[idx] === 0) continue;
        const aj = Math.tanh(B[j] + Theta[j]);
        if (inhibitory[j]) {
          // Inhibitory plasticity (Vogels): co-activity strengthens inhibition onto the
          // post-synaptic neuron — homeostatic, pushes the E/I balance toward cancellation.
          W[idx] -= etaI * Math.abs(ai * aj) - decay * W[idx];
        } else {
          // Hebbian: strengthen co-active, weaken anti-correlated
          W[idx] += eta * ai * aj - decay * W[idx];
        }
      }
    }
  }

  // Per-weight clamp: cap each synaptic weight individually so Hebbian
  // can strengthen specific connections (creating clusters) without
  // runaway growth. Unlike per-neuron normalization, this preserves
  // weight heterogeneity — essential for Phi (integrated information).
  function clampWeights() {
    const maxW = cfg.maxWeight;
    const dale = cfg.inhibitoryFraction > 0;

    for (let i = 0; i < N; i++) {
      const row = i * N;
      for (let j = 0; j < N; j++) {
        const idx = row + j;
        let w = W[idx];
        if (w === 0) continue;
        // Dale's law: a synapse that drifts across zero is lost, not flipped.
        if (dale && ((inhibitory[j] && w > 0) || (!inhibitory[j] && w < 0))) { W[idx] = 0; continue; }
        if (maxW > 0) {
          if (w > maxW) w = maxW;
          else if (w < -maxW) w = -maxW;
          W[idx] = w;
        }
      }
    }
  }

  // Synaptic scaling: per-neuron incoming L1 norm bounded at targetIncomingNorm.
  // Downscale hard when over; nudge up slowly when a live neuron has gone quiet.
  function synapticScaling() {
    const target = cfg.targetIncomingNorm;
    if (!(target > 0)) return 0;
    let scaled = 0;
    const compRatio = cfg.competitionRatio;
    const compDecay = cfg.competitionDecay;
    const K = cfg.maxIncomingSynapses | 0;
    for (let i = 0; i < N; i++) {
      const row = i * N;
      let norm = 0;
      let rowMax = 0;
      for (let j = 0; j < N; j++) {
        const a = Math.abs(W[row + j]);
        norm += a;
        if (a > rowMax) rowMax = a;
      }
      if (norm === 0) continue;
      if (compRatio > 0 && compDecay < 1) {
        const floor = rowMax * compRatio;
        for (let j = 0; j < N; j++) {
          const w = W[row + j];
          if (w !== 0 && Math.abs(w) < floor) W[row + j] = w * compDecay;
        }
      }
      if (K > 0) {
        let active = 0;
        for (let j = 0; j < N; j++) if (W[row + j] !== 0) active++;
        if (active > K) {
          const mags = [];
          for (let j = 0; j < N; j++) if (W[row + j] !== 0) mags.push(Math.abs(W[row + j]));
          mags.sort((a, b) => b - a);
          const cutoff = mags[K - 1];
          let kept = 0;
          for (let j = 0; j < N; j++) {
            const a = Math.abs(W[row + j]);
            if (a === 0) continue;
            if (a > cutoff || (a === cutoff && kept < K)) { kept++; }
            else { norm -= a; W[row + j] = 0; stats.pruned++; }
          }
        }
      }
      let factor = 1;
      if (norm > target) factor = target / norm;
      else if (norm < target * 0.5) factor = 1 + cfg.scalingUpRate;
      if (factor !== 1) {
        for (let j = 0; j < N; j++) W[row + j] *= factor;
        scaled++;
      }
    }
    return scaled;
  }

  // Intrinsic plasticity: Theta drifts against each neuron's output so the
  // operating point returns toward tanh's linear region.
  function intrinsicPlasticity() {
    const rate = cfg.intrinsicRate;
    if (!(rate > 0)) return;
    const maxT = cfg.maxTheta;
    for (let i = 0; i < N; i++) {
      Theta[i] -= rate * Math.tanh(B[i] + Theta[i]);
      if (Theta[i] > maxT) Theta[i] = maxT;
      else if (Theta[i] < -maxT) Theta[i] = -maxT;
    }
  }

  function clampMembrane() {
    const maxB = cfg.maxB;
    if (!(maxB > 0)) return;
    for (let i = 0; i < N; i++) {
      if (B[i] > maxB) B[i] = maxB;
      else if (B[i] < -maxB) B[i] = -maxB;
      else if (Number.isNaN(B[i])) B[i] = 0;
    }
  }

  // Grid distance between two neuron indices on the 16x16 grid
  function gridDist(a, b) {
    const ax = a % cfg.gridSize, ay = (a / cfg.gridSize) | 0;
    const bx = b % cfg.gridSize, by = (b / cfg.gridSize) | 0;
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function injectGaussian(tx, ty, sigma = 2.0, amplitude = 1.0) {
    for (let i = 0; i < N; i++) {
      const ix = i % cfg.gridSize;
      const iy = Math.floor(i / cfg.gridSize);
      const dx = ix - tx;
      const dy = iy - ty;
      const dist2 = dx * dx + dy * dy;
      Iext[i] += amplitude * Math.exp(-dist2 / (2 * sigma * sigma));
    }
  }

  function decayExternalInput(rate = 0.95) {
    for (let i = 0; i < N; i++) {
      Iext[i] *= rate;
    }
  }

  function computeMetrics() {
    let totalActivation = 0;
    let activeSynapses = 0;
    let totalWeight = 0;
    let saturated = 0;
    let atClamp = 0;
    let totalIncomingNorm = 0;
    let maxWeightSeen = 0;
    const maxW = cfg.maxWeight;

    for (let i = 0; i < N; i++) {
      totalActivation += Math.abs(B[i]);
      if (Math.abs(Math.tanh(B[i] + Theta[i])) > 0.95) saturated++;
      let norm = 0;
      const row = i * N;
      for (let j = 0; j < N; j++) {
        const w = W[row + j];
        if (w !== 0) {
          const a = Math.abs(w);
          activeSynapses++;
          totalWeight += a;
          norm += a;
          if (a > maxWeightSeen) maxWeightSeen = a;
          if (maxW > 0 && a >= maxW - 1e-9) atClamp++;
        }
      }
      totalIncomingNorm += norm;
    }

    return {
      neuronCount: N,
      totalActivation,
      meanActivation: totalActivation / N,
      activeSynapses,
      totalSynapses: N * N,
      connectivityRatio: activeSynapses / (N * N),
      meanWeight: activeSynapses > 0 ? totalWeight / activeSynapses : 0,
      // Phase O health signals: how many neurons sit on a tanh rail, how many
      // weights sit on the clamp, and the mean incoming norm scaling holds to.
      saturationRatio: saturated / N,
      clampedRatio: activeSynapses > 0 ? atClamp / activeSynapses : 0,
      meanIncomingNorm: totalIncomingNorm / N,
      maxWeightSeen,
      inhibitoryCount: inhibitory.reduce((s, v) => s + v, 0),
    };
  }

  async function step(parallel = false) {
    tick++;

    if (parallel && N >= 64) {
      await eulerStepParallel();
    } else {
      eulerStepSync();
    }

    hebbianPlasticity();
    synapticScaling();
    clampWeights();
    intrinsicPlasticity();
    clampMembrane();
    const pruned = prune();
    const neuroCount = neurogenesis();
    const bio = biosphere();
    decayExternalInput();

    if (cfg.persistEveryTicks > 0 && tick % cfg.persistEveryTicks === 0 && persistPath) {
      persistTo(persistPath);
    }

    if (tick % 600 === 0) {
      const metrics = computeMetrics();
      const id = randomUUID().slice(0, 12);
      try {
        db.prepare(`INSERT INTO ctrnn_snapshots (id, tick, neuron_count, active_synapses, total_activation, mean_weight, pruned_count, neurogenesis_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, tick, metrics.neuronCount, metrics.activeSynapses,
          metrics.totalActivation, metrics.meanWeight, pruned, neuroCount, now()
        );
      } catch (_) {}

      try {
        db.prepare(`DELETE FROM ctrnn_snapshots WHERE created_at < ?`).run(now() - 7 * 86400_000);
      } catch (_) {}
    }

    return { tick, pruned, neurogenesis: neuroCount, biosphere: bio };
  }

  function getState() {
    return {
      B: Array.from(B),
      gridSize: cfg.gridSize,
      tick,
    };
  }

  let persistPath = null;
  let lastPersistAt = 0;

  function persistTo(path) {
    try {
      const payload = {
        version: 1,
        tick,
        gridSize: cfg.gridSize,
        B: Array.from(B),
        W: Array.from(W),
        Theta: Array.from(Theta),
        Iext: Array.from(Iext),
        inhibitory: Array.from(inhibitory),
        stats: { ...stats },
        metrics: computeMetrics(),
        ts: now(),
      };
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, path);
      lastPersistAt = now();
      return { persisted: true, tick, path };
    } catch (e) {
      console.error(`[ctrnn] persist failed: ${e.message}`);
      return { persisted: false, error: e.message };
    }
  }

  function getWeightMatrix() {
    return {
      W: Array.from(W),
      N,
      gridSize: cfg.gridSize,
    };
  }

  return {
    get tick() { return tick; },
    get running() { return running; },
    get config() { return { ...cfg }; },

    initialize() {
      initializeRandom();
      tick = 0;
      stats = { pruned: 0, neurogenesis: 0, predatorEvents: 0, preyEvents: 0 };
    },

    async step(parallel = false) {
      return step(parallel);
    },

    start(broadcast) {
      if (running) return;
      running = true;
      if (tick === 0) this.initialize();

      const intervalMs = Math.round(1000 / cfg.tickRate);
      let lastBroadcast = 0;

      tickTimer = setInterval(async () => {
        try {
          const result = await step(false);

          if (now() - lastBroadcast > 100) {
            const state = getState();
            broadcast?.('ctrnn', {
              type: 'tick',
              tick: state.tick,
              B: state.B,
              gridSize: state.gridSize,
              metrics: computeMetrics(),
            });
            lastBroadcast = now();
          }
        } catch (err) {
          console.error(`CTRNN tick error: ${err.message}`);
        }
      }, intervalMs);

      publish('ctrnn', 'system.ctrnn', JSON.stringify({ event: 'start', N, gridSize: cfg.gridSize, tickRate: cfg.tickRate, resumed: tick > 0 }));
    },

    stop() {
      if (!running) return;
      running = false;
      clearInterval(tickTimer);
      tickTimer = null;
      if (persistPath) persistTo(persistPath);
      publish('ctrnn', 'system.ctrnn', JSON.stringify({ event: 'stop', tick, stats }));
    },

    setPersistPath(path) { persistPath = path || null; },
    persist() { return persistPath ? persistTo(persistPath) : { persisted: false, error: 'no persist path' }; },
    get lastPersistAt() { return lastPersistAt; },

    restoreFromFile(path) {
      if (!existsSync(path)) return { restored: false, reason: 'no_state_file' };
      try {
        const snap = JSON.parse(readFileSync(path, 'utf8'));
        this.restore(snap);
        return { restored: true, tick, ts: snap.ts, activeSynapses: snap.metrics?.activeSynapses };
      } catch (e) {
        console.error(`[ctrnn] restore failed, starting fresh: ${e.message}`);
        return { restored: false, reason: e.message };
      }
    },

    inject(tx, ty, sigma, amplitude) {
      injectGaussian(tx, ty, sigma, amplitude);
    },

    modulatePlasticity(overrides = {}) {
      const before = { hebbianRate: cfg.hebbianRate, hebbianDecay: cfg.hebbianDecay, pruneRate: cfg.pruneRate, neurogenesisThreshold: cfg.neurogenesisThreshold, biosphereRate: cfg.biosphereRate };
      if (overrides.hebbianRate !== undefined) cfg.hebbianRate = Math.max(0, Math.min(0.05, overrides.hebbianRate));
      if (overrides.hebbianDecay !== undefined) cfg.hebbianDecay = Math.max(0, Math.min(0.01, overrides.hebbianDecay));
      if (overrides.pruneRate !== undefined) cfg.pruneRate = Math.max(0, Math.min(0.02, overrides.pruneRate));
      if (overrides.neurogenesisThreshold !== undefined) cfg.neurogenesisThreshold = Math.max(0, Math.min(0.5, overrides.neurogenesisThreshold));
      if (overrides.biosphereRate !== undefined) cfg.biosphereRate = Math.max(0, Math.min(0.1, overrides.biosphereRate));
      return { before, after: { hebbianRate: cfg.hebbianRate, hebbianDecay: cfg.hebbianDecay, pruneRate: cfg.pruneRate, neurogenesisThreshold: cfg.neurogenesisThreshold, biosphereRate: cfg.biosphereRate } };
    },

    get baseConfig() { return { ...DEFAULT_CONFIG }; },

    state() {
      return getState();
    },

    weights() {
      return getWeightMatrix();
    },

    metrics() {
      return computeMetrics();
    },

    stats() {
      return { tick, running, ...stats, ...computeMetrics() };
    },

    history({ limit = 50 } = {}) {
      return db.prepare(`SELECT * FROM ctrnn_snapshots ORDER BY created_at DESC LIMIT ?`).all(
        Math.min(200, Math.max(1, limit))
      );
    },

    snapshot() {
      return {
        tick,
        B: Array.from(B),
        W: Array.from(W),
        Theta: Array.from(Theta),
        Iext: Array.from(Iext),
        inhibitory: Array.from(inhibitory),
        metrics: computeMetrics(),
        stats: { ...stats },
        gridSize: cfg.gridSize,
        ts: now(),
      };
    },

    restore(snap) {
      if (!snap || !snap.B || !snap.W || !snap.Theta) {
        throw new Error('Invalid snapshot: missing B, W, or Theta');
      }
      if (snap.B.length !== N || snap.Theta.length !== N) {
        throw new Error(`Snapshot size mismatch: expected N=${N}, got B=${snap.B.length}`);
      }
      if (snap.W.length !== N * N) {
        throw new Error(`Snapshot weight mismatch: expected ${N * N}, got ${snap.W.length}`);
      }
      B = new Float64Array(snap.B);
      W = new Float64Array(snap.W);
      Theta = new Float64Array(snap.Theta);
      Iext = snap.Iext ? new Float64Array(snap.Iext) : new Float64Array(N);
      if (snap.inhibitory && snap.inhibitory.length === N) inhibitory = new Uint8Array(snap.inhibitory);
      else assignInhibitory();
      tick = snap.tick || 0;
      if (snap.stats) stats = { ...stats, ...snap.stats };
    },
  };
}
