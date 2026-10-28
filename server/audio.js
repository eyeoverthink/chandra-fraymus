const MAX_WAV_BYTES = 4 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil(MAX_WAV_BYTES / 3) * 4;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEADLINE_MS = 32000;
const ENGINES = new Set(['windows-system-speech-recognition', 'faster-whisper-cpu']);
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const ERROR_MARK = Symbol('validated audio error');
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status, [ERROR_MARK]: true });
const reject = (code, message, status) => { throw failure(code, message, status); };

function languageTag(value, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 35 || !LANGUAGE.test(value)) reject('invalid_field', 'language must be a short language tag such as en-US');
  return value;
}
function objectKeys(value, allowed) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
}

/** Strict RIFF/WAVE PCM16 inspection only: no decoding, playback, OCR or recognition. */
export function validateWav(data) {
  if (!Buffer.isBuffer(data)) reject('invalid_wav', 'Audio must be WAV bytes');
  if (!data.length || data.length > MAX_WAV_BYTES) reject('audio_too_large', 'WAV size must be 1 byte to 4 MiB', 413);
  if (data.length < 12 || data.toString('latin1', 0, 4) !== 'RIFF' || data.toString('latin1', 8, 12) !== 'WAVE'
      || data.readUInt32LE(4) + 8 !== data.length) reject('invalid_wav', 'Expected an exact RIFF/WAVE file; compressed, RF64 and trailing data are unsupported');
  let offset = 12, chunks = 0, format, dataBytes;
  while (offset < data.length) {
    if (++chunks > 1024 || offset + 8 > data.length) reject('invalid_wav', 'WAV chunk count or framing is invalid');
    const id = data.toString('latin1', offset, offset + 4), length = data.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, next = end + (length & 1);
    if (end > data.length || next > data.length) reject('invalid_wav', 'WAV chunk exceeds its RIFF extent or is missing padding');
    if (id === 'fmt ') {
      if (format || dataBytes !== undefined || ![16, 18].includes(length)) reject('invalid_wav', 'WAV needs one PCM fmt chunk before one data chunk');
      const code = data.readUInt16LE(start), channels = data.readUInt16LE(start + 2), sampleRate = data.readUInt32LE(start + 4);
      const byteRate = data.readUInt32LE(start + 8), align = data.readUInt16LE(start + 12), bits = data.readUInt16LE(start + 14);
      if (code !== 1 || bits !== 16 || ![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 48000
          || align !== channels * 2 || byteRate !== sampleRate * align || (length === 18 && data.readUInt16LE(start + 16) !== 0)) reject('invalid_wav', 'Only unextended PCM16 mono/stereo at 8–48 kHz with exact alignment and byte rate is supported');
      format = { sampleRate, channels, align };
    } else if (id === 'data') {
      if (!format || dataBytes !== undefined || !length || length % format.align !== 0) reject('invalid_wav', 'WAV needs one nonempty frame-aligned data chunk after fmt');
      dataBytes = length;
    }
    offset = next;
  }
  if (offset !== data.length || !format || dataBytes === undefined) reject('invalid_wav', 'WAV is missing a complete fmt or data chunk');
  const frames = dataBytes / format.align, durationSeconds = frames / format.sampleRate;
  if (frames > format.sampleRate * 60) reject('audio_too_large', 'WAV duration must be greater than zero and at most 60 seconds', 413);
  return { durationSeconds, sampleRate: format.sampleRate, channels: format.channels, sampleWidth: 2, frames };
}

/** HTTP request boundary: a canonical encoded WAV plus optional language, never paths or URLs. */
export function validateListenRequest(body) {
  if (!objectKeys(body, ['audioBase64', 'language']) || !Object.hasOwn(body, 'audioBase64')) reject('unknown_fields', 'Listen accepts only audioBase64 and optional language');
  const encoded = body.audioBase64;
  if (typeof encoded !== 'string' || !encoded.length) reject('invalid_base64', 'audioBase64 must contain canonical WAV base64');
  if (encoded.length > MAX_BASE64_CHARS) reject('audio_too_large', 'Encoded WAV exceeds 4 MiB', 413);
  if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) reject('invalid_base64', 'audioBase64 must be canonical base64 without whitespace or data URLs');
  const data = Buffer.from(encoded, 'base64');
  if (data.toString('base64') !== encoded) reject('invalid_base64', 'audioBase64 has noncanonical padding bits');
  validateWav(data);
  const language = Object.hasOwn(body, 'language') ? languageTag(body.language) : undefined;
  return { audioBase64: encoded, ...(language === undefined ? {} : { language }) };
}

