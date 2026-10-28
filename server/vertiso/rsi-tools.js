// RSI Fleet Tools — Recursive Self-Improvement tools callable by all agents
const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function createRSITools(rsi) {
  return [
    {
      name: 'rsi.evolve',
      group: 'rsi',
      risk: 'safe',
      description: 'Run one Recursive Self-Improvement evolution cycle for an agent. Evaluates fitness across 8 dimensions, generates mutant genomes, selects the best, and records the generation. The agent literally evolves itself.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        metrics: {
          type: 'object',
          properties: {
            taskCompletion: { type: 'number', minimum: 0, maximum: 1 },
            responseQuality: { type: 'number', minimum: 0, maximum: 1 },
            toolEfficiency: { type: 'number', minimum: 0, maximum: 1 },
            memoryUtilization: { type: 'number', minimum: 0, maximum: 1 },
            delegationAccuracy: { type: 'number', minimum: 0, maximum: 1 },
            userSatisfaction: { type: 'number', minimum: 0, maximum: 1 },
            speedScore: { type: 'number', minimum: 0, maximum: 1 },
            novelty: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
        populationSize: { type: 'integer', minimum: 2, maximum: 16 },
        mutationRate: { type: 'number', minimum: 0.01, maximum: 1 },
      }, ['agentId']),
      execute: async ({ args }) => {
        return rsi.evolve(args.agentId, args.metrics || {}, {
          populationSize: args.populationSize || 6,
          mutationRate: args.mutationRate || 0.15,
        });
      },
    },
    {
      name: 'rsi.reflect',
      group: 'rsi',
      risk: 'safe',
      description: 'Agent self-reflection: analyze performance trends across all fitness dimensions, identify weaknesses, and generate targeted improvement recommendations. The agent uses this to understand where it needs to grow.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
      }, ['agentId']),
      execute: async ({ args }) => {
        return rsi.reflect(args.agentId);
      },
    },
    {
      name: 'rsi.improve',
      group: 'rsi',
      risk: 'safe',
      description: 'Apply a targeted improvement to an agent genome parameter. Use after rsi.reflect identifies weaknesses. Changes are recorded and can be reverted.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        kind: string(100, { minLength: 1 }),
        target: string(100, { minLength: 1 }),
        value: { type: 'number' },
      }, ['agentId', 'kind', 'target']),
      execute: async ({ args }) => {
        return rsi.improve(args.agentId, args.kind, {
          target: args.target,
          value: args.value,
        });
      },
    },
    {
      name: 'rsi.rewrite_prompt',
      group: 'rsi',
      risk: 'approval',
      description: 'Use the local LLM to rewrite an agent system prompt based on feedback. The agent can literally rewrite its own instructions to be more effective. Requires approval before applying.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        currentPrompt: string(4000, { minLength: 10 }),
        feedback: string(2000, { minLength: 10 }),
      }, ['agentId', 'currentPrompt', 'feedback']),
      execute: async ({ args }) => {
        return rsi.rewritePrompt(args.agentId, args.currentPrompt, args.feedback);
      },
    },
    {
      name: 'rsi.revert',
      group: 'rsi',
      risk: 'safe',
      description: 'Revert a previous improvement that degraded performance.',
      parameters: object({
        improvementId: string(100, { minLength: 1 }),
      }, ['improvementId']),
      execute: async ({ args }) => {
        return rsi.revert(args.improvementId);
      },
    },
    {
      name: 'rsi.evolve_fleet',
      group: 'rsi',
      risk: 'safe',
      description: 'Evolve ALL agents in the fleet simultaneously. Each agent gets its own evolution cycle with optional per-agent metrics. Returns fleet-wide fitness summary.',
      parameters: object({
        agentIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32 },
        metrics: { type: 'object' },
      }, ['agentIds']),
      execute: async ({ args }) => {
        return rsi.evolveFleet(args.agentIds, args.metrics || {});
      },
    },
    {
      name: 'rsi.genome',
      group: 'rsi',
      risk: 'safe',
      description: 'Get the current active genome for an agent — all tunable parameters that control its behavior.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
      }, ['agentId']),
      execute: async ({ args }) => {
        return { agentId: args.agentId, genome: rsi.getGenome(args.agentId), generation: rsi.currentGeneration(args.agentId) };
      },
    },
    {
      name: 'rsi.history',
      group: 'rsi',
      risk: 'safe',
      description: 'Get evolution history for an agent — all generations, fitness scores, and mutations.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      }, ['agentId']),
      execute: async ({ args }) => {
        return { history: rsi.history(args.agentId, args.limit || 20) };
      },
    },
    {
      name: 'rsi.status',
      group: 'rsi',
      risk: 'safe',
      description: 'Get RSI status across all agents — generations, fitness, improvements.',
      parameters: object({}),
      execute: async () => {
        return rsi.status();
      },
    },
  ];
}
