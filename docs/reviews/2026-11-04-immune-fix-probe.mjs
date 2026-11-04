// Fraynix - By Vaughn Scott
// Follow-up review: pure-module tests, synthetic secrets, no DB/server imports.
// node docs/reviews/2026-11-04-immune-fix-probe.mjs [--output relative-path]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourcePaths = ['ep3', 'transcoder4d', 'canary', 'stream-canary']
  .map(name => `server/fraymus/intelligence/${name}.js`)
  .concat(['server/fraymus-tools.js', 'server/fraymus-routes.js',
    'server/commerce/shared.js', 'server/fleet/runtime.js', 'server/agent/provider.js',
    'server/creation/shared.js', 'server/distribution/shared.js',
    'server/fraymus/intelligence/ollama-sanitize.js']);
async function hashes() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => {
    try { return [path, createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')]; }
    catch (error) {
      if (error.code === 'ENOENT') return [path, null];
      throw error;
    }
  })));
}
const before = await hashes();
const { evaluateEp3Sensor } = await import(new URL('../../server/fraymus/intelligence/ep3.js', import.meta.url));
const { SECRET_PREFIXES, sanitizeStreamText, transmute4ByteSecret, reconstructSecret }
  = await import(new URL('../../server/fraymus/intelligence/transcoder4d.js', import.meta.url));
const { StreamCanaryInterceptor } = await import(new URL('../../server/fraymus/intelligence/stream-canary.js', import.meta.url));

let byteChecks = 0;
for (let coordinate = 0; coordinate < 4; coordinate++) {
  const distinct = new Set();
  for (let value = 0; value < 256; value++) {
    const input = new Uint8Array(4);
    input[coordinate] = value;
    const encoded = transmute4ByteSecret('test-only', input, 0x5a, 0x11);
    distinct.add(encoded.coord4D[coordinate]);
    assert.deepEqual(reconstructSecret(encoded.coord4D, 0x5a, 0x11), input);
    byteChecks++;
  }
  assert.equal(distinct.size, 256);
}
const payload = 'UNIT_TEST_ONLY_0123456789';
const complete = sanitizeStreamText(`before sk-${payload} after`);
assert.ok(!JSON.stringify(complete).includes(`sk-${payload}`));
const partialPrefix = sanitizeStreamText('sk-');
assert.equal(partialPrefix.redactionCount, 1);

async function intercept(records) {
  const instance = new StreamCanaryInterceptor();
  const outputs = [];
  const chunks = records.map(item => Buffer.from(JSON.stringify(item) + '\n'));
  for await (const output of instance.interceptStream(Readable.from(chunks))) outputs.push(output);
  return { outputs, redactions: instance.totalRedactions };
}
const prefixBoundaryCases = [];
for (const prefix of SECRET_PREFIXES) {
  const result = await intercept([{ response: prefix }, { response: payload }, { response: ' after', done: true }]);
  const standardText = result.outputs.map(item => item.response ?? item.message?.content ?? '').join('');
  prefixBoundaryCases.push({ prefix, redactions: result.redactions,
    credentialBodyExposed: standardText.includes(payload), output: standardText });
}
const splitPrefix = await intercept([{ response: 'sk' }, { response: '-' + payload, done: true }]);
const fullSplitText = splitPrefix.outputs.map(item => item.response ?? '').join('');
const fragmentByCharacter = await intercept(Array.from('sk-' + payload).map(response => ({ response })));
const characterText = fragmentByCharacter.outputs.map(item => item.response ?? '').join('');
const benignEof = await intercept([
  { message: { role: 'assistant', content: 'books' }, done: false },
  { message: { role: 'assistant', content: '' }, done: true },
]);
const eofStandardText = benignEof.outputs.map(item => item.message?.content ?? item.response ?? '').join('');

const epsilon = 1e-6;
const ep3 = evaluateEp3Sensor(1, epsilon);
const cubicResiduals = ep3.eigenvalues.map(({ re: a, im: b }) =>
  Math.hypot(a ** 3 - 3 * a * b ** 2 - epsilon, 3 * a ** 2 * b - b ** 3) / epsilon);
assert.ok(cubicResiduals.every(value => Number.isFinite(value) && value < 1e-12));
const quantizer = [0, 1e-12, 1e-10, 1e-8, 1e-6, 1e-4, 1e-2, 1].map(epsilon => ({
  epsilon, output: evaluateEp3Sensor(1, epsilon).quantized8bit,
}));
assert.equal(quantizer[0].output, 0);
assert.ok(quantizer.every((item, index) => index === 0 || item.output >= quantizer[index - 1].output));
assert.ok(quantizer.slice(2, -1).every(item => item.output > 0 && item.output < 255));

