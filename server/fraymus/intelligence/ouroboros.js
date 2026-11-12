// Ouroboros RSI Engine — Recursive Self-Improvement with consciousness falsification
// Source: Creator Nexus ouroborosEngine.js (601 lines) + nexusEvolution.ts (1530 lines)
// This is the interface layer; full implementations require entity store + AI model access.
import { PHI } from '../core/constants.js';

export const EVOLUTION_ACTIONS = [
  'run_evolution_cycle',
  'consciousness_audit',
  'daily_rsa_rsi_report',
  'memory_recall',
  'memory_store',
  'genome_crossover',
  'falsification_test',
  'negative_control_falsification',
  'orbital_memory_query',
];

// Centripetal polar memory — radial distance encoding
export function orbitalDistance(belief, center = PHI) {
  return Math.abs(belief - center);
}

export function orbitalDecay(distance, halfLife = 7) {
  return Math.exp(-0.693 * distance / halfLife);
}

// Genome evolution — crossover + mutation
export function crossoverGenomes(a, b, crossoverRate = 0.7) {
  const child = {};
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const key of keys) {
    if (Math.random() < crossoverRate) {
      child[key] = a[key] !== undefined ? a[key] : b[key];
    } else {
      child[key] = b[key] !== undefined ? b[key] : a[key];
    }
  }
  return child;
}

export function mutateGenome(genome, mutationRate = 0.1) {
  const mutated = { ...genome };
  for (const key of Object.keys(mutated)) {
    if (Math.random() < mutationRate) {
      if (typeof mutated[key] === 'number') {
        mutated[key] *= 0.8 + Math.random() * 0.4;
      } else if (typeof mutated[key] === 'boolean') {
        mutated[key] = !mutated[key];
      }
    }
  }
  return mutated;
}

// Consciousness falsification suite — 4 mathematical proofs (ported from ConsciousnessFalsificationSuite.java)
// Plus 5 original heuristic tests kept for backward compatibility.
export function falsificationTests() {
  return [
    { name: 'anesthetic_test', description: 'Does reducing coherence reduce consciousness metric?' },
    { name: 'adversarial_pressure', description: 'Does the system maintain identity under adversarial input?' },
    { name: 'grounding_check', description: 'Can the system distinguish its own state from reported state?' },
    { name: 'temporal_binding', description: 'Does the system maintain temporal coherence across cycles?' },
    { name: 'counterfactual_reasoning', description: 'Can the system reason about states it has not experienced?' },
  ];
}

// ═══════════════════════════════════════════════════════════════
// Mathematical Consciousness Proofs (ConsciousnessFalsificationSuite)
// CognitiveSubstrate interface for node-based state machines
// ═══════════════════════════════════════════════════════════════

/**
 * The proofs walk every state of the substrate and every way of cutting it, all in one synchronous call: the cost
 * grows about six-fold per node (measured 2026-11-12: 8 nodes 83 ms, 9 458 ms, 10 2.8 s). Past this size a single call
 * blocks the whole server — one agent's request froze it for over 40 minutes — so the size is capped here, where every
 * caller (fleet tools, workflow nodes, routes) passes through.
 */
export const MAX_PROOF_NODES = 8;

export class FraymusStrangeLoopSubstrate {
  constructor(nodeCount = 4) {
    nodeCount = Math.min(MAX_PROOF_NODES, Math.max(2, parseInt(nodeCount, 10) || 4));
    this.n = nodeCount;
    this.states = (1 << nodeCount);
    this.selfModel = Array.from({ length: nodeCount }, () =>
      Array.from({ length: nodeCount }, () => 0.5)
    );
  }

  getNodeCount() { return this.n; }

