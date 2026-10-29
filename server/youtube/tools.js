import { searchAndAnalyze, analyzeUrl, saveToBoard, getBoard, boardStats } from './service.js';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function createYouTubeTools() {
  return [
    {
      name: 'youtube.search_outliers',
      group: 'youtube',
      risk: 'safe',
      description: 'Search YouTube for videos by keyword or interest and classify each result as a Big Outlier, Mid Outlier, or No Outlier based on views-to-subscribers ratio.',
      parameters: object({
        query: string(500, { minLength: 1 }),
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
        order: string(20, { enum: ['relevance', 'viewCount', 'date', 'rating'] }),
      }, ['query']),
      execute: async ({ args }) => {
        const results = await searchAndAnalyze(args.query, {
          maxResults: args.maxResults || 20,
          order: args.order || 'relevance',
        });
        const big = results.filter(r => r.outlierTier === 'big').length;
        const mid = results.filter(r => r.outlierTier === 'mid').length;
        return { results, summary: { total: results.length, bigOutliers: big, midOutliers: mid } };
      },
    },
    {
      name: 'youtube.analyze_video',
      group: 'youtube',
      risk: 'safe',
      description: 'Analyze a single YouTube video URL — fetch its stats, channel subscribers, and compute its outlier classification.',
      parameters: object({
        url: string(2000, { minLength: 5 }),
      }, ['url']),
      execute: async ({ args }) => {
        return analyzeUrl(args.url);
      },
    },
    {
      name: 'youtube.save_outlier',
      group: 'youtube',
      risk: 'safe',
      description: 'Save a video to the Outlier Board with optional notes.',
      parameters: object({
        video: {
          type: 'object',
          properties: {
            videoId: string(20),
            title: string(500),
            channelTitle: string(200),
            channelId: string(50),
            thumbnail: string(500),
            publishedAt: string(30),
            viewCount: { type: 'integer' },
            subscriberCount: { type: 'integer' },
            duration: { type: 'integer' },
            outlierRatio: { type: 'number' },
            outlierTier: string(20),
          },
          required: ['videoId'],
        },
        notes: string(2000),
      }, ['video']),
      execute: async ({ args }) => {
        return saveToBoard('local', args.video, args.notes || '');
      },
    },
    {
      name: 'youtube.board',
      group: 'youtube',
      risk: 'safe',
      description: 'Retrieve saved videos from the Outlier Board, optionally filtered by outlier tier or keyword.',
      parameters: object({
        tier: string(20, { enum: ['all', 'big', 'mid', 'none'] }),
        search: string(200),
        sort: string(20, { enum: ['recent', 'views', 'outlier', 'duration'] }),
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      }),
      execute: async ({ args }) => {
        const items = getBoard('local', {
          tier: args.tier || 'all',
          search: args.search,
          sort: args.sort || 'recent',
          limit: args.limit || 50,
        });
        return { items, stats: boardStats('local') };
      },
    },
    {
      name: 'youtube.board_stats',
      group: 'youtube',
      risk: 'safe',
      description: 'Get stats about the Outlier Board — total saved videos and count per outlier tier.',
      parameters: object({}),
      execute: async () => {
        return boardStats('local');
      },
    },
  ];
}
