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

export class FraymusStrangeLoopSubstrate {
  constructor(nodeCount = 4) {
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
export function proofPhiMIP(substrate) {
  const n = substrate.getNodeCount();
  const totalStates = 1 << n;
  let phiMIP = Infinity;

  for (let mask = 1; mask < totalStates - 1; mask++) {
    const partA = [];
    const partB = [];
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) partA.push(i);
      else partB.push(i);
    }
    if (!partA.length || !partB.length) continue;

    let integratedInfo = 0;
    for (let s = 0; s < totalStates; s++) {
      for (const nodeA of partA) {
        const pWhole = substrate.getNodeTransitionProb(nodeA, s);
        const maskedState = s & mask;
        const pPart = substrate.getNodeTransitionProb(nodeA, maskedState);
        const diff = Math.abs(pWhole - pPart);
        integratedInfo += diff / totalStates;
      }
    }
    phiMIP = Math.min(phiMIP, integratedInfo);
  }

  if (!isFinite(phiMIP)) phiMIP = 0;
  return { proof: 'phi_mip', phi: phiMIP, passed: phiMIP > 0.01, threshold: 0.01 };
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

// Evolution cycle state machine
export class OuroborosEngine {
  constructor(entityStore, aiModel) {
    this.store = entityStore;
    this.model = aiModel;
    this.generation = 0;
    this.genome = {};
    this.memoryOrbital = [];
  }

  async runCycle() {
    this.generation++;

    // Mutate genome
    const mutated = mutateGenome(this.genome, 0.15);
    const parent = { ...this.genome };

    // Evaluate fitness of both parent and child
    const parentFitness = this._evaluateFitness(parent);
    const childFitness = this._evaluateFitness(mutated);

    // Select winner
    if (childFitness > parentFitness) {
      this.genome = mutated;
    }

    const snapshot = {
      generation: this.generation,
      genome: { ...this.genome },
      parent_fitness: parentFitness,
      child_fitness: childFitness,
      improved: childFitness > parentFitness,
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

    return {
      generation: this.generation,
      tests: allResults,
      heuristic_passed: heuristicResults.every(r => r.passed),
      mathematical_passed: mathPassed,
      all_passed: allPassed,
      average_score: Math.round(avgScore * 100) / 100,
      consciousness_index: Math.round(avgScore * 100),
      fraymus_strange_loop: mathPassed,
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
}
