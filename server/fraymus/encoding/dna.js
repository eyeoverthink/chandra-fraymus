// DNA encoding: 4 bases per byte (ACGT) + HDC 16384-bit hypervector fingerprinting
import { DNA_BASES } from '../core/constants.js';

// ═══ Basic DNA Encoding (2 bits per base, 4 bases per byte) ═══

export function encodeDna(bytes) {
  let s = '';
  for (const b of bytes) {
    s += DNA_BASES[(b >> 6) & 3];
    s += DNA_BASES[(b >> 4) & 3];
    s += DNA_BASES[(b >> 2) & 3];
    s += DNA_BASES[b & 3];
  }
  return s;
}

export function decodeDna(str) {
  const map = { A: 0, C: 1, G: 2, T: 3 };
  const clean = str.replace(/[^ACGT]/g, '');
  const out = [];
  for (let i = 0; i + 3 < clean.length; i += 4) {
    out.push(
      (map[clean[i]] << 6) | (map[clean[i + 1]] << 4) |
      (map[clean[i + 2]] << 2) | map[clean[i + 3]]
    );
  }
  return new Uint8Array(out);
}

export function gcPercent(dna) {
  const g = (dna.match(/G/g) || []).length;
  const c = (dna.match(/C/g) || []).length;
  return dna.length ? +(((g + c) / dna.length) * 100).toFixed(2) : 0;
}

// ═══ HDC DNA Hypervector (16384-bit / 2048-byte content fingerprint) ═══

function splitMix64(seed) {
  let x = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn;
  return function () {
    x = (x + 0x9e3779b97f4a7c15n) & 0xFFFFFFFFFFFFFFFFn;
    let z = x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xFFFFFFFFFFFFFFFFn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xFFFFFFFFFFFFFFFFn;
    z = z ^ (z >> 31n);
    return z;
  };
}

export function dnaHypervector(bytes, shaHex) {
  const CHUNKS = 256;
  const vec = new BigUint64Array(CHUNKS);
  const rng = splitMix64('0x' + shaHex.slice(0, 16));
  for (let i = 0; i < CHUNKS; i++) vec[i] = rng();
  const perChunk = Math.max(1, Math.floor(bytes.length / CHUNKS));
  for (let c = 0; c < CHUNKS; c++) {
    let h = 0xcbf29ce484222325n;
    const start = c * perChunk;
    const end = Math.min(bytes.length, start + perChunk);
    for (let i = start; i < end; i++) {
      h ^= BigInt(bytes[i]);
      h = (h * 0x100000001b3n) & 0xFFFFFFFFFFFFFFFFn;
    }
    vec[c] ^= h;
  }
  const out = new Uint8Array(CHUNKS * 8);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < CHUNKS; i++) dv.setBigUint64(i * 8, vec[i], true);
  return out;
}
