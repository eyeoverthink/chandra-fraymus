import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWav, validateListenRequest, transcribeAudio } from '../server/audio.js';

function chunk(id, payload) {
  const header = Buffer.alloc(8); header.write(id, 0, 4, 'ascii'); header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, ...(payload.length & 1 ? [Buffer.of(0)] : [])]);
}
function riff(chunks) {
  const payload = Buffer.concat([Buffer.from('WAVE'), ...chunks]), header = Buffer.alloc(8);
  header.write('RIFF'); header.writeUInt32LE(payload.length, 4); return Buffer.concat([header, payload]);
}
function format({ sampleRate = 16000, channels = 1, fmtSize = 16, code = 1, bits = 16, align = channels * 2, byteRate = sampleRate * align, cbSize = 0 } = {}) {
  const fmt = Buffer.alloc(fmtSize); fmt.writeUInt16LE(code); fmt.writeUInt16LE(channels, 2); fmt.writeUInt32LE(sampleRate, 4); fmt.writeUInt32LE(byteRate, 8); fmt.writeUInt16LE(align, 12); fmt.writeUInt16LE(bits, 14);
  if (fmtSize >= 18) fmt.writeUInt16LE(cbSize, 16);
  return chunk('fmt ', fmt);
}
function wav(options = {}) { const { frames = 1600, channels = 1 } = options; return riff([format(options), chunk('data', Buffer.alloc(frames * channels * 2))]); }
const voiceUrl = 'http://127.0.0.1:9099';
function success(data, extra = {}) {
  const { durationSeconds, sampleRate, channels, sampleWidth } = validateWav(data);
  return { ok: true, transcript: 'hello world', engine: 'windows-system-speech-recognition', language: 'en-US', confidence: 0.85,
    segments: [{ text: 'hello', confidence: 0.9, startSeconds: 0, durationSeconds: durationSeconds / 2 }, { text: 'world', confidence: 0.8, startSeconds: durationSeconds / 2, durationSeconds: durationSeconds / 2 }],
    audio: { durationSeconds, sampleRate, channels, sampleWidth }, ...extra };
}
const client = (data, response, options = {}) => transcribeAudio(data, { voiceUrl, fetchImpl: async () => response instanceof Response ? response : Response.json(response), ...options });

test('offline Whisper receipts require pinned English model identity and an explicit decoder metric', async () => {
  const data = wav(), receipt = success(data, { engine: 'faster-whisper-cpu', language: 'en', confidenceMetric: 'exp_avg_logprob',
    model: { id: 'Systran/faster-whisper-small.en', revision: 'd1d751a5f8271d482d14ca55d9e2deeebbae577f' } });
  const result = await client(data, receipt, { language: 'en-US' });
  assert.equal(result.language, 'en'); assert.equal(result.engine, 'faster-whisper-cpu'); assert.deepEqual(result.model, receipt.model);
  assert.equal(result.confidenceMetric, 'exp_avg_logprob');
  for (const override of [
    { model: undefined }, { confidenceMetric: undefined }, { confidenceMetric: 'language_probability' },
    { model: { ...receipt.model, revision: 'main' } }, { model: { ...receipt.model, id: 'other/model' } },
    { language: 'fr' }, { engine: 'remote-whisper' },
  ]) await assert.rejects(client(data, { ...receipt, ...override }), { code: 'speech_response_invalid' });
  await assert.rejects(client(data, receipt, { language: 'fr-FR' }), { code: 'speech_response_invalid' });
  await assert.rejects(client(data, success(data), { language: 'en-GB' }), { code: 'speech_response_invalid' });
});

test('PCM16 WAV validates exact mono/stereo metadata, Windows fmt18 and bounded ancillary chunks', () => {
  assert.deepEqual(validateWav(wav()), { durationSeconds: 0.1, sampleRate: 16000, channels: 1, sampleWidth: 2, frames: 1600 });
  assert.deepEqual(validateWav(wav({ sampleRate: 48000, channels: 2, fmtSize: 18, frames: 1 })), { durationSeconds: 1 / 48000, sampleRate: 48000, channels: 2, sampleWidth: 2, frames: 1 });
  const padded = riff([chunk('JUNK', Buffer.of(7)), format({ fmtSize: 18 }), chunk('LIST', Buffer.from('metadata')), chunk('data', Buffer.alloc(320)), chunk('JUNK', Buffer.alloc(0))]);
  assert.equal(validateWav(padded).frames, 160);
  assert.equal(validateWav(wav({ sampleRate: 8000, frames: 480000 })).durationSeconds, 60);
});

