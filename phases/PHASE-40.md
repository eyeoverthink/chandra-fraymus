# Phase 40: Agent Chat Panel

**Date:** 2026-10-30
**Feature Count:** 52 (added `agent-chat-panel`)
**Prev:** [Phase 39 — Keyboard Shortcuts & Quick Actions](./PHASE-39.md)
**Next:** [Phase 41 — TBD](./PHASE-41.md)

---

## Overview

A dedicated conversational chat interface for talking directly with any of the 17+ agents. Replaces the basic "send task" flow in FleetPanel with a proper chat-bubble UI that shows real-time agent responses via polling.

## Files Created

### `client/src/panels/AgentChatPanel.jsx`
Full-featured chat panel with two views:

**Agent Picker View** (no agent selected):
- Grid of agent cards showing name, role, tool count, model
- Hover effects with purple highlight
- Click to select and start conversation

**Chat View** (agent selected):
- Back button + agent name/role header
- Status indicator: amber "Thinking..." with pulse animation while agent is processing, green "Ready" when idle
- Message bubbles with role-based styling:
  - User messages: indigo background, right-aligned
  - Agent messages: dark purple border, left-aligned
  - Tool calls filtered out for clean conversation view
- Auto-scroll to bottom on new messages
- Typing indicator (three pulsing dots) while agent is processing
- Empty state with `◈` icon and prompt to start chatting
- Message input with Enter-to-send

**Polling mechanism:**
- On send: immediately adds user message to UI (optimistic update)
- Starts polling `GET /api/fleet/threads/:id` every 1.5s
- Stops polling when no runs have `status: 'running'`
- Also triggers on WebSocket `fleet` events for faster response

## Files Modified

### `client/src/nexus/DetailDrawer.jsx`
- Added `AgentChatPanel` import
- Added `chat` entry to PANELS map (16th panel)

### `client/src/App.jsx`
- Added "◈ Chat" button in nav bar between search and status
- Added `chat` action handler in `handleShortcut` callback

### `client/src/useKeyboardShortcuts.js`
- Added `{ key: '5', action: 'chat', label: 'Agent Chat' }` to SHORTCUTS array
- Added `5` key handler in hook (8 shortcuts total)

### `server/runtime.js`
- Added `'agent-chat-panel'` to features array (52nd feature)

## Architecture Notes

The chat panel reuses existing infrastructure:
- **`POST /api/fleet/runs`** — starts an agent run with `{ agentId, message, threadId }`
- **`GET /api/fleet/threads/:id`** — retrieves messages, runs, approvals
- **`threadId` continuity** — first message creates a new thread; subsequent messages reuse it for a persistent conversation

No new server code was needed — the existing fleet runtime already supports everything. The panel is pure client-side UX.

## Testing Performed

- [x] Chat button appears in nav bar
- [x] `5` keyboard shortcut opens Agent Chat panel
- [x] Agent picker grid shows all 17 agents
- [x] Clicking agent shows chat view with empty state
- [x] ShortcutHelp overlay updated with `5 → Agent Chat`
- [x] Feature count confirmed at 52 via `/api/health`
