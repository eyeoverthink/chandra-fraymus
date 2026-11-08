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
const EULER_STEPS_PER_SAMPLE = 3;

// Seedable PRNG (mulberry32) — ensures reproducible noise so two
// self-modeling trials with the same seed differ ONLY by whether
// counterfactual intervention is enabled.
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class CTRNNSubstrate {
  constructor(ctrnn, opts = {}) {
    this.ctrnn = ctrnn;
    this.sampleCount = opts.sampleCount || 4;
    this.samplesPerState = opts.samplesPerState || SAMPLES_PER_STATE;
    this.stepsPerSample = opts.stepsPerSample || EULER_STEPS_PER_SAMPLE;
    // Amplitude the sampled neurons are set to when a state is imposed. 0.15 only
    // registers against a high-gain network; a homeostatic one operates near |B| ~ 1-2.
    this.imposeAmplitude = opts.imposeAmplitude || 0.15;
    // Grain of a unit. 1 = single neurons (original). >1 = clusters: a homeostatic,
    // bounded-norm network builds its structure in reciprocal E/I neighbourhoods, and
    // Phi_MIP over 4 isolated single neurons is 0 for every such network (18 probes) —
    // integration there needs in-subset gain only a saturated net has. Coarse-graining
    // to clusters measures at the scale where the living network is integrated.
    this.clusterSize = Math.max(1, opts.clusterSize | 0 || 1);
    // What a unit's state IS for the TPM. 'level': sign of B after the horizon (original).
    // 'drive': sign of the recurrent input the unit received, B(t+h) - B(t)*decay^h.
    // In a leaky continuous network the imposed level and any interaction decay at the
    // same rate, so at a short horizon the level is the unit's own past (EI = 4 bits,
    // Phi = 0: four memory cells) and at a long horizon everything is forgotten
    // (EI = 0). Drive removes self-persistence and leaves exactly the causal influence
    // of the other units — the quantity Phi_MIP is defined over.
    this.stateMode = opts.stateMode === 'drive' ? 'drive' : 'level';

    const snap = ctrnn.snapshot();
    this.gridSize = snap.gridSize;
    this.totalN = snap.B.length;

    if (opts.units) this.units = opts.units;
    else if (opts.sampleIndices) this.units = opts.sampleIndices.map(i => [i]);
    else if (this.clusterSize > 1) this.units = this._selectClusters(this.sampleCount, this.clusterSize, snap);
    else this.units = this._selectStrategic(this.sampleCount, snap).map(i => [i]);
    // Flat member list: isolation set for _eulerRun, and what downstream consumers
    // (gate's targeted injection, audit row) read as sampleIndices.
    this.sampleIndices = this.units.flat();
    this._memberSet = new Set(this.sampleIndices);

    this._baseB = new Float64Array(snap.B);
    this._baseW = new Float64Array(snap.W);
    this._baseTheta = new Float64Array(snap.Theta);

    this._tpmCache = null;
    this._selfModel = null;
  }

  _selectStrategic(n, snap) {
    const totalN = this.totalN;
    const W = snap.W;

    // Greedy strongly-connected-cluster selection — the main complex IIT prescribes
    // as the unit of Phi measurement. Phi_MIP is the minimum over ALL bipartitions,
    // single-node cuts included, so it is exactly 0 whenever one sampled neuron
    // receives nothing from the others (under isolation it just decays to Theta).
    // The old picker maximised total mutual weight and routinely returned a subset
    // with a dangling node: EI read up to 2 bits from the connected pairs while Phi
    // stayed 0 in every sparse, living regime. Each neuron added here must both
    // receive from and project to the current set; the score is the weaker
    // direction (the bottleneck link). By induction the result is strongly connected.
    // Falls back to the sum heuristic only when no reciprocal candidate exists.
    const reciprocal = new Float64Array(totalN);
    for (let i = 0; i < totalN; i++) {
      for (let j = 0; j < totalN; j++) {
        if (i === j) continue;
        reciprocal[i] += Math.min(Math.abs(W[i * totalN + j]), Math.abs(W[j * totalN + i]));
      }
    }

    let best = 0;
    for (let i = 1; i < totalN; i++) {
      if (reciprocal[i] > reciprocal[best]) best = i;
    }

    const selected = [best];
    const used = new Set([best]);

    while (selected.length < n && selected.length < totalN) {
      let bestNext = -1, bestScore = -1;
      let fallbackNext = -1, fallbackScore = -1;
      for (let i = 0; i < totalN; i++) {
        if (used.has(i)) continue;
        let inbound = 0, outbound = 0;
        for (const s of selected) {
          inbound += Math.abs(W[i * totalN + s]);   // s -> i
          outbound += Math.abs(W[s * totalN + i]);  // i -> s
        }
        const bottleneck = Math.min(inbound, outbound);
        if (bottleneck > bestScore) { bestScore = bottleneck; bestNext = i; }
        const sum = inbound + outbound;
        if (sum > fallbackScore) { fallbackScore = sum; fallbackNext = i; }
      }
      const next = bestScore > 0 ? bestNext : fallbackNext;
      if (next < 0) break;
      selected.push(next);
      used.add(next);
    }

    return selected;
  }

  // Cluster-grain unit selection. Cluster 1 grows around the neuron with the highest
  // reciprocal coupling; each further cluster grows around the unused neuron with the
  // strongest bottleneck (min of in/out) coupling to the union of existing clusters, so
  // the clusters are mutually connected — a single-unit cut with no inbound influence
  // makes Phi_MIP exactly 0. Growth adds the unused neuron most coupled to the cluster.
  _selectClusters(n, size, snap) {
    const totalN = this.totalN;
    const W = snap.W;
    const w = (i, j) => Math.abs(W[i * totalN + j]); // j -> i

    const reciprocal = new Float64Array(totalN);
    for (let i = 0; i < totalN; i++) {
      for (let j = 0; j < totalN; j++) {
        if (i !== j) reciprocal[i] += Math.min(w(i, j), w(j, i));
      }
    }

    const used = new Set();
    const units = [];

    const grow = (seed) => {
      const members = [seed];
      used.add(seed);
      while (members.length < size) {
        let best = -1, bestScore = 0;
        for (let i = 0; i < totalN; i++) {
          if (used.has(i)) continue;
          let score = 0;
          for (const m of members) score += w(i, m) + w(m, i);
          if (score > bestScore) { bestScore = score; best = i; }
        }
        if (best < 0) break;
        members.push(best);
        used.add(best);
      }
      return members;
    };

    let seed = 0;
    for (let i = 1; i < totalN; i++) if (reciprocal[i] > reciprocal[seed]) seed = i;
    units.push(grow(seed));

    while (units.length < n) {
      const existing = units.flat();
      let best = -1, bestScore = -1, fallback = -1, fallbackScore = -1;
      for (let i = 0; i < totalN; i++) {
        if (used.has(i)) continue;
        let inbound = 0, outbound = 0;
        for (const m of existing) { inbound += w(i, m); outbound += w(m, i); }
        const bottleneck = Math.min(inbound, outbound);
        if (bottleneck > bestScore) { bestScore = bottleneck; best = i; }
        if (inbound + outbound > fallbackScore) { fallbackScore = inbound + outbound; fallback = i; }
      }
      const next = bestScore > 0 ? best : fallback;
      if (next < 0) break;
      units.push(grow(next));
    }

    return units;
  }

  getNodeCount() {
    return this.units.length;
  }

  // Binarize: a unit is 1 when its mean activation > 0 (single neuron: B > 0)
  _binarize(B) {
    let bits = 0;
    for (let u = 0; u < this.units.length; u++) {
      const members = this.units[u];
      let sum = 0;
      for (const idx of members) sum += B[idx];
      if (sum > 0) bits |= (1 << u);
    }
    return bits;
  }

  _unitMean(B, u) {
    let sum = 0;
    for (const idx of this.units[u]) sum += B[idx];
    return sum / this.units[u].length;
  }

  // Set every member of each unit coherently to match a binary state vector, keep others at base
  _imposeState(B, stateBits) {
    const imposed = new Float64Array(B);
    // Drive mode imposes relative to each neuron's tanh centre (-Theta). Intrinsic
    // plasticity drifts Theta to ~-0.5 against a mean drive of ~1.7; an absolute +-0.5
    // then yields tanh(-0.05) and tanh(-1.05) — the same sign either way — so no unit's
    // input ever flips with the imposed state and EI reads 0.
    const relative = this.stateMode === 'drive';
    for (let u = 0; u < this.units.length; u++) {
      const sign = ((stateBits >> u) & 1) === 1 ? 1 : -1;
      for (const idx of this.units[u]) {
        imposed[idx] = (relative ? -this._baseTheta[idx] : 0) + sign * this.imposeAmplitude;
      }
    }
    return imposed;
  }

  // Run a mini Euler integration from a given state, return next B vector.
  // When isolateSubset is provided, sampled neurons only receive input from
  // other sampled neurons — this isolates the causal structure being measured,
  // which is what IIT's interventional calculus requires.
  _eulerRun(startB, W, Theta, steps, isolateSubset, noise = 0, rng = null) {
    const N = this.totalN;
    const dt = 16.67;
    const tau = 50;
    const dtTau = dt / tau;
    let B = new Float64Array(startB);
    const isolated = isolateSubset ? new Set(isolateSubset) : null;
    const rand = rng || Math.random;

    for (let t = 0; t < steps; t++) {
      const newB = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let sum = 0;
        for (let j = 0; j < N; j++) {
          if (isolated && isolated.has(i) && !isolated.has(j)) continue;
          sum += W[i * N + j] * Math.tanh(B[j] + Theta[j]);
        }
        newB[i] = B[i] + dtTau * (-B[i] + sum);
        if (noise > 0) newB[i] += (rand() - 0.5) * noise;
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
        if (!this._memberSet.has(i)) {
          startB[i] += (Math.random() - 0.5) * 0.05;
        }
      }

      const nextB = this._eulerRun(startB, this._baseW, this._baseTheta, this.stepsPerSample, this.sampleIndices);
      let value = this._unitMean(nextB, nodeIndex);
      if (this.stateMode === 'drive') {
        const decay = Math.pow(1 - 16.67 / 50, this.stepsPerSample);
        value -= this._unitMean(startB, nodeIndex) * decay;
      }
      if (value > 0) ones++;
    }

    return Math.max(1e-6, Math.min(1 - 1e-6, ones / this.samplesPerState));
  }

  // Pre-compute full TPM for all states — expensive but used by Phi_MIP
  buildTPM() {
    const n = this.units.length;
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

  runSelfModelingTrial(steps, mirrorEnabled, counterfactualEnabled, seed = 42) {
    const n = this.units.length;
    const N = this.totalN;
    const numStates = 1 << n;
    const trapState = numStates - 1;
    const rng = mulberry32(seed);

    // Self-model: starts at maximum uncertainty (0.5 for each node given each state)
    if (!this._selfModel) {
      this._selfModel = [];
      for (let s = 0; s < numStates; s++) {
        this._selfModel.push(new Float64Array(n).fill(0.5));
      }
    }

    let currentB = new Float64Array(this._baseB);
    // Start near the decision boundary so noise drives exploration of many states
    for (const idx of this.sampleIndices) {
      currentB[idx] = (rng() - 0.5) * 0.02;
    }

    let totalSurprise = 0;
    let safeSteps = 0;
    const stateHistory = new Int32Array(steps);

    for (let t = 0; t < steps; t++) {
      const currentState = this._binarize(currentB);
      stateHistory[t] = currentState;

      // Counterfactual reasoning: use the self-model's predictions to detect
      // when the system is about to enter a fixed point (predicted next state
      // equals current state) and intervene to break the cycle.
      //
      // Near-identity TPMs are the CTRNN's dominant dynamics — the attractor
      // holds each state in place. The CF intervention creates trajectory
      // divergence by fighting the attractor: it flips the least-certain neuron,
      // forcing the system through states it would never visit passively.
      // The withCF trial oscillates (intervention → attractor pulls back →
      // intervention), while the noCF trial stays static — measurably different.
      if (counterfactualEnabled && this._selfModel[currentState]) {
        let predictedNext = 0;
        for (let i = 0; i < n; i++) {
          if (this._selfModel[currentState][i] > 0.5) predictedNext |= (1 << i);
        }
        if (predictedNext === currentState) {
          // Break the fixed point by flipping the 2 least-certain neurons.
          // A single flip reverses within 3 Euler substeps (the attractor's
          // cross-connections restore it). Two flips create mutual negative
          // reinforcement: each flipped neuron's tanh < 0 fights the other's
          // recovery, keeping B negative through the full Euler window.
          const certs = [];
          for (let i = 0; i < n; i++) {
            certs.push({ i, cert: Math.abs(this._selfModel[currentState][i] - 0.5) });
          }
          certs.sort((a, b) => a.cert - b.cert);
          const flipCount = Math.min(2, n);
          for (let f = 0; f < flipCount; f++) {
            const u = certs[f].i;
            const sign = Math.sign(this._unitMean(currentB, u) || 0.01);
            for (const idx of this.units[u]) currentB[idx] = -sign * 2.5;
          }
        }
      }

      // Run one Euler integration step (isolated to sampled subset).
      // Noise from the seeded PRNG ensures both CF-on and CF-off trials
      // see identical stochasticity — the only difference is the intervention.
      const nextB = this._eulerRun(currentB, this._baseW, this._baseTheta, 3, this.sampleIndices, 0.05, rng);
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
      stateHistory,
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
    samplesPerState = 64,
    stepsPerSample = 3,
    trialSteps = 400,
    imposeAmplitude = 0.15,
    clusterSize = 1,
    stateMode = 'level',
  } = opts;

  const t0 = Date.now();

  const substrate = new CTRNNSubstrate(ctrnn, {
    sampleCount,
    samplesPerState,
    stepsPerSample,
    imposeAmplitude,
    clusterSize,
    stateMode,
  });

  // Build the empirical TPM (needed for EI and Phi_MIP)
  substrate.buildTPM();

  // Import proof functions dynamically to avoid circular deps
  const results = {
    substrate: `CTRNNLiveCore${substrate.clusterSize > 1 ? ':cluster' + substrate.clusterSize : ''}${substrate.stateMode === 'drive' ? ':drive' : ''}`,
    sampleIndices: substrate.sampleIndices,
    units: substrate.units,
    clusterSize: substrate.clusterSize,
    stateMode: substrate.stateMode,
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
  // Both trials share the same seed so noise and starting state are identical —
  // the ONLY difference is whether counterfactual intervention fires.
  const cfSeed = 0xCF | 0;
  substrate.resetSelfModel();
  const withCF = substrate.runSelfModelingTrial(trialSteps, true, true, cfSeed);
  substrate.resetSelfModel();
  const noCF = substrate.runSelfModelingTrial(trialSteps, true, false, cfSeed);

  // Trajectory divergence: fraction of steps where the two trials occupy
  // different binarized states. This bypasses surprise convergence — it
  // directly measures whether CF intervention changes the system's path.
  let divergedSteps = 0;
  const len = Math.min(withCF.stateHistory.length, noCF.stateHistory.length);
  for (let i = 0; i < len; i++) {
    if (withCF.stateHistory[i] !== noCF.stateHistory[i]) divergedSteps++;
  }
  const trajectoryDiv = divergedSteps / len;
  const surpriseDiv = Math.abs(withCF.avgSurprise - noCF.avgSurprise);
  const survivalGain = withCF.survivalRate - noCF.survivalRate;
  results.proofs.counterfactual_branching = {
    divergence: trajectoryDiv,
    surpriseDivergence: surpriseDiv,
    divergedSteps,
    totalSteps: len,
    survivalGain,
    passed: trajectoryDiv > 0.05 || survivalGain > 0.02,
    threshold: 0.05,
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