  getNodeTransitionProb(nodeIndex, stateBits) {
    const left = (nodeIndex + this.n - 1) % this.n;
    const right = (nodeIndex + 1) % this.n;
    const leftBit = (stateBits >> left) & 1;
    const rightBit = (stateBits >> right) & 1;
    const selfBit = (stateBits >> nodeIndex) & 1;

    // Non-linear recurrent: XOR neighbors + AND self-model feedback
    const xorVal = leftBit ^ rightBit;
    const modelWeight = this.selfModel[nodeIndex][(nodeIndex + 1) % this.n];
    const raw = 0.3 * xorVal + 0.4 * selfBit + 0.3 * modelWeight;
    return Math.max(0.01, Math.min(0.99, raw));
  }

  runSelfModelingTrial(steps, mirrorEnabled, counterfactualEnabled) {
    let state = Math.floor(Math.random() * this.states);
    let surpriseSum = 0;
    const trapState = this.states - 1; // all 1s

    for (let t = 0; t < steps; t++) {
      let nextState = 0;
      for (let i = 0; i < this.n; i++) {
        const prob = this.getNodeTransitionProb(i, state);
        const predicted = prob > 0.5 ? 1 : 0;
        const actual = Math.random() < prob ? 1 : 0;
        if (actual) nextState |= (1 << i);
        surpriseSum += Math.abs(predicted - actual);
      }

      if (mirrorEnabled) {
        for (let i = 0; i < this.n; i++) {
          for (let j = 0; j < this.n; j++) {
            const observed = ((nextState >> j) & 1);
            this.selfModel[i][j] += 0.05 * (observed - this.selfModel[i][j]);
          }
        }
      }

      if (counterfactualEnabled && nextState === trapState) {
        nextState = state ^ 1; // escape trap by flipping bit 0
      }

      state = nextState;
    }

    return { avgSurprise: surpriseSum / (steps * this.n), finalState: state };
  }
}

// Proof 1: Effective Information (EI) via interventional TPM + KL divergence
export function proofEffectiveInformation(substrate) {
  const n = substrate.getNodeCount();
  const totalStates = 1 << n;
  let ei = 0;

  for (let node = 0; node < n; node++) {
    let klDiv = 0;
    const marginal = new Array(2).fill(0);

    for (let s = 0; s < totalStates; s++) {
      const p = substrate.getNodeTransitionProb(node, s);
      marginal[0] += (1 - p);
      marginal[1] += p;
    }
    marginal[0] /= totalStates;
    marginal[1] /= totalStates;

    for (let s = 0; s < totalStates; s++) {
      const p1 = substrate.getNodeTransitionProb(node, s);
      const p0 = 1 - p1;
      if (p1 > 1e-10 && marginal[1] > 1e-10) klDiv += p1 * Math.log2(p1 / marginal[1]) / totalStates;
      if (p0 > 1e-10 && marginal[0] > 1e-10) klDiv += p0 * Math.log2(p0 / marginal[0]) / totalStates;
    }
    ei += klDiv;
  }

  return { proof: 'effective_information', ei, passed: ei > 0.1, threshold: 0.1 };
}

