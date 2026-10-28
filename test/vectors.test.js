import test from 'node:test';
import assert from 'node:assert/strict';
import { packFloat32XYZW, unpackFloat32XYZW, quantizeXYZWToRGBA, decodeRGBAToXYZW, vectorBenchmark } from '../server/transport/vectors.js';

test('Float32 XYZW little-endian round trip retains finite bit patterns and signed zero', () => {
  const bits = [0x00000000, 0x80000000, 0x3f800000, 0xbf800000, 0x00000001, 0x80000001, 0x7f7fffff, 0xff7fffff];
  const source = Buffer.alloc(bits.length * 4); bits.forEach((value, index) => source.writeUInt32LE(value, index * 4));
  const values = unpackFloat32XYZW(source);
  assert.ok(Object.is(values[0], 0)); assert.ok(Object.is(values[1], -0));
  const packed = packFloat32XYZW(values);
  assert.deepEqual(packed, source);
  assert.equal(packed.readUInt32LE(4), 0x80000000); assert.deepEqual([...packed.subarray(8, 12)], [0, 0, 128, 63]);
  const offsetBuffer = Buffer.concat([Buffer.of(1), source, Buffer.of(2)]);
  assert.deepEqual(packFloat32XYZW(unpackFloat32XYZW(offsetBuffer.subarray(1, -1))), source);
});

test('JS doubles undergo explicit Float32 rounding before lossless Float32 byte transport', () => {
  const values = [Math.PI, 1 / 3, -0, Number.MIN_VALUE];
  const decoded = unpackFloat32XYZW(packFloat32XYZW(values));
  decoded.forEach((value, index) => assert.ok(Object.is(value, Math.fround(values[index]))));
  assert.notEqual(decoded[0], values[0]); assert.ok(Object.is(decoded[2], -0)); assert.equal(decoded[3], 0);
});

test('uint8 RGBA numerical quantization stays within half a grid step without clipping', () => {
  const input = Array.from({ length: 4096 }, (_, i) => -1 + (2 * i / 4095));
  input[0] = -1; input[1] = 1; input[2] = 0; input[3] = -0;
  const encoded = quantizeXYZWToRGBA(input), decoded = decodeRGBAToXYZW(encoded);
  assert.equal(encoded.length, input.length); assert.equal(encoded[0], 0); assert.equal(encoded[1], 255);
  assert.equal(decoded[0], -1); assert.equal(decoded[1], 1); assert.equal(encoded[2], 128); assert.equal(encoded[3], 128);
  input.forEach((value, index) => assert.ok(Math.abs(value - decoded[index]) <= 1 / 255 + 1e-12));
  assert.notEqual(decoded[2], 0); assert.ok(!Object.is(decoded[3], -0));
  assert.equal(packFloat32XYZW(input).length / encoded.length, 4);
});

test('all vector helpers reject malformed, sparse, unbounded, nonfinite and wrong-range input', () => {
  for (const input of [[], [1, 2, 3], [1, 2, 3, NaN], [1, 2, 3, Infinity], [1, 2, 3, -Infinity], [1, 2, 3, 1e40], [1, 2, 3, '4'], [1, 2, 3, true], new Array(4), new Array(16388).fill(0), new DataView(new ArrayBuffer(16)), new BigInt64Array(4)]) assert.throws(() => packFloat32XYZW(input));
  for (const input of [[-1.01, 0, 0, 0], [0, 0, 0, 1.01], [0, 0, 0, NaN]]) assert.throws(() => quantizeXYZWToRGBA(input));
  for (const input of [[], Buffer.alloc(15), Buffer.alloc(65552), [0, 0, 0, -1], new Float32Array(4), [0, 0, 0, 256], new Array(16)]) assert.throws(() => unpackFloat32XYZW(input));
  for (const input of [Buffer.alloc(3), Buffer.alloc(16388), [0, 1, 2, NaN], new Array(4)]) assert.throws(() => decodeRGBAToXYZW(input));
  for (const bits of [0x7f800000, 0xff800000, 0x7fc00001]) {
    const bytes = Buffer.alloc(16); bytes.writeUInt32LE(bits); assert.throws(() => unpackFloat32XYZW(bytes), /non-finite/);
  }
});

test('deterministic benchmark separates rounding, quantization and exact PNG transport', () => {
  const result = vectorBenchmark();
  assert.deepEqual(result, vectorBenchmark());
  assert.equal(result.fixture.dimensions, 4); assert.equal(result.fixture.vectors, 256);
  assert.equal(result.sizes.float32.rawBytes, 256 * 16); assert.equal(result.sizes.uint8Rgba.rawBytes, 256 * 4);
  assert.equal(result.sizes.rawNumericalReductionFactor, 4); assert.equal(result.sizes.float32.payloadRgbaPixels, 1024);
  assert.equal(result.sizes.uint8Rgba.payloadRgbaPixels, 256);
  for (const entry of [result.sizes.float32, result.sizes.uint8Rgba]) {
    assert.equal(entry.pngByteExact, true);
    for (const field of ['gzipBytes', 'brotliBytes', 'pngCarrierBytes']) assert.ok(Number.isInteger(entry[field]) && entry[field] > 0);
    assert.ok(entry.carrierTotalPixels >= entry.payloadRgbaPixels);
  }
  assert.ok(result.sourceDoubleToFloat32.maxAbsComponentError > 0);
  assert.ok(result.sourceDoubleToFloat32.maxAbsComponentError < result.quantization.maxAbsComponentError);
  assert.ok(result.quantization.withinComponentErrorBound); assert.ok(result.quantization.maxAbsComponentError <= 1 / 255 + 1e-12);
  const angles = result.quantization.angularErrorDegrees;
  assert.ok(angles.mean >= 0 && angles.p95 >= angles.mean && angles.max >= angles.p95 && angles.max < 2);
  for (const entry of Object.values(result.nearestNeighbor)) {
    assert.ok(entry.top1Agreement >= 0 && entry.top1Agreement <= 1);
    assert.equal(entry.top1Matches + entry.top1Disagreements, entry.queries);
  }
  assert.equal(result.nearestNeighbor.all.queries, 640);
  assert.equal(result.nearestNeighbor.all.top1Matches, result.nearestNeighbor.noisyOriginals.top1Matches + result.nearestNeighbor.heldoutDirections.top1Matches);
  assert.match(result.semantics, /discarding numerical precision/); assert.ok(result.caveats.some(value => value.includes('tokenizer')));
});
