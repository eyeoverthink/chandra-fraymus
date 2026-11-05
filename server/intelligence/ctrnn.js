import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
  // Hebbian plasticity: co-active neurons strengthen their mutual connections
  hebbianRate: 0.003,
  hebbianDecay: 0.0001,
  // Spatial locality: neurogenesis probability decays with grid distance
  spatialSigma: 3.0,
  // Per-weight clamp: caps individual synaptic weights so Hebbian can
  // strengthen cluster connections without runaway growth, while leaving
  // non-cluster connections free to stay weak. This replaces per-neuron
  // budget normalization which homogenized all weights.
  maxWeight: 2.0,
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

  function initializeRandom() {
    for (let i = 0; i < N; i++) {
      B[i] = (Math.random() - 0.5) * 0.1;
      Theta[i] = (Math.random() - 0.5) * 0.2;
    }
    for (let i = 0; i < N * N; i++) {
      W[i] = Math.random() < 0.3 ? (Math.random() - 0.5) * 0.5 : 0;
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

  function neurogenesis() {
    let count = 0;
    const totalW = W.reduce((s, v) => s + Math.abs(v), 0);
    const avgW = totalW / (N * N);
    const sigma = cfg.spatialSigma;
    const sigma2x2 = 2 * sigma * sigma;

    if (avgW < cfg.connectivityFloor) {
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const idx = i * N + j;
          if (W[idx] !== 0) continue;
          const d = gridDist(i, j);
          const spatialP = Math.exp(-(d * d) / sigma2x2);
          if (Math.random() < cfg.neurogenesisThreshold * spatialP) {
            W[idx] = (Math.random() - 0.5) * 0.3;
            count++;
          }
        }
      }
    } else {
      const lambda = 0.02 * (1 - avgW / 0.5);
      if (lambda > 0) {
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) {
            const idx = i * N + j;
            if (W[idx] !== 0) continue;
            const d = gridDist(i, j);
            const spatialP = Math.exp(-(d * d) / sigma2x2);
            if (Math.random() < lambda * spatialP) {
              W[idx] = (Math.random() - 0.5) * 0.2;
              count++;
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
        W[i * N + j] = (Math.random() - 0.5) * 0.4;
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
    const decay = cfg.hebbianDecay;
    if (eta <= 0) return;

    for (let i = 0; i < N; i++) {
      const ai = Math.tanh(B[i] + Theta[i]);
      for (let j = 0; j < N; j++) {
        const idx = i * N + j;
        if (W[idx] === 0) continue;
        const aj = Math.tanh(B[j] + Theta[j]);
        // Hebbian: strengthen co-active, weaken anti-correlated
        W[idx] += eta * ai * aj - decay * W[idx];
      }
    }
  }

  // Per-weight clamp: cap each synaptic weight individually so Hebbian
  // can strengthen specific connections (creating clusters) without
  // runaway growth. Unlike per-neuron normalization, this preserves
  // weight heterogeneity — essential for Phi (integrated information).
  function clampWeights() {
    const maxW = cfg.maxWeight;
    if (maxW <= 0) return;

    for (let i = 0; i < N * N; i++) {
      if (W[i] > maxW) W[i] = maxW;
      else if (W[i] < -maxW) W[i] = -maxW;
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

    for (let i = 0; i < N; i++) {
      totalActivation += Math.abs(B[i]);
    }

    for (let i = 0; i < N * N; i++) {
      if (W[i] !== 0) {
        activeSynapses++;
        totalWeight += Math.abs(W[i]);
      }
    }

    return {
      neuronCount: N,
      totalActivation,
      meanActivation: totalActivation / N,
      activeSynapses,
      totalSynapses: N * N,
      connectivityRatio: activeSynapses / (N * N),
      meanWeight: activeSynapses > 0 ? totalWeight / activeSynapses : 0,
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
    clampWeights();
    const pruned = prune();
    const neuroCount = neurogenesis();
    const bio = biosphere();
    decayExternalInput();

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
      publish('ctrnn', 'system.ctrnn', JSON.stringify({ event: 'stop', tick, stats }));
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
      tick = snap.tick || 0;
      if (snap.stats) stats = { ...stats, ...snap.stats };
    },
  };
}
