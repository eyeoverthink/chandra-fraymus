import {
  getTemplates, getJobs, getRepurposeStats,
  repurposeContent, suggestRepurposeTargets,
} from './repurpose-engine.js';

export function createRepurposeTools({ memoryBridge, broadcast } = {}) {
  return [
    {
      name: 'repurpose.templates',
      description: 'List available content repurposing templates',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          sourceFormat: { type: 'string' },
          targetFormat: { type: 'string' },
        },
      },
      handler: async (params) => ({ templates: getTemplates(params) }),
    },
    {
      name: 'repurpose.jobs',
      description: 'List repurposing job history',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
          limit: { type: 'number' },
        },
      },
      handler: async (params) => ({ jobs: getJobs(params) }),
    },
    {
      name: 'repurpose.stats',
      description: 'Get content repurposing statistics',
      safety: 'safe',
      parameters: { type: 'object', properties: {} },
      handler: async () => getRepurposeStats(),
    },
    {
      name: 'repurpose.run',
      description: 'Repurpose content into multiple platform-specific variants',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          sourceFormat: { type: 'string', enum: ['article', 'short_video_script', 'blog_post', 'newsletter', 'podcast_transcript'] },
          targetFormats: { type: 'array', items: { type: 'string' } },
          targetPlatforms: { type: 'array', items: { type: 'string' } },
          audienceSegment: { type: 'string' },
        },
        required: ['content'],
      },
      handler: async (params) => repurposeContent({ ...params, memoryBridge, broadcast }),
    },
    {
      name: 'repurpose.suggest',
      description: 'Get AI suggestions for which formats and platforms to repurpose content into',
      safety: 'safe',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string' } },
        required: ['content'],
      },
      handler: async ({ content }) => suggestRepurposeTargets(content, { memoryBridge }),
    },
  ];
}
