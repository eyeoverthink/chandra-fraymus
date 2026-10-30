# Phase 17: Living Constellation — Real-Time System Visualization

**Commit:** `05fc280`
**Date:** 2026-10-30
**Previous:** [Phase 16 — Command Bar + Live Activity Stream](PHASE-16.md)
**Next:** *(next phase)*

---

## Summary

Transforms the static Constellation SVG from a topology diagram into a living, breathing system monitor. Nodes pulse when their subsystem is active, edges animate to show data flow, the center hub breathes with the autonomy heartbeat, and status badges show real-time state without hovering. Zero new backend endpoints — all data comes from existing WebSocket events and the 3 API endpoints already fetched on mount.

**Design goal:** When you look at the Constellation, you should instantly know what's alive, what's busy, and what's idle — without clicking anything.

---

## What Will Be Built

### 1. Node Activity Pulses
- Each node gets a subtle glow animation when its subsystem fires a WebSocket event
- Glow color matches node color, fades over 3 seconds
- Multiple events stack (brighter glow, longer fade)
- Event type → node mapping:
  - `agents` / `agent` → fleet node
  - `event` with `pipeline` payload → commerce node
  - `event` with `workflow` payload → canvas node
  - `memory` → membridge + vertiso nodes
  - `v3` → all inner ring nodes (security is intelligence-layer)
  - `tasks` → automations node

### 2. Center Hub Breathing
- The CHANDRA center hub pulses with a slow 4-second breathing animation
- When autonomous mode is active: purple glow that expands/contracts
- When offline/connecting: dim, no animation
- Autonomy generation counter displayed under "NEXUS"

### 3. Edge Flow Animation
- Edges between recently-active nodes show animated dash flow
- CSS `stroke-dashoffset` animation creates flowing particle effect
- Direction follows the edge definition (inner → outer = intelligence feeding capabilities)
- Active edges are brighter, thicker, with node colors blended

### 4. Always-Visible Status Badges
- Each node shows a small status indicator without requiring hover
- Inner ring: Heart mood emoji, dream count, ledger count, cognition mode, proofs, memory count
- Outer ring: agent count, pipeline status, workflow count, automation count, server count, etc.
- Badges update on WebSocket events, not just on mount

### 5. WebSocket Reactivity
- `wsEvent` changes trigger targeted status refreshes (not full reload)
- Activity map tracks which nodes fired recently (Map<nodeId, timestamp>)
- Nodes that fired in last 3s get the glow animation
- Edges between two recently-active nodes get the flow animation

## Files to Modify

| File | Change |
|------|--------|
| `client/src/nexus/ConstellationView.jsx` | Add animations, WebSocket reactivity, status badges, breathing hub |
| `phases/PHASE-16.md` | Update Next link |
| `phases/README.md` | Add Phase 17 row |
| `CLAUDE.md` | Update ConstellationView description |

## Running Counts (projected)

| Metric | Count | Change |
|--------|-------|--------|
| Nexus Components | 5 | — |
| REST Endpoints | 75+ | — |
| Phases Complete | **17** | +1 |
