import {
  attributeRevenue, getRevenueSummary, getRevenueByTopic,
  generateDecisions, getDecisions, markDecisionApplied, pollShopifyOrders,
} from './learning-loop.js';

export function createLearningLoopTools({ memoryBridge, broadcast } = {}) {
  return [
    {
      name: 'commerce.revenue_summary',
      description: 'Get revenue attribution summary with breakdowns by topic and platform',
      safety: 'safe',
      parameters: {},
      handler: async () => getRevenueSummary(),
    },
    {
      name: 'commerce.revenue_by_topic',
      description: 'Get revenue attributed to each content topic',
      safety: 'safe',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async ({ limit }) => ({ topics: getRevenueByTopic(limit || 20) }),
    },
    {
      name: 'commerce.attribute_revenue',
      description: 'Manually attribute an order to a content topic and platform',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string' }, orderTotal: { type: 'number' },
          topic: { type: 'string' }, platform: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
      handler: async (params) => {
        const result = attributeRevenue(params);
        if (broadcast) broadcast('commerce', { type: 'revenue_attribution', ...result });
        return result;
      },
    },
    {
      name: 'commerce.generate_decisions',
      description: 'Run the learning loop to generate strategic recommendations from revenue + analytics data',
      safety: 'safe',
      parameters: {},
      handler: async () => generateDecisions({ memoryBridge, broadcast }),
    },
    {
      name: 'commerce.get_decisions',
      description: 'List learning loop strategic decisions',
      safety: 'safe',
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: async ({ limit }) => ({ decisions: getDecisions(limit || 20) }),
    },
    {
      name: 'commerce.apply_decision',
      description: 'Mark a learning loop decision as applied with outcome',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, outcome: { type: 'string' } },
        required: ['id'],
      },
      handler: async ({ id, outcome }) => { markDecisionApplied(id, outcome); return { applied: true }; },
    },
    {
      name: 'commerce.poll_shopify',
      description: 'Poll Shopify for recent orders and auto-attribute revenue',
      safety: 'safe',
      parameters: {},
      handler: async () => pollShopifyOrders({ broadcast, memoryBridge }),
    },
  ];
}
