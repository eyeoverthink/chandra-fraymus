# Phase 43 — Agent Profiles Panel

**Date:** 2026-10-30
**Commit:** (pending)

## Summary

Added a dedicated Agent Profiles panel that enriches static manifest data with live operational statistics from the database. The panel provides a fleet-wide overview grid and a detailed per-agent profile view showing run history, bus activity, memory stats, and tool capabilities.

## What Was Built

### Server: `server/agent-profiles.js`
- **`GET /api/agent-profiles`** — Returns all agent profiles enriched with stats
- **`GET /api/agent-profiles/:id`** — Returns a single enriched profile
- Batch SQL queries (no N+1): run counts from `runs` JOIN `threads`, thread counts, bus messages sent/received, agent memory counts with avg confidence
- All queries wrapped in `safe()` try/catch — missing tables don't crash
- Strips `systemPrompt` from output (security: never expose prompts to client)

### Client: `client/src/panels/AgentProfiles.jsx`
- **Fleet List View**: Responsive grid of agent cards with search filter
  - Avatar circle with first letter + role-based color
  - Description (2-line clamp), stat badges (runs, threads, msgs, mems)
  - Success rate pill with threshold coloring (green ≥80%, amber ≥50%, red <50%)
- **Profile Detail View**: Click-through from any agent card
  - Agent header with avatar, name, role, model
  - Description block
  - 7 stat pills: Runs, Success, Failed, Threads, Bus Sent, Bus Recv, Memories
  - Success rate progress bar (animated, threshold-colored)
  - Memory confidence percentage
  - Last run timestamp
  - Tool chips with role-colored borders
  - Greeting quote (italic)
  - Back-to-fleet navigation
- **Role color mapping**: concierge→indigo, orchestrator→violet, researcher→blue, analyst→sky, developer→emerald, creative→amber, security→red, commerce→pink

### Wiring
- **DetailDrawer.jsx**: Added as 19th panel (`profiles`)
- **useKeyboardShortcuts.js**: Shortcut `8` → Agent Profiles (11 total shortcuts)
- **App.jsx**: Nav button `⊕ Profiles` (amber hover), `handleShortcut` handler for `profiles`
- **runtime.js**: Router mounted, feature flag `agent-profiles` added (55 total features)

## Files Changed

| File | Change |
|------|--------|
| `server/agent-profiles.js` | **NEW** — Express router with enriched profile endpoints |
| `client/src/panels/AgentProfiles.jsx` | **NEW** — Fleet list + profile detail panel (~185 lines) |
| `client/src/nexus/DetailDrawer.jsx` | Import + 19th panel entry |
| `client/src/useKeyboardShortcuts.js` | Shortcut `8` + handler |
| `client/src/App.jsx` | Nav button + shortcut handler |
| `server/runtime.js` | Import, route mount, feature flag |

## Patterns Used

- **Batch SQL aggregation**: GROUP BY queries into Maps for O(1) lookup per agent, avoiding N+1
- **List→Detail navigation**: `selected` state toggles between grid and detail view
- **Role-based color system**: Keyword matching on role strings for visual identity
- **Defensive array handling**: `Array.isArray(tools)` check handles string values like `"*"`
- **Stat pill component**: Reusable `StatPill` with configurable label/value/color

## Running Counts

- Features: **55** (was 54)
- Detail Drawer panels: **19** (was 18)
- Keyboard shortcuts: **11** (was 10)
- Nav bar buttons: **4** (Chat, Timeline, Metrics, Profiles)
- Phases complete: **43** (was 42)
- Server route files: 5 router modules (timeline, metrics, agent-profiles, fleet/routes, search)

## Bug Fixed During Development

- `tools.map is not a function` — Concierge manifest has `tools: "*"` (a string, not array). Fixed with `Array.isArray()` guard in ProfileDetail.

---

**Previous:** [Phase 42 — System Metrics Panel](PHASE-42.md)
**Next:** Phase 44 (TBD)
