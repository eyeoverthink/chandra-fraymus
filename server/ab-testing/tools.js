import {
  createExperiment, listExperiments, recordEvent,
  getResults, concludeExperiment, autoCreateExperiment,
} from './ab-engine.js';

export function createAbTestingTools({ memoryBridge, broadcast } = {}) {
  return [
    {
      name: 'ab.list_experiments',
      description: 'List A/B content experiments with optional status filter',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['running', 'concluded'] },
          limit: { type: 'number' },
        },
      },
      handler: async ({ status, limit }) => ({ experiments: listExperiments({ status, limit: limit || 20 }) }),
    },
    {
      name: 'ab.create_experiment',
      description: 'Create a manual A/B content experiment with two variants',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' }, hypothesis: { type: 'string' },
          dimension: { type: 'string', enum: ['topic', 'format', 'hook', 'thumbnail', 'timing'] },
          variantA: { type: 'string' }, variantB: { type: 'string' },
        },
        required: ['name', 'variantA', 'variantB'],
      },
      handler: async (params) => {
        const result = createExperiment(params);
        if (broadcast) broadcast('ab_testing', { type: 'experiment_created', id: result.id });
        return result;
      },
    },
    {
      name: 'ab.auto_experiment',
      description: 'LLM-generate an A/B experiment for a given content topic',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
      handler: async ({ topic }) => autoCreateExperiment({ topic, memoryBridge }),
    },
    {
      name: 'ab.record_event',
      description: 'Record an impression, conversion, engagement, or revenue event for an experiment variant',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          experimentId: { type: 'string' }, variant: { type: 'string', enum: ['a', 'b'] },
          eventType: { type: 'string', enum: ['impression', 'conversion', 'engagement', 'revenue'] },
          value: { type: 'number' }, metadata: { type: 'object' },
        },
        required: ['experimentId', 'variant'],
      },
      handler: async (params) => recordEvent(params),
    },
    {
      name: 'ab.get_results',
      description: 'Get statistical results for an A/B experiment including z-score, p-value, and winner recommendation',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { experimentId: { type: 'string' } },
        required: ['experimentId'],
      },
      handler: async ({ experimentId }) => getResults(experimentId),
    },
    {
      name: 'ab.conclude',
      description: 'Conclude an A/B experiment and declare a winner',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: { experimentId: { type: 'string' } },
        required: ['experimentId'],
      },
      handler: async ({ experimentId }) => {
        const result = concludeExperiment(experimentId);
        if (result && broadcast) broadcast('ab_testing', { type: 'experiment_concluded', id: experimentId, winner: result.winner });
        return result;
      },
    },
  ];
}
