// Streaming Routes — installStreamingRoutes(app, opts)
// REST endpoints for minting, verification, webhooks, API keys, and overlay serving.

import { db as defaultDb } from '../db.js';
import { mintArtifact, verifyArtifact, getIdentityPublicKey } from './mint.js';
import {
  initStreamingKeys, validateKey, hasScope,
  createKey, revokeKey, listKeys,
  storeArtifactRecord, listArtifacts,
} from './keys.js';
import { createWebhookHandler } from './webhook.js';
import { DATA_DIR } from '../config.js';

export function installStreamingRoutes(app, { broadcast, memoryBridge, db: dbParam, obsBridge } = {}) {
  const d = dbParam || defaultDb;
  const dataDir = DATA_DIR;
  initStreamingKeys(d);

  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  const webhook = createWebhookHandler({
    db: d, dataDir, broadcast, memoryBridge,
    obsClients: obsBridge?.clients,
  });

  function deliverToOverlay(result) {
    if (!obsBridge) return;
    obsBridge.broadcastArtifact({
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
  }

  app.post('/api/streaming/simulate-donation', route(async (req, res) => {
    const { donor_name, amount, message, streamer_id } = req.body;
    if (!donor_name || !amount) return res.status(400).json({ error: 'donor_name and amount required' });
    const result = await webhook.handleDonation({
      name: donor_name,
      amount,
      message: message || '',
      streamer_id: streamer_id || 'demo-streamer',
    });
    deliverToOverlay(result);
    res.json({ artifact: result.artifact, durationMs: result.durationMs });
  }));

  app.post('/api/streaming/webhook', route(async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.query.key;
    const keyRow = validateKey(d, apiKey);
    if (!keyRow) return res.status(401).json({ error: 'Invalid or missing API key' });
    if (!hasScope(keyRow, 'webhook')) return res.status(403).json({ error: 'Key lacks webhook scope' });
    const results = await webhook.handleStreamlabsFormat(req.body);
    results.forEach(deliverToOverlay);
    res.json({ ok: true, count: results.length, artifacts: results.map(r => r.artifact.id) });
  }));

  app.post('/api/streaming/verify', route(async (req, res) => {
    const { wasm_base64 } = req.body;
    if (!wasm_base64) return res.status(400).json({ error: 'wasm_base64 required' });
    const buf = Buffer.from(wasm_base64, 'base64');
    res.json(await verifyArtifact(buf));
  }));

  app.get('/api/streaming/artifacts', route(async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const streamerId = req.query.streamer_id;
    res.json(listArtifacts(d, { limit, streamerId }));
  }));

  app.get('/api/streaming/keys', route(async (req, res) => {
    res.json(listKeys(d));
  }));

  app.post('/api/streaming/keys', route(async (req, res) => {
    const { name, scopes, rate_limit } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    res.json(createKey(d, { name, scopes, rateLimit: rate_limit }));
  }));

  app.delete('/api/streaming/keys/:id', route(async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid key id' });
    res.json({ revoked: revokeKey(d, id) });
  }));

  app.get('/api/streaming/identity', route(async (req, res) => {
    const pub = getIdentityPublicKey();
    res.json(pub || { error: 'Identity not yet initialized — mint an artifact first' });
  }));

  app.get('/api/streaming/overlay-status', route(async (req, res) => {
    res.json(obsBridge ? obsBridge.getStats() : { connectedOverlays: 0 });
  }));

  if (obsBridge) {
    app.get('/streaming/overlay', obsBridge.serveOverlay);
    app.get('/streaming/demo', obsBridge.serveDemo);
  }

  console.log('streaming: routes installed (9 endpoints + overlay/demo pages)');
}
