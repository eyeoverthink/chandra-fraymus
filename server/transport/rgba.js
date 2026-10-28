import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const MAGIC = Buffer.from('FRAYRGBA');
const MAX_BYTES = 8 * 1024 * 1024;
function bytesOf(input) {
  if (ArrayBuffer.isView(input)) return Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  if (Array.isArray(input)) {
    for (let i=0;i<input.length;i++) if (!Object.hasOwn(input,i) || !Number.isInteger(input[i]) || input[i]<0 || input[i]>255) throw new Error('Expected a dense byte array');
    return Buffer.from(input);
  }
  throw new Error('Expected bytes, an ArrayBuffer view, or UTF-8 text');
}
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export const sha256 = data => createHash('sha256').update(data).digest('hex');
export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type), out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); tag.copy(out, 4); data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([tag, data])), data.length + 8);
  return out;
}

/** Byte transport, not visual quantization: every RGBA channel carries one exact byte. */
export function encodeRgbaPng(input, { width = 64, compression = 'auto' } = {}) {
  const source = bytesOf(input);
  if (source.length > MAX_BYTES || !Number.isInteger(width) || width < 1 || width > 1024
      || !['auto','none','brotli'].includes(compression)) throw new Error('Invalid RGBA input/options');
  const compressed = compression === 'none' ? source : brotliCompressSync(source);
  const useBrotli = compression === 'brotli' || (compression === 'auto' && compressed.length < source.length);
  const data = useBrotli ? compressed : source;
  const header = Buffer.alloc(50);
  MAGIC.copy(header); header[8] = 1; header[9] = useBrotli ? 1 : 0;
  header.writeUInt32BE(source.length, 10); header.writeUInt32BE(data.length, 14);
  Buffer.from(sha256(source), 'hex').copy(header, 18);
  const packet = Buffer.concat([header, data]), rowBytes = width * 4;
  const height = Math.ceil(packet.length / rowBytes), pixels = Buffer.alloc(height * rowBytes);
  packet.copy(pixels);
  const scan = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) pixels.copy(scan, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scan)), chunk('IEND', Buffer.alloc(0))]);
  return { png, width, height, originalBytes: source.length, pngBytes: png.length,
    encoding: useBrotli ? 'brotli' : 'raw', sha256: sha256(source) };
}

/** Strict decoder for the format above; never route transport bytes through a compositing canvas. */
export function decodeRgbaPng(input) {
  const png = Buffer.from(input);
  if (png.length > MAX_BYTES * 2 || !png.subarray(0,8).equals(SIGNATURE)) throw new Error('Invalid PNG signature/size');
  let pos = 8, width, height, ended = false, seenData = false;
  const parts = [];
  while (pos < png.length) {
    if (png.length - pos < 12) throw new Error('Truncated PNG chunk');
    const length = png.readUInt32BE(pos), end = pos + length + 12;
    if (end > png.length) throw new Error('Truncated PNG payload');
    const tag = png.toString('latin1', pos + 4, pos + 8), data = png.subarray(pos + 8, end - 4);
    if (crc32(png.subarray(pos + 4, end - 4)) !== png.readUInt32BE(end - 4)) throw new Error('PNG CRC mismatch');
    if (tag === 'IHDR') {
      if (pos !== 8 || length !== 13) throw new Error('Invalid PNG header');
      width = data.readUInt32BE(); height = data.readUInt32BE(4);
      if (!width || width > 1024 || !height || width * height * 4 > MAX_BYTES + 8192
          || data[8] !== 8 || data[9] !== 6 || data[10] || data[11] || data[12]) throw new Error('Unsupported RGBA dimensions/format');
    } else if (tag === 'IDAT') {
      if (!width || ended) throw new Error('Misordered PNG data');
      seenData = true; parts.push(data);
    } else if (tag === 'IEND') {
      if (length || !seenData || end !== png.length) throw new Error('Invalid PNG end');
      ended = true;
    } else throw new Error('Unexpected transport PNG chunk');
    pos = end;
  }
  if (!ended || !width) throw new Error('Missing PNG chunks');
  const rowBytes = width * 4, expected = height * (rowBytes + 1);
  const compressedRaster = Buffer.concat(parts);
  const inflated = inflateSync(compressedRaster, { maxOutputLength: expected, info: true });
  if (inflated.engine.bytesWritten !== compressedRaster.length) throw new Error('Trailing PNG compressed data');
  const scan = inflated.buffer;
  if (scan.length !== expected) throw new Error('Wrong PNG raster length');
  const packet = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    if (scan[y * (rowBytes + 1)] !== 0) throw new Error('Unsupported transport PNG filter');
    scan.copy(packet, y * rowBytes, y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
  }
  if (packet.length < 50 || !packet.subarray(0,8).equals(MAGIC) || packet[8] !== 1 || packet[9] > 1) throw new Error('Invalid Fraymus packet');
  const length = packet.readUInt32BE(10), stored = packet.readUInt32BE(14);
  if (length > MAX_BYTES || stored > MAX_BYTES + 1024 || 50 + stored > packet.length) throw new Error('Invalid packet bounds');
  const encoded = packet.subarray(50, 50 + stored);
  let data;
  if (packet[9]) {
    const decoded = brotliDecompressSync(encoded, { maxOutputLength: Math.max(1, length), info: true });
    if (decoded.engine.bytesWritten !== encoded.length) throw new Error('Trailing compressed packet data');
    data = decoded.buffer;
  } else data = Buffer.from(encoded);
  if (data.length !== length || sha256(data) !== packet.subarray(18,50).toString('hex')) throw new Error('Packet content checksum mismatch');
  return { data, width, height, sha256: sha256(data), encoding: packet[9] ? 'brotli' : 'raw' };
}

