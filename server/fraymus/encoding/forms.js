// Orchestrator: encode data in all 7 forms at once
import { sha256hex, sha256HexSync, sha256Sync } from '../core/crypto.js';
import { toEmoji, encodeEmoji, decodeEmoji } from './emoji.js';
import { encodeDna, decodeDna, gcPercent } from './dna.js';
import { merkleRoot, merkle41 } from './merkle.js';
import { frayHeader } from './fray.js';
import { wrapWasm } from './wasm.js';
import { zipStore } from './zip.js';

export async function allForms(text) {
  const payload = new TextEncoder().encode(text);
  const sha = await sha256hex(payload);
  const root = sha256Sync(payload);

  const visibleEmoji = toEmoji(payload);
  const stegoEmoji = encodeEmoji(payload);
  const dna = encodeDna(payload);
  const header = frayHeader({ root, timestamp: Date.now() });
  const wasm = wrapWasm(payload);
  const m = merkle41(payload);
  const mRoot = merkleRoot(payload);
  const zip = zipStore([{ name: 'payload.bin', data: payload }]);

  const emojiBack = decodeEmoji(stegoEmoji);
  let emojiOk = emojiBack.length === payload.length;
  for (let i = 0; emojiOk && i < payload.length; i++) if (emojiBack[i] !== payload[i]) emojiOk = false;

  const dnaBack = decodeDna(dna);
  let dnaOk = dnaBack.length === payload.length;
  for (let i = 0; dnaOk && i < payload.length; i++) if (dnaBack[i] !== payload[i]) dnaOk = false;

  return {
    input: text,
    size: payload.length,
    sha256: sha,
    visibleEmoji,
    stegoEmoji,
    emojiRoundTrip: emojiOk,
    dna,
    dnaBases: dna.length,
    gc: gcPercent(dna),
    dnaRoundTrip: dnaOk,
    merkleRoot: Array.from(mRoot, b => b.toString(16).padStart(2, '0')).join(''),
    fnvMerkleRoot: m.root,
    fnvMerkleCount: m.count,
    frayHeaderSize: 64,
    wasmSize: wasm.length,
    zipSize: zip.length,
    verified: emojiOk && dnaOk,
  };
}