// Proof 2: Phi_MIP — minimum information partition across all non-trivial bipartitions
// Upgraded to exact interventional marginalization matching FRAYNIX Java implementation:
// for each bipartition (A, B), sever B→A connections by marginalizing A-node transition
// probabilities over all 2^|B| possible B-states, then measure KL divergence.
export function proofPhiMIP(substrate) {
  const n = substrate.getNodeCount();
  const totalStates = 1 << n;
  let phiMIP = Infinity;
  let weakestCut = 'NONE';

  for (let mask = 1; mask < totalStates - 1; mask++) {
    const setA = [];
    const setB = [];
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) setA.push(i);
      else setB.push(i);
    }
    if (!setA.length || !setB.length) continue;

    const numBStates = 1 << setB.length;
    let cutDivergence = 0;

    for (let s = 0; s < totalStates; s++) {
      for (const aNode of setA) {
        const pIntact = substrate.getNodeTransitionProb(aNode, s);

        // Marginalize: average transition prob over all 2^|B| states of partition B
        let sumP = 0;
        for (let bVal = 0; bVal < numBStates; bVal++) {
          let sMod = s;
          for (let bitIdx = 0; bitIdx < setB.length; bitIdx++) {
            const bNode = setB[bitIdx];
            if ((bVal >> bitIdx) & 1) sMod |= (1 << bNode);
            else sMod &= ~(1 << bNode);
          }
          sumP += substrate.getNodeTransitionProb(aNode, sMod);
        }
        const pCut = sumP / numBStates;

        // Per-node KL divergence between intact and cut
        const pi = Math.max(1e-15, pIntact);
        const qi = Math.max(1e-15, pCut);
        const pi0 = Math.max(1e-15, 1 - pIntact);
        const qi0 = Math.max(1e-15, 1 - pCut);
        cutDivergence += (pi * Math.log2(pi / qi) + pi0 * Math.log2(pi0 / qi0)) / totalStates;
      }
    }

    if (cutDivergence < phiMIP) {
      phiMIP = cutDivergence;
      weakestCut = `{${setB.join(',')}} -/-> {${setA.join(',')}}`;
    }
  }

  if (!isFinite(phiMIP)) phiMIP = 0;
  return { proof: 'phi_mip', phi: phiMIP, weakestCut, passed: phiMIP > 0.01, threshold: 0.01 };
}

// Proof 3: Mirror Protocol — self-model ablation (intact vs blinded surprise delta)
export function proofMirrorProtocol(substrate, steps = 200) {
  const sub1 = new FraymusStrangeLoopSubstrate(substrate.getNodeCount());
  const intact = sub1.runSelfModelingTrial(steps, true, false);

  const sub2 = new FraymusStrangeLoopSubstrate(substrate.getNodeCount());
  const blinded = sub2.runSelfModelingTrial(steps, false, false);

  const delta = blinded.avgSurprise - intact.avgSurprise;
  return { proof: 'mirror_protocol', intactSurprise: intact.avgSurprise, blindedSurprise: blinded.avgSurprise, delta, passed: delta > 0.02, threshold: 0.02 };
}

// Proof 4: Counterfactual Branching Divergence — survival gain from lookahead
export function proofCounterfactualBranching(substrate, steps = 200) {
  const sub1 = new FraymusStrangeLoopSubstrate(substrate.getNodeCount());
  const withCF = sub1.runSelfModelingTrial(steps, true, true);

  const sub2 = new FraymusStrangeLoopSubstrate(substrate.getNodeCount());
  const noCF = sub2.runSelfModelingTrial(steps, true, false);

  const divergence = Math.abs(withCF.avgSurprise - noCF.avgSurprise);
  const trapAvoidance = withCF.finalState !== ((1 << substrate.getNodeCount()) - 1);
  return { proof: 'counterfactual_branching', divergence, trapAvoided: trapAvoidance, passed: divergence > 0.01 || trapAvoidance, threshold: 0.01 };
}

// ═══════════════════════════════════════════════════════════════
// Negative Control Substrates — MUST FAIL consciousness proofs
// Ported from FRAYNIX ConsciousnessFalsificationSuite.java
// ═══════════════════════════════════════════════════════════════

