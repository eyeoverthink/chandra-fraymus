/**
 * Hive Mesh — Phase U: this machine becomes a node, not just a server.
 *
 * Two real transports, both of which existed as code and neither of which was ever
 * started at boot:
 *   - NUDP/1 (server/fraymus/protocol/mesh-node.js) — UDP :47331. The node is created
 *     with a source id derived from the persistent Ed25519 system identity, seeded with
 *     configured neighbours (MESH_PEERS, default the Raspberry Pi at 10.0.0.162:47100)
 *     so HELLO packets are actually sent, and peers persist across restarts.
 *   - V13 hub (server/fraymus/protocol/hub.js) — HTTPS relay at DEFAULT_RELAY. The node
 *     registers its identity every 10 min so the hub directory lists it, and reads the
 *     directory back to see who else is present.
 *
 * Honesty note: the Pi runs `fmp1`, a different protocol on UDP 47100 with its own
 * Ed25519 roster. Sending NUDP HELLOs at it is harmless and will show whether it
 * answers; joining its roster needs `fmp1 keygen` on this PC and a roster entry on the
 * Pi — an operator step, reported as such in status.
 *
 * Third transport (2026-11-08): a real FMP/1 node now runs beside the NUDP node as a
 * supervised Python child (fmp1-node.js) using Chandra's own FMP/1 identity
 * (a55799181f41d3f8) and the operator-signed roster. Its inbox is bridged onto the bus.
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { DATA_DIR } from '../config.js';
import { getSystemIdentity } from '../fraymus/core/system-identity.js';
import { createNode, getNode } from '../fraymus/protocol/mesh-node.js';
import { sourceIdFromPubkey } from '../fraymus/protocol/nudp.js';
import { liveRegister, liveDirectory, hubTokenSource } from '../fraymus/protocol/hub.js';
import { presenceStatus } from '../fraymus/protocol/presence.js';
import { DEFAULT_RELAY } from '../fraymus/core/constants.js';
import { startFmp1Node, stopFmp1Node, getFmp1Status, installFmp1Routes } from './fmp1-node.js';

const now = () => Date.now();
const REGISTER_INTERVAL_MS = 10 * 60_000;
const DEFAULT_PEERS = '10.0.0.163:47100';
const SKILLS = ['chandra', 'nudp', 'consciousness-audit', 'goal-executor', 'self-audit', 'hive-export'];

let registerTimer = null;
let state = {
  running: false,
  identity: null,          // { name, pubkey, number } — never the private key
  node: null,              // last node.start() result
  seededPeers: [],
  hub: { registered: false, lastRegisterAt: 0, lastError: null, directory: null, selfInDirectory: false, online: 0, idle: 0 },
  operatorSteps: [],
};

function parsePeers() {
  const raw = process.env.MESH_PEERS ?? DEFAULT_PEERS;
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const [addr, port] = s.split(':');
    return { addr, port: parseInt(port, 10) || 47331, label: addr === '10.0.0.163' ? 'raspberry-pi fmp1 (NUDP HELLOs are a probe only; the real link is the FMP/1 node)' : null };
  });
}

export async function startHiveMesh() {
  if (state.running) return getHiveMeshStatus();
  const identity = await getSystemIdentity();
  state.identity = { name: identity.name, pubkey: identity.pubkey, number: identity.number };

  const sourceId = await sourceIdFromPubkey(identity.pubkey);
  const node = getNode() || createNode({ sourceId, dataDir: DATA_DIR, onMessage: (pkt) => {
    try { publish('hive-mesh', 'hive.mesh.packet', JSON.stringify({ type: pkt.typeName, sourceId: pkt.sourceId, seq: pkt.seq })); } catch {}
  } });
  state.node = await node.start();

  state.seededPeers = [];
  for (const p of parsePeers()) {
    const r = node.addPeer(p);
    if (r.added) state.seededPeers.push({ ...r, label: p.label });
  }
  // FMP/1 — the protocol the Pi actually speaks. Started here so the hive has one lifecycle.
  const f = startFmp1Node();
  state.fmp1Start = f;
  // Roster pushed to the Pi 2026-11-09 (its roster version now matches ours). Discovery itself
  // never consulted the roster — HELLO reachability did; see fmp1-node.js detectBindAddress().
  state.operatorSteps = f.started
    ? ['If the FMP/1 link stays one-way (Pi lists Chandra, Chandra lists nobody), add Chandra as a static unicast peer on the Pi so its HELLOs do not depend on Wi-Fi multicast: `--peer <this PC\'s LAN IP>:47100` in the fmp1 service on fraymus-pi, then restart it.']
    : [`FMP/1 node not started: ${f.reason}`];

  state.running = true;
  await registerOnHub().catch(() => {});
  registerTimer = setInterval(() => { registerOnHub().catch(() => {}); }, REGISTER_INTERVAL_MS);
  try { publish('hive-mesh', 'hive.mesh.started', JSON.stringify({ sourceId, port: state.node.port, peers: state.seededPeers.length, number: identity.number })); } catch {}
  return getHiveMeshStatus();
}

export function stopHiveMesh() {
  if (registerTimer) { clearInterval(registerTimer); registerTimer = null; }
  try { stopFmp1Node(); } catch (e) { console.error('[hive-mesh] fmp1 stop:', e.message); }
  state.running = false;
  return { stopped: true };
}

export async function registerOnHub() {
  const identity = await getSystemIdentity();
  try {
    const reg = await liveRegister(identity, SKILLS, DEFAULT_RELAY);
    state.hub.registered = !(reg && reg.error);
    state.hub.lastRegisterAt = now();
    state.hub.lastError = reg?.error ? String(reg.error).slice(0, 200) : null;
  } catch (e) {
    state.hub.registered = false;
    state.hub.lastRegisterAt = now();
    state.hub.lastError = e.message.slice(0, 200);
  }
  try {
    const dir = await liveDirectory(DEFAULT_RELAY);
    const agents = Array.isArray(dir?.agents) ? dir.agents : [];
    let online = 0, idle = 0;
    for (const a of agents) { const s = presenceStatus(a); if (s === 'online') online++; else if (s === 'idle') idle++; }
    state.hub.directory = agents.map(a => ({ name: a.name, number: a.number, status: presenceStatus(a), skills: a.skills })).slice(0, 50);
    state.hub.selfInDirectory = agents.some(a => a.pubkey === identity.pubkey || a.number === identity.number);
    state.hub.online = online; state.hub.idle = idle;
  } catch (e) {
    state.hub.lastError = state.hub.lastError || e.message.slice(0, 200);
  }
  return state.hub;
}

export function getHiveMeshStatus() {
  const node = getNode();
  const peers = node ? node.peers() : [];
  const fmp1 = getFmp1Status();
  const fmp1Neighbors = Array.isArray(fmp1.status?.neighbors) ? fmp1.status.neighbors : [];
  return {
    running: state.running,
    identity: state.identity,
    node: node ? node.status() : null,
    peers: peers.map(p => ({ sourceId: p.sourceId, addr: p.addr, port: p.port, seeded: !!p.seeded, restored: !!p.restored, label: p.label || null, lastSeen: p.lastSeen })),
    heardFromPeers: peers.filter(p => !p.seeded && !p.restored).length,
    fmp1: {
      enabled: fmp1.enabled, running: fmp1.running, pid: fmp1.pid, uptimeMs: fmp1.uptimeMs, exits: fmp1.exits,
      nodeId: fmp1.status?.node_id || null, state: fmp1.status?.state || null, addr: fmp1.status?.addr || null,
      neighbors: fmp1Neighbors, bidirNeighbors: fmp1Neighbors.filter(n => n.bidir).length,
      routes: fmp1.status?.routes ? Object.keys(fmp1.status.routes).length : 0,
      rosterVersion: fmp1.status?.roster_version ?? null, receipts: fmp1.status?.receipts?.count ?? null,
      lastError: fmp1.status?.last_error || fmp1.statusError || null,
      inbox: fmp1.inbox, config: fmp1.config,
    },
    hub: { ...state.hub, relay: DEFAULT_RELAY, registerIntervalMs: REGISTER_INTERVAL_MS, tokenConfigured: !!hubTokenSource(), tokenSource: hubTokenSource() },
    operatorSteps: [
      ...state.operatorSteps,
      ...(/unauthorized/i.test(state.hub.lastError || '') ? ['Hub registration is unauthorized: point FRAYMUS_HUB_TOKEN_FILE in .env at a file holding the write-tier token (preferred — a stale process-level FRAYMUS_HUB_TOKEN would otherwise shadow .env), or set FRAYMUS_HUB_TOKEN. The hub at ' + DEFAULT_RELAY + ' is your VPS; the token is yours.'] : []),
    ],
  };
}

export function installHiveMeshRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/hive-mesh', route((_req, res) => res.json(getHiveMeshStatus())));
  installFmp1Routes(app);
  app.post('/api/intelligence/hive-mesh/register', route(async (_req, res) => res.json(await registerOnHub())));
  app.post('/api/intelligence/hive-mesh/peer', route((req, res) => {
    const node = getNode();
    if (!node) return res.status(409).json({ error: 'mesh node not started' });
    const addr = String(req.body?.addr || '').slice(0, 64);
    const port = parseInt(req.body?.port, 10);
    if (!/^[0-9a-zA-Z.:-]+$/.test(addr) || !(port > 0 && port < 65536)) return res.status(400).json({ error: 'valid addr and port required' });
    res.json(node.addPeer({ addr, port, label: String(req.body?.label || '').slice(0, 80) || null }));
  }));
}
