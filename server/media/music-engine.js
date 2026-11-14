import { poolChat } from '../intelligence/model-pool.js';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';
import { startMusic, getSong } from './music.js';

const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DATA_DIR = process.env.CHANDRA_DATA_DIR || './data';
const MUSIC_DIR = join(DATA_DIR, 'music');
if (!existsSync(MUSIC_DIR)) mkdirSync(MUSIC_DIR, { recursive: true });

const EMOTION_TO_MUSIC = {
  joy:      { tempo: [120, 140], key: 'major', energy: 'high', instruments: ['piano', 'strings', 'synth pad'] },
  sadness:  { tempo: [60, 80], key: 'minor', energy: 'low', instruments: ['cello', 'piano', 'ambient'] },
  anger:    { tempo: [140, 170], key: 'minor', energy: 'very_high', instruments: ['distorted guitar', 'drums', 'bass'] },
  fear:     { tempo: [80, 100], key: 'diminished', energy: 'medium', instruments: ['strings', 'ambient', 'sub bass'] },
  surprise: { tempo: [110, 130], key: 'major', energy: 'high', instruments: ['brass', 'synth', 'percussion'] },
  trust:    { tempo: [90, 110], key: 'major', energy: 'medium', instruments: ['acoustic guitar', 'piano', 'light strings'] },
  neutral:  { tempo: [100, 120], key: 'major', energy: 'medium', instruments: ['piano', 'ambient pad', 'light percussion'] },
};

export function emotionToMusicParams(emotionData) {
  if (!emotionData || typeof emotionData !== 'object') return EMOTION_TO_MUSIC.neutral;

  let dominant = 'neutral';
  let maxVal = 0;
  for (const [dim, val] of Object.entries(emotionData)) {
    if (typeof val === 'number' && val > maxVal && EMOTION_TO_MUSIC[dim]) {
      maxVal = val;
      dominant = dim;
    }
  }

  const base = EMOTION_TO_MUSIC[dominant];
  const valence = emotionData.valence ?? 0.5;
  const arousal = emotionData.arousal ?? 0.5;

  return {
    ...base,
    tempo: Math.round(base.tempo[0] + (base.tempo[1] - base.tempo[0]) * arousal),
    valence,
    arousal,
    dominant,
  };
}

export async function generateMusicPrompt(topic, emotion, format = 'short_video') {
  const params = emotionToMusicParams(emotion);
  const durationMap = { short_video: '30-60 seconds', long_video: '3-5 minutes', podcast: '60-90 seconds intro', social_post: '15-30 seconds' };
  const duration = durationMap[format] || '30-60 seconds';

  const system = `You are a music director. Generate a concise music production prompt for an AI music generator.
The prompt should describe mood, instruments, tempo, genre, and duration. One paragraph, under 100 words.
Do NOT use copyrighted song references.`;

  const user = `Topic: ${topic}
Emotion: ${params.dominant} (valence: ${params.valence?.toFixed(2)}, arousal: ${params.arousal?.toFixed(2)})
Tempo: ~${params.tempo} BPM
Key: ${params.key}
Instruments: ${params.instruments.join(', ')}
Energy: ${params.energy}
Duration: ${duration}
Format: ${format}`;

  try {
    const data = { message: { content: await poolChat([{ role: 'system', content: system }, { role: 'user', content: user }], { model: 'llama3.2', label: 'music:prompt', timeoutMs: 30_000 }) } };
    return {
      prompt: sanitizeOllamaContent(data.message?.content) || `${params.dominant} ${params.key} instrumental at ${params.tempo} BPM`,
      params,
      duration,
    };
  } catch {
    return {
      prompt: `${params.dominant} ${params.key} instrumental at ${params.tempo} BPM, ${params.instruments.join(' and ')}, ${params.energy} energy, ${duration}`,
      params,
      duration,
    };
  }
}

export async function generateMusic(prompt, options = {}) {
  // our own card first (ACE-Step 1.5 on a worker, music.js); the paid services below only if the local path fails
  try {
    const started = startMusic({ request: prompt.prompt || prompt, seconds: options.durationSeconds || 30, instrumental: options.instrumental !== false, source: 'music-engine' });
    await started.done;
    const song = getSong(started.id);
    if (song.status === 'completed') return { status: 'generated', engine: 'ace-step-1.5', id: song.id, file: song.file, url: song.media, title: song.plan?.title, prompt: prompt.prompt || prompt };
    console.error('[music] local:', song.error);
    if (!process.env.FAL_API_KEY && !process.env.SUNO_API_KEY) return { status: 'failed', engine: 'ace-step-1.5', id: song.id, error: song.error, prompt: prompt.prompt || prompt };
  } catch (e) { console.error('[music] local:', e.message); }
  const falToken = process.env.FAL_API_KEY;
  const sunoToken = process.env.SUNO_API_KEY;

  if (falToken) {
    try {
      const res = await fetch('https://queue.fal.run/fal-ai/minimax-music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Key ${falToken}` },
        body: JSON.stringify({
          prompt: prompt.prompt || prompt,
          duration: options.durationSeconds || 30,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json();
      if (data.audio_url || data.audio?.url) {
        const url = data.audio_url || data.audio.url;
        return { status: 'generated', engine: 'fal-minimax', url, prompt: prompt.prompt || prompt };
      }
      return { status: 'queued', engine: 'fal-minimax', requestId: data.request_id, prompt: prompt.prompt || prompt };
    } catch (e) {
      console.error('[music] FAL.AI failed:', e.message);
    }
  }

  if (sunoToken) {
    try {
      const res = await fetch('https://api.suno.ai/v1/generation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sunoToken}` },
        body: JSON.stringify({
          prompt: prompt.prompt || prompt,
          duration: options.durationSeconds || 30,
          make_instrumental: options.instrumental !== false,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json();
      return { status: 'queued', engine: 'suno', id: data.id, prompt: prompt.prompt || prompt };
    } catch (e) {
      console.error('[music] Suno failed:', e.message);
    }
  }

  return {
    status: 'prompt_only',
    engine: 'none',
    prompt: prompt.prompt || prompt,
    params: prompt.params || {},
    note: 'No music API configured. Set FAL_API_KEY (MiniMax via FAL.AI) or SUNO_API_KEY. The prompt is ready for manual generation.',
  };
}

export async function runMusicPipeline(topic, emotion, format = 'short_video', options = {}) {
  const musicPrompt = await generateMusicPrompt(topic, emotion, format);
  const result = await generateMusic(musicPrompt, { durationSeconds: options.durationSeconds || 30, instrumental: options.instrumental });

  return {
    ...result,
    musicPrompt,
    topic,
    emotion: musicPrompt.params?.dominant || 'neutral',
    format,
  };
}
