import { db } from '../db.js';
import {
  runContentCommercePipeline,
  runResearcher,
  runCreator,
  runReviewer,
  runCeoLogger,
  runShopifyPublish,
} from './pipeline.js';

const now = () => Date.now();

export function installCommerceRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // Run the full 5-stage pipeline
  app.post('/api/commerce/pipeline', route(async (req, res) => {
    const { topic, contentType, sources, autoPublish } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const result = await runContentCommercePipeline(
      { topic, contentType: contentType || 'both', sources: sources || 'both' },
      { autoPublish: autoPublish !== false },
    );
    res.json(result);
  }));

  // Run individual stages
  app.post('/api/commerce/research', route(async (req, res) => {
    const result = await runResearcher(req.body);
    res.json(result);
  }));

  app.post('/api/commerce/create', route(async (req, res) => {
    const result = await runCreator(req.body);
    res.json(result);
  }));

  app.post('/api/commerce/review', route(async (req, res) => {
    const result = await runReviewer(req.body);
    res.json(result);
  }));

  app.post('/api/commerce/log', route(async (req, res) => {
    const result = await runCeoLogger(req.body);
    res.json(result);
  }));

  app.post('/api/commerce/publish', route(async (req, res) => {
    const result = await runShopifyPublish(req.body);
    res.json(result);
  }));

  // Pipeline run history
  app.get('/api/commerce/runs', route((_req, res) => {
    const runs = db.prepare(
      `SELECT id, topic, content_type, status, score, issues, created_at
       FROM commerce_pipeline_runs ORDER BY created_at DESC LIMIT 50`
    ).all();
    res.json({ runs: runs.map(r => ({ ...r, issues: JSON.parse(r.issues || '[]') })) });
  }));

  app.get('/api/commerce/runs/:id', route((req, res) => {
    const run = db.prepare('SELECT * FROM commerce_pipeline_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({
      ...run,
      issues: JSON.parse(run.issues || '[]'),
      final_content: JSON.parse(run.final_content || '{}'),
      shopify_result: run.shopify_result ? JSON.parse(run.shopify_result) : null,
    });
  }));
}
