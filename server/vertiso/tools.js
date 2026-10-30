// Vertiso Memory Tools — Fleet-callable tools for all 17 agents
const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function createVertisoTools(vertiso) {
  return [
    {
      name: 'vertiso.store',
      group: 'vertiso-memory',
      risk: 'safe',
      description: 'Store a memory in Vertiso vector memory. Memories are semantically searchable, decay over time, and auto-consolidate when similar. Every agent has their own namespace but can read globally.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        content: string(8000, { minLength: 1 }),
        namespace: string(100),
        importance: { type: 'number', minimum: 0, maximum: 1 },
        metadata: { type: 'object' },
      }, ['agentId', 'content']),
      execute: async ({ args }) => {
        return vertiso.store({
          agentId: args.agentId,
          content: args.content,
          namespace: args.namespace || 'global',
          importance: args.importance ?? 0.5,
          metadata: args.metadata || {},
        });
      },
    },
    {
      name: 'vertiso.recall',
      group: 'vertiso-memory',
      risk: 'safe',
      description: 'Recall memories from Vertiso using semantic search. Returns the most relevant memories ranked by similarity + recency + importance. Updates access counts to strengthen recalled memories.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        query: string(2000, { minLength: 1 }),
        namespace: string(100),
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        minSimilarity: { type: 'number', minimum: 0, maximum: 1 },
      }, ['agentId', 'query']),
      execute: async ({ args }) => {
        const memories = await vertiso.recall({
          agentId: args.agentId,
          query: args.query,
          namespace: args.namespace || 'global',
          limit: args.limit || 5,
          minSimilarity: args.minSimilarity ?? 0.3,
        });
        return { memories, count: memories.length };
      },
    },
    {
      name: 'vertiso.recall_global',
      group: 'vertiso-memory',
      risk: 'safe',
      description: 'Search ALL agent memories across the entire fleet. Useful for cross-agent knowledge sharing and collective intelligence.',
      parameters: object({
        query: string(2000, { minLength: 1 }),
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        minSimilarity: { type: 'number', minimum: 0, maximum: 1 },
      }, ['query']),
      execute: async ({ args }) => {
        const memories = await vertiso.recallGlobal({
          query: args.query,
          limit: args.limit || 5,
          minSimilarity: args.minSimilarity ?? 0.3,
        });
        return { memories, count: memories.length };
      },
    },
    {
      name: 'vertiso.consolidate',
      group: 'vertiso-memory',
      risk: 'safe',
      description: 'Consolidate similar memories for an agent. Finds near-duplicate memories (cosine sim > 0.92), merges them, and reduces importance of originals. Mimics human memory consolidation during sleep.',
      parameters: object({
        agentId: string(100, { minLength: 1 }),
        namespace: string(100),
      }, ['agentId']),
      execute: async ({ args }) => {
        return vertiso.consolidate(args.agentId, args.namespace || 'global');
      },
    },
    {
      name: 'vertiso.forget',
      group: 'vertiso-memory',
      risk: 'safe',
      description: 'Remove a specific memory by ID. Used for pruning incorrect or outdated information.',
      parameters: object({
        memoryId: string(100, { minLength: 1 }),
      }, ['memoryId']),
      execute: async ({ args }) => {
        return vertiso.forget(args.memoryId);
      },
    },
    {
      name: 'vertiso.stats',
      group: 'vertiso-memory',
      risk: 'safe',
      description: 'Get Vertiso memory statistics for a specific agent or the entire fleet.',
      parameters: object({
        agentId: string(100),
      }),
      execute: async ({ args }) => {
        if (args.agentId) return vertiso.stats(args.agentId);
        return vertiso.allStats();
      },
    },
  ];
}
