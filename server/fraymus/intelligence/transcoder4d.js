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

function isCredentialChar(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45;
}

/**
 * A prefix counts only where a token starts: at the start of the text or after a character that cannot be part of a key.
 * Without this, "sk-" matched inside "ta·sk-policy-fixture", "ri·sk-free", "di·sk-usage": a model's tool arguments were
 * redacted mid-stream ("task-policy-fixture:local" reached the scheduler as "ta[REDACTED:4D(…)]:local"), failing every
 * scheduled-task creation since the canary was wired into the Ollama provider (found 2026-11-12).
 */
export function atTokenStart(text, idx, prevChar = '') {
  // prevChar: the last character already emitted before `text` (a streamed token boundary is not a token start)
  if (idx === 0) return !prevChar || !isCredentialChar(prevChar);
  return !isCredentialChar(text[idx - 1]);
}

export function findCredentialEnd(text, startIdx) {
  for (let i = startIdx; i < text.length; i++) {
    if (!isCredentialChar(text[i])) return i;
  }
  return -1;
}

export function detectSecretPrefixes(text) {
  const found = [];
  for (const prefix of SECRET_PREFIXES) {
    let idx = 0;
    while ((idx = text.indexOf(prefix, idx)) !== -1) {
      if (!atTokenStart(text, idx)) { idx += prefix.length; continue; }
      const end = findCredentialEnd(text, idx + prefix.length);
      const tokenLen = (end === -1 ? text.length : end) - idx;
      found.push({ prefix, index: idx, length: tokenLen });
      idx += prefix.length;
    }
  }
  return found;
}

export function sanitizeStreamText(rawText, xorKey = 0x5A, stepAdd = 0x11, prevChar = '') {
  let sanitized = rawText;
  const redactions = [];
  let unterminated = false;

  for (const prefix of SECRET_PREFIXES) {
    let idx = 0;
    while ((idx = sanitized.indexOf(prefix, idx)) !== -1) {
      if (!atTokenStart(sanitized, idx, prevChar)) { idx += prefix.length; continue; }
      const end = findCredentialEnd(sanitized, idx + prefix.length);
      const secretToken = sanitized.substring(idx, end === -1 ? sanitized.length : end);
      if (end === -1) unterminated = true;
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

  return { sanitized, redactions, redactionCount: redactions.length, unterminated };
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
