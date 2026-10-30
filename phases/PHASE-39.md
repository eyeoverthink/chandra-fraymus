# Phase 39: Keyboard Shortcuts & Quick Actions

**Date:** 2026-10-30
**Feature Count:** 51 (added `keyboard-shortcuts`)
**Prev:** [Phase 38 — Global Search](./PHASE-38.md)
**Next:** [Phase 40 — Agent Chat Panel](./PHASE-40.md)

---

## Overview

Global keyboard shortcuts for rapid navigation and control across the entire Chandra-FRAYMUS Nexus interface. Shortcuts work from any view and are suppressed when the user is typing in an input field (except Escape and Ctrl+K which always work).

## Files Created

### `client/src/useKeyboardShortcuts.js`
Custom React hook that registers a global `keydown` listener on `document`. Exports a `SHORTCUTS` array describing all available shortcuts for the help overlay.

**Shortcuts defined:**
| Key | Modifier | Action | Description |
|-----|----------|--------|-------------|
| K | Ctrl | `search` | Open GlobalSearch input |
| 1 | — | `view:command` | Switch to Command Center |
| 2 | — | `view:constellation` | Switch to Constellation |
| 3 | — | `view:canvas` | Switch to Canvas |
| 4 | — | `view:library` | Switch to Library |
| Escape | — | `close` | Close drawer / search / help |
| ? | — | `help` | Toggle shortcuts help overlay |

**Input suppression:** Number keys and `?` are ignored when focus is in `<input>`, `<textarea>`, or `contentEditable` elements, so they don't interfere with typing. Ctrl+K and Escape always fire regardless of focus context.

### `client/src/ShortcutHelp.jsx`
Modal overlay component displaying all keyboard shortcuts. Reads the `SHORTCUTS` array from `useKeyboardShortcuts.js` for a single source of truth. Dark themed with purple `<kbd>` styling, centered on screen with semi-transparent backdrop. Closeable via X button or backdrop click.

## Files Modified

### `client/src/App.jsx`
- Imported `useKeyboardShortcuts` and `ShortcutHelp`
- Added `showHelp` and `searchOpen` state
- Added `handleShortcut` callback that dispatches actions (view switching, close, search, help toggle)
- Called `useKeyboardShortcuts({ onAction: handleShortcut })`
- Passed `externalOpen` / `onExternalClose` props to GlobalSearch for Ctrl+K support
- Rendered `<ShortcutHelp>` modal when `showHelp` is true

### `client/src/GlobalSearch.jsx`
- Added `externalOpen` and `onExternalClose` props
- Added `useEffect` that opens search input when `externalOpen` becomes true, then calls `onExternalClose()` to reset the flag
- Enables Ctrl+K from any context to programmatically focus the search input

### `server/runtime.js`
- Added `'keyboard-shortcuts'` to features array (51st feature)

## Architecture Notes

The shortcut system uses a **prop-drilling pattern** rather than a global event emitter because:
1. Only App.jsx needs to dispatch — it already owns view state, drawer state, and search state
2. GlobalSearch just needs an "open" signal — a single boolean prop is simpler than a ref or pub/sub
3. The `externalOpen` flag is immediately reset via `onExternalClose`, acting as a one-shot trigger

The `SHORTCUTS` array is the single source of truth for both the keydown handler and the help overlay, so adding a new shortcut automatically updates the help modal.

## Testing Performed

- [x] `?` toggles ShortcutHelp overlay on/off
- [x] `Escape` closes overlay, drawer, and search
- [x] `1`–`4` switch between all four views
- [x] `Ctrl+K` opens GlobalSearch input
- [x] Number keys suppressed when typing in search input
- [x] Feature count confirmed at 51 via `/api/health`
- [x] No console errors on clean page load
