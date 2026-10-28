// Two Merkle tree variants:
// 1. Binary SHA-256 tree (forms.js) — standard content-addressable
// 2. FNV-1a 41-hash tree (fraymusComms.js) — lightweight, 32 blocks + 8 intermediate + 1 root
import { sha256Sync, fnv1a } from '../core/crypto.js';

// ═══ Binary SHA-256 Merkle (32-byte chunk tree) ═══

export function merkleRoot(u8) {
  if (u8.length === 0) return new Uint8Array(32);
  const leaves = [];
  for (let i = 0; i < u8.length; i += 32) {
    leaves.push(sha256Sync(u8.subarray(i, Math.min(i + 32, u8.length))));
  }
  let layer = leaves;
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const pair = new Uint8Array(64);
      pair.set(layer[i], 0);
      pair.set(layer[i + 1] || layer[i], 32);
      next.push(sha256Sync(pair));
    }
    layer = next;
  }
  return layer[0];
}

// ═══ FNV-1a Merkle 41 (32 leaves → 8 intermediate → 1 root) ═══

export function merkle41(bytes) {
  const blocks = [];
  for (let i = 0; i < 32; i++) {
    const blk = new Uint8Array(32);
    const start = i * 32;
    const chunk = bytes.subarray ? bytes.subarray(start, start + 32) : bytes.slice(start, start + 32);
    if (chunk && chunk.length) blk.set(chunk, 0);
    blocks.push(fnv1a(blk));
  }
  const inter = [];
  for (let i = 0; i < 8; i++) {
    let acc = 0n;
    for (let j = 0; j < 4; j++) acc ^= blocks[i * 4 + j];
    inter.push(acc);
  }
  let root = 0n;
  for (const x of inter) root ^= x;
  const hashes = [
    ...blocks.map((h) => h.toString(16)),
    ...inter.map((h) => h.toString(16)),
    root.toString(16),
  ];
  return { hashes, root: root.toString(16), count: hashes.length };
}

export function merkleDivergence(a, b) {
  const ma = merkle41(a).hashes, mb = merkle41(b).hashes;
  const diff = [];
  for (let i = 0; i < Math.min(ma.length, mb.length); i++) {
    if (ma[i] !== mb[i]) diff.push(i);
  }
  return diff;
}
