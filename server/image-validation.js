import { inflateSync } from 'node:zlib';
import { crc32 } from './transport/rgba.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_EDGE = 8192;
const MAX_PIXELS = 16_000_000;
const MAX_RASTER = 64 * 1024 * 1024;
const MAX_MARKERS = 65536;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_MODES = new Map([
  [0, { channels: 1, depths: [1, 2, 4, 8, 16] }],
  [2, { channels: 3, depths: [8, 16] }],
  [3, { channels: 1, depths: [1, 2, 4, 8] }],
  [4, { channels: 2, depths: [8, 16] }],
  [6, { channels: 4, depths: [8, 16] }],
]);

function dimensions(width, height) {
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new Error('Image dimensions exceed 8192 pixels per edge or 16 megapixels');
  }
}

function validatePng(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature');
  let position = 8, width, height, depth, color, rowBytes, expected;
  let seenHeader = false, seenPalette = false, seenData = false, dataEnded = false, seenEnd = false;
  let chunks = 0, compressedBytes = 0;
  const compressed = [];
  while (position < data.length) {
    if (++chunks > MAX_MARKERS || data.length - position < 12) throw new Error('Invalid/truncated PNG chunk framing');
    const length = data.readUInt32BE(position);
    const end = position + 12 + length;
    if (length > 0x7fffffff || end > data.length) throw new Error('Truncated PNG chunk payload');
    const tagBytes = data.subarray(position + 4, position + 8);
    const tag = tagBytes.toString('latin1');
    if (!/^[A-Za-z]{4}$/.test(tag) || (tagBytes[2] & 32)) throw new Error('Invalid PNG chunk type');
    if (crc32(data.subarray(position + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw new Error('PNG CRC mismatch');
    if (!seenHeader && tag !== 'IHDR') throw new Error('PNG IHDR must be first');
    const payload = data.subarray(position + 8, end - 4);
    if (tag === 'IHDR') {
      if (seenHeader || position !== 8 || length !== 13) throw new Error('Invalid/duplicate PNG IHDR');
      width = payload.readUInt32BE(); height = payload.readUInt32BE(4);
      dimensions(width, height);
      depth = payload[8]; color = payload[9];
      const mode = PNG_MODES.get(color);
      if (!mode || !mode.depths.includes(depth) || payload[10] !== 0 || payload[11] !== 0) {
        throw new Error('Unsupported PNG bit depth/color/compression/filter mode');
      }
      if (payload[12] !== 0) throw new Error('Interlaced PNG uploads are unsupported');
      rowBytes = Math.ceil(width * mode.channels * depth / 8);
      expected = height * (rowBytes + 1);
      if (expected > MAX_RASTER) throw new Error('PNG expanded raster exceeds 64 MiB');
      seenHeader = true;
    } else if (tag === 'PLTE') {
      if (seenPalette || seenData || color === 0 || color === 4 || !length || length % 3
          || length > 768 || (color === 3 && length / 3 > 2 ** depth)) throw new Error('Invalid PNG palette');
      seenPalette = true;
    } else if (tag === 'IDAT') {
      if (dataEnded || (color === 3 && !seenPalette)) throw new Error('Misordered PNG IDAT/palette');
      seenData = true; compressedBytes += length; compressed.push(payload);
    } else if (tag === 'IEND') {
      if (length || !seenData || !compressedBytes || end !== data.length) throw new Error('Invalid PNG IEND/data');
      seenEnd = true;
    } else {
      if (['acTL', 'fcTL', 'fdAT'].includes(tag)) throw new Error('Animated PNG uploads are unsupported');
      if (!(tagBytes[0] & 32)) throw new Error('Unknown critical PNG chunk');
      if (seenData) dataEnded = true;
    }
    position = end;
  }
  if (!seenHeader || !seenData || !seenEnd) throw new Error('Missing PNG IHDR/IDAT/IEND');
  // Bound and validate the scanline byte stream only. No unfiltering, color conversion,
  // pixel interpretation, canvas compositing, or model call occurs here.
  const encoded = Buffer.concat(compressed, compressedBytes);
  let decoded;
  try { decoded = inflateSync(encoded, { maxOutputLength: expected, info: true }); }
  catch { throw new Error('Invalid PNG compressed raster or expanded raster length'); }
  if (decoded.engine.bytesWritten !== encoded.length) throw new Error('Trailing PNG zlib data');
  if (decoded.buffer.length !== expected) throw new Error('PNG raster length does not match dimensions');
  for (let y = 0; y < height; y++) {
    if (decoded.buffer[y * (rowBytes + 1)] > 4) throw new Error('Invalid PNG scanline filter byte');
  }
  return { width, height, format: 'png' };
}

function quantizationTables(payload, tables) {
  let position = 0;
  while (position < payload.length) {
    const descriptor = payload[position++], precision = descriptor >>> 4, id = descriptor & 15;
    const size = 64 * (precision + 1);
    if (precision > 1 || id > 3 || position + size > payload.length) throw new Error('Invalid JPEG quantization table');
    for (let offset = 0; offset < size; offset += precision + 1) {
      const value = precision ? payload.readUInt16BE(position + offset) : payload[position + offset];
      if (!value) throw new Error('Invalid zero JPEG quantization coefficient');
    }
    tables.add(id); position += size;
  }
  if (!position) throw new Error('Empty JPEG quantization table');
}

function huffmanTables(payload, tables) {
  let position = 0;
  while (position < payload.length) {
    if (payload.length - position < 17) throw new Error('Truncated JPEG Huffman table');
    const descriptor = payload[position++], kind = descriptor >>> 4, id = descriptor & 15;
    if (kind > 1 || id > 3) throw new Error('Invalid JPEG Huffman table selector');
    let symbols = 0, slots = 1;
    for (let i = 0; i < 16; i++) {
      const count = payload[position++]; symbols += count; slots = slots * 2 - count;
      if (slots < 0) throw new Error('Oversubscribed JPEG Huffman table');
    }
    if (!symbols || symbols > 256 || position + symbols > payload.length) throw new Error('Invalid JPEG Huffman table length');
    tables.add(`${kind}:${id}`); position += symbols;
  }
  if (!position) throw new Error('Empty JPEG Huffman table');
}

function validateJpeg(data) {
  if (data.length < 4 || data[0] !== 255 || data[1] !== 216) throw new Error('Invalid JPEG signature');
  let position = 2, width, height, frameType, scanCount = 0, markerCount = 0;
  let inScan = false, scanBytes = 0, restartInterval = 0, expectedRestart = 0;
  const components = new Map(), scannedComponents = new Set(), quantization = new Set(), huffman = new Set();
  while (position < data.length) {
    let marker;
    if (inScan) {
      while (position < data.length) {
        if (data[position++] !== 255) { scanBytes++; continue; }
        const fillStart = position;
        while (position < data.length && data[position] === 255) position++;
        if (position >= data.length) throw new Error('Truncated JPEG entropy marker');
        marker = data[position++];
        if (marker === 0) {
          if (position - fillStart !== 1) throw new Error('Invalid JPEG entropy byte stuffing');
          scanBytes++; marker = undefined; continue;
        }
        if (marker >= 0xd0 && marker <= 0xd7) {
          if (!restartInterval || marker !== 0xd0 + expectedRestart || ++markerCount > MAX_MARKERS) throw new Error('Invalid JPEG restart marker');
          expectedRestart = (expectedRestart + 1) % 8; marker = undefined; continue;
        }
        if (!scanBytes) throw new Error('Empty JPEG entropy scan');
        inScan = false; break;
      }
      if (inScan) throw new Error('Missing JPEG EOI');
    } else {
      if (data[position++] !== 255) throw new Error('Invalid JPEG marker framing');
      while (position < data.length && data[position] === 255) position++;
      if (position >= data.length) throw new Error('Truncated JPEG marker');
      marker = data[position++];
    }
    if (++markerCount > MAX_MARKERS) throw new Error('Too many JPEG markers');
    if (marker === 0xd9) {
      if (!frameType || !scanCount || scannedComponents.size !== components.size || position !== data.length) throw new Error('Invalid JPEG EOI/frame/scan');
      return { width, height, format: 'jpeg' };
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) throw new Error('Invalid/unsupported standalone JPEG marker');
    if (data.length - position < 2) throw new Error('Truncated JPEG segment length');
    const length = data.readUInt16BE(position), end = position + length;
    if (length < 2 || end > data.length) throw new Error('Invalid/truncated JPEG segment');
    const payload = data.subarray(position + 2, end);
    position = end;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (frameType || payload.length < 6) throw new Error('Invalid/duplicate JPEG SOF');
      frameType = marker;
      const precision = payload[0], count = payload[5];
      height = payload.readUInt16BE(1); width = payload.readUInt16BE(3);
      dimensions(width, height);
      if ((marker === 0xc0 ? precision !== 8 : ![8, 12].includes(precision))
          || ![1, 3, 4].includes(count) || payload.length !== 6 + 3 * count) throw new Error('Unsupported JPEG frame precision/components');
      for (let i = 0; i < count; i++) {
        const offset = 6 + 3 * i, id = payload[offset], sampling = payload[offset + 1], table = payload[offset + 2];
        if (components.has(id) || !(sampling >>> 4) || (sampling >>> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || table > 3) throw new Error('Invalid JPEG frame component');
        components.set(id, { table });
      }
    } else if (marker === 0xda) {
      if (!frameType || payload.length < 6) throw new Error('JPEG SOS requires a valid SOF');
      const count = payload[0];
      if (!count || count > components.size || payload.length !== 4 + 2 * count) throw new Error('Invalid JPEG SOS components/length');
      const start = payload[1 + 2 * count], finish = payload[2 + 2 * count], approximation = payload[3 + 2 * count];
      const high = approximation >>> 4, low = approximation & 15;
      if (frameType === 0xc2) {
        if (start > finish || finish > 63 || (start === 0 && finish !== 0) || (start > 0 && count !== 1)
            || high > 13 || low > 13 || (high && high !== low + 1)) throw new Error('Invalid progressive JPEG scan');
      } else if (start !== 0 || finish !== 63 || approximation) throw new Error('Invalid sequential JPEG scan');
      const selected = new Set();
      for (let i = 0; i < count; i++) {
        const id = payload[1 + 2 * i], selector = payload[2 + 2 * i], dc = selector >>> 4, ac = selector & 15;
        const component = components.get(id);
        if (!component || selected.has(id) || dc > 3 || ac > 3 || !quantization.has(component.table)
            || ((frameType !== 0xc2 || start === 0) && !huffman.has(`0:${dc}`))
            || ((frameType !== 0xc2 || start > 0) && !huffman.has(`1:${ac}`))
            || (frameType !== 0xc2 && scannedComponents.has(id))) throw new Error('Invalid JPEG scan component/tables');
        selected.add(id); scannedComponents.add(id);
      }
      scanCount++; scanBytes = 0; inScan = true; expectedRestart = 0;
    } else if (marker === 0xdb) quantizationTables(payload, quantization);
    else if (marker === 0xc4) huffmanTables(payload, huffman);
    else if (marker === 0xdd) {
      if (payload.length !== 2) throw new Error('Invalid JPEG restart interval');
      restartInterval = payload.readUInt16BE();
    } else if (!((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe)) {
      throw new Error('Unsupported JPEG coding/marker');
    }
  }
  throw new Error('Missing JPEG SOF/SOS/EOI');
}

/** Bounded framing validation, not a pixel decoder or proof of JPEG entropy validity.
 * PNG IDAT is inflated only to verify its exact bounded scanline length/filter bytes.
 * Interlaced PNG, animation, and uncommon JPEG coding modes are explicitly unsupported.
 */
export function validateImage(input, mimeType) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) throw new Error('Image data must be bytes');
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!data.length || data.length > MAX_BYTES) throw new Error('Image size must be 1 byte to 4 MiB');
  if (mimeType === 'image/png') return validatePng(data);
  if (mimeType === 'image/jpeg') return validateJpeg(data);
  throw new Error('Unsupported image MIME type');
}
