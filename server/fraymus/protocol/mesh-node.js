// NUDP/1 Mesh Node — forwarding, dedup, JSONL log, WASM wrapping
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { sha256hex, crc32 } from '../core/crypto.js';
import { wrapWasm } from '../encoding/wasm.js';
import {
  decodeNUDP, encodeNUDP, MSG, FLAG, MSG_NAMES,
  helloPacket, nextSeq, sourceIdFromPubkey,
} from './nudp.js';
import { db } from '../../db.js';
import { publish } from '../../fleet/bus.js';

export const NUDP_PORT = 47331;
const MAX_DEDUP = 64;
const HELLO_INTERVAL_MS = 30_000;
const DEFAULT_HOP_LIMIT = 4;

// ── Dedup ring buffer ────────────────────────────────
class DedupRing {
  constructor(size = MAX_DEDUP) {
    this._buf = new Array(size);
    this._idx = 0;
    this._size = size;
  }
  seen(sourceId, seq) {
    const key = `${sourceId}:${seq}`;
    if (this._buf.includes(key)) return true;
    this._buf[this._idx] = key;
    this._idx = (this._idx + 1) % this._size;
    return false;
  }
}

// ── JSONL log with SHA-256 sealing ───────────────────
class SealedLog {
  constructor(logDir) {
    mkdirSync(logDir, { recursive: true });
    this._path = join(logDir, `nudp-${new Date().toISOString().slice(0, 10)}.jsonl`);
    this._stream = createWriteStream(this._path, { flags: 'a' });
    this._prevHash = 'genesis';
  }
  async append(record) {
    const entry = {
      ...record,
      ts: Date.now(),
      prev: this._prevHash,
    };
    const line = JSON.stringify(entry);
    this._prevHash = await sha256hex(line);
    entry.hash = this._prevHash;
    this._stream.write(JSON.stringify(entry) + '\n');
    return entry;
  }
  close() { this._stream.end(); }
}

// ── Peer tracker ─────────────────────────────────────
class PeerTracker {
  constructor() { this._peers = new Map(); }
  seen(sourceId, meta = {}) {
    this._peers.set(sourceId, { lastSeen: Date.now(), ...meta });
  }
  list() {
    return [...this._peers.entries()].map(([id, info]) => ({ sourceId: id, ...info }));
  }
  get(sourceId) { return this._peers.get(sourceId); }
}

// ── Mesh Node ────────────────────────────────────────
export class MeshNode {
  constructor({ dataDir, sourceId, bridgeIds = [], onMessage } = {}) {
    this._sourceId = sourceId || 0;
    this._bridgeIds = new Set(bridgeIds.map(Number));
    this._dedup = new DedupRing(MAX_DEDUP);
    this._peers = new PeerTracker();
    this._log = new SealedLog(join(dataDir || 'data', 'nudp'));
    this._onMessage = onMessage || (() => {});
    this._socket = null;
    this._helloTimer = null;
    this._running = false;
    this._stats = { received: 0, forwarded: 0, dropped: 0, logged: 0 };
  }

  async start() {
    if (this._running) return { already: true };
    this._running = true;

    try {
      this._socket = createSocket('udp4');
      this._socket.on('message', (msg, rinfo) => this._handleIncoming(msg, rinfo));
      await new Promise((resolve, reject) => {
        this._socket.bind(NUDP_PORT, () => resolve());
        this._socket.once('error', reject);
      });
    } catch (e) {
      this._socket = null;
    }

    this._helloTimer = setInterval(() => {
      const pkt = helloPacket(this._sourceId);
      this._broadcast(pkt);
    }, HELLO_INTERVAL_MS);

    return { started: true, port: NUDP_PORT, sourceId: this._sourceId };
  }

  stop() {
    this._running = false;
    if (this._helloTimer) { clearInterval(this._helloTimer); this._helloTimer = null; }
    if (this._socket) { this._socket.close(); this._socket = null; }
    this._log.close();
    return { stopped: true, stats: { ...this._stats } };
  }

  status() {
    return {
      running: this._running,
      sourceId: this._sourceId,
      port: NUDP_PORT,
      peers: this._peers.list().length,
      stats: { ...this._stats },
    };
  }

