import { Router } from 'express';
import { generateMusicPrompt, generateMusic, runMusicPipeline, emotionToMusicParams } from './music-engine.js';

const router = Router();

router.post('/api/media/music/prompt', async (req, res, next) => {
  try {
    const { topic, emotion, format } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const result = await generateMusicPrompt(topic, emotion || {}, format || 'short_video');
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/api/media/music/generate', async (req, res, next) => {
  try {
    const { prompt, durationSeconds, instrumental } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const result = await generateMusic(prompt, { durationSeconds, instrumental });
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/api/media/music/pipeline', async (req, res, next) => {
  try {
    const { topic, emotion, format, durationSeconds, instrumental } = req.body;
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const result = await runMusicPipeline(topic, emotion || {}, format || 'short_video', { durationSeconds, instrumental });
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/api/media/music/emotion-map', (req, res) => {
  const { emotion } = req.body;
  res.json(emotionToMusicParams(emotion || {}));
});

router.get('/api/media/music/status', (_req, res) => {
  res.json({
    engines: {
      fal_minimax: !!process.env.FAL_API_KEY,
      suno: !!process.env.SUNO_API_KEY,
    },
    available: !!(process.env.FAL_API_KEY || process.env.SUNO_API_KEY),
    note: !process.env.FAL_API_KEY && !process.env.SUNO_API_KEY
      ? 'No music API configured. Prompt generation works; actual audio requires FAL_API_KEY or SUNO_API_KEY.'
      : 'Music generation ready',
  });
});

export default router;
