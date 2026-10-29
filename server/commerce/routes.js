import { db } from '../db.js';
import {
  runContentCommercePipeline,
  runResearcher,
  runCreator,
  runReviewer,
  runCeoLogger,
  runShopifyPublish,
} from './pipeline.js';
import {
  runApparelPipeline,
  runTrendScout,
  runDesigner,
  runPrintifyPush,
  runShopifySync,
  runPricingEngine,
} from './apparel-pipeline.js';
import {
  runMysteryShopperPipeline,
  runShopperAgent,
  runUxAuditor,
  runPriceAnalyst,
} from './mystery-shopper.js';
import {
  runStoreFixerPipeline,
  runPageGenerator,
  runCollectionOrganizer,
  runDescriptionEnhancer,
  runPriceAdjuster,
} from './store-fixer.js';

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

  // ── Apparel Pipeline ────────────────────────────────────────────
  app.post('/api/apparel/pipeline', route(async (req, res) => {
    const { niche, season, productTypes } = req.body;
    const result = await runApparelPipeline({ niche, season, productTypes });
    res.json(result);
  }));

  app.post('/api/apparel/trends', route(async (req, res) => {
    res.json(await runTrendScout(req.body));
  }));

  app.post('/api/apparel/design', route(async (req, res) => {
    res.json(await runDesigner(req.body));
  }));

  app.post('/api/apparel/printify', route(async (req, res) => {
    res.json(await runPrintifyPush(req.body));
  }));

  app.post('/api/apparel/shopify-sync', route(async (req, res) => {
    res.json(await runShopifySync(req.body, req.body._designs || {}));
  }));

  app.post('/api/apparel/pricing', route(async (req, res) => {
    res.json(await runPricingEngine(req.body, req.body._designs || {}));
  }));

  app.get('/api/apparel/runs', route((_req, res) => {
    const runs = db.prepare(
      'SELECT * FROM apparel_pipeline_runs ORDER BY created_at DESC LIMIT 50'
    ).all();
    res.json({ runs: runs.map(r => ({ ...r, stages: JSON.parse(r.stages || '{}') })) });
  }));

  // ── Mystery Shopper ─────────────────────────────────────────────
  app.post('/api/shopper/audit', route(async (req, res) => {
    const result = await runMysteryShopperPipeline(req.body, { autoApply: req.body.autoApply });
    res.json(result);
  }));

  app.post('/api/shopper/browse', route(async (req, res) => {
    res.json(await runShopperAgent(req.body));
  }));

  app.post('/api/shopper/ux', route(async (req, res) => {
    res.json(await runUxAuditor(req.body));
  }));

  app.post('/api/shopper/pricing', route(async (req, res) => {
    res.json(await runPriceAnalyst(req.body));
  }));

  app.get('/api/shopper/runs', route((_req, res) => {
    const runs = db.prepare(
      'SELECT * FROM mystery_shopper_runs ORDER BY created_at DESC LIMIT 50'
    ).all();
    res.json({
      runs: runs.map(r => ({
        ...r,
        scores: JSON.parse(r.scores || '{}'),
        automated_fixes: JSON.parse(r.automated_fixes || '[]'),
        manual_fixes: JSON.parse(r.manual_fixes || '[]'),
        strategic: JSON.parse(r.strategic || '[]'),
      })),
    });
  }));

  // ── Store Fixer ─────────────────────────────────────────────────
  app.post('/api/fixer/pipeline', route(async (req, res) => {
    const result = await runStoreFixerPipeline(req.body.auditReport || req.body, { draft: req.body.draft });
    res.json(result);
  }));

  app.post('/api/fixer/pages', route(async (req, res) => {
    res.json(await runPageGenerator(req.body));
  }));

  app.post('/api/fixer/collections', route(async (req, res) => {
    res.json(await runCollectionOrganizer(req.body));
  }));

  app.post('/api/fixer/descriptions', route(async (req, res) => {
    res.json(await runDescriptionEnhancer(req.body));
  }));

  app.post('/api/fixer/prices', route(async (req, res) => {
    res.json(await runPriceAdjuster(req.body));
  }));

  app.get('/api/fixer/runs', route((_req, res) => {
    const runs = db.prepare(
      'SELECT * FROM store_fixer_runs ORDER BY created_at DESC LIMIT 50'
    ).all();
    res.json({ runs });
  }));
}
