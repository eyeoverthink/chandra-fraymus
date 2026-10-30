# Phase 26: Background Evolution Daemon

**Date:** 2026-10-30
**Prev:** [Phase 25 — Generator-Verifier-Executor Loop](PHASE-25.md)
**Next:** TBD

---

## Overview

Phase 26 adds a persistent background daemon that orchestrates autonomous system evolution. Three capabilities in one module:

1. **Dream Consolidation** — compresses recent system activity (bus messages, workflow runs, health alerts, verification loops) into summarized knowledge via Ollama, stored as agent memories
2. **Prompt Evolution** — reads verified "fossil" patterns from the verifier-loop (Phase 25) and injects them into forged agent system prompts, making agents evolve based on proven code
3. **Daemon Cycle** — runs consolidation → evolution → reflection as a single background loop on a configurable timer (default 30 min)

## Architecture

```
                    ┌─────────────────────────┐
                    │   Evolution Daemon       │
                    │   (background timer)     │
                    └─────────┬───────────────┘
                              │ every N minutes
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
     ┌────────────────┐ ┌──────────────┐ ┌──────────────┐
     │ Dream          │ │ Prompt       │ │ Reflection   │
     │ Consolidation  │ │ Evolution    │ │ (Phase 24C)  │
     │                │ │              │ │              │
     │ Recent activity│ │ Fossils from │ │ System-wide  │
     │ → Ollama →     │ │ Phase 25 →   │ │ analysis →   │
     │ compressed     │ │ inject into  │ │ forge/synth/ │
     │ learnings      │ │ agent prompts│ │ prune/verify │
     └───────┬────────┘ └──────┬───────┘ └──────┬───────┘
             ▼                 ▼                 ▼
        agent_memories    data/agents/*.md    reflections
        (dream category)  (evolved prompts)  (actions taken)
             │                 │                 │
             └─────────────────┼─────────────────┘
                               ▼
                    Bus: system.daemon
                    (cycle_complete event)
```

---

## What Was Built

### Dream Consolidation

Reads the last hour of system activity from 4 sources:
- `bus_messages` — agent-to-agent communication
- `workflow_runs` — workflow execution results
- `health_alerts` — system health warnings
- `verification_loops` — code verification outcomes

Sends the activity to Ollama with a structured prompt. Output: patterns, outcomes, learnings, and a compressed summary. Learnings are stored as `agent_memories` with category "dream" and confidence 0.7.

### Prompt Evolution

Reads verified fossils (confidence >= 1.0) from `agent_memories` where category is "fossil". Parses the JSON value to extract proven patterns (goal + language + iteration count). For each forged agent that has evolution-related tools, appends a `[Proven Patterns]` block to the system prompt via `writeOverride()`. Reloads manifests after changes.

Safety: only evolves forged agents (not default manifests), skips agents already evolved (checks for `[proven patterns]` marker), limits to 3 patterns per injection.

### Daemon Cycle

A full cycle runs three steps sequentially:
1. Dream consolidation
2. Prompt evolution
3. Reflection (from Phase 24C)

Each step is independently error-guarded — one failing doesn't block the others. Results are recorded to `daemon_cycles` table and published to bus topic `system.daemon`.

### Daemon Control

Start/stop/status/manual-cycle via API routes. Minimum interval enforced at 60 seconds. Timer uses `setInterval` with async error catching.

---

## Files Changed

### New (1)
- `server/daemon/engine.js` — Full daemon engine: consolidation, prompt evolution, cycle orchestrator, control functions, API routes

### Modified (3)
- `server/db-migrate.js` — Added `daemon_cycles` table with index
- `server/fleet/tools.js` — Added `daemon_control` fleet tool (25 total)
- `server/runtime.js` — Import + install daemon routes after verifier routes

---

## DB Schema

```sql
CREATE TABLE IF NOT EXISTS daemon_cycles (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,           -- 'consolidation', 'prompt_evolution', 'full_cycle', 'error:*'
  input_summary TEXT,
  output TEXT,
  duration_ms INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daemon ON daemon_cycles(created_at DESC);
```

---

## API Endpoints (7)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/daemon/start` | Start background daemon (body: `{cycleMs}`) |
| POST | `/api/daemon/stop` | Stop daemon |
| GET | `/api/daemon/status` | Current daemon state |
| POST | `/api/daemon/cycle` | Run one full cycle now |
| GET | `/api/daemon/cycles` | List past cycles (query: `?limit=N`) |
| POST | `/api/daemon/consolidate` | Run dream consolidation only |
| POST | `/api/daemon/evolve` | Run prompt evolution only |

---

## Agent Tool (1)

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `daemon_control` | evolution | approval | Control daemon: start, stop, status, cycle, cycles |

---

## Running Counts

| Category | Count |
|----------|-------|
| Features | 39 |
| Fleet Tools | 25 |
| Agents (default) | 17 |
| Workflow Node Types | 36 |
| DB Tables | ~59 |
| API Routes | 80+ |
| Phases | 26 |

---

## Integration Points

- **Phase 24C (Reflection)** — daemon calls `reflect()` directly as step 3 of each cycle
- **Phase 25 (Verifier Loop)** — daemon reads fossils stored by the verifier and injects proven patterns into agent prompts
- **Phase 24A (Agent Forge)** — daemon evolves forged agent prompts via `writeOverride()`
- **Agent Memory** — dream learnings stored as agent_memories with category "dream"
- **Bus** — publishes `system.daemon` events on cycle completion
- **Fleet Runtime** — calls `reloadManifests()` after prompt evolution

---

## Known Limitations

1. Dream consolidation requires Ollama to be responsive — on GPU memory pressure, consolidation step will error (gracefully)
2. Prompt evolution only targets forged agents with evolution tools — default agents are untouched
3. No rollback for prompt evolution — if patterns degrade an agent, manual manifest edit needed
4. Single-process daemon — if the server restarts, daemon must be re-started
5. No deduplication of dream learnings across cycles — repeated patterns may accumulate
