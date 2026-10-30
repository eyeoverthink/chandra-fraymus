import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import multer from 'multer';
import {
  videoInfo, videoThumbnail, videoTrim, videoResize,
  videoConvert, videoExtractAudio, videoToGif, videoConcat,
  videoOverlayText, videoFrames, ffmpegStatus, listVideos,
  VIDEO_DIR, videoUrl,
} from './video-engine.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const route = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

function getInput(req) {
  if (req.file) return req.file.buffer;
  if (req.body?.base64) return req.body.base64;
  if (req.body?.dataUri) return req.body.dataUri;
  if (req.body?.path) {
    const clean = req.body.path.replace(/^\/video\//, '');
    return readFileSync(join(VIDEO_DIR, clean));
  }
  return null;
}

const MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.gif': 'image/gif', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.aac': 'audio/aac',
};

export function installVideoRoutes(app) {
  // ── Video Info ──────────────────────────────
  app.post('/api/video/info', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input (file upload, base64, dataUri, or path)' });
    res.json(await videoInfo(input));
  }));

  // ── Extract Thumbnail ──────────────────────
  app.post('/api/video/thumbnail', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoThumbnail(input, { time: req.body?.time }));
  }));

  // ── Trim ───────────────────────────────────
  app.post('/api/video/trim', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoTrim(input, {
      start: req.body?.start, end: req.body?.end,
      duration: req.body?.duration, format: req.body?.format,
    }));
  }));

  // ── Resize ─────────────────────────────────
  app.post('/api/video/resize', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoResize(input, {
      width: req.body?.width ? Number(req.body.width) : undefined,
      height: req.body?.height ? Number(req.body.height) : undefined,
      format: req.body?.format,
    }));
  }));

  // ── Convert Format ─────────────────────────
  app.post('/api/video/convert', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoConvert(input, { format: req.body?.format }));
  }));

  // ── Extract Audio ──────────────────────────
  app.post('/api/video/extract-audio', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoExtractAudio(input, { format: req.body?.format }));
  }));

  // ── Video to GIF ───────────────────────────
  app.post('/api/video/gif', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoToGif(input, {
      width: req.body?.width ? Number(req.body.width) : undefined,
      fps: req.body?.fps ? Number(req.body.fps) : undefined,
      start: req.body?.start, duration: req.body?.duration,
    }));
  }));

  // ── Concatenate ────────────────────────────
  app.post('/api/video/concat', upload.array('files', 10), route(async (req, res) => {
    let inputs;
    if (req.files?.length >= 2) {
      inputs = req.files.map(f => f.buffer);
    } else if (req.body?.paths && Array.isArray(req.body.paths)) {
      inputs = req.body.paths.map(p => {
        const clean = p.replace(/^\/video\//, '');
        return readFileSync(join(VIDEO_DIR, clean));
      });
    } else {
      return res.status(400).json({ error: 'Upload at least 2 files or provide paths array' });
    }
    res.json(await videoConcat(inputs, { format: req.body?.format }));
  }));

  // ── Overlay Text ───────────────────────────
  app.post('/api/video/overlay-text', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    if (!req.body?.text) return res.status(400).json({ error: 'text is required' });
    res.json(await videoOverlayText(input, req.body.text, {
      fontSize: req.body?.fontSize ? Number(req.body.fontSize) : undefined,
      color: req.body?.color, x: req.body?.x, y: req.body?.y,
      format: req.body?.format,
    }));
  }));

  // ── Extract Frames ─────────────────────────
  app.post('/api/video/frames', upload.single('file'), route(async (req, res) => {
    const input = getInput(req);
    if (!input) return res.status(400).json({ error: 'No video input' });
    res.json(await videoFrames(input, {
      count: req.body?.count ? Number(req.body.count) : undefined,
    }));
  }));

  // ── List Outputs ───────────────────────────
  app.get('/api/video/outputs', (_req, res) => {
    const limit = Math.min(Number(_req.query.limit) || 50, 200);
    res.json({ files: listVideos(limit) });
  });

  // ── ffmpeg Status ──────────────────────────
  app.get('/api/video/status', route(async (_req, res) => {
    res.json(await ffmpegStatus());
  }));

  // ── Serve Video Files ──────────────────────
  app.get('/video/:file', (req, res) => {
    const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
    const fp = join(VIDEO_DIR, file);
    try {
      statSync(fp);
      const ext = extname(file).toLowerCase();
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.sendFile(fp);
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  });
}
