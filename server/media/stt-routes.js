import { statSync } from 'node:fs';
import { join } from 'node:path';
import multer from 'multer';
import {
  sttTranscribe, sttStatus, listSTTFiles, STT_DIR,
} from './stt-engine.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const route = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

export function installSTTRoutes(app) {
  // ── Transcribe Audio ───────────────────────
  app.post('/api/stt/transcribe', upload.single('audio'), route(async (req, res) => {
    let input;
    if (req.file) {
      input = req.file.buffer;
    } else if (req.body?.audioBase64) {
      input = req.body.audioBase64;
    } else if (req.body?.dataUri) {
      input = req.body.dataUri;
    } else {
      return res.status(400).json({ error: 'audio file, audioBase64, or dataUri required' });
    }

    const { language, engine, model } = req.body || {};
    res.json(await sttTranscribe(input, { language, engine, model }));
  }));

  // ── Engine Status ──────────────────────────
  app.get('/api/stt/status', route(async (_req, res) => {
    res.json(await sttStatus());
  }));

  // ── List Transcriptions ────────────────────
  app.get('/api/stt/outputs', (_req, res) => {
    const limit = Math.min(Number(_req.query.limit) || 50, 200);
    res.json({ files: listSTTFiles(limit) });
  });

  // ── Get Transcription ──────────────────────
  app.get('/api/stt/transcription/:file', (req, res) => {
    const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
    if (!file.endsWith('.json')) return res.status(400).json({ error: 'Invalid file name' });
    const fp = join(STT_DIR, file);
    try {
      statSync(fp);
      res.setHeader('Content-Type', 'application/json');
      res.sendFile(fp);
    } catch {
      res.status(404).json({ error: 'Transcription not found' });
    }
  });
}
