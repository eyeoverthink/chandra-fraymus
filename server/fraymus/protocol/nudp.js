// NUDP/1 — sovereign mesh datagram protocol
// Binary format: [header 16B] [TLV payload NB] [CRC32 4B]
import { crc32 } from '../core/crypto.js';
import { randomUUID } from 'node:crypto';

// ── Magic & version ──────────────────────────────────
export const NUDP_MAGIC = 0x4E44;
export const NUDP_VERSION = 1;

// ── Message types ────────────────────────────────────
export const MSG = {
  HELLO:     0x00,
  TELEMETRY: 0x01,
  ALERT:     0x02,
  WELFARE:   0x03,
  ACK:       0x04,
};
export const MSG_NAMES = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));

// ── Flags ────────────────────────────────────────────
export const FLAG = {
  ACK_REQ:   0x01,
  VIA_RADIO: 0x02,
  OFFICIAL:  0x04,
};

// ── TLV type codes ───────────────────────────────────
export const TLV = {
  TEMPERATURE:  0x01,  // i16  °C × 100
  BATTERY:      0x02,  // u16  mV
  RSSI:         0x03,  // i8   dBm
  LATITUDE:     0x04,  // i32  deg × 1e7
  LONGITUDE:    0x05,  // i32  deg × 1e7
  CLIENT_COUNT: 0x06,  // u16
  ALERT_TEXT:   0x07,  // UTF-8 max 120B
  FEED_ID:      0x08,  // u16
  ACK_SEQ:      0x09,  // u32
};
export const TLV_NAMES = Object.fromEntries(Object.entries(TLV).map(([k, v]) => [v, k]));

// TLV value sizes (fixed-length types; ALERT_TEXT is variable)
const TLV_SIZES = {
  [TLV.TEMPERATURE]:  2,
  [TLV.BATTERY]:      2,
  [TLV.RSSI]:         1,
  [TLV.LATITUDE]:     4,
  [TLV.LONGITUDE]:    4,
  [TLV.CLIENT_COUNT]: 2,
  [TLV.FEED_ID]:      2,
  [TLV.ACK_SEQ]:      4,
};

// ── Header layout (16 bytes) ─────────────────────────
// Offset  Size  Field
// 0       2     Magic: 0x4E44
// 2       1     Version: 1
// 3       1     Flags
// 4       1     Type (HELLO/TELEMETRY/ALERT/WELFARE/ACK)
// 5       1     Hop limit (default 4)
// 6       4     Source ID (first 4 bytes of identity hash)
// 10      4     Sequence number
// 14      2     Payload length (big-endian)
const HEADER_SIZE = 16;
const CRC_SIZE = 4;

