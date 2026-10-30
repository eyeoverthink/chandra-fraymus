# Phase 37: Notification Toast System

| Field | Value |
|-------|-------|
| **Phase** | 37 |
| **Feature** | `notification-toasts` |
| **Prev** | [Phase 36 — System Settings Panel](PHASE-36.md) |
| **Next** | Phase 38 (TBD) |

## What It Does

Real-time toast notifications that appear bottom-right whenever a WebSocket event fires. Every intelligence, fleet, workflow, and commerce subsystem can surface feedback to the user without requiring them to check the Activity Stream.

## Components

### ToastProvider.jsx (client/src/ToastProvider.jsx)
- React context provider wrapping the entire app
- 6 toast variants with distinct colors:
  - **info** — slate (`#1e293b`) — workflows, cognition, needle, motor, tasks, memory, ledger
  - **success** — green (`#052e16`) — forge, consciousness proofs, deploy (on success)
  - **warning** — amber (`#422006`) — reserved for future use
  - **error** — red (`#350a0a`) — deploy (on error)
  - **agent** — purple (`#1a0a2e`) — agents, heart, dreamer
  - **system** — navy (`#0c1222`) — autonomy, intelligence, health, reflection
- Auto-subscribes to 17 WebSocket event types via `WS_MAP`:
  `agents`, `workflow`, `forge`, `autonomy`, `heart`, `dreamer`, `cognition`, `consciousness`, `intelligence`, `needle`, `motor`, `deploy`, `health`, `tasks`, `memory`, `reflection`, `ledger`
- Toast stack: max 6 visible, auto-dismiss after 4 seconds, click to dismiss
- CSS keyframe animations: `toast-in` (slide up + scale + fade in), `toast-out` (reverse)
- Exports `useToast()` hook with `push(message, variant, duration)` and `dismiss(id)` for manual use from any component

### App.jsx Changes
- `import ToastProvider from './ToastProvider.jsx'`
- Root `<div>` wrapped in `<ToastProvider wsEvent={wsEvent}>`

### runtime.js Changes
- Added `'notification-toasts'` to features array (49th feature)

## WS_MAP Event Mappings

| Event Type | Variant | Example Message |
|-----------|---------|-----------------|
| agents | agent | "Agent Helix started" |
| workflow | info | "Workflow updated #a3f2b1" |
| forge | success | "New agent forged" |
| autonomy | system | "Autonomy evolved" |
| heart | agent | "Feeling: joy (38%)" |
| dreamer | agent | "Dream #3" |
| cognition | info | "Cognition cycle: feel" |
| consciousness | success | "Ouroboros: all passed" |
| intelligence | system | "Intelligence cycle complete" |
| needle | info | "Needle: enqueued" |
| motor | info | "Motor: dispatch" |
| deploy | success/error | "API /my-flow: 42ms" |
| health | system | "Health check updated" |
| tasks | info | "Task: scheduled" |
| memory | info | "Memory updated: dream-insight" |
| reflection | system | "Reflection cycle complete" |
| ledger | info | "Ledger: phase-37 #1" |

## Architecture

```
WebSocket event → useWebSocket.js → wsEvent prop → ToastProvider
                                                      ├── WS_MAP lookup (17 types)
                                                      ├── variant resolution (6 colors)
                                                      ├── push to stack (max 6)
                                                      └── auto-dismiss (4s timer)
```

## How to Add New Toast Types

1. Add a new entry to `WS_MAP` in `ToastProvider.jsx` with `variant` and `fmt` function
2. Ensure the server calls `broadcast('your-type', payload)` — that's it

## Manual Toast Usage

```jsx
import { useToast } from './ToastProvider.jsx';

function MyComponent() {
  const { push, dismiss } = useToast();
  push('Custom message', 'success', 6000); // variant, duration in ms
}
```

## Verification

- Server broadcasts `heart`, `ledger`, and agent events over WebSocket
- ToastProvider picks up events via `useEffect` watching `wsEvent`
- Toast container renders `position: fixed; bottom: 16px; right: 16px; z-index: 9999`
- All 6 variants display correctly with proper colors, icons, and animations
- Click-to-dismiss and auto-dismiss both functional
