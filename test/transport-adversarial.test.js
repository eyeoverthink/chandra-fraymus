import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  encodeRgbaPng, decodeRgbaPng, packetize, recoverPackets, crc32,
} from '../server/transport/rgba.js';
import { spectrum, transportBenchmark } from '../server/extension-tools.js';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxBytes = 8 * 1024 * 1024;

function pngChunk(type, data) {
  const tag = Buffer.isBuffer(type) ? type : Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  tag.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8);
  return result;
}

function pngParts(png) {
  const parts = [];
  for (let position = 8; position < png.length;) {
    const size = png.readUInt32BE(position);
    parts.push({ type: png.subarray(position + 4, position + 8),
      data: png.subarray(position + 8, position + 8 + size) });
    position += size + 12;
  }
  return parts;
}

function rebuild(parts) {
  return Buffer.concat([signature, ...parts.map(part => pngChunk(part.type, part.data))]);
}

function mutateRaster(png, mutate) {
  const parts = pngParts(png);
  const idat = parts.find(part => part.type.equals(Buffer.from('IDAT')));
  const raster = inflateSync(idat.data);
  mutate(raster);
  idat.data = deflateSync(raster);
  return rebuild(parts);
}

function seededBytes(length) {
  let state = 0x76543210;
  return Buffer.from(Array.from({ length }, () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return state & 255;
  }));
}

test('adversarial byte roundtrips cover row/shard boundaries and all encoding modes', () => {
  for (const size of [0, 1, 13, 49, 50, 63, 64, 65, 255, 256, 257, 1023, 1024, 1025, 4097]) {
    const input = seededBytes(size);
    for (const width of [1, 7, 64, 1024]) {
      for (const compression of ['none', 'brotli', 'auto']) {
        assert.deepEqual(decodeRgbaPng(encodeRgbaPng(input, { width, compression }).png).data, input);
      }
    }
  }
});

test('maximum supported payload roundtrips; payload above the bound is rejected', () => {
  const input = Buffer.alloc(maxBytes, 0xa5);
  assert.deepEqual(decodeRgbaPng(encodeRgbaPng(input, { width: 1024, compression: 'none' }).png).data, input);
  assert.throws(() => encodeRgbaPng(Buffer.alloc(maxBytes + 1), { compression: 'none' }));
  assert.throws(() => packetize(Buffer.alloc(maxBytes + 1)));
});

test('float32 bit patterns including signed zero, infinities and NaN payloads survive as bytes', () => {
  const bits = Buffer.from('00000000000000800000803f0000807f000080ff0100c07f0100807f', 'hex');
  for (const compression of ['none', 'brotli', 'auto']) {
    assert.deepEqual(decodeRgbaPng(encodeRgbaPng(bits, { compression }).png).data, bits);
  }
  const packets = packetize(bits, { shardBytes: 64, dataPerGroup: 2 });
  assert.deepEqual(recoverPackets({ ...packets, frames: packets.frames.filter(frame => frame.type === 'parity') }).data, bits);
});

test('non-byte typed views are rejected or preserve raw byte ranges, never silently truncate', () => {
  const backing = new ArrayBuffer(32);
  const floatView = new Float32Array(backing, 4, 4);
  floatView.set([0.1, Math.PI, -1, Infinity]);
  for (const input of [floatView, new DataView(backing, 4, 16), new Uint16Array(backing, 4, 8)]) {
    const expected = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    for (const [encode, decode] of [
      [encodeRgbaPng, result => decodeRgbaPng(result.png).data],
      [packetize, result => recoverPackets(result).data],
    ]) {
      let result;
      try { result = encode(input); }
      catch (error) {
        assert.match(error.message, /byte|input|type|view|buffer/i);
        continue;
      }
      assert.deepEqual(decode(result), expected);
    }
  }
});

test('UTF-8 normalization stays distinct and arbitrary invalid UTF-8 still roundtrips as bytes', () => {
  const composed = Buffer.from('é φ 日本語 🧠');
  const decomposed = Buffer.from('e\u0301 φ 日本語 🧠');
  assert.notDeepEqual(composed, decomposed);
  for (const input of [composed, decomposed, Buffer.from([0xff, 0xfe, 0xc0, 0x80, 0xed, 0xa0, 0x80, 0])]) {
    assert.deepEqual(decodeRgbaPng(encodeRgbaPng(input).png).data, input);
  }
});

