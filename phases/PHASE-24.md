# Phase 24: Agent Self-Evolution Engine

**Date:** 2026-10-30
**Prev:** [Phase 23 — Event-Driven Orchestration + Agent Persistent Memory + System Health Monitor](PHASE-23.md)
**Next:** [Phase 25 — Generator-Verifier-Executor Loop](PHASE-25.md)

---

## Overview

Phase 24 closes the loop. Chandra-FRAYMUS has memory, health monitoring, workflows, bus triggers, and an intelligence stack — but nothing that acts on what it learns. Phase 24 adds three subsystems that make the platform self-evolving:

1. **24A: Agent Forge** — Agents create new agents on demand
2. **24B: Workflow Synthesis** — Agents compose new workflows from existing node types
3. **24C: Reflection Loop** — Scheduled self-analysis that identifies patterns and acts on them

Together, these turn every run, failure, and insight into fuel for evolution.

## Architecture

```
                         ┌─────────────────┐
                         │  Reflection Loop │ ← Reads memories, runs, health, outcomes
                         │     (24C)        │
                         └────────┬────────┘
                    ┌─────────────┼─────────────┐
                    ▼             ▼              ▼
           ┌──────────────┐ ┌──────────┐ ┌────────────┐
           │ Agent Forge  │ │ Workflow  │ │  Memory    │
           │   (24A)      │ │ Synthesis │ │ Verify /   │
           │              │ │   (24B)   │ │ Prune      │
           └──────┬───────┘ └─────┬────┘ └────────────┘
                  ▼               ▼
           ┌──────────────┐ ┌──────────┐
           │ Fleet: new   │ │ Workflow  │
           │ agent .md    │ │ saved to  │
           │ registered   │ │ DB, ready │
           └──────────────┘ └──────────┘
                  │               │
                  └───────┬───────┘
                          ▼
                   Bus: system.evolution
                   (broadcast to all subscribers)
```

---

## 24A: Agent Forge

### Concept
Any agent (or the system itself) can create a new specialized agent by describing a goal. The forge uses Ollama to generate a complete agent manifest (frontmatter + system prompt), saves it as a .md file in the data/agents override directory, and registers it in the fleet immediately. The new agent is runnable within seconds.

### Files
- **`server/fleet/forge.js`** (NEW) — Forge engine: LLM-driven manifest generation, validation, registration
- **`server/fleet/tools.js`** (MODIFIED) — 2 new agent tools: `agent_forge`, `agent_list_forged`

### How It Works
1. Caller provides a `goal` (what the agent should do) and optional `context` (domain knowledge, constraints)
2. Forge calls Ollama with a structured prompt that outputs JSON: `{id, name, role, description, model, tools, systemPrompt}`
3. Validates the output (id format, required fields, no duplicate id)
4. Writes the manifest via `writeOverride()` from manifest.js
5. Reloads fleet manifests so the agent is immediately available
6. Records the forge event in `forged_agents` table
7. Publishes `system.evolution` bus event

### DB Schema
```sql
CREATE TABLE forged_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  forged_by TEXT NOT NULL DEFAULT 'system',
  goal TEXT NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL
);
```

### API Endpoints (3)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/fleet/forge` | Forge a new agent from goal + context |
| GET | `/api/fleet/forge/history` | List all forged agents |
| DELETE | `/api/fleet/forge/:agentId` | Remove a forged agent |

### Agent Tools (2)
| Tool | Description |
|------|-------------|
| `agent_forge` | Create a new specialist agent from a goal description |
| `agent_list_forged` | List all agents that were forged (vs. manually created) |

---

## 24B: Workflow Synthesis

### Concept
Agents can compose new workflows programmatically. Given a goal, the synthesizer uses Ollama to select appropriate node types from the 36 available, wire them into a DAG, validate the topology, save the workflow, and optionally deploy it as an API endpoint.

### Files
- **`server/workflow/synthesizer.js`** (NEW) — LLM-driven workflow composition, validation, save
- **`server/fleet/tools.js`** (MODIFIED) — 1 new agent tool: `workflow_synthesize`

### Available Node Types (36)
The synthesizer knows all node types from the workflow engine:
- **LLM:** llm, chat, llama variants
- **Media:** image_gen, flux, bg_remove, upscale
- **Commerce:** researcher, copywriter, reviewer, ceo_logger, shopify_publish, trend_scout, apparel_designer, printify_push, shopify_sync, pricing_engine, mystery_shopper, ux_auditor, price_analyst, shopper_report, page_generator, collection_organizer, description_enhancer, price_adjuster, shopify_applier
- **Intelligence:** heart_feel, dream, consciousness_prove, cognition, memory_recall, intelligence_cycle
- **Utility:** code, sandbox, web_search, preview, fraymus_tool

