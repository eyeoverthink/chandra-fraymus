# Phase 14: Workflow Canvas Polish

**Commit:** `6aa2f8d`
**Date:** 2026-10-30
**Previous:** [Phase 13 — Backend Visibility Completion](PHASE-13.md)
**Next:** Phase 15 (pending)

## Summary

Made the 19 pre-built workflow definitions accessible from the visual canvas and added per-node execution status visualization. Before this phase, the canvas could only load user-saved workflows from the DB — the 8 definitions with pre-built visual layouts (canvas_nodes/canvas_edges) were invisible. Nodes also stayed static during runs with no feedback on which succeeded or failed.

## What Was Built

### 1. Definitions API Endpoint (server/workflow/routes.js)
- **New endpoint:** `GET /api/workflows/definitions` — serves the 8 workflow definitions that have `canvas_nodes` arrays
- Returns name, description, nodes, and edges for each template
- Placed before the `/:id` route to avoid Express parameter collision
- Imports from `definitions.js` — zero duplication of definition data

### 2. Template Picker (client/src/panels/WorkflowCanvas.jsx)
- **"Load template" dropdown** in toolbar shows all 8 pre-built definitions
- Converts PascalCase names to readable labels (e.g., "Content To Commerce Pipeline")
- Loading a template: clears current canvas, sets nodes/edges from definition, names the workflow, clears currentId (unsaved state)
- Templates available: Content-to-Commerce, Apparel Production, Mystery Shopper Audit, Store Fixer, Intelligence Analysis, Consciousness Checkpoint, Intelligent Commerce, plus any future definitions that include canvas_nodes

### 3. Node Execution Status Visualization (client/src/panels/WorkflowCanvas.jsx)
- **Running state:** When a workflow runs, all nodes get amber pulsing borders (CSS `@keyframes pulse` animation)
- **Success state:** After run completes, nodes with successful results get green borders + "OK" badge + duration display
- **Error state:** Failed nodes get red borders + "ERR" badge
- **Status propagation:** `applyNodeStatuses()` updates node data without losing position/connections — uses ReactFlow's functional setNodes pattern
- **Duration display:** Each node shows its individual execution time in ms after completion

### 4. Node Card Enhancement (NodeCard component)
- Added `_status` and `_durationMs` fields to node data (prefixed with `_` to avoid collision with workflow engine fields)
- Status badge (OK/ERR/...) positioned at right edge of node header
- Glow effect changes based on status: amber pulse for running, green/red glow for complete
- Duration text below prompt when available

## Files Changed (4 files, +75 -7)

| File | Change |
|------|--------|
| `server/workflow/routes.js` | +WORKFLOWS import, +GET /api/workflows/definitions endpoint (8 templates) |
| `client/src/panels/WorkflowCanvas.jsx` | +definitions state/fetch, +template picker dropdown, +node status tracking, +NodeCard status visualization, +CSS pulse animation |
| `phases/PHASE-13.md` | Updated Next link to point to Phase 14 |
| `CLAUDE.md` | Updated WorkflowCanvas + definitions.js descriptions |

## Patterns Used

- **Route ordering guard:** `/api/workflows/definitions` registered before `/api/workflows/:id` — Express matches `:id` greedily, so the static path must come first
- **Functional state update:** `applyNodeStatuses()` uses `setNodes(nds => nds.map(...))` to overlay status without triggering re-renders on position/connection data
- **Underscore-prefixed fields:** `_status`, `_durationMs` on node data avoids collision with the workflow engine's own data fields that get serialized to the DB
- **Template-to-canvas conversion:** Definition canvas_nodes have a different shape than ReactFlow nodes — template loader maps `{ id, type, position, data }` to `{ id, type: 'custom', position, data: { type, prompt, label } }`

## Running Counts

| Metric | Count |
|--------|-------|
| Canvas Node Types | 36 |
| Workflow Definitions | 19 |
| Pre-built Templates | **8** (new metric — definitions with canvas layouts) |
| Fleet Tools | 13 |
| Commerce Fleet Tools | 17 |
| Commerce Pipelines | 4 |
| Client Panels | 10 |
| Phases Complete | **14** |
