# Phase 42: System Metrics Panel

**Date:** 2026-10-30
**Feature Count:** 54 (added `system-metrics`)
**Prev:** [Phase 41 — Activity Timeline Panel](./PHASE-41.md)
**Next:** [Phase 43 — Agent Profiles Panel](./PHASE-43.md)

---

## Overview

An operational metrics dashboard providing aggregate statistics across all Chandra subsystems. Complements the Activity Timeline (individual events) with aggregate views — success rates, throughput, trend charts, and leaderboards. Queries the same 12 database tables as the timeline but with `COUNT`, `GROUP BY`, and time-bucketed aggregate queries.

## Files Created

### `server/metrics.js`
Express Router providing `GET /api/metrics` endpoint. Returns a comprehensive metrics object:

**Overview stats:**
- Agent run totals (all-time + last 24h), success rate, failed count
- Workflow run totals (all-time + last 24h)
- Bus message totals (all-time + last 24h)
- Health alert totals + unresolved count
- Reflection, forged agent, synthesized workflow totals
- Commerce pipeline run counts (all 4 pipelines)

**Breakdowns:**
- `topAgents` — top 5 agents by run count (JOIN threads→runs)
- `topBusTopics` — top 5 bus topics by message count
- `runsByStatus` — run count per status
- `recentActivity` — 7-day activity trend (runs + bus per day)

All queries wrapped in `try/catch` so missing tables don't crash the endpoint.

### `client/src/panels/SystemMetrics.jsx`
React panel component with:
- **6 top stat cards** in a 3×2 grid: Agent Runs, Success Rate, Workflows, Bus Messages, Alerts, Reflections
- **2 evolution stat cards**: Forged Agents, Synthesized Workflows
- **4 commerce stat cards**: Content→Commerce, Apparel, Mystery Shopper, Store Fixer
- **7-day activity sparkline** — SVG line chart with dots and day labels
- **Runs by status** — colored badge chips (green=completed, amber=running, red=failed)
- **Top agents bar chart** — horizontal bars with gradient fills (blue)
- **Top bus topics bar chart** — horizontal bars with gradient fills (pink)
- **Refresh button** for on-demand data reload

**Stat card color logic:** Success rate uses threshold-based coloring (>=80% green, >=50% amber, <50% red). Alerts turn red when unresolved > 0.

**Component architecture:**
- `StatCard` — reusable metric tile with label, value, sub-text, color
- `BarChart` — reusable horizontal bar chart with label, value, color, max-width normalization
- `MiniSparkline` — SVG polyline chart with circles and day labels

## Files Modified

### `server/runtime.js`
- Added `import metricsRouter from './metrics.js'`
- Added `app.use(metricsRouter)` after timeline router
- Added `'system-metrics'` to features array (54th feature)

### `client/src/nexus/DetailDrawer.jsx`
- Added `import SystemMetrics from '../panels/SystemMetrics.jsx'`
- Added `metrics: { component: SystemMetrics, label: 'System Metrics' }` to PANELS map (18th panel)

### `client/src/useKeyboardShortcuts.js`
- Added `{ key: '7', ctrl: false, action: 'metrics', label: 'System Metrics' }` to SHORTCUTS array (10th shortcut)
- Added handler for key `7` to dispatch `metrics` action

### `client/src/App.jsx`
- Added `metrics` action handler in `handleShortcut` callback
- Added "Metrics" nav button with dot icon (◉) in nav bar

## Architecture Notes

The metrics endpoint uses aggregate SQL (`COUNT(*)`, `GROUP BY`, `ORDER BY ... DESC LIMIT 5`) rather than the per-row queries in the timeline. The 7-day activity trend iterates over 7 day-buckets computing per-day counts — this could be optimized with a single `GROUP BY date(created_at/1000, 'unixepoch')` query but the current approach is simpler and plenty fast for the table sizes.

The `StatCard` component uses conditional coloring — success rate turns red below 50%, alerts turn red when any are unresolved, making operational anomalies immediately visible.

## Running Counts

- **Features:** 54
- **Detail Drawer panels:** 18
- **Keyboard shortcuts:** 10 (Ctrl+K, 1-7, Escape, ?)
- **Nav bar buttons:** 3 (Chat, Timeline, Metrics)

## Testing Performed

- [x] `GET /api/metrics` returns real aggregate data from all tables
- [x] Stat cards display correct values for runs, reflections, alerts, forged agents
- [x] 7-day sparkline renders with real data points
- [x] Top Agents bar chart shows `_prime` with 3 runs
- [x] Top Bus Topics bar chart shows `system.evolution` (8), `system.reflection` (4)
- [x] Runs by Status section renders status badges
- [x] Commerce pipeline counts display correctly (2 apparel, 1 mystery, 1 fixer)
- [x] Feature count confirmed at 54 via `/api/health`
- [x] No console errors on clean page load
