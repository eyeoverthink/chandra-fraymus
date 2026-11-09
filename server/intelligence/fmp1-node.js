/**
 * FMP/1 node supervisor — Phase U, Pi mesh.
 *
 * The Raspberry Pi speaks FMP/1 (Vaughn's Python prototype: UDP 47100, Ed25519 key
 * cards, operator-root-signed roster), not NUDP. Chandra's FMP/1 identity
 * (node a55799181f41d3f8) and the signed roster live in ~/.fmp1. This module runs a
 * real FMP/1 node as a supervised child process (`python -m fmp1 … node --lan`),
 * talks to it over its localhost JSON control socket (authenticated by
 * <data-dir>/control.token), and bridges its inbox onto the Chandra bus.
 *
 * Config (env): FMP1_ENABLED (default on when the data dir holds identity.key),
 * FMP1_PYTHON (python), FMP1_DATA_DIR (~/.fmp1), FMP1_PORT (47100),
 * FMP1_CONTROL_PORT (47101), FMP1_PEERS (10.0.0.163:47100), FMP1_ROSTER
 * (<data-dir>/roster.cbor), FMP1_ROOT_PUB (hex; default read from <data-dir>/root.pub).
 */

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';

const now = () => Date.now();
const DATA_DIR = process.env.FMP1_DATA_DIR || join(homedir(), '.fmp1');
const PYTHON = process.env.FMP1_PYTHON || 'python';
const PORT = parseInt(process.env.FMP1_PORT, 10) || 47100;
const CONTROL_PORT = parseInt(process.env.FMP1_CONTROL_PORT, 10) || 47101;
const PEERS = (process.env.FMP1_PEERS ?? '10.0.0.163:47100').split(',').map(s => s.trim()).filter(Boolean);
const ROSTER = process.env.FMP1_ROSTER || join(DATA_DIR, 'roster.cbor');
const ENABLED = process.env.FMP1_ENABLED ? process.env.FMP1_ENABLED !== '0' : existsSync(join(DATA_DIR, 'identity.key'));
const POLL_MS = 60_000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;
const LOG_LINES = 40;

let child = null;
let pollTimer = null;
let restarts = [];
let stopping = false;
const state = {
  enabled: ENABLED,
  running: false,
  pid: null,
  startedAt: 0,
  exits: 0,
  lastExit: null,
  log: [],
  status: null,
  statusAt: 0,
  statusError: null,
  inboxSeen: 0,
  lastInboxAt: 0,
};

function ensureTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS fmp1_messages (
    msg_id TEXT PRIMARY KEY,
    src TEXT,
    kind TEXT,
    text TEXT,
    received_at INTEGER NOT NULL
  )`).run();
}
try { ensureTable(); } catch (e) { console.error('[fmp1] schema:', e.message); }

function rootPub() {
  if (process.env.FMP1_ROOT_PUB) return process.env.FMP1_ROOT_PUB.trim();
  try { return readFileSync(join(DATA_DIR, 'root.pub'), 'utf8').trim(); } catch { return null; }
}

function log(line) {
  state.log.push(`${new Date().toISOString()} ${line}`.slice(0, 300));
  if (state.log.length > LOG_LINES) state.log.shift();
}

// Which local IPv4 shares a subnet with the first peer? Needed because this PC is multi-homed
// (Wi-Fi + Hyper-V + WSL + Tailscale): an fmp1 node bound to 0.0.0.0 joined the multicast group
// on the Hyper-V switch and sent its multicast HELLOs from 172.28.0.1, so the Pi's multicast
// never met ours (pktmon + `netsh interface ipv4 show joins`, 2026-11-09). Longest-prefix match
// over os.networkInterfaces() — synchronous, no socket. FMP1_BIND overrides; 'any' = 0.0.0.0.
const ip4 = s => s.split('.').reduce((n, o) => ((n << 8) | (parseInt(o, 10) & 255)) >>> 0, 0);
export function detectBindAddress(peers = PEERS) {
  const env = (process.env.FMP1_BIND || '').trim();
  if (env && env.toLowerCase() !== 'auto') return env.toLowerCase() === 'any' ? null : env;
  const first = peers[0];
  if (!first) return null;
  const host = first.includes(':') ? first.slice(0, first.lastIndexOf(':')) : first;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const peer = ip4(host);
  let best = null, bestBits = -1;
  try {
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family !== 'IPv4' && a.family !== 4) continue;
        if (a.internal || !a.netmask) continue;
        const mask = ip4(a.netmask);
        if (((ip4(a.address) & mask) >>> 0) !== ((peer & mask) >>> 0)) continue;
        const bits = a.netmask.split('.').reduce((n, o) => n + ((parseInt(o, 10) >>> 0).toString(2).match(/1/g) || []).length, 0);
        if (bits > bestBits) { best = a.address; bestBits = bits; state.bindIface = name; }
      }
    }
  } catch (e) { log(`bind auto-detect failed: ${e.message}`); }
  return best;
}

function buildArgs() {
  const args = ['-m', 'fmp1', '--data-dir', DATA_DIR, '--control-port', String(CONTROL_PORT), 'node', '--lan', '--port', String(PORT)];
  const bind = detectBindAddress();
  state.bind = bind;
  if (bind) args.push('--bind', bind);
  for (const p of PEERS) args.push('--peer', p);
  const rp = rootPub();
  if (existsSync(ROSTER) && rp) args.push('--roster', ROSTER, '--root-pub', rp);
  return args;
}

export function startFmp1Node() {
  if (!ENABLED) return { started: false, reason: 'disabled: no identity.key in ' + DATA_DIR + ' (run `python -m fmp1 keygen`) or FMP1_ENABLED=0' };
  if (child) return { started: false, reason: 'already running', pid: child.pid };
  stopping = false;
  const args = buildArgs();
  try {
    child = spawn(PYTHON, args, { cwd: homedir(), env: { ...process.env, PYTHONUNBUFFERED: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(`spawn failed: ${e.message}`);
    return { started: false, reason: e.message };
  }
  state.running = true; state.pid = child.pid; state.startedAt = now();
  log(`spawned pid ${child.pid}: ${PYTHON} ${args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ').replace(rootPub() || '§', '<root-pub>')}`);
  const onLine = (prefix) => (buf) => { for (const l of String(buf).split(/\r?\n/)) if (l.trim()) log(`${prefix} ${l.trim()}`); };
  child.stdout.on('data', onLine('out'));
  child.stderr.on('data', onLine('err'));
  child.on('exit', (code, signal) => {
    state.running = false; state.pid = null; state.exits++;
    state.lastExit = { code, signal, at: now() };
    log(`exited code=${code} signal=${signal}`);
    child = null;
    if (stopping) return;
    restarts = restarts.filter(t => now() - t < RESTART_WINDOW_MS);
    if (restarts.length >= MAX_RESTARTS) { log(`not restarting: ${MAX_RESTARTS} exits in ${RESTART_WINDOW_MS / 60000} min`); return; }
    restarts.push(now());
    const delay = Math.min(60_000, 2000 * 2 ** restarts.length);
    log(`restarting in ${delay / 1000}s`);
    setTimeout(() => { if (!stopping) startFmp1Node(); }, delay);
  });
  if (!pollTimer) {
    pollTimer = setInterval(() => { pollStatus().catch(() => {}); pollInbox().catch(() => {}); }, POLL_MS);
    setTimeout(() => { pollStatus().catch(() => {}); }, 8000);
  }
  try { publish('fmp1', 'hive.fmp1.started', JSON.stringify({ pid: child.pid, port: PORT, peers: PEERS, roster: existsSync(ROSTER) })); } catch {}
  return { started: true, pid: child.pid, port: PORT, controlPort: CONTROL_PORT, peers: PEERS, roster: existsSync(ROSTER) };
}

export function stopFmp1Node() {
  stopping = true;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (child) { try { child.kill(); } catch {} }
  return { stopped: true };
}

// Never orphan the Python node: if the server dies without stopDaemon(), take the child with it.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.once(sig, () => { if (child) { try { child.kill(); } catch {} } });
}

// Localhost JSON control socket (same wire format as fmp1/cli.py _control()).
export function fmp1Control(req, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let token;
    try { token = readFileSync(join(DATA_DIR, 'control.token'), 'utf8').trim(); } catch (e) { return reject(new Error('no control token; node not running?')); }
    const sock = createConnection({ host: '127.0.0.1', port: CONTROL_PORT }, () => {
      sock.write(JSON.stringify({ ...req, token }) + '\n');
    });
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('control timeout')); }, timeoutMs);
    sock.on('data', d => { buf += d; if (buf.endsWith('\n')) { clearTimeout(t); sock.end(); } });
    sock.on('end', () => { clearTimeout(t); try { const r = JSON.parse(buf); r.ok ? resolve(r.result) : reject(new Error(r.error || 'control error')); } catch (e) { reject(e); } });
    sock.on('error', e => { clearTimeout(t); reject(e); });
  });
}

