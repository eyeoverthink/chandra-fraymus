// FRAY 64-byte header — binary protocol frame
import { FRAY_MAGIC } from '../core/constants.js';

export function frayHeader(opts = {}) {
  const h = new Uint8Array(64);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, FRAY_MAGIC, false);
  h[4] = opts.version ?? 3;
  dv.setUint16(5, opts.wordCount ?? 256, false);
  h[7] = 41; // hash count
  const root = opts.root && opts.root.length === 32 ? opts.root : new Uint8Array(32);
  h.set(root, 8);
  dv.setBigUint64(40, BigInt(opts.timestamp ?? Date.now()), false);
  dv.setBigUint64(48, BigInt(opts.gameId ?? 0), false);
  dv.setUint32(56, opts.drawCount ?? 0, false);
  h[60] = opts.op ?? 0x01;
  h[61] = opts.protocol ?? 0x00;
  return h;
}

export function parseFrayHeader(h) {
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  return {
    magic: dv.getUint32(0, false),
    ver: h[4],
    wordCount: dv.getUint16(5, false),
    hashCount: h[7],
    root: h.slice(8, 40),
    timestamp: Number(dv.getBigUint64(40, false)),
    gameId: Number(dv.getBigUint64(48, false)),
    drawCount: dv.getUint32(56, false),
    op: h[60],
    protocol: h[61],
  };
}