  peers() { return this._peers.list(); }

  async _handleIncoming(raw, rinfo) {
    try {
      const pkt = decodeNUDP(new Uint8Array(raw));
      if (!pkt.valid) { this._stats.dropped++; return; }
      this._stats.received++;
      this._peers.seen(pkt.sourceId, { addr: rinfo?.address, port: rinfo?.port });

      if (this._dedup.seen(pkt.sourceId, pkt.seq)) {
        this._stats.dropped++;
        return;
      }

      if (pkt.type === MSG.ALERT && (pkt.flags & FLAG.OFFICIAL)) {
        if (!this._bridgeIds.has(pkt.sourceId)) {
          this._stats.dropped++;
          return;
        }
      }

      const entry = await this._log.append({
        type: pkt.typeName,
        sourceId: pkt.sourceId,
        seq: pkt.seq,
        flags: pkt.flagNames,
        hopLimit: pkt.hopLimit,
        tlvs: pkt.tlvs,
        from: rinfo ? `${rinfo.address}:${rinfo.port}` : 'local',
      });
      this._stats.logged++;

      try { this._onMessage(pkt, entry); } catch {}
      try {
        publish('mesh-node', 'mesh.packet', JSON.stringify({
          type: pkt.typeName, sourceId: pkt.sourceId, seq: pkt.seq,
        }));
      } catch {}

      if (pkt.hopLimit > 0 && pkt.type !== MSG.ACK) {
        this._forward(raw, pkt);
      }
    } catch { this._stats.dropped++; }
  }

  _forward(raw, pkt) {
    const buf = new Uint8Array(raw);
    buf[5] = pkt.hopLimit - 1;
    const payload = buf.subarray(16, 16 + new DataView(buf.buffer, buf.byteOffset).getUint16(14, false));
    const newCrc = crc32(buf.subarray(0, 16 + payload.length));
    new DataView(buf.buffer, buf.byteOffset).setUint32(16 + payload.length, newCrc, false);
    this._broadcast(buf);
    this._stats.forwarded++;
  }

  _broadcast(buf) {
    if (!this._socket) return;
    for (const peer of this._peers.list()) {
      if (peer.addr && peer.port) {
        try { this._socket.send(buf, peer.port, peer.addr); } catch {}
      }
    }
  }

  async injectLocal(pkt) {
    const raw = pkt instanceof Uint8Array ? pkt : encodeNUDP(pkt);
    await this._handleIncoming(raw, { address: '127.0.0.1', port: NUDP_PORT });
    return { injected: true, size: raw.length };
  }

  async wrapInWasm(datagram) {
    const buf = datagram instanceof Uint8Array ? datagram : encodeNUDP(datagram);
    const wasmBuf = wrapWasm(buf);
    return { wasm: wasmBuf, datagramSize: buf.length, wasmSize: wasmBuf.length };
  }
}

// ── DB tables ────────────────────────────────────────
export function migrateNUDP() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nudp_packets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packet_id TEXT NOT NULL,
      type TEXT NOT NULL,
      source_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      flags TEXT DEFAULT '[]',
      hop_limit INTEGER NOT NULL,
      tlvs TEXT DEFAULT '[]',
      raw_size INTEGER NOT NULL,
      wasm_wrapped INTEGER DEFAULT 0,
      from_addr TEXT,
      log_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nudp_src ON nudp_packets(source_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nudp_type ON nudp_packets(type, created_at DESC);

    CREATE TABLE IF NOT EXISTS nudp_peers (
      source_id INTEGER PRIMARY KEY,
      addr TEXT,
      port INTEGER,
      last_seen INTEGER NOT NULL,
      hello_count INTEGER DEFAULT 0,
      meta TEXT DEFAULT '{}'
    );
  `);
}

// ── Singleton node instance ──────────────────────────
let _node = null;

export function getNode() { return _node; }

export function createNode(opts = {}) {
  if (_node) return _node;
  _node = new MeshNode(opts);
  return _node;
}

export function destroyNode() {
  if (_node) { _node.stop(); _node = null; }
}