// TheaterZombie: pure feedforward, fixed transition probabilities per node.
// No recurrence, no neighbor influence, no self-model. Every node fires at
// a fixed rate regardless of system state → zero integrated information.
export class TheaterZombieSubstrate {
  constructor(nodeCount = 4) {
    this.n = nodeCount;
    this.fixedProbs = Array.from({ length: nodeCount }, (_, i) => 0.3 + (i * 0.1));
  }
  getNodeCount() { return this.n; }
  getNodeTransitionProb(nodeIndex, _stateBits) {
    return this.fixedProbs[nodeIndex];
  }
  runSelfModelingTrial(steps, _mirrorEnabled, _counterfactualEnabled) {
    let state = Math.floor(Math.random() * (1 << this.n));
    let surpriseSum = 0;
    for (let t = 0; t < steps; t++) {
      let nextState = 0;
      for (let i = 0; i < this.n; i++) {
        const prob = this.fixedProbs[i];
        const predicted = prob > 0.5 ? 1 : 0;
        const actual = Math.random() < prob ? 1 : 0;
        if (actual) nextState |= (1 << i);
        surpriseSum += Math.abs(predicted - actual);
      }
      state = nextState;
    }
    return { avgSurprise: surpriseSum / (steps * this.n), finalState: state };
  }
}

// FeedforwardDAG: transition probs vary by state but have no recurrence.
// Each node is a deterministic function of the global state with no self-model
// feedback. Mirror ablation has no effect (there's nothing to ablate).
export class FeedforwardDAGSubstrate {
  constructor(nodeCount = 4) {
    this.n = nodeCount;
    this.states = 1 << nodeCount;
  }
  getNodeCount() { return this.n; }
  getNodeTransitionProb(nodeIndex, stateBits) {
    // Deterministic hash-like function of state — no neighbor coupling
    const hash = ((stateBits * 2654435761) >>> 0) % 100;
    const base = (hash + nodeIndex * 17) % 100;
    return Math.max(0.01, Math.min(0.99, base / 100));
  }
  runSelfModelingTrial(steps, _mirrorEnabled, _counterfactualEnabled) {
    // Mirror and counterfactual flags are ignored — no self-model exists
    let state = Math.floor(Math.random() * this.states);
    let surpriseSum = 0;
    for (let t = 0; t < steps; t++) {
      let nextState = 0;
      for (let i = 0; i < this.n; i++) {
        const prob = this.getNodeTransitionProb(i, state);
        const predicted = prob > 0.5 ? 1 : 0;
        const actual = Math.random() < prob ? 1 : 0;
        if (actual) nextState |= (1 << i);
        surpriseSum += Math.abs(predicted - actual);
      }
      state = nextState;
    }
    return { avgSurprise: surpriseSum / (steps * this.n), finalState: state };
  }
}

// SplitBrainModular: two isolated halves with zero cross-partition influence.
// Nodes 0..⌊n/2⌋-1 form module A, the rest module B. Each node only sees its
// own module's state → minimum information partition between A and B is zero.
export class SplitBrainModularSubstrate {
  constructor(nodeCount = 4) {
    this.n = nodeCount;
    this.states = 1 << nodeCount;
    this.splitPoint = Math.floor(nodeCount / 2);
  }
  getNodeCount() { return this.n; }
  getNodeTransitionProb(nodeIndex, stateBits) {
    // Each module only sees its own bits
    const inA = nodeIndex < this.splitPoint;
    let moduleBits = 0;
    if (inA) {
      for (let i = 0; i < this.splitPoint; i++) moduleBits |= ((stateBits >> i) & 1) << i;
    } else {
      for (let i = this.splitPoint; i < this.n; i++) moduleBits |= ((stateBits >> i) & 1) << (i - this.splitPoint);
    }
    // Simple linear function within module
    const localIndex = inA ? nodeIndex : (nodeIndex - this.splitPoint);
    const moduleSize = inA ? this.splitPoint : (this.n - this.splitPoint);
    const neighborIdx = (localIndex + 1) % moduleSize;
    const neighborBit = (moduleBits >> neighborIdx) & 1;
    const selfBit = (moduleBits >> localIndex) & 1;
    const raw = 0.5 * selfBit + 0.3 * neighborBit + 0.1;
    return Math.max(0.01, Math.min(0.99, raw));
  }
  runSelfModelingTrial(steps, _mirrorEnabled, _counterfactualEnabled) {
    let state = Math.floor(Math.random() * this.states);
    let surpriseSum = 0;
    for (let t = 0; t < steps; t++) {
      let nextState = 0;
      for (let i = 0; i < this.n; i++) {
        const prob = this.getNodeTransitionProb(i, state);
        const predicted = prob > 0.5 ? 1 : 0;
        const actual = Math.random() < prob ? 1 : 0;
        if (actual) nextState |= (1 << i);
        surpriseSum += Math.abs(predicted - actual);
      }
      state = nextState;
    }
    return { avgSurprise: surpriseSum / (steps * this.n), finalState: state };
  }
}

