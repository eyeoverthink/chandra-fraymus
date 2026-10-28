import { createHash, timingSafeEqual } from 'node:crypto';

const MAGIC = Buffer.from('FRAYVEC\0'), HEADER = 64, MAX_COUNT = 1024, MAX_DIMENSIONS = 4096, MAX_COMPONENTS = 1048576;
const fail = message => { throw Object.assign(new Error(message), { code: 'vector_codec_invalid' }); };
const checksum = (header, payload) => createHash('sha256').update(header).update(payload).digest();
function sizes(count, dimensions, format) {
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_DIMENSIONS || count * dimensions > MAX_COMPONENTS || !['float32','signed8-rgba'].includes(format)) fail('Vector count, dimensions or format are outside codec limits');
  const paddedDimensions = format === 'signed8-rgba' ? Math.ceil(dimensions / 4) * 4 : dimensions;
  const scaleBytes = format === 'signed8-rgba' ? count * 4 : 0, componentBytes = count * paddedDimensions * (format === 'float32' ? 4 : 1), payloadBytes = scaleBytes + componentBytes;
  return { format, count, dimensions, paddedDimensions, paddingPerVector: paddedDimensions - dimensions, paddingComponents: count * (paddedDimensions - dimensions), headerBytes: HEADER,
    componentBytes, scaleBytes, payloadBytes, totalBytes: HEADER + payloadBytes, payloadRgbaPixels: payloadBytes / 4, rgbaPixels: (HEADER + payloadBytes) / 4,
    losslessFloat32: format === 'float32', signedZeroPreserved: format === 'float32', normalizedByCodec: false };
}
function inputs(vectors) {
  if (!Array.isArray(vectors) || !vectors.length || vectors.length > MAX_COUNT) fail('A bounded nonempty array of vectors is required');
  const count = vectors.length; let dimensions;
  const result = [];
  for (let index = 0; index < count; index++) {
    const vector = vectors[index];
    if (!Object.hasOwn(vectors, index) || !(Array.isArray(vector) || vector instanceof Float32Array || vector instanceof Float64Array) || !vector.length || vector.length > MAX_DIMENSIONS || dimensions !== undefined && vector.length !== dimensions) fail('Dense vectors must have one consistent dimension');
    dimensions = vector.length; if (count * dimensions > MAX_COMPONENTS) fail('Vector components exceed codec limit');
    const copy = new Float32Array(dimensions);
    for (let i = 0; i < dimensions; i++) {
      const component = vector[i];
      if (!Object.hasOwn(vector, i) || typeof component !== 'number' || !Number.isFinite(component) || !Number.isFinite(Math.fround(component))) fail('Every component must be finite and representable as float32');
      copy[i] = component;
    }
    result.push(copy);
  }
  return result;
}

/** Explicit LE float32 baseline or lossy adaptive signed8 RGBA comparison payload. */
export function encodeVectors(vectors, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'format')) fail('Only an explicit vector format option is supported');
  const format = options.format === undefined ? 'float32' : options.format;
  const source = inputs(vectors), metadata = sizes(source.length, source[0].length, format), data = Buffer.alloc(metadata.totalBytes);
  MAGIC.copy(data); data[8] = 1; data[9] = format === 'float32' ? 0 : 1; data.writeUInt16LE(HEADER, 10); data.writeUInt32LE(metadata.count, 12);
  data.writeUInt32LE(metadata.dimensions, 16); data.writeUInt32LE(metadata.paddedDimensions, 20); data.writeUInt32LE(metadata.payloadBytes, 24); data.writeUInt32LE(0, 28);
  let offset = HEADER;
  for (const vector of source) {
    if (format === 'float32') for (const component of vector) { data.writeFloatLE(component, offset); offset += 4; }
    else {
      let scale = 0; for (const component of vector) scale = Math.max(scale, Math.abs(component));
      data.writeFloatLE(scale, offset); offset += 4;
      for (let i = 0; i < metadata.paddedDimensions; i++) data[offset++] = i >= vector.length || !scale ? 128 : Math.round(vector[i] / scale * 127) + 128;
    }
  }
  checksum(data.subarray(0, 32), data.subarray(HEADER)).copy(data, 32);
  return { ...metadata, data };
}

export function decodeVectors(input) {
  if (!(input instanceof Uint8Array) || input.byteLength < HEADER || input.byteLength > HEADER + MAX_COMPONENTS * 4 + MAX_COUNT * 4) fail('Expected a bounded framed vector byte payload');
  const data = Buffer.from(input);
  if (!data.subarray(0, 8).equals(MAGIC) || data[8] !== 1 || ![0, 1].includes(data[9]) || data.readUInt16LE(10) !== HEADER || data.readUInt32LE(28) !== 0) fail('Vector payload magic, version, format, header or reserved fields are invalid');
  const metadata = sizes(data.readUInt32LE(12), data.readUInt32LE(16), data[9] === 0 ? 'float32' : 'signed8-rgba');
  if (data.readUInt32LE(20) !== metadata.paddedDimensions || data.readUInt32LE(24) !== metadata.payloadBytes || data.length !== metadata.totalBytes) fail('Vector payload dimensions, padding or extent is invalid');
  if (!timingSafeEqual(data.subarray(32, 64), checksum(data.subarray(0, 32), data.subarray(HEADER)))) fail('Vector payload checksum does not match');
  const vectors = []; let offset = HEADER;
  for (let index = 0; index < metadata.count; index++) {
    const vector = new Float32Array(metadata.dimensions);
    if (metadata.format === 'float32') for (let i = 0; i < vector.length; i++) { const component = data.readFloatLE(offset); offset += 4; if (!Number.isFinite(component)) fail('Float32 payload contains a nonfinite component'); vector[i] = component; }
    else {
      const scale = data.readFloatLE(offset); offset += 4;
      if (!Number.isFinite(scale) || scale < 0 || Object.is(scale, -0)) fail('Adaptive vector scale is invalid');
      let extreme = false;
      for (let i = 0; i < metadata.paddedDimensions; i++) {
        const byte = data[offset++];
        if (byte === 0 || i >= vector.length && byte !== 128 || scale === 0 && byte !== 128) fail('Signed8 range, zero scale or zero padding is invalid');
        if (i < vector.length) { vector[i] = scale * ((byte - 128) / 127); if (byte === 1 || byte === 255) extreme = true; }
      }
      if (scale > 0 && !extreme) fail('Adaptive vector scale is not represented by any component');
    }
    vectors.push(vector);
  }
  return { ...metadata, vectors };
}

export function vectorPayloadSizes(count, dimensions) {
  return { count, dimensions, float32: sizes(count, dimensions, 'float32'), signed8Rgba: sizes(count, dimensions, 'signed8-rgba') };
}
