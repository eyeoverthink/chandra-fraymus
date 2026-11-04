// HyperTranscoder4D — Bijective 4D Spectral-Chromatic-Frequency Encoding
// Ported from FraynixSuperOrganismV19.java V2
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc
//
// Bijective: transmute ↔ reconstruct is lossless round-trip.
// Secret detection scans for known credential prefixes and transmutes them
// into 4D coordinate space, making raw secrets unrecoverable from output.

export const SECRET_PREFIXES = ['ghp_', 'github_pat_', 'xai-', 'xoxb-', 'sk-'];

export function transmute4ByteSecret(label, secret4Bytes, xorKey, stepAdd) {
  const padded = new Uint8Array(4);
  const len = secret4Bytes ? Math.min(secret4Bytes.length, 4) : 0;
  for (let i = 0; i < len; i++) padded[i] = secret4Bytes[i] & 0xFF;
  const coord4D = new Array(4);
  for (let i = 0; i < 4; i++) {
    coord4D[i] = ((padded[i] ^ xorKey) + stepAdd * (i + 1)) & 0xFF;
  }
  return { label, coord4D, xorKey, stepAdd };
}

export function reconstructSecret(coord4D, xorKey, stepAdd) {
  const secret = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const dec = ((coord4D[i] - stepAdd * (i + 1)) & 0xFF) ^ xorKey;
    secret[i] = dec & 0xFF;
  }
  return secret;
}

export function detectSecretPrefixes(text) {
  const found = [];
  for (const prefix of SECRET_PREFIXES) {
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) !== -1) {
      const end = text.indexOf(' ', idx);
      const tokenLen = (end === -1 ? text.length : end) - idx;
      found.push({ prefix, index: idx, length: tokenLen });
      idx += prefix.length;
    }
  }
  return found;
}

export function sanitizeStreamText(rawText, xorKey = 0x5A, stepAdd = 0x11) {
  let sanitized = rawText;
  const redactions = [];

  for (const prefix of SECRET_PREFIXES) {
    let idx = 0;
    while ((idx = sanitized.indexOf(prefix, idx)) !== -1) {
      const end = sanitized.indexOf(' ', idx);
      const secretToken = sanitized.substring(idx, end === -1 ? sanitized.length : end);
      const bytes = new Uint8Array(4);
      for (let i = 0; i < Math.min(secretToken.length, 4); i++) {
        bytes[i] = secretToken.charCodeAt(i) & 0xFF;
      }
      const transmuted = transmute4ByteSecret(prefix, bytes, xorKey, stepAdd);
      const replacement = `[REDACTED:4D(${transmuted.coord4D.join(',')})]`;
      redactions.push({
        prefix,
        replacement,
        coord4D: transmuted.coord4D,
        index: idx,
        length: secretToken.length,
      });
      sanitized = sanitized.substring(0, idx) + replacement + sanitized.substring(idx + secretToken.length);
      idx += replacement.length;
    }
  }

  return { sanitized, redactions, redactionCount: redactions.length };
}

export function verifyBijectiveRoundTrip(secret4Bytes, xorKey = 0x5A, stepAdd = 0x11) {
  const transmuted = transmute4ByteSecret('test', secret4Bytes, xorKey, stepAdd);
  const reconstructed = reconstructSecret(transmuted.coord4D, xorKey, stepAdd);
  for (let i = 0; i < 4; i++) {
    if ((secret4Bytes[i] & 0xFF) !== reconstructed[i]) return false;
  }
  return true;
}

export default {
  transmute4ByteSecret,
  reconstructSecret,
  detectSecretPrefixes,
  sanitizeStreamText,
  verifyBijectiveRoundTrip,
  SECRET_PREFIXES,
};
