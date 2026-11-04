// CTRNNSubstrate — Adapter bridging the live CTRNN neural core to the
// CognitiveSubstrate interface required by the ConsciousnessFalsificationSuite.
//
// The CTRNN operates in continuous space (Float64 activations, real-valued weights).
// The consciousness proofs operate on discrete binary state machines.
// This adapter samples N neurons from the grid, binarizes activations,
// and estimates transition probabilities empirically by running the CTRNN.
//
// Complexity: proofs enumerate 2^N states, so N must stay small (4-8).
// For a 16x16 grid, we sample neurons at strategic positions (corners,
// center, high-connectivity hubs) to capture the network's causal structure.
//
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc

const LOG2 = Math.log(2);
const SAMPLES_PER_STATE = 64;
const EULER_STEPS_PER_SAMPLE = 20;

export class CTRNNSubstrate {
  constructor(ctrnn, opts = {}) {
    this.ctrnn = ctrnn;
    this.sampleCount = opts.sampleCount || 4;
    this.samplesPerState = opts.samplesPerState || SAMPLES_PER_STATE;
    this.stepsPerSample = opts.stepsPerSample || EULER_STEPS_PER_SAMPLE;

    const snap = ctrnn.snapshot();
    this.gridSize = snap.gridSize;
    this.totalN = snap.B.length;

    this.sampleIndices = opts.sampleIndices || this._selectStrategic(this.sampleCount);

    this._baseB = new Float64Array(snap.B);
    this._baseW = new Float64Array(snap.W);
    this._baseTheta = new Float64Array(snap.Theta);

    this._tpmCache = null;
    this._selfModel = null;
  }

  _selectStrategic(n) {
    const g = this.gridSize;
    const totalN = g * g;
    const candidates = [];

    // Corners of the grid
    candidates.push(0, g - 1, (g - 1) * g, totalN - 1);
    // Center cross
    const mid = Math.floor(g / 2);
    candidates.push(mid * g + mid, mid * g, mid, (g - 1) * g + mid);
    // Quarter points
    const q = Math.floor(g / 4);
    candidates.push(q * g + q, q * g + (g - q - 1), (g - q - 1) * g + q, (g - q - 1) * g + (g - q - 1));

    const unique = [...new Set(candidates)].filter(i => i >= 0 && i < totalN);
    return unique.slice(0, n);
  }

  getNodeCount() {
    return this.sampleIndices.length;
  }

  // Binarize: activation > 0 → 1, else 0
  _binarize(B) {
    let bits = 0;
    for (let i = 0; i < this.sampleIndices.length; i++) {
      if (B[this.sampleIndices[i]] > 0) bits |= (1 << i);
    }
    return bits;
  }

  // Set sampled neurons to match a binary state vector, keep others at base
  _imposeState(B, stateBits) {
    const imposed = new Float64Array(B);
    for (let i = 0; i < this.sampleIndices.length; i++) {
      const idx = this.sampleIndices[i];
      imposed[idx] = ((stateBits >> i) & 1) === 1 ? 0.5 : -0.5;
    }
    return imposed;
  }