test('PNG checks both outer CRC and inner content hash after valid outer reconstruction', () => {
  const original = encodeRgbaPng(Buffer.from('content checksum must fail'), { compression: 'none' }).png;
  const badCrc = Buffer.from(original);
  badCrc[29] ^= 1;
  assert.throws(() => decodeRgbaPng(badCrc), /CRC/);
  const badContent = mutateRaster(original, raster => { raster[51] ^= 1; });
  assert.throws(() => decodeRgbaPng(badContent), /checksum/);
});

test('PNG rejects malformed declared lengths, versions, filters and dimensions with valid CRCs', () => {
  const original = encodeRgbaPng(Buffer.from('bounded packet'), { compression: 'none' }).png;
  assert.throws(() => decodeRgbaPng(mutateRaster(original, raster => { raster.writeUInt32BE(maxBytes + 1, 11); })), /bounds/);
  assert.throws(() => decodeRgbaPng(mutateRaster(original, raster => { raster.writeUInt32BE(0xffffffff, 15); })), /bounds/);
  assert.throws(() => decodeRgbaPng(mutateRaster(original, raster => { raster[9] = 99; })), /packet/i);
  assert.throws(() => decodeRgbaPng(mutateRaster(original, raster => { raster[0] = 1; })), /filter/);
  const parts = pngParts(original);
  parts[0].data = Buffer.from(parts[0].data);
  parts[0].data.writeUInt32BE(0xffffffff, 4);
  assert.throws(() => decodeRgbaPng(rebuild(parts)), /dimensions/);
});

test('PNG inflate output is bounded by declared dimensions', () => {
  const parts = pngParts(encodeRgbaPng(Buffer.alloc(2048), { compression: 'none' }).png);
  parts[0].data = Buffer.from(parts[0].data);
  parts[0].data.writeUInt32BE(1);
  parts[0].data.writeUInt32BE(1, 4);
  assert.throws(() => decodeRgbaPng(rebuild(parts)), /large|length|buffer|size/i);
});

test('PNG chunk tags reject high-bit aliases even when CRC is recomputed', () => {
  const parts = pngParts(encodeRgbaPng(Buffer.from('tag check')).png);
  parts[0].type = Buffer.from(parts[0].type.map(byte => byte | 0x80));
  assert.throws(() => decodeRgbaPng(rebuild(parts)), /chunk|header|type|tag/i);
});

test('PNG IDAT rejects bytes trailing the complete zlib stream', () => {
  const parts = pngParts(encodeRgbaPng(Buffer.from('trailing stream bytes')).png);
  const idat = parts.find(part => part.type.equals(Buffer.from('IDAT')));
  idat.data = Buffer.concat([idat.data, Buffer.from('trailing junk')]);
  assert.throws(() => decodeRgbaPng(rebuild(parts)), /trailing|stream|length|data/i);
});

test('inner Brotli packet rejects trailing junk even when stored length and outer CRC agree', () => {
  const original = encodeRgbaPng(Buffer.from('trailing Brotli check'), { compression: 'brotli' }).png;
  const changed = mutateRaster(original, raster => {
    // Width 64 places this short packet wholly in the first scanline after its filter byte.
    const stored = raster.readUInt32BE(15);
    raster.write('JUNK', 51 + stored);
    raster.writeUInt32BE(stored + 4, 15);
  });
  assert.throws(() => decodeRgbaPng(changed), /trailing|stream|length|data|Brotli/i);
});

test('one erasure per group survives ordering changes, including the partial final group', () => {
  const input = seededBytes(64 * 9 + 13);
  const packet = packetize(input, { shardBytes: 64, dataPerGroup: 4 });
  const frames = packet.frames.filter(frame => frame.type !== 'data' || ![2, 7, 9].includes(frame.index)).reverse();
  const result = recoverPackets({ ...packet, frames });
  assert.deepEqual(result.data, input);
  assert.equal(result.recoveredFrames, 3);
});

test('missing parity is harmless with complete data, but a data erasure then fails', () => {
  const input = seededBytes(256);
  const packet = packetize(input, { shardBytes: 64, dataPerGroup: 4 });
  const dataOnly = packet.frames.filter(frame => frame.type === 'data');
  assert.deepEqual(recoverPackets({ ...packet, frames: dataOnly }).data, input);
  assert.throws(() => recoverPackets({ ...packet, frames: dataOnly.slice(1) }), /parity/);
  assert.throws(() => recoverPackets({ ...packet, frames: packet.frames.filter(frame => frame.type !== 'data' || frame.index > 1) }), /Too many/);
});

