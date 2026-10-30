# Phase 12: Runtime Intelligence Completion

**Commit:** `d88e7bd`
**Date:** 2026-10-29
**Previous:** [Phase 11 — Commerce Intelligence Completion](.) (`8946889`)
**Next:** [Phase 13 — Backend Visibility Completion](PHASE-13.md)

## Summary

Wired intelligence hooks (Heart emotion, Ledger audit, Memory Bridge storage) into the 5 remaining non-intelligence subsystems. After this phase, **every subsystem that produces work** records it to Vertiso via Memory Bridge — zero blind spots.

Also fixed a pre-existing async bug in `fraymus-routes.js` (missing `async` on the evolve endpoint).

## What Was Built

### 1. Agent Runtime Intelligence (server/runtime.js)
- Hooked the `onEvent` callback in runtime.js (orchestrator level)
- On `completed` events: Heart reads output emotion, Ledger records the event, Memory Bridge stores cognition result
- Pattern: event-layer hooking avoids modifying the 736-line security-hardened `agent/service.js`

### 2. Scheduler Intelligence (server/automations/scheduler.js)
- Added module-level `memoryBridgeRef` with late-binding via `initScheduler()`
- After successful automation runs: stores result to Memory Bridge with name, kind, trigger, status

### 3. Web Research Intelligence (server/web/research.js)
- Added `memoryBridge` as constructor parameter to `createWebResearch()`
- On `retain()` (page stored): records URL + title to Memory Bridge
- Required reordering in `runtime.js` — moved `createWebResearch()` after `memoryBridge` creation (was line 59, memoryBridge at line 77)

### 4. YouTube Outlier Intelligence (server/youtube/service.js)
- Added late-binding `setYouTubeMemoryBridge()` (same pattern as fleet runtime)
- On `saveToBoard()`: records title, outlier tier, view count to Memory Bridge

### 5. Dashboard Runtime Intelligence Cards (client + server)
- Added `MemoryBridge.recentCognitionTypes()` — queries Vertiso via `json_extract(metadata, '$.type')` grouped by type
- Added `runtimeIntelligence` field to `/api/fraymus/health` endpoint
- Dashboard shows per-type insight counters with auto-fill grid layout

## Files Changed (9 files, +91 -13)

| File | Change |
|------|--------|
| `server/runtime.js` | +heart/ledger import, +YouTube bridge ref, reordered web creation, +onEvent intelligence hooks |
| `server/automations/scheduler.js` | +memoryBridgeRef, +initScheduler memoryBridge param, +post-run storage |
| `server/web/research.js` | +memoryBridge constructor param, +retain() storage |
| `server/youtube/service.js` | +setYouTubeMemoryBridge(), +saveToBoard() storage |
| `server/app.js` | +memoryBridge passed to initScheduler |
| `server/fraymus-routes.js` | +runtimeIntelligence in health, +async fix on evolve |
| `server/fraymus/intelligence/memory-bridge.js` | +recentCognitionTypes() method |
| `client/src/panels/DashboardPanel.jsx` | +runtimeIntel state, +Runtime Intelligence cards grid |
| `CLAUDE.md` | Updated subsystem descriptions with intelligence hooks |

## Patterns Used

- **Event-layer hooking:** Hook `onEvent` callback instead of modifying security-hardened inner code
- **Late-binding refs:** `setXRef()` for modules created at import time before dependencies exist (YouTube, scheduler)
- **Constructor injection:** For modules created after dependencies (web research)
- **Fire-and-forget:** `memoryBridge.storeCognitionResult(...).catch(() => {})` — never blocks main operation
- **SQLite json_extract:** Query inside JSON metadata column for type breakdowns

## Running Counts

| Metric | Count |
|--------|-------|
| Canvas Node Types | 36 |
| Workflow Definitions | 19 |
| Fleet Tools | 13 |
| Commerce Fleet Tools | 17 |
| Commerce Pipelines | 4 |
| Client Panels | 9 |
| Phases Complete | 12 |