### How It Works
1. Caller provides a `goal` and optional `constraints`
2. Synthesizer sends the goal + available node type catalog to Ollama
3. LLM returns JSON: `{name, nodes: [{id, type, data}], edges: [{source, target}]}`
4. Validates: all node types exist, DAG is acyclic (via topoSort), no orphans
5. Saves workflow to DB via the existing workflow create pattern
6. Optionally deploys as API (links to Deploy-as-API system)
7. Records synthesis in `synthesized_workflows` table
8. Publishes `system.evolution` bus event

### DB Schema
```sql
CREATE TABLE synthesized_workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  synthesized_by TEXT NOT NULL DEFAULT 'system',
  goal TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### API Endpoints (2)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workflows/synthesize` | Synthesize a new workflow from a goal |
| GET | `/api/workflows/synthesized` | List all synthesized workflows |

### Agent Tool (1)
| Tool | Description |
|------|-------------|
| `workflow_synthesize` | Compose a new workflow from a goal description |

---

## 24C: Reflection Loop

### Concept
A scheduled process that reads across all system data — agent memories, workflow run history, health metrics, commerce outcomes, bus activity — identifies patterns (what works, what fails, what's slow), and takes action: forging agents, synthesizing workflows, verifying/pruning memories, and publishing findings.

Inspired by Dream-RSI: "An agent must dream to recursively self-improve. History is the world it dreams in."

### Files
- **`server/intelligence/reflection.js`** (NEW) — Reflection engine: data collection, LLM analysis, action execution

### How It Works
1. Runs on a configurable interval (default: every 30 minutes, or manually triggered)
2. Collects system state:
   - Agent memory stats and recent high-confidence memories
   - Workflow run results (success/failure rates, duration trends)
   - Health metrics (error rates, resource usage)
   - Recent bus activity and trigger fire counts
   - Commerce pipeline outcomes
3. Sends the collected state to Ollama for analysis
4. LLM returns structured actions:
   - `verify_memory` — mark a memory as verified based on supporting evidence
   - `prune_memory` — remove low-confidence memories that haven't been accessed
   - `forge_agent` — create a new agent to handle a pattern (delegates to 24A)
   - `synthesize_workflow` — create a new workflow for a recurring need (delegates to 24B)
   - `publish_insight` — publish a finding to the bus for other agents
5. Executes each action
6. Records the reflection in `reflections` table
7. Publishes summary to bus `system.reflection` topic

### DB Schema
```sql
CREATE TABLE reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL DEFAULT 'scheduled',
  input_summary TEXT NOT NULL,
  actions_taken TEXT NOT NULL,
  insights TEXT,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

### API Endpoints (3)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/intelligence/reflect` | Trigger immediate reflection |
| GET | `/api/intelligence/reflections` | List past reflections |
| GET | `/api/intelligence/reflections/:id` | Get reflection detail |

### Auto-Behavior
- Runs every 30 minutes when autonomy is active
- Skips if no new data since last reflection (checks bus message count, workflow run count)
- Publishes `system.reflection` event with summary
- Each reflection is bounded: max 5 actions per cycle to prevent runaway

---

## Files Changed

### New (3)
- `server/fleet/forge.js` — Agent Forge engine
- `server/workflow/synthesizer.js` — Workflow Synthesis engine
- `server/intelligence/reflection.js` — Reflection Loop engine

### Modified (4)
- `server/db-migrate.js` — 3 new tables (forged_agents, synthesized_workflows, reflections)
- `server/runtime.js` — Import + initialize forge routes, synthesis routes, reflection routes + loop; add features
- `server/fleet/tools.js` — 3 new agent tools (agent_forge, agent_list_forged, workflow_synthesize) — 22 total
- `phases/PHASE-23.md` — Forward link to Phase 24

---

## Continuity References

- **Dream-RSI**: "An agent must dream to recursively self-improve. History is the world it dreams in." — The reflection loop IS the dream made actionable
- **FRAYNIX Brain Router**: Classify → route to exact subsystem — The reflection LLM classifies patterns and routes to forge/synthesis/memory actions
- **Niles Continuity Plasmid**: Self-healing memory chains — Reflection verifies and prunes memories, maintaining integrity
- **Ouroboros**: The snake eating its own tail — The system's output (runs, memories, metrics) becomes its input (reflection), completing the loop

---

## Known Limitations

1. Forge uses LLM to generate manifests — quality depends on model capability
2. Workflow synthesis limited to existing 36 node types — cannot create new node types
3. Reflection bounded to 5 actions per cycle — prevents runaway but limits throughput
4. No rollback mechanism — if a forged agent or synthesized workflow performs poorly, manual removal needed
5. Reflection LLM analysis is as good as the local model — larger models produce better insights