// ── Encode TLV payload ───────────────────────────────
export function encodeTLVs(entries) {
  const parts = [];
  for (const { type, value } of entries) {
    if (type === TLV.ALERT_TEXT) {
      const textBytes = new TextEncoder().encode(String(value).slice(0, 120));
      const tlv = new Uint8Array(3 + textBytes.length);
      tlv[0] = type;
      new DataView(tlv.buffer).setUint16(1, textBytes.length, false);
      tlv.set(textBytes, 3);
      parts.push(tlv);
    } else {
      const size = TLV_SIZES[type];
      if (!size) throw new Error(`Unknown TLV type: 0x${type.toString(16)}`);
      const tlv = new Uint8Array(3 + size);
      const dv = new DataView(tlv.buffer);
      tlv[0] = type;
      dv.setUint16(1, size, false);
      switch (type) {
        case TLV.TEMPERATURE:  dv.setInt16(3, value, false); break;
        case TLV.BATTERY:      dv.setUint16(3, value, false); break;
        case TLV.RSSI:         dv.setInt8(3, value); break;
        case TLV.LATITUDE:     dv.setInt32(3, value, false); break;
        case TLV.LONGITUDE:    dv.setInt32(3, value, false); break;
        case TLV.CLIENT_COUNT: dv.setUint16(3, value, false); break;
        case TLV.FEED_ID:      dv.setUint16(3, value, false); break;
        case TLV.ACK_SEQ:      dv.setUint32(3, value, false); break;
      }
      parts.push(tlv);
    }
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { buf.set(p, offset); offset += p.length; }
  return buf;
}

// ── Decode TLV payload ───────────────────────────────
export function decodeTLVs(payload) {
  const entries = [];
  let offset = 0;
  while (offset < payload.length) {
    if (offset + 3 > payload.length) break;
    const type = payload[offset];
    const dv = new DataView(payload.buffer, payload.byteOffset + offset);
    const len = dv.getUint16(1, false);
    if (offset + 3 + len > payload.length) break;
    const valBuf = payload.subarray(offset + 3, offset + 3 + len);
    const vdv = new DataView(valBuf.buffer, valBuf.byteOffset, valBuf.byteLength);
    let value;
    switch (type) {
      case TLV.TEMPERATURE:  value = vdv.getInt16(0, false); break;
      case TLV.BATTERY:      value = vdv.getUint16(0, false); break;
      case TLV.RSSI:         value = vdv.getInt8(0); break;
      case TLV.LATITUDE:     value = vdv.getInt32(0, false); break;
      case TLV.LONGITUDE:    value = vdv.getInt32(0, false); break;
      case TLV.CLIENT_COUNT: value = vdv.getUint16(0, false); break;
      case TLV.FEED_ID:      value = vdv.getUint16(0, false); break;
      case TLV.ACK_SEQ:      value = vdv.getUint32(0, false); break;
      case TLV.ALERT_TEXT:   value = new TextDecoder().decode(valBuf); break;
      default:               value = Array.from(valBuf); break;
    }
    entries.push({ type, name: TLV_NAMES[type] || `0x${type.toString(16)}`, value });
    offset += 3 + len;
  }
  return entries;
}

// ── Encode a full NUDP/1 datagram ────────────────────
export function encodeNUDP({ type, flags = 0, hopLimit = 4, sourceId, seq, tlvs = [] }) {
  if (!(type in MSG_NAMES)) throw new Error(`Invalid message type: ${type}`);
  const payload = encodeTLVs(tlvs);
  if (payload.length > 0xFFFF) throw new Error('TLV payload exceeds 65535 bytes');
  const total = HEADER_SIZE + payload.length + CRC_SIZE;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // Header
  dv.setUint16(0, NUDP_MAGIC, false);
  buf[2] = NUDP_VERSION;
  buf[3] = flags & 0xFF;
  buf[4] = type & 0xFF;
  buf[5] = Math.min(255, Math.max(0, hopLimit));
  dv.setUint32(6, (sourceId || 0) >>> 0, false);
  dv.setUint32(10, (seq || 0) >>> 0, false);
  dv.setUint16(14, payload.length, false);

  // Payload
  buf.set(payload, HEADER_SIZE);

  // CRC32 over header + payload
  const crcVal = crc32(buf.subarray(0, HEADER_SIZE + payload.length));
  dv.setUint32(HEADER_SIZE + payload.length, crcVal, false);

  return buf;
}

// ── Decode a NUDP/1 datagram ─────────────────────────
export function decodeNUDP(buf) {
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  if (buf.length < HEADER_SIZE + CRC_SIZE) return { valid: false, error: 'Too short' };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  const magic = dv.getUint16(0, false);
  if (magic !== NUDP_MAGIC) return { valid: false, error: `Bad magic: 0x${magic.toString(16)}` };

  const version = buf[2];
  if (version !== NUDP_VERSION) return { valid: false, error: `Unsupported version: ${version}` };

  const flags = buf[3];
  const type = buf[4];
  const hopLimit = buf[5];
  const sourceId = dv.getUint32(6, false);
  const seq = dv.getUint32(10, false);
  const payloadLen = dv.getUint16(14, false);

  if (buf.length < HEADER_SIZE + payloadLen + CRC_SIZE) {
    return { valid: false, error: 'Truncated payload' };
  }

  const payload = buf.subarray(HEADER_SIZE, HEADER_SIZE + payloadLen);
  const expectedCrc = crc32(buf.subarray(0, HEADER_SIZE + payloadLen));
  const actualCrc = dv.getUint32(HEADER_SIZE + payloadLen, false);
  if (expectedCrc !== actualCrc) {
    return { valid: false, error: `CRC mismatch: expected ${expectedCrc}, got ${actualCrc}` };
  }

  const tlvs = decodeTLVs(payload);

  return {
    valid: true,
    magic, version, flags, type,
    typeName: MSG_NAMES[type] || `0x${type.toString(16)}`,
    flagNames: Object.entries(FLAG).filter(([, v]) => flags & v).map(([k]) => k),
    hopLimit, sourceId, seq,
    tlvs,
    rawSize: HEADER_SIZE + payloadLen + CRC_SIZE,
  };
}

// ── Source ID from Ed25519 public key ────────────────
export async function sourceIdFromPubkey(pubkeyHex) {
  const { sha256hex } = await import('../core/crypto.js');
  const hash = await sha256hex(pubkeyHex);
  return parseInt(hash.slice(0, 8), 16) >>> 0;
}

// ── Generate sequence number ─────────────────────────
let _seqCounter = 0;
export function nextSeq() {
  return (++_seqCounter) >>> 0;
}

// ── Convenience builders ─────────────────────────────
export function helloPacket(sourceId) {
  return encodeNUDP({ type: MSG.HELLO, sourceId, seq: nextSeq() });
}

export function telemetryPacket(sourceId, { tempC, batteryMv, rssi, lat, lon, clients } = {}) {
  const tlvs = [];
  if (tempC != null) tlvs.push({ type: TLV.TEMPERATURE, value: Math.round(tempC * 100) });
  if (batteryMv != null) tlvs.push({ type: TLV.BATTERY, value: batteryMv });
  if (rssi != null) tlvs.push({ type: TLV.RSSI, value: rssi });
  if (lat != null) tlvs.push({ type: TLV.LATITUDE, value: Math.round(lat * 1e7) });
  if (lon != null) tlvs.push({ type: TLV.LONGITUDE, value: Math.round(lon * 1e7) });
  if (clients != null) tlvs.push({ type: TLV.CLIENT_COUNT, value: clients });
  return encodeNUDP({
    type: MSG.TELEMETRY,
    flags: FLAG.VIA_RADIO,
    sourceId, seq: nextSeq(), tlvs,
  });
}

export function alertPacket(sourceId, text, { official = false } = {}) {
  return encodeNUDP({
    type: MSG.ALERT,
    flags: official ? FLAG.OFFICIAL : 0,
    sourceId, seq: nextSeq(),
    tlvs: [{ type: TLV.ALERT_TEXT, value: text }],
  });
}

export function welfarePacket(sourceId) {
  return encodeNUDP({ type: MSG.WELFARE, sourceId, seq: nextSeq() });
}

export function ackPacket(sourceId, ackSeq) {
  return encodeNUDP({
    type: MSG.ACK,
    sourceId, seq: nextSeq(),
    tlvs: [{ type: TLV.ACK_SEQ, value: ackSeq }],
  });
}