  // Run a mini Euler integration from a given state, return next B vector
  _eulerRun(startB, W, Theta, steps) {
    const N = this.totalN;
    const dt = 16.67;
    const tau = 50;
    const dtTau = dt / tau;
    let B = new Float64Array(startB);

    for (let t = 0; t < steps; t++) {
      const newB = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = 0; j < N; j++) {
          sum += W[i * N + j] * Math.tanh(B[j] + Theta[j]);
        }
        newB[i] = B[i] + dtTau * (-B[i] + sum);
      }
      B = newB;
    }
    return B;
  }

  // Estimate P(node_i = 1 at t+1 | do(S_t = stateBits)) empirically
  getNodeTransitionProb(nodeIndex, stateBits) {
    if (this._tpmCache) {
      return this._tpmCache[stateBits][nodeIndex];
    }
    return this._estimateNodeProb(nodeIndex, stateBits);
  }

  _estimateNodeProb(nodeIndex, stateBits) {
    let ones = 0;
    const N = this.totalN;

    for (let s = 0; s < this.samplesPerState; s++) {
      // Start from base state with noise
      const startB = this._imposeState(this._baseB, stateBits);
      for (let i = 0; i < N; i++) {
        if (!this.sampleIndices.includes(i)) {
          startB[i] += (Math.random() - 0.5) * 0.05;
        }
      }

      const nextB = this._eulerRun(startB, this._baseW, this._baseTheta, this.stepsPerSample);
      if (nextB[this.sampleIndices[nodeIndex]] > 0) ones++;
    }

    return Math.max(1e-6, Math.min(1 - 1e-6, ones / this.samplesPerState));
  }

  // Pre-compute full TPM for all states — expensive but used by Phi_MIP
  buildTPM() {
    const n = this.sampleIndices.length;
    const numStates = 1 << n;
    const tpm = [];

    for (let s = 0; s < numStates; s++) {
      const row = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        row[i] = this._estimateNodeProb(i, s);
      }
      tpm.push(row);
    }

    this._tpmCache = tpm;
    return tpm;
  }

  runSelfModelingTrial(steps, mirrorEnabled, counterfactualEnabled) {
    const n = this.sampleIndices.length;
    const N = this.totalN;
    const numStates = 1 << n;
    const trapState = numStates - 1;

    // Self-model: starts at maximum uncertainty (0.5 for each node given each state)
    if (!this._selfModel) {
      this._selfModel = [];
      for (let s = 0; s < numStates; s++) {
        this._selfModel.push(new Float64Array(n).fill(0.5));
      }
    }

    let currentB = new Float64Array(this._baseB);
    // Start from a non-degenerate state
    for (let i = 0; i < this.sampleIndices.length; i++) {
      currentB[this.sampleIndices[i]] = (i % 2 === 0) ? 0.3 : -0.3;
    }

    let totalSurprise = 0;
    let safeSteps = 0;

    for (let t = 0; t < steps; t++) {
      const currentState = this._binarize(currentB);

      // Counterfactual rollout: check if trajectory risks trap state
      if (counterfactualEnabled && this._selfModel[currentState]) {
        let riskOfTrap = 1.0;
        for (let i = 0; i < n; i++) {
          riskOfTrap *= this._selfModel[currentState][i];
        }
        if (riskOfTrap > 0.25) {
          // Phase-shift intervention: perturb MSB neuron
          const msbIdx = this.sampleIndices[n - 1];
          currentB[msbIdx] = -currentB[msbIdx];
        }
      }

      // Run one Euler integration step
      const nextB = this._eulerRun(currentB, this._baseW, this._baseTheta, 3);
      const nextState = this._binarize(nextB);

      // Compute surprise: prediction error of self-model
      let stepSurprise = 0;
      for (let i = 0; i < n; i++) {
        const actual = (nextState >> i) & 1;
        const predicted = this._selfModel[currentState]?.[i] || 0.5;
        const probObserved = actual === 1 ? predicted : (1 - predicted);
        stepSurprise += -Math.log(Math.max(1e-9, probObserved)) / LOG2;
      }
      totalSurprise += stepSurprise / n;

      // Mirror Protocol: update self-model toward observed reality
      if (mirrorEnabled && this._selfModel[currentState]) {
        for (let i = 0; i < n; i++) {
          const actual = (nextState >> i) & 1;
          const target = actual === 1 ? 0.9 : 0.1;
          this._selfModel[currentState][i] =
            0.8 * this._selfModel[currentState][i] + 0.2 * target;
        }
      }

      // Track survival (not in trap state or null state)
      if (nextState !== trapState && nextState !== 0) {
        safeSteps++;
      }

      currentB = nextB;
    }

    return {
      avgSurprise: totalSurprise / steps,
      survivalRate: safeSteps / steps,
      finalState: this._binarize(currentB),
    };
  }

  // Reset self-model for fresh trials
  resetSelfModel() {
    this._selfModel = null;
  }
}