test('malformed RIFF sizes, magic, chunk extents/order/duplicates and excess chunk counts are rejected', () => {
  const valid = wav();
  for (const id of ['RF64', 'RIFX', 'JUNK']) { const copy = Buffer.from(valid); copy.write(id); assert.throws(() => validateWav(copy), { code: 'invalid_wav' }); }
  const wrongType = Buffer.from(valid); wrongType.write('AVI ', 8); assert.throws(() => validateWav(wrongType), { code: 'invalid_wav' });
  for (const position of [0, 8, 12, 36]) { const highBit = Buffer.from(valid); highBit[position] |= 0x80; assert.throws(() => validateWav(highBit), { code: 'invalid_wav' }); }
  for (const bytes of [valid.subarray(0, -1), Buffer.concat([valid, Buffer.of(0)]), Buffer.from('RIFF'), riff([chunk('data', Buffer.alloc(2)), format()]), riff([format(), format(), chunk('data', Buffer.alloc(2))]), riff([format(), chunk('data', Buffer.alloc(2)), chunk('data', Buffer.alloc(2))]), riff([format()]), riff([format(), chunk('data', Buffer.alloc(0))])]) assert.throws(() => validateWav(bytes), { code: 'invalid_wav' });
  const overrun = Buffer.from(valid); overrun.writeUInt32LE(0xffffffff, 40); assert.throws(() => validateWav(overrun), { code: 'invalid_wav' });
  const truncatedPad = riff([chunk('JUNK', Buffer.of(7)).subarray(0, 9)]); assert.throws(() => validateWav(truncatedPad), { code: 'invalid_wav' });
  assert.equal(validateWav(riff([...Array.from({ length: 1022 }, () => chunk('JUNK', Buffer.alloc(0))), format(), chunk('data', Buffer.alloc(2))])).frames, 1);
  assert.throws(() => validateWav(riff([...Array.from({ length: 1023 }, () => chunk('JUNK', Buffer.alloc(0))), format(), chunk('data', Buffer.alloc(2))])), { code: 'invalid_wav' });
});

test('unsupported/compressed/extensible formats, invalid rates/alignment and malformed frames fail closed', () => {
  for (const options of [{ code: 3 }, { code: 0xfffe }, { bits: 8 }, { channels: 0 }, { channels: 3 }, { sampleRate: 7999 }, { sampleRate: 48001 }, { align: 1 }, { byteRate: 1 }, { fmtSize: 18, cbSize: 1 }, { fmtSize: 40 }]) assert.throws(() => validateWav(wav(options)), { code: 'invalid_wav' });
  assert.throws(() => validateWav(riff([format(), chunk('data', Buffer.alloc(3))])), { code: 'invalid_wav' });
  assert.throws(() => validateWav(riff([format({ channels: 2 }), chunk('data', Buffer.alloc(2))])), { code: 'invalid_wav' });
  assert.throws(() => validateWav(wav({ sampleRate: 8000, frames: 480001 })), { code: 'audio_too_large', status: 413 });
  assert.throws(() => validateWav(Buffer.alloc(4 * 1024 * 1024 + 1)), { code: 'audio_too_large', status: 413 });
  assert.throws(() => validateWav(new Uint8Array(wav())), { code: 'invalid_wav' });
});

