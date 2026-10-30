# Phase 15: Chandra Nexus — Unified Interface

**Commit:** `1fbdf04`
**Date:** 2026-10-30
**Previous:** [Phase 14 — Workflow Canvas Polish](PHASE-14.md)
**Next:** *(next phase)*

---

## Summary

Transformed the 10-tab sidebar navigation into a 4-view unified interface called **Nexus**. Replaced the 220px vertical sidebar with a 52px horizontal top nav bar and introduced a contextual **Detail Drawer** that slides in from the right to show full panel content on demand. Zero backend changes — all 74+ REST endpoints are untouched. All 10 existing panel components are preserved as drawer content.

This phase directly addresses Niles's design directive: **"I don't want a million tabs, I want a cohesive well-designed system."** Inspired by the ARMS (Applications, Routines, Memory, Skills) framework concept from RoboNuggets/Jay E's agentic OS design principles — consolidate capabilities into cohesive surfaces instead of isolated tabs.

---

## Architecture Decision: Why 4 Views

The 10-tab sidebar had a fundamental UX problem: every subsystem got equal weight in the navigation, making the system feel fragmented. A user who wanted to check system health, then review an agent, then launch a pipeline had to click three different tabs — three separate mental contexts.

The 4-view Nexus solves this by organizing capabilities around **intent**, not subsystem:

| View | Intent | What it replaces |
|------|--------|-----------------|
| **Command Center** | "What's happening?" | Dashboard tab (expanded to cover all subsystems) |
| **Constellation** | "How does this all connect?" | No equivalent — new capability |
| **Canvas** | "I need to build/run a workflow" | Workflow Canvas tab (unchanged) |
| **Library** | "Show me what's been produced" | No single equivalent — aggregates Commerce, Outlier, Fleet, Workflow outputs |

The remaining 9 tabs (Intelligence, Fleet, Automations, MCP, Browser, Vertiso, Commerce, Outlier, Dashboard) become **drawer content** — accessible from any view via widget click, constellation node click, or library item interaction. This means you can check an agent's status while looking at the constellation, or review a pipeline run's details while browsing the library, without leaving your current context.

### The Detail Drawer Pattern

The drawer is the key architectural choice. Instead of routing to a separate page:

```
User clicks "Agent Fleet" widget in Command Center
  → Drawer slides in from right (55% width, 0.2s animation)
  → FleetPanel renders inside drawer with full functionality
  → Backdrop overlay prevents accidental clicks behind
  → Click backdrop or ✕ to dismiss
  → Command Center is still visible behind the overlay
```

This keeps the user oriented. They know where they are (Command Center) and what they're inspecting (Agent Fleet). No context switch, no "which tab was I on?" moment.

---

## What Was Built

### 1. App.jsx — Complete Rewrite (81 → 90 lines)

**Before:**
```
┌──────────┬──────────────────────────────┐
│ CHANDRA  │                              │
│          │                              │
│ ◈ Dash   │   Panel content area         │
│ ♦ Intel  │   (one panel at a time)      │
│ ⬡ Canvas │                              │
│ ⚡ Fleet  │                              │
│ ⟳ Auto   │                              │
│ ⬢ MCP    │                              │
│ ◉ Browse │                              │
│ ◇ Verti  │                              │
│ ◆ Comm   │                              │
│ ◎ Outlr  │                              │
│          │                              │
│ Port 8787│                              │
└──────────┴──────────────────────────────┘
```

**After:**
```
┌──────────────────────────────────────────────────────┐
│ CHANDRA NEXUS  [Command Center] [Constellation] [Canvas] [Library]  Port 8787 │
├──────────────────────────────────────────────────────┤
│                                                      │
│   View content area (full width, full height)        │
│                                                      │
│                                     ┌────────────────┤
│                                     │ Detail Drawer  │
│                                     │ (slides from   │
│                                     │  right, 55%    │
│                                     │  width, any    │
│                                     │  of 9 panels)  │
│                                     └────────────────┤
└──────────────────────────────────────────────────────┘
```

