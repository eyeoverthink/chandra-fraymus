// EP3 Sensor — Cube-Root Anomaly Detector
// Ported from FraynixSuperOrganismV19.java
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc
//
// Cube-root splitting: epsilon^(1/3) amplifies small perturbations.
// For epsilon=1e-6, cbrt/eps = 10,000× — a sensitivity ratio, not a
// precision claim (see Langbein arXiv:1801.05750 for EP sensing limits).
// Eigenvalues of lambda^3 = epsilon are the three complex cube roots.
// Sub-noise floor clamped at 1e-12.

const NOISE_FLOOR = 1e-12;
const SQRT3_HALF = Math.sqrt(3) / 2;

export function evaluateEp3Sensor(g, epsilon) {
  if (epsilon === 0 || (typeof epsilon === 'number' && !epsilon)) {
    return {
      g, epsilon: 0, puiseuxSplit: 0, amplification: 0,
      eigenvalues: [
        { re: 0, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 },
      ],
      maxMagnitude: 0, quantized8bit: 0, zeroInput: true,
    };
  }
  const eps = Math.max(NOISE_FLOOR, Math.abs(epsilon));
  const puiseuxSplit = Math.cbrt(eps);
  const amplification = puiseuxSplit / eps;
  const eigenvalues = [
    { re: puiseuxSplit, im: 0 },
    { re: -puiseuxSplit / 2, im: puiseuxSplit * SQRT3_HALF },
    { re: -puiseuxSplit / 2, im: -puiseuxSplit * SQRT3_HALF },
  ];
  const maxMagnitude = puiseuxSplit;
  const logScale = maxMagnitude > 0
    ? (Math.log10(maxMagnitude) - Math.log10(Math.cbrt(NOISE_FLOOR)))
      / (0 - Math.log10(Math.cbrt(NOISE_FLOOR)))
    : 0;
  const quantized8bit = Math.min(255, Math.max(0, Math.round(logScale * 255)));

  return {
    g, epsilon: eps, puiseuxSplit, amplification,
    eigenvalues, maxMagnitude, quantized8bit,
  };
}

export function measureResidualEpsilon(observed, expected) {
  return Math.abs(observed - expected);
}

export function measurePuiseuxSplit(residual) {
  return Math.cbrt(Math.max(NOISE_FLOOR, Math.abs(residual)));
}

export function amplificationFactor(epsilon) {
  const eps = Math.max(NOISE_FLOOR, Math.abs(epsilon));
  return Math.cbrt(eps) / eps;
}

export function quantizePeakDeltaTo8Bit(delta) {
  if (!delta || delta === 0) return 0;
  const d = Math.abs(delta);
  const minLog = Math.log10(Math.cbrt(NOISE_FLOOR));
  const logScale = (Math.log10(d) - minLog) / (0 - minLog);
  return Math.min(255, Math.max(0, Math.round(logScale * 255)));
}

export class Ep3Sensor {
  constructor(g = 1.0) {
    this.g = g;
    this.driftAccumulator = 0;
    this.sampleCount = 0;
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

  evaluate() {
    const eps = this.getResidualEpsilon();
    return evaluateEp3Sensor(this.g, eps);
  }

  reset() {
    this.driftAccumulator = 0;
    this.sampleCount = 0;
  }

  toJSON() {
    return {
      g: this.g,
      driftAccumulator: this.driftAccumulator,
      sampleCount: this.sampleCount,
      residualEpsilon: this.getResidualEpsilon(),
    };
  }
}

export default { evaluateEp3Sensor, measureResidualEpsilon, measurePuiseuxSplit, amplificationFactor, quantizePeakDeltaTo8Bit, Ep3Sensor };