export function packetize(input, { shardBytes = 1024, dataPerGroup = 4 } = {}) {
  const data = bytesOf(input);
  if (data.length > MAX_BYTES || !Number.isInteger(shardBytes) || shardBytes < 64 || shardBytes > 65536
      || !Number.isInteger(dataPerGroup) || dataPerGroup < 2 || dataPerGroup > 16) throw new Error('Invalid shard options');
  const dataCount = Math.max(1, Math.ceil(data.length / shardBytes)), frames = [];
  for (let first = 0; first < dataCount; first += dataPerGroup) {
    const parity = Buffer.alloc(shardBytes), group = first / dataPerGroup;
    for (let index = first; index < Math.min(first + dataPerGroup, dataCount); index++) {
      const bytes = Buffer.alloc(shardBytes); data.copy(bytes, 0, index * shardBytes, (index + 1) * shardBytes);
      for (let j = 0; j < shardBytes; j++) parity[j] ^= bytes[j];
      frames.push({ type: 'data', index, group, data: bytes.toString('base64'), crc32: crc32(bytes) });
    }
    frames.push({ type: 'parity', index: group, group, data: parity.toString('base64'), crc32: crc32(parity) });
  }
  return { manifest: { version: 1, bytes: data.length, sha256: sha256(data), shardBytes, dataPerGroup, dataCount }, frames };
}
export function recoverPackets({ manifest: m, frames }) {
  if (!m || m.version !== 1 || !Number.isInteger(m.bytes) || m.bytes < 0 || m.bytes > MAX_BYTES
      || !Number.isInteger(m.shardBytes) || m.shardBytes < 64 || m.shardBytes > 65536
      || !Number.isInteger(m.dataPerGroup) || m.dataPerGroup < 2 || m.dataPerGroup > 16
      || m.dataCount !== Math.max(1, Math.ceil(m.bytes / m.shardBytes)) || !Array.isArray(frames)
      || frames.length > m.dataCount + Math.ceil(m.dataCount / m.dataPerGroup) || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error('Invalid packet manifest');
  const valid = new Map(); let corruptFrames = 0, recoveredFrames = 0;
  for (const frame of frames) {
    if (!frame || !['data','parity'].includes(frame.type) || !Number.isInteger(frame.index)
        || typeof frame.data !== 'string' || frame.data.length > Math.ceil(m.shardBytes / 3) * 4) throw new Error('Invalid frame');
    if (frame.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) { corruptFrames++; continue; }
    const bytes = Buffer.from(frame.data, 'base64');
    if (bytes.toString('base64') !== frame.data) { corruptFrames++; continue; }
    if (bytes.length !== m.shardBytes || crc32(bytes) !== frame.crc32) { corruptFrames++; continue; }
    const key = frame.type + ':' + frame.index;
    if (valid.has(key)) throw new Error('Duplicate frame');
    if (frame.index < 0 || frame.index >= (frame.type === 'data' ? m.dataCount : Math.ceil(m.dataCount / m.dataPerGroup))) throw new Error('Invalid frame index');
    valid.set(key, bytes);
  }
  const output = [];
  for (let first = 0; first < m.dataCount; first += m.dataPerGroup) {
    const indices = Array.from({ length: Math.min(m.dataPerGroup, m.dataCount - first) }, (_, i) => first + i);
    const missing = indices.filter(i => !valid.has('data:' + i));
    if (missing.length > 1) throw new Error('Too many missing/corrupt frames in one group');
    if (missing.length) {
      const parity = valid.get('parity:' + first / m.dataPerGroup);
      if (!parity) throw new Error('Missing recovery parity');
      const restored = Buffer.from(parity);
      for (const i of indices) if (i !== missing[0]) {
        const bytes = valid.get('data:' + i); for (let j = 0; j < m.shardBytes; j++) restored[j] ^= bytes[j];
      }
      valid.set('data:' + missing[0], restored); recoveredFrames++;
    }
    output.push(...indices.map(i => valid.get('data:' + i)));
  }
  const data = Buffer.concat(output).subarray(0, m.bytes);
  if (sha256(data) !== m.sha256) throw new Error('Recovered content checksum mismatch');
  return { data, recoveredFrames, corruptFrames, sha256: m.sha256 };
}
