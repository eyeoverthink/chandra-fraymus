import { AgentError, fail } from './schema.js';
import {normalizeThinking,thinkingControls,requireThinking,attachPrivateThinking} from './thinking.js';

export const cloudModelName = model => typeof model === 'string' && /(?:^|[:/@._-])cloud(?:$|[:/@._-])/i.test(model);
export function remoteModelMetadata(data, depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return false;
  for (const [key, value] of Object.entries(data)) {
    if (/^(?:remote[_-]?(?:host|model)|is[_-]?(?:cloud|remote)|cloud)$/i.test(key) && Boolean(value)) return true;
    if (value && typeof value === 'object' && remoteModelMetadata(value, depth + 1)) return true;
  }
  return false;
}
export function assertLocalModel(model, metadata) {
  if (cloudModelName(model) || remoteModelMetadata(metadata) || cloudModelName(metadata?.model) || cloudModelName(metadata?.name)) fail('local_cloud_blocked', 'Cloud and remotely hosted Ollama models are blocked by the local-only provider');
}

export function localOllamaUrl(input = 'http://127.0.0.1:11434') {
  let url;
  try { url = new URL(input); } catch { fail('invalid_provider', 'Invalid Ollama URL'); }
  const host = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
      || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    fail('invalid_provider', 'Ollama must use an explicit loopback HTTP endpoint; cloud providers are disabled');
  }
  return url.origin;
}

export async function readJson(response, signal, maxBytes = 2 * 1024 * 1024) {
  if (!response.ok) fail('provider_http', `Provider returned HTTP ${response.status}`);
  if (response.redirected) fail('provider_redirect', 'Provider redirects are not permitted');
  const length = Number(response.headers?.get?.('content-length'));
  if (length > maxBytes) fail('provider_response_too_large', 'Provider response exceeds the size limit');
  let text;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    const cancel = () => { reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maxBytes) { await reader.cancel(); fail('provider_response_too_large', 'Provider response exceeds the size limit'); }
        chunks.push(Buffer.from(next.value));
      }
      signal?.throwIfAborted();
      text = Buffer.concat(chunks).toString('utf8');
    } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) fail('provider_response_too_large', 'Provider response exceeds the size limit');
  }
  try { return JSON.parse(text); } catch { fail('provider_invalid_json', 'Provider returned invalid JSON'); }
}

/** Local implementation of the provider contract documented in README.md. No cloud fallback. */
export function createOllamaProvider({ url, fetchImpl = fetch }) {
  const base = localOllamaUrl(url);
  const request = async (path, body, signal) => {
    let response;
    try {
      response = await fetchImpl(base + path, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new AgentError('provider_unavailable', `Local Ollama is unavailable: ${String(error.message || error).slice(0, 200)}`);
    }
    return readJson(response, signal);
  };
  const inspectModel = async (model, signal) => {
    assertLocalModel(model);
    const data = await request('/api/show', { model }, signal);
    if (data.error) fail('model_unavailable', String(data.error).slice(0, 300));
    assertLocalModel(model, data);
    const capabilities = Array.isArray(data.capabilities) ? data.capabilities.filter(c => typeof c === 'string') : [];
    if (capabilities.length && !capabilities.includes('completion')) fail('model_unsupported', `${model} does not support chat completion`);
    const thinking=thinkingControls(data);
    return { name: model, provider: 'ollama', local: true, cloud: false, allowed: true, capabilities, tools: capabilities.includes('tools'), vision: capabilities.includes('vision'), capabilityMetadataAvailable: Array.isArray(data.capabilities),...(thinking?{thinking}:{}) };
  };
  return {
    id: 'ollama', local: true,
    async listModels(signal) {
      const data = await request('/api/tags', undefined, signal);
      if (!Array.isArray(data.models)) fail('provider_invalid_response', 'Ollama model inventory is invalid');
      return data.models.map(m => {
        const name = m.name || m.model;
        const blocked = cloudModelName(name) || remoteModelMetadata(m);
        return { name, size: m.size, details: m.details, remote_host: m.remote_host, remote_model: m.remote_model, provider: 'ollama', local: !blocked, cloud: blocked, allowed: !blocked, ...(blocked ? { blockedReason: 'Cloud/remote Ollama model is disabled' } : {}) };
      }).filter(m => typeof m.name === 'string');
    },
    inspectModel,
    async chat({ model, messages, tools, maxOutputTokens, maxInputTokens, signal,thinking,beforeRequest,estimatedInputTokens }) {
      // A direct caller or a renamed alias must not bypass service/UI inventory checks.
      // Inspect freshly for every inference; a cached local alias could be retargeted remotely.
      const choice=normalizeThinking(thinking),metadata=await inspectModel(model, signal);
      requireThinking(choice,metadata);
      signal?.throwIfAborted();
      // Recheck durable run headroom after metadata I/O, immediately before
      // dispatch. A late auxiliary response may have changed known usage.
      const checked=beforeRequest?.({inputTokens:estimatedInputTokens??Buffer.byteLength(JSON.stringify(messages))+Buffer.byteLength(JSON.stringify(tools??[]))+512,maxOutputTokens,reservedCostUsd:0,estimated:true});
      if(checked&&typeof checked.then==='function')await checked;
      signal?.throwIfAborted();
      const data = await request('/api/chat', {
        model, messages, ...(tools?.length ? { tools } : {}), stream: false,...(choice!==undefined?{think:choice}:{}),
        options: { num_predict: maxOutputTokens, num_ctx: maxInputTokens, temperature: 0.2 },
      }, signal);
      assertLocalModel(model, data);
      if (data.error) fail('provider_error', String(data.error).slice(0, 300));
      if (!data.message || typeof data.message.content !== 'string' || (data.message.tool_calls !== undefined && !Array.isArray(data.message.tool_calls))) fail('provider_invalid_response', 'Ollama returned an invalid chat message');
      if (data.done !== true) fail('provider_incomplete', 'Ollama response was incomplete');
      if (![data.prompt_eval_count, data.eval_count].every(n => Number.isSafeInteger(n) && n >= 0)) fail('usage_unavailable', 'Ollama did not return actual token usage; run stopped');
      const result={
        message: { role: 'assistant', content: data.message.content, ...(data.message.tool_calls ? { tool_calls: data.message.tool_calls } : {}) },
        usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count, costUsd: 0 },
        finishReason: data.done_reason || 'stop',
      };
      if(data.message.tool_calls?.length)attachPrivateThinking(result,data.message.thinking);return result;
    },
  };
}
