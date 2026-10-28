import { gzipSync, brotliCompressSync } from 'node:zlib';
import { encodeRgbaPng, decodeRgbaPng } from './rgba.js';

const MAX_VECTORS = 4096;
const MAX_COMPONENTS = MAX_VECTORS * 4;
function components(input, inRange = false) {
  if (!(Array.isArray(input) || (ArrayBuffer.isView(input) && !(input instanceof DataView)))
      || !input.length || input.length % 4 || input.length > MAX_COMPONENTS) throw new Error('Expected 1–4096 dense XYZW vectors in a flat numeric array');
  for (let i = 0; i < input.length; i++) {
    if (!Object.hasOwn(input, i) || typeof input[i] !== 'number' || !Number.isFinite(input[i]) || !Number.isFinite(Math.fround(input[i]))) throw new Error('XYZW components must be finite Float32-representable numbers');
    if (inRange && (input[i] < -1 || input[i] > 1)) throw new Error('Quantization requires every component in [-1,1]; clipping is not automatic');
  }
  return input;
}
function bytes(input, bytesPerVector, maxBytes) {
  let result;
  if (input instanceof Uint8Array) result = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else if (input instanceof ArrayBuffer) result = Buffer.from(input);
  else if (Array.isArray(input)) {
    if (input.length > maxBytes) throw new Error('Vector byte array is too large');
    for (let i = 0; i < input.length; i++) if (!Object.hasOwn(input, i) || !Number.isInteger(input[i]) || input[i] < 0 || input[i] > 255) throw new Error('Expected a dense array of bytes');
    result = Buffer.from(input);
  } else throw new Error('Expected vector bytes, not a numeric floating-point view');
  if (!result.length || result.length % bytesPerVector || result.length > maxBytes) throw new Error('Invalid vector byte length');
  return result;
}

/** Round JS numbers to IEEE-754 Float32 and write X,Y,Z,W as explicit little-endian bytes.
 * Existing finite Float32 values (including signed zero/subnormals) retain their bits.
 * Arbitrary JS double values undergo a separate, intentionally explicit rounding step.
 */
export function packFloat32XYZW(input) {
  const values = components(input), result = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) result.writeFloatLE(values[i], i * 4);
  return result;
}
export function unpackFloat32XYZW(input) {
  const source = bytes(input, 16, MAX_COMPONENTS * 4), result = new Float32Array(source.length / 4);
  for (let i = 0; i < result.length; i++) {
    const value = source.readFloatLE(i * 4);
    if (!Number.isFinite(value)) throw new Error('Encoded vectors contain non-finite Float32 values');
    result[i] = value;
  }
  return result;
}

/** Lossy numerical quantization, not lossless Float32 byte transport.
 * X→R,Y→G,Z→B,W→A; nearest uint8 level from [-1,1]. No clipping, scaling inference or tokenizer changes.
 */
export function quantizeXYZWToRGBA(input) {
  const values = components(input, true), result = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) result[i] = Math.round((values[i] + 1) * 127.5);
  return result;
}
/** Decode uint8 levels as JS/Float64 grid values; zero has no exact level in this grid. */
export function decodeRGBAToXYZW(input) {
  const source = bytes(input, 4, MAX_COMPONENTS), result = new Float64Array(source.length);
  for (let i = 0; i < source.length; i++) result[i] = source[i] / 127.5 - 1;
  return result;
}

function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return ((state >>> 0) + 0.5) / 4294967296; };
}
function gaussian(rng) { return Math.sqrt(-2 * Math.log(rng())) * Math.cos(2 * Math.PI * rng()); }
function normalize(vector) {
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error('Synthetic vector norm is zero');
  return vector.map(component => component / norm);
}
function direction(rng) { return normalize(Array.from({ length: 4 }, () => gaussian(rng))); }
function cosine(left, right) {
  let dot = 0; for (let i = 0; i < 4; i++) dot += left[i] * right[i];
  return Math.max(-1, Math.min(1, dot / (Math.hypot(...left) * Math.hypot(...right))));
}
function vectors(flat) { return Array.from({ length: flat.length / 4 }, (_, i) => Array.from(flat.subarray(i * 4, i * 4 + 4))); }
function nearest(query, catalog) {
  let index = -1, score = -Infinity, secondScore = -Infinity;
  catalog.forEach((candidate, i) => {
    const next = cosine(query, candidate);
    if (next > score) { secondScore = score; score = next; index = i; }
    else if (next > secondScore) secondScore = next;
  });
  return { index, cosine: score, margin: score - secondScore };
}
function errors(original, decoded) {
  let max = 0, sum = 0, squared = 0;
  for (let i = 0; i < original.length; i++) {
    const error = Math.abs(original[i] - decoded[i]);
    max = Math.max(max, error); sum += error; squared += error * error;
  }
  return { maxAbsComponentError: max, meanAbsComponentError: sum / original.length, componentRmse: Math.sqrt(squared / original.length) };
}
function sizes(data) {
  // Disable the optional Brotli pre-layer to make this an ordinary PNG-deflate comparison.
  const carrier = encodeRgbaPng(data, { width: 64, compression: 'none' });
  return { rawBytes: data.length, gzipBytes: gzipSync(data).length, brotliBytes: brotliCompressSync(data).length,
    pngCarrierBytes: carrier.png.length, pngPayloadEncoding: 'raw bytes + carrier header, compressed by PNG IDAT deflate',
    payloadRgbaPixels: data.length / 4, carrierWidth: carrier.width, carrierHeight: carrier.height,
    carrierTotalPixels: carrier.width * carrier.height, sha256: carrier.sha256,
    pngByteExact: decodeRgbaPng(carrier.png).data.equals(data) };
}
function agreement(queries, baseline, decoded) {
  let matches = 0, originalScore = 0, decodedScore = 0;
  const disagreements = [];
  queries.forEach((query, queryIndex) => {
    const before = nearest(query, baseline), after = nearest(query, decoded);
    originalScore += before.cosine; decodedScore += after.cosine;
    if (before.index === after.index) matches++;
    else if (disagreements.length < 8) disagreements.push({ queryIndex, float32Index: before.index, quantizedIndex: after.index, float32Margin: before.margin, float32Cosine: before.cosine, quantizedCosine: after.cosine });
  });
  return { queries: queries.length, top1Matches: matches, top1Disagreements: queries.length - matches,
    top1Agreement: matches / queries.length, meanFloat32BestCosine: originalScore / queries.length,
    meanQuantizedBestCosine: decodedScore / queries.length, exampleDisagreements: disagreements };
}

