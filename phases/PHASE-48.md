# Phase 48 — Agent Leaderboard Panel

**Previous:** [Phase 47 — System Pulse Panel](./PHASE-47.md)
**Next:** Phase 49 (TBD)

## Summary

Agent Leaderboard ranks every agent in the fleet by a composite score computed from runs completed, bus messages sent, memories stored, and agents forged. It adds gamification to the autonomous fleet, making it immediately visible which agents are most active and productive.

## What Was Built

### Backend: `server/leaderboard.js`
- Express Router with `GET /api/leaderboard`
- Aggregates data from 5 tables: `agents`, `runs`, `bus_messages`, `agent_memories`, `forged_agents`
- Composite scoring formula: `(runs * 10) + (successes * 5) + (busMessages * 2) + (memories * 3) + (forged * 20) + (avgConfidence * 10)`
- Returns: ranked leaderboard, totals, title holders (Top Runner/Communicator/Scholar/Forger), forge lineage

### Frontend: `client/src/panels/LeaderboardPanel.jsx`
- 4 title holder cards with emoji badges and accent colors
- Totals bar showing aggregate system activity
- Ranked table with medal badges (gold/silver/bronze), gradient score bars, color-coded stat pills
- Forge lineage section showing who forged what and when
- 30-second auto-refresh + WebSocket-triggered refresh

### Scoring System
| Activity | Points |
|----------|--------|
| Run completed | 10 |
| Successful run | +5 bonus |
| Bus message sent | 2 |
| Memory stored | 3 |
| Agent forged | 20 |
| Confidence bonus | avg * 10 |

### Title System
| Title | Criteria | Color |
|-------|----------|-------|
| Top Runner | Most runs | #ef4444 (red) |
| Top Communicator | Most bus messages | #22d3ee (cyan) |
| Top Scholar | Most memories | #a78bfa (purple) |
| Top Forger | Most forged agents | #f59e0b (amber) |

## Integration Points
- **DetailDrawer.jsx** — 24th panel entry (`leaderboard`)
- **useKeyboardShortcuts.js** — `Ctrl+L` opens Agent Leaderboard (16th shortcut)
- **App.jsx** — 10th nav button (★ amber), `leaderboard` handler
- **runtime.js** — `app.use(leaderboardRouter)`, 60th feature

## Files Changed

| File | Change |
|------|--------|
| `server/leaderboard.js` | **NEW** — scoring + ranking endpoint |
| `client/src/panels/LeaderboardPanel.jsx` | **NEW** — leaderboard panel |
| `client/src/nexus/DetailDrawer.jsx` | Added LeaderboardPanel import + panel entry |
| `client/src/useKeyboardShortcuts.js` | Added Ctrl+L → leaderboard shortcut |
| `client/src/App.jsx` | Added leaderboard handler + nav button |
| `server/runtime.js` | Added leaderboard route + feature |

## System Counts After Phase 48

| Metric | Count |
|--------|-------|
| Features | 60 |
| Detail Drawer panels | 24 |
| Keyboard shortcuts | 16 |
| Nav bar buttons | 10 |
| Phases | 48 |
