import { statSync } from 'node:fs';
import { join, extname } from 'node:path';
import {
  ttsSpeak, ttsVoices, ttsStatus, listTTSFiles,
  TTS_DIR, ttsUrl,
} from './tts-engine.js';

const route = fn => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

export function installTTSRoutes(app) {
  // ── Generate Speech ────────────────────────
  app.post('/api/tts/speak', route(async (req, res) => {
    const { text, voice, rate, pitch, engine, model } = req.body || {};
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text is required (string, max 5000 chars)' });
    res.json(await ttsSpeak(text, { voice, rate, pitch, engine, model }));
  }));

  // ── List Voices ────────────────────────────
  app.get('/api/tts/voices', route(async (req, res) => {
    const engine = req.query.engine;
    res.json(await ttsVoices(engine));
  }));

  // ── Engine Status ──────────────────────────
  app.get('/api/tts/status', route(async (_req, res) => {
    res.json(await ttsStatus());
  }));

  // ── List Generated Files ───────────────────
  app.get('/api/tts/outputs', (_req, res) => {
    const limit = Math.min(Number(_req.query.limit) || 50, 200);
    res.json({ files: listTTSFiles(limit) });
  });

  // ── Serve TTS Files ────────────────────────
  app.get('/tts/:file', (req, res) => {
    const file = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '');
    const fp = join(TTS_DIR, file);
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
