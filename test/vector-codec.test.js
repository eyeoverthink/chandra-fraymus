import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeVectors, decodeVectors, vectorPayloadSizes } from '../server/retrieval/vector-codec.js';
import { encodeRgbaPng, decodeRgbaPng } from '../server/transport/rgba.js';

function reseal(data) { createHash('sha256').update(data.subarray(0,32)).update(data.subarray(64)).digest().copy(data,32); return data; }
function bits(vector) { const result = Buffer.alloc(vector.length * 4); for (let i = 0; i < vector.length; i++) result.writeFloatLE(vector[i], i * 4); return result; }

test('default Float32 framing is deterministic, explicit LE and byte-exact including signed zero', () => {
  const vector = new Float32Array([-0, 0, 1 / 3, -3.4028234663852886e38, 1.401298464324817e-45]), encoded = encodeVectors([vector]);
  assert.equal(encoded.format, 'float32'); assert.equal(encoded.headerBytes, 64); assert.equal(encoded.dimensions, 5); assert.equal(encoded.payloadBytes, 20); assert.equal(encoded.scaleBytes, 0);
  assert.equal(encoded.losslessFloat32, true); assert.equal(encoded.normalizedByCodec, false); assert.ok(encoded.data.subarray(64).equals(bits(vector)));
  const decoded = decodeVectors(encoded.data); assert.ok(bits(decoded.vectors[0]).equals(bits(vector))); assert.ok(Object.is(decoded.vectors[0][0], -0));
  assert.ok(encodeVectors([decoded.vectors[0]]).data.equals(encoded.data)); assert.ok(encodeVectors([vector]).data.equals(encoded.data));
  const rounded = decodeVectors(encodeVectors([[1 / 3]]).data).vectors[0][0]; assert.equal(rounded, Math.fround(1 / 3)); assert.notEqual(rounded, 1 / 3);
});

test('adaptive signed8 RGBA groups store Float32 scales, exact numeric zero and explicit zero padding', () => {
  const vectors = [new Float32Array([0, -0, .001, -.001, .000321]), new Float32Array(5)], encoded = encodeVectors(vectors, { format: 'signed8-rgba' });
  assert.equal(encoded.paddedDimensions, 8); assert.equal(encoded.paddingPerVector, 3); assert.equal(encoded.paddingComponents, 6); assert.equal(encoded.scaleBytes, 8);
  assert.equal(encoded.payloadBytes, 24); assert.equal(encoded.payloadRgbaPixels, 6); assert.equal(encoded.losslessFloat32, false); assert.equal(encoded.signedZeroPreserved, false);
  assert.equal(encoded.data.readFloatLE(64), Math.fround(.001)); assert.equal(encoded.data[68], 128); assert.equal(encoded.data[69], 128);
  assert.deepEqual([...encoded.data.subarray(73,76)], [128,128,128]); assert.equal(encoded.data.readFloatLE(76), 0);
  const decoded = decodeVectors(encoded.data); assert.equal(decoded.vectors[0][0], 0); assert.equal(decoded.vectors[0][1], 0); assert.deepEqual([...decoded.vectors[1]], [0,0,0,0,0]);
  for (let row = 0; row < vectors.length; row++) { const scale = Math.max(...vectors[row].map(Math.abs)); for (let i = 0; i < vectors[row].length; i++) assert.ok(Math.abs(vectors[row][i] - decoded.vectors[row][i]) <= scale / 254 + scale * 2 ** -23 + 2 ** -149); }
});

