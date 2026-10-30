# Phase 27: NUDP/1 Sovereign Mesh Protocol

**Date:** 2026-10-30
**Prev:** [Phase 26 — Background Evolution Daemon](PHASE-26.md)
**Next:** [Phase 28 — Local Image Processing Engine](PHASE-28.md)

---

## Overview

Phase 27 implements NUDP/1 (Niles UDP Protocol v1) — a custom binary datagram format for sovereign mesh networking. NUDP/1 datagrams carry sensor telemetry, alerts, welfare checks, and peer discovery over UDP (port 47331), with hop-limited forwarding and deduplication. The protocol wraps into FRAYMUS WASM containers for Ed25519-signed "sovereign datagrams" — a novel combination of lightweight binary mesh networking with cryptographic identity.

### Key Innovation: Sovereign Datagrams

A 25-byte temperature reading can travel over LoRa radio at 915 MHz, then be wrapped in a 3058-byte FRAYMUS WASM container (with Ed25519 identity, SHA-256 baseline, DNA hypervector encoding) for Wi-Fi transport — bridging constrained radio networks to sovereign identity infrastructure.

## Architecture

```
 LoRa 915MHz                    Wi-Fi / IP
 (25-byte datagram)             (WASM-wrapped sovereign datagram)
      │                              ▲
      ▼                              │
┌───────────────────────────────────────────────────────────────┐
│                    NUDP/1 Binary Protocol                     │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Header (16 bytes)                                       │  │
│  │ magic(2) + ver(1) + flags(1) + type(1) + hop(1)       │  │
│  │ + source_id(4) + seq(4) + payload_len(2)               │  │
│  ├─────────────────────────────────────────────────────────┤  │
│  │ Payload: TLV entries                                    │  │
│  │ TEMPERATURE(i16) | BATTERY(u16) | RSSI(i8) | LAT(i32) │  │
│  │ LON(i32) | CLIENT_COUNT(u16) | ALERT_TEXT(UTF-8 120B)  │  │
│  │ FEED_ID(u16) | ACK_SEQ(u32)                            │  │
│  ├─────────────────────────────────────────────────────────┤  │
│  │ CRC32 Trailer (4 bytes)                                 │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
      │                              │
      ▼                              ▼
┌──────────────┐            ┌──────────────────┐
│  MeshNode    │            │  WASM Wrapping    │
│  UDP :47331  │            │  wrapWasm()       │
│  HELLO 30s   │            │  transmute()      │
│  dedup ring  │            │  (5 fraymus       │
│  hop fwd     │            │   sections)       │
│  sealed log  │            │                   │
└──────┬───────┘            └──────────────────┘
       │
       ▼
  Bus: mesh.packet
  DB: nudp_packets, nudp_peers
```

---

## What Was Built

### 1. Binary Encoder/Decoder (`nudp.js`)

Complete NUDP/1 binary protocol implementation:
- **Header**: 16-byte big-endian header with magic `0x4E44`, version 1
- **TLV payload**: Type-Length-Value encoding for 9 data types (temperature, battery, RSSI, lat/lon, client count, alert text, feed ID, ACK seq)
- **CRC32 trailer**: Integrity check using existing `core/crypto.js` crc32
- **5 message types**: HELLO (0x00), TELEMETRY (0x01), ALERT (0x02), WELFARE (0x03), ACK (0x04)
- **3 flag bits**: ACK_REQ (bit 0), VIA_RADIO (bit 1), OFFICIAL (bit 2)
- **Convenience builders**: `helloPacket()`, `telemetryPacket()`, `alertPacket()`, `welfarePacket()`, `ackPacket()`
- **Source ID derivation**: 4-byte ID from Ed25519 public key hash via `sourceIdFromPubkey()`

### 2. Mesh Node Behavior Engine (`mesh-node.js`)

Full mesh networking node with:
- **UDP socket**: Binds port 47331, broadcasts HELLO beacons every 30s
- **DedupRing**: 64-entry ring buffer — `seen(sourceId, seq)` prevents re-processing
- **SealedLog**: JSONL append with SHA-256 chain (each entry links previous hash)
- **PeerTracker**: Tracks known peers with last_seen timestamps
- **Hop-limited forwarding**: Decrements hop limit, recomputes CRC, broadcasts to known peers (max 4 hops)
- **OFFICIAL flag gate**: ALERT packets with OFFICIAL flag only accepted from configured bridge IDs
- **Bus integration**: Publishes parsed packets to `mesh.packet` topic
- **DB persistence**: Logs packets to `nudp_packets`, tracks peers in `nudp_peers`
- **WASM wrapping**: `wrapInWasm()` for simple container, full `transmute()` available via routes

