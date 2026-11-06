/**
 * Awareness Layer — Protocol Engine
 *
 * Named operational protocol system inspired by Brahma's FlowStateManager.
 * Protocols define system-wide behavioral profiles that modulate autonomy,
 * intelligence depth, and interaction style.
 *
 * 5 built-in protocols:
 *   sentinel  — default, balanced monitoring + response
 *   deep_work — minimal interruptions, max intelligence depth
 *   creative  — relaxed constraints, higher temperature, dream-heavy
 *   research  — systematic exploration, citation tracking
 *   lockdown  — minimal autonomy, manual-only operations
 *
 * Active protocol published to bus topic 'system.protocol'.
 * Other subsystems can query getActiveProtocol() to adjust behavior.
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const PROTOCOLS = {
  sentinel: {
    name: 'sentinel',
    label: 'Sentinel',
    description: 'Balanced monitoring and response — default operational mode',
    modifiers: {
      nudgeFrequency: 1.0,
      intelligenceDepth: 1.0,
      autonomyScale: 1.0,
      interruptionLevel: 'normal',
    },
  },
  deep_work: {
    name: 'deep_work',
    label: 'Deep Work',
    description: 'Minimal interruptions, maximum intelligence processing depth',
    modifiers: {
      nudgeFrequency: 0.2,
      intelligenceDepth: 1.5,
      autonomyScale: 1.2,
      interruptionLevel: 'critical_only',
    },
  },
  creative: {
    name: 'creative',
    label: 'Creative',
    description: 'Relaxed constraints, higher exploration, dream consolidation emphasis',
    modifiers: {
      nudgeFrequency: 0.5,
      intelligenceDepth: 1.2,
      autonomyScale: 1.3,
      interruptionLevel: 'low',
    },
  },
  research: {
    name: 'research',
    label: 'Research',
    description: 'Systematic exploration with citation tracking and deep recall',
    modifiers: {
      nudgeFrequency: 0.8,
      intelligenceDepth: 1.4,
      autonomyScale: 0.8,
      interruptionLevel: 'normal',
    },
  },
  lockdown: {
    name: 'lockdown',
    label: 'Lockdown',
    description: 'Minimal autonomy — manual operations only, all automations paused',
    modifiers: {
      nudgeFrequency: 1.5,
      intelligenceDepth: 0.5,
      autonomyScale: 0.1,
      interruptionLevel: 'all',
    },
  },
};

let activeProtocol = 'sentinel';
let activatedAt = now();
let protocolHistory = [];

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS protocol_events (
      id TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      previous TEXT,
      reason TEXT,
      created_at INTEGER NOT NULL
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_protocol_ts ON protocol_events(created_at)`).run();
  } catch (_) {}
}

ensureTable();

export function activateProtocol(name, reason = '') {
  if (!PROTOCOLS[name]) {
    return { activated: false, error: `unknown protocol: ${name}. Valid: ${Object.keys(PROTOCOLS).join(', ')}` };
  }

  const previous = activeProtocol;
  if (previous === name) {
    return { activated: false, reason: 'already_active', protocol: name };
  }

  activeProtocol = name;
  activatedAt = now();
  protocolHistory.push({ from: previous, to: name, reason, at: activatedAt });

  // Keep history bounded
  if (protocolHistory.length > 50) protocolHistory = protocolHistory.slice(-50);

  // Persist
  try {
    db.prepare(
      `INSERT INTO protocol_events (id, protocol, previous, reason, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(randomUUID().slice(0, 12), name, previous, reason, now());
  } catch (_) {}

  // Publish to bus
  try {
    publish('system.protocol', JSON.stringify({
      protocol: name,
      previous,
      reason,
      modifiers: PROTOCOLS[name].modifiers,
    }));
  } catch (_) {}

  return { activated: true, protocol: name, previous, modifiers: PROTOCOLS[name].modifiers };
}

export function getActiveProtocol() {
  return {
    name: activeProtocol,
    ...PROTOCOLS[activeProtocol],
    activatedAt,
    durationMinutes: Math.round((now() - activatedAt) / 60_000),
  };
}

export function getProtocolModifiers() {
  return PROTOCOLS[activeProtocol]?.modifiers || PROTOCOLS.sentinel.modifiers;
}

export function listProtocols() {
  return Object.values(PROTOCOLS).map(p => ({
    ...p,
    active: p.name === activeProtocol,
  }));
}

export function resetProtocol() {
  return activateProtocol('sentinel', 'reset');
}

export function getProtocolStatus() {
  return {
    active: getActiveProtocol(),
    available: Object.keys(PROTOCOLS),
    historyCount: protocolHistory.length,
    recentTransitions: protocolHistory.slice(-5),
  };
}

export function installProtocolRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/awareness/protocol', route((_req, res) => {
    res.json(getProtocolStatus());
  }));

  app.get('/api/awareness/protocol/list', route((_req, res) => {
    res.json({ protocols: listProtocols() });
  }));

  app.get('/api/awareness/protocol/modifiers', route((_req, res) => {
    res.json(getProtocolModifiers());
  }));

  app.post('/api/awareness/protocol/activate', route((req, res) => {
    const { protocol, reason } = req.body || {};
    if (!protocol) return res.status(400).json({ error: 'protocol name required' });
    res.json(activateProtocol(protocol, reason || ''));
  }));

  app.post('/api/awareness/protocol/reset', route((_req, res) => {
    res.json(resetProtocol());
  }));

  app.get('/api/awareness/protocol/history', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const rows = db.prepare(
      `SELECT * FROM protocol_events ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
    res.json({ events: rows });
  }));
}
