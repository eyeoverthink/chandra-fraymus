# Phase 45 — Run History Panel

**Date:** 2026-10-30
**Commit:** (pending)

## Summary

Added a unified Run History panel that aggregates execution records from all 7 run tables into a single, filterable timeline. The server endpoint normalizes heterogeneous table schemas (agent runs, workflow runs, automation runs, and 4 commerce pipeline types) into a common shape with type-specific metadata in a `meta` field.

## What Was Built

### Server: `server/run-history.js`
- **`GET /api/run-history`** — Returns unified, sorted execution log
  - Query params: `type` (agent|workflow|automation|commerce|apparel|mystery-shopper|store-fixer), `status`, `limit` (max 500), `offset`
  - Queries all 7 tables, normalizes into `{id, type, status, label, detail, meta, timestamp}`
  - Agent runs JOIN threads for agent_id and thread title
  - Timestamp normalization handles integer ms, integer seconds, and ISO date strings
  - All queries wrapped in `safe()` — missing tables don't crash
- **`GET /api/run-history/stats`** — Returns per-type counts and total

### Client: `client/src/panels/RunHistory.jsx`
- **List View**: Scrollable list of run cards
  - Type chips with color-coded icons (7 types: Agent ⊛, Workflow ⬡, Automation ⏲, Commerce ◈, Apparel ✦, Mystery ⊘, Fixer ⊕)
  - Status dots (green=completed, blue=running, red=failed, purple=pending)
  - Relative timestamps ("11h ago", "1d ago")
  - Type and status filter dropdowns
  - Stats summary chips showing per-type counts
  - Refresh button
- **Detail View**: Click-through from any run card
  - Type icon with header (name, run type, truncated ID)
  - Stat pills: Status, Type, When, and type-specific metadata (Model, Provider, Steps, Duration, Score, Grade, Products, Pages)
  - Detail text block
  - Error display for failed runs (red border)
  - Back navigation

### Wiring
- **DetailDrawer.jsx**: Added as 21st panel (`run-history`)
- **useKeyboardShortcuts.js**: Shortcut `0` → Run History (13 total shortcuts)
- **App.jsx**: Nav button `▶ Runs` (red hover), `handleShortcut` handler for `run-history`
- **runtime.js**: Router mounted, feature flag `run-history` added (57 total features)

## Files Changed

| File | Change |
|------|--------|
| `server/run-history.js` | **NEW** — Express router with unified run history endpoints |
| `client/src/panels/RunHistory.jsx` | **NEW** — List + detail panel (~190 lines) |
| `client/src/nexus/DetailDrawer.jsx` | Import + 21st panel entry |
| `client/src/useKeyboardShortcuts.js` | Shortcut `0` + handler |
| `client/src/App.jsx` | Nav button + shortcut handler |
| `server/runtime.js` | Import, route mount, feature flag |

## Patterns Used

- **Union adapter**: 7 different table schemas normalized into one `{id, type, status, label, detail, meta, timestamp}` shape
- **Timestamp normalization**: `ts()` function handles integer ms, integer seconds, and ISO strings
- **Type-metadata pattern**: Common fields in the run object, type-specific fields in `meta` so the detail view renders contextual pills
- **Color-coded type system**: Each of 7 run types has its own icon, color, and label in `TYPE_META`

## Running Counts

- Features: **57** (was 56)
- Detail Drawer panels: **21** (was 20)
- Keyboard shortcuts: **13** (was 12)
- Nav bar buttons: **7** (Chat, Timeline, Metrics, Profiles, Memory, Runs)
- Phases complete: **45** (was 44)
- Server route files: 6 router modules (timeline, metrics, agent-profiles, run-history, fleet/routes, search)
- Run table coverage: 7 tables (runs, workflow_runs, automation_runs, commerce_pipeline_runs, apparel_pipeline_runs, mystery_shopper_runs, store_fixer_runs)

---

**Previous:** [Phase 44 — Memory Browser Panel](PHASE-44.md)
**Next:** [Phase 46](PHASE-46.md)