### 3. REST API (11 endpoints in `nudp-routes.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/nudp/encode` | Encode datagram from JSON |
| POST | `/api/nudp/decode` | Decode from hex or base64 |
| POST | `/api/nudp/wrap` | Encode + simple WASM wrap |
| POST | `/api/nudp/transmute` | Encode + full 5-section WASM with identity |
| POST | `/api/nudp/node/start` | Start mesh node |
| POST | `/api/nudp/node/stop` | Stop and destroy mesh node |
| GET | `/api/nudp/node/status` | Node running state |
| GET | `/api/nudp/node/peers` | Peer list |
| POST | `/api/nudp/node/inject` | Inject test packet (local) |
| GET | `/api/nudp/packets` | Query packet log from DB |
| GET | `/api/nudp/info` | Protocol specification |

### 4. Fleet Tools (4 new, 29 total)

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `nudp_encode` | mesh | safe | Encode a NUDP/1 datagram |
| `nudp_decode` | mesh | safe | Decode from hex or base64 |
| `nudp_wrap_wasm` | mesh | safe | Encode + WASM wrap with identity |
| `nudp_node_status` | mesh | safe | Mesh node status |

---

## Files Changed

### New (3)
- `server/fraymus/protocol/nudp.js` — NUDP/1 binary encoder/decoder (~230 lines)
- `server/fraymus/protocol/mesh-node.js` — Mesh node behavior engine (~200 lines)
- `server/fraymus/protocol/nudp-routes.js` — 11 REST API endpoints (~180 lines)

### Modified (4)
- `server/db-migrate.js` — Added `nudp_packets` and `nudp_peers` tables with indexes
- `server/fleet/tools.js` — Added 4 NUDP fleet tools (29 total)
- `server/runtime.js` — Import + install NUDP routes, added `nudp-mesh-protocol` to features
- `server/fraymus/index.js` — Export NUDP/1 constants, functions, and MeshNode from unified entry

---

## DB Schema

```sql
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
```

---

## Protocol Specification

### Header Layout (16 bytes, big-endian)

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0 | 2 | Magic | `0x4E44` ("ND") |
| 2 | 1 | Version | `0x01` |
| 3 | 1 | Flags | ACK_REQ=0x01, VIA_RADIO=0x02, OFFICIAL=0x04 |
| 4 | 1 | Type | HELLO=0, TELEMETRY=1, ALERT=2, WELFARE=3, ACK=4 |
| 5 | 1 | Hop Limit | Max 4, decremented on forward |
| 6 | 4 | Source ID | Derived from Ed25519 pubkey hash |
| 10 | 4 | Sequence | Monotonic counter |
| 14 | 2 | Payload Length | TLV payload size in bytes |

### TLV Types

| Code | Name | Size | Encoding |
|------|------|------|----------|
| 0x01 | TEMPERATURE | 2 | i16, °C × 100 |
| 0x02 | BATTERY | 2 | u16, millivolts |
| 0x03 | RSSI | 1 | i8, dBm |
| 0x04 | LATITUDE | 4 | i32, degrees × 1e7 |
| 0x05 | LONGITUDE | 4 | i32, degrees × 1e7 |
| 0x06 | CLIENT_COUNT | 2 | u16 |
| 0x07 | ALERT_TEXT | variable | UTF-8, max 120 bytes |
| 0x08 | FEED_ID | 2 | u16 |
| 0x09 | ACK_SEQ | 4 | u32 |

### Datagram Size Examples
- HELLO beacon: 20 bytes (header + CRC, no TLVs)
- Single temperature: 25 bytes (fits LoRa ~40B frame)
- Full telemetry (temp + battery + RSSI + lat/lon): 39 bytes
- WASM-wrapped datagram: ~3058 bytes (5 fraymus sections)

---

## Running Counts

| Category | Count |
|----------|-------|
| Features | 40 |
| Fleet Tools | 29 |
| Agents (default) | 17 |
| Workflow Node Types | 36 |
| DB Tables | ~61 |
| API Routes | 90+ |
| Phases | 27 |

---

## Integration Points

- **core/crypto.js** — Reuses existing `crc32()` for datagram integrity
- **encoding/wasm.js** — `wrapWasm()` for simple container, `transmute()` for full 5-section WASM with identity
- **core/identity.js** — Ed25519 pubkey → source ID derivation
- **fleet/bus.js** — Mesh node publishes parsed packets to `mesh.packet` topic
- **fraymus/index.js** — All NUDP exports available from unified entry point

---

## Known Limitations

1. UDP socket requires the port to be free — only one MeshNode instance per machine
2. LoRa radio integration is protocol-ready but requires hardware (Raspberry Pi + LoRa module)
3. Full WASM transmute produces ~3KB — too large for LoRa, appropriate for Wi-Fi only
4. `verifyWasm()` has a pre-existing stringification gap (returns "INVALID - undefined" on some errors) — not a NUDP bug
5. No encryption layer — datagrams are signed via WASM identity but payload is cleartext
6. DedupRing is in-memory only — resets on node restart
