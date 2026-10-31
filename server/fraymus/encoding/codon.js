// Carbon X Layer 2: Codon Engine
// 64 codons (3 bases each) with biological start/stop framing and redundant error correction
// Maps real biological codon table to data encoding

// ═══ Biological Codon Table ═══
// Real amino acid assignments (standard genetic code)
// We use this for encoding bytes: 61 sense codons + 3 stop codons
// ATG = start codon (methionine) — marks frame beginning

const STOP_CODONS = ['TAA', 'TAG', 'TGA'];
const START_CODON = 'ATG';

// All 64 codons in canonical order (4^3)
const ALL_CODONS = [];
const BASES = ['A', 'C', 'G', 'T'];
for (const a of BASES) for (const b of BASES) for (const c of BASES) ALL_CODONS.push(a + b + c);

// 61 sense codons (excluding 3 stops) used for data encoding
const SENSE_CODONS = ALL_CODONS.filter(c => !STOP_CODONS.includes(c) && c !== START_CODON);

// Build encoding tables: byte value → codon(s), codon → byte value
// 256 byte values mapped across 60 sense codons (ATG reserved for start)
// Values 0-59 get 1 codon each, values 60-255 get mapped with modular wrap
const BYTE_TO_CODON = new Map();
const CODON_TO_BYTE = new Map();

for (let i = 0; i < SENSE_CODONS.length; i++) {
  BYTE_TO_CODON.set(i, SENSE_CODONS[i]);
  CODON_TO_BYTE.set(SENSE_CODONS[i], i);
}

// For values 60-255, use pairs: high nibble codon + low nibble codon
// This gives us redundancy — like real biology where multiple codons encode the same amino acid

/**
 * Encode a byte array into a codon sequence with biological framing
 * Format: ATG [length codons] [data codons] [checksum codon] STOP
 */
export function encodeCodon(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);

  const codons = [START_CODON];

  // Encode length as 4 bytes (big-endian, max ~4GB)
  const lenBytes = new Uint8Array(4);
  const dv = new DataView(lenBytes.buffer);
  dv.setUint32(0, bytes.length, false);
  for (const b of lenBytes) {
    codons.push(byteToCodonPair(b));
  }

  // Encode data bytes
  for (const b of bytes) {
    codons.push(byteToCodonPair(b));
  }

  // Checksum: FNV-1a of payload, encode as 4 codon pairs
  const check = fnvChecksum(bytes);
  const checkBytes = new Uint8Array(4);
  const cdv = new DataView(checkBytes.buffer);
  cdv.setUint32(0, check, false);
  for (const b of checkBytes) {
    codons.push(byteToCodonPair(b));
  }

  // Stop codon (TAA — ochre stop, most common in nature)
  codons.push('TAA');

  return codons.flat().join('');
}

/**
 * Decode a codon sequence back to bytes
 * Validates start/stop framing and checksum
 */
export function decodeCodon(sequence) {
  const clean = sequence.replace(/[^ACGT]/g, '');
  const codons = [];
  for (let i = 0; i + 2 < clean.length; i += 3) {
    codons.push(clean.substring(i, i + 3));
  }

  // Find start codon
  const startIdx = codons.indexOf(START_CODON);
  if (startIdx === -1) throw new Error('No start codon (ATG) found');

  // Find stop codon after start
  let stopIdx = -1;
  for (let i = startIdx + 1; i < codons.length; i++) {
    if (STOP_CODONS.includes(codons[i])) { stopIdx = i; break; }
  }
  if (stopIdx === -1) throw new Error('No stop codon found');

  const payload = codons.slice(startIdx + 1, stopIdx);

  // Decode length (first 4 codon pairs = 8 codons)
  if (payload.length < 8) throw new Error('Frame too short for length header');
  const lenBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    lenBytes[i] = codonPairToByte(payload[i * 2], payload[i * 2 + 1]);
  }
  const length = new DataView(lenBytes.buffer).getUint32(0, false);

  // Decode data (after length header, before checksum)
  const dataStart = 8;
  const dataEnd = dataStart + length * 2;
  if (payload.length < dataEnd + 8) throw new Error('Frame too short for declared length');

  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    data[i] = codonPairToByte(payload[dataStart + i * 2], payload[dataStart + i * 2 + 1]);
  }

  // Verify checksum
  const checkStart = dataEnd;
  const checkBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    checkBytes[i] = codonPairToByte(payload[checkStart + i * 2], payload[checkStart + i * 2 + 1]);
  }
  const expectedCheck = new DataView(checkBytes.buffer).getUint32(0, false);
  const actualCheck = fnvChecksum(data);
  if (expectedCheck !== actualCheck) {
    throw new Error(`Checksum mismatch: expected ${expectedCheck}, got ${actualCheck}`);
  }

  return data;
}

// ═══ Byte ↔ Codon Pair mapping ═══
// Each byte (0-255) encoded as TWO codons: high nibble + low nibble
// This gives biological redundancy — single-base mutations caught by checksum

function byteToCodonPair(byte) {
  const high = (byte >> 4) & 0x0F;
  const low = byte & 0x0F;
  return [SENSE_CODONS[high], SENSE_CODONS[low]];
}

function codonPairToByte(highCodon, lowCodon) {
  const high = CODON_TO_BYTE.get(highCodon);
  const low = CODON_TO_BYTE.get(lowCodon);
  if (high === undefined) throw new Error(`Unknown codon: ${highCodon}`);
  if (low === undefined) throw new Error(`Unknown codon: ${lowCodon}`);
  return ((high & 0x0F) << 4) | (low & 0x0F);
}

// ═══ FNV-1a 32-bit checksum ═══

function fnvChecksum(bytes) {
  let h = 0x811C9DC5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ═══ GC Content Analysis ═══

export function codonGcContent(sequence) {
  const clean = sequence.replace(/[^ACGT]/g, '');
  const gc = (clean.match(/[GC]/g) || []).length;
  return clean.length ? +((gc / clean.length) * 100).toFixed(2) : 0;
}

// ═══ Frame Statistics ═══

export function codonStats(sequence) {
  const clean = sequence.replace(/[^ACGT]/g, '');
  const codons = [];
  for (let i = 0; i + 2 < clean.length; i += 3) codons.push(clean.substring(i, i + 3));

  const starts = codons.filter(c => c === START_CODON).length;
  const stops = codons.filter(c => STOP_CODONS.includes(c)).length;
  const gc = codonGcContent(sequence);

  return {
    totalBases: clean.length,
    totalCodons: codons.length,
    startCodons: starts,
    stopCodons: stops,
    gcContent: gc,
    openReadingFrames: Math.min(starts, stops),
  };
}

export { START_CODON, STOP_CODONS, SENSE_CODONS, ALL_CODONS };