test('listen requests accept canonical WAV base64 only, bound before decoding, and forbid paths/URLs/extra fields', () => {
  const encoded = wav({ frames: 1 }).toString('base64');
  assert.deepEqual(validateListenRequest({ audioBase64: encoded, language: 'en-US' }), { audioBase64: encoded, language: 'en-US' });
  for (const body of [null, [], {}, { audioBase64: encoded, path: 'user.wav' }, { audioBase64: encoded, url: 'http://example.test/audio' }, { audioBase64: 5 }, { audioBase64: encoded + '\n' }, { audioBase64: 'data:audio/wav;base64,' + encoded }, { audioBase64: encoded, language: '../en' }, { audioBase64: encoded, language: 'x'.repeat(36) }]) assert.throws(() => validateListenRequest(body));
  assert.throws(() => validateListenRequest({ audioBase64: 'A'.repeat(Math.ceil(4 * 1024 * 1024 / 3) * 4 + 4) }), { code: 'audio_too_large', status: 413 });
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', position = encoded.length - 3;
  const noncanonical = encoded.slice(0, position) + alphabet[alphabet.indexOf(encoded[position]) + 1] + encoded.slice(position + 1);
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), Buffer.from(encoded, 'base64'));
  assert.throws(() => validateListenRequest({ audioBase64: noncanonical }), { code: 'invalid_base64' });
});

test('client posts canonical bytes to fixed loopback listen and validates actual recognizer receipts', async () => {
  const data = wav(), expected = success(data);
  let requests = 0;
  const actual = await transcribeAudio(data, { voiceUrl: 'http://localhost:9099/', language: 'en', fetchImpl: async (url, options) => {
    requests++; assert.equal(url, 'http://localhost:9099/listen'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), { audioBase64: data.toString('base64'), language: 'en' });
    return Response.json(expected);
  } });
  assert.deepEqual(actual, expected); assert.equal(requests, 1);
  const bytes = Buffer.from(JSON.stringify(success(data, { transcript: 'hello 🌍' })));
  const split = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  assert.equal((await client(data, split)).transcript, 'hello 🌍');
});

test('client rejects remote/non-HTTP/non-origin/credential URLs before sending audio', async () => {
  let calls = 0;
  for (const url of ['https://localhost:9099', 'http://example.test', 'http://127.0.0.1.evil.test', 'http://localhost:9099/listen', 'http://localhost:9099/?x=1', 'http://localhost:9099/#x', 'http://u:p@localhost:9099', 'http://@localhost:9099', 'http://localhost:0', 'file:///C:/audio.wav']) await assert.rejects(transcribeAudio(wav(), { voiceUrl: url, fetchImpl: async () => { calls++; return Response.json(success(wav())); } }), { code: 'invalid_voice_url' });
  assert.equal(calls, 0);
});

test('redirects, malformed/oversized JSON and streaming overflow never yield transcripts', async () => {
  const data = wav();
  await assert.rejects(client(data, new Response('', { status: 302, headers: { location: 'http://example.test' } })), { code: 'voice_redirect_blocked' });
  const redirected = Response.json(success(data)); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(data, redirected), { code: 'voice_redirect_blocked' });
  await assert.rejects(client(data, new Response('{bad')), { code: 'speech_response_invalid' });
  await assert.rejects(client(data, new Response('{}', { headers: { 'content-length': String(256 * 1024 + 1) } })), { code: 'speech_response_too_large' });
  let cancelled = false;
  const stream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } }));
  await assert.rejects(client(data, stream), { code: 'speech_response_too_large' }); assert.equal(cancelled, true);
});

test('success receipts require correct identity, bounded transcript, finite confidence and local audio metadata', async () => {
  const data = wav(), expected = success(data);
  for (const fields of [{ engine: 'cloud-fallback' }, { transcript: '   ' }, { transcript: 'x'.repeat(12001) }, { transcript: 'bad\0text' }, { confidence: '0.8' }, { confidence: -0.1 }, { confidence: 1.1 }, { confidence: Infinity }, { language: 'invalid language' }, { unknown: 'field' }, { audio: { ...expected.audio, sampleRate: 8000 } }, { audio: { ...expected.audio, channels: 2 } }, { audio: { ...expected.audio, sampleWidth: 1 } }, { audio: { ...expected.audio, durationSeconds: expected.audio.durationSeconds + 2 / 16000 } }]) await assert.rejects(client(data, { ...expected, ...fields }), { code: 'speech_response_invalid' });
  const withinFrame = { ...expected, audio: { ...expected.audio, durationSeconds: expected.audio.durationSeconds + 1 / 16000 } };
  assert.equal((await client(data, withinFrame)).ok, true);
  await assert.rejects(client(data, expected, { language: 'en-GB' }), { code: 'speech_response_invalid' });
});

