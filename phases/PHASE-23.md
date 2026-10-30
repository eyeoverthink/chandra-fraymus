# Phase 23: Event-Driven Orchestration + Agent Persistent Memory + System Health Monitor

**Date:** 2026-10-30
**Prev:** [Phase 22 — Agent Live Bus](PHASE-22.md)
**Next:** Phase 24 (TBD)

---

## Overview

Phase 23 delivers three interconnected subsystems that transform Chandra-FRAYMUS from a reactive system into a self-aware, self-monitoring, memory-accumulating platform:

1. **23A: Event-Driven Orchestration** — Bus events auto-trigger workflows
2. **23B: Agent Persistent Memory** — Agents accumulate knowledge across sessions
3. **23C: System Health Monitor** — Real-time metrics, alerts via bus

## Architecture

```
Bus Message → Topic Match → Trigger Engine → Workflow Pipeline
                                ↓
Agent Run → Auto-Store → Agent Memory Store → Prompt Context
                                ↓
Health Collector → Metrics DB → Alert Rules → Bus Publish (system.alert)
```

---

## 23A: Event-Driven Orchestration

### Concept
Wire the Agent Live Bus into the workflow engine. When a message arrives on a topic that has a trigger configured, the linked workflow runs automatically with the bus message as input.

### Files
- **`server/fleet/bus-triggers.js`** (NEW) — Trigger engine: create/delete/toggle triggers, wire `onTopic()` handlers, fire workflows
- **`server/db-migrate.js`** (MODIFIED) — `bus_triggers` table

### SQLite Schema
```sql
CREATE TABLE bus_triggers (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  label TEXT,
  enabled INTEGER DEFAULT 1,
  fire_count INTEGER DEFAULT 0,
  last_fired_at INTEGER,
  created_at INTEGER NOT NULL
);
```

### API Endpoints (4)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/fleet/bus/triggers` | List all triggers |
| POST | `/api/fleet/bus/triggers` | Create trigger (topic + workflowId) |
| DELETE | `/api/fleet/bus/triggers/:id` | Delete trigger |
| POST | `/api/fleet/bus/triggers/:id/toggle` | Enable/disable |

### How It Works
1. On startup, `initTriggers()` loads all enabled triggers and wires `onTopic()` handlers
2. When a bus message hits a trigger's topic, `fireTrigger()`:
   - Loads the linked workflow
   - Runs `runPipeline()` with bus payload as prompt
   - Records the run in `workflow_runs`
   - Updates fire count and last_fired_at
   - Broadcasts `trigger_fired` event via WebSocket

---

## 23B: Agent Persistent Memory

### Concept
Inspired by the Niles Continuity Plasmid's `verified/against` pattern and the FRAYMUS Memory Lattice. Each agent gets a persistent knowledge store that survives across sessions. Memories are categorized, keyed for dedup, carry confidence scores, and track verification status.

### Files
- **`server/fleet/agent-memory.js`** (NEW) — Memory CRUD, prompt context builder, auto-store hook
- **`server/fleet/runtime.js`** (MODIFIED) — Injects memory context into system prompt, auto-stores after completion
- **`server/fleet/tools.js`** (MODIFIED) — 3 new agent tools: `agent_remember`, `agent_recall`, `agent_memory_stats`

### SQLite Schema
```sql
CREATE TABLE agent_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  source TEXT DEFAULT 'agent',
  access_count INTEGER DEFAULT 0,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### API Endpoints (5)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/fleet/memory/stats` | Global or per-agent memory stats |
| GET | `/api/fleet/memory/:agentId` | List agent memories (with search/filter) |
| POST | `/api/fleet/memory/:agentId` | Manually store a memory |
| POST | `/api/fleet/memory/verify/:id` | Mark memory as verified |
| DELETE | `/api/fleet/memory/:id` | Forget a memory |

### Agent Tools (3)
| Tool | Description |
|------|-------------|
| `agent_remember` | Store fact/preference/learning with category, key, confidence |
| `agent_recall` | Search memories by query or category |
| `agent_memory_stats` | Get memory store statistics |

### Auto-Behavior
- **Prompt injection**: Before each LLM call, `buildPromptContext()` adds the agent's 10 most recent memories as context with `[verified]`/`[unverified]` tags
- **Auto-store on completion**: After each successful run, the task and result are automatically stored as `interaction` and `outcome` memories

