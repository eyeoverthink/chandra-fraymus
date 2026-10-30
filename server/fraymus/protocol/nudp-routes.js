// NUDP/1 REST API routes
import { db } from '../../db.js';
import { randomUUID } from 'node:crypto';
import {
  encodeNUDP, decodeNUDP, MSG, FLAG, TLV, MSG_NAMES,
  helloPacket, telemetryPacket, alertPacket, welfarePacket, ackPacket,
  sourceIdFromPubkey, nextSeq,
} from './nudp.js';
import { wrapWasm, transmute } from '../encoding/wasm.js';
import { createNode, getNode, destroyNode, migrateNUDP } from './mesh-node.js';

const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

export function installNUDPRoutes(app) {
  migrateNUDP();

  // ── Encode a datagram ──────────────────────────────
  app.post('/api/nudp/encode', route(async (req, res) => {
    const { type, flags, hopLimit, sourceId, tlvs } = req.body;
    if (type == null) return res.status(400).json({ error: 'type required' });
    const msgType = typeof type === 'string' ? MSG[type.toUpperCase()] : type;
    if (msgType == null) return res.status(400).json({ error: `Unknown type: ${type}` });

    let flagBits = 0;
    if (Array.isArray(flags)) {
      for (const f of flags) flagBits |= FLAG[f.toUpperCase()] || 0;
    } else if (typeof flags === 'number') {
      flagBits = flags;
    }

    const parsedTlvs = (tlvs || []).map(t => ({
      type: typeof t.type === 'string' ? TLV[t.type.toUpperCase()] : t.type,
      value: t.value,
    }));

    const buf = encodeNUDP({
      type: msgType,
      flags: flagBits,
      hopLimit: hopLimit ?? 4,
      sourceId: sourceId ?? 0,
      seq: nextSeq(),
      tlvs: parsedTlvs,
    });

    res.json({
      size: buf.length,
      hex: Array.from(buf, b => b.toString(16).padStart(2, '0')).join(''),
      base64: Buffer.from(buf).toString('base64'),
    });
  }));

  // ── Decode a datagram ──────────────────────────────
  app.post('/api/nudp/decode', route(async (req, res) => {
    const { hex, base64 } = req.body;
    let buf;
    if (hex) buf = new Uint8Array((hex.match(/../g) || []).map(x => parseInt(x, 16)));
    else if (base64) buf = new Uint8Array(Buffer.from(base64, 'base64'));
    else return res.status(400).json({ error: 'hex or base64 required' });

    const result = decodeNUDP(buf);
    res.json(result);
  }));

  // ── Encode + wrap in WASM ──────────────────────────
  app.post('/api/nudp/wrap', route(async (req, res) => {
    const { type, flags, hopLimit, sourceId, tlvs } = req.body;
    if (type == null) return res.status(400).json({ error: 'type required' });
    const msgType = typeof type === 'string' ? MSG[type.toUpperCase()] : type;
    if (msgType == null) return res.status(400).json({ error: `Unknown type: ${type}` });

    let flagBits = 0;
    if (Array.isArray(flags)) {
      for (const f of flags) flagBits |= FLAG[f.toUpperCase()] || 0;
    } else if (typeof flags === 'number') {
      flagBits = flags;
    }

    const parsedTlvs = (tlvs || []).map(t => ({
      type: typeof t.type === 'string' ? TLV[t.type.toUpperCase()] : t.type,
      value: t.value,
    }));

    const datagram = encodeNUDP({
      type: msgType,
      flags: flagBits,
      hopLimit: hopLimit ?? 4,
      sourceId: sourceId ?? 0,
      seq: nextSeq(),
      tlvs: parsedTlvs,
    });

    const wasmBuf = wrapWasm(datagram);

    res.json({
      datagramSize: datagram.length,
      wasmSize: wasmBuf.length,
      datagramHex: Array.from(datagram, b => b.toString(16).padStart(2, '0')).join(''),
      wasmBase64: Buffer.from(wasmBuf).toString('base64'),
    });
  }));

  // ── Full transmute (WASM with identity) ────────────
  app.post('/api/nudp/transmute', route(async (req, res) => {
    const { type, flags, hopLimit, sourceId, tlvs } = req.body;
    if (type == null) return res.status(400).json({ error: 'type required' });
    const msgType = typeof type === 'string' ? MSG[type.toUpperCase()] : type;

    let flagBits = 0;
    if (Array.isArray(flags)) {
      for (const f of flags) flagBits |= FLAG[f.toUpperCase()] || 0;
    } else if (typeof flags === 'number') {
      flagBits = flags;
    }

    const parsedTlvs = (tlvs || []).map(t => ({
      type: typeof t.type === 'string' ? TLV[t.type.toUpperCase()] : t.type,
      value: t.value,
    }));

    const datagram = encodeNUDP({
      type: msgType,
      flags: flagBits,
      hopLimit: hopLimit ?? 4,
      sourceId: sourceId ?? 0,
      seq: nextSeq(),
      tlvs: parsedTlvs,
    });

    const fakeFile = {
      name: `nudp-${Date.now()}.bin`,
      arrayBuffer: () => Promise.resolve(datagram.buffer.slice(datagram.byteOffset, datagram.byteOffset + datagram.byteLength)),
    };
    const wasmResult = await transmute(fakeFile);

    res.json({
      datagramSize: datagram.length,
      wasmSize: wasmResult.wasm.length,
      sha256: wasmResult.sha256,
      ledger: wasmResult.ledger,
      dnaPreview: wasmResult.dna ? Array.from(wasmResult.dna.slice(0, 32), b => b.toString(16).padStart(2, '0')).join('') : null,
    });
  }));

  // ── Node control ───────────────────────────────────
  app.post('/api/nudp/node/start', route(async (req, res) => {
    const { sourceId, bridgeIds, dataDir } = req.body || {};
    const node = createNode({ sourceId, bridgeIds, dataDir });
    const result = await node.start();
    res.json(result);
  }));

  app.post('/api/nudp/node/stop', route(async (_req, res) => {
    const node = getNode();
    if (!node) return res.json({ stopped: true, wasRunning: false });
    const result = node.stop();
    destroyNode();
    res.json(result);
  }));

  app.get('/api/nudp/node/status', route(async (_req, res) => {
    const node = getNode();
    if (!node) return res.json({ running: false });
    res.json(node.status());
  }));

  app.get('/api/nudp/node/peers', route(async (_req, res) => {
    const node = getNode();
    if (!node) return res.json({ peers: [], nodeRunning: false });
    res.json({ peers: node.peers(), nodeRunning: true });
  }));

  // ── Inject a local packet (for testing) ────────────
  app.post('/api/nudp/node/inject', route(async (req, res) => {
    const node = getNode();
    if (!node) return res.status(400).json({ error: 'Node not running' });
    const { type, flags, hopLimit, sourceId, tlvs } = req.body;
    const msgType = typeof type === 'string' ? MSG[type.toUpperCase()] : type;
    const parsedTlvs = (tlvs || []).map(t => ({
      type: typeof t.type === 'string' ? TLV[t.type.toUpperCase()] : t.type,
      value: t.value,
    }));
    let flagBits = 0;
    if (Array.isArray(flags)) {
      for (const f of flags) flagBits |= FLAG[f.toUpperCase()] || 0;
    }
    const result = await node.injectLocal({
      type: msgType ?? MSG.TELEMETRY,
      flags: flagBits,
      hopLimit: hopLimit ?? 4,
      sourceId: sourceId ?? 0,
      seq: nextSeq(),
      tlvs: parsedTlvs,
    });
    res.json(result);
  }));

  // ── Packet log (from DB) ───────────────────────────
  app.get('/api/nudp/packets', route(async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const type = req.query.type;
    let rows;
    if (type) {
      rows = db.prepare('SELECT * FROM nudp_packets WHERE type = ? ORDER BY created_at DESC LIMIT ?').all(type.toUpperCase(), limit);
    } else {
      rows = db.prepare('SELECT * FROM nudp_packets ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    res.json({ packets: rows, count: rows.length });
  }));

  // ── Protocol info ──────────────────────────────────
  app.get('/api/nudp/info', (_req, res) => {
    res.json({
      protocol: 'NUDP/1',
      magic: '0x4E44',
      version: 1,
      port: 47331,
      messageTypes: Object.entries(MSG).map(([name, code]) => ({ name, code })),
      flags: Object.entries(FLAG).map(([name, bit]) => ({ name, bit })),
      tlvTypes: Object.entries(TLV).map(([name, code]) => ({ name, code })),
      headerSize: 16,
      maxHops: 4,
      dedupRing: 64,
      helloIntervalMs: 30000,
    });
  });
}