function voiceOrigin(value) {
  let url;
  if (typeof value !== 'string' || value.length > 2048) reject('invalid_voice_url', 'Voice service must be a configured HTTP loopback origin', 500);
  try { url = new URL(value); } catch { reject('invalid_voice_url', 'Voice service URL is invalid', 500); }
  const authority = value.match(/^http:\/\/([^/?#]*)/i)?.[1];
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || authority?.includes('@') || url.pathname !== '/' || url.search || url.hash
      || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) reject('invalid_voice_url', 'Voice service must be an HTTP loopback origin without credentials, path, query or fragment', 500);
  return url.origin;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
function cancelBody(response) {
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch { /* Cancellation does not replace the bounded validation error. */ }
}
async function responseJson(response, signal) {
  const length = Number(response.headers?.get?.('content-length'));
  if (length > MAX_RESPONSE_BYTES) { cancelBody(response); reject('speech_response_too_large', 'Speech service JSON exceeds 256 KiB', 502); }
  if (!response.body?.getReader) reject('speech_response_invalid', 'Speech service returned no readable JSON body', 502);
  const reader = response.body.getReader(), chunks = [];
  let size = 0, complete = false;
  const cancel = () => { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const item = await abortable(reader.read(), signal);
      if (item.done) { complete = true; break; }
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) reject('speech_response_too_large', 'Speech service JSON exceeds 256 KiB', 502);
      chunks.push(Buffer.from(item.value));
    }
    signal.throwIfAborted();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { reject('speech_response_invalid', 'Speech service returned invalid JSON', 502); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    try { reader.releaseLock(); } catch {}
  }
}

const BACKEND_ERRORS = {
  invalid_field: [400, 'Speech request contains an invalid field'], unknown_fields: [400, 'Speech request contains unsupported fields'],
  invalid_base64: [400, 'Speech request base64 is invalid'], invalid_wav: [400, 'Speech request WAV is unsupported'],
  language_unavailable: [400, 'The requested recognition language is not installed'],
  audio_too_large: [413, 'Speech audio exceeds the supported limit'], body_too_large: [413, 'Speech request exceeds the supported limit'],
  no_speech: [422, 'No speech was recognized in the supplied audio'],
  stt_unavailable: [503, 'Local speech recognition is unavailable'], recognition_busy: [503, 'Local speech recognition is busy'],
  recognition_timeout: [504, 'Local speech recognition exceeded its deadline'],
  recognition_failed: [502, 'Local speech recognition failed'], output_limit: [502, 'Speech recognition output exceeded its limit'],
  recognition_incomplete: [502, 'Speech recognition did not finish the complete supplied clip'],
};
function backendFailure(data, httpStatus) {
  const known = typeof data?.code === 'string' && Object.hasOwn(BACKEND_ERRORS, data.code) ? BACKEND_ERRORS[data.code] : null;
  if (known) throw failure(data.code, known[1], known[0]);
  if (httpStatus === 503) reject('stt_unavailable', 'Local speech recognition is unavailable', 503);
  if (httpStatus === 504) reject('recognition_timeout', 'Local speech recognition exceeded its deadline', 504);
  reject('recognition_failed', 'Local speech recognition failed without a valid success receipt', 502);
}
function receiptError(message) { reject('speech_response_invalid', message, 502); }
const confidenceValid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const textValid = value => typeof value === 'string' && value.length <= 12000 && value.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export function validateAudioReceipt(data, local, requestedLanguage) {
  if (!objectKeys(data, ['ok', 'transcript', 'engine', 'language', 'confidence', 'confidenceMetric', 'model', 'segments', 'audio']) || data.ok !== true
      || !ENGINES.has(data.engine) || !textValid(data.transcript) || !confidenceValid(data.confidence)
      || typeof data.language !== 'string' || data.language.length > 35 || !LANGUAGE.test(data.language)) receiptError('Speech service returned an invalid recognizer receipt');
  const whisper = data.engine === 'faster-whisper-cpu';
  if (whisper) {
    if (!objectKeys(data.model, ['id','revision']) || data.model.id !== 'Systran/faster-whisper-small.en' || typeof data.model.revision !== 'string' || !/^[a-f0-9]{40}$/.test(data.model.revision)
      || data.confidenceMetric !== 'exp_avg_logprob' || data.language.toLowerCase() !== 'en') receiptError('Whisper receipt requires the pinned English model identity and uncalibrated decoder metric');
  } else if (data.model !== undefined || (data.confidenceMetric !== undefined && data.confidenceMetric !== 'recognizer_confidence')) receiptError('Windows speech receipt has unsupported model or metric fields');
  const language = data.language.toLowerCase();
  if (requestedLanguage && language !== requestedLanguage.toLowerCase()
      && !(whisper && requestedLanguage.toLowerCase().split('-')[0] === 'en' && language === 'en')
      && (requestedLanguage.includes('-') || language.split('-')[0] !== requestedLanguage.toLowerCase())) receiptError('Speech recognition language does not match the request');
  const audio = data.audio, tolerance = 1 / local.sampleRate + 1e-9;
  if (!objectKeys(audio, ['durationSeconds', 'sampleRate', 'channels', 'sampleWidth']) || audio.sampleRate !== local.sampleRate || audio.channels !== local.channels || audio.sampleWidth !== 2
      || typeof audio.durationSeconds !== 'number' || !Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0
      || Math.abs(audio.durationSeconds - local.durationSeconds) > tolerance) receiptError('Speech receipt audio metadata does not match the supplied WAV');
  let segments;
  if (data.segments !== undefined) {
    if (!Array.isArray(data.segments) || data.segments.length > 1024) receiptError('Speech segments exceed the supported bound');
    segments = data.segments.map(segment => {
      if (!objectKeys(segment, ['text', 'confidence', 'startSeconds', 'durationSeconds']) || !textValid(segment.text) || !confidenceValid(segment.confidence)) receiptError('Speech service returned an invalid segment');
      for (const key of ['startSeconds', 'durationSeconds']) if (segment[key] !== undefined && (typeof segment[key] !== 'number' || !Number.isFinite(segment[key]) || segment[key] < 0 || segment[key] > local.durationSeconds + tolerance)) receiptError('Speech segment timing lies outside the supplied audio');
      if (segment.startSeconds !== undefined && segment.durationSeconds !== undefined && segment.startSeconds + segment.durationSeconds > local.durationSeconds + tolerance) receiptError('Speech segment end lies outside the supplied audio');
      return { text: segment.text, confidence: segment.confidence, ...(segment.startSeconds === undefined ? {} : { startSeconds: segment.startSeconds }), ...(segment.durationSeconds === undefined ? {} : { durationSeconds: segment.durationSeconds }) };
    });
  }
  return { ok: true, transcript: data.transcript, engine: data.engine, language: data.language, confidence: data.confidence,
    ...(whisper ? { model: { id: data.model.id, revision: data.model.revision }, confidenceMetric: data.confidenceMetric } : data.confidenceMetric ? { confidenceMetric: data.confidenceMetric } : {}),
    ...(segments === undefined ? {} : { segments }), audio: { durationSeconds: audio.durationSeconds, sampleRate: audio.sampleRate, channels: audio.channels, sampleWidth: 2 } };
}

/** Fixed loopback recognition transport. Errors never fabricate a transcript or switch engines. */
export async function transcribeAudio(data, { voiceUrl, fetchImpl = fetch, signal, language } = {}) {
  const local = validateWav(data), requestedLanguage = languageTag(language, true), origin = voiceOrigin(voiceUrl);
  if (typeof fetchImpl !== 'function') reject('invalid_voice_client', 'Voice client is not configured', 500);
  if (signal?.aborted) reject('audio_cancelled', 'Audio transcription was cancelled', 499);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(failure('recognition_timeout', 'Local speech recognition exceeded its 32 second deadline', 504)), DEADLINE_MS);
  timer.unref?.();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    let response;
    try {
      response = await abortable(fetchImpl(origin + '/listen', { method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audioBase64: data.toString('base64'), ...(requestedLanguage === undefined ? {} : { language: requestedLanguage }) }) }), combined);
    } catch (error) {
      if (combined.aborted) throw combined.reason;
      if (error?.name === 'TimeoutError') reject('recognition_timeout', 'Local speech recognition exceeded its deadline', 504);
      reject('stt_unavailable', 'Local speech recognition service is unavailable', 503);
    }
    if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) receiptError('Speech service returned an invalid HTTP response');
    if (response.redirected || (response.status >= 300 && response.status < 400)) { cancelBody(response); reject('voice_redirect_blocked', 'Speech service redirects are not permitted', 502); }
    const result = await responseJson(response, combined);
    if (!response.ok || result?.ok !== true) backendFailure(result, response.status);
    return validateAudioReceipt(result, local, requestedLanguage);
  } catch (error) {
    if (signal?.aborted) throw failure('audio_cancelled', 'Audio transcription was cancelled', 499);
    if (deadline.signal.aborted) throw failure('recognition_timeout', 'Local speech recognition exceeded its 32 second deadline', 504);
    if (error?.[ERROR_MARK]) throw error;
    throw failure('recognition_failed', 'Local speech recognition failed without a valid receipt', 502);
  } finally { clearTimeout(timer); }
}