test('adaptive error is bounded across unequal magnitudes without applying hidden normalization', () => {
  let seed = 0x12345678; const random = () => { seed = (Math.imul(seed,1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const vectors = Array.from({ length: 32 }, (_, row) => Float32Array.from({ length: 257 }, () => (random() * 2 - 1) * 10 ** ((row % 9) - 4)));
  const encoded = encodeVectors(vectors, { format: 'signed8-rgba' }), decoded = decodeVectors(encoded.data);
  for (let row = 0; row < vectors.length; row++) { const scale = Math.max(...vectors[row].map(Math.abs)); for (let i = 0; i < vectors[row].length; i++) assert.ok(Math.abs(vectors[row][i] - decoded.vectors[row][i]) <= scale / 254 + scale * 2 ** -23 + 2 ** -149); }
  assert.ok(Math.abs(Math.hypot(...decoded.vectors[0]) - 1) > .1); assert.equal(decoded.normalizedByCodec, false);
});

test('payload sizing includes scale/header/padding costs and rejects invalid or excessive arrays', () => {
  const sizes = vectorPayloadSizes(256, 4096); assert.equal(sizes.float32.payloadBytes, 4 * 1024 * 1024); assert.equal(sizes.signed8Rgba.payloadBytes, 1024 * 1024 + 1024);
  assert.equal(vectorPayloadSizes(1, 3).signed8Rgba.totalBytes, 72);
  assert.equal(vectorPayloadSizes(1023, 1025).signed8Rgba.paddingComponents, 3069);
  const sparse = [1,,3];
  for (const vectors of [[], [[]], new Array(2), [[1], [1,2]], [[NaN]], [[Infinity]], [[1e39]], [sparse], [new Uint8Array([1,2])], new Array(1025).fill([1])]) assert.throws(() => encodeVectors(vectors), { code: 'vector_codec_invalid' });
  for (const args of [[0,1],[1,0],[1,4097],[1025,1],[1024,4096]]) assert.throws(() => vectorPayloadSizes(...args), { code: 'vector_codec_invalid' });
  assert.throws(() => encodeVectors([[1]], { dimensions: 1 }), { code: 'vector_codec_invalid' });
  assert.throws(() => encodeVectors([[1]], { format: null }), { code: 'vector_codec_invalid' });
});

test('strict header, checksum and extent validation rejects mutations rather than reshaping vectors', () => {
  const original = encodeVectors([[1,2,3]]).data;
  for (const mutate of [data => { data[0] ^= 1; }, data => { data[8] = 2; }, data => { data[9] = 5; }, data => data.writeUInt16LE(32,10), data => data.writeUInt32LE(0,12),
    data => data.writeUInt32LE(4097,16), data => data.writeUInt32LE(4,20), data => data.writeUInt32LE(99,24), data => data.writeUInt32LE(1,28), data => { data[64] ^= 1; }]) {
    const data = Buffer.from(original); mutate(data); assert.throws(() => decodeVectors(data), { code: 'vector_codec_invalid' });
  }
  for (const data of [Buffer.alloc(0), original.subarray(0,-1), Buffer.concat([original,Buffer.from([0])]), [1,2,3]]) assert.throws(() => decodeVectors(data), { code: 'vector_codec_invalid' });
  const parent = Buffer.concat([Buffer.alloc(3),original,Buffer.alloc(2)]); assert.deepEqual([...decodeVectors(parent.subarray(3,-2)).vectors[0]], [1,2,3]);
});

test('recomputed checksums cannot legitimize nonfinite floats, invalid scales, signed8 ranges or padding', () => {
  for (const value of [0x7fc00000,0x7f800000,0xff800000]) { const data = Buffer.from(encodeVectors([[1]]).data); data.writeUInt32LE(value,64); reseal(data); assert.throws(() => decodeVectors(data), { code: 'vector_codec_invalid' }); }
  const base = encodeVectors([[1,0,0]], { format: 'signed8-rgba' }).data;
  for (const mutate of [data => data.writeFloatLE(-1,64), data => data.writeFloatLE(-0,64), data => data.writeFloatLE(NaN,64), data => { data[68] = 0; },
    data => { data[71] = 127; }, data => data.writeFloatLE(0,64), data => { data[68] = 128; }]) {
    const data = Buffer.from(base); mutate(data); reseal(data); assert.throws(() => decodeVectors(data), { code: 'vector_codec_invalid' });
  }
});

test('RGBA PNG carriers preserve framed bytes; decoded arrays and caller vectors cannot mutate stored payload', () => {
  for (const format of ['float32','signed8-rgba']) {
    const original = new Float32Array([-.3, 0, .7, 1, .2]), encoded = encodeVectors([original], { format }), before = Buffer.from(encoded.data); original[0] = 999;
    assert.ok(encoded.data.equals(before)); const carrier = encodeRgbaPng(encoded.data, { compression: 'none' }), restored = decodeRgbaPng(carrier.png).data;
    assert.ok(restored.equals(before)); const decoded = decodeVectors(restored); assert.equal(decoded.format, format); decoded.vectors[0][0] = -999; assert.ok(restored.equals(before));
  }
});
