import { heart } from '../fraymus-tools.js';
import { createDistributionIntel, availablePlatforms, PLATFORMS } from './shared.js';
import { optimizeForPlatform, distributeToAll } from './social.js';
import {
  scheduleContent,
  listScheduled,
  listDistributionRuns,
  getDistributionStats,
  runDistributionPipeline,
} from './scheduler.js';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

export function createDistributionTools({ memoryBridge, broadcast } = {}) {
  const intel = createDistributionIntel(memoryBridge, heart);
  return [
    {
      name: 'distribution.platforms',
      group: 'distribution',
      risk: 'safe',
      description: 'List available social distribution platforms and their credential status.',
      parameters: object({}),
      execute: async () => ({ platforms: availablePlatforms(), all: Object.keys(PLATFORMS) }),
    },
    {
      name: 'distribution.optimize',
      group: 'distribution',
      risk: 'safe',
      description: 'Optimize content metadata (title, description, tags, hook, CTA) for a specific platform using LLM analysis.',
      parameters: object({
        content: { type: 'object', description: 'Content object with topic, description, format fields', items: { type: 'object' } },
        platform: string(30, { enum: Object.keys(PLATFORMS), description: 'Target platform' }),
      }, ['content', 'platform']),
      execute: async ({ args }) => optimizeForPlatform(args.content, args.platform),
    },
    {
      name: 'distribution.publish',
      group: 'distribution',
      risk: 'approval',
      description: 'Publish content to one or all available social platforms. Optimizes per-platform then queues for posting.',
      parameters: object({
        content: { type: 'object', description: 'Content with topic, description, format, thumbnailUrl', items: { type: 'object' } },
        platforms: { type: 'array', items: { type: 'string' }, description: 'Platform IDs to post to (null = all available)' },
        creationRunId: string(100, { description: 'Link back to the creation pipeline run' }),
      }, ['content']),
      execute: async ({ args }) => runDistributionPipeline(args.content, { intel, broadcast, creationRunId: args.creationRunId }),
    },
    {
      name: 'distribution.schedule',
      group: 'distribution',
      risk: 'safe',
      description: 'Schedule a content creation + distribution run for a future time.',
      parameters: object({
        topic: string(500, { description: 'Topic for the creation pipeline' }),
        format: string(50, { enum: ['short_video', 'long_video', 'podcast', 'social_post', 'hyperframes'] }),
        style: string(100),
        platforms: { type: 'array', items: { type: 'string' }, description: 'Target platforms' },
        scheduledAt: { type: 'number', description: 'Unix timestamp (ms) for when to run' },
      }, ['topic']),
      execute: async ({ args }) => scheduleContent(args),
    },
    {
      name: 'distribution.calendar',
      group: 'distribution',
      risk: 'safe',
      description: 'List scheduled content calendar entries.',
      parameters: object({
        limit: { type: 'number', description: 'Max entries to return' },
      }),
      execute: async ({ args }) => ({ entries: listScheduled(args.limit || 50) }),
    },
    {
      name: 'distribution.runs',
      group: 'distribution',
      risk: 'safe',
      description: 'List recent distribution runs with platform results.',
      parameters: object({
        limit: { type: 'number', description: 'Max entries to return' },
      }),
      execute: async ({ args }) => ({ runs: listDistributionRuns(args.limit || 100) }),
    },
    {
      name: 'distribution.stats',
      group: 'distribution',
      risk: 'safe',
      description: 'Get distribution statistics — totals by platform, status breakdown, scheduled count.',
      parameters: object({}),
      execute: async () => getDistributionStats(),
    },
  ];
}
