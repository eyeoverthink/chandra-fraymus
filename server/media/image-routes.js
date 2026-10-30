import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import multer from 'multer';
import {
  imageInfo, imageResize, imageCrop, imageConvert, imageEffects,
  imageComposite, imageWatermark, imageThumbnail, imageUpscale,
  imageCreate, listMedia, MEDIA_DIR,
  comfyuiStatus, comfyuiGenerate, comfyuiResult, comfyuiFetchImage,
} from './image-engine.js';

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

let upload;
try {
  upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
} catch {
  upload = null;
}

function getInput(req) {
  if (req.file?.buffer) return req.file.buffer;
  if (req.body?.base64) return Buffer.from(req.body.base64, 'base64');
  if (req.body?.dataUri) {
    const m = req.body.dataUri.match(/^data:[^;]+;base64,(.+)$/);
    if (m) return Buffer.from(m[1], 'base64');
  }
  if (req.body?.path) {
    const resolved = join(MEDIA_DIR, req.body.path.replace(/^\/media\//, ''));
    return readFileSync(resolved);
  }
  return null;
}

export function installImageRoutes(app) {
  const up = upload ? upload.single('image') : (_req, _res, next) => next();

  // ── Info ──────────────────────────────────────
  app.post('/api/media/info', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required (file upload, base64, dataUri, or path)' });
    res.json(await imageInfo(input));
  }));

  // ── Resize ────────────────────────────────────
  app.post('/api/media/resize', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const { width, height, fit } = req.body;
    if (!width && !height) return res.status(400).json({ error: 'width or height required' });
    res.json(await imageResize(input, { width, height, fit }));
  }));

  // ── Crop ──────────────────────────────────────
  app.post('/api/media/crop', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const { left, top, width, height } = req.body;
    if (left == null || top == null || !width || !height) {
      return res.status(400).json({ error: 'left, top, width, height required' });
    }
    res.json(await imageCrop(input, { left, top, width, height }));
  }));

  // ── Convert ───────────────────────────────────
  app.post('/api/media/convert', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const { format, quality } = req.body;
    res.json(await imageConvert(input, { format, quality }));
  }));

  // ── Effects ───────────────────────────────────
  app.post('/api/media/effects', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const { rotate, flip, flop, grayscale, negate, blur, sharpen, tint, gamma, normalize } = req.body;
    res.json(await imageEffects(input, { rotate, flip, flop, grayscale, negate, blur, sharpen, tint, gamma, normalize }));
  }));

  // ── Composite ─────────────────────────────────
  app.post('/api/media/composite', up, route(async (req, res) => {
    const { base, overlays } = req.body;
    if (!base) return res.status(400).json({ error: 'base image required (base64)' });
    if (!Array.isArray(overlays) || !overlays.length) {
      return res.status(400).json({ error: 'overlays array required [{input, top, left}]' });
    }
    res.json(await imageComposite(base, overlays));
  }));

  // ── Watermark ─────────────────────────────────
  app.post('/api/media/watermark', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const { text, fontSize, color, position } = req.body;
    res.json(await imageWatermark(input, text, { fontSize, color, position }));
  }));

  // ── Thumbnail ─────────────────────────────────
  app.post('/api/media/thumbnail', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const size = req.body.size || req.query.size;
    res.json(await imageThumbnail(input, size));
  }));

  // ── Upscale ───────────────────────────────────
  app.post('/api/media/upscale', up, route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'image required' });
    const scale = req.body.scale || req.query.scale;
    res.json(await imageUpscale(input, scale));
  }));

  // ── Create blank canvas ───────────────────────
  app.post('/api/media/create', route(async (req, res) => {
    const { width, height, color } = req.body;
    res.json(await imageCreate({ width, height, color }));
  }));

  // ── List outputs ──────────────────────────────
  app.get('/api/media/outputs', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ files: listMedia(limit) });
  }));

  // ── Serve media files ─────────────────────────
  app.get('/media/:file', (req, res, next) => {
    const file = req.params.file.replace(/[\/\\]/g, '');
    try {
      const buf = readFileSync(join(MEDIA_DIR, file));
      const ext = file.split('.').pop().toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', tiff: 'image/tiff' }[ext] || 'application/octet-stream';
      res.set('Content-Type', mime).set('Cache-Control', 'public, max-age=86400').send(buf);
    } catch { next(); }
  });

  // ── ComfyUI bridge ────────────────────────────
  app.get('/api/media/comfyui/status', route(async (_req, res) => {
    res.json(await comfyuiStatus());
  }));

  app.post('/api/media/comfyui/generate', route(async (req, res) => {
    const { prompt, width, height, steps, cfg, seed } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    try {
      res.json(await comfyuiGenerate(prompt, { width, height, steps, cfg, seed }));
    } catch (e) {
      res.status(502).json({ error: `ComfyUI unavailable: ${e.message}` });
    }
  }));

  app.get('/api/media/comfyui/result/:promptId', route(async (req, res) => {
    try {
      res.json(await comfyuiResult(req.params.promptId));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }));

  app.post('/api/media/comfyui/fetch', route(async (req, res) => {
    const { filename, subfolder } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    try {
      res.json(await comfyuiFetchImage(filename, subfolder));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  }));
}
