/**
 * External Senses — Phase Q: the organism's senses that point at the world.
 *
 * Every pre-existing sensory channel measured the system itself. These six read
 * outside it:
 *   web       — web research sources retained + trend signals seen (24 h)
 *   youtube   — outlier-board videos saved (24 h)
 *   commerce  — Shopify orders in the last 24 h via the Admin API (falls back to local
 *               commerce/distribution runs when no store is configured, and says so)
 *   mesh      — agents online/idle on the V13 hub directory + NUDP peers heard
 *   git       — commits in the last hour and dirty files in this repository
 *   user      — the user sensorium's activity/attention/engagement
 *
 * Network and shell sources are polled on a 60 s loop into a cache (the sensory bridge
 * is synchronous and ticks every 5 s); DB-backed sources are read live each tick.
 * Signals are [0, 1] and carry a `source` so a fallback is never mistaken for the real thing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { PROJECT_ROOT } from '../config.js';
import { publish } from '../fleet/bus.js';
import { shopifyHeaders, shopifyBase } from '../commerce/shared.js';
import { liveDirectory } from '../fraymus/protocol/hub.js';
import { presenceStatus } from '../fraymus/protocol/presence.js';
import { DEFAULT_RELAY } from '../fraymus/core/constants.js';
import { getNode } from '../fraymus/protocol/mesh-node.js';
import { getFmp1Status } from './fmp1-node.js';
import { getUserSensoriumStatus } from '../awareness/user-sensorium.js';

const execFileP = promisify(execFile);
const now = () => Date.now();
const DAY = 86400_000;
const POLL_INTERVAL_MS = 60_000;
const SNAPSHOT_EVERY = 10;
const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

let pollTimer = null;
let polls = 0;
let polling = false;
const cache = {
  commerce: { value: 0, source: 'unpolled', detail: null, at: 0, error: null },
  mesh:     { value: 0, source: 'unpolled', detail: null, at: 0, error: null },
  git:      { value: 0, source: 'unpolled', detail: null, at: 0, error: null },
};

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS external_sense_events (
    id TEXT PRIMARY KEY,
    signals TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_external_sense_ts ON external_sense_events(created_at)`).run();
}
try { ensureTable(); } catch (e) { console.error('[external-senses] schema:', e.message); }

// ─── Live DB-backed senses ───────────────────────────────────────

function senseWeb() {
  const since = now() - DAY;
  let sources = 0, trends = 0;
  try { sources = db.prepare(`SELECT COUNT(*) as c FROM agent_web_sources WHERE created_at > ?`).get(since)?.c || 0; } catch (_) {}
  try { trends = db.prepare(`SELECT COUNT(*) as c FROM trend_signals WHERE last_seen_at > ?`).get(since)?.c || 0; } catch (_) {}
  return { value: Math.max(clamp01(sources / 5), clamp01(trends / 10)), source: 'db', detail: { webSources24h: sources, trendSignals24h: trends } };
}

function senseYouTube() {
  const since = now() - DAY;
  let saved = 0;
  try { saved = db.prepare(`SELECT COUNT(*) as c FROM outlier_board WHERE created_at > ?`).get(since)?.c || 0; } catch (_) {}
  return { value: clamp01(saved / 5), source: 'db', detail: { outliersSaved24h: saved } };
}

function senseUser() {
  try {
    const s = getUserSensoriumStatus();
    const sig = s?.lastSignals || {};
    const vals = ['activity', 'attention', 'engagement'].map(k => Number(sig[k])).filter(Number.isFinite);
    if (!vals.length) return { value: 0, source: 'sensorium', detail: { readings: 0 } };
    return { value: clamp01(vals.reduce((a, b) => a + b, 0) / vals.length), source: 'sensorium', detail: { ...sig } };
  } catch (e) {
    return { value: 0, source: 'sensorium', detail: null, error: e.message };
  }
}

// ─── Polled senses (network / shell) ────────────────────────────

async function pollCommerce() {
  const headers = shopifyHeaders();
  const base = (() => { try { return shopifyBase(); } catch (_) { return null; } })();
  if (headers && base) {
    const since = new Date(now() - DAY).toISOString();
    const res = await fetch(`${base}/orders/count.json?status=any&created_at_min=${encodeURIComponent(since)}`, {
      headers, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const data = await res.json();
    const orders = Number(data?.count) || 0;
    return { value: clamp01(orders / 10), source: 'shopify', detail: { orders24h: orders, store: base.replace(/^https?:\/\//, '').split('/')[0] } };
  }
  // No store configured: local commerce activity, labelled as such.
  const since = now() - DAY;
  let runs = 0, dist = 0;
  try { runs = db.prepare(`SELECT COUNT(*) as c FROM commerce_pipeline_runs WHERE created_at > ?`).get(since)?.c || 0; } catch (_) {}
  try { dist = db.prepare(`SELECT COUNT(*) as c FROM distribution_runs WHERE created_at > ?`).get(since)?.c || 0; } catch (_) {}
  return { value: clamp01((runs + dist) / 3), source: 'local', detail: { pipelineRuns24h: runs, distributionRuns24h: dist, note: 'no SHOPIFY_ACCESS_TOKEN / store domain' } };
}

async function pollMesh() {
  let hubOnline = 0, hubIdle = 0, hubTotal = 0, hubError = null;
  try {
    const dir = await liveDirectory(DEFAULT_RELAY);
    const agents = Array.isArray(dir?.agents) ? dir.agents : [];
    hubTotal = agents.length;
    for (const a of agents) {
      const st = presenceStatus(a);
      if (st === 'online') hubOnline++;
      else if (st === 'idle') hubIdle++;
    }
  } catch (e) { hubError = e.message.slice(0, 120); }
  let udpPeers = 0;
  try { udpPeers = getNode()?.peers?.()?.length || 0; } catch (_) {}
  let dbPeers = 0;
  try { dbPeers = db.prepare(`SELECT COUNT(*) as c FROM nudp_peers WHERE last_seen > ?`).get(now() - 600_000)?.c || 0; } catch (_) {}
  // Phase U: the fleet talks on the fraymus-bridge; messages ingested in 24 h are peers speaking.
  let bridgeIn24h = 0, bridgeAgents24h = 0;
  try {
    const r = db.prepare(`SELECT COUNT(*) as c, COUNT(DISTINCT agent) as a FROM hive_bridge_messages WHERE direction = 'in' AND ingested_at > ?`).get(now() - DAY);
    bridgeIn24h = r?.c || 0; bridgeAgents24h = r?.a || 0;
  } catch (_) {}
  // FMP/1 (the Pi's protocol): bidirectional neighbours are real radio-level peers.
  let fmp1Neighbors = 0, fmp1Running = false;
  try {
    const f = getFmp1Status();
    fmp1Running = f.running;
    fmp1Neighbors = Array.isArray(f.status?.neighbors) ? f.status.neighbors.filter(n => n.bidir).length : 0;
  } catch (_) {}
  const live = hubOnline + hubIdle * 0.5 + Math.max(udpPeers, dbPeers) + bridgeAgents24h + fmp1Neighbors;
  return {
    value: clamp01(live / 5),
    source: hubError ? (udpPeers || dbPeers || bridgeIn24h || fmp1Neighbors ? 'nudp+bridge+fmp1' : 'unreachable') : 'hub+nudp+bridge+fmp1',
    detail: { hubOnline, hubIdle, hubTotal, udpPeers, dbPeers, bridgeIn24h, bridgeAgents24h, fmp1Running, fmp1Neighbors, relay: DEFAULT_RELAY, hubError },
    error: hubError,
  };
}

async function pollGit() {
  const opts = { cwd: PROJECT_ROOT, timeout: 10_000, windowsHide: true };
  const [log, status] = await Promise.all([
    execFileP('git', ['log', '--since=1 hour ago', '--oneline'], opts),
    execFileP('git', ['status', '--porcelain'], opts),
  ]);
  const commits = log.stdout.split('\n').filter(Boolean).length;
  const dirty = status.stdout.split('\n').filter(Boolean).length;
  return { value: clamp01(commits / 3) * 0.6 + clamp01(dirty / 10) * 0.4, source: 'git', detail: { commitsLastHour: commits, dirtyFiles: dirty } };
}

export async function pollExternalSenses() {
  if (polling) return { skipped: true, reason: 'poll_in_progress' };
  polling = true;
  const t0 = now();
  const results = await Promise.allSettled([pollCommerce(), pollMesh(), pollGit()]);
  const keys = ['commerce', 'mesh', 'git'];
  results.forEach((r, i) => {
    const k = keys[i];
    if (r.status === 'fulfilled') cache[k] = { ...r.value, at: now(), error: r.value.error || null };
    else cache[k] = { ...cache[k], at: now(), error: String(r.reason?.message || r.reason).slice(0, 200), source: cache[k].source === 'unpolled' ? 'error' : cache[k].source };
  });
  polls++;
  polling = false;

  if (polls % SNAPSHOT_EVERY === 1) {
    try {
      const signals = getExternalSignals();
      db.prepare(`INSERT INTO external_sense_events (id, signals, details, created_at) VALUES (?, ?, ?, ?)`)
        .run(randomUUID().slice(0, 12), JSON.stringify(signals), JSON.stringify(getExternalDetails()), now());
      db.prepare(`DELETE FROM external_sense_events WHERE created_at < ?`).run(now() - 7 * DAY);
    } catch (e) { console.error('[external-senses] snapshot:', e.message); }
  }
  return { polled: true, durationMs: now() - t0, signals: getExternalSignals() };
}

// Synchronous read used by the sensory bridge each tick.
export function getExternalSignals() {
  return {
    web: senseWeb().value,
    youtube: senseYouTube().value,
    commerce: cache.commerce.value,
    mesh: cache.mesh.value,
    git: cache.git.value,
    user: senseUser().value,
  };
}

export function getExternalDetails() {
  return {
    web: senseWeb(),
    youtube: senseYouTube(),
    commerce: cache.commerce,
    mesh: cache.mesh,
    git: cache.git,
    user: senseUser(),
  };
}

export function startExternalSenses({ intervalMs = POLL_INTERVAL_MS } = {}) {
  stopExternalSenses();
  pollTimer = setInterval(() => {
    pollExternalSenses().then(r => {
      if (r?.polled && polls % SNAPSHOT_EVERY === 1) {
        try { publish('external-senses', 'system.senses.external', JSON.stringify({ signals: r.signals, at: now() })); } catch (_) {}
      }
    }).catch(e => console.error('[external-senses] poll error:', e.message));
  }, intervalMs);
  pollExternalSenses().catch(e => console.error('[external-senses] first poll error:', e.message));
  return { started: true, intervalMs };
}

export function stopExternalSenses() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  return { stopped: true, polls };
}

export function getExternalSensesStatus() {
  return { running: !!pollTimer, polls, intervalMs: POLL_INTERVAL_MS, signals: getExternalSignals(), details: getExternalDetails() };
}

export function installExternalSensesRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/external-senses', route((_req, res) => res.json(getExternalSensesStatus())));
  app.get('/api/intelligence/external-senses/history', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ events: db.prepare(`SELECT * FROM external_sense_events ORDER BY created_at DESC LIMIT ?`).all(limit) });
  }));
  app.post('/api/intelligence/external-senses/poll', route(async (_req, res) => res.json(await pollExternalSenses())));
}
