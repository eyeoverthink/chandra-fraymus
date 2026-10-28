import { randomUUID } from 'node:crypto';

const connections = new Map();
const pending = new Map();

export function handleExtensionWs(ws, req) {
  const id = randomUUID().slice(0, 8);
  const conn = { id, ws, tabs: [], connected: new Date().toISOString() };
  connections.set(id, conn);

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'tabs') { conn.tabs = msg.tabs || []; return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  });

  ws.on('close', () => { connections.delete(id); });
  ws.on('error', () => { connections.delete(id); });

  ws.send(JSON.stringify({ type: 'connected', extensionId: id }));
}

function send(connId, msg, timeout = 15_000) {
  const conn = connections.get(connId);
  if (!conn || conn.ws.readyState !== 1) throw Object.assign(new Error('Extension not connected'), { code: 'ext_disconnected' });
  const id = randomUUID().slice(0, 8);
  msg.id = id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Extension request timed out')); }, timeout);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolve(r); }, reject });
    conn.ws.send(JSON.stringify(msg));
  });
}

export function extensionStatus() {
  return [...connections.values()].map(c => ({ id: c.id, tabs: c.tabs, connected: c.connected }));
}

export async function extensionScreenshot(connId, tabId) {
  return send(connId, { type: 'screenshot', tabId });
}

export async function extensionGetText(connId, tabId, selector) {
  return send(connId, { type: 'getText', tabId, selector });
}

export async function extensionGetHtml(connId, tabId, selector) {
  return send(connId, { type: 'getHtml', tabId, selector });
}

export async function extensionGetLinks(connId, tabId) {
  return send(connId, { type: 'getLinks', tabId });
}

export async function extensionGetImages(connId, tabId) {
  return send(connId, { type: 'getImages', tabId });
}

export async function extensionClick(connId, tabId, selector) {
  return send(connId, { type: 'click', tabId, selector });
}

export async function extensionEval(connId, tabId, code) {
  return send(connId, { type: 'eval', tabId, code });
}

export async function extensionNavigate(connId, tabId, url) {
  return send(connId, { type: 'navigate', tabId, url });
}

export function installExtensionRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/extension/status', route(async (_req, res) => {
    res.json({ connections: extensionStatus() });
  }));

  app.post('/api/extension/:connId/screenshot', route(async (req, res) => {
    res.json(await extensionScreenshot(req.params.connId, req.body.tabId));
  }));

  app.post('/api/extension/:connId/text', route(async (req, res) => {
    res.json(await extensionGetText(req.params.connId, req.body.tabId, req.body.selector));
  }));

  app.post('/api/extension/:connId/click', route(async (req, res) => {
    res.json(await extensionClick(req.params.connId, req.body.tabId, req.body.selector));
  }));

  app.post('/api/extension/:connId/navigate', route(async (req, res) => {
    res.json(await extensionNavigate(req.params.connId, req.body.tabId, req.body.url));
  }));

  app.post('/api/extension/:connId/eval', route(async (req, res) => {
    res.json(await extensionEval(req.params.connId, req.body.tabId, req.body.code));
  }));
}
