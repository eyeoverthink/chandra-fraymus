# Phase 41: Activity Timeline Panel

**Date:** 2026-10-30
**Feature Count:** 53 (added `activity-timeline`)
**Prev:** [Phase 40 — Agent Chat Panel](./PHASE-40.md)
**Next:** [Phase 42 — System Metrics Panel](./PHASE-42.md)

---

## Overview

A unified chronological feed of all system events across agents, bus messages, workflows, commerce pipelines, health alerts, and self-evolution activities. The timeline aggregates events from 12 different SQLite tables into a single normalized view with category filters, status badges, and auto-refresh.

## Files Created

### `server/timeline.js`
Express Router providing `GET /api/timeline` endpoint. Queries 12 database tables in parallel, normalizes events into a unified schema `{ id, type, category, title, detail, status, timestamp }`, sorts by timestamp descending, and supports query params:
- `limit` — max events to return (default 100, max 500)
- `category` — filter to one category (agent, workflow, commerce, bus, health, evolution)

**Tables aggregated:**
| Table | Category | Event Type |
|-------|----------|------------|
| `runs` | agent | agent-run |
| `workflow_runs` | workflow | workflow-run |
| `automation_runs` | workflow | automation-run |
| `commerce_pipeline_runs` | commerce | commerce-pipeline |
| `apparel_pipeline_runs` | commerce | apparel-pipeline |
| `mystery_shopper_runs` | commerce | mystery-shopper |
| `store_fixer_runs` | commerce | store-fixer |
| `bus_messages` | bus | bus-message |
| `health_alerts` | health | health-alert |
| `reflections` | evolution | reflection |
| `forged_agents` | evolution | agent-forge |
| `synthesized_workflows` | evolution | workflow-synthesis |

**Timestamp normalization:** The `safeTs()` function handles both INTEGER (Unix ms) and TEXT (ISO string) timestamp formats used across different tables. Each table's query uses `try/catch` so missing tables don't crash the endpoint.

### `client/src/panels/ActivityTimeline.jsx`
React panel component with:
- **Category filter chips** — 7 filters (All + 6 categories) with color-coded active state
- **Auto-refresh toggle** — 5-second polling interval, controllable via checkbox
- **Day-grouped timeline** — Events grouped by date with timeline dots and connecting line
- **Event cards** — Type badge (uppercase colored), relative timestamp, title, detail (truncated to 120 chars), and status badge with semantic colors
- **Empty state** — Guidance message when no events exist

**Status color mapping:** running (amber), complete/completed/success (green), failed/error/critical (red), resolved (gray), delivered (blue), pending/unknown (gray).

## Files Modified

### `server/runtime.js`
- Added `import timelineRouter from './timeline.js'`
- Added `app.use(timelineRouter)` after search routes
- Added `'activity-timeline'` to features array (53rd feature)

### `client/src/nexus/DetailDrawer.jsx`
- Added `import ActivityTimeline from '../panels/ActivityTimeline.jsx'`
- Added `timeline: { component: ActivityTimeline, label: 'Activity Timeline' }` to PANELS map (17th panel)

### `client/src/useKeyboardShortcuts.js`
- Added `{ key: '6', ctrl: false, action: 'timeline', label: 'Activity Timeline' }` to SHORTCUTS array (9th shortcut)
- Added handler for key `6` to dispatch `timeline` action

### `client/src/App.jsx`
- Added `timeline` action handler in `handleShortcut` callback
- Added "Timeline" nav button with clock icon between Chat and status display

## Architecture Notes

The timeline endpoint uses a **fan-out-and-merge** pattern: each table is queried independently with its own `try/catch` so a missing or empty table doesn't affect others. Results are normalized to a common schema and merged with a single sort pass. The `safeTs()` helper handles the mixed timestamp formats (INTEGER Unix ms vs TEXT ISO strings) that exist across the database.

The client-side auto-refresh uses `setInterval` at 5 seconds — fast enough for near-real-time visibility but not so fast as to strain the database. The interval is user-controllable.

## Running Counts

- **Features:** 53
- **Detail Drawer panels:** 17
- **Keyboard shortcuts:** 9 (Ctrl+K, 1-6, Escape, ?)
- **Database tables queried by timeline:** 12

## Testing Performed

- [x] `GET /api/timeline?limit=10` returns real events from database
- [x] Category filter param works (`?category=evolution`)
- [x] Timeline panel opens via nav button click
- [x] Category filter chips toggle correctly
- [x] Auto-refresh checkbox present and functional
- [x] Events display with correct type badges, status colors, and relative timestamps
- [x] Feature count confirmed at 53 via `/api/health`
- [x] No console errors on clean page load