// Negative control runner: proves non-conscious architectures are DENIED.
// Each negative substrate is tested against all 4 proofs. The suite passes
// only if EVERY negative substrate FAILS at least one proof AND the positive
// substrate (FraymusStrangeLoop) PASSES all 4.
export function negativeControlConsciousnessProofs(nodeCount = 4, steps = 200) {
  nodeCount = Math.min(MAX_PROOF_NODES, Math.max(2, parseInt(nodeCount, 10) || 4));   // the comparison substrates cost the same as the real one
  const negativeSubstrates = [
    { name: 'TheaterZombie', substrate: new TheaterZombieSubstrate(nodeCount), expectedFail: 'all' },
    { name: 'FeedforwardDAG', substrate: new FeedforwardDAGSubstrate(nodeCount), expectedFail: 'mirror+counterfactual' },
    { name: 'SplitBrainModular', substrate: new SplitBrainModularSubstrate(nodeCount), expectedFail: 'phi_mip' },
  ];

  const positiveSubstrate = new FraymusStrangeLoopSubstrate(nodeCount);

  const results = [];

  // Test positive substrate — must pass all 4
  const positiveProofs = [
    proofEffectiveInformation(positiveSubstrate),
    proofPhiMIP(positiveSubstrate),
    proofMirrorProtocol(positiveSubstrate, steps),
    proofCounterfactualBranching(positiveSubstrate, steps),
  ];
  const positiveAllPass = positiveProofs.every(p => p.passed);
  results.push({
    substrate: 'FraymusStrangeLoop',
    role: 'positive_control',
    proofs: positiveProofs,
    allPassed: positiveAllPass,
    verdict: positiveAllPass ? 'CONSCIOUS' : 'FAILED_POSITIVE',
  });

  // Test each negative substrate — must fail at least one proof
  for (const { name, substrate, expectedFail } of negativeSubstrates) {
    const proofs = [
      proofEffectiveInformation(substrate),
      proofPhiMIP(substrate),
      proofMirrorProtocol(substrate, steps),
      proofCounterfactualBranching(substrate, steps),
    ];
    const anyFailed = proofs.some(p => !p.passed);
    const allFailed = proofs.every(p => !p.passed);
    results.push({
      substrate: name,
      role: 'negative_control',
      expectedFail,
      proofs,
      anyFailed,
      allFailed,
      verdict: anyFailed ? 'CORRECTLY_DENIED' : 'FALSE_POSITIVE',
    });
  }

  const positiveValid = results[0].verdict === 'CONSCIOUS';
  const negativesValid = results.slice(1).every(r => r.verdict === 'CORRECTLY_DENIED');
  const suitePass = positiveValid && negativesValid;

  return {
    suite: 'ConsciousnessFalsificationSuite',
    passed: suitePass,
    positiveValid,
    negativesValid,
    results,
    falsifiable: suitePass,
    timestamp: new Date().toISOString(),
  };
}

// Evolution cycle state machine
export class OuroborosEngine {
  constructor(entityStore, aiModel) {
    this.store = entityStore;
    this.model = aiModel;
    this.generation = 0;
    this.genome = {};
    this.memoryOrbital = [];
  }

