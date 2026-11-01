// Simulated Donation Webhook — matches Streamlabs event format
// Demo mode: POST /api/streaming/simulate-donation triggers the minting pipeline.
// Wire format matches real Streamlabs so switching to live webhooks is a config swap.

import { mintArtifact } from './mint.js';
import { storeArtifactRecord } from './keys.js';

export function createWebhookHandler({ db, dataDir, broadcast, memoryBridge, obsClients }) {

  async function handleDonation(donationEvent, apiKeyId = null) {
    const { name, amount, message, currency = 'USD', from: donorId } = donationEvent;

    const streamerId = donationEvent.streamer_id || 'default-streamer';
    const result = await mintArtifact(
      {
        streamerId,
        donorId: donorId || `donor_${Date.now().toString(36)}`,
        donorName: name || 'Anonymous',
        amount: parseFloat(amount) || 0,
        message: (message || '').slice(0, 500),
        timestamp: new Date().toISOString(),
      },
      { dataDir, broadcast }
    );

    storeArtifactRecord(db, result.artifact, apiKeyId);

    if (memoryBridge) {
      memoryBridge.storeCognitionResult({
        phase: 'artifact_mint',
        feeling: { primary: 'creation', intensity: 0.8 },
        response: `Minted artifact ${result.artifact.id} for ${name} ($${amount})`,
        durationMs: result.durationMs,
      }).catch(() => {});
    }

    deliverToOverlays(obsClients, result);

    return result;
  }

  function deliverToOverlays(clients, mintResult) {
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
