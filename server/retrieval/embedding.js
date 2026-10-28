import { AgentError, fail, stableJson } from '../agent/schema.js';
import { assertLocalModel, localOllamaUrl } from '../agent/provider.js';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const PREFIX_KEYS = ['provider','model','digest','documentPrefix','queryPrefix'];
const validPrefix = value => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && Buffer.byteLength(value) <= 256;
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, caught => { signal.removeEventListener('abort', abort); reject(caught); });
    if (signal.aborted) abort();
  });
}
function combine(signal, timeout) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('embedding_arguments', 'signal must be an AbortSignal');
  return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
}
function localMetadata(model, data, depth = 0) {
  if (depth > 8) fail('embedding_invalid_response', 'Embedding metadata is too deeply nested');
  if (!data || typeof data !== 'object') return;
  if (depth === 0) assertLocalModel(model, data);
  for (const value of Object.values(data)) if (value && typeof value === 'object') localMetadata(model, value, depth + 1);
}
function identityEquals(left, right) { return stableJson(left) === stableJson(right); }
function annotate(caught, dispatched, inputTokens) {
  const code=typeof caught?.code==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(caught.code)?caught.code
    :caught?.name==='TimeoutError'?'embedding_timeout':caught?.name==='AbortError'?'embedding_cancelled':'embedding_failed';
  const target=new AgentError(code,typeof caught?.message==='string'?caught.message.slice(0,400):'Local embedding operation failed');
  if(caught instanceof Error)Object.defineProperty(target,'cause',{value:caught,enumerable:false});
  if(Number.isInteger(caught?.status)&&caught.status>=100&&caught.status<=599)target.status=caught.status;
  target.dispatched = dispatched;
  if (inputTokens !== undefined) { target.inputTokens = inputTokens; target.usage = Object.freeze({ inputTokens, actual: true }); }
  else if (dispatched) target.usageUncertain = true;
  return target;
}

