import {
  getCalendar, scheduleItem, cancelItem, getCalendarStats,
  learnTimingPatterns, suggestSchedule,
} from './smart-calendar.js';

export function createCalendarTools({ memoryBridge, broadcast } = {}) {
  return [
    {
      name: 'calendar.list',
      description: 'List scheduled content calendar items',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['scheduled', 'in_progress', 'completed', 'cancelled'] },
          limit: { type: 'number' },
        },
      },
      handler: async ({ status, limit }) => ({ items: getCalendar({ status, limit: limit || 20 }) }),
    },
    {
      name: 'calendar.stats',
      description: 'Get calendar statistics including patterns and upcoming items',
      safety: 'safe',
      parameters: { type: 'object', properties: {} },
      handler: async () => getCalendarStats(),
    },
    {
      name: 'calendar.schedule',
      description: 'Schedule a content item for creation and distribution',
      safety: 'approval_required',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' }, format: { type: 'string' },
          platforms: { type: 'array', items: { type: 'string' } },
          scheduledAt: { type: 'number' }, priority: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['topic'],
      },
      handler: async (params) => {
        const result = scheduleItem({ ...params, source: 'agent' });
        if (broadcast) broadcast('calendar', { type: 'scheduled', id: result.id, topic: params.topic });
        return result;
      },
    },
    {
      name: 'calendar.cancel',
      description: 'Cancel a scheduled calendar item',
      safety: 'approval_required',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler: async ({ id }) => ({ cancelled: cancelItem(id) }),
    },
    {
      name: 'calendar.learn_patterns',
      description: 'Analyze historical analytics to learn optimal posting times per platform',
      safety: 'safe',
      parameters: { type: 'object', properties: {} },
      handler: async () => learnTimingPatterns(),
    },
    {
      name: 'calendar.suggest',
      description: 'AI-powered schedule suggestions using analytics, revenue, daemon dreams, and timing patterns',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number' }, daysAhead: { type: 'number' } },
      },
      handler: async ({ count, daysAhead }) => suggestSchedule({ count, daysAhead, memoryBridge }),
    },
  ];
}