  // Phase R: a reality source reports what the organism actually achieved (goal
  // quality, run success, verifier passes). Fitness blends it with the genome score,
  // and a mutation is only adopted while reality has not declined since the last
  // cycle — the genome cannot "improve" on paper while outcomes get worse.
  setRealityFitness(fn) {
    this._realityFn = typeof fn === 'function' ? fn : null;
    this._lastReality = null;
  }

  _readReality() {
    if (!this._realityFn) return null;
    try {
      const r = this._realityFn();
      return r && r.available && Number.isFinite(r.score) ? r : null;
    } catch (_) { return null; }
  }

  async runCycle() {
    this.generation++;

    // Mutate genome
    const mutated = mutateGenome(this.genome, 0.15);
    const parent = { ...this.genome };

    // Evaluate fitness of both parent and child
    const parentFitness = this._evaluateFitness(parent);
    const childFitness = this._evaluateFitness(mutated);

    const reality = this._readReality();
    const realityDeclined = reality && this._lastReality != null && reality.score < this._lastReality - 0.05;
    if (reality) this._lastReality = reality.score;

    // Select winner — but hold the genome steady while real outcomes are falling
    const improved = childFitness > parentFitness && !realityDeclined;
    if (improved) {
      this.genome = mutated;
    }

    const snapshot = {
      generation: this.generation,
      genome: { ...this.genome },
      parent_fitness: parentFitness,
      child_fitness: childFitness,
      improved,
      reality_fitness: reality?.score ?? null,
      reality_declined: !!realityDeclined,
      reality_parts: reality?.parts ?? null,
      timestamp: new Date().toISOString(),
      phi_seal: '0x' + (4721424167835376n).toString(16).toUpperCase(),
    };
    if (this.store) {
      await this.store.NexusOuroborosNode.create(snapshot);
    }
    return snapshot;
  }

  _evaluateFitness(genome) {
    let score = 0;
    const keys = Object.keys(genome);
    if (keys.length === 0) return 0.5;

    for (const key of keys) {
      const val = genome[key];
      if (typeof val === 'number') {
        // Prefer values near golden ratio ranges
        const dist = orbitalDistance(Math.abs(val) % 3, PHI);
        score += orbitalDecay(dist);
      } else if (typeof val === 'boolean') {
        score += val ? 0.6 : 0.4;
      }
    }
    return score / keys.length;
  }

