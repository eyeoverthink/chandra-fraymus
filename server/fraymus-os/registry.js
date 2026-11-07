/**
 * Configured Ollama and voice endpoints.
 * Route class is derived from the actual host. Models are whatever /api/tags returns.
 */

import os from 'node:os';
import { OLLAMA_URL } from '../config.js';

const REASONING_NAMES = ['fraynix-gpt'];
const FAST_NAMES = ['fraynix-dna'];

let cpuSample = null;

export function classifyHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return 'invalid';
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return 'local';
  if (host.endsWith('.local') || host.endsWith('.internal')) return 'private';
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return a === 127 ? 'local' : 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'private';
    return 'public';
  }
  if (host.includes(':')) {
    if (host === '::1') return 'local';
    if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return 'private';
    return 'public';
  }
  return 'public';
}

export function classifyUrl(value) {
  if (!value) return { url: null, host: null, routeClass: 'unconfigured' };
  try {
    const url = new URL(value);
    return { url: url.origin, host: url.hostname, routeClass: classifyHost(url.hostname) };
  } catch {
    return { url: null, host: null, routeClass: 'invalid' };
  }
}

export function nameMatches(installed, bases) {
  for (const base of bases) {
    const hit = installed.find(name => name === base || name.startsWith(`${base}:`) || name.split(':')[0] === base);
    if (hit) return hit;
  }
  return null;
}

export function selectInstalledModel(models, task = 'reasoning') {
  const names = (models || []).map(model => (typeof model === 'string' ? model : model.name)).filter(Boolean);
  const reasoning = nameMatches(names, REASONING_NAMES);
  const fast = nameMatches(names, FAST_NAMES);
  if (task === 'fast') return fast || reasoning || names[0] || null;
  return reasoning || fast || names[0] || null;
}

