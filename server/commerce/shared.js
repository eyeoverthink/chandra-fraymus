import { poolChat } from '../intelligence/model-pool.js';
import { OLLAMA_URL } from '../config.js';
import { sanitizeOllamaContent } from '../fraymus/intelligence/ollama-sanitize.js';
import { withOllama } from '../intelligence/ollama-scheduler.js';

// opts.priority: scheduler class ('interactive' | 'agent_run' | 'scoring' | 'goal' | 'forge' |
// 'debate' | 'verifier' | 'reflection' | 'dream'); untagged callers run as 'goal' (medium).
// The request timeout starts only once the scheduler admits the call, so queue time never
// counts against the model.
/**
 * One model reply. Goes to the first machine in the model pool that can take it (intelligence/model-pool.js):
 * this PC's calls still pass through the Ollama scheduler; another machine is used when it answers, and the next one
 * when it does not. A caller that names a model reaches only machines that have it.
 */
export async function chatOllama(messages, opts = {}) {
  const content = await poolChat(messages, {
    model: opts.model || null, priority: opts.priority ?? 'goal', label: opts.label || `chat:${opts.priority || 'untagged'}`,
    // Default 180 s; long single-shot generations (SMK whole-file code rewrites) pass timeoutMs, capped at 15 min
    timeoutMs: Math.min(900_000, Math.max(10_000, parseInt(opts.timeoutMs, 10) || 180_000)),
    temperature: opts.temperature ?? 0.7, maxTokens: opts.maxTokens ?? 2048,
    // Ollama grammar-constrained JSON output; callers that must parse JSON pass format: 'json'
    format: opts.format || null,
  });
  return sanitizeOllamaContent(content);
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

export function shopifyHeaders() {
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token };
}

export function shopifyBase() {
  const store = process.env.SHOPIFY_STORE_DOMAIN;
  return store ? `https://${store}/admin/api/2024-10` : null;
}

export function createCommerceIntel(memoryBridge, heart) {
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
  };
}
