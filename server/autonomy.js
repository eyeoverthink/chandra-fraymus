import { ouroboros, hermes, motor, openclaw, controlPlane, needle, heart, ledger, dreamer, cognition } from './fraymus-tools.js';
import { FraymusStrangeLoopSubstrate, proofEffectiveInformation, proofPhiMIP, proofMirrorProtocol, proofCounterfactualBranching } from './fraymus/intelligence/ouroboros.js';
import { generateIdentity, numberFromPub, signText } from './fraymus/core/identity.js';
import { sha256hex } from './fraymus/core/crypto.js';
import { kuramotoR, kuramotoStep } from './fraymus/protocol/v13.js';
import { AGENTS, COMPUTE_NODES, PHI } from './fraymus/core/constants.js';

const AUTONOMY_INTERVAL_MS = 30_000;
const EVOLUTION_INTERVAL_MS = 300_000;
const DREAM_CONSOLIDATION_MS = 600_000; // consolidate dreams every 10 minutes

export function createAutonomyEngine({ db, broadcast, agent, tasks, memoryBridge, logEvent }) {
  let identity = null;
  let running = false;
  let autonomyTimer = null;
  let evolutionTimer = null;
  let dreamTimer = null;
  let phaseState = AGENTS.map(() => Math.random() * 2 * Math.PI);
  const naturalFreqs = AGENTS.map((_, i) => 0.1 + 0.05 * Math.sin(i * PHI));
  let generation = 0;
  let lastFitness = 0;
  let autonomyLog = [];

  const log = (action, detail) => {
    const entry = { ts: Date.now(), action, detail: String(detail).slice(0, 500) };
    autonomyLog.push(entry);
    if (autonomyLog.length > 200) autonomyLog = autonomyLog.slice(-100);
    logEvent?.('autonomy.' + action, 'fraymus-autonomy', entry.detail);
    broadcast?.('autonomy', entry);
  };

  async function ensureIdentity() {
    if (!identity) {
      identity = await generateIdentity();
      const num = await numberFromPub(identity.publicKey);
      log('identity', `Ed25519 identity established · agent #${num}`);
    }
    return identity;
  }

  function synchronizePhases() {
    const R = kuramotoR(phaseState);
    phaseState = kuramotoStep(phaseState, naturalFreqs, 1.5);
    const newR = kuramotoR(phaseState);
    if (newR > 0.95 && R <= 0.95) log('sync', `Fleet phase-locked · R=${newR.toFixed(4)}`);
    return { R: newR, phases: phaseState, locked: newR > 0.9 };
  }

  async function runEvolutionCycle() {
    generation++;

    // Recall relevant intelligence memories before evolving
    let priorInsights = [];
    if (memoryBridge) {
      try {
        priorInsights = await memoryBridge.recallRelated(`evolution generation ${generation} fitness improvement`, 3);
      } catch (_) {}
    }

    const result = ouroboros.evolve({ populationSize: 8, mutationRate: 0.15 });
    const fitness = ouroboros.fitness();
    const improved = fitness.score > lastFitness;
    lastFitness = fitness.score;

    log('evolve', `Gen ${generation} · fitness=${fitness.score.toFixed(4)} · ${improved ? 'IMPROVED' : 'stable'}${priorInsights.length ? ` · ${priorInsights.length} prior memories consulted` : ''}`);

    if (improved) {
      const skills = hermes.selectOptimal(fitness);
      log('adapt', `Hermes selected ${skills?.length || 0} optimal skills for gen ${generation}`);
    }

    // Run consciousness proofs each evolution cycle and log to ledger
    try {
      const substrate = new FraymusStrangeLoopSubstrate(4);
      const proofs = [
        proofEffectiveInformation(substrate),
        proofPhiMIP(substrate),
        proofMirrorProtocol(substrate),
        proofCounterfactualBranching(substrate),
      ];
      const allPassed = proofs.every(p => p.passed);
      ledger.record('consciousness.proof', {
        generation, allPassed,
        ei: proofs[0].ei, phi: proofs[1].phi,
        passed: proofs.filter(p => p.passed).length,
      }, 'autonomy');
      broadcast?.('consciousness', { allPassed, generation });
      memoryBridge?.storeConsciousnessProof({ allPassed, proofs, architecture: 'FraymusStrangeLoop' }).catch(() => {});
    } catch (_) {}

    // Trigger idle dream on significant evolution — include prior memory context
    if (improved && generation > 1) {
      const dreamSeed = priorInsights.length
        ? `Evolution gen ${generation}: fitness ${fitness.score.toFixed(4)}. Prior insight: ${String(priorInsights[0].content || priorInsights[0].text || '').slice(0, 200)}`
        : `Evolution gen ${generation}: fitness ${fitness.score.toFixed(4)}`;
      dreamer.dream(
        dreamSeed,
        [`fitness:${fitness.score.toFixed(4)}`, `gen:${generation}`],
        'evolution'
      ).then(d => memoryBridge?.storeDream(d).catch(() => {})).catch(() => {});
    }

    // Store evolution event to Memory Bridge for future recall
    memoryBridge?.storeCognitionResult({
      phase: 'evolution',
      text: `Gen ${generation} fitness=${fitness.score.toFixed(4)} ${improved ? 'improved' : 'stable'}`,
      feeling: heart.recentMood(),
      priorMemories: priorInsights.length,
    }).catch(() => {});

    return { generation, fitness, improved, result, priorMemories: priorInsights.length };
  }

  async function runDreamConsolidation() {
    try {
      const state = dreamer.feel();
      if (state.dreamCount < 3) return;
      const result = await dreamer.consolidate();
      if (result.themes?.length > 0) {
        log('dream.consolidate', `Consolidated ${state.dreamCount} dreams → ${result.themes.length} themes`);
        ledger.record('dream.consolidation', { dreamCount: state.dreamCount, themes: result.themes.length }, 'autonomy');
        broadcast?.('dreamer', { action: 'consolidate', themes: result.themes.length });
      }
    } catch (_) {}
  }

  async function autonomyPulse() {
    try {
      await ensureIdentity();
      const sync = synchronizePhases();
      const compute = motor.status();
      const plane = controlPlane.status();
      const queueDepth = needle.depth?.() || 0;

      if (queueDepth > 0) {
        const job = needle.dequeue?.();
        if (job) {
          const dispatched = motor.submit({ task: job.task, priority: job.priority || 5 });
          log('dispatch', `Needle → Motor: ${job.task.slice(0, 80)}`);
        }
      }

      const mood = heart.recentMood();
      const dreamerState = dreamer.feel();
      const ledgerIntegrity = ledger.verify(10);

      ledger.record('autonomy.pulse', {
        R: sync.R, generation, fitness: lastFitness,
        mood: mood.mood, dreamCount: dreamerState.dreamCount,
      }, 'autonomy');

      const signed = await signText(identity.privateKey, `pulse:${Date.now()}:R=${sync.R.toFixed(4)}`);
      broadcast?.('autonomy', {
        type: 'pulse',
        ts: Date.now(),
        sync: { R: sync.R, locked: sync.locked },
        compute,
        generation,
        fitness: lastFitness,
        queueDepth,
        intelligence: { mood: mood.mood, dreamerState: dreamerState.state, ledgerValid: ledgerIntegrity.valid },
        signed: signed.slice(0, 32) + '…',
      });
    } catch (err) {
      log('error', `Autonomy pulse failed: ${err.message}`);
    }
  }

  return {
    get running() { return running; },
    get generation() { return generation; },
    get fitness() { return lastFitness; },
    get log() { return autonomyLog; },
    get phases() { return phaseState; },

    async start() {
      if (running) return;
      running = true;
      await ensureIdentity();
      log('start', 'Autonomy engine started');

      autonomyTimer = setInterval(() => autonomyPulse(), AUTONOMY_INTERVAL_MS);
      evolutionTimer = setInterval(() => runEvolutionCycle().catch(() => {}), EVOLUTION_INTERVAL_MS);
      dreamTimer = setInterval(() => runDreamConsolidation(), DREAM_CONSOLIDATION_MS);

      await autonomyPulse();
      await runEvolutionCycle();
    },

    stop() {
      if (!running) return;
      running = false;
      clearInterval(autonomyTimer);
      clearInterval(evolutionTimer);
      clearInterval(dreamTimer);
      autonomyTimer = null;
      evolutionTimer = null;
      dreamTimer = null;
      log('stop', 'Autonomy engine stopped');
    },

    async identity() {
      const id = await ensureIdentity();
      const num = await numberFromPub(id.publicKey);
      return { publicKey: id.publicKey, agentNumber: num };
    },

    status() {
      const sync = kuramotoR(phaseState);
      return {
        running,
        generation,
        fitness: lastFitness,
        phaseSync: { R: sync, locked: sync > 0.9 },
        agents: AGENTS,
        computeNodes: COMPUTE_NODES,
        phi: PHI,
        logEntries: autonomyLog.length,
        recentLog: autonomyLog.slice(-10),
      };
    },

    async evolveNow() {
      return runEvolutionCycle();
    },

    syncNow() {
      return synchronizePhases();
    },

    async assessFull() {
      const id = await ensureIdentity();
      const num = await numberFromPub(id.publicKey);
      const fitness = ouroboros.fitness();
      const skills = hermes.listSkills();
      const compute = motor.status();
      const gateway = openclaw.listActions();
      const plane = controlPlane.status();
      const sync = synchronizePhases();

      const mood = heart.recentMood();
      const dreamerState = dreamer.feel();
      const ledgerIntegrity = ledger.verify(10);
      const cognitionState = cognition.status();

      return {
        identity: { agentNumber: num, algorithm: 'Ed25519', healthy: true },
        autonomy: { running, generation, fitness: lastFitness },
        phaseSync: { R: sync.R, locked: sync.locked, agentCount: AGENTS.length },
        intelligence: {
          ouroboros: fitness,
          hermes: { skills: skills.total || 30 },
          motor: compute,
          openclaw: { actions: gateway.count || 23 },
          heart: { mood: mood.mood, readings: mood.readings },
          dreamer: { state: dreamerState.state, dreamCount: dreamerState.dreamCount, score: dreamerState.score },
          ledger: { valid: ledgerIntegrity.valid, checked: ledgerIntegrity.checked },
          cognition: { contextLength: cognitionState.contextLength, modules: cognitionState.modules },
        },
        controlPlane: plane,
        recommendation: running
          ? `Autonomous · Gen ${generation} · R=${sync.R.toFixed(3)} · fitness=${lastFitness.toFixed(4)} · mood:${mood.mood} · dreams:${dreamerState.dreamCount}`
          : 'Autonomy engine not started. Call POST /api/fraymus/autonomy/start.',
      };
    },
  };
}
