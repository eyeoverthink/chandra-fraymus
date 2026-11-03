import {
  getTrends, getTrendStats, dismissTrend,
  scanTrends, assessTrendForContent,
} from './radar.js';

export function createTrendRadarTools({ memoryBridge, broadcast } = {}) {
  return [
    {
      name: 'trends.list',
      description: 'List tracked trend signals with optional filters',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['emerging', 'trending', 'peaked', 'faded', 'dismissed'] },
          category: { type: 'string', enum: ['tech', 'culture', 'platform', 'format', 'audience', 'commerce'] },
          minRelevance: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      handler: async (params) => ({ trends: getTrends(params) }),
    },
    {
      name: 'trends.stats',
      description: 'Get trend radar statistics and top emerging trends',
      safety: 'safe',
      parameters: {},
      handler: async () => getTrendStats(),
    },
    {
      name: 'trends.scan',
      description: 'Run an LLM-powered trend scan for emerging topics in your niche',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { niche: { type: 'string' } },
      },
      handler: async ({ niche }) => scanTrends({ niche, memoryBridge }),
    },
    {
      name: 'trends.assess',
      description: 'Assess whether a specific trend is worth creating content about',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { trendId: { type: 'string' } },
        required: ['trendId'],
      },
      handler: async ({ trendId }) => assessTrendForContent(trendId, { memoryBridge }),
    },
    {
      name: 'trends.dismiss',
      description: 'Dismiss a trend signal as not relevant',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: { trendId: { type: 'string' } },
        required: ['trendId'],
      },
      handler: async ({ trendId }) => {
        const ok = dismissTrend(trendId);
        if (ok && broadcast) broadcast('trend_radar', { type: 'trend_dismissed', id: trendId });
        return { dismissed: ok };
      },
    },
  ];
}
