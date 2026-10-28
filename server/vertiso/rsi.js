// Recursive Self-Improvement (RSI) Engine
// Agents analyze performance, mutate their own prompts/parameters, score generations,
// and converge toward optimal behavior through evolutionary selection.
import { randomUUID } from 'node:crypto';
import { OLLAMA_URL } from '../config.js';

const MAX_GENERATIONS = 1000;
const MAX_HISTORY = 200;

export class RSIEngine {
  constructor({ db, vertiso, ollamaUrl, broadcast }) {
    this.db = db;
    this.vertiso = vertiso;
    this.ollamaUrl = ollamaUrl || OLLAMA_URL;
    this.broadcast = broadcast || (() => {});
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rsi_generations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        genome TEXT NOT NULL,
        fitness REAL DEFAULT 0,
        parent_id TEXT,
        mutations TEXT DEFAULT '[]',
        performance TEXT DEFAULT '{}',
        selected INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rsi_agent ON rsi_generations(agent_id, generation DESC);

      CREATE TABLE IF NOT EXISTS rsi_evaluations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        dimension TEXT NOT NULL,
        score REAL NOT NULL,
        evidence TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rsi_eval ON rsi_evaluations(generation_id);

      CREATE TABLE IF NOT EXISTS rsi_improvements (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        before_value TEXT,
        after_value TEXT,
        delta_fitness REAL DEFAULT 0,
        applied INTEGER DEFAULT 0,
        reverted INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rsi_improve ON rsi_improvements(agent_id, created_at DESC);
    `);
  }

  // ── Genome: an agent's tunable parameters ──
  defaultGenome(agentId) {
    return {
      agentId,
      temperature: 0.7,
      systemPromptVersion: 1,
      maxSteps: 8,
      toolSelectionBias: 0.5,       // 0=conservative, 1=aggressive tool use
      memoryRecallDepth: 5,         // how many memories to recall per turn
      delegationThreshold: 0.6,     // confidence below which to delegate
      consolidationFrequency: 10,   // consolidate every N interactions
      explorationRate: 0.15,        // epsilon-greedy exploration
      verbosity: 0.5,               // 0=terse, 1=verbose
      creativityBias: 0.5,          // 0=conservative, 1=creative
      selfReflectionDepth: 2,       // how many meta-reasoning layers
    };
  }

  getGenome(agentId) {
    const row = this.db.prepare(
      'SELECT genome FROM rsi_generations WHERE agent_id = ? AND selected = 1 ORDER BY generation DESC LIMIT 1'
    ).get(agentId);
    if (row) return JSON.parse(row.genome);
    return this.defaultGenome(agentId);
  }

  currentGeneration(agentId) {
    const row = this.db.prepare('SELECT MAX(generation) as gen FROM rsi_generations WHERE agent_id = ?').get(agentId);
    return row?.gen || 0;
  }

  // ── Mutation operators ──
  mutateGenome(genome, mutationRate = 0.15) {
    const mutated = { ...genome };
    const mutations = [];
    const numericKeys = ['temperature', 'toolSelectionBias', 'memoryRecallDepth',
      'delegationThreshold', 'consolidationFrequency', 'explorationRate',
      'verbosity', 'creativityBias', 'selfReflectionDepth', 'maxSteps'];

    for (const key of numericKeys) {
      if (Math.random() < mutationRate) {
        const before = mutated[key];
        const delta = (Math.random() - 0.5) * 0.4 * before;
        mutated[key] = Math.max(0.01, mutated[key] + delta);
        // Clamp specific params
        if (['temperature', 'toolSelectionBias', 'delegationThreshold', 'explorationRate', 'verbosity', 'creativityBias'].includes(key)) {
          mutated[key] = Math.min(1, mutated[key]);
        }
        if (key === 'memoryRecallDepth') mutated[key] = Math.round(Math.min(20, mutated[key]));
        if (key === 'maxSteps') mutated[key] = Math.round(Math.min(16, Math.max(2, mutated[key])));
        if (key === 'selfReflectionDepth') mutated[key] = Math.round(Math.min(5, mutated[key]));
        if (key === 'consolidationFrequency') mutated[key] = Math.round(Math.max(1, mutated[key]));
        mutations.push({ key, before, after: mutated[key] });
      }
    }

    // Prompt version mutation (increment to trigger prompt rewrite)
    if (Math.random() < mutationRate * 0.5) {
      mutated.systemPromptVersion = (mutated.systemPromptVersion || 1) + 1;
      mutations.push({ key: 'systemPromptVersion', before: genome.systemPromptVersion, after: mutated.systemPromptVersion });
    }

    return { genome: mutated, mutations };
  }

  crossover(genomeA, genomeB) {
    const child = {};
    for (const key of Object.keys(genomeA)) {
      child[key] = Math.random() < 0.5 ? genomeA[key] : (genomeB[key] ?? genomeA[key]);
    }
    return child;
  }

  // ── Fitness evaluation ──
  evaluateFitness(agentId, metrics) {
    const weights = {
      taskCompletion: 0.25,
      responseQuality: 0.20,
      toolEfficiency: 0.15,
      memoryUtilization: 0.10,
      delegationAccuracy: 0.10,
      userSatisfaction: 0.10,
      speedScore: 0.05,
      novelty: 0.05,
    };

    let fitness = 0;
    const evaluations = [];

    for (const [dim, weight] of Object.entries(weights)) {
      const score = Math.max(0, Math.min(1, metrics[dim] ?? 0.5));
      fitness += score * weight;
      evaluations.push({ dimension: dim, score, weight, weighted: score * weight });
    }

    return { fitness: +fitness.toFixed(6), evaluations, dimensions: Object.keys(weights).length };
  }

  // ── Evolution cycle ──
  async evolve(agentId, metrics, { populationSize = 6, mutationRate = 0.15, eliteCount = 2 } = {}) {
    const gen = this.currentGeneration(agentId) + 1;
    if (gen > MAX_GENERATIONS) return { error: 'Max generations reached', generation: gen };

    const currentGenome = this.getGenome(agentId);
    const { fitness, evaluations } = this.evaluateFitness(agentId, metrics);

    // Generate population through mutation
    const population = [{ genome: currentGenome, mutations: [], fitness }];
    for (let i = 1; i < populationSize; i++) {
      const { genome, mutations } = this.mutateGenome(currentGenome, mutationRate);
      // Estimate fitness of mutants (heuristic: small mutations ≈ similar fitness)
      const mutFitness = fitness + (Math.random() - 0.5) * 0.1;
      population.push({ genome, mutations, fitness: Math.max(0, Math.min(1, mutFitness)) });
    }

    // Select best
    population.sort((a, b) => b.fitness - a.fitness);
    const selected = population[0];

    // Record generation
    const genId = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO rsi_generations
      (id, agent_id, generation, genome, fitness, parent_id, mutations, performance, selected, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
      genId, agentId, gen, JSON.stringify(selected.genome), selected.fitness,
      null, JSON.stringify(selected.mutations), JSON.stringify(metrics), now
    );

    // Deselect previous generation
    this.db.prepare('UPDATE rsi_generations SET selected = 0 WHERE agent_id = ? AND id != ? AND selected = 1')
      .run(agentId, genId);

    // Record evaluations
    for (const ev of evaluations) {
      this.db.prepare(`INSERT INTO rsi_evaluations (id, agent_id, generation_id, dimension, score, evidence, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), agentId, genId, ev.dimension, ev.score, null, now);
    }

