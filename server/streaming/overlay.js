// OBS Overlay WebSocket Bridge
// Manages /ws/obs connections from OBS Browser Source instances.
// Serves overlay.html and demo.html as static files.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createObsBridge() {
  const clients = new Set();
  let artifactHistory = [];
  const MAX_HISTORY = 50;

  function addClient(ws) {
    clients.add(ws);
    console.log(`streaming: OBS client connected (total: ${clients.size})`);

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`streaming: OBS client disconnected (total: ${clients.size})`);
    });

    ws.on('error', () => clients.delete(ws));

    if (artifactHistory.length) {
      ws.send(JSON.stringify({
        type: 'history',
        payload: artifactHistory.slice(-5),
      }));
    }
  }

  function broadcastArtifact(artifactPayload) {
    artifactHistory.push(artifactPayload);
    if (artifactHistory.length > MAX_HISTORY) artifactHistory = artifactHistory.slice(-MAX_HISTORY);

    const msg = JSON.stringify({ type: 'artifact', payload: artifactPayload });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
    return clients.size;
  }

  function broadcastSporeState(sporeState) {
    const msg = JSON.stringify({ type: 'spore', payload: sporeState });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function broadcastConfig(config) {
    const msg = JSON.stringify({ type: 'config', payload: config });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function serveOverlay(_req, res) {
    try {
      const html = readFileSync(join(__dirname, 'overlay.html'), 'utf8');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).json({ error: 'overlay.html not found' });
    }
  }

  function serveDemo(_req, res) {
    try {
      const html = readFileSync(join(__dirname, 'demo.html'), 'utf8');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).json({ error: 'demo.html not found' });
    }
  }

  return {
    clients,
    addClient,
    broadcastArtifact,
    broadcastSporeState,
    broadcastConfig,
    serveOverlay,
    serveDemo,
    getStats: () => ({
      connectedOverlays: clients.size,
      artifactsInHistory: artifactHistory.length,
    }),
  };
}

let _bridge = null;
export function getObsBridge() {
  if (!_bridge) _bridge = createObsBridge();
  return _bridge;
}