---

## 23C: System Health Monitor

### Concept
Real-time health monitoring that polls Ollama, DB stats, bus activity, Needle queue, and process memory. Auto-publishes alerts to the bus when thresholds are breached (Ollama down, error spike, queue backlog).

### Files
- **`server/health/monitor.js`** (NEW) — Metric collector, alert engine, routes
- **`client/src/panels/HealthPanel.jsx`** (NEW) — Health dashboard with stat cards, resource bars, alert list

### SQLite Schema
```sql
CREATE TABLE health_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  collected_at INTEGER NOT NULL
);

CREATE TABLE health_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
```

### Metrics Collected (every 60s)
| Metric | Source |
|--------|--------|
| `ollama_up` | `GET /api/tags` with 5s timeout |
| `ollama_models` | Model count from Ollama |
| `db_agents`, `db_workflows`, `db_bus_messages` | SQLite counts |
| `db_bus_today` | Bus messages in last 24h |
| `needle_pending`, `needle_running` | GPU queue status |
| `agent_runs_1h`, `agent_errors_1h` | Agent activity |
| `commerce_runs_24h` | Commerce pipeline activity |
| `bus_subscriptions`, `bus_triggers` | Bus infrastructure |
| `heap_mb`, `rss_mb` | Process memory |

### Alert Rules
| Rule | Severity | Condition | Cooldown |
|------|----------|-----------|----------|
| `ollama_down` | critical | Ollama unreachable | 5 min |
| `needle_backlog` | warning | >20 pending jobs | 5 min |
| `error_spike` | warning | >10 agent errors/hour | 5 min |

### API Endpoints (6)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health/metrics` | Latest metric snapshot |
| GET | `/api/health/metrics/:metric` | Metric history (configurable hours) |
| GET | `/api/health/alerts` | Active/resolved alerts |
| POST | `/api/health/alerts/:id/resolve` | Resolve an alert |
| GET | `/api/health/stats` | Combined metrics + alert count |
| POST | `/api/health/collect` | Force immediate collection |

### UI Panel
- **HealthPanel** — 12th Detail Drawer panel (red/`#ef4444` theme)
  - 4 stat cards: Ollama status, Heap memory, Active alerts, Bus activity
  - Resource bars: Heap, agent runs, errors, needle queue, subscriptions, triggers
  - Infrastructure grid: Workflows, threads, commerce, needle
  - Alert list with resolve buttons
  - Auto-refreshes every 30s + on WebSocket health events

---

## Files Changed

### New (4)
- `server/fleet/bus-triggers.js` — Event-driven trigger engine
- `server/fleet/agent-memory.js` — Per-agent persistent memory
- `server/health/monitor.js` — Health monitor + alerts
- `client/src/panels/HealthPanel.jsx` — Health dashboard panel

### Modified (7)
- `server/db-migrate.js` — 4 new tables, 5 new indexes
- `server/runtime.js` — Import + initialize all 3 subsystems, 3 new features in health endpoint
- `server/fleet/tools.js` — Import agent-memory, 3 new agent tools
- `server/fleet/runtime.js` — Import agent-memory, inject memory context into prompts, auto-store on completion
- `client/src/nexus/DetailDrawer.jsx` — Import HealthPanel, add to PANELS (12th)
- `client/src/nexus/CommandCenter.jsx` — Health Monitor widget + health event style

---

## Continuity References

Concepts drawn from the FRAYMUS continuity ecosystem:
- **Niles Continuity Plasmid** (`memory.py`): Triple-redundancy, SHA-256 integrity chains, boot records forming recursive memory
- **Claudette MEMORY.md**: `verified:`/`against:` frontmatter — "an entry without those is a rumor"
- **Dream-RSI**: "An agent must dream to recursively self-improve. History is the world it dreams in"
- **Memory Lattice**: 16x16x16 holographic categorization — every fragment contains the whole
- **FRAYNIX Brain Router**: Classify → route to exact subsystem

---

## Known Limitations

1. Health metrics stored in SQLite (same DB as app) — no external time-series
2. Alert rules are hardcoded — no user-configurable threshold UI yet
3. Agent auto-store captures all runs — no relevance filtering (may accumulate noise)
4. Trigger firing is async fire-and-forget — no retry on workflow failure
5. Memory search is LIKE-based — not semantic (Vertiso handles that layer)
