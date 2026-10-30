# Phase 18: Offline-First Hardening — FRAYNIX-DREAMER ULTIMATE Integration

**Commit:** `eea4fe3`
**Date:** 2026-10-30
**Previous:** [Phase 17 — Living Constellation](PHASE-17.md)
**Next:** [Phase 19 — Hermes Full Fleet + Agent Collaboration](PHASE-19.md)

---

## Summary

Hardens Chandra-FRAYMUS for 100% offline operation with FRAYNIX-DREAMER ULTIMATE as the default model, fixes 4 cascading server startup bugs, and resolves a React rendering crash that made the entire UI black. The system now boots cleanly, runs fleet agents through Ollama without any cloud dependency, and renders all 4 Nexus views with live intelligence data.

**Design goal:** The complete pipeline — from user prompt through agent fleet to UI display — runs on local hardware with zero external API calls. Your GPU, your models, your store.

---

## What Was Built

### 1. FRAYNIX-DREAMER ULTIMATE Model Integration
- Replaced all 7 hardcoded `llama3.2` fallbacks with `fraynix-dreamer-ultimate:8b`
- Updated model fallback chain: `opts.model` → `FRAYMUS_DEFAULT_MODEL` env → `fraynix-dreamer-ultimate:8b`
- Corrected local Ollama model names to match actual tags:
  - `ollama/v6.1-machine` → `ollama/eyeoverthink/v6.1-machine`
  - `Niles-FRAYMUS:v10` → `niles-fraymus:v9`
- Three model tiers from GitHub modelfiles:
  - **120B** — Cloud-routed, phi-harmonic sampling
  - **8B** — Primary local (RTX 3070, 16K context)
  - **3B** — Lite/VPS tier (8K context)

### 2. Server Startup Fixes (3 cascading bugs)
- **`server/agent/service.js:159`** — extraTools limit 128 → 256 (42 FRAYMUS + 13 fleet + 17 commerce + others exceeded old limit)
- **`server/agent/schema.js:43`** — Added `'default'` to allowed JSON Schema keywords (tools with default values were rejected)
- **`server/fleet/tools.js`** — Changed `memory_recall` and `intelligence_cycle` from `run: async (args, ctx) =>` to `execute: async ({ args }) =>` (signature mismatch with agent runtime)

### 3. React Health API Fix
- **Root cause:** `/api/fraymus/health` returns `intelligence.mood` as an object `{mood, readings, distribution}`, not a string
- **CommandCenter.jsx** — Fixed `f?.intelligence?.mood` (object rendered as React child) → `f?.intelligence?.mood?.mood` (string)
- **CommandCenter.jsx** — Fixed non-existent field paths:
  - `intelligence.dreams` → `intelligence.dreamerState?.dreamCount`
  - `intelligence.ledgerCount` → `intelligence.ledgerIntegrity?.checked`
  - `intelligence.cognitionMode` → `intelligence.cognition.modules` (count)
- **ConstellationView.jsx** — Same 5 field path fixes for status badges
- **Result:** Intelligence Stack section now renders with real data (Heart Mood, Dreamer count, Ledger events, Cognition modules, Memory Bridge count, Autonomy generation)

### 4. End-to-End Offline Verification
- Fleet API tested: `POST /api/fleet/runs` → Ollama chat → thread storage → response retrieval
- Model `fraynix-dreamer-ultimate:8b` responds correctly, identifies itself as FRAYNIX-DREAMER ULTIMATE
- All 4 Nexus views render without errors
- Zero console errors after fixes

---

## Files Changed

| File | Change |
|------|--------|
| `server/commerce/shared.js:9` | `llama3.2` → `fraynix-dreamer-ultimate:8b` |
| `server/fleet/runtime.js:150` | `llama3.2` → `fraynix-dreamer-ultimate:8b` |
| `server/fraymus/core/constants.js:32-33` | Corrected claudette + niles model tags |
| `server/fraymus/intelligence/niles.js:4,24` | `niles-fraymus:v9`, `fraynix-dreamer-ultimate:8b` |
| `server/runtime.js:163` | `gpt-oss:20b` → `fraynix-dreamer-ultimate:8b` |
| `server/vertiso/rsi.js:329` | `llama3.2` → `fraynix-dreamer-ultimate:8b` |
| `server/agent/schema.js:43` | Added `'default'` to allowed schema keywords |
| `server/agent/service.js:159,161` | Tool limit 256, diagnostic error messages |
| `server/fleet/tools.js:196,211` | `run` → `execute` for memory_recall, intelligence_cycle |
| `client/src/nexus/CommandCenter.jsx` | Fixed health API field mappings (mood object → string) |
| `client/src/nexus/ConstellationView.jsx` | Fixed health API field mappings (5 paths) |

---

## Commits

| Hash | Message |
|------|---------|
| `8ff1155` | Replace all hardcoded llama3.2 fallbacks with fraynix-dreamer-ultimate:8b |
| `5c4226e` | Fix server startup: tool schema validation and tool registration |
| `eea4fe3` | Fix React crash: health API mood object rendered as React child |

---

## Verification

- Server starts clean on port 8787 with all features loaded
- Vite client starts on port 5173 with HMR
- Agent run with `fraymus_prime` completes successfully via local Ollama
- All 4 Nexus views render: Command Center, Constellation, Canvas, Library
- Intelligence Stack section shows: neutral mood, 0 dreams, 4 ledger events, 5 cognition modules, 6 memory bridge entries
- Zero console errors in browser
- 39 Ollama models available locally including fraynix-dreamer-ultimate (3b/8b/120b)

---

## Running Counts

| Metric | Count |
|--------|-------|
| Canvas Node Types | 36 |
| Workflow Definitions | 19 |
| Fleet Tools | 13 |
| Commerce Fleet Tools | 17 |
| Commerce Pipelines | 4 |
| Nexus Views | 4 |
| Detail Panels | 9 |
| REST Endpoints | 180+ |
| Phases Complete | 18 |
| Git | `eea4fe3` on master |
