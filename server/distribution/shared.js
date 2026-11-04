import { heart } from '../fraymus-tools.js';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';

const OLLAMA = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';

export async function chatOllama(system, user, model = 'llama3.2') {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json();
  return sanitizeOllamaContent(data.message?.content || '');
}

export function parseJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

export const PLATFORMS = {
  youtube: {
    name: 'YouTube',
    maxTitle: 100,
    maxDesc: 5000,
    maxTags: 500,
    formats: ['short_video', 'long_video'],
    apiEnv: 'YOUTUBE_API_KEY',
  },
  tiktok: {
    name: 'TikTok',
    maxTitle: 150,
    maxDesc: 2200,
    maxTags: 0,
    formats: ['short_video', 'social_post'],
    apiEnv: 'TIKTOK_ACCESS_TOKEN',
  },
  instagram: {
    name: 'Instagram',
    maxTitle: 0,
    maxDesc: 2200,
    maxTags: 30,
    formats: ['short_video', 'social_post'],
    apiEnv: 'INSTAGRAM_ACCESS_TOKEN',
  },
  x: {
    name: 'X / Twitter',
    maxTitle: 0,
    maxDesc: 280,
    maxTags: 0,
    formats: ['social_post', 'short_video'],
    apiEnv: 'X_BEARER_TOKEN',
  },
  podcast: {
    name: 'Podcast RSS',
    maxTitle: 255,
    maxDesc: 4000,
    maxTags: 0,
    formats: ['podcast'],
    apiEnv: null,
  },
};

export function platformAvailable(platformId) {
  const cfg = PLATFORMS[platformId];
  if (!cfg) return false;
  if (!cfg.apiEnv) return true;
  return !!process.env[cfg.apiEnv];
}

export function availablePlatforms() {
  return Object.entries(PLATFORMS)
    .filter(([id]) => platformAvailable(id))
    .map(([id, cfg]) => ({ id, ...cfg }));
}

export function createDistributionIntel(memoryBridge, heartRef) {
  const h = heartRef || heart;
  return {
    analyzeContent: async (text) => {
      try { return h?.feel?.(text) || { valence: 0 }; } catch { return { valence: 0 }; }
    },
    recallPerformance: async (topic) => {
      try {
        if (!memoryBridge?.recall) return [];
        return await memoryBridge.recall(`distribution performance ${topic}`, 5);
      } catch { return []; }
    },
    storeResult: async (key, value) => {
      try { memoryBridge?.store?.(key, value, { provenance: 'measured', type: 'distribution' }); } catch {}
    },
  };
}