export async function pollStatus() {
  try {
    state.status = await fmp1Control({ cmd: 'status' });
    state.statusAt = now(); state.statusError = null;
  } catch (e) {
    state.statusError = e.message.slice(0, 160);
  }
  return state.status;
}

export async function pollInbox() {
  let rows;
  try { rows = await fmp1Control({ cmd: 'inbox', limit: 50 }); } catch (e) { return { error: e.message }; }
  if (!Array.isArray(rows)) return { ingested: 0 };
  let ingested = 0;
  for (const r of rows) {
    const msgId = String(r.msg_id || '');
    if (!msgId) continue;
    const exists = db.prepare(`SELECT 1 FROM fmp1_messages WHERE msg_id = ?`).get(msgId);
    if (exists) continue;
    const body = r.body || {};
    const text = typeof body === 'string' ? body : (body.text || body.rendered || JSON.stringify(body));
    db.prepare(`INSERT OR IGNORE INTO fmp1_messages (msg_id, src, kind, text, received_at) VALUES (?, ?, ?, ?, ?)`).run(msgId, String(r.src || ''), String(r.kind || 'data'), String(text).slice(0, 4000), now());
    try { storeMemory(`fmp1:${r.src || 'unknown'}`, 'hive_message', `fmp1:${msgId}`, `[FMP/1 ${r.kind || 'data'} from ${r.src}] ${String(text).slice(0, 1500)}`, { confidence: 0.7, source: 'fmp1' }); } catch {}
    try { publish(`fmp1:${r.src || 'unknown'}`, 'hive.fmp1.message', JSON.stringify({ msgId, src: r.src, kind: r.kind, text: String(text).slice(0, 400) })); } catch {}
    ingested++;
  }
  if (ingested) { state.inboxSeen += ingested; state.lastInboxAt = now(); }
  return { ingested };
}

export async function fmp1Send(dst, text, { encrypt = false, wait = false } = {}) {
  if (!/^[0-9a-f]{16}$/i.test(String(dst))) throw new Error('dst must be a 16-hex node_id');
  return fmp1Control({ cmd: 'send', dst: String(dst), text: String(text).slice(0, 4000), encrypt: !!encrypt, unreliable: false, wait: !!wait, timeout: 30 }, { timeoutMs: 40_000 });
}

function neighborCount(s) {
  if (!s || typeof s !== 'object') return 0;
  for (const k of ['neighbors', 'neighbours', 'peers']) {
    const v = s[k];
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === 'object') return Object.keys(v).length;
    if (typeof v === 'number') return v;
  }
  return 0;
}

export function getFmp1Status() {
  return {
    enabled: ENABLED,
    running: state.running,
    pid: state.pid,
    startedAt: state.startedAt,
    uptimeMs: state.running ? now() - state.startedAt : 0,
    exits: state.exits,
    lastExit: state.lastExit,
    config: { dataDir: DATA_DIR, bind: state.bind ?? null, bindIface: state.bindIface ?? null, port: PORT, controlPort: CONTROL_PORT, peers: PEERS, roster: existsSync(ROSTER) ? ROSTER : null, rootPubConfigured: !!rootPub(), python: PYTHON },
    status: state.status,
    statusAt: state.statusAt,
    statusError: state.statusError,
    neighbors: neighborCount(state.status),
    inbox: { ingested: state.inboxSeen, lastAt: state.lastInboxAt },
    log: state.log.slice(-15),
  };
}

export function installFmp1Routes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/hive-mesh/fmp1', route(async (_req, res) => { await pollStatus(); res.json(getFmp1Status()); }));
  app.post('/api/intelligence/hive-mesh/fmp1/start', route((_req, res) => res.json(startFmp1Node())));
  app.post('/api/intelligence/hive-mesh/fmp1/stop', route((_req, res) => res.json(stopFmp1Node())));
  app.post('/api/intelligence/hive-mesh/fmp1/send', route(async (req, res) => {
    const { dst, text, encrypt, wait } = req.body || {};
    if (!dst || !text) return res.status(400).json({ error: 'dst and text required' });
    res.json(await fmp1Send(dst, text, { encrypt: encrypt === true, wait: wait === true }));
  }));
  app.get('/api/intelligence/hive-mesh/fmp1/inbox', route(async (_req, res) => {
    const r = await pollInbox();
    res.json({ ...r, messages: db.prepare(`SELECT * FROM fmp1_messages ORDER BY received_at DESC LIMIT 50`).all() });
  }));
}