**Key changes:**
- `TABS` array (10 items) → `VIEWS` array (4 items)
- Vertical sidebar (`flex-direction: column`, 220px fixed) → Horizontal top nav (`flex-direction: row`, 52px height)
- Simple `{tab === 'x' && <Panel />}` → View routing + drawer state machine
- New state: `drawer` (null or `{ panel, title }`) managed via `openDrawer`/`closeDrawer`
- Backdrop overlay: `position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 99` — click to dismiss
- All 10 panel imports removed from App.jsx (moved to DetailDrawer.jsx), replaced by 4 nexus component imports

**Props flow:**
```
App (health, wsEvent, drawer state)
  ├── CommandCenter → receives health, wsEvent, onOpenDrawer, onNavigate
  ├── ConstellationView → receives wsEvent, onOpenDrawer, onNavigate
  ├── WorkflowCanvas → receives wsEvent (unchanged)
  ├── LibraryView → receives wsEvent, onOpenDrawer
  └── DetailDrawer → receives panel, title, onClose, wsEvent, health
```

### 2. CommandCenter (client/src/nexus/CommandCenter.jsx) — NEW, ~130 lines

The home surface. A grid of interactive status widgets, an intelligence stack overview, and a live activity feed.

**Widget System:**

The `WIDGETS` config array defines 10 widgets:

| Widget | Icon | Color | Panel/Action | Metric Source |
|--------|------|-------|--------------|---------------|
| System Health | ◈ | `#22c55e` green | drawer → dashboard | `/api/fraymus/health` autonomous status |
| Intelligence | ♦ | `#f59e0b` amber | drawer → intelligence | `/api/fraymus/health` mood field |
| Agent Fleet | ⚡ | `#6366f1` indigo | drawer → fleet | `/api/fleet/agents` count |
| Workflows | ⬡ | `#8b5cf6` purple | navigate → canvas | `/api/workflows` count |
| Commerce | ◆ | `#ec4899` pink | drawer → commerce | Static "4 pipelines" |
| Memory / RSI | ◇ | `#a78bfa` violet | drawer → vertiso | `/api/vertiso/stats` totalMemories |
| MCP Gateway | ⬢ | `#10b981` emerald | drawer → mcp | `/api/mcp/servers` count |
| Automations | ⟳ | `#06b6d4` cyan | drawer → automations | `/api/automations` count |
| Browser | ◉ | `#7c3aed` purple | drawer → browser | Static "Headless + Ext" |
| Outlier Board | ◎ | `#eab308` yellow | drawer → outlier | Static "YouTube Research" |

Each widget card has:
- **Radial gradient accent** — subtle color glow in top-right corner (`radial-gradient(circle at top right, ${color}15, transparent 70%)`)
- **Hover effect** — border brightens from `25` to `60` alpha, background tints with `08` alpha
- **Two-line data** — primary metric (e.g., "17 agents") and subtext detail (e.g., "llama3.2, qwen2.5")

