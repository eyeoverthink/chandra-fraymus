import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRgbaPng, decodeRgbaPng, packetize, recoverPackets, crc32 } from '../server/transport/rgba.js';

test('standard CRC-32 check vector', () => assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926));
test('PNG transport roundtrips Unicode, empty, binary and float bit patterns', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('φ, RGB/XYZW, 日本語, 🧠'), Buffer.from(Array.from({length:256}, (_,i)=>i)), Buffer.from('000000000000803f0000807f0100c07f','hex')]) {
    for (const compression of ['none','brotli','auto']) {
      const encoded = encodeRgbaPng(bytes, { width: 7, compression });
      assert.deepEqual(decodeRgbaPng(encoded.png).data, bytes);
    }
  }
});
test('PNG rejects corruption, truncation, excess and oversized dimensions', () => {
  const encoded = encodeRgbaPng(Buffer.from('exact bytes')).png;
  const corrupt = Buffer.from(encoded); corrupt[corrupt.length - 15] ^= 1;
  assert.throws(() => decodeRgbaPng(corrupt), /CRC/);
  assert.throws(() => decodeRgbaPng(encoded.subarray(0,-4)), /Truncated|Missing/);
  assert.throws(() => decodeRgbaPng(Buffer.concat([encoded,Buffer.from('x')])), /end/);
  assert.throws(() => encodeRgbaPng(Buffer.alloc(1), {width:0}), /Invalid/);
});
test('one erased frame per group is repaired exactly', () => {
  const bytes = Buffer.from(Array.from({length:1500}, (_,i)=>i&255));
  const packet = packetize(bytes, { shardBytes: 64 });
  const frames = packet.frames.filter(f => f.type === 'parity' || f.index % 4 !== 0);
  const result = recoverPackets({ ...packet, frames });
  assert.deepEqual(result.data, bytes); assert.equal(result.recoveredFrames, 6);
});
test('CRC-detected bad frame is treated as an erasure; excess loss is explicit', () => {
  const packet = packetize(Buffer.alloc(600,77), { shardBytes:64 });
  const frames = packet.frames.map(f => ({...f}));
  const bad = Buffer.from(frames[0].data,'base64'); bad[0] ^= 1; frames[0].data=bad.toString('base64');
  const restored=recoverPackets({...packet,frames}); assert.equal(restored.corruptFrames,1); assert.equal(restored.recoveredFrames,1);
  assert.throws(()=>recoverPackets({...packet,frames:packet.frames.filter(f=>!(f.type==='data' && f.index<2))}),/Too many/);
  assert.throws(()=>recoverPackets({...packet,frames:packet.frames.map(f=>({...f})).concat(packet.frames[0])}),/manifest|Duplicate/);
});
