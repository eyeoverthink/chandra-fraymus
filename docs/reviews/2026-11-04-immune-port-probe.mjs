// Fraynix - By Vaughn Scott
// Review probe: synthetic data and pure modules only. Never imports the app or DB.
// Run: node docs/reviews/2026-11-04-immune-port-probe.mjs [--output path]
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const moduleNames = ['ep3', 'transcoder4d', 'canary', 'stream-canary'];
const sourcePaths = moduleNames.map(name => `server/fraymus/intelligence/${name}.js`)
  .concat(['server/fraymus-tools.js', 'server/fraymus-routes.js']);
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path,
    createHash('sha256').update(await readFile(resolve(root, path))).digest('hex')])));
}
const before = await sourceHashes();
const ep3 = await import(new URL('../../server/fraymus/intelligence/ep3.js', import.meta.url));
const transcoder = await import(new URL('../../server/fraymus/intelligence/transcoder4d.js', import.meta.url));
const { StreamCanaryInterceptor } = await import(new URL('../../server/fraymus/intelligence/stream-canary.js', import.meta.url));

// Check the actual separable byte bijection over all 256 inputs in each coordinate.
let coordinateByteChecks = 0;
for (let coordinate = 0; coordinate < 4; coordinate++) {
  const outputs = new Set();
  for (let value = 0; value < 256; value++) {
    const input = new Uint8Array(4);
    input[coordinate] = value;
    const encoded = transcoder.transmute4ByteSecret('synthetic', input, 0x5a, 0x11);
    outputs.add(encoded.coord4D[coordinate]);
    assert.deepEqual(transcoder.reconstructSecret(encoded.coord4D, 0x5a, 0x11), input);
    coordinateByteChecks++;
  }
  assert.equal(outputs.size, 256);
}

const dummy = 'sk-UNIT_TEST_ONLY_0123456789';
const sanitized = transcoder.sanitizeStreamText(`before ${dummy} after`);
let prefixOnlyError = null;
try { transcoder.sanitizeStreamText('sk-'); }
catch (error) { prefixOnlyError = error.message; }

async function splitStream(split) {
  const interceptor = new StreamCanaryInterceptor();
  const wire = [dummy.slice(0, split), dummy.slice(split)].map(response =>
    Buffer.from(JSON.stringify({ response }) + '\n'));
  let reconstructed = '';
  try {
    for await (const output of interceptor.interceptStream(Readable.from(wire))) {
      reconstructed += output.response ?? output.raw ?? '';
    }
    return { split, outputContainsDummy: reconstructed.includes(dummy), redactions: interceptor.totalRedactions };
  } catch (error) {
    return { split, error: error.message, redactions: interceptor.totalRedactions };
  }
}
const streamSplitCases = [];
for (let split = 1; split < dummy.length; split++) streamSplitCases.push(await splitStream(split));

const epsilon = 1e-6;
const evaluation = ep3.evaluateEp3Sensor(1, epsilon);
const r = Math.cbrt(epsilon);
const expectedComplexRoots = [
  { real: r, imaginary: 0 },
  { real: -r / 2, imaginary: r * Math.sqrt(3) / 2 },
  { real: -r / 2, imaginary: -r * Math.sqrt(3) / 2 },
];
for (const { real: a, imaginary: b } of expectedComplexRoots) {
  const residual = Math.hypot(a ** 3 - 3 * a * b ** 2 - epsilon, 3 * a ** 2 * b - b ** 3) / epsilon;
  assert.ok(residual < 1e-12);
}
const benign = new StreamCanaryInterceptor();
benign.processToken('hello');
const benignTriangulation = benign.getTriangulation(42);
const after = await sourceHashes();
const evidence = {
  capturedAt: new Date().toISOString(),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  node: process.version,
  platform: process.platform,
  method: 'Direct pure-module calls with synthetic marker and in-memory NDJSON; no real secret, model, database or app mutation',
  sourceSha256: before,
  sourcesStableDuringProbe: JSON.stringify(before) === JSON.stringify(after),
  byteBijection: { passed: true, coordinateByteChecks },
  redactor: {
    sanitizedContainsDummy: sanitized.sanitized.includes(dummy),
    returnedMetadataContainsDummy: JSON.stringify(sanitized).includes(dummy),
    prefixOnlyError,
  },
  stream: { splitAtTwo: streamSplitCases.find(item => item.split === 2), streamSplitCases },
  ep3: {
    amplification: evaluation.amplification,
    reportedEigenvalues: evaluation.eigenvalues,
    relativeCubicResiduals: evaluation.eigenvalues.map(value => (value ** 3 - epsilon) / epsilon),
    expectedComplexRoots,
    zeroResidualQuantized: ep3.evaluateEp3Sensor(1, 0).quantized8bit,
    quantizedAtOneEMinus10: ep3.evaluateEp3Sensor(1, 1e-10).quantized8bit,
    degenerateWithZeroCoupling: ep3.evaluateEp3Sensor(0, 0).degenerate,
  },
  benignCanary: {
    triggered: benignTriangulation.triggered,
    confidence: benignTriangulation.confidence,
    dominant: benignTriangulation.dominant,
  },
};
const json = JSON.stringify(evidence, null, 2) + '\n';
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1) {
  assert.ok(process.argv[outputIndex + 1], '--output requires a path');
  await writeFile(resolve(root, process.argv[outputIndex + 1]), json);
}
process.stdout.write(json);
