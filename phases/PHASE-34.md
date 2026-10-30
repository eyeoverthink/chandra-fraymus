# Phase 34 — Error Boundary + System Resilience

| Field | Value |
|-------|-------|
| **Phase** | 34 |
| **Title** | Error Boundary + System Resilience |
| **Prev** | [Phase 33 — Media Hub Panel](PHASE-33.md) |
| **Next** | Phase 35 (TBD) |

## Summary

Added React ErrorBoundary wrapping all 4 Nexus views and all 13 Detail Drawer panels. A crashed component now shows a "Component crashed" UI with a Retry button and expandable stack trace instead of white-screening the entire app. Client-side errors are POSTed to `/api/client-error` for server-side logging. The WebSocket hook now exposes connection status (`connected`/`connecting`/`reconnecting`/`error`) and the nav bar shows a reconnection indicator when disconnected.

**Motivation:** Phase 33's Health Monitor WebSocket crash proved the system needed resilience at the React level — one bad render in any panel could white-screen the entire app. This phase ensures individual components can fail gracefully without taking down the whole UI.

## Architecture

```
App.jsx
├── ErrorBoundary label="Command Center"
│   └── CommandCenter
├── ErrorBoundary label="Constellation"
│   └── ConstellationView
├── ErrorBoundary label="Canvas"
│   └── WorkflowCanvas
├── ErrorBoundary label="Library"
│   └── LibraryView
└── DetailDrawer
    └── ErrorBoundary label={panel.label}
        └── <PanelComponent />
```

When a wrapped component throws during render:
1. `getDerivedStateFromError` sets `hasError: true`
2. `componentDidCatch` POSTs error details to `/api/client-error`
3. The boundary renders a crash UI (warning icon, error message, Retry button, collapsible stack trace)
4. Clicking Retry resets the boundary state, re-rendering the child component

## Files Changed

| File | Change |
|------|--------|
| `client/src/ErrorBoundary.jsx` | **NEW** — React class component error boundary with retry UI, stack trace display, and server-side error reporting |
| `client/src/App.jsx` | Wrapped all 4 Nexus views in ErrorBoundary; destructured new useWebSocket return; added reconnection status indicator in nav bar |
| `client/src/nexus/DetailDrawer.jsx` | Wrapped panel content in ErrorBoundary |
| `client/src/useWebSocket.js` | Added `wsStatus` state tracking (`connecting`/`connected`/`reconnecting`/`error`); returns `{ lastEvent, wsStatus }` instead of bare event |
| `server/runtime.js` | Added `POST /api/client-error` + `GET /api/client-errors` endpoints; registered `error-boundary-resilience` feature flag |
| `CLAUDE.md` | Added ErrorBoundary.jsx documentation |

## Key Implementation Details

- **React class component is required** — `componentDidCatch` and `getDerivedStateFromError` have no hooks equivalent, so even in a hooks-first codebase this is the one class component
- **Error boundaries catch render errors only** — async errors and event handlers need try/catch; that's why Phase 33 needed both server-side fix AND client-side defense
- **Circular ring buffer** — `/api/client-error` keeps a capped 100-entry array, shifting old entries to prevent memory leaks
- **WebSocket status doesn't interfere with events** — `useWebSocket` returns an object `{ lastEvent, wsStatus }` with the event aliased to `wsEvent` in App.jsx for backward compatibility

## Running Counts

| Metric | Count |
|--------|-------|
| Features | 46 |
| Phases complete | 34 |
| Client components with error boundaries | 17 (4 views + 13 panels) |
| New REST endpoints | 2 (`/api/client-error`, `/api/client-errors`) |
