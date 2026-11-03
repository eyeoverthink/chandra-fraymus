import {
  recordMetrics,
  getTopPerformers,
  getAnalyticsByTopic,
  getAnalyticsOverview,
  generateInsights,
  getInsights,
} from './collector.js';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

export function createAnalyticsTools({ memoryBridge } = {}) {
  return [
    {
      name: 'analytics.record',
      group: 'analytics',
      risk: 'safe',
      description: 'Record engagement metrics for a piece of distributed content (views, likes, shares, CTR, watch time).',
      parameters: object({
        platform: string(30, { description: 'Platform (youtube, tiktok, instagram, x)' }),
        topic: string(500),
        distributionRunId: string(100),
        creationRunId: string(100),
        metrics: { type: 'object', description: 'Metrics object: views, likes, shares, comments, ctr, watchTimeAvg, revenue', items: { type: 'object' } },
      }, ['platform', 'metrics']),
      execute: async ({ args }) => recordMetrics(args),
    },
    {
      name: 'analytics.overview',
      group: 'analytics',
      risk: 'safe',
      description: 'Get analytics dashboard overview — totals by platform, top topics, engagement trends, revenue attribution.',
      parameters: object({}),
      execute: async () => getAnalyticsOverview(),
    },
    {
      name: 'analytics.top_performers',
      group: 'analytics',
      risk: 'safe',
      description: 'Get top-performing content by engagement rate, optionally filtered by platform.',
      parameters: object({
        platform: string(30),
        limit: { type: 'number' },
      }),
      execute: async ({ args }) => ({ top: getTopPerformers(args.platform, args.limit || 10) }),
    },
    {
      name: 'analytics.by_topic',
      group: 'analytics',
      risk: 'safe',
      description: 'Get analytics for content about a specific topic across all platforms.',
      parameters: object({
        topic: string(500, { description: 'Topic to search for' }),
        limit: { type: 'number' },
      }, ['topic']),
      execute: async ({ args }) => ({ analytics: getAnalyticsByTopic(args.topic, args.limit || 20) }),
    },
    {
      name: 'analytics.generate_insights',
      group: 'analytics',
      risk: 'safe',
      description: 'Generate AI-powered insights from accumulated analytics data. Stores insights to Memory Bridge for future creative briefs.',
      parameters: object({}),
      execute: async () => generateInsights(memoryBridge),
    },
    {
      name: 'analytics.insights',
      group: 'analytics',
      risk: 'safe',
      description: 'List previously generated analytics insights.',
      parameters: object({ limit: { type: 'number' } }),
      execute: async ({ args }) => ({ insights: getInsights(args.limit || 20) }),
    },
  ];
}