export function sampleHost() {
  const cpus = os.cpus();
  const totals = cpus.map(cpu => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
  let cpuPercent = null;
  if (cpuSample && cpuSample.length === totals.length) {
    let idle = 0;
    let total = 0;
    for (let i = 0; i < totals.length; i += 1) {
      idle += totals[i].idle - cpuSample[i].idle;
      total += totals[i].total - cpuSample[i].total;
    }
    if (total > 0) cpuPercent = Math.round((1 - idle / total) * 1000) / 10;
  }
  cpuSample = totals;
  const memoryTotalBytes = os.totalmem();
  const memoryFreeBytes = os.freemem();
  return {
    cpuPercent,
    cpuCount: cpus.length,
    cpuNote: cpuPercent == null
      ? 'CPU percent needs a second sample of os.cpus(); load average is shown in the meantime.'
      : 'CPU percent is the delta of os.cpus() since the previous sample.',
    loadAvg: os.loadavg(),
    memoryUsedBytes: memoryTotalBytes - memoryFreeBytes,
    memoryTotalBytes,
    memoryFreeBytes,
    heapUsedBytes: process.memoryUsage().heapUsed,
    measuredAt: Date.now(),
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function combineSignals(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function createRegistry(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const ollamaUrl = options.ollamaUrl || process.env.OLLAMA_BASE_URL || OLLAMA_URL;
  const voiceStudioUrl = options.voiceStudioUrl ?? process.env.FRAYMUS_VOICESTUDIO_URL ?? '';
  const voiceId = options.voiceId || process.env.FRAYMUS_VOICE_ID || 'vaughn-one';
  const allowPublicCloud = options.allowPublicCloud ?? process.env.FRAYMUS_OS_ALLOW_PUBLIC === '1';
  const telemetry = options.telemetry;
  const ollama = classifyUrl(ollamaUrl);
  const voice = classifyUrl(voiceStudioUrl);

  async function measured(kind, target, path, init = {}, { model = null, timeoutMs = 15_000 } = {}) {
    const endpoint = target.url ? `${target.url}${path}` : null;
    if (!endpoint) {
      const error = new Error(`${kind} endpoint is not configured`);
      error.code = 'unconfigured';
      throw error;
    }
    if (target.routeClass === 'public' && !allowPublicCloud) {
      telemetry?.record({
        kind, endpoint, routeClass: 'public', model, bytesSent: 0, bytesReceived: 0,
        durationMs: 0, ok: 0, error: 'public_cloud_disabled',
      });
      const error = new Error('Public cloud calls are disabled. No data was sent.');
      error.code = 'public_cloud_disabled';
      error.status = 403;
      throw error;
    }
    const body = init.body ? String(init.body) : '';
    const bytesSent = Buffer.byteLength(body);
    const started = Date.now();
    const signal = init.signal;
    const timeout = AbortSignal.timeout(timeoutMs);
    const composite = signal ? combineSignals([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(endpoint, { ...init, signal: composite });
      const buffer = Buffer.from(await response.arrayBuffer());
      let tokensIn = null;
      let tokensOut = null;
      let evalDurationNs = null;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('json') || contentType.includes('text')) {
        try {
          const parsed = JSON.parse(buffer.toString('utf8'));
          tokensIn = numberOrNull(parsed.prompt_eval_count);
          tokensOut = numberOrNull(parsed.eval_count);
          evalDurationNs = numberOrNull(parsed.eval_duration);
        } catch { /* audio or non-JSON */ }
      }
      telemetry?.record({
        kind,
        endpoint,
        routeClass: target.routeClass,
        model,
        bytesSent,
        bytesReceived: buffer.length,
        tokensIn,
        tokensOut,
        evalDurationNs,
        durationMs: Date.now() - started,
        ok: response.ok ? 1 : 0,
        error: response.ok ? null : `HTTP ${response.status}`,
      });
      return { response, buffer, tokensIn, tokensOut, evalDurationNs, durationMs: Date.now() - started };
    } catch (error) {
      telemetry?.record({
        kind,
        endpoint,
        routeClass: target.routeClass,
        model,
        bytesSent,
        bytesReceived: null,
        durationMs: Date.now() - started,
        ok: 0,
        error: signal?.aborted ? 'cancelled' : (error.name === 'TimeoutError' ? 'timeout' : error.message),
      });
      throw error;
    }
  }

  async function listModels() {
    if (typeof options.listModels === 'function') {
      const models = await options.listModels();
      return { ...ollama, models, error: null };
    }
    if (!ollama.url) return { ...ollama, models: [], error: 'Ollama endpoint is not configured' };
    try {
      const { response, buffer } = await measured('ollama_tags', ollama, '/api/tags', { method: 'GET' }, { timeoutMs: 5_000 });
      if (!response.ok) {
        return { ...ollama, models: [], error: `Ollama tags returned HTTP ${response.status}` };
      }
      const data = JSON.parse(buffer.toString('utf8'));
      const models = (data.models || [])
        .map(model => ({ name: model.name || model.model, size: Number.isFinite(model.size) ? model.size : null }))
        .filter(model => model.name);
      return { ...ollama, models, error: null };
    } catch (error) {
      return { ...ollama, models: [], error: error.code === 'public_cloud_disabled' ? error.message : `Ollama is not reachable: ${error.message}` };
    }
  }

  async function chat({ model, messages, signal }) {
    if (typeof options.chat === 'function') {
      const started = Date.now();
      try {
        const result = await options.chat({ model, messages, signal, endpoint: ollama.url, routeClass: ollama.routeClass });
        const text = result?.text ?? '';
        telemetry?.record({
          kind: 'ollama_chat',
          endpoint: ollama.url,
          routeClass: ollama.routeClass,
          model,
          bytesSent: Number.isFinite(result?.bytesSent) ? result.bytesSent : Buffer.byteLength(JSON.stringify(messages || [])),
          bytesReceived: Number.isFinite(result?.bytesReceived) ? result.bytesReceived : Buffer.byteLength(String(text)),
          tokensIn: numberOrNull(result?.tokensIn),
          tokensOut: numberOrNull(result?.tokensOut),
          evalDurationNs: numberOrNull(result?.evalDurationNs),
          durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : Date.now() - started,
          ok: 1,
          error: null,
        });
        return {
          text,
          model,
          endpoint: ollama.url,
          routeClass: ollama.routeClass,
          tokensIn: numberOrNull(result?.tokensIn),
          tokensOut: numberOrNull(result?.tokensOut),
          evalDurationNs: numberOrNull(result?.evalDurationNs),
        };
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') throw error;
        telemetry?.record({
          kind: 'ollama_chat', endpoint: ollama.url, routeClass: ollama.routeClass, model,
          bytesSent: 0, durationMs: Date.now() - started, ok: 0, error: error.message,
        });
        throw error;
      }
    }
    const payload = JSON.stringify({ model, messages, stream: false });
    const { response, buffer, tokensIn, tokensOut, evalDurationNs } = await measured(
      'ollama_chat',
      ollama,
      '/api/chat',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal },
      { model, timeoutMs: 180_000 },
    );
    if (!response.ok) {
      throw Object.assign(new Error(`Ollama returned HTTP ${response.status}`), { status: 502 });
    }
    const data = JSON.parse(buffer.toString('utf8'));
    const { sanitizeOllamaContent } = await import('../fraymus/intelligence/ollama-sanitize.js');
    return {
      text: sanitizeOllamaContent(data.message?.content || ''),
      model,
      endpoint: ollama.url,
      routeClass: ollama.routeClass,
      tokensIn,
      tokensOut,
      evalDurationNs,
    };
  }

  async function snapshot() {
    const models = await listModels();
    const installed = models.models || [];
    return {
      ollama: {
        ...models,
        preference: { reasoning: 'fraynix-gpt', fast: 'fraynix-dna:8b' },
        selectedReasoning: selectInstalledModel(installed, 'reasoning'),
        selectedFast: selectInstalledModel(installed, 'fast'),
        reasoningInstalled: !!nameMatches(installed.map(model => model.name), REASONING_NAMES),
        fastInstalled: !!nameMatches(installed.map(model => model.name), FAST_NAMES),
      },
      voice: {
        voiceId: ['vaughn-one', 'overlord'].includes(voiceId) ? voiceId : null,
        voiceStudio: voice.url ? { ...voice, configured: true } : { configured: false, url: null, host: null, routeClass: 'unconfigured' },
      },
      host: sampleHost(),
      policy: { allowPublicCloud, label: allowPublicCloud ? 'public cloud allowed by env' : 'public cloud disabled' },
    };
  }

  return {
    ollama,
    voice,
    voiceId,
    allowPublicCloud,
    listModels,
    chat,
    snapshot,
    measured,
    selectInstalledModel,
  };
}
