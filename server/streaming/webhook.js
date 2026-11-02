// Simulated Donation Webhook — matches Streamlabs event format
// Demo mode: POST /api/streaming/simulate-donation triggers the minting pipeline.
// Wire format matches real Streamlabs so switching to live webhooks is a config swap.

import { mintArtifact } from './mint.js';
import { storeArtifactRecord } from './keys.js';

export function createWebhookHandler({ db, dataDir, broadcast, memoryBridge, obsClients, sporeRegistry }) {

  async function handleDonation(donationEvent, apiKeyId = null) {
    const { name, amount, message, currency = 'USD', from: donorId } = donationEvent;
    const { audio_peak, chat_velocity, stream_tick } = donationEvent;

    const streamerId = donationEvent.streamer_id || 'default-streamer';
    const parsedAmount = parseFloat(amount) || 0;

    const result = await mintArtifact(
      {
        streamerId,
        donorId: donorId || `donor_${Date.now().toString(36)}`,
        donorName: name || 'Anonymous',
        amount: parsedAmount,
        message: (message || '').slice(0, 500),
        timestamp: new Date().toISOString(),
      },
      { dataDir, broadcast }
    );

    let sporeMutation = null;
    if (sporeRegistry) {
      const organism = sporeRegistry.getOrCreate(streamerId);
      if (!organism.fossilized) {
        sporeMutation = organism.mutate({
          donorName: name || 'Anonymous',
          donorId: donorId || result.artifact.donorId,
          amount: parsedAmount,
          message: (message || '').slice(0, 200),
          audioPeak: parseInt(audio_peak) || 0,
          chatVelocity: parseInt(chat_velocity) || 0,
          streamTick: parseInt(stream_tick) || 0,
        });
      }
    }

    storeArtifactRecord(db, result.artifact, apiKeyId);

    if (memoryBridge) {
      memoryBridge.storeCognitionResult({
        phase: 'artifact_mint',
        feeling: { primary: 'creation', intensity: 0.8 },
        response: `Minted artifact ${result.artifact.id} for ${name} ($${amount}) — spore gen ${sporeMutation?.generation || 'n/a'}`,
        durationMs: result.durationMs,
      }).catch(() => {});
    }

    deliverToOverlays(obsClients, result, sporeMutation);

    return { ...result, sporeMutation };
  }

  function deliverToOverlays(clients, mintResult, sporeMutation) {
    if (!clients || !clients.size) return;
    const payload = JSON.stringify({
      type: 'artifact',
      payload: {
        id: mintResult.artifact.id,
        donorName: mintResult.artifact.donorName,
        amount: mintResult.artifact.amount,
        message: mintResult.artifact.message,
        pngBase64: mintResult.pngBase64,
        wasmBase64: mintResult.wasmBase64,
        sha256: mintResult.artifact.sha256,
        stegoEmoji: mintResult.stegoEmoji,
        signature: mintResult.artifact.signed,
        timestamp: mintResult.artifact.timestamp,
        durationMs: mintResult.durationMs,
        spore: sporeMutation ? {
          generation: sporeMutation.generation,
          dna16: sporeMutation.dna16,
          visuals: sporeMutation.visuals,
          mutationKey: sporeMutation.mutation.mutationKey,
          genomeHash: sporeMutation.genomeHash,
        } : null,
      },
    });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  async function handleStreamlabsFormat(body) {
    if (body.type === 'donation' && Array.isArray(body.message)) {
      const results = [];
      for (const msg of body.message.slice(0, 5)) {
        results.push(await handleDonation({
          name: msg.name,
          amount: msg.amount,
          message: msg.message,
          currency: msg.currency,
          from: msg.from,
          streamer_id: body.streamer_id,
        }));
      }
      return results;
    }
    if (body.type === 'subscription' || body.type === 'bits') {
      return [await handleDonation({
        name: body.message?.[0]?.name || 'Subscriber',
        amount: body.message?.[0]?.amount || 0,
        message: body.message?.[0]?.message || `${body.type} event`,
        streamer_id: body.streamer_id,
      })];
    }
    throw new Error(`Unsupported event type: ${body.type}`);
  }

  return { handleDonation, handleStreamlabsFormat, deliverToOverlays };
}
