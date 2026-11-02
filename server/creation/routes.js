import { db } from '../db.js';
import { heart } from '../fraymus-tools.js';
import { createCreationIntel } from './shared.js';
import {
  runCreationPipeline,
  runCreativeBrief,
  runScriptWriter,
  runVoiceSynth,
  runVisualAssembly,
  runDistributionPrep,
  runCommerceBridge,
} from './pipeline.js';

function safeParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

export function installCreationRoutes(app, { memoryBridge, broadcast } = {}) {
  const intel = createCreationIntel(memoryBridge, heart);
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  // Full 6-stage creation pipeline
  app.post('/api/creation/pipeline', route(async (req, res) => {
    const { topic, format, style } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const result = await runCreationPipeline(
      { topic, format: format || 'short_video', style: style || 'auto' },
      { intel, broadcast },
    );
    res.json(result);
  }));

  // Individual stages
  app.post('/api/creation/brief', route(async (req, res) => {
    if (!req.body.topic) return res.status(400).json({ error: 'topic required' });
    res.json(await runCreativeBrief(req.body, { intel }));
  }));

  app.post('/api/creation/script', route(async (req, res) => {
    res.json(await runScriptWriter(req.body));
  }));

  app.post('/api/creation/voice', route(async (req, res) => {
    res.json(await runVoiceSynth(req.body));
  }));

  app.post('/api/creation/visuals', route(async (req, res) => {
    res.json(await runVisualAssembly(req.body));
  }));

  app.post('/api/creation/distribute', route(async (req, res) => {
    res.json(await runDistributionPrep(req.body));
  }));

  app.post('/api/creation/commerce-bridge', route(async (req, res) => {
    res.json(await runCommerceBridge(req.body));
  }));

  // Run history
  app.get('/api/creation/runs', route((_req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(_req.query.limit) || 50));
    const runs = db.prepare(
      `SELECT id, topic, format, status, shot_count, channels, created_at
       FROM creation_pipeline_runs ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
    res.json({ runs: runs.map(r => ({ ...r, channels: safeParse(r.channels, []) })) });
  }));

  app.get('/api/creation/runs/:id', route((req, res) => {
    const run = db.prepare('SELECT * FROM creation_pipeline_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json({
      ...run,
      stages: safeParse(run.stages, {}),
      channels: safeParse(run.channels, []),
    });
  }));
}