**Data Loading:**
- Single `load()` function fetches from 7 endpoints in parallel on mount
- WebSocket events trigger full reload (debounced by React's batching)
- API: `/api/fleet/agents`, `/api/workflows`, `/api/mcp/servers`, `/api/fraymus/health`, `/api/vertiso/stats`, `/api/automations`, `/api/events?limit=20`

**Intelligence Stack Section:**
Shows when `data.fraymus.intelligence` exists. Six cards in an auto-fill grid:
- Heart Mood (amber), Dreamer dream count (purple), Ledger event count (cyan)
- Cognition mode (emerald), Memory Bridge stored count (violet), Autonomy generation (green)

**Recent Activity Feed:**
- Scrollable list, max-height 320px
- Color-coded dots: red for errors, indigo for agent events, violet for everything else
- Truncated summary text with ellipsis overflow
- Locale-formatted timestamps

### 3. ConstellationView (client/src/nexus/ConstellationView.jsx) — NEW, ~140 lines

The "Second Brain" visualization — an interactive SVG node graph that maps every subsystem and shows how they connect. This is the only view that exists purely for spatial understanding of the system's architecture.

**Node Topology:**

14 nodes arranged in 2 concentric rings around a center hub:

```
                         ⚡ Agent Fleet
                    ◉ Canvas       ◆ Commerce
               ♥ Heart                   
          ⊶ Memory Bridge    ☾ Dreamer
     ◇ Vertiso          [CHANDRA]        ⬡ Workflows
          ∞ Ouroboros    ⧫ Cognition
               ◉ Browser                
                    ⟐ Ledger       ⬢ MCP
                         ⟳ Automations
                              ◎ Outlier
```

**Inner Ring** (radius ~130px from center, intelligence layer):
- Heart (♥, amber) — emotion engine, 7 dimensions
- Dreamer (☾, purple) — Ed25519 signed dream protocol
- Ledger (⟐, cyan) — SHA-256 chained cognitive audit trail
- Cognition (⧫, emerald) — two-speed pipeline (feel → think)
- Ouroboros (∞, pink) — RSI + consciousness proofs
- Memory Bridge (⊶, violet) — intelligence → Vertiso connector

**Outer Ring** (radius ~260px, capability layer):
- Agent Fleet (⚡, indigo), Commerce (◆, pink), Workflows (⬡, purple)
- Automations (⟳, cyan), MCP Gateway (⬢, emerald), Browser (◉, purple)
- Vertiso (◇, violet), Outlier (◎, yellow)

**15 Edge Connections** (adjacency list, representing real data flow):
```
Heart → Fleet, Commerce
Dreamer → Fleet, Cognition
Ledger → Fleet, Automations
Cognition → Fleet, Commerce
Consciousness → Cognition, Dreamer
MemBridge → Fleet, Commerce, Vertiso, Automations, Outlier
```

These edges reflect actual system wiring — for example, Memory Bridge connects to Fleet because fleet agents store cognition results to Vertiso via the bridge, and connects to Commerce because all 4 pipelines use `createCommerceIntel` which stores results through the bridge.

**Inner ring → center hub:** Dashed lines (`strokeDasharray: "4 4"`) connect all inner nodes to the CHANDRA center, showing they're all part of the intelligence core.

**Interaction:**
- **Hover** — Node circle fills with `20` alpha tint, stroke brightens to full color, connected edges highlight in purple
- **Status tooltip** — Hovering shows a small rect below the node with live status text (fetched from `/api/fraymus/health`, `/api/fleet/agents`, `/api/vertiso/stats`)
- **Click** — Opens Detail Drawer with the corresponding panel (Workflows node navigates to Canvas view instead)

**Responsive sizing:**
- `ResizeObserver` on the container div updates `size.w` and `size.h`
- Center point (`cx`, `cy`) recalculates as half of container dimensions
- All node positions recalculate via `nodePos()` using trigonometric radial placement

**Position calculation:**
```javascript
function nodePos(node) {
  const r = node.ring === 1 ? 130 : 260;
  const ringNodes = NODES.filter(n => n.ring === node.ring);
  const idx = ringNodes.indexOf(node);
  const angle = (2 * Math.PI * idx) / ringNodes.length - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}
```
The `-Math.PI / 2` offset places the first node at 12 o'clock instead of 3 o'clock.

### 4. LibraryView (client/src/nexus/LibraryView.jsx) — NEW, ~140 lines

A unified content browser that aggregates all generated outputs across the system into one searchable, filterable feed.

**Data Sources (7 endpoints):**

| Source | Endpoint | Item shape | Badge color |
|--------|----------|------------|-------------|
| Content Pipeline | `/api/commerce/runs` | topic, status, score, stages | `#ec4899` pink |
| Apparel Pipeline | `/api/apparel/runs` | niche, season, status, stages | `#ec4899` pink |
| Mystery Shopper | `/api/shopper/runs` | store_url, grade, score, issues | `#f59e0b` amber |
| Store Fixer | `/api/fixer/runs` | status, stages | `#10b981` green |
| Outlier Saves | `/api/youtube/board` | title, outlier_tier, view_count | `#eab308` yellow |
| Agent Threads | `/api/fleet/threads` | title, agent_id, messages | `#6366f1` indigo |
| Workflows | `/api/workflows` | name, nodes, edges | `#8b5cf6` purple |

**Normalization:**
Each fetched item is tagged with `_source` (for badge display) and `_label` (for display text). This allows items from different APIs with different field names to render uniformly:
```javascript
(d.runs || []).map(r => ({
  ...r,
  _source: 'commerce',
  _label: r.topic || 'Content Pipeline'
}))
```

**Sorting:** All items sorted by `created_at` (or `saved_at` for outlier saves), newest first.

**Filter tabs:** All, Commerce Runs, Workflow Runs, Outlier Saves, Agent Threads — each triggers a `source` state change that determines which endpoints to fetch from.

**Search:** Case-insensitive substring match across `_label` and `_source` fields.

**Expandable items:** Click any row to reveal:
- Score/grade (commerce runs)
- Outlier tier and ratio (outlier saves)
- View count (outlier saves)
- Pipeline stages (commerce runs)
- Node count (workflows)
- Agent ID (threads)
- Full raw JSON in a `<pre>` block (all items, with `_source`/`_label` keys stripped)

**Time formatting:**
```javascript
function timeAgo(ts) {
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
```

### 5. DetailDrawer (client/src/nexus/DetailDrawer.jsx) — NEW, ~55 lines

The glue component that makes the View + Drawer pattern work. Maps panel IDs to panel components and renders them inside a slide-out container.

**Panel Registry:**
```javascript
const PANELS = {
  dashboard: { component: DashboardPanel, label: 'System Dashboard', needsHealth: true },
  intelligence: { component: IntelligencePanel, label: 'Intelligence' },
  fleet: { component: FleetPanel, label: 'Agent Fleet' },
  commerce: { component: CommercePanel, label: 'Commerce Pipelines' },
  automations: { component: AutomationsPanel, label: 'Automations' },
  mcp: { component: McpPanel, label: 'MCP Gateway' },
  browser: { component: BrowserPanel, label: 'Browser' },
  vertiso: { component: VertisoPanel, label: 'Vertiso / RSI' },
  outlier: { component: OutlierPanel, label: 'Outlier Board' },
};
```

**Layout:**
- `position: fixed; top: 0; right: 0; bottom: 0` — full viewport height
- `width: 55%; min-width: 480px; max-width: 900px` — responsive but bounded
- `box-shadow: -8px 0 32px rgba(0,0,0,0.5)` — depth separation from content behind
- `z-index: 100` (backdrop is `z-index: 99`)

**Animation:**
```css
@keyframes drawerSlide {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
```
Applied via inline `<style>` tag injected inside the component — avoids needing a separate CSS file.

**Props forwarding:**
- `wsEvent` → passed to all panels (every panel reacts to WebSocket events)
- `health` → passed only to DashboardPanel (only panel that needs the health object)

---

## Tab → View Migration Map

Every capability from the old 10-tab system is accessible in the new 4-view Nexus. Nothing was removed.

| Old Tab | New Access Point(s) | Interaction |
|---------|--------------------|-|
| Dashboard | Command Center widget "System Health" | Click widget → drawer opens DashboardPanel |
| Intelligence | Command Center widget "Intelligence" + Constellation inner ring nodes (Heart, Dreamer, etc.) | Click widget or node → drawer opens IntelligencePanel |
| Workflow Canvas | Canvas view (top nav, 3rd button) | Direct view — WorkflowCanvas renders as before |
| Agent Fleet | Command Center widget "Agent Fleet" + Constellation outer ring node | Click → drawer opens FleetPanel |
| Automations | Command Center widget "Automations" + Constellation outer ring node | Click → drawer opens AutomationsPanel |
| MCP Gateway | Command Center widget "MCP Gateway" + Constellation outer ring node | Click → drawer opens McpPanel |
| Browser | Command Center widget "Browser" + Constellation outer ring node | Click → drawer opens BrowserPanel |
| Vertiso / RSI | Command Center widget "Memory / RSI" + Constellation node (Vertiso + Memory Bridge) | Click → drawer opens VertisoPanel |
| Commerce | Command Center widget "Commerce" + Constellation outer ring node | Click → drawer opens CommercePanel |
| Outlier Board | Command Center widget "Outlier Board" + Constellation outer ring node + Library outlier items | Click → drawer opens OutlierPanel |

---

## Files Changed (10 files, +733 -63)

| File | Lines | Change |
|------|-------|--------|
| `client/src/App.jsx` | 81→90 | **REWRITE** — 10-tab sidebar → 4-view top nav + drawer state management |
| `client/src/nexus/CommandCenter.jsx` | 130 | **NEW** — widget grid + intelligence stack + activity feed |
| `client/src/nexus/ConstellationView.jsx` | 140 | **NEW** — SVG node graph with 2-ring radial layout, 15 edges, hover highlighting |
| `client/src/nexus/LibraryView.jsx` | 140 | **NEW** — unified content archive from 7 endpoints with search/filter/expand |
| `client/src/nexus/DetailDrawer.jsx` | 55 | **NEW** — slide-out panel wrapper, 9-panel registry, animation |
| `phases/PHASE-15.md` | — | **NEW** — this document |
| `phases/PHASE-14.md` | 1 | Updated Next link |
| `phases/README.md` | 1 | Added Phase 15 row |
| `CLAUDE.md` | 27 | Updated architecture section for Nexus interface |
| `.claude/launch.json` | 6 | Fixed dev server launch config |

---

## Patterns Used

### View + Drawer
4 top-level views for navigation, contextual drawer for deep-dive. The key insight: views represent **intent** (monitoring, exploring, building, reviewing), while panels represent **subsystems** (fleet, commerce, memory). Cross-cutting these two dimensions via the drawer means any subsystem is accessible from any intent — without tabs.

### Widget-as-Summary
Each Command Center widget condenses a subsystem to its most important metric. The widget is a read operation; clicking it is an inspect operation. This two-tier interaction (glance vs. deep-dive) reduces cognitive load — you see 10 status numbers at once, then drill into the one that needs attention.

### Radial SVG Layout
Nodes positioned via `Math.cos(angle)` / `Math.sin(angle)` at fixed radii. Inner ring (intelligence) at 130px, outer ring (capabilities) at 260px. Edges defined as an adjacency list, hover triggers edge traversal to highlight all connections. This layout makes system topology visible — you can see that Memory Bridge connects to 5 outer systems, making it the most connected intelligence component.

### Content Aggregation
Library merges 7 independent API endpoints into one sorted, filterable feed. Each item is normalized with `_source` and `_label` metadata tags. `Promise.all` fetches in parallel, then items are merged and sorted by timestamp. Filter tabs control which endpoints are queried (not which items are shown), so switching tabs triggers new fetches rather than client-side filtering of a pre-loaded set.

### Zero-Deletion Refactor
All 10 panel components are preserved unchanged in `client/src/panels/`. They were not modified, renamed, or restructured. The DetailDrawer simply imports and renders them based on a panel ID lookup. This means:
- Rolling back to the old 10-tab layout is trivial (restore App.jsx from `pre-nexus-checkpoint` branch)
- Panels can still be improved independently in future phases
- No risk of breaking panel functionality during the layout transformation

### Backdrop Dismissal
A fixed overlay div (`inset: 0`, `z-index: 99`) sits between the main content and the drawer. Clicking it calls `closeDrawer()`. This is more reliable than click-outside detection (which has edge cases with portals and event bubbling) and provides visual feedback that a modal state is active.

---

## Design Language

### Colors (maintained from existing panels)
- Background: `#0a0a0f` (main), `#111118` (cards), `#0a0a14` (inset fields)
- Text: `#e0e0e8` (primary), `#888` (secondary), `#666` (muted), `#555` (disabled)
- Borders: `#222` (standard), `#333` (input fields), `#1a1a2e` (subtle separators)
- Accent: `#a78bfa` (brand purple — CHANDRA identity)
- Per-widget colors: green, amber, indigo, purple, pink, violet, emerald, cyan, purple, yellow

### Typography
- View titles: 24px, weight 700
- Widget labels: 12px, weight 600
- Widget metrics: 16px, weight 700 (in widget color)
- Section headers: 14px, weight 600
- Body text: 12-13px, weight 400

### Spacing
- View padding: 32px
- Widget grid gap: 14px
- Card padding: 18-20px
- Section spacing: 20-28px

### Animation
- Drawer slide: `translateX(100%) → translateX(0)`, 0.2s ease-out
- Widget hover: border-color and background-color transition, 0.2s
- Nav button: all properties transition, 0.15s

---

## API Endpoint Coverage by View

### Command Center (reads from 7 endpoints)
| Endpoint | Data Used |
|----------|-----------|
| `GET /api/fleet/agents` | Agent count, model names |
| `GET /api/workflows` | Workflow count |
| `GET /api/mcp/servers` | Server count |
| `GET /api/fraymus/health` | Autonomous status, generation, fitness, intelligence mood/dreams/ledger/cognition |
| `GET /api/vertiso/stats` | Total memories, consolidations |
| `GET /api/automations` | Automation count |
| `GET /api/events?limit=20` | Recent activity feed |

### Constellation (reads from 3 endpoints)
| Endpoint | Data Used |
|----------|-----------|
| `GET /api/fraymus/health` | Intelligence subsystem statuses for node tooltips |
| `GET /api/fleet/agents` | Agent count for Fleet node tooltip |
| `GET /api/vertiso/stats` | Memory count for Memory Bridge / Vertiso node tooltips |

### Library (reads from 7 endpoints)
| Endpoint | Data Used |
|----------|-----------|
| `GET /api/commerce/runs` | Content pipeline run history |
| `GET /api/apparel/runs` | Apparel pipeline run history |
| `GET /api/shopper/runs` | Mystery Shopper audit history |
| `GET /api/fixer/runs` | Store Fixer run history |
| `GET /api/youtube/board` | Saved outlier videos |
| `GET /api/fleet/threads` | Agent conversation threads |
| `GET /api/workflows` | Workflow definitions |

### Canvas (reads from 2 endpoints — unchanged from Phase 14)
| Endpoint | Data Used |
|----------|-----------|
| `GET /api/workflows` | Workflow CRUD |
| `POST /api/workflows/:id/run` | Workflow execution |

---

## Running Counts

| Metric | Count | Change |
|--------|-------|--------|
| Canvas Node Types | 36 | — |
| Workflow Definitions | 19 | — |
| Fleet Tools | 13 | — |
| Commerce Fleet Tools | 17 | — |
| Commerce Pipelines | 4 | — |
| Client Views | **4** | was 10 tabs |
| Client Panels (as drawer content) | **9** | all preserved |
| Nexus Components | **4** | new |
| Total Client Components | **14** | 4 nexus + 10 panels |
| REST Endpoints (backend) | **74+** | unchanged |
| Phases Complete | **15** | +1 |

---

## Rollback

Safety checkpoint branch `pre-nexus-checkpoint` exists at commit `bfc2919` (Phase 14). To restore the old 10-tab layout:
```bash
git checkout pre-nexus-checkpoint -- client/src/App.jsx
git checkout pre-nexus-checkpoint -- CLAUDE.md
rm -rf client/src/nexus/
```
The panel components were never modified, so no panel rollback is needed.
