import { poolChat } from '../intelligence/model-pool.js';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';

/** One model reply through the model pool (the same path as commerce/shared.js chatOllama). */
export async function chatOllama(messages, opts = {}) {
  const data = { message: { content: await poolChat(messages, { model: opts.model || null, priority: opts.priority ?? 'goal', label: opts.label || 'creation', timeoutMs: 180_000, temperature: opts.temperature ?? 0.7, maxTokens: opts.maxTokens ?? 2048 }) } };
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