/** Deterministic finite synthetic test, with no model calls or external datasets. */
export function vectorBenchmark() {
  const catalogRandom = random(0x58495a57), queryRandom = random(0x52474241);
  const original = Array.from({ length: 256 }, () => direction(catalogRandom)).flat();
  const float32Bytes = packFloat32XYZW(original), float32 = unpackFloat32XYZW(float32Bytes);
  const quantizedBytes = quantizeXYZWToRGBA(float32), decoded = decodeRGBAToXYZW(quantizedBytes);
  const baseline = vectors(float32), quantized = vectors(decoded);
  const noisy = Array.from({ length: 128 }, (_, i) => normalize(baseline[(i * 73) % baseline.length].map(value => value + 0.02 * gaussian(queryRandom))).map(Math.fround));
  const heldout = Array.from({ length: 512 }, () => direction(queryRandom).map(Math.fround));
  const angular = baseline.map((vector, i) => Math.acos(cosine(vector, quantized[i])) * 180 / Math.PI).sort((a, b) => a - b);
  const componentErrors = errors(float32, decoded);
  return {
    version: 1, fixture: { seedCatalog: '0x58495a57', seedQueries: '0x52474241', dimensions: 4, vectors: 256,
      distribution: 'Gaussian components normalized to unit directions, then separately rounded to Float32',
      noisyOriginalQueries: noisy.length, noisyOriginalSigma: 0.02, heldoutDirectionQueries: heldout.length,
      queryRepresentation: 'Identical Float32-rounded queries in both cosine searches; only the catalog is quantized',
      nearestNeighborMetric: 'Cosine similarity with decoded vector norms recomputed; ties choose the lowest catalog index' },
    layout: { componentOrder: 'X,Y,Z,W', byteOrder: 'little-endian IEEE-754 Float32',
      float32BytesPerVector: 16, float32RgbaPixelsPerVector: 4, quantizedBytesPerVector: 4, quantizedRgbaPixelsPerVector: 1,
      rgbaMeaning: 'Lossless byte carrier: each channel is one byte. Lossy numerical layout: X→R,Y→G,Z→B,W→A.' },
    sourceDoubleToFloat32: { ...errors(original, float32), meaning: 'Separate JS double-to-Float32 rounding, before either carrier or uint8 quantization.' },
    quantization: { encode: 'q=round((component+1)*127.5)', decode: 'component=q/127.5-1', sourceRange: [-1, 1], levelsPerChannel: 256,
      step: 2 / 255, maxTheoreticalComponentError: 1 / 255, clipping: false, ...componentErrors,
      withinComponentErrorBound: componentErrors.maxAbsComponentError <= 1 / 255 + 1e-12,
      angularErrorDegrees: { mean: angular.reduce((sum, value) => sum + value, 0) / angular.length,
        p95: angular[Math.ceil(0.95 * angular.length) - 1], max: angular.at(-1) } },
    sizes: { float32: sizes(float32Bytes), uint8Rgba: sizes(quantizedBytes), rawNumericalReductionFactor: float32Bytes.length / quantizedBytes.length },
    nearestNeighbor: { noisyOriginals: agreement(noisy, baseline, quantized), heldoutDirections: agreement(heldout, baseline, quantized), all: agreement([...noisy, ...heldout], baseline, quantized) },
    preview: { float32XYZW: Array.from(float32.subarray(0, 16)), quantizedRGBABytes: Array.from(quantizedBytes.subarray(0, 16)), decodedXYZW: Array.from(decoded.subarray(0, 16)) },
    semantics: 'uint8/channel quantization uses four times fewer raw bytes by discarding numerical precision. A lossless PNG carrier preserves its payload bytes and does not increase information capacity.',
    caveats: [
      'This is a deterministic synthetic 4D nearest-neighbor comparison, not an LLM, perception, recognition or intelligence benchmark.',
      'Top1 agreement measures consistency with this Float32 catalog, not accuracy against real-world labels; query distribution and nearest-neighbor margins affect the result.',
      'XYZW here are four numerical coordinates, not a calibrated physical space, quaternion convention or device channel.',
      'JS double-to-Float32 rounding and Float32-to-uint8 quantization are different precision losses; PNG transport adds no further numerical loss.',
      'The uint8 grid has no exact zero and does not preserve signed zero; normalize decoded directions when a downstream metric requires unit vectors.',
      'RGBA payload pixel counts exclude the carrier header and row padding; PNG sizes include framing and deflate compression, and compression sizes depend on these data and encoder versions.',
      'Keep original carrier PNG bytes: compositing, alpha premultiplication, resizing, screenshots, color conversion or JPEG can corrupt byte channels.',
      'This format does not alter a model tokenizer, add an embedding decoder, or let a model understand packed vector bytes automatically.',
    ],
  };
}
