// Living Artifact / Sovereign Emote — Minting Pipeline
// Wires the full FRAYMUS encoding stack into a single mintArtifact() call.
// Split-brain: ALL transmutation happens here (server-side). Clients only verify + render.

import { transmute, verifyWasm, decodeWasm } from '../fraymus/encoding/wasm.js';
import { dnaHypervector } from '../fraymus/encoding/dna.js';
import { encodeCodon } from '../fraymus/encoding/codon.js';
import { forgePlasmid } from '../fraymus/encoding/plasmid.js';
import { encodeEmoji } from '../fraymus/encoding/emoji.js';
import { signMessage } from '../fraymus/core/signing.js';
import { generateIdentity } from '../fraymus/core/identity.js';
import { sha256hex, bytesToBase64 } from '../fraymus/core/crypto.js';
import { encodeRgbaPng } from '../transport/rgba.js';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

let _identity = null;

async function getServerIdentity(dataDir) {
  if (_identity) return _identity;
  const idPath = join(dataDir, 'streaming-identity.json');
  if (existsSync(idPath)) {
    try {
      _identity = JSON.parse(readFileSync(idPath, 'utf8'));
      return _identity;
    } catch (e) { console.error('streaming: failed to load identity:', e.message); }
  }
  _identity = await generateIdentity('fraymus-streaming-server');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(idPath, JSON.stringify(_identity, null, 2));
  return _identity;
}

function createFilelike(buffer, name) {
  return {
    name,
    arrayBuffer() {
      return Promise.resolve(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      );
    },
  };
}

export async function mintArtifact(
  { streamerId, donorId, donorName, amount, message, timestamp, frameData },
  { dataDir, broadcast }
) {
  const ts = timestamp || new Date().toISOString();
  const startMs = Date.now();

  const momentPayload = JSON.stringify({
    type: 'living-artifact',
    version: 1,
    streamer: streamerId,
    donor: { id: donorId, name: donorName },
    amount,
    message,
    timestamp: ts,
    frame: frameData ? bytesToBase64(new Uint8Array(frameData)) : null,
  });
  const momentBytes = new TextEncoder().encode(momentPayload);

  const file = createFilelike(Buffer.from(momentBytes), `artifact-${Date.now()}.fray`);
  const { wasm, ledger, sha256, dna, genesis } = await transmute(file);

  const codon = encodeCodon(momentBytes);
  let plasmid = null;
  try {
    plasmid = forgePlasmid(momentPayload, {
      name: `artifact-${donorName}-${ts}`,
      type: 'sovereign-emote',
    });
  } catch (e) { console.error('streaming: plasmid forge warning:', e.message); }

  const identity = await getServerIdentity(dataDir);
  const signed = await signMessage(identity, streamerId, {
    artifact_sha256: sha256,
    donor: donorName,
    amount,
    timestamp: ts,
  }, 'genesis');

  const ownershipTag = new TextEncoder().encode(`${sha256}:${donorName}:${ts}`);
  const stegoEmoji = encodeEmoji(ownershipTag);

  const { png, width, height } = encodeRgbaPng(wasm);

  const artifactId = `art_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const durationMs = Date.now() - startMs;

  const artifact = {
    id: artifactId,
    streamerId,
    donorId,
    donorName,
    amount,
    message,
    timestamp: ts,
    sha256,
    dnaSize: dna.length,
    codonLength: codon.length,
    plasmidSize: plasmid?.size || 0,
    signed: { from: signed.from_number, hash: signed.hash, ts: signed.ts },
    stegoEmoji,
    png: { width, height, bytes: png.length },
    wasmSize: wasm.length,
    mintedAt: Date.now(),
    durationMs,
  };

  if (broadcast) {
    broadcast('streaming', { type: 'artifact_minted', artifact });
  }

  return {
    artifact,
    wasm,
    png,
    pngBase64: png.toString('base64'),
    wasmBase64: Buffer.from(wasm).toString('base64'),
    ledger,
    genesis,
    signature: signed,
    stegoEmoji,
    dna,
    codon,
    plasmid,
    durationMs,
  };
}

export async function verifyArtifact(wasmBuffer) {
  const result = await verifyWasm(wasmBuffer);
  if (!result.valid) return { valid: false, reason: 'wasm_verification_failed', ...result };

  const decoded = await decodeWasm(wasmBuffer);
  if (decoded.original && decoded.dna) {
    const recomputedDna = dnaHypervector(decoded.original, decoded.baseline);
    const dnaMatch = Buffer.from(recomputedDna).equals(Buffer.from(decoded.dna));
    return { valid: result.valid && dnaMatch, dnaMatch, reason: dnaMatch ? null : 'dna_mismatch', ...result };
  }

  return { valid: result.valid, dnaMatch: null, reason: null, ...result };
}

export function getIdentityPublicKey() {
  return _identity ? { pubkey: _identity.pubkey, number: _identity.number } : null;
}
