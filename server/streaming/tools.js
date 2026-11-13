// Streaming Fleet Tools — registered into the agent tool system
// Agents can mint artifacts, verify them, and manage the streaming subsystem.

import { mintArtifact, verifyArtifact } from './mint.js';
import { listArtifacts, storeArtifactRecord } from './keys.js';

export function createStreamingTools({ memoryBridge, db, dataDir, broadcast, obsBridge } = {}) {
  return [
    {
      name: 'streaming.mint_artifact',
      group: 'streaming',
      risk: 'safe',
      description: 'Mint a Living Artifact from a stream donation moment. Returns WASM container, PNG visual, DNA fingerprint, Ed25519 signature, and steganographic emoji tag.',
      parameters: {
        type: 'object',
        properties: {
          streamer_id: { type: 'string', description: 'Streamer identifier' },
          donor_name: { type: 'string', description: 'Donor display name' },
          amount: { type: 'number', description: 'Donation amount' },
          message: { type: 'string', description: 'Donation message' },
        },
        required: ['donor_name', 'amount'],
      },
      execute: async ({ args }) => {
        const result = await mintArtifact({
          streamerId: args.streamer_id || 'agent-stream',
          donorId: `agent_${Date.now().toString(36)}`,
          donorName: args.donor_name,
          amount: args.amount,
          message: args.message || '',
        }, { dataDir, broadcast });
        return {
          id: result.artifact.id,
          sha256: result.artifact.sha256,
          wasmSize: result.artifact.wasmSize,
          pngSize: result.artifact.png.bytes,
          dnaSize: result.artifact.dnaSize,
          durationMs: result.durationMs,
          signature: result.artifact.signed,
        };
      },
    },
    {
      name: 'streaming.verify_artifact',
      group: 'streaming',
      risk: 'safe',
      description: 'Verify a Living Artifact WASM binary — checks magic bytes, all 5 fraymus.* sections, SHA-256 baseline, DNA fingerprint match.',
      parameters: {
        type: 'object',
        properties: {
          wasm_base64: { type: 'string', description: 'Base64-encoded WASM artifact to verify' },
        },
        required: ['wasm_base64'],
      },
      execute: async ({ args }) => {
        const buf = Buffer.from(args.wasm_base64, 'base64');
        return verifyArtifact(buf);
      },
    },
    {
      name: 'streaming.list_artifacts',
      group: 'streaming',
      risk: 'safe',
      description: 'List recently minted Living Artifacts from the database.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 20)' },
          streamer_id: { type: 'string', description: 'Filter by streamer' },
        },
      },
      execute: async ({ args }) => listArtifacts(db, {
        limit: args.limit || 20,
        streamerId: args.streamer_id,
      }),
    },
    {
      name: 'streaming.overlay_status',
      group: 'streaming',
      risk: 'safe',
      description: 'Check how many OBS overlay clients are connected and recent artifact history.',
      parameters: { type: 'object', properties: {} },
      execute: async () => obsBridge
        ? obsBridge.getStats()
        : { connectedOverlays: 0, artifactsInHistory: 0 },
    },
    {
      name: 'streaming.simulate_donation',
      group: 'streaming',
      risk: 'safe',
      // A simulated donation is shown on every connected OBS overlay — on a live stream, viewers see a donation that
      // never happened. With an overlay connected it waits for Vaughn's approval; with none, agents test freely.
      // (Found 2026-11-13 when the goal engine first proposed stream work.)
      approvalWhen: () => (obsBridge?.clients?.size || 0) > 0,
      description: 'Simulate a stream donation to test the minting pipeline. Triggers the full pipeline and delivers to any connected OBS overlays (asks for approval while an overlay is connected, because viewers would see it).',
      parameters: {
        type: 'object',
        properties: {
          donor_name: { type: 'string', description: 'Donor name' },
          amount: { type: 'number', description: 'Amount' },
          message: { type: 'string', description: 'Donation message' },
          streamer_id: { type: 'string', description: 'Streamer ID' },
        },
        required: ['donor_name', 'amount'],
      },
      execute: async ({ args }) => {
        const result = await mintArtifact({
          streamerId: args.streamer_id || 'demo-streamer',
          donorId: `sim_${Date.now().toString(36)}`,
          donorName: args.donor_name,
          amount: args.amount,
          message: args.message || 'Simulated donation',
        }, { dataDir, broadcast });
        storeArtifactRecord(db, result.artifact);
        if (obsBridge) obsBridge.broadcastArtifact({
          id: result.artifact.id,
          donorName: result.artifact.donorName,
          amount: result.artifact.amount,
          message: result.artifact.message,
          pngBase64: result.pngBase64,
          wasmBase64: result.wasmBase64,
          sha256: result.artifact.sha256,
          stegoEmoji: result.stegoEmoji,
          signature: result.artifact.signed,
          timestamp: result.artifact.timestamp,
          durationMs: result.durationMs,
        });
        return {
          id: result.artifact.id,
          sha256: result.artifact.sha256,
          durationMs: result.durationMs,
          deliveredTo: obsBridge?.clients?.size || 0,
        };
      },
    },
  ];
}