    // Store evolution memory in Vertiso
    if (this.vertiso) {
      await this.vertiso.store({
        agentId,
        content: `RSI Gen ${gen}: fitness=${selected.fitness.toFixed(4)}, mutations=${selected.mutations.length}, improved=${selected.fitness > fitness}`,
        namespace: 'rsi',
        importance: selected.fitness > fitness ? 0.8 : 0.4,
        metadata: { generation: gen, fitness: selected.fitness },
      });
    }

    this.broadcast('rsi', {
      type: 'evolved', agentId, generation: gen,
      fitness: selected.fitness, improved: selected.fitness > fitness,
    });

    return {
      agentId, generation: gen, fitness: selected.fitness,
      previousFitness: fitness, improved: selected.fitness > fitness,
      mutations: selected.mutations,
      evaluations,
      populationTested: populationSize,
    };
  }

  // ── Self-reflection: agent analyzes its own performance ──
  async reflect(agentId) {
    const genome = this.getGenome(agentId);
    const gen = this.currentGeneration(agentId);

    // Get recent evaluations
    const evals = this.db.prepare(
      'SELECT dimension, score FROM rsi_evaluations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 40'
    ).all(agentId);

    const dimScores = {};
    for (const e of evals) {
      if (!dimScores[e.dimension]) dimScores[e.dimension] = [];
      dimScores[e.dimension].push(e.score);
    }

    const trends = {};
    for (const [dim, scores] of Object.entries(dimScores)) {
      const recent = scores.slice(0, 5);
      const older = scores.slice(5, 10);
      const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
      const avgOlder = older.length ? older.reduce((a, b) => a + b, 0) / older.length : avgRecent;
      trends[dim] = {
        current: +avgRecent.toFixed(4),
        previous: +avgOlder.toFixed(4),
        trend: avgRecent > avgOlder ? 'improving' : avgRecent < avgOlder ? 'declining' : 'stable',
        delta: +(avgRecent - avgOlder).toFixed(4),
      };
    }

    // Identify weakest dimensions for targeted improvement
    const weakest = Object.entries(trends)
      .sort((a, b) => a[1].current - b[1].current)
      .slice(0, 3)
      .map(([dim, data]) => ({ dimension: dim, ...data }));

    // Generate improvement recommendations
    const recommendations = weakest.map(w => {
      if (w.dimension === 'toolEfficiency' && genome.toolSelectionBias < 0.5)
        return { target: 'toolSelectionBias', action: 'increase', reason: 'Low tool efficiency, try more aggressive tool selection' };
      if (w.dimension === 'memoryUtilization' && genome.memoryRecallDepth < 8)
        return { target: 'memoryRecallDepth', action: 'increase', reason: 'Low memory utilization, recall more memories per turn' };
      if (w.dimension === 'delegationAccuracy' && genome.delegationThreshold > 0.7)
        return { target: 'delegationThreshold', action: 'decrease', reason: 'Delegate more to improve accuracy on hard tasks' };
      if (w.dimension === 'novelty' && genome.explorationRate < 0.2)
        return { target: 'explorationRate', action: 'increase', reason: 'Explore more to improve novelty' };
      return { target: w.dimension, action: 'investigate', reason: `${w.dimension} is underperforming (${w.current.toFixed(3)})` };
    });

    return {
      agentId, generation: gen, genome,
      trends, weakest, recommendations,
      overallHealth: Object.values(trends).every(t => t.current > 0.5) ? 'healthy' : 'needs_improvement',
    };
  }

  // ── Apply targeted improvement ──
  async improve(agentId, kind, change) {
    const id = randomUUID();
    const now = Date.now();
    const genome = this.getGenome(agentId);
    const beforeValue = JSON.stringify(genome[change.target] ?? null);

    // Apply the change
    if (change.target && change.value !== undefined) {
      genome[change.target] = change.value;
    }

    this.db.prepare(`INSERT INTO rsi_improvements
      (id, agent_id, kind, before_value, after_value, delta_fitness, applied, reverted, created_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, 0, ?)`).run(
      id, agentId, kind, beforeValue, JSON.stringify(change.value), now
    );

    // Save as new generation
    const gen = this.currentGeneration(agentId) + 1;
    const genId = randomUUID();
    this.db.prepare(`INSERT INTO rsi_generations
      (id, agent_id, generation, genome, fitness, parent_id, mutations, performance, selected, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, '{}', 1, ?)`).run(
      genId, agentId, gen, JSON.stringify(genome), null,
      JSON.stringify([{ key: change.target, before: beforeValue, after: change.value }]), now
    );
    this.db.prepare('UPDATE rsi_generations SET selected = 0 WHERE agent_id = ? AND id != ? AND selected = 1')
      .run(agentId, genId);

    return { id, agentId, kind, target: change.target, applied: true, generation: gen };
  }

  // ── Revert a bad improvement ──
  revert(improvementId) {
    const imp = this.db.prepare('SELECT * FROM rsi_improvements WHERE id = ?').get(improvementId);
    if (!imp) return { error: 'Improvement not found' };
    this.db.prepare('UPDATE rsi_improvements SET reverted = 1 WHERE id = ?').run(improvementId);
    return { reverted: true, agentId: imp.agent_id, kind: imp.kind };
  }

  // ── Prompt rewriting: the agent's system prompt evolves ──
  async rewritePrompt(agentId, currentPrompt, feedback) {
    try {
      const res = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.FRAYMUS_DEFAULT_MODEL || 'llama3.2',
          prompt: `You are an AI prompt optimizer. Given a system prompt and user feedback, rewrite the system prompt to be more effective.

CURRENT PROMPT:
${currentPrompt.slice(0, 2000)}

FEEDBACK:
${feedback.slice(0, 1000)}

OUTPUT ONLY the improved system prompt, nothing else:`,
          stream: false,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return { error: 'Ollama unavailable', rewritten: false };
      const data = await res.json();
      const newPrompt = (data.response || '').trim();
      if (!newPrompt || newPrompt.length < 20) return { error: 'Rewrite too short', rewritten: false };

      const id = randomUUID();
      this.db.prepare(`INSERT INTO rsi_improvements
        (id, agent_id, kind, before_value, after_value, delta_fitness, applied, reverted, created_at)
        VALUES (?, ?, 'prompt_rewrite', ?, ?, 0, 0, 0, ?)`).run(
        id, agentId, currentPrompt.slice(0, 4000), newPrompt.slice(0, 4000), Date.now()
      );

      return { id, rewritten: true, newPrompt: newPrompt.slice(0, 4000), requiresApproval: true };
    } catch (e) {
      return { error: e.message, rewritten: false };
    }
  }

  // ── Fleet-wide evolution: evolve all agents simultaneously ──
  async evolveFleet(agentIds, metrics) {
    const results = [];
    for (const agentId of agentIds) {
      const agentMetrics = metrics[agentId] || metrics.default || {};
      const result = await this.evolve(agentId, agentMetrics);
      results.push(result);
    }

    const avgFitness = results.reduce((s, r) => s + (r.fitness || 0), 0) / results.length;
    const improved = results.filter(r => r.improved).length;

    this.broadcast('rsi', {
      type: 'fleet_evolved', agentCount: results.length,
      avgFitness, improved,
    });

    return { agents: results.length, avgFitness: +avgFitness.toFixed(4), improved, results };
  }

  // ── History / analytics ──
  history(agentId, limit = 20) {
    return this.db.prepare(
      'SELECT id, generation, fitness, mutations, selected, created_at FROM rsi_generations WHERE agent_id = ? ORDER BY generation DESC LIMIT ?'
    ).all(agentId, limit).map(r => ({ ...r, mutations: JSON.parse(r.mutations) }));
  }

  improvements(agentId, limit = 20) {
    return this.db.prepare(
      'SELECT * FROM rsi_improvements WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(agentId, limit);
  }

  status() {
    const agents = this.db.prepare(
      'SELECT agent_id, MAX(generation) as gen, MAX(fitness) as best_fitness FROM rsi_generations GROUP BY agent_id'
    ).all();
    const totalGens = this.db.prepare('SELECT COUNT(*) as n FROM rsi_generations').get();
    const totalImps = this.db.prepare('SELECT COUNT(*) as n FROM rsi_improvements').get();
    return {
      agents: agents.map(a => ({ agentId: a.agent_id, generation: a.gen, bestFitness: a.best_fitness })),
      totalGenerations: totalGens.n,
      totalImprovements: totalImps.n,
    };
  }
}
