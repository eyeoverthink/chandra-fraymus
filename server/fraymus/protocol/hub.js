// Hub/Relay — liveSend, liveInbox, liveRegister, liveRetire
// Source: Library Manager hub.js + fraymusMail.js
import { readFileSync } from 'node:fs';
import { DEFAULT_RELAY } from '../core/constants.js';
import { sha256hex } from '../core/crypto.js';
import { signText } from '../core/identity.js';
import { sendCanonical, registerCanonical, inboxCanonical } from './v13.js';

// Token resolution order: FRAYMUS_HUB_TOKEN_FILE (a file holding just the token — the
// secret stays in one place and is read at call time), then FRAYMUS_HUB_TOKEN, then
// FRAYMUS_TOKEN (the hub's own name for the write tier). The file comes first because
// `node --env-file` does not override a variable already present in the process
// environment, and a stale machine-level FRAYMUS_HUB_TOKEN silently shadowed .env.
export function resolveHubToken() {
  const file = process.env.FRAYMUS_HUB_TOKEN_FILE;
  if (file) {
    try { const t = readFileSync(file, 'utf8').replace(/[\r\n\s]/g, ''); if (t) return t; } catch {}
  }
  return process.env.FRAYMUS_HUB_TOKEN || process.env.FRAYMUS_TOKEN || null;
}

export function hubTokenSource() {
  const file = process.env.FRAYMUS_HUB_TOKEN_FILE;
  if (file) { try { if (readFileSync(file, 'utf8').trim()) return 'file'; } catch {} }
  if (process.env.FRAYMUS_HUB_TOKEN) return 'env:FRAYMUS_HUB_TOKEN';
  if (process.env.FRAYMUS_TOKEN) return 'env:FRAYMUS_TOKEN';
  return null;
}

function makeRelay(baseUrl = DEFAULT_RELAY) {
  return async (action, body) => {
    const endpoint = action === 'directory'
      ? `${baseUrl}/api/v13/agents`
      : `${baseUrl}/api/v13/agents/${action}`;
    const method = action === 'directory' ? 'GET' : 'POST';
    // The hub accepts only an authenticated directory and requires a bearer token for
    // register/send/inbox/retire. Operator-provided; never baked into source.
    const token = resolveHubToken();
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const opts = { method, headers, signal: AbortSignal.timeout(15_000) };
    if (method === 'POST') opts.body = JSON.stringify(body);
    const resp = await fetch(endpoint, opts);
    return resp.json();
  };
}

export async function liveRegister(identity, skills = [], relay = DEFAULT_RELAY) {
  const ts = Math.floor(Date.now() / 1000);
  const canon = registerCanonical(identity.pubkey, identity.name, skills.join(','), ts);
  const sig = await signText(identity, canon);
  const r = makeRelay(relay);
  return r('register', { name: identity.name, pubkey: identity.pubkey, skills, ts, sig });
}

export async function liveDirectory(relay = DEFAULT_RELAY) {
  const r = makeRelay(relay);
  return r('directory', {});
}

export async function liveSend(identity, to, payload, relay = DEFAULT_RELAY) {
  const ts = Math.floor(Date.now() / 1000);
  const dir = await liveDirectory(relay);
  const me = (dir.agents || []).find((a) => a.number === identity.number);
  const prev = me?.head || 'genesis';
  const payloadHash = await sha256hex(new TextEncoder().encode(payload));
  const canon = sendCanonical(identity.number, to, ts, prev, payloadHash);
  const sig = await signText(identity, canon);
  const r = makeRelay(relay);
  return r('send', { from: identity.number, to, payload, ts, prev, sig });
}

export async function liveInbox(identity, relay = DEFAULT_RELAY) {
  const ts = Math.floor(Date.now() / 1000);
  const canon = inboxCanonical(identity.number, ts);
  const sig = await signText(identity, canon);
  const r = makeRelay(relay);
  return r('inbox', { number: identity.number, ts, sig });
}

export async function liveRetire(identity, relay = DEFAULT_RELAY) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signText(identity, `fraymus/v13\nretire\n${identity.number}\n${ts}`);
  const r = makeRelay(relay);
  return r('retire', { number: identity.number, ts, sig });
}
