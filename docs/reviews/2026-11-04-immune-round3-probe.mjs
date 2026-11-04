// Fraynix - By Vaughn Scott
// Independent round-three checks. Synthetic data, mocked fetch, no DB imports.
// node docs/reviews/2026-11-04-immune-round3-probe.mjs [--output relative-path]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { StreamCanaryInterceptor } from '../../server/fraymus/intelligence/stream-canary.js';
import { sanitizeDeep, sanitizeOllamaContent, resetInterceptorStats, getInterceptorStats }
  from '../../server/fraymus/intelligence/ollama-sanitize.js';
import { assertSchema } from '../../server/agent/schema.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const callers = ['agent/provider.js', 'fleet/runtime.js', 'commerce/shared.js', 'creation/shared.js',
  'distribution/shared.js', 'intelligence/strategy.js', 'intelligence/subconscious.js',
  'media/music-engine.js', 'vision/local.js', 'vertiso/rsi.js'].map(path => 'server/' + path);
const files = [...callers, 'server/agent/schema.js', 'server/fraymus-tools.js', 'server/fraymus-routes.js',
  ...['ep3', 'transcoder4d', 'canary', 'stream-canary', 'ollama-sanitize']
    .map(name => `server/fraymus/intelligence/${name}.js`)];
async function hashes() {
  return Object.fromEntries(await Promise.all(files.map(async path => [path,
    createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])));
}
const before = await hashes();
// Retain the existing positive regressions and observe its declared failures.
const priorProbe = JSON.parse(execFileSync(process.execPath,
  ['docs/reviews/2026-11-04-immune-fix-probe.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
assert.ok(priorProbe.remainingStreamFailures.prefixBoundaryCases.every(item => !item.credentialBodyExposed));
assert.equal(priorProbe.remainingStreamFailures.characterFragments.credentialBodyExposed, false);
assert.equal(priorProbe.remainingStreamFailures.benignEof.standardContent, 'books');
assert.equal(priorProbe.workingTreeOllamaBoundary.toolArgumentMarkerExposed, false);
assert.equal(priorProbe.workingTreeOllamaBoundary.structuredContent.parsesAsJson, true);

// Execute the actual fleet chat function in isolation. Loading fleet/runtime.js
// as a module would open the live DB, so take its complete declaration between
// explicit source markers and supply only its fetch/config dependencies.
const fleetSource = (await readFile(resolve(root, 'server/fleet/runtime.js'), 'utf8')).replaceAll('\r\n', '\n');
const start = fleetSource.indexOf('async function chat(messages, tools, model) {');
const end = fleetSource.indexOf('\nfunction addMsg(', start);
assert.ok(start >= 0 && end > start, 'Fleet source markers changed; inspect before rerunning');
const fleetChatSource = fleetSource.slice(start, end).trim();
const marker = 'sk-UNIT_TEST_ONLY_0123456789';
const fleetChat = runInNewContext('(' + fleetChatSource + ')', {
  sanitizeOllamaContent, AbortSignal, OLLAMA_URL: 'http://127.0.0.1:11434', process: { env: {} },
  fetch: async () => Response.json({ message: { content: 'before ' + marker + ' after',
    tool_calls: [{ function: { name: 'synthetic_tool', arguments: { token: marker } } }] } }),
});
const fleetResult = await fleetChat([], [], 'synthetic-local-model');

const originalNow = Date.now;
let now = 1000;
const sentence = 'The local model is ready to process your next request.';
const chunkingCases = [];
let bufferedProviderTelemetry;
try {
  Date.now = () => now;
  for (const [kind, parts] of [['whole', [sentence]], ['words', sentence.match(/\s*\S+/g)], ['characters', [...sentence]]]) {
    const interceptor = new StreamCanaryInterceptor();
    for (const part of parts) { now += 50; interceptor.processToken(part); }
    const state = interceptor.getTriangulation(42);
    chunkingCases.push({ kind, fragmentCount: parts.length, triggered: state.triggered,
      confidence: state.confidence, epsilons: state.epsilons });
  }
  resetInterceptorStats();
  for (let request = 0; request < 20; request++) { now += 50; sanitizeOllamaContent(sentence); }
  const stats = getInterceptorStats();
  bufferedProviderTelemetry = { requests: stats.totalRequests,
    timingSamples: stats.canary.canaries.alpha.sampleCount,
    entropySamples: stats.canary.canaries.beta.sampleCount,
    phaseSamples: stats.canary.canaries.gamma.sampleCount,
    triggered: stats.triangulation.triggered, confidence: stats.triangulation.confidence };
} finally { Date.now = originalNow; }

// Ordinary JSON keys must remain data and must not create inherited arguments.
const protoInput = JSON.parse('{"__proto__":{"syntheticInherited":true},"ok":true}');
const protoOutput = sanitizeDeep(protoInput);
let beforeSchemaError = null;
let afterSchemaError = null;
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
try { assertSchema(protoInput, schema); } catch (error) { beforeSchemaError = error.code; }
try { assertSchema(protoOutput, schema); } catch (error) { afterSchemaError = error.code; }

const nestedWire = '{"child":'.repeat(5000) + JSON.stringify(marker) + '}'.repeat(5000);
const nested = JSON.parse(nestedWire);
let deepError = null;
try { sanitizeDeep(nested); } catch (error) { deepError = { name: error.name, message: error.message }; }

async function completionCase(shape) {
  const first = shape === 'chat' ? { message: { role: 'assistant', content: 'books' }, done: false }
    : { response: 'books', done: false };
  const wire = [first, { done: true }].map(record => Buffer.from(JSON.stringify(record) + '\n'));
  const outputs = [];
  for await (const item of new StreamCanaryInterceptor().interceptStream(Readable.from(wire))) outputs.push(item);
  return { shape, text: outputs.map(item => item.response ?? item.message?.content ?? '').join(''), outputs };
}
const metadataOnlyCompletions = [await completionCase('chat'), await completionCase('generate')];

const callerReferences = [];
for (const file of callers) {
  const source = await readFile(resolve(root, file), 'utf8');
  callerReferences.push({ file, referencesTextSanitizer: source.includes('sanitizeOllamaContent('),
    referencesDeepSanitizer: source.includes('sanitizeDeep(') });
}
const after = await hashes();
const evidence = {
  capturedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version, platform: process.platform,
  method: 'Existing probe plus synthetic in-memory streams, isolated fleet function, deterministic clock and pure helpers; no app import, DB, network or live model',
  sourceSha256: before, sourcesStableDuringProbe: JSON.stringify(before) === JSON.stringify(after),
  priorProbe,
  fleetFunctionIsolation: {
    sourceFunctionSha256: createHash('sha256').update(fleetChatSource).digest('hex'),
    contentMarkerRemoved: !fleetResult.content.includes(marker),
    toolArgumentMarkerExposed: JSON.stringify(fleetResult.tool_calls).includes(marker),
  },
  normalSentenceCanaryChunking: { sentence, cases: chunkingCases },
  bufferedProviderTelemetry,
  recursiveWalker: {
    prototypeChanged: Object.getPrototypeOf(protoOutput) !== Object.prototype,
    syntheticInheritedValue: protoOutput.syntheticInherited,
    ownProtoKeyPreserved: Object.hasOwn(protoOutput, '__proto__'),
    originalInputSchemaError: beforeSchemaError,
    sanitizedInputSchemaError: afterSchemaError,
    serializedOutput: JSON.stringify(protoOutput),
    globalObjectPrototypeUnchanged: Object.prototype.syntheticInherited === undefined,
    deeplyNestedFixture: { depth: 5000, serializedBytes: Buffer.byteLength(nestedWire), error: deepError },
  },
  metadataOnlyCompletions,
  callerReferences,
};
const output = JSON.stringify(evidence, null, 2) + '\n';
const index = process.argv.indexOf('--output');
if (index !== -1) {
  assert.ok(process.argv[index + 1], '--output requires a path');
  await writeFile(resolve(root, process.argv[index + 1]), output);
}
process.stdout.write(output);