const originalNow = Date.now;
let fakeNow = 1000;
const benignSamples = [];
try {
  // Timing is exactly the code's expected 50 ms, so the entropy/phase policy
  // can be examined without machine load or scheduler jitter affecting it.
  Date.now = () => fakeNow;
  const instance = new StreamCanaryInterceptor();
  for (let token = 1; token <= 8; token++) {
    fakeNow += 50;
    instance.processToken('hello');
    const state = instance.getTriangulation(42);
    benignSamples.push({ tokens: token, totalSamples: state.totalSamples,
      triggered: state.triggered, confidence: state.confidence,
      dominant: state.dominant, epsilons: state.epsilons });
  }
} finally { Date.now = originalNow; }

// The provider/config/thinking modules below have no DB imports. All HTTP is
// replaced by injected fetch or this process's temporary fetch stub.
let boundary = { available: false, reason: 'Working-tree ollama-sanitize.js is absent; core caca6bc checks still ran' };
if (before['server/fraymus/intelligence/ollama-sanitize.js']) {
const { createOllamaProvider } = await import(new URL('../../server/agent/provider.js', import.meta.url));
const { sanitizeOllamaContent, getInterceptorStats, resetInterceptorStats }
  = await import(new URL('../../server/fraymus/intelligence/ollama-sanitize.js', import.meta.url));
const marker = 'sk-' + payload;
const requests = [];
const provider = createOllamaProvider({ url: 'http://127.0.0.1:11434', fetchImpl: async (url, options) => {
  requests.push({ pathname: new URL(url).pathname, body: JSON.parse(options.body) });
  if (url.endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools'] });
  return Response.json({ message: { content: 'before ' + marker + ' after',
    tool_calls: [{ function: { name: 'synthetic_tool', arguments: { token: marker } } }] },
  done: true, prompt_eval_count: 3, eval_count: 5, done_reason: 'stop' });
} });
resetInterceptorStats();
const providerResult = await provider.chat({ model: 'synthetic-local-model', messages: [],
  maxOutputTokens: 16, maxInputTokens: 1024 });
assert.ok(!providerResult.message.content.includes(marker));
assert.deepEqual(providerResult.usage, { inputTokens: 3, outputTokens: 5, costUsd: 0 });
const originalStructured = JSON.stringify({ token: marker, ok: true });
const sanitizedStructured = sanitizeOllamaContent(originalStructured);
let structuredParseError = null;
try { JSON.parse(sanitizedStructured); } catch (error) { structuredParseError = error.message; }
const stats = getInterceptorStats();

const originalFetch = globalThis.fetch;
const helperResults = [];
try {
  globalThis.fetch = async () => Response.json({ message: { content: 'before ' + marker + ' after' } });
  for (const folder of ['commerce', 'creation']) {
    const { chatOllama } = await import(new URL(`../../server/${folder}/shared.js`, import.meta.url));
    const content = await chatOllama([]);
    helperResults.push({ folder, contentMarkerRemoved: !content.includes(marker) });
    assert.ok(!content.includes(marker));
  }
} finally { globalThis.fetch = originalFetch; }
boundary = {
  available: true,
  contentMarkerRemoved: !providerResult.message.content.includes(marker),
  toolArgumentMarkerExposed: JSON.stringify(providerResult.message.tool_calls).includes(marker),
  usagePreserved: providerResult.usage,
  requestedStream: requests.find(item => item.pathname === '/api/chat').body.stream,
  structuredContent: { original: originalStructured, sanitized: sanitizedStructured,
    parsesAsJson: structuredParseError === null, parseError: structuredParseError },
  completedTimingSamplesAfterTwoSanitizations: stats.canary.canaries.alpha.sampleCount,
  helperResults,
};
}

const after = await hashes();
const evidence = {
  capturedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  platform: process.platform, node: process.version,
  method: 'Synthetic NDJSON and mocked provider fetch; deterministic 50ms clock only within this disposable probe process; no DB, app, network, or live model',
  sourceSha256: before,
  sourcesStableDuringProbe: JSON.stringify(before) === JSON.stringify(after),
  confirmedCorrections: {
    byteChecks, plaintextMarkerAbsentFromWholeSanitizerResult: true,
    shortPrefixNoLongerThrows: true,
    actualComplexRootRelativeResiduals: cubicResiduals, quantizer,
    originalSplitAfterSkMarkerRemoved: !fullSplitText.includes('sk-' + payload),
  },
  remainingStreamFailures: {
    prefixBoundaryCases,
    characterFragments: { credentialBodyExposed: characterText.includes(payload), output: characterText },
    benignEof: { original: 'books', standardContent: eofStandardText, records: benignEof.outputs },
  },
  benignCanaryAtExpectedTiming: benignSamples,
  workingTreeOllamaBoundary: boundary,
};
const output = JSON.stringify(evidence, null, 2) + '\n';
const index = process.argv.indexOf('--output');
if (index !== -1) {
  assert.ok(process.argv[index + 1], '--output requires a path');
  await writeFile(resolve(root, process.argv[index + 1]), output);
}
process.stdout.write(output);
