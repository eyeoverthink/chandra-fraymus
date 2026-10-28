// Hive Mind — thought signing + DNA fingerprint matrix
// Source: Library Manager hive.js
import { signText } from '../core/identity.js';
import { fnv1aStr } from '../core/crypto.js';
import { hiveCanonical } from '../core/signing.js';

export async function signThought(identity, text, source = 'manual') {
  const ts = Math.floor(Date.now() / 1000);
  const canon = hiveCanonical(identity.number, ts, text);
  const sig = await signText(identity, canon);
  return {
    from: identity.number,
    pub: identity.pubkey,
    ts,
    text,
    sig,
    sig_kind: 'hive',
    source,
  };
}

// 16x16 deterministic DNA fingerprint matrix from fx-number
export function matrix(fx) {
  const out = [];
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      out.push(Number(fnv1aStr(`${fx}:${x},${y}`) % 100n));
    }
  }
  return out;
}

// DNA base from matrix value
export function matrixDna(fx) {
  const bases = ['A', 'C', 'G', 'T'];
  return matrix(fx).map((v) => bases[v % 4]);
}
