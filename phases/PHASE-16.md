# Phase 16: Command Bar + Live Activity Stream

**Commit:** `9fdb842`
**Date:** 2026-10-30
**Previous:** [Phase 15 — Chandra Nexus Unified Interface](PHASE-15.md)
**Next:** [Phase 17 — Living Constellation](PHASE-17.md)

---

## Summary

Transforms the Nexus from a read-only dashboard into an interactive command center. Two additions:

1. **Command Bar** — a persistent input at the bottom of the Command Center where you type natural commands to talk to agents, launch pipelines, run workflows, and trigger actions. No more 5-click drill-downs through drawers.
2. **Live Activity Stream** — replaces the static "Recent Activity" section with a real-time WebSocket-driven event feed. Events appear as they happen, each one clickable.

**Design goal:** Make the most common action (talking to an agent) take 1 step instead of 5. Make the system's autonomous operations visible in real-time.

---

## Architecture

### Command Bar (client/src/nexus/CommandBar.jsx)

A bottom-anchored input bar inside the Command Center view with:

**Input parsing** — the bar recognizes these command patterns:

| Pattern | Maps to | API Call |
|---------|---------|----------|
| `@agentname message` | Talk to a specific agent | `POST /api/fleet/runs { agentId, message }` |
| `run content-pipeline "topic"` | Launch Content-to-Commerce | `POST /api/commerce/pipeline { topic }` |
| `run apparel "niche"` | Launch Apparel Pipeline | `POST /api/apparel/pipeline { niche }` |
| `run shopper "url"` | Launch Mystery Shopper | `POST /api/shopper/audit { store_url }` |
| `run fixer` | Launch Store Fixer | `POST /api/fixer/pipeline {}` |
| `run workflow "name"` | Execute workflow by name | `POST /api/workflows/:id/run` |
| Anything else | Default agent (fraymus_prime) | `POST /api/fleet/runs { agentId: 'fraymus_prime', message }` |

**UI elements:**
- Fixed to bottom of Command Center, full width, 60px height
- Input field with placeholder: `Type a command... (@agent, run pipeline, or just ask)`
- Agent autocomplete dropdown when typing `@` — fetches from `/api/fleet/agents`
- Submit button + Enter key
- Response area: slide-up panel (max 300px) showing the last command's result
- Typing indicator while waiting for agent/pipeline response
- Command history (up/down arrow, stored in localStorage)

**Response handling:**
- Agent runs return a `run_id` — poll `GET /api/fleet/threads/:threadId` for completion, or listen for WebSocket `agents` event
- Pipeline runs return immediately with `run_id` — result arrives via WebSocket `event` broadcast
- Workflow runs return result directly from the POST

### Live Activity Stream (enhancement to CommandCenter.jsx)

Replace the static `Recent Activity` section with a live-updating event feed:

**Data source:** WebSocket events already broadcast from the server. Current types:
- `agents` — agent state changes (run started, completed, failed)
- `event` — general system events (pipeline stages, autonomy pulses)
- `memory` — memory writes/reads
- `v3` — FRAYMUS V3 security events

**UI changes to CommandCenter.jsx:**
- Remove the fetch-once `/api/events?limit=20` call for the activity section
- Add a `useRef` array to accumulate WebSocket events in real-time (cap at 100)
- Each event card shows: timestamp, type badge (color-coded), summary text, source
- New events slide in from top with CSS animation
- Click any event → opens the relevant drawer (agent event → fleet drawer, pipeline event → commerce drawer)
- Subtle pulse animation on the "Recent Activity" header when new events arrive
- "Clear" button to reset the feed

**Event enrichment (backend):**
New endpoint: `POST /api/command` — a thin router that parses the command string and dispatches to the right subsystem. This keeps parsing logic on the server (where it can be extended later for natural language understanding) rather than hardcoding regex patterns in the client.

```
POST /api/command
Body: { text: "@helix analyze the store" }
Response: { type: "agent_run", runId: "...", threadId: "...", agentId: "helix" }
```

The server parses the text, identifies the intent, calls the right internal function, and returns a uniform response shape. This is a 50-line router, not an NLP system — just string matching for the patterns in the table above.

### WebSocket Enhancement (server/app.js)

Currently `broadcast()` sends `{ type, payload }` but payload is often just `{}` or `{ id }`. For the live stream to be useful, we need richer event payloads:

- Agent broadcasts include: `{ agentId, agentName, action: 'started'|'completed'|'failed', message_preview }`
- Pipeline broadcasts include: `{ pipeline, stage, status, topic_or_url }`
- Autonomy broadcasts include: `{ type: 'heartbeat'|'evolution', generation, fitness }`

This is additive — existing broadcast calls get enriched payloads, the `type` field stays the same.

---

## Files to Create

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `client/src/nexus/CommandBar.jsx` | ~180 | Command input, parsing, autocomplete, response display |
| `server/command-router.js` | ~80 | `POST /api/command` — parse text → dispatch to subsystem |

## Files to Modify

| File | Change |
|------|--------|
| `client/src/nexus/CommandCenter.jsx` | Replace static activity with live WebSocket stream, add CommandBar at bottom |
| `server/app.js` | Register command router route, enrich broadcast payloads |
| `client/src/App.jsx` | Pass `onOpenDrawer` callback into CommandCenter for event clicks (already done) |
| `CLAUDE.md` | Add command router docs, update CommandCenter description |
| `phases/PHASE-15.md` | Update Next link |
| `phases/README.md` | Add Phase 16 row |