test('CRC failures count as erasures; recomputed CRC cannot bypass the logical SHA256', () => {
  const packet = packetize(seededBytes(256), { shardBytes: 64, dataPerGroup: 4 });
  const frames = packet.frames.map(frame => ({ ...frame }));
  const corrupt = Buffer.from(frames[0].data, 'base64');
  corrupt[0] ^= 1;
  frames[0].data = corrupt.toString('base64');
  assert.equal(recoverPackets({ ...packet, frames }).corruptFrames, 1);
  frames[0].crc32 = crc32(corrupt);
  assert.throws(() => recoverPackets({ ...packet, frames }), /checksum/);
});

test('recovery rejects invalid manifest bounds, valid-CRC indices and duplicate frame identities', () => {
  const packet = packetize(seededBytes(256), { shardBytes: 64 });
  for (const patch of [{ bytes: -1 }, { bytes: maxBytes + 1 }, { shardBytes: 63 }, { dataPerGroup: 17 }, { dataCount: 99 }, { sha256: 'x'.repeat(64) }]) {
    assert.throws(() => recoverPackets({ ...packet, manifest: { ...packet.manifest, ...patch } }), /manifest/);
  }
  const indices = packet.frames.map(frame => ({ ...frame }));
  indices[0].index = -1;
  assert.throws(() => recoverPackets({ ...packet, frames: indices }), /index/);
  const duplicate = packet.frames.filter(frame => frame.type === 'data');
  duplicate[3] = duplicate[0];
  assert.throws(() => recoverPackets({ ...packet, frames: duplicate }), /Duplicate/);
});

test('invalid base64 padding is rejected or counted as an erasure, not silently accepted', () => {
  const packet = packetize(Buffer.from('base64 validation'), { shardBytes: 64 });
  const frames = packet.frames.map(frame => ({ ...frame }));
  frames[0].data = frames[0].data.replace(/==$/, '!!');
  let recovered;
  try { recovered = recoverPackets({ ...packet, frames }); }
  catch (error) { assert.match(error.message, /base64|frame/i); return; }
  assert.equal(recovered.corruptFrames, 1);
});

test('spectrum preserves the amplitude of the even-length Nyquist bin', () => {
  const result = spectrum([1, -1, 1, -1, 1, -1, 1, -1], 8);
  assert.equal(result.peaks[0].frequencyHz, 4);
  assert.ok(Math.abs(result.peaks[0].amplitude - 1) < 1e-12);
});

test('spectrum rejects sparse arrays rather than returning NaN peaks', () => {
  assert.throws(() => spectrum(Array(4), 4), /finite|sample|array/i);
});

test('spectrum never returns nonfinite amplitudes for accepted finite inputs', () => {
  for (const samples of [[1e308, 1e308, -1e308, -1e308], [1e308, 1e308, 1e308, 1e308]]) {
    let result;
    try { result = spectrum(samples, 4); }
    catch (error) { assert.match(error.message, /finite|range|overflow|numeric|sample/i); continue; }
    assert.ok(result.peaks.every(peak => Number.isFinite(peak.amplitude)));
  }
});

test('benchmark wire accounting includes the actual emitted base64/JSON manifest and frames', () => {
  const text = 'A bounded independent wire-accounting experiment.';
  const report = transportBenchmark(text);
  const userCase = report.cases.find(entry => entry.name === 'user-text');
  const serializedBytes = Buffer.byteLength(JSON.stringify(packetize(Buffer.from(text))));
  assert.ok(userCase.parityWireBytes >= serializedBytes,
    'A field called wire bytes must include serialization, not just decoded shard payloads.');
});

test('benchmark distinguishes conventional redundancy compression from high-entropy expansion', () => {
  const report = transportBenchmark();
  const repeated = report.cases.find(entry => entry.name === 'repeated-text');
  const noise = report.cases.find(entry => entry.name === 'seeded-high-entropy');
  assert.ok(report.cases.every(entry => entry.byteExact && entry.parityRecoveryExact));
  assert.ok(repeated.brotliBytes < repeated.pngBytes);
  assert.ok(noise.pngBytes > noise.rawBytes);
  assert.match(report.meaning, /not extra information capacity|not.*tokenizer/i);
});
