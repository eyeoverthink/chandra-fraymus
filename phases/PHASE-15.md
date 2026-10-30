# Phase 15: Chandra Nexus — Unified Interface

**Commit:** *(pending)*
**Date:** 2026-10-30
**Previous:** [Phase 14 — Workflow Canvas Polish](PHASE-14.md)
**Next:** *(next phase)*

## Summary

Transformed the 10-tab sidebar navigation into a 4-view unified interface called **Nexus**. Replaced the vertical sidebar with a horizontal top nav and added a contextual Detail Drawer that slides in from the right to show full panel content on demand. Zero backend changes — all 74+ REST endpoints untouched. All 10 existing panel components preserved as drawer content.

Inspired by the ARMS (Applications, Routines, Memory, Skills) framework concept: consolidate capabilities into cohesive surfaces instead of isolated tabs.

## What Was Built

### 1. App.jsx — Complete Rewrite
- Replaced 220px vertical sidebar with 52px horizontal top nav bar
- 4-view VIEWS array replaces 10-tab TABS array
- Added drawer state management (panel + title + backdrop overlay)
- Drawer opens from any view via `onOpenDrawer(panel, title)` callback
- Click backdrop to dismiss drawer

### 2. CommandCenter (client/src/nexus/CommandCenter.jsx) — NEW
- **10-widget grid** with hover effects, color-coded borders, radial gradient accents
- Each widget: icon, label, live metric value, subtext detail
- Live data from 7 API endpoints: fleet/agents, workflows, mcp/servers, fraymus/health, vertiso/stats, automations, events
- **Intelligence Stack section** — 6 status cards: Heart Mood, Dreamer, Ledger, Cognition, Memory Bridge, Autonomy
- **Recent Activity feed** — scrollable event list with color-coded dots and timestamps
- WebSocket event reactivity refreshes all data
- Widgets click to open drawer (or navigate to Canvas for Workflows)

### 3. ConstellationView (client/src/nexus/ConstellationView.jsx) — NEW
- **Interactive SVG node graph** — "Second Brain" visualization of the entire system
- **Center hub**: CHANDRA NEXUS with purple ring
- **Inner ring** (6 nodes, radius ~130): Heart, Dreamer, Ledger, Cognition, Ouroboros, Memory Bridge
- **Outer ring** (8 nodes, radius ~260): Agent Fleet, Commerce, Workflows, Automations, MCP Gateway, Browser, Vertiso, Outlier
- **15 edge connections** between related subsystems (e.g., Heart → Fleet, MemBridge → Commerce)
- **Hover highlighting**: hovering a node highlights all its connections
- **Status tooltips**: live status text appears below hovered nodes
- **ResizeObserver**: SVG scales with container dimensions
- Click any node to open its panel in the Detail Drawer

### 4. LibraryView (client/src/nexus/LibraryView.jsx) — NEW
- **Unified content archive** aggregating from 7 API endpoints:
  - Commerce: `/api/commerce/runs`, `/api/apparel/runs`, `/api/shopper/runs`, `/api/fixer/runs`
  - YouTube: `/api/youtube/board`
  - Fleet: `/api/fleet/threads`
  - Workflows: `/api/workflows`
- **5 source filter tabs**: All, Commerce Runs, Workflow Runs, Outlier Saves, Agent Threads
- **Full-text search** across item labels and source names
- **Expandable items** — click to reveal scores, grades, stages, metadata, raw JSON
- **Color-coded source badges**: pink for commerce, yellow for shopper, green for fixer, purple for workflow, blue for fleet, amber for outlier
- **Time-ago formatting**: relative timestamps (just now, 5m ago, 2h ago, 3d ago)

### 5. DetailDrawer (client/src/nexus/DetailDrawer.jsx) — NEW
- **Slide-out panel** from right edge, 55% width (480–900px)
- **CSS keyframe animation**: slides in 0.2s ease-out
- **Backdrop overlay**: semi-transparent black, click to dismiss
- **Header bar**: title + close button
- **Renders any of 9 panel components** based on panel ID:
  - dashboard, intelligence, fleet, commerce, automations, mcp, browser, vertiso, outlier
- Props forwarding: wsEvent to all panels, health to DashboardPanel

## Tab → View Mapping

| Old Tab (removed) | New Location |
|---|---|
| Dashboard | Command Center widget → drawer |
| Intelligence | Command Center widget / Constellation node → drawer |
| Workflow Canvas | Canvas view (unchanged) |
| Agent Fleet | Command Center widget / Constellation node → drawer |
| Automations | Command Center widget / Constellation node → drawer |
| MCP Gateway | Command Center widget / Constellation node → drawer |
| Browser | Command Center widget / Constellation node → drawer |
| Vertiso / RSI | Command Center widget / Constellation node → drawer |
| Commerce | Command Center widget / Constellation node → drawer |
| Outlier Board | Command Center widget / Constellation node → drawer |

## Files Changed (5 files, +580 -68)

| File | Change |
|------|--------|
| `client/src/App.jsx` | **REWRITE** — 81→90 lines, 10-tab sidebar → 4-view top nav + drawer |
| `client/src/nexus/CommandCenter.jsx` | **NEW** — ~130 lines, widget grid + intelligence stack + activity feed |
| `client/src/nexus/ConstellationView.jsx` | **NEW** — ~140 lines, SVG node graph with hover + status |
| `client/src/nexus/LibraryView.jsx` | **NEW** — ~140 lines, unified content archive with search/filter |
| `client/src/nexus/DetailDrawer.jsx` | **NEW** — ~55 lines, slide-out panel wrapper for all 9 panels |

## Patterns Used

- **View + Drawer pattern**: 4 top-level views for navigation, contextual drawer for deep-dive — eliminates "million tabs" while keeping all functionality accessible
- **Widget-as-summary**: Each widget fetches its own condensed data, clicking reveals full panel in drawer
- **Radial SVG layout**: Nodes positioned via trigonometric calculation, edges defined as adjacency list, hover highlights via edge traversal
- **Content aggregation**: Library merges from 7 independent API endpoints into one sorted, filterable feed
- **Zero-deletion refactor**: All 10 panel components preserved unchanged, re-housed as drawer content
- **Backdrop dismissal**: Fixed overlay div catches clicks to close drawer, preventing interaction with content behind

## Running Counts

| Metric | Count |
|--------|-------|
| Canvas Node Types | 36 |
| Workflow Definitions | 19 |
| Fleet Tools | 13 |
| Commerce Fleet Tools | 17 |
| Commerce Pipelines | 4 |
| Client Views | **4** (was 10 tabs) |
| Client Panels (as drawer content) | **9** (all preserved) |
| Nexus Components | **4** (new) |
| Phases Complete | **15** |
