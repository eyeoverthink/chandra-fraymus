import {
  runContentCommercePipeline,
  runResearcher,
  runCreator,
  runReviewer,
  runShopifyPublish,
} from './pipeline.js';

const string = (maxLength, extra = {}) => ({ type: 'string', maxLength, ...extra });
const object = (properties, required = []) => ({ type: 'object', properties, required });

export function createCommerceTools() {
  return [
    {
      name: 'commerce.research',
      group: 'commerce',
      risk: 'safe',
      description: 'Research a topic using web search and YouTube outlier data. Returns a structured brief with demand signals, keywords, and content ideas.',
      parameters: object({
        topic: string(500, { description: 'The topic or niche to research' }),
        contentType: string(20, { enum: ['product', 'blog', 'both'], description: 'Type of content to create' }),
        sources: string(20, { enum: ['web', 'youtube', 'both'], description: 'Data sources to use' }),
      }, ['topic']),
      execute: async ({ args }) => runResearcher(args),
    },
    {
      name: 'commerce.create_content',
      group: 'commerce',
      risk: 'safe',
      description: 'Generate product listings and/or blog posts from a research brief. Pass the output of commerce.research as input.',
      parameters: object({
        brief: { type: 'object', description: 'Research brief from commerce.research' },
        topic: string(500),
        contentType: string(20, { enum: ['product', 'blog', 'both'] }),
      }, ['brief', 'topic']),
      execute: async ({ args }) => runCreator(args),
    },
    {
      name: 'commerce.review',
      group: 'commerce',
      risk: 'safe',
      description: 'QA-review generated content for grammar, SEO, and commerce readiness. Pass the output of commerce.create_content.',
      parameters: object({
        content: { type: 'object', description: 'Content from commerce.create_content' },
        topic: string(500),
      }, ['content', 'topic']),
      execute: async ({ args }) => runReviewer(args),
    },
    {
      name: 'commerce.publish_shopify',
      group: 'commerce',
      risk: 'approval',
      description: 'Publish approved content to Shopify as draft products and/or blog articles. Requires SHOPIFY_ACCESS_TOKEN and SHOPIFY_STORE_DOMAIN env vars.',
      parameters: object({
        finalContent: { type: 'object', description: 'Approved content to publish' },
        approved: { type: 'boolean' },
        runId: string(100),
        topic: string(500),
      }, ['finalContent']),
      execute: async ({ args }) => runShopifyPublish({ ...args, approved: args.approved !== false }),
    },
    {
      name: 'commerce.full_pipeline',
      group: 'commerce',
      risk: 'approval',
      description: 'Run the full content-to-commerce pipeline: Research → Create → Review → Log → Shopify. One-shot execution of all 5 stages.',
      parameters: object({
        topic: string(500, { description: 'The topic or niche' }),
        contentType: string(20, { enum: ['product', 'blog', 'both'] }),
        sources: string(20, { enum: ['web', 'youtube', 'both'] }),
        autoPublish: { type: 'boolean', description: 'Auto-publish to Shopify if approved (default true)' },
      }, ['topic']),
      execute: async ({ args }) => runContentCommercePipeline(args, { autoPublish: args.autoPublish }),
    },
  ];
}
