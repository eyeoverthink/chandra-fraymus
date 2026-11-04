import { OLLAMA_URL } from '../config.js';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';

export async function chatOllama(messages, opts = {}) {
  const url = process.env.OLLAMA_BASE_URL || OLLAMA_URL || 'http://127.0.0.1:11434';
  const res = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b',
      messages,
      stream: false,
      options: { temperature: opts.temperature ?? 0.7, num_predict: opts.maxTokens ?? 2048 },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return sanitizeOllamaContent(data.message?.content || '');
}

export function parseJSON(raw) {
  try { return JSON.parse(raw.trim()); } catch {}
  const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try { return JSON.parse(braceMatch[0]); } catch {}
  }
  return { raw };
}

export function voiceEndpoint() {
  return process.env.FRAYMUS_VOICE_URL || 'http://127.0.0.1:9099';
}

export function createCreationIntel(memoryBridge, heart) {
  if (!memoryBridge || !heart) return null;
  return {
    analyzeContent(text) {
      try { return heart.feel(text); } catch { return null; }
    },
    async recallInsights(query, limit = 3) {
      try { return await memoryBridge.recallRelated(query, limit); } catch { return []; }
    },
    storeInsight(data) {
      memoryBridge.storeCognitionResult(data).catch(() => {});
    },
    async recallDreams(limit = 3) {
      try { return await memoryBridge.recallRelated('dream consolidation creative', limit); } catch { return []; }
    },
  };
}
