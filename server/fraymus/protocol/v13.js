// v13 Protocol — constants, endpoints, canonical format, Kuramoto sync
import { DEFAULT_RELAY, TIMESTAMP_WINDOW, PHI } from '../core/constants.js';

export const ENDPOINTS = {
  register: { method: 'POST', path: '/api/v13/agents/register', zone: 'write' },
  directory: { method: 'GET', path: '/api/v13/agents', zone: 'read' },
  inbox: { method: 'GET', path: '/api/v13/inbox/', zone: 'read' },
  send: { method: 'POST', path: '/api/v13/send', zone: 'write' },
  chain: { method: 'GET', path: '/api/v13/chain/', zone: 'read' },
};

export function sendCanonical(from, to, ts, prev, payloadHash) {
  return ['fraymus/v13', 'send', from, to, String(ts), prev, payloadHash].join('\n');
}

export function registerCanonical(pubkey, name, skills, ts) {
  return ['fraymus/v13', 'register', pubkey, name, skills, String(ts)].join('\n');
}

export function inboxCanonical(number, ts) {
  return ['fraymus/v13', 'inbox', number, String(ts)].join('\n');
}

export function isTimestampValid(ts, windowSec = TIMESTAMP_WINDOW) {
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= windowSec;
}

// ═══ Kuramoto Phase Synchronization ═══

export function kuramotoR(phases) {
  let re = 0, im = 0;
  for (const th of phases) { re += Math.cos(th); im += Math.sin(th); }
  const n = phases.length || 1;
  return Math.hypot(re, im) / n;
}

export function kuramotoStep(phases, omegas, K) {
  const n = phases.length;
  const next = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += Math.sin(phases[j] - phases[i]);
    next[i] = phases[i] + omegas[i] + (K / n) * s;
  }
  return next;
}

export function loraFreq(i) {
  return 432 * ((i * PHI) % 1);
}
