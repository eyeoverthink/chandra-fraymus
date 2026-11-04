// Honeypot Canary Triangulation — 3-Canary Barycentric Fault Isolation
// Ported from FraynixSuperOrganismV19.java V2 (TriangulatedHoneypotArray)
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc
//
// Three orthogonal canaries placed at fixed grid vertices:
//   Alpha (CHRONOS_TIMING)  at (0, 0)        — timing drift
//   Beta  (LEXICAL_ENTROPY) at (G-1, 0)      — token entropy
//   Gamma (METABOLIC_PHASE) at (G/2, G-1)    — phase coherence
//
// Barycentric triangulation: X_bary = Σ(w_k * x_k) / Σ(w_k)
// where w_k = cbrt(max(1e-12, eps_k))
// SplitMix64 deterministic jitter in [-3, +3]

import { evaluateEp3Sensor } from './ep3.js';

const NOISE_FLOOR = 1e-12;

function splitMix64(seed) {
  let s = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn;
  s = (s + 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & 0xFFFFFFFFFFFFFFFFn;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & 0xFFFFFFFFFFFFFFFFn;
  z = z ^ (z >> 31n);
  return Number(z & 0xFFFFFFFFn);
}

function jitter(seed, range = 3) {
  const raw = splitMix64(seed);
  return (raw % (2 * range + 1)) - range;
}

export const CANARY_TYPES = {
  CHRONOS_TIMING: 'chronos_timing',
  LEXICAL_ENTROPY: 'lexical_entropy',
  METABOLIC_PHASE: 'metabolic_phase',
};

export class HoneypotCanary {
  constructor(type, g = 1.0) {
    this.type = type;
    this.g = g;
    this.driftAccumulator = 0;
    this.sampleCount = 0;
    this.triggerCount = 0;
  }

  observe(expected, actual) {
    const drift = Math.abs(actual - expected);
    this.driftAccumulator += drift * drift;
    this.sampleCount++;
  }

  getResidualEpsilon() {
    if (this.sampleCount === 0) return 0;
    return Math.sqrt(this.driftAccumulator / this.sampleCount);
  }

  getPuiseuxSplit() {
    return Math.cbrt(Math.max(NOISE_FLOOR, this.getResidualEpsilon()));
  }

  evaluate() {
    return evaluateEp3Sensor(this.g, this.getResidualEpsilon());
  }

  reset() {
    this.driftAccumulator = 0;
    this.sampleCount = 0;
  }

  toJSON() {
    return {
      type: this.type,
      residualEpsilon: this.getResidualEpsilon(),
      puiseuxSplit: this.getPuiseuxSplit(),
      sampleCount: this.sampleCount,
      triggerCount: this.triggerCount,
    };
  }
}

export class TriangulatedHoneypotArray {
  constructor(gridSize = 48, g = 1.0, opts = {}) {
    this.gridSize = gridSize;
    this.g = g;
    this.minSamples = opts.minSamples || 10;
    this.sensitivityThreshold = opts.sensitivityThreshold || 2.0;
    this.alpha = new HoneypotCanary(CANARY_TYPES.CHRONOS_TIMING, g);
    this.beta = new HoneypotCanary(CANARY_TYPES.LEXICAL_ENTROPY, g);
    this.gamma = new HoneypotCanary(CANARY_TYPES.METABOLIC_PHASE, g);

    // Fixed grid vertex positions
    this.alphaPos = { x: 0, y: 0 };
    this.betaPos = { x: gridSize - 1, y: 0 };
    this.gammaPos = { x: Math.floor(gridSize / 2), y: gridSize - 1 };
  }

  observeTiming(expected, actual) {
    this.alpha.observe(expected, actual);
  }

  observeEntropy(expected, actual) {
    this.beta.observe(expected, actual);
  }

  observePhase(expected, actual) {
    this.gamma.observe(expected, actual);
  }

  triangulateFault(seed = Date.now()) {
    const epsAlpha = this.alpha.getResidualEpsilon();
    const epsBeta = this.beta.getResidualEpsilon();
    const epsGamma = this.gamma.getResidualEpsilon();

    // Cube-root weights (Puiseux-inspired)
    const wA = Math.cbrt(Math.max(NOISE_FLOOR, epsAlpha));
    const wB = Math.cbrt(Math.max(NOISE_FLOOR, epsBeta));
    const wG = Math.cbrt(Math.max(NOISE_FLOOR, epsGamma));
    const wSum = wA + wB + wG;

    if (wSum < NOISE_FLOOR) {
      return { x: 0, y: 0, confidence: 0, weights: { alpha: 0, beta: 0, gamma: 0 }, triggered: false };
    }

    // Barycentric coordinates
    const baryX = (wA * this.alphaPos.x + wB * this.betaPos.x + wG * this.gammaPos.x) / wSum;
    const baryY = (wA * this.alphaPos.y + wB * this.betaPos.y + wG * this.gammaPos.y) / wSum;

    // Deterministic SplitMix64 jitter
    const jX = jitter(seed);
    const jY = jitter(seed + 1);

    const faultX = Math.max(0, Math.min(this.gridSize - 1, Math.round(baryX + jX)));
    const faultY = Math.max(0, Math.min(this.gridSize - 1, Math.round(baryY + jY)));

    const maxEps = Math.max(epsAlpha, epsBeta, epsGamma);
    const totalSamples = this.alpha.sampleCount + this.beta.sampleCount + this.gamma.sampleCount;
    const minPerChannel = Math.max(4, Math.ceil(this.minSamples / 3));
    const enoughSamples = totalSamples >= this.minSamples
      && this.alpha.sampleCount >= minPerChannel
      && this.beta.sampleCount >= minPerChannel
      && this.gamma.sampleCount >= minPerChannel;
    const confidence = enoughSamples
      ? Math.tanh(maxEps / this.sensitivityThreshold)
      : 0;

    const dominant =
      epsAlpha >= epsBeta && epsAlpha >= epsGamma ? CANARY_TYPES.CHRONOS_TIMING :
      epsBeta >= epsGamma ? CANARY_TYPES.LEXICAL_ENTROPY :
      CANARY_TYPES.METABOLIC_PHASE;

    return {
      x: faultX,
      y: faultY,
      confidence,
      dominant,
      weights: {
        alpha: wA / wSum,
        beta: wB / wSum,
        gamma: wG / wSum,
      },
      epsilons: { alpha: epsAlpha, beta: epsBeta, gamma: epsGamma },
      totalSamples,
      triggered: enoughSamples && confidence > 0.5,
    };
  }

  reset() {
    this.alpha.reset();
    this.beta.reset();
    this.gamma.reset();
  }

  toJSON() {
    return {
      gridSize: this.gridSize,
      canaries: {
        alpha: this.alpha.toJSON(),
        beta: this.beta.toJSON(),
        gamma: this.gamma.toJSON(),
      },
    };
  }
}

export default { HoneypotCanary, TriangulatedHoneypotArray, CANARY_TYPES, splitMix64 };