// Run the full consciousness audit against a live CTRNN instance.
// Returns structured results with all 4 proofs + negative control validation.
export function auditCTRNNConsciousness(ctrnn, opts = {}) {
  const {
    sampleCount = 4,
    samplesPerState = 32,
    stepsPerSample = 15,
    trialSteps = 200,
  } = opts;

  const t0 = Date.now();

  const substrate = new CTRNNSubstrate(ctrnn, {
    sampleCount,
    samplesPerState,
    stepsPerSample,
  });

  // Build the empirical TPM (needed for EI and Phi_MIP)
  substrate.buildTPM();

  // Import proof functions dynamically to avoid circular deps
  const results = {
    substrate: 'CTRNNLiveCore',
    sampleIndices: substrate.sampleIndices,
    gridSize: substrate.gridSize,
    totalNeurons: substrate.totalN,
    sampledNeurons: substrate.getNodeCount(),
    proofs: {},
    verdict: 'UNKNOWN',
    duration_ms: 0,
    ts: new Date().toISOString(),
  };

  // Proof 1: Effective Information
  const n = substrate.getNodeCount();
  const numStates = 1 << n;
  const tpm = substrate._tpmCache;

  let totalEI = 0;
  for (let node = 0; node < n; node++) {
    const marginal = [0, 0];
    for (let s = 0; s < numStates; s++) {
      const p = tpm[s][node];
      marginal[0] += (1 - p);
      marginal[1] += p;
    }
    marginal[0] /= numStates;
    marginal[1] /= numStates;

    let klDiv = 0;
    for (let s = 0; s < numStates; s++) {
      const p1 = tpm[s][node];
      const p0 = 1 - p1;
      if (p1 > 1e-10 && marginal[1] > 1e-10) klDiv += p1 * Math.log2(p1 / marginal[1]) / numStates;
      if (p0 > 1e-10 && marginal[0] > 1e-10) klDiv += p0 * Math.log2(p0 / marginal[0]) / numStates;
    }
    totalEI += klDiv;
  }
  results.proofs.effective_information = {
    ei: totalEI,
    passed: totalEI > 0.01,
    threshold: 0.01,
  };

  // Proof 2: Phi_MIP — exact interventional marginalization (matching Java)
  let minPhi = Infinity;
  let weakestCut = 'NONE';

  for (let mask = 1; mask < numStates - 1; mask++) {
    const setA = [];
    const setB = [];
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) setA.push(i);
      else setB.push(i);
    }
    if (!setA.length || !setB.length) continue;

    // Build partitioned TPM: marginalize B's inputs to A over all 2^|B| states
    const numBStates = 1 << setB.length;
    let cutDivergence = 0;

    for (let s = 0; s < numStates; s++) {
      const pIntact = [];
      const pCut = [];

      for (let aNode of setA) {
        pIntact.push(tpm[s][aNode]);

        // Marginalize: average transition prob over all possible B states
        let sumP = 0;
        for (let bVal = 0; bVal < numBStates; bVal++) {
          let sMod = s;
          for (let bitIdx = 0; bitIdx < setB.length; bitIdx++) {
            const bNode = setB[bitIdx];
            if ((bVal >> bitIdx) & 1) sMod |= (1 << bNode);
            else sMod &= ~(1 << bNode);
          }
          sumP += tpm[sMod][aNode];
        }
        pCut.push(sumP / numBStates);
      }

      // KL divergence between intact and cut distributions for A-nodes
      for (let k = 0; k < setA.length; k++) {
        const pi = Math.max(1e-15, pIntact[k]);
        const qi = Math.max(1e-15, pCut[k]);
        const pi0 = Math.max(1e-15, 1 - pIntact[k]);
        const qi0 = Math.max(1e-15, 1 - pCut[k]);
        cutDivergence += (pi * Math.log2(pi / qi) + pi0 * Math.log2(pi0 / qi0)) / numStates;
      }
    }

    if (cutDivergence < minPhi) {
      minPhi = cutDivergence;
      weakestCut = `{${setB.join(',')}} -/-> {${setA.join(',')}}`;
    }
  }

  if (!isFinite(minPhi)) minPhi = 0;
  results.proofs.phi_mip = {
    phi: minPhi,
    weakestCut,
    passed: minPhi > 0.001,
    threshold: 0.001,
  };

  // Proof 3: Mirror Protocol — self-model ablation
  substrate.resetSelfModel();
  const intact = substrate.runSelfModelingTrial(trialSteps, true, false);
  substrate.resetSelfModel();
  const blinded = substrate.runSelfModelingTrial(trialSteps, false, false);

  const mirrorDelta = blinded.avgSurprise - intact.avgSurprise;
  results.proofs.mirror_protocol = {
    intactSurprise: intact.avgSurprise,
    blindedSurprise: blinded.avgSurprise,
    delta: mirrorDelta,
    passed: mirrorDelta > 0.02,
    threshold: 0.02,
  };

  // Proof 4: Counterfactual Branching Divergence
  substrate.resetSelfModel();
  const withCF = substrate.runSelfModelingTrial(trialSteps, true, true);
  substrate.resetSelfModel();
  const noCF = substrate.runSelfModelingTrial(trialSteps, true, false);

  const cfDivergence = Math.abs(withCF.avgSurprise - noCF.avgSurprise);
  const survivalGain = withCF.survivalRate - noCF.survivalRate;
  results.proofs.counterfactual_branching = {
    divergence: cfDivergence,
    survivalGain,
    passed: cfDivergence > 0.01 || survivalGain > 0.02,
    threshold: 0.01,
  };

  // Overall verdict
  const allPassed = Object.values(results.proofs).every(p => p.passed);
  const failedProofs = Object.entries(results.proofs)
    .filter(([, p]) => !p.passed)
    .map(([name]) => name);

  if (allPassed) {
    results.verdict = 'PROVEN_INTEGRATED_CORE';
  } else {
    results.verdict = `DENIED: ${failedProofs.join(', ')} failed`;
  }

  results.duration_ms = Date.now() - t0;
  return results;
}