## Files NOT Modified

All existing panels, DetailDrawer, ConstellationView, LibraryView, WorkflowCanvas, useWebSocket — untouched.

---

## Interaction Flow

### Command Bar: Talk to Agent
```
User types: @helix what models do you have access to?
  → Client sends POST /api/command { text: "@helix what models do you have access to?" }
  → Server parses: agentId = "helix", message = "what models do you have access to?"
  → Server calls startRun('local', 'helix', message)
  → Server returns { type: "agent_run", runId, threadId, agentId: "helix" }
  → Client shows typing indicator
  → WebSocket broadcasts { type: "agents", payload: { agentId: "helix", action: "started" } }
  → Live stream shows: "⚡ Helix started: what models do you have..."
  → Agent completes, WebSocket broadcasts { type: "agents", payload: { agentId: "helix", action: "completed" } }
  → Client fetches thread, shows response in slide-up panel
  → Live stream shows: "✓ Helix completed (2.3s)"
```

### Command Bar: Launch Pipeline
```
User types: run content-pipeline "AI fitness trackers"
  → Client sends POST /api/command { text: 'run content-pipeline "AI fitness trackers"' }
  → Server parses: pipeline = "commerce", topic = "AI fitness trackers"
  → Server calls runContentPipeline(topic, ...)
  → Server returns { type: "pipeline_run", pipeline: "commerce", runId }
  → Live stream shows: "◆ Content Pipeline started: AI fitness trackers"
  → As stages complete, WebSocket events fire
  → Live stream updates: "◆ Stage 2/5: Product generation..."
```

### Live Stream: Click to Inspect
```
Live stream shows: "⚡ Cantor completed sentiment analysis (1.8s)"
  → User clicks the event
  → Drawer opens with FleetPanel showing Cantor's thread
```

---

## Design Specs

### Command Bar Layout
```
┌──────────────────────────────────────────────────────┐
│ Command Center content (widgets, intelligence, etc.)  │
│                                                       │
│ ┌─────────────────────────────────────────────────┐  │
│ │ Live Activity Stream (scrollable, max 300px)     │  │
│ │  ✓ Helix completed: model analysis (2.3s)       │  │
│ │  ◆ Content Pipeline stage 3/5: SEO optimization │  │
│ │  ♥ Heart mood shift: curious → focused          │  │
│ │  ⚡ Autonomy heartbeat: gen 47, fitness 0.83    │  │
│ └─────────────────────────────────────────────────┘  │
│                                                       │
│ ┌─────────────────────────────────────────────────┐  │
│ │ ◈ Type a command... (@agent, run pipeline)  [⏎] │  │
│ └─────────────────────────────────────────────────┘  │
│ ┌─ Response Panel (slides up when active) ────────┐  │
│ │  Helix: You have access to llama3.2, qwen2.5,   │  │
│ │  mistral, and codellama models via Ollama...     │  │
│ └─────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Event Badge Colors
| Event Type | Icon | Color | Drawer Target |
|------------|------|-------|---------------|
| Agent start | ⚡ | `#6366f1` indigo | fleet |
| Agent complete | ✓ | `#22c55e` green | fleet |
| Agent error | ✗ | `#ef4444` red | fleet |
| Pipeline stage | ◆ | `#ec4899` pink | commerce |
| Pipeline complete | ◆ | `#22c55e` green | commerce |
| Autonomy heartbeat | ⟳ | `#06b6d4` cyan | dashboard |
| Autonomy evolution | ∞ | `#a78bfa` violet | vertiso |
| Heart mood | ♥ | `#f59e0b` amber | intelligence |
| Dream generated | ☾ | `#8b5cf6` purple | intelligence |
| Memory write | ◇ | `#a78bfa` violet | vertiso |
| V3 security | ◈ | `#10b981` emerald | dashboard |

### Command Autocomplete
When user types `@`, show a dropdown of all 17 agents:
- Filtered as they type (e.g., `@hel` shows only Helix)
- Each row: agent icon + name + role (one line)
- Arrow keys to navigate, Enter/Tab to select
- Dropdown appears above the input (since bar is at bottom)

---

## Patterns

### Server-Side Command Parsing
Keep parsing on the server so it can be upgraded to LLM-based intent recognition later without changing the client. The client just sends `{ text }` and gets back a uniform response.

### Optimistic Live Stream
Events are added to the stream array immediately from WebSocket — no round-trip to `/api/events`. The `/api/events` fetch on mount still loads the initial batch for history, but after that it's pure WebSocket.

### Response Panel as Mini-Thread
The response panel shows the last agent reply, but it's really rendering a single thread message. This means it's compatible with multi-turn: send another `@helix` message and it appends to the same thread.

---

## Running Counts (projected)

| Metric | Count | Change |
|--------|-------|--------|
| Canvas Node Types | 36 | — |
| Workflow Definitions | 19 | — |
| Fleet Tools | 13 | — |
| Commerce Fleet Tools | 17 | — |
| Commerce Pipelines | 4 | — |
| Client Views | 4 | — |
| Client Panels (drawer) | 9 | — |
| Nexus Components | **5** | +1 (CommandBar) |
| REST Endpoints | **75+** | +1 (POST /api/command) |
| Phases Complete | **16** | +1 |