test('segments validate finite confidence, timing bounds and count without inventing alignment', async () => {
  const data = wav(), expected = success(data);
  for (const segments of [null, Array(1025).fill({ text: 'x', confidence: 1 }), [{ text: '', confidence: 0.5 }], [{ text: 'word', confidence: NaN }], [{ text: 'word', confidence: 0.5, startSeconds: -1 }], [{ text: 'word', confidence: 0.5, durationSeconds: Infinity }], [{ text: 'word', confidence: 0.5, startSeconds: 0.09, durationSeconds: 0.09 }], [{ text: 'word', confidence: 0.5, invented: true }]]) await assert.rejects(client(data, { ...expected, segments }), { code: 'speech_response_invalid' });
  const untimed = success(data, { segments: [{ text: 'hello world', confidence: 0.85 }] }); assert.deepEqual((await client(data, untimed)).segments, untimed.segments);
});

test('backend errors retain known codes/statuses with sanitized messages and never fabricate fallback text', async () => {
  const data = wav();
  for (const [code, status] of [['no_speech', 422], ['language_unavailable', 400], ['recognition_busy', 503], ['recognition_timeout', 504], ['recognition_failed', 502]]) await assert.rejects(client(data, Response.json({ ok: false, code, error: 'SECRET_MUST_NOT_LEAK', transcript: 'fake fallback' }, { status })), error => error.code === code && error.status === status && !error.message.includes('SECRET'));
  await assert.rejects(client(data, Response.json({ ok: false, code: 'SECRET_MUST_NOT_LEAK', error: 'SECRET_MUST_NOT_LEAK' }, { status: 500 })), error => error.code === 'recognition_failed' && !error.message.includes('SECRET'));
  await assert.rejects(transcribeAudio(data, { voiceUrl, fetchImpl: async () => { throw new Error('Authorization: SECRET_MUST_NOT_LEAK'); } }), error => error.code === 'stt_unavailable' && error.status === 503 && !error.message.includes('SECRET'));
  const broken = new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('SECRET_MUST_NOT_LEAK'), { code: 'secret_code', status: 500 })); } }));
  await assert.rejects(client(data, broken), error => error.code === 'recognition_failed' && error.status === 502 && !error.message.includes('SECRET'));
});

test('caller cancellation aborts an uncooperative fetch and pre-aborted requests never send audio', async () => {
  const data = wav(), controller = new AbortController(); let captured, calls = 0;
  const pending = transcribeAudio(data, { voiceUrl, signal: controller.signal, fetchImpl: async (_url, options) => { calls++; captured = options.signal; return new Promise(() => {}); } });
  const assertion = assert.rejects(pending, { code: 'audio_cancelled', status: 499 }); controller.abort(new Error('SECRET cancel reason')); await assertion;
  assert.equal(captured.aborted, true);
  await assert.rejects(transcribeAudio(data, { voiceUrl, signal: controller.signal, fetchImpl: async () => { calls++; } }), { code: 'audio_cancelled' }); assert.equal(calls, 1);
});

test('32-second combined deadline aborts a stalled transport using mocked time', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let captured;
  const pending = transcribeAudio(wav(), { voiceUrl, fetchImpl: async (_url, options) => { captured = options.signal; return new Promise(() => {}); } });
  const assertion = assert.rejects(pending, { code: 'recognition_timeout', status: 504 });
  t.mock.timers.tick(31999); assert.equal(captured.aborted, false);
  t.mock.timers.tick(1); await assertion; assert.equal(captured.aborted, true);
});

test('deadline and caller cancellation also bound a stalled JSON body and cancel its reader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const byCaller of [false, true]) {
    const controller = new AbortController(); let cancelled = false;
    const body = new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from('{"ok":')); }, cancel() { cancelled = true; } }));
    const pending = client(wav(), body, { signal: controller.signal });
    const assertion = assert.rejects(pending, { code: byCaller ? 'audio_cancelled' : 'recognition_timeout' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    if (byCaller) controller.abort(); else t.mock.timers.tick(32000);
    await assertion; assert.equal(cancelled, true);
  }
});
