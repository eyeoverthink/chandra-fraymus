// Edit Rebuild Pipeline — REST API Routes
// POST /api/media/edit-rebuild      — run full pipeline
// GET  /api/media/edit-rebuild/status — check engine readiness
// GET  /api/media/edit-rebuild/list  — list completed rebuilds
// POST /api/media/edit-rebuild/detect — stage 1 only (scene detect)
// POST /api/media/edit-rebuild/plan  — stage 2 only (shot plan from scene data)

import { Router } from 'express';
import { runEditRebuild, editRebuildStatus, listRebuilds, detectScenes, planShots } from './edit-rebuild.js';

const router = Router();

// Full pipeline — multipart or JSON with base64 video
router.post('/', async (req, res) => {
  try {
    const { video, productDescription, productImage, instruction, threshold, width, height, fps, model } = req.body;

    if (!video) return res.status(400).json({ error: 'video required (base64 or data URI)' });
    if (!productDescription) return res.status(400).json({ error: 'productDescription required' });

    const events = [];
    const result = await runEditRebuild(Buffer.from(video, 'base64'), {
      productDescription,
      productImage,
      instruction,
      threshold: threshold ? parseFloat(threshold) : undefined,
      width: width ? parseInt(width) : undefined,
      height: height ? parseInt(height) : undefined,
      fps: fps ? parseInt(fps) : undefined,
      model,
      onProgress: (ev) => events.push(ev),
    });

    res.json({
      ok: true,
      ...result,
      progressLog: events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pipeline readiness check
router.get('/status', async (_req, res) => {
  try {
    const status = await editRebuildStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List completed rebuilds
router.get('/list', (_req, res) => {
  try {
    const limit = Math.min(parseInt(_req.query.limit) || 50, 200);
    const rebuilds = listRebuilds(limit);
    res.json({ count: rebuilds.length, rebuilds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stage 1 only: Scene Detection
router.post('/detect', async (req, res) => {
  try {
    const { video, threshold, minDuration } = req.body;
    if (!video) return res.status(400).json({ error: 'video required (base64)' });

    const scenes = await detectScenes(Buffer.from(video, 'base64'), {
      threshold: threshold ? parseFloat(threshold) : undefined,
      minDuration: minDuration ? parseFloat(minDuration) : undefined,
    });

    res.json({ ok: true, ...scenes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stage 2 only: Shot Planning (requires scene data from stage 1)
router.post('/plan', async (req, res) => {
  try {
    const { sceneData, productDescription, instruction, model } = req.body;
    if (!sceneData) return res.status(400).json({ error: 'sceneData required (from /detect)' });
    if (!productDescription) return res.status(400).json({ error: 'productDescription required' });

    const plan = await planShots(sceneData, { productDescription, instruction, model });
    res.json({ ok: true, ...plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
