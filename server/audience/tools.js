import {
  getSegments, getSegment, getAudienceStats, recordSignal,
  createSegment, discoverSegments, predictEngagement, generatePersona,
} from './audience-engine.js';

export function createAudienceTools({ memoryBridge, broadcast } = {}) {
  return [
    {
      name: 'audience.list_segments',
      description: 'List audience segments with optional status filter',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['active', 'archived'] },
          limit: { type: 'number' },
        },
      },
      handler: async (params) => ({ segments: getSegments(params) }),
    },
    {
      name: 'audience.get_segment',
      description: 'Get full details for an audience segment including signals and predictions',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { segmentId: { type: 'string' } },
        required: ['segmentId'],
      },
      handler: async ({ segmentId }) => {
        const segment = getSegment(segmentId);
        if (!segment) return { error: 'Segment not found' };
        return { segment };
      },
    },
    {
      name: 'audience.stats',
      description: 'Get audience intelligence statistics',
      safety: 'safe',
      parameters: {},
      handler: async () => getAudienceStats(),
    },
    {
      name: 'audience.record_signal',
      description: 'Record an audience engagement signal (view, click, purchase, etc.)',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          segmentId: { type: 'string' },
          signalType: { type: 'string' },
          platform: { type: 'string' },
          contentTopic: { type: 'string' },
          engagementRate: { type: 'number' },
          conversionRate: { type: 'number' },
          revenue: { type: 'number' },
        },
        required: ['signalType'],
      },
      handler: async (params) => recordSignal(params),
    },
    {
      name: 'audience.create_segment',
      description: 'Manually create an audience segment',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          preferredFormats: { type: 'array', items: { type: 'string' } },
          preferredPlatforms: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
      handler: async (params) => {
        const result = createSegment(params);
        if (broadcast) broadcast('audience', { type: 'segment_created', id: result.id });
        return result;
      },
    },
    {
      name: 'audience.discover',
      description: 'LLM-powered audience segment discovery from behavioral data',
      safety: 'safe',
      parameters: {},
      handler: async () => discoverSegments({ memoryBridge }),
    },
    {
      name: 'audience.predict',
      description: 'Predict how a specific audience segment will engage with a content topic',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          segmentId: { type: 'string' },
          contentTopic: { type: 'string' },
        },
        required: ['segmentId', 'contentTopic'],
      },
      handler: async ({ segmentId, contentTopic }) => predictEngagement(segmentId, contentTopic, { memoryBridge }),
    },
    {
      name: 'audience.persona',
      description: 'Generate a detailed marketing persona for an audience segment',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { segmentId: { type: 'string' } },
        required: ['segmentId'],
      },
      handler: async ({ segmentId }) => generatePersona(segmentId, { memoryBridge }),
    },
  ];
}
