# Phase 35 — Agent Forge + Synthesis Panel

| Field | Value |
|-------|-------|
| **Phase** | 35 |
| **Title** | Agent Forge + Synthesis Panel |
| **Status** | Complete |
| **Prev** | [Phase 34 — Error Boundary + System Resilience](PHASE-34.md) |
| **Next** | Phase 36 (TBD) |

## Summary

Creates a dedicated UI panel for two Phase 24 backend features that previously had zero frontend: **Agent Forge** (create new agents from natural language goals via Ollama) and **Workflow Synthesis** (generate DAG workflows from goal descriptions). The panel surfaces the full lifecycle — create, view history, and remove — for both subsystems in a tabbed interface.

## Architecture

```
ForgePanel.jsx (2-tab interface)
  ├─ Agent Forge Tab
  │   ├─ Goal input + Context textarea → POST /api/fleet/forge
  │   ├─ Result card (success/error) with tool tags
  │   └─ Forged Agents history → GET /api/fleet/forge/history
  │       └─ Remove button → DELETE /api/fleet/forge/:agentId
  └─ Workflow Synthesis Tab
      ├─ Goal input + Constraints textarea → POST /api/workflows/synthesize
      ├─ Result card with node/edge counts and type tags
      └─ Synthesized Workflows history → GET /api/workflows/synthesized

DetailDrawer.jsx  → panel registry: 'forge' → ForgePanel (14 panels total)
CommandCenter.jsx → widget grid: 'Forge + Synth' (15 widgets total)
runtime.js        → feature flag: 'forge-synthesis-panel' (47 features total)
```

## Files Changed

| File | Change |
|------|--------|
| `client/src/panels/ForgePanel.jsx` | **NEW** — 298-line tabbed panel with Agent Forge + Workflow Synthesis |
| `client/src/nexus/DetailDrawer.jsx` | Import + register ForgePanel as 'forge' panel (14th panel) |
| `client/src/nexus/CommandCenter.jsx` | Add 'Forge + Synth' widget (15th widget) with amber color |
| `server/runtime.js` | Add 'forge-synthesis-panel' feature flag (47th feature) |

## API Endpoints Used

### Agent Forge (from Phase 24)
- `POST /api/fleet/forge` — `{ goal, context? }` → Ollama generates agent manifest → saved to `data/agents/`
- `GET /api/fleet/forge/history` — lists all forged agents with metadata
- `DELETE /api/fleet/forge/:agentId` — removes a forged agent and reloads manifests

### Workflow Synthesis (from Phase 24)
- `POST /api/workflows/synthesize` — `{ goal, constraints? }` → Ollama selects from NODE_CATALOG → validates DAG → saves to DB
- `GET /api/workflows/synthesized` — lists all synthesized workflows with node/edge counts

## Design Decisions

1. **Two tabs, not two panels** — Forge and Synthesis are conceptually linked (both are LLM-driven creation tools), so a single panel with tab switching keeps the Detail Drawer registry clean
2. **WebSocket-driven refresh** — history lists reload on `agents`, `workflow`, or `forge` WebSocket events, keeping the UI live without polling
3. **Amber + Purple theming** — Agent Forge uses amber (#f59e0b) matching the fleet/intelligence brand, Workflow Synthesis uses purple (#a78bfa) matching the workflow system
4. **Defensive response handling** — results display handles both success and error states, with flexible field access (`forgeResult.name || forgeResult.agentId`) to accommodate varying API response shapes

## Counts After Phase 35

| Metric | Count |
|--------|-------|
| Features | 47 |
| Detail Drawer panels | 14 |
| Command Center widgets | 15 |
| REST endpoints | ~190+ |
| Agent manifests | 17 (+ forged) |
| Media engines | 5 |
| Workflow node types | 47 |
| Fleet tools | 54 |
| Phases complete | 35 |
| Components with ErrorBoundary | 18 (4 views + 14 panels) |
