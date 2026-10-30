# Phase 38: Global Search

| Field | Value |
|-------|-------|
| **Phase** | 38 |
| **Feature** | `global-search` |
| **Prev** | [Phase 37 — Notification Toast System](PHASE-37.md) |
| **Next** | [Phase 39 — Keyboard Shortcuts & Quick Actions](PHASE-39.md) |

## What It Does

Unified search across every subsystem in Chandra-FRAYMUS. A search button in the nav bar expands into an input that queries 8 data sources with 250ms debounce, returning categorized results grouped by type with color-coded headers.

## Components

### Server: search.js (server/search.js)
- `GET /api/search?q=<query>&limit=<n>` — queries 8 data sources with SQL LIKE matching
- Data sources searched:
  1. **agents** — id, name from agents table
  2. **workflows** — name from workflows table
  3. **agent_memories** — key, value fields
  4. **bus_messages** — topic, payload
  5. **commerce_pipeline_runs** — topic, status
  6. **threads** — title, agent_id
  7. **reflections** — insights text
  8. **forged_agents** — agent_id, goal
- Returns `{ results: [...], query, total }` with max 50 results
- Each result includes `category`, `id`, `title`, `subtitle`, and `panel` (target drawer panel)

### Client: GlobalSearch.jsx (client/src/GlobalSearch.jsx)
- Search button in nav bar: `⌕ Search Ctrl+K` — toggles to input on click
- 280px input field with purple border accent, dark background
- 250ms debounce on keystroke
- Dropdown results panel with:
  - Category headers: colored icons + uppercase labels
  - 8 categories with distinct colors: Agents (purple), Workflows (blue), Memories (green), Bus Messages (amber), Commerce (pink), Threads (indigo), Reflections (gray), Forged Agents (orange)
  - Click result → opens relevant Detail Drawer panel or navigates to Canvas
  - Escape key → close and clear
  - Click outside → close
- Minimum 2 characters to trigger search

### App.jsx Changes
- `import GlobalSearch from './GlobalSearch.jsx'`
- Rendered in nav bar between view buttons and status indicator

### runtime.js Changes
- Added `import { installSearchRoutes } from './search.js'`
- Added `installSearchRoutes(app, { db })` call
- Added `'global-search'` to features array (50th feature)

## Architecture

```
User types in nav → GlobalSearch.jsx
  ├── 250ms debounce
  ├── GET /api/search?q=...
  ├── Server queries 8 tables with LIKE
  ├── Results grouped by category
  └── Click → onOpenDrawer(panel, title) or onNavigate('canvas')
```

## Running Counts After Phase 38
- Features: 50
- Phases complete: 38
- Client components: App, ErrorBoundary, ToastProvider, GlobalSearch + 4 views + 15 panels = 23
- Server route files: 25+
- Data sources searchable: 8

## Verification
- `GET /api/search?q=dream&limit=5` returns results across agents, memories, bus, reflections
- Search button visible in nav bar, expands to input on click
- Results dropdown renders with correct category colors and icons
- Click-to-navigate opens appropriate panel
