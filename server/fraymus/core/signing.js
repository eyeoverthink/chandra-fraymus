// Unified v13 message signing — merged from v13.js + fraymusMail.js
import { sha256hex, canonical } from './crypto.js';
import { signText, verifyText, numberFromPub } from './identity.js';

export async function signMessage(identity, to, payload, prev) {
  const m = {
    from_number: identity.number,
    to,
    payload,
    ts: Math.floor(Date.now() / 1000),
    prev: prev || 'genesis',
  };
  m.hash = await sha256hex(new TextEncoder().encode(canonical(m)));
  m.sig = await signText(identity, canonical(m));
  return m;
}

export async function verifyMessage(m, pubHex, expectedPrev) {
  const checks = { sig: false, hash: false, chain: false, time: false };
  const { sig, hash, ...body } = m;
  const bodyCanon = canonical(body);
  const computedHash = await sha256hex(new TextEncoder().encode(bodyCanon));
  checks.hash = computedHash === hash;
  checks.sig = await verifyText(pubHex, bodyCanon, sig);
  checks.chain = expectedPrev ? m.prev === expectedPrev : true;
  const now = Math.floor(Date.now() / 1000);
  checks.time = Math.abs(now - m.ts) <= 300;
  return { valid: checks.sig && checks.hash && checks.chain && checks.time, checks };
}

// Hub-style canonical for send operations
export function hubCanonical(kind, ...fields) {
  return new TextEncoder().encode(['fraymus/v13', kind, ...fields.map(String)].join('\n'));
}

// Hive mind canonical for thought signing
export function hiveCanonical(number, ts, text) {
  return `hive|${number}|${ts}|${text}`;
}
