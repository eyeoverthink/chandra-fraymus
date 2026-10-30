# Phase 47 — System Pulse Panel

**Previous:** [Phase 46 — Evolution Log Panel](./PHASE-46.md)
**Next:** Phase 48 (TBD)

## Summary

System Pulse is the capstone dashboard — a single-glance health snapshot that aggregates data from every subsystem into one unified panel. It queries 15+ SQLite tables through one backend endpoint and presents the results as glowing PulseCards with live stats, sparklines, and auto-refresh.

## What Was Built

### Backend: `server/system-pulse.js`
- Express Router with `GET /api/system-pulse`
- `safe()` / `safeOne()` query wrappers — missing tables don't crash
- Aggregates: fleet (agents, forged, memories), bus (total, today, hour, topics, subscriptions), runs (7 tables → unified by-type counts), evolution (reflections, verifications, daemon cycles, forged, synthesized), vertiso (memories, RSI evals, RSI gens), workflows, entities, healthSparkline (last 20 CPU samples), recentEvents (last 10), commerce (pipeline + apparel status counts), uptime

### Frontend: `client/src/panels/SystemPulse.jsx`
- 7-color COLORS map: fleet=#a78bfa, bus=#22d3ee, runs=#ef4444, evolution=#c084fc, vertiso=#34d399, workflows=#60a5fa, commerce=#f472b6
- `PulseCard` — glowing ring indicator + big stat + sub-stats + optional children
- `Spark` — mini sparkline bar chart component
- `StatRow` — labeled stat row for card interiors
- 6 main pulse cards: Agent Fleet, Bus Traffic, Total Runs, Evolution, Vertiso Memory, Workflows
- Commerce pipeline section with status breakdown
- Recent events feed with type pills and relative timestamps
- 15-second auto-refresh interval + WebSocket-triggered immediate refresh
- Header shows uptime + last refresh time

### Integration Points
- **DetailDrawer.jsx** — 23rd panel entry (`pulse`)
- **useKeyboardShortcuts.js** — `Ctrl+P` opens System Pulse (15th shortcut)
- **App.jsx** — 9th nav button (♥ green), `pulse` handler in shortcut dispatcher
- **runtime.js** — `app.use(systemPulseRouter)`, 59th feature in health endpoint

## Files Changed

| File | Change |
|------|--------|
| `server/system-pulse.js` | **NEW** — aggregation endpoint |
| `client/src/panels/SystemPulse.jsx` | **NEW** — pulse dashboard panel |
| `client/src/nexus/DetailDrawer.jsx` | Added SystemPulse import + panel entry |
| `client/src/useKeyboardShortcuts.js` | Added Ctrl+P → pulse shortcut |
| `client/src/App.jsx` | Added pulse handler + nav button |
| `server/runtime.js` | Added system-pulse route + feature |

## System Counts After Phase 47

| Metric | Count |
|--------|-------|
| Features | 59 |
| Detail Drawer panels | 23 |
| Keyboard shortcuts | 15 |
| Nav bar buttons | 9 |
| Server routes (routers) | 30+ |
| Database tables | 71 |
| Agent fleet | 54 (17 manifest + 37 dynamic) |

## Architecture Pattern

The System Pulse follows the **union adapter pattern** established in Run History and Evolution Log — normalizing heterogeneous table schemas into common shapes. It extends this by querying ALL subsystems in a single request, making it the most comprehensive aggregation endpoint in the system.

```
GET /api/system-pulse
  ├── fleet: agents + forged_agents + agent_memories
  ├── bus: bus_messages + bus_subscriptions
  ├── runs: runs + workflow_runs + automation_runs + commerce/apparel/mystery/fixer
  ├── evolution: reflections + verification_loops + daemon_cycles + forged + synthesized
  ├── vertiso: vertiso_memories + rsi_evaluations + rsi_generations
  ├── workflows: workflows
  ├── entities: fraymus_entities
  ├── healthSparkline: health_metrics (last 20 CPU)
  ├── recentEvents: events (last 10)
  └── commerce: commerce_pipeline_runs + apparel_pipeline_runs (by status)
```

## Screenshots

See screenshots delivered during Phase 47 completion showing:
- Top row: Agent Fleet (54), Bus Traffic (16), Total Runs (7 across 4 types)
- Bottom row: Evolution (12 autonomous actions), Vertiso (16 RSI evals), Workflows (5) + 33 entities
- Commerce pipelines section with apparel success runs
