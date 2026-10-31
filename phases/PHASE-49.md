# Phase 49: Agent Collaboration Protocol

**Date:** 2026-10-30
**Feature Count:** 61 (was 60)
**Panels:** 25 (was 24)
**Shortcuts:** 17 (was 16)
**Nav Buttons:** 12 (was 11)

---

## What Was Built

Multi-agent collaboration engine with 3 execution strategies, enabling agents to work together on complex goals through structured interaction patterns.

### Backend: Collaboration Engine

**`server/fleet/collab.js`** — Core engine with SQLite-backed session and step tracking:
- **Chain Strategy** — Sequential pipeline: each agent builds on the previous agent's output, passing context forward
- **Parallel Strategy** — Fan-out all agents simultaneously on the same goal, then first agent synthesizes all contributions into a unified result
- **Debate Strategy** — Adversarial: proponent argues for, opponent argues against, judge delivers a verdict
- DB tables: `collab_sessions` (id, initiator, goal, strategy, agents, status, result, timestamps) and `collab_steps` (id, session_id, agent_id, task, result, status, step_order, duration_ms, timestamps)
- `initCollab({ runAgent, broadcast })` — dependency injection of `runAgentAndWait` from fleet runtime
- `createCollab()` / `runCollab()` / `getCollab()` / `listCollabs()` — full CRUD
- Bus events published on `collab.created` and `collab.done`
- WebSocket broadcasts for real-time UI updates

**`server/fleet/collab-routes.js`** — Express Router with 5 REST endpoints:
- `POST /api/collab` — Create + run in one call
- `POST /api/collab/create` — Create only (deferred execution)
- `POST /api/collab/:id/run` — Run an existing session
- `GET /api/collab` — List sessions with limit param
- `GET /api/collab/:id` — Session detail with steps

**`server/runtime.js`** changes:
- Import `runAgentAndWait` from `./fleet/runtime.js`
- Import `initCollab` from `./fleet/collab.js`
- Import `installCollabRoutes` from `./fleet/collab-routes.js`
- Call `initCollab({ runAgent: runAgentAndWait, broadcast })` after bus init
- Call `installCollabRoutes(app)` after leaderboard router
- Added `'agent-collaboration'` to features array (feature #61)

### Frontend: CollabPanel

**`client/src/panels/CollabPanel.jsx`** — 2-tab panel:
- **Create tab**: Goal textarea, 3 strategy cards (Chain/Parallel/Debate) with icons and descriptions, agent picker grid with toggle selection, "Start Collaboration" button with strategy name
- **History tab**: Session list with strategy icons, goal preview, status badges, agent count, timestamps; click to drill into session detail
- **Session Detail view**: Full session info, step-by-step execution cards with status dots, duration, agent output; Final Output / Synthesis / Verdict sections depending on strategy
- Components: `StrategyCard`, `StepCard`, `SessionDetail`
- WebSocket-driven: auto-refreshes session list on `collab` events
- Purple theme consistent with intelligence stack

### Wiring
- **DetailDrawer.jsx** — 25th panel entry: `collab: { component: CollabPanel, label: 'Agent Collaboration' }`
- **App.jsx** — New action handler for `collab`, new nav bar button with `⊗ Collab` label (purple hover)
- **useKeyboardShortcuts.js** — `Ctrl+J` shortcut for Agent Collaboration (17th shortcut)

---

## Architecture Decision: Dependency Injection

The collab engine receives `runAgentAndWait` as an injected function rather than importing fleet internals directly. This keeps the collaboration layer decoupled — it doesn't need to know how agents execute, only that it can call a function with `(userId, agentId, message)` and get a result back. This makes testing and future refactoring simpler.

---

## Files Changed
- `server/fleet/collab.js` — **NEW** — Collaboration engine (248 lines)
- `server/fleet/collab-routes.js` — **NEW** — REST API (59 lines)
- `client/src/panels/CollabPanel.jsx` — **NEW** — UI panel (260 lines)
- `server/runtime.js` — Added imports, init, route wiring, feature flag
- `client/src/nexus/DetailDrawer.jsx` — Added CollabPanel import and panel entry
- `client/src/App.jsx` — Added collab action handler and nav button
- `client/src/useKeyboardShortcuts.js` — Added Ctrl+J shortcut

## Previous Phase
[Phase 48: Agent Leaderboard Upgrade](PHASE-48.md)

## Next Phase
[Phase 50: Workflow Canvas Polish](PHASE-50.md)