/** Local-only Ollama embeddings. Metadata is fresh; model calls are never retried. */
export function createEmbeddingProvider({ url, fetchImpl = fetch, model = 'nomic-embed-text:latest', documentPrefix = 'search_document: ', queryPrefix = 'search_query: ' } = {}) {
  const base = localOllamaUrl(url);
  if (typeof fetchImpl !== 'function' || typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(model) || !validPrefix(documentPrefix) || !validPrefix(queryPrefix)) fail('embedding_configuration', 'A local model and bounded UTF-8 prefixes are required');
  assertLocalModel(model);
  const dimensionsByIdentity = new Map();
  const makeIdentity = digest => Object.freeze({ provider: 'ollama', model, digest, documentPrefix, queryPrefix });
  function expected(value) {
    if (value === undefined) return undefined;
    if (!own(value, PREFIX_KEYS) || Object.keys(value).length !== PREFIX_KEYS.length || value.provider !== 'ollama' || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
      || !validPrefix(value.documentPrefix) || !validPrefix(value.queryPrefix) || typeof value.model !== 'string') fail('embedding_identity', 'A complete immutable embedding identity is required');
    const copy = Object.freeze(Object.fromEntries(PREFIX_KEYS.map(key => [key, value[key]])));
    if (copy.model !== model || copy.documentPrefix !== documentPrefix || copy.queryPrefix !== queryPrefix) fail('embedding_identity_changed', 'Embedding model or prefix identity changed');
    return copy;
  }
  async function request(path, body, signal, onDispatch) {
    signal.throwIfAborted(); onDispatch?.();
    let response;
    try { response = await abortable(fetchImpl(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), signal); }
    catch (caught) { if (signal.aborted) throw signal.reason; throw new AgentError('embedding_unavailable', 'The local embedding endpoint is unavailable'); }
    if (response.redirected || response.status >= 300 && response.status < 400 || response.url && response.url !== base + path) fail('embedding_redirect', 'Embedding endpoint redirects are forbidden');
    if (!response.ok) { const caught = new AgentError('embedding_http', `Local embedding endpoint returned HTTP ${Number.isInteger(response.status) ? response.status : 'error'}`); caught.status = response.status; throw caught; }
    const length = response.headers?.get?.('content-length');
    if (length !== null && length !== undefined && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) { response.body?.cancel?.().catch(() => {}); fail('embedding_response_limit', 'Embedding JSON response exceeds its byte bound'); }
    if (!response.body?.getReader) fail('embedding_invalid_response', 'Embedding endpoint must return a readable JSON response');
    const reader = response.body.getReader(), parts = []; let size = 0;
    const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted(); const next = await abortable(reader.read(), signal); if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('embedding_response_limit', 'Embedding JSON response exceeds its byte bound'); }
        parts.push(next.value);
      }
    } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
    signal.throwIfAborted();
    let data;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); } catch { fail('embedding_invalid_response', 'Embedding endpoint returned invalid UTF-8 JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('embedding_invalid_response', 'Embedding JSON must be an object');
    return data;
  }
  async function inventory(signal) {
    const data = await request('/api/tags', undefined, signal);
    const { models, ...metadata } = data; localMetadata(model, metadata);
    if (!Array.isArray(models) || models.length > 2048) fail('embedding_invalid_response', 'Local model inventory is invalid');
    const matches = models.filter(item => item && (item.name === model || item.model === model));
    if (matches.length !== 1) fail('embedding_model_unavailable', 'Exact embedding model tag is missing or ambiguous');
    const item = matches[0]; localMetadata(model, item);
    if (item.name !== undefined && item.name !== model || item.model !== undefined && item.model !== model || typeof item.digest !== 'string' || !/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(item.digest)) fail('embedding_invalid_response', 'Exact local model digest is unavailable');
    return item.digest.replace(/^sha256:/, '').toLowerCase();
  }
  async function inspectFresh(signal, expectedIdentity) {
    const first = makeIdentity(await inventory(signal));
    if (expectedIdentity && !identityEquals(first, expectedIdentity)) fail('embedding_identity_changed', 'Embedding model digest or prefixes changed');
    const shown = await request('/api/show', { model }, signal); localMetadata(model, shown);
    if (shown.error || !Array.isArray(shown.capabilities) || !shown.capabilities.includes('embedding')) fail('embedding_model_unsupported', 'The exact local model must advertise embedding capability');
    const last = makeIdentity(await inventory(signal));
    if (!identityEquals(first, last)) fail('embedding_identity_changed', 'Embedding model digest changed during inspection');
    return last;
  }
  async function inspect({ signal } = {}) { return inspectFresh(combine(signal, 15000)); }
  async function embed(texts, options = {}) {
    let dispatched = false, inputTokens;
    try {
      if (!own(options, ['kind','expectedIdentity','signal','beforeRequest']) || !['document','query'].includes(options.kind) || options.beforeRequest !== undefined && typeof options.beforeRequest !== 'function') fail('embedding_arguments', 'Embedding kind and exact supported options are required');
      if (!Array.isArray(texts) || !texts.length || texts.length > 32) fail('embedding_arguments', 'Embed between 1 and 32 strings');
      const prefix = options.kind === 'document' ? documentPrefix : queryPrefix, input = []; let inputBytes = 0;
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (!Object.hasOwn(texts, i) || typeof text !== 'string' || !text.isWellFormed() || !text.trim() || text.includes('\0')) fail('embedding_arguments', 'Inputs must be dense, nonempty UTF-8 strings');
        const value = prefix + text, count = Buffer.byteLength(value);
        if (count > 4096 || inputBytes + count > 32768) fail('embedding_input_limit', 'Prefixed embedding inputs exceed 4096 bytes each or 32768 bytes total');
        input.push(value); inputBytes += count;
      }
      // A conservative reservation estimate, not a model-tokenizer guarantee.
      // Actual prompt_eval_count remains authoritative and may exceed it.
      const estimatedInputTokens = inputBytes + input.length * 64 + 32;
      const expectedIdentity = expected(options.expectedIdentity), signal = combine(options.signal, 60000);
      const identity = await inspectFresh(signal, expectedIdentity);
      if (options.beforeRequest) await abortable(Promise.resolve().then(() => { signal.throwIfAborted(); return options.beforeRequest(Object.freeze({ estimatedInputTokens })); }), signal);
      signal.throwIfAborted();
      const data = await request('/api/embed', { model, input, truncate: false }, signal, () => { dispatched = true; });
      if (Number.isSafeInteger(data.prompt_eval_count) && data.prompt_eval_count >= 0) inputTokens = data.prompt_eval_count;
      localMetadata(model, data);
      if (data.error) fail('embedding_provider_error', 'Local embedding provider returned an error');
      if (data.model !== model) fail('embedding_model_mismatch', 'Embedding response model differs from the requested exact tag');
      if (inputTokens === undefined) fail('embedding_usage_unavailable', 'Embedding response omitted actual prompt_eval_count');
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== input.length) fail('embedding_invalid_vectors', 'Embedding vector count does not match input count');
      let dimensions;
      const vectors = data.embeddings.map(vector => {
        if (!Array.isArray(vector) || !vector.length || vector.length > 4096 || dimensions !== undefined && vector.length !== dimensions) fail('embedding_invalid_vectors', 'Embedding dimensions are invalid or inconsistent');
        dimensions = vector.length; let maximum = 0;
        for (let i = 0; i < vector.length; i++) { if (!Object.hasOwn(vector, i) || typeof vector[i] !== 'number' || !Number.isFinite(vector[i])) fail('embedding_invalid_vectors', 'Embedding components must be finite numbers'); maximum = Math.max(maximum, Math.abs(vector[i])); }
        if (!maximum) fail('embedding_invalid_vectors', 'Zero-norm embeddings are invalid');
        let squares = 0; for (const value of vector) squares += (value / maximum) ** 2;
        const divisor = Math.sqrt(squares), result = new Float32Array(dimensions);
        for (let i = 0; i < dimensions; i++) result[i] = (vector[i] / maximum) / divisor;
        return result;
      });
      const after = await inspectFresh(signal, identity);
      if (!identityEquals(identity, after)) fail('embedding_identity_changed', 'Embedding identity changed during inference');
      const key = stableJson(identity), previous = dimensionsByIdentity.get(key);
      if (previous !== undefined && previous !== dimensions) fail('embedding_dimensions_changed', 'The same embedding identity returned different dimensions');
      dimensionsByIdentity.set(key, dimensions);
      if (dimensionsByIdentity.size > 16) dimensionsByIdentity.delete(dimensionsByIdentity.keys().next().value);
      return { identity, vectors, dimensions, inputTokens, estimatedInputTokens };
    } catch (caught) { throw annotate(caught, dispatched, inputTokens); }
  }
  return Object.freeze({ inspect, embed });
}
