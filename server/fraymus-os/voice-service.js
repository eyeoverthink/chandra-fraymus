/**
 * VoiceStudio speaks through an OpenAI-style /v1/audio/speech route.
 * Piper is the local fallback. A failed VoiceStudio call is not relabeled as the owner voice.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DATA_DIR } from '../config.js';
import { classifyUrl } from './registry.js';
import { isAbort } from './http-error.js';

const execFileAsync = promisify(execFile);
const ALLOWED_VOICES = new Set(['vaughn-one', 'overlord']);

async function defaultPiperAvailable() {
  try {
    await execFileAsync('piper', ['--version'], { timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

export function createVoiceService(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const telemetry = options.telemetry;
  const audioDir = options.audioDir || join(options.dataDir || DATA_DIR, 'fraymus-os-audio');
  const voiceStudioUrl = options.voiceStudioUrl ?? process.env.FRAYMUS_VOICESTUDIO_URL ?? '';
  const configuredVoice = options.voiceId || process.env.FRAYMUS_VOICE_ID || 'vaughn-one';
  const allowPublicCloud = options.allowPublicCloud ?? process.env.FRAYMUS_OS_ALLOW_PUBLIC === '1';
  const studio = classifyUrl(voiceStudioUrl);
  let speakController = null;

  function resolveVoice(requested) {
    const voice = requested || configuredVoice;
    if (!ALLOWED_VOICES.has(voice)) {
      const error = new Error('Voice must be vaughn-one or overlord. F.R.A.Y.M.U.S. will not substitute another voice and call it the owner voice.');
      error.status = 400;
      throw error;
    }
    return voice;
  }

  let piperCache = { at: 0, value: null };
  async function piperAvailable() {
    if (typeof options.piperAvailable === 'function') return options.piperAvailable();
    if (piperCache.value != null && Date.now() - piperCache.at < 30_000) return piperCache.value;
    const value = await defaultPiperAvailable();
    piperCache = { at: Date.now(), value };
    return value;
  }

  async function transcribe(audio, { signal } = {}) {
    if (typeof options.transcribe === 'function') return options.transcribe(audio, { signal });
    const { sttTranscribe } = await import('../media/stt-engine.js');
    const result = await sttTranscribe(audio, { signal });
    const text = result?.transcript || result?.text || '';
    if (!text.trim()) {
      const error = new Error('Local speech recognition returned an empty transcript.');
      error.status = 503;
      throw error;
    }
    return { text: text.trim(), engine: result.engine || 'local-stt', routeClass: 'local' };
  }

  function saveAudio(buffer, extension) {
    mkdirSync(audioDir, { recursive: true });
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.${extension}`;
    writeFileSync(join(audioDir, name), buffer);
    return { name, bytes: buffer.length, url: `/api/fraymus-os/audio/${name}` };
  }

  async function speakWithStudio(text, voice, signal) {
    if (!studio.url) {
      const error = new Error('VoiceStudio is not configured.');
      error.code = 'unconfigured';
      throw error;
    }
    if (studio.routeClass === 'public' && !allowPublicCloud) {
      telemetry?.record({
        kind: 'voicestudio_speech', endpoint: studio.url, routeClass: 'public', model: voice,
        bytesSent: 0, durationMs: 0, ok: 0, error: 'public_cloud_disabled',
      });
      const error = new Error('VoiceStudio is on a public host and public cloud calls are disabled. No audio was requested.');
      error.code = 'public_cloud_disabled';
      error.status = 403;
      throw error;
    }
    const payload = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'wav' });
    const started = Date.now();
    const endpoint = `${studio.url}/v1/audio/speech`;
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal,
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      telemetry?.record({
        kind: 'voicestudio_speech',
        endpoint,
        routeClass: studio.routeClass,
        model: voice,
        bytesSent: Buffer.byteLength(payload),
        bytesReceived: buffer.length,
        durationMs: Date.now() - started,
        ok: response.ok ? 1 : 0,
        error: response.ok ? null : `HTTP ${response.status}`,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`VoiceStudio returned HTTP ${response.status}`), { status: 502 });
      }
      const type = response.headers.get('content-type') || '';
      const extension = type.includes('mpeg') || type.includes('mp3') ? 'mp3' : 'wav';
      const saved = saveAudio(buffer, extension);
      return { ok: true, engine: 'voicestudio', voice, routeClass: studio.routeClass, endpoint, ...saved };
    } catch (error) {
      if (!error.status) {
        telemetry?.record({
          kind: 'voicestudio_speech', endpoint, routeClass: studio.routeClass, model: voice,
          bytesSent: Buffer.byteLength(payload), durationMs: Date.now() - started, ok: 0,
          error: signal?.aborted ? 'cancelled' : error.message,
        });
      }
      throw error;
    }
  }

  async function speakWithPiper(text, signal) {
    if (signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    if (typeof options.speakPiper === 'function') {
      const result = await options.speakPiper(text, { signal });
      const buffer = result.buffer || Buffer.from(result.audioBase64 || '', 'base64');
      const saved = buffer.length ? saveAudio(buffer, result.format || 'wav') : { name: null, bytes: 0, url: result.url || null };
      telemetry?.record({
        kind: 'piper_speech', endpoint: 'piper://local', routeClass: 'local', model: 'piper',
        bytesSent: Buffer.byteLength(text), bytesReceived: saved.bytes, durationMs: result.durationMs || 0,
        ok: 1, error: null,
      });
      return { ok: true, engine: 'piper', voice: null, routeClass: 'local', endpoint: 'piper://local', ...saved };
    }
    const available = await piperAvailable();
    if (!available) {
      const error = new Error('Piper is not installed.');
      error.code = 'piper_unavailable';
      throw error;
    }
    const started = Date.now();
    const name = `${Date.now()}-${randomBytes(4).toString('hex')}.wav`;
    mkdirSync(audioDir, { recursive: true });
    const output = join(audioDir, name);
    await execFileAsync('piper', ['--model', process.env.FRAYMUS_PIPER_MODEL || 'en_US-lessac-medium', '--output_file', output], {
      timeout: 60_000,
      input: text,
      signal,
    });
    const { statSync } = await import('node:fs');
    const size = statSync(output).size;
    telemetry?.record({
      kind: 'piper_speech', endpoint: 'piper://local', routeClass: 'local', model: 'piper',
      bytesSent: Buffer.byteLength(text), bytesReceived: size, durationMs: Date.now() - started, ok: 1, error: null,
    });
    return { ok: true, engine: 'piper', voice: null, routeClass: 'local', endpoint: 'piper://local', name, bytes: size, url: `/api/fraymus-os/audio/${name}` };
  }

  async function speak(text, { voice, signal } = {}) {
    const clean = String(text || '').trim();
    if (!clean) {
      const error = new Error('text is required');
      error.status = 400;
      throw error;
    }
    if (clean.length > 4000) {
      const error = new Error('text is too long (max 4000 characters)');
      error.status = 400;
      throw error;
    }
    const chosen = resolveVoice(voice);
    const controller = new AbortController();
    speakController = controller;
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      try {
        return await speakWithStudio(clean, chosen, controller.signal);
      } catch (error) {
        if (isAbort(error, controller.signal)) throw error;
        try {
          const fallback = await speakWithPiper(clean, controller.signal);
          return { ...fallback, voiceStudioError: error.message, voiceRequested: chosen };
        } catch (piperError) {
          if (isAbort(piperError, controller.signal)) throw piperError;
          const wrapped = new Error(`Speech is unavailable. VoiceStudio: ${error.message} Piper: ${piperError.message}`);
          wrapped.status = 503;
          wrapped.fallback = 'text';
          throw wrapped;
        }
      }
    } finally {
      if (speakController === controller) speakController = null;
    }
  }

  function cancel() {
    if (!speakController) return { cancelled: false, reason: 'not_speaking' };
    speakController.abort();
    return { cancelled: true };
  }

  async function status() {
    const available = await piperAvailable().catch(() => false);
    return {
      voiceStudio: studio.url
        ? { configured: true, url: studio.url, host: studio.host, routeClass: studio.routeClass }
        : { configured: false, url: null, routeClass: 'unconfigured' },
      voiceId: ALLOWED_VOICES.has(configuredVoice) ? configuredVoice : null,
      piper: { available, offline: true, checked: true },
      allowedVoices: [...ALLOWED_VOICES],
    };
  }

  return { transcribe, speak, cancel, status, audioDir, resolveVoice };
}