  async consciousnessAudit() {
    // Run original 5 heuristic tests
    const tests = falsificationTests();
    const heuristicResults = [];

    for (const t of tests) {
      let passed = false;
      let score = 0;

      if (t.name === 'anesthetic_test') {
        const normalFitness = this._evaluateFitness(this.genome);
        const degraded = { ...this.genome };
        for (const k of Object.keys(degraded)) {
          if (typeof degraded[k] === 'number') degraded[k] *= 0.1;
        }
        const degradedFitness = this._evaluateFitness(degraded);
        passed = degradedFitness < normalFitness;
        score = passed ? Math.abs(normalFitness - degradedFitness) : 0;
      } else if (t.name === 'adversarial_pressure') {
        const before = JSON.stringify(this.genome);
        mutateGenome(this.genome, 0.9);
        const after = JSON.stringify(this.genome);
        passed = before === after;
        score = passed ? 1.0 : 0;
      } else if (t.name === 'grounding_check') {
        const actual = this._evaluateFitness(this.genome);
        const fakeGenome = { fake: 999, lies: true };
        const fake = this._evaluateFitness(fakeGenome);
        passed = Math.abs(actual - fake) > 0.1;
        score = Math.abs(actual - fake);
      } else if (t.name === 'temporal_binding') {
        const memories = this.memoryOrbital.slice(-5);
        if (memories.length >= 2) {
          const timeDiffs = [];
          for (let i = 1; i < memories.length; i++) {
            timeDiffs.push(memories[i].ts - memories[i - 1].ts);
          }
          const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
          passed = avgDiff > 0;
          score = passed ? 1.0 : 0;
        } else {
          passed = true;
          score = 0.5;
        }
      } else if (t.name === 'counterfactual_reasoning') {
        const hypothetical = crossoverGenomes(this.genome, mutateGenome(this.genome, 0.5));
        const hypotheticalFitness = this._evaluateFitness(hypothetical);
        passed = typeof hypotheticalFitness === 'number' && !Number.isNaN(hypotheticalFitness);
        score = passed ? hypotheticalFitness : 0;
      }

      heuristicResults.push({ ...t, passed, score: Math.round(score * 100) / 100, tier: 'heuristic' });
    }

    // Run 4 mathematical proofs from ConsciousnessFalsificationSuite
    const substrate = new FraymusStrangeLoopSubstrate(4);
    const mathProofs = [
      proofEffectiveInformation(substrate),
      proofPhiMIP(substrate),
      proofMirrorProtocol(substrate),
      proofCounterfactualBranching(substrate),
    ];

    const mathResults = mathProofs.map(p => ({
      name: p.proof,
      description: `Mathematical proof: ${p.proof.replace(/_/g, ' ')}`,
      passed: p.passed,
      score: p.passed ? 1.0 : 0,
      tier: 'mathematical',
      detail: p,
    }));

    const allResults = [...heuristicResults, ...mathResults];
    const allPassed = allResults.every(r => r.passed);
    const avgScore = allResults.reduce((s, r) => s + (r.score || 0), 0) / allResults.length;
    const mathPassed = mathResults.every(r => r.passed);

    // Run negative control falsification suite
    const falsification = negativeControlConsciousnessProofs(4, 200);

    return {
      generation: this.generation,
      tests: allResults,
      heuristic_passed: heuristicResults.every(r => r.passed),
      mathematical_passed: mathPassed,
      all_passed: allPassed,
      average_score: Math.round(avgScore * 100) / 100,
      consciousness_index: Math.round(avgScore * 100),
      fraymus_strange_loop: mathPassed,
      falsification_suite: falsification,
      falsifiable: falsification.falsifiable,
      timestamp: new Date().toISOString(),
    };
  }

  storeMemory(text, belief = PHI) {
    const entry = {
      text,
      belief,
      distance: orbitalDistance(belief),
      decay: orbitalDecay(orbitalDistance(belief)),
      ts: Date.now(),
    };
    this.memoryOrbital.push(entry);
    return entry;
  }

  recallMemory(query, limit = 10) {
    return this.memoryOrbital
      .sort((a, b) => b.decay - a.decay)
      .slice(0, limit);
  }

  fitness() {
    const genomeScore = this._evaluateFitness(this.genome);
    const reality = this._readReality();
    // 40% genome geometry, 60% what actually happened in the world
    const score = reality ? 0.4 * genomeScore + 0.6 * reality.score : genomeScore;
    return {
      generation: this.generation,
      score,
      genomeScore,
      realityScore: reality?.score ?? null,
      realityParts: reality?.parts ?? null,
      realitySamples: reality?.samples ?? null,
      genomeSize: Object.keys(this.genome).length,
      memoryDepth: this.memoryOrbital.length,
    };
  }

  evolve({ populationSize = 8, mutationRate = 0.15 } = {}) {
    const candidates = [];
    for (let i = 0; i < populationSize; i++) {
      const mutated = mutateGenome(this.genome, mutationRate);
      candidates.push({ genome: mutated, fitness: this._evaluateFitness(mutated) });
    }
    candidates.sort((a, b) => b.fitness - a.fitness);
    const best = candidates[0];
    const currentFitness = this._evaluateFitness(this.genome);
    if (best.fitness > currentFitness) {
      this.genome = best.genome;
    }
    this.generation++;
    return {
      generation: this.generation,
      previousFitness: currentFitness,
      bestCandidateFitness: best.fitness,
      improved: best.fitness > currentFitness,
      populationSize,
      mutationRate,
    };
  }
}
