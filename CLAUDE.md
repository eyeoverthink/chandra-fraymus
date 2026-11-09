# Chandra-FRAYMUS

Autonomous AI agent workspace with intelligence stack — Express server (port 8787) + Vite React frontend (port 5173).

## Quick Start

```bash
npm run dev          # concurrently runs server + client
npm run server       # Express only (needs .env)
npm run client       # Vite only
npm run build        # production client build
npm run start        # production server (serves built client)
```

## Architecture

- **Server:** Node.js ESM, Express 4, better-sqlite3 (WAL mode), WebSocket broadcast
- **Client:** Vite + React, 4-view Nexus interface (Command Center, Constellation, Canvas, Library) + Detail Drawer for 13 panels, useWebSocket hook for live updates
- **LLM:** Ollama at localhost:11434 (configurable via OLLAMA_BASE_URL)
- **DB:** SQLite at `data/chandra.db`, migrations in `server/db-migrate.js`
- **Auth:** Bearer tokens via `server/mcp/auth.js`, loopback-only binding

## Server Subsystems (server/)

### Core Runtime
- `index.js` — entry point, starts HTTP + WebSocket
- `app.js` — Express app, all REST routes, WebSocket heartbeat (30s ping/pong)
- `config.js` — env validation (HOST, PORT, OLLAMA_URL, VOICE_URL)
- `db.js` / `db-migrate.js` — SQLite setup, schema migrations
- `runtime.js` — request handling, error middleware (truncates messages, no stack leaks)
- `command-router.js` — `POST /api/command` endpoint: parses @agent, run pipeline/workflow, and freetext commands; dispatches to fleet/commerce/workflow subsystems
- `local-http.js` — CORS, security headers, loopback enforcement
- `lifecycle.js` — graceful shutdown (HTTP, WS, DB, intervals)
- `data-lock.js` — prevents multiple server instances via port lock
- `static.js` — serves production client build
- `v3.js` — Fraymus V3 bulletproof recursive security engine
- `brain.js` — central reasoning coordinator (full intelligence: Heart emotion + Ledger logging + Memory Bridge storage + dreamer/cognition context + bridge recall)
- `autonomy.js` — Kuramoto phase sync + intelligence monitoring (consciousness proofs, dreams)
- `fraymus-tools.js` — FRAYMUS → fleet adapter (42 tools + MemoryBridge export)
- `fraymus-routes.js` — FRAYMUS API routes (16 intelligence + 8 autonomy + 7 needle + 5 motor + memory search + intelligence cycle + runtime intelligence endpoints)

### Deploy-as-API (server/deploy-api/)
- `middleware.js` — Auth middleware (Bearer token validation via mcp/auth, scope checking)
- `rate-limiter.js` — Token bucket rate limiter (in-memory, 60 req/min default, 600 for admin, auto-refill)
- `usage.js` — SQLite usage tracker (per-invocation logging, per-slug/key analytics, global stats)
- `routes.js` — Deploy catalog, deploy/undeploy, auth-protected `/api/run/:slug`, usage endpoints (7 routes)

### Agent Live Bus (server/fleet/bus*.js)
- `bus.js` — Core pub/sub engine: publish to topics, direct messages, subscriptions, inbox, history, stats (SQLite-backed + in-memory handlers)
- `bus-routes.js` — 9 REST endpoints for bus operations (publish, DM, subscribe, topics, history, inbox, subscriptions, stats)
- Agent tools `bus_publish`, `bus_dm`, `bus_read` in `fleet/tools.js` — agents use these during execution to communicate

### Event-Driven Orchestration (server/fleet/bus-triggers.js)
- `bus-triggers.js` — Trigger engine: bus topic events auto-fire linked workflows via `runPipeline()`, CRUD for triggers, enable/disable toggle, fire counting
- DB table: `bus_triggers` (topic, workflow_id, label, enabled, fire_count, last_fired_at)
- 4 REST endpoints: GET/POST triggers, DELETE trigger, POST toggle

### Agent Persistent Memory (server/fleet/agent-memory.js)
- `agent-memory.js` — Per-agent knowledge store with categories, confidence scores, verified/unverified status (inspired by Niles Continuity Plasmid)
- `storeMemory` / `recallMemories` / `verifyMemory` / `forgetMemory` — CRUD with LIKE-based search
- `buildPromptContext()` — injects agent's 10 most recent memories into system prompt with [verified]/[unverified] tags
- `autoStoreFromCompletion()` — auto-stores task + result after every agent run
- DB table: `agent_memories` (agent_id, category, key, value, confidence, source, access_count, verified_at)
- 5 REST endpoints + 3 agent tools (`agent_remember`, `agent_recall`, `agent_memory_stats`)

### Agent Forge (server/fleet/forge.js)
- `forge.js` — LLM-driven agent manifest generation: goal → Ollama → validated JSON → writeOverride() → reloadManifests() → fleet reload → runnable immediately
- DB table: `forged_agents` (agent_id, forged_by, goal, context, created_at)
- 3 REST endpoints: POST forge, GET forge/history, DELETE forge/:agentId
- 2 agent tools: `agent_forge`, `agent_list_forged`
- **Phase N guard:** `checkForgeAllowed(goal)` — 7-day normalized-goal dedup + cap of 30 forged agents (`MAX_FORGED_AGENTS`). `forgeAgent()` returns `{ forged: false, reason: 'duplicate_goal' | 'forge_cap_reached' }` rather than forging; callers must check `result.forged`. `force: true` bypasses (API passes `body.force`). Archived machine-forged rows live in `forged_agents_archive`.

### Workflow Synthesis (server/workflow/synthesizer.js)
- `synthesizer.js` — LLM-driven workflow composition: goal → Ollama → select from 33 node types (NODE_CATALOG) → validate DAG (topoSort cycle check) → save to DB
- **IMPORTANT**: installSynthesisRoutes() must register BEFORE installWorkflowRoutes() in runtime.js — the `/api/workflows/:id` param route will swallow `/api/workflows/synthesized` otherwise
- DB table: `synthesized_workflows` (workflow_id, synthesized_by, goal, node_count, created_at)
- 2 REST endpoints: POST synthesize, GET synthesized
- 1 agent tool: `workflow_synthesize` — 27 fleet tools total

### Reflection Loop (server/intelligence/reflection.js)
- `reflection.js` — Scheduled self-analysis: collects agent memories + workflow runs + health metrics + bus activity → Ollama analysis → max 5 actions per cycle (verify_memory, prune_memory, forge_agent, synthesize_workflow, publish_insight)
- DB table: `reflections` (trigger, input_summary, actions_taken, insights, duration_ms, created_at)
- 3 REST endpoints: POST reflect, GET reflections, GET reflections/:id
- Runs every 30 minutes when autonomy active, skips if no new data

### Generator-Verifier-Executor Loop (server/intelligence/verifier-loop.js)
- `verifier-loop.js` — Adversarial code generation: Generator writes code → Verifier critiques → Executor runs in child_process → feedback loop until APPROVED or max iterations
- Supports JavaScript (Node) and Python execution with 15s timeout
- Proven code saved as "fossil" in agent_memories (confidence 1.0) + bus event on `system.evolution`
- DB tables: `verification_loops`, `verification_steps`
- 3 REST endpoints: POST run, GET loops, GET loops/:id
- 2 agent tools: `verify_loop`, `verify_list`

### OPEG V1.0 Protocol (server/intelligence/opeg.js)
- `opeg.js` — Empirical grounding state machine: S0_IDLE → S1_HYPOTHESIS → S2_EXECUTE → S3_SANITIZE → S4_UPDATE. Gates all autonomous self-modifications through hypothesis/execute/sanitize/update cycle with pre/post metric collection and regression detection.
- `runPipeline()` convenience wrapper chains all 4 stages with an executeFn callback
- `evaluateModification()` checks: execution success, no new alerts, type-specific checks, no regression
- Wired into reflection loop: forge_agent and synthesize_workflow actions pass through OPEG
- DB table: `opeg_proposals` (id, type, state, hypothesis, params, pre_metrics, post_metrics, execution_result, sanitize_verdict, source, created_at, updated_at, completed_at)
- 4 REST endpoints: GET stats, GET proposals, GET proposals/:id, POST propose
- Exports: `propose`, `execute`, `sanitize`, `update`, `runPipeline`, `getProposal`, `listProposals`, `stats`

### Goal Executor (server/intelligence/goal-executor.js) — Phase P
- `goal-executor.js` — Drains `goal_proposals` through the fleet: `pickNextGoal()` (priority → simplicity → recency) → `selectAgent()` (keyword overlap with agent name/role/description, default manifests win ties, fallback `GOAL_EXECUTOR_AGENT` env / `fraymus_prime`) → `runAgentAndWait` (240 s) → `goal_proposals.status` `completed | failed | blocked`, `goal_executions` row, `outcome` memories for `system` and the agent, `system.goals` bus events
- One in flight at a time; honours `isResourceConstrained()` and `isActionSuppressed('goal_seek')`; `expireStaleProposals()` marks `proposed` older than 48 h `expired`
- Runs on its own 5 min interval (`startGoalExecutor` from daemon start), as daemon Step 5.5, and as the motor **Goal-seek** target (execute first, generate only when the queue is empty); status in `getDaemonStatus().goalExecutor`
- DB table: `goal_executions`; `updateProposalStatus()` in goal-engine accepts `failed | blocked | expired`
- 6 REST endpoints under **`/api/goal-executor`** — own prefix on purpose: `/api/goals/:id` in goal-engine is a param route and would swallow `/api/goals/executor`
- Reflection actions added: `run_verifier` (verifier loop) and `execute_goal`; debates now fail closed (`status='failed'`, `verdict='abandoned'`) and `sweepStaleDebates()` runs at daemon start
- Metacognitive gotcha fixed: `runs` has no `agent_id` column — the agent is the prefix of `model` (`agentId:model`); query with `model LIKE 'id:%'`

### Outcome Scorer (server/intelligence/outcome-scorer.js) — Phase R
- `scoreOutcome({execId, objective, threadId, reply, runStatus})` — quality 0–1 = 50% Ollama judge (JSON mode via `chatOllama(..., {format:'json'})`: specificity/actionability/evidence/meta_talk/overall + critique) + 50% deterministic (tool calls, memory writes, length, concreteness, meta-talk ratio); non-done runs cap at 0.2. Persists `goal_executions.quality/quality_detail`
- `agentQualityStats(agentId)` / `fleetQualityStats()` — consumed by `evolvePrompts()` for `[Outcome Feedback]` blocks
- `computeRealityFitness()` — 24 h composite (goal completion .25, goal quality .35, run success .20, verifier pass .10, debate decisiveness .10); wired into `OuroborosEngine.setRealityFitness()` in fraymus-tools.js: `fitness()` = 0.4 genome + 0.6 reality, mutations refused while reality declines > 0.05
- Goal generation is gated on queue depth (`GOAL_MAX_PENDING`, default 12); `POST /api/goal-executor/run {force:true}` bypasses autonomy throttles; LLM-timeout runs with 0 steps requeue (max 2 retries)
- Knowledge graph: semantic threshold 0.35, `pruneToDegreeCap(8)` on `semantically_related` only
- 2 REST endpoints: `GET /api/goal-executor/quality`, `GET /api/goal-executor/quality/:agentId`

### External Senses (server/intelligence/external-senses.js + sensory-channels.js) — Phase Q
- `sensory-channels.js` — the ONLY place sensory channels are declared (`SENSORY_REGIONS`, `SENSORY_KEYS`, `INTERNAL_KEYS`, `EXTERNAL_KEYS`); sensory bridge, attention gate, habituation, working memory and predictive processing import it. Add a channel here, then map it in `attention-gate.js` MOTOR_SENSORY_MAP and `active-inference.js` INFERENCE_MAP
- `external-senses.js` — outward channels on grid row 11: `web` (agent_web_sources + trend_signals), `youtube` (outlier_board), `commerce` (Shopify orders/count 24 h, falls back to local runs with `source:'local'`), `mesh` (V13 hub directory presence + NUDP peers), `git` (commits/hour + dirty files), `user` (user sensorium, `inject:false` — already injected at column 15). Network/shell sources polled every 60 s into a cache (`pollExternalSenses`), DB sources read live; `getExternalSignals()` is the synchronous read the bridge uses
- Started/stopped with the daemon; status in `getDaemonStatus().externalSenses`; table `external_sense_events`
- 3 REST endpoints: `GET /api/intelligence/external-senses`, `GET …/history`, `POST …/poll`

### Self-Audit Organ (server/intelligence/self-audit.js) — Phase S
- `runSelfAudit({trigger, writeReport})` — five recurring-defect checks on the live DB: `repeated_action` (≥5× in 24h, ≥50× BLOCKING), `flat_metric`/`dead_channel` (std-dev < 1e-6 over ≥20 samples across Φ/EI/CTRNN/metacog/pressure/connectivity + every sensory channel), `producer_without_consumer` (consumed/produced < 10%), `written_never_read` (access_count = 0 > 95%), `stuck_transient` (rows in running/executing/S1–S3 > 1 h)
- Findings upsert by (check, subject) into `self_audit_findings`; cleared conditions set `resolved_at`. Exactly ONE aggregated `health_alerts` row (`rule='self_audit'`) for BLOCKING — never one per finding (would pin the neurogenesis health penalty). `getOpenFindingCounts()` feeds a stuck signal in `metacognitive-monitor.js`
- Report in fraymus-audit format → `data/audits/self-audit-YYYY-MM-DD.md` + `latest.md` (weekly or `POST …/report`). Runs in `self_audit_runs`; bus `system.self_audit`
- Own 15-min timer started by the daemon (first run 60 s after boot); status in `getDaemonStatus().selfAudit`
- 5 REST endpoints under `/api/intelligence/self-audit`; fleet tool `self_audit_status`
- **When adding an autonomous action, ask what the self-audit would say about it:** does it dedup, does it have a consumer, does it leave rows in a transient state on crash. Debates now dedup on topic for 24 h (`config.allowRepeat` to override); goals dedup on objective for 7 days across all statuses

### Hive (server/intelligence/hive-mesh.js + hive-peers.js) — Phase U
- `hive-mesh.js` — NUDP node started at daemon start (`createNode` with `sourceIdFromPubkey(systemIdentity.pubkey)`), peers seeded from `MESH_PEERS` (default now `10.0.0.163:47100`, the Pi — it speaks fmp1, not NUDP; see `fmp1-node.js` below for the real link), V13 hub `liveRegister` every 10 min + directory read. `mesh-node.js`: `addPeer()`, peers persisted to `nudp_peers`, restored on start, immediate HELLO. Hub auth: `hub.js resolveHubToken()` reads **`FRAYMUS_HUB_TOKEN_FILE`** (a file holding only the write-tier token — set in `.env` to `C:/Users/eyeka/fraymus-hub-token.txt`) before `FRAYMUS_HUB_TOKEN` / `FRAYMUS_TOKEN`. **Gotcha:** `node --env-file` never overrides a variable already in the process environment, and this PC has a stale 48-char `FRAYMUS_HUB_TOKEN` in the *User* scope that silently shadowed `.env` — the file pointer sidesteps it. Registered 2026-11-08 as `fx-4e2d-c0b2-5667-d8b5`; the authenticated directory lists ~75 agents (unauthenticated it returns none, which is why the mesh sense read 0 before)
- `hive-peers.js` — fraymus-bridge adapter (repo at `BRIDGE_REPO_PATH`, env `FRAYMUS_BRIDGE_PATH`). Inbound every 5 min: `git pull --ff-only` → new messages → bus `hive.bridge.<agent>` + `agent_memories` category `hive_message` for the registry agent. First run backfills `HIVE_BRIDGE_BACKFILL` (10). Outbound: hourly digest via `postMessage('chandra', …)`, committed as Chandra-FRAYMUS, **pushed only with `HIVE_BRIDGE_PUSH=1`** (Vaughn enabled it 2026-11-08 — the flag is in `.env`; each sync also pushes any pending local digest commits). Tables `hive_bridge_state`, `hive_bridge_messages`. `'chandra'` added to bridge KNOWN_AGENTS
- `hive-export.js` fixed (`objective/rationale`, not `title/description`) + receipt types `goal_outcome`, `self_audit`
- **hive-export watermark + dedup (2026-11-09).** The ledger `data/chandra-to-hive.jsonl` had reached 117,812 receipts for 4,324 unique events (96% duplicates, 85 MB — over the chain verifier's 10 MB limit, so `GET /api/intelligence/hive-export` 400'd). Two causes: (1) every export re-read a fixed 2 h window on a 30 min cycle; (2) `consciousness_audits.created_at` is **TEXT** (`datetime('now')`) while every other table stores epoch ms — in SQLite every INTEGER sorts below every TEXT, so `created_at > 1794208331889` was true for the whole table and the window never applied to that collector at all (and `new Date('YYYY-MM-DD HH:MM:SS')` parsed it as local time, putting receipts 8 h in the future). Fixes: `resolveSince()` = start of the previous export (`hive_exports.created_at`; capped at 7 days, 2 h at genesis; explicit `since` still honoured); `sinceClause(col)` compares in the column's own type and `toIso()` reads both shapes as UTC — **use these for any new collector**; `recentLedgerKeys()` scans the last 5,000 ledger lines and skips any `(type, source id)` already present (`receiptKey()`); zero-event runs still insert a `hive_exports` row so the watermark advances; new columns `since_ts`, `skipped_duplicates`. `compactExportLedger({dryRun})` re-seals one-receipt-per-event from genesis and archives the old file beside it (`*.pre-compact-<ts>.jsonl`) — **operator-only**, never from the daemon: `POST /api/intelligence/hive-export/compact` is a dry run unless `{"dryRun": false}`. Stats expose `watermark`, `nextSince`, `duplication`; chain verification failure is reported inline, not as a 400. Self-audit `repeated_action` now has a `hive_exports:duplicate_receipts` subject (≥20% REAL, ≥50% BLOCKING over the receipts exported in 24 h) — it fired BLOCKING at 94% on first run, which is the test that this class of defect is now caught. **Gotcha for the whole codebase:** check `typeof(col)` before writing a time-window query against a table you did not create. **Compacted 2026-11-09 on Vaughn's OK:** 117,900 → 4,412 receipts, 85.6 MB → 4.0 MB, chain re-sealed from genesis and verified intact; the pre-compaction chain is kept at `data/chandra-to-hive.pre-compact-2026-11-09T08-17-45-634Z.jsonl` (gitignored, like the ledger). Receipt indices `i` restarted from 0 — anything downstream that remembered an old `i`/`self` must re-sync from the new genesis
- 7 REST endpoints under `/api/intelligence/hive-mesh` and `/api/intelligence/hive-peers`; fleet tool `hive_status`
- `fmp1-node.js` (2026-11-08) — **the Pi's actual protocol.** The Raspberry Pi (now at `10.0.0.163`, not `.162`; `MESH_PEERS` default updated) runs Vaughn's `fmp1` Python prototype (UDP 47100, Ed25519 key cards, operator-root-signed roster) and never answers NUDP. Chandra now runs a real FMP/1 node as a supervised child process: `python -m fmp1 --data-dir ~/.fmp1 --control-port 47101 node --lan --port 47100 --peer 10.0.0.163:47100 --roster ~/.fmp1/roster.cbor --root-pub <root.pub>`. Identity `C:\Users\eyeka\.fmp1\identity.key` (never read it) = node `a55799181f41d3f8`; roster signed on Vaughn's Mac lists `fraymus-pi` (`0cd41863a0d974b4`, gateway+relay) + `chandra` (relay). Package installed from `F:\Claude-Work\fmp1\fmp1-prototype` (`pip install --user --no-deps`). Supervisor: restart with exponential backoff (max 5 exits / 10 min), 40-line stdout ring, child killed on process exit. Control client = Node TCP to `127.0.0.1:47101`, one JSON line with `token` from `<data-dir>/control.token` (same wire format as `fmp1/cli.py _control()`); polls `status` + `inbox` every 60 s; new inbox rows → table `fmp1_messages` + bus `hive.fmp1.message` + `agent_memories` (agent `fmp1:<src>`, category `hive_message`). Env: `FMP1_ENABLED` (auto-on when identity.key exists), `FMP1_PYTHON`, `FMP1_DATA_DIR`, `FMP1_PORT`, `FMP1_CONTROL_PORT`, `FMP1_PEERS`, `FMP1_ROSTER`, `FMP1_ROOT_PUB`. Started/stopped inside `startHiveMesh()/stopHiveMesh()`; `fmp1` block in hive-mesh status, `fmp1Running/fmp1NodeId/fmp1Neighbors` in `getDaemonStatus().hiveMesh`; the `mesh` sense adds bidirectional FMP/1 neighbours. 5 routes: `GET /api/intelligence/hive-mesh/fmp1`, `POST …/fmp1/start|stop`, `POST …/fmp1/send {dst, text, encrypt?, wait?}`, `GET …/fmp1/inbox`. **Live 2026-11-08:** node `a55799181f41d3f8` up, roster v1794209923 loaded, state `DISCOVERING`, 0 neighbours — the Pi rejects Chandra until the roster is pushed to it (operator step on the Mac: `ssh-add --apple-use-keychain ~/.ssh/id_ed25519 && bash ~/fmp1-push-chandra-roster.sh`)

### Ollama Scheduler & anti-thrash (server/intelligence/ollama-scheduler.js) — Phase V
- **Why (measured 2026-11-09):** 956 reflections/24 h (884 from the motor Reflect region, one every ~90 s), each ~303 s because debates (161/6 h), verifier loops (51) and forges ran inline → 3–4 reflections overlapped → 100 % of agent-run errors were Ollama timeouts → metacog effectiveness 0.14 → `conserve` suppressed `goal_seek` (which only the executor honoured) → 3 % of goals executed → effectiveness stayed low. Verifier 0/136 passes (model wrote `import pandas from 'pandas-js'`; reflection sent goals like "Debate on …"). 326/371 debates failed, one topic ×82 (dedup only honoured completed verdicts). Motor suppression never matched `goalSeek`/`selfAudit` (strategy keys are `goal_seek`/`consciousness_audit`).
- `ollama-scheduler.js` — `withOllama(priority, fn, {label})`: priority queue in front of the single GPU. Classes 0 interactive · 1 agent_run · 2 scoring · 3 goal (default for untagged) · 4 forge/debate/swarm/synthesize · 5 verifier · 6 reflection · 7 dream/background. `OLLAMA_MAX_CONCURRENT` (2) slots; waiting jobs sorted by class then arrival; classes ≥ 4 are **dropped** past their max wait (2 min; reflection 90 s; dream 60 s) or when the queue holds `OLLAMA_MAX_QUEUE` (24) — error code `scheduler_dropped`, bus `system.ollama.dropped`. Slot is held for the whole callback (fleet streaming reads inside it). Wired: `commerce/shared.js chatOllama(messages, {priority, label})` (timeout starts after admission), `fleet/runtime.js chat()` = agent_run, `agent/provider.js` = agent_run, reflection/debate/verifier/goal-engine/outcome-scorer tagged. `GET /api/intelligence/ollama-scheduler`; `getDaemonStatus().ollamaScheduler`. **Tag any new autonomous Ollama caller with a priority** — untagged = medium, which is wrong for both chat and dreams.
- `resource-envelope.js` — new sensor `ollamaQueue` (scheduler pressure = (running+queued)/(3×slots), weight 0.15; weights rebalanced heap .20 db .10 runs .20 latency .20 bus .15); critical 0.8 → `isResourceConstrained()`.
- `reflection.js` gate (autonomous triggers only; `manual`/`api` bypass): single-flight; `REFLECTION_MIN_INTERVAL_MS` (10 min → ≤ 6/h); `hasNewData()` now means outcome-bearing rows since the last reflection **started** (runs, goal_executions, workflow_runs, hive/fmp1 messages, verifier completions, debates, non-system memories) — **bus_messages no longer count**, the organism emits ~13/min about itself. Heavy-action budget 1 each per reflection (`run_debate`, `run_verifier`, `forge_agent`, `synthesize_workflow`). `getReflectionGateStats()` in daemon status (`ran/inProgress/minInterval/noNewData/heavySkipped/strategySkipped`).
- `motor-output.js` — `STRATEGY_KEY` map (region → strategy action) so suppression/preference actually apply; per-region floors `MIN_INTERVAL_MS` (reflect 10 min, selfAudit 10 min, goalSeek 3 min, dream 5, neurogenesis 2, communicate 1; env `MOTOR_REFLECT_MIN_MS`, `MOTOR_SELFAUDIT_MIN_MS`, `MOTOR_GOALSEEK_MIN_MS`) = max(gate-scaled cooldown, floor).
- `adaptive-strategy.js` — **action keys split:** `goal_generate` (goal engine) vs `goal_execute` (executor); plus `debate`, `verify`, `forge`, `synthesize`, `neurogenesis`, `dream`, `consciousness_audit`, `reflect`, `communicate`; `goal_seek` is only the motor region. **Conserve inverted:** suppresses `forge, synthesize, neurogenesis, goal_generate, debate, verify, dream`, prefers `goal_execute`, reflectionCap 2 — "stop talking, finish what you started". Diversify/calibrate prefer `goal_execute`, suppress `goal_generate`. Consumers: `goal-executor.js` checks `goal_execute`; `goal-engine.js generateGoals` checks `goal_generate`; `debate.js` (source `reflection`) checks `debate`; `verifier-loop.js` (triggeredBy `reflection`) checks `verify`; reflection's ACTION_SUPPRESSION_MAP covers run_debate/run_verifier
- `debate.js` — failed-topic backoff: 30 min × 2^(failures−1), cap 24 h (`deferred: true, reason: 'failed_recently'`); `config.allowRepeat` bypasses
- `verifier-loop.js` — `goalUnsuitable(goal)` rejects non-programming goals from reflection (`status: 'rejected'`); `nonBuiltinImports(code, lang)` (node `builtinModules` / a Python third-party list) forces REJECTED + skips execution with exact feedback — a fossil can never depend on a package the sandbox lacks; generator prompt demands standard library + self-demonstrating program
- `neurogenesis.js` — `measureConnectivity()` counts failed terms; ≥ 3 → `{score: null, degraded: true}` and `neurogenesisCycle()` returns `reason: 'metrics_unavailable'` instead of declaring an emergency at 0.000 (478 such events on 2026-11-08 were query failures, not a dead organism)
- Success criteria for V (check after 24 h): run error rate < 30 %, reflections < 150/24 h, ≥ 50 % of proposals executed, effectiveness > 0.4, no BLOCKING self-audit findings

### Agent Quality & Credit Assignment (server/intelligence/agent-quality.js) — Phase W
- **Why:** Phase R made outcomes measurable (`goal_executions.quality`); nothing consumed them for decisions — agent selection was keyword overlap only, the queue was FIFO, and poor agents kept being picked. W closes outcome → selection with **no new LLM calls**.
- `agentQualityWeight(agentId)` — `0.5 + 7-day mean quality` once ≥ 3 scored outcomes (neutral 1.0 before, so new agents get tried). `selectAgent()` in goal-executor now scores `keywordFit × weight (+0.25 for hand-written manifests)`, **excludes retired agents**, returns `{weight, fit, reason: 'keyword_match_x_quality', retiredExcluded}`; `goal_started` bus events carry `qualityWeight`, `agentMeanQuality`, `expectedQuality`
- **Retirement (reversible):** `sweepAgentQuality({agents})` retires forged/custom agents with ≥ `AGENT_RETIRE_MIN_SAMPLES` (5) outcomes and 7-day mean < `AGENT_RETIRE_THRESHOLD` (0.2) → table `agent_retirements` (agent_id PK, quality, samples, reason, retired_at, restored_at, restored_by), bus `system.fleet.retired`, outcome memories for agent + system. **Hand-written (`source: 'default'`) manifests are exempt** — Vaughn's agents are never auto-retired. Manifests are never deleted. Daemon **Step 5.6** runs the sweep each cycle (`runAgentQualitySweep()`); `POST /api/goal-executor/retirements/:id/restore` brings one back; `POST …/retirements/:id` retires by hand
- **Goal utility:** `goalUtility(goal)` = Jaccard-weighted mean quality of past scored executions with ≥ 2 shared key tokens and J ≥ 0.2 (30-day history, 60 s cache; the goal's own prior attempts count double). `pickNextGoal()` orders priority → expected utility → simplicity → recency over the top 40 candidates, and **shelves** (`status = 'shelved'`, bus `goal_shelved`) any proposal whose similar history has ≥ 3 samples averaging < `AGENT_SHELVE_THRESHOLD` (0.15). `updateProposalStatus` accepts `shelved`
- **Measurement:** `qualityTrend({days})` — daily fleet mean quality + least-squares slope (`improving`), retired and shelved counts. Self-audit check `credit_assignment` → finding `retired_agent_selected` (REAL) if a retired agent executes a goal
- 6 REST endpoints: `GET /api/goal-executor/quality/trend`, `GET …/retirements`, `POST …/retirements/sweep`, `POST …/retirements/:agentId`, `POST …/retirements/:agentId/restore`, `GET …/utility?goalId=`; `retiredAgents` in `GET /api/goal-executor`
- Judge: `F:\Claude-Work\chandra-superintelligence\judge-phase-w.mjs` (needs ≥ 72 h; criteria: trend slope > 0, ≥ 80 % of goal starts weighted, retirement bites, backlog triaged, window mean ≥ prior week)
- **Gotcha:** `selectAgent` requires `fit ≥ 1` before weighting — an agent with great quality but zero keyword overlap still loses to the default fallback. That is deliberate: quality modulates fit, it does not replace it
- **Gotcha (route order):** `installAgentQualityRoutes()` must run **before** `installOutcomeScorerRoutes()` in `installGoalExecutorRoutes` — `/api/goal-executor/quality/:agentId` is a param route and swallowed `/quality/trend` on first deploy. Also: the object passed to `install*Routes` is not guaranteed to be a bare Express app — never touch `app.locals`; pass dependencies as arguments

### Outcome Feedback — human-in-the-loop credit (server/intelligence/outcome-feedback.js)
- **Why (2026-11-09, absorbed from looseScrew's "tighten/loosen screw"):** R and W made quality consequential, but every signal was machine-made. This lets Vaughn's judgement enter the same path. **One 👍/👎 changes `goal_executions.quality`**, which already drives agent weights, retirement, goal utility, reality fitness, trend, digests and the hive ledger — no reader had to change.
- Blend: `quality = HUMAN_FEEDBACK_WEIGHT (0.65) × human + 0.35 × machine`, human = 0.9 (👍) | 0.1 (👎). On first vote the machine score is frozen into `quality_machine`; later votes re-blend from it, never from each other. `quality_human` records the latest vote. Table `outcome_feedback` (id, exec_id, goal_id, agent_id, rating ±1, note, source, quality_before, quality_after, created_at). High-confidence (0.95) `outcome` memory for the agent and `system` (`feedback:<execId>`) so the agent's next prompt sees what the human thought; bus `system.goals` action `human_feedback`.
- **Undo** (`deleteFeedback`): removes the vote, re-blends from the latest remaining vote or restores `quality_machine` (and nulls it), deletes the two memories, bus `human_feedback_undone`. Exists so a misclick — or a test — never permanently injects an opinion. Verified: a test 👎 moved an agent's 7-day mean 0.486 → 0.433 and the execution 0.59 → 0.271; undo restored both exactly with 0 rows and 0 memories left.
- `pendingForReview()` = finished executions (7 d) without a vote; `feedbackStats()` = counts, **judge agreement** (machine ≥ 0.5 ⇔ 👍 — low agreement means the votes carry information the judge lacks), per-agent tallies, backlog.
- 5 routes under `/api/goal-executor/feedback` (GET list+stats, GET `/pending`, GET `/stats`, POST `{execId, rating, note?}`, DELETE `/:id`); installed before the scorer's `/quality/:agentId` param route. **Nexus:** `client/src/panels/FeedbackPanel.jsx` → drawer key `feedback` ("Outcome Feedback"), Command Center widget **"Rate Outcomes"** (👍). Judge: `F:\Claude-Work\chandra-superintelligence\judge-feedback.mjs` (informational — reports usage, agreement, agents moved by votes)
- Not absorbed from looseScrew (decorative or already stronger here): WebAudio synth / canvas shader, in-memory Akashic Record, thermal core, GitHub push script. Still on the list from it: REA 8-stage evidence protocol for the RE agents (0 dossiers today); TTS narration of bus events into the OBS overlay

### Narrator — the organism speaks on the overlay (server/intelligence/narrator.js)
- **Why (2026-11-09, third idea from looseScrew's Avatar Host):** TTS cascade, OBS overlay (`/ws/obs`) and the bus all existed and none were connected. The narrator subscribes (`onTopic`) to 10 topics that mean something happened — `system.goals` (completed ≥ 0.5 quality, human_feedback, goal_shelved), `system.consciousness.transition`, `system.re.rea.completed|reverified`, `system.fleet.retired|restored`, `hive.bridge.chandra`, `system.world.observed` (≥ 8 new), `system.self_audit` (blocking > 0), `system.ollama.dropped` — and turns each into one sentence from a **deterministic template** (no LLM; narration is a report). Line → `ttsSpeak()` (edge-tts, voice `NARRATOR_VOICE` default en-US-GuyNeural, SAPI fallback) → overlay `type:'narration'` card with audio → row in `narrations` → bus `system.narration`.
- **Economy:** audio is synthesised only while an overlay client is connected (`NARRATOR_ALWAYS=1` overrides); otherwise the line is stored text-only. `NARRATOR_MIN_GAP_MS` (45 s) between lines, queue of 5, identical text within 10 min is dropped. **Gap is reserved at speak START** (`speaking` flag + `lastSpokenAt` set before TTS): the first live test had a bus line start 5 s after a forced line because the gap was only set at speak end. Verified after the fix: forced → queued 52 s → bus 53 s; duplicate refused.
- `overlay.js` gained `broadcastNarration()`; `overlay.html` renders `#narrations` cards (top-right, cyan, speaking-dot) and plays `audioUrl` via `new Audio` — in OBS enable "Control audio via OBS" or unmute the browser source. Served at `/streaming/overlay`.
- Routes: `GET /api/intelligence/narrator` (status + recent), `GET …/narrator/history`, `POST …/narrator/say {text, force?}` (operator line; `force` bypasses the queue, not the TTS), `POST …/narrator/start|stop`. Fleet tool **`narrate`** (≤ 300 chars, same queue/gap; mode `status`) — agents can speak to the stream. Daemon start/stop; `getDaemonStatus().narrator`. Judge: `F:\Claude-Work\chandra-superintelligence\judge-narration.mjs` (lines, audio-only-with-listener, bus grounding, gap, TTS reliability; min window 14 min so a single bad gap stays visible for a while).
- `NARRATOR_ENABLED=0` disables. Add a topic by adding a template to `LINES`; keep templates factual and under ~160 chars — edge-tts time scales with length and the gap is fixed

### REA Protocol — Reverse Engineer Anything, evidence-first (server/intelligence/rea-protocol.js)
- **Why (2026-11-09, from Vaughn's looseScrew spec):** the 8-stage shape was right; the demo's "evidence" was hard-coded strings. Chandra's RE agents (`re-analyst`, Tycho) had 6 `re.*` tools, a `dossier_ingestions` table and **0 dossiers**; RE runs were one-shot prompts with invented confidence. This makes the protocol real: facts are collected by code before any reasoning, claims must cite them, and only execution can prove.
- **Stages:** 1 Target Scoping · 2 Setup & Readiness · 3 Surface Mapping · 4 Feature Tracing · 5 Evidence Collection · 6 Reconstruction · 7 Verification · 8 Final Report. Stages 1–6 are one `chatOllama` call each (`format:'json'`, temperature 0.2, priority `agent_run`) over the numbered FACTS plus prior claims; 7 executes checks; 8 is compiled, not generated.
- **Facts (deterministic collectors, F1…Fn, cap 160):** `path` targets (must sit under `REA_ROOTS`, default project root + F:/Claude-Work + F:/Fraymus-Skill-Lab): file walk (depth 4, ≤ 400 files, skips node_modules/.git/dist/data), per-file sha256/bytes/lines (≤ 60), `export` names, import edges (internal + external dep counts), package.json, grep hits for `feature` (≤ 80). `url` targets via `requestPublicPage` (public hosts only): status/content-type/sha256, title, meta, script hosts, link hosts, forms/iframes/images, feature hits. `text` targets: size/sha, headings, urls, code fences, hits.
- **Labels:** the model may only write LIKELY (cites ≥ 1 valid fact id) or UNVERIFIED (no citation); any PROVEN it emits is downgraded. Stage 7 asks for ≤ 3 standalone Node checks (built-ins only; `nonBuiltinImports()` + a network/write regex reject anything else), run through `verifier-loop.executeCode` with `const TARGET = <abs path>` prepended (url/text targets are written to a temp file first); a check whose last stdout line starts with `PASS` promotes its claim to **PROVEN**. Run label = PROVEN if any claim proved, else LIKELY if fact-backed claims ≥ inferences, else UNVERIFIED.
- Tables `rea_runs` (status, current_stage, counts, confidence_label, report_path) and `rea_evidence` (kind `fact` | `claim` | `check`, fact_ids, label, detail). Report markdown at `data/rea/<runId>.md` (facts listed verbatim at the end). Memories: `re-analyst` category **`binary_dossier`** key `rea:<id>` (confidence 1.0/0.6/0.3 by label) — the store is no longer empty — and `system` `outcome`. Bus `system.re.rea.completed`.
- Routes: `GET /api/intelligence/rea` (stages, roots, running, totals), `GET …/rea/runs`, `GET …/rea/runs/:id` (evidence + report), `POST …/rea/run {target, targetType?, feature?, question?, wait?}` — async by default (returns runId; a run is minutes), `wait:true` blocks. Fleet tool **`rea_run`** (modes `start` | `status` | `list`) added to both RE agents' manifests with instructions to quote the run's labels verbatim. Judge: `F:\Claude-Work\chandra-superintelligence\judge-rea.mjs` (label integrity, fact discipline, checks executed, honesty, dossier store non-empty).
- **Gotcha:** `verifier-loop.executeCode` is now exported for this; it runs in a tmp dir with the server's env — checks read `TARGET` by absolute path, which is why the path root check matters.
- **Lessons from the first two live runs (ollama-scheduler.js / withOllama):** (1) a single-file target yielded 7 facts and the model restated the same two claims for six stages, one of them false — fixed with `symbol` (name@line), `const`, `doc` and ±3-line `snippet` facts for small trees, a "do not repeat" rule and Jaccard ≥ 0.75 claim dedup (run 2: 12 facts, 17 claims, specific and correct, one honest UNVERIFIED); (2) every check then failed on `readFileSync is not defined` — the model drops imports, so a **standard prelude** (`fs`/`path`/`crypto` + destructured helpers + `TARGET`) is injected and the model's own imports of those modules stripped; checks that do not read `TARGET` or print PASS are rejected as stubs. `POST /api/intelligence/rea/runs/:id/verify` re-runs stage 7 on a completed run (facts/claims reloaded from `rea_evidence`; url/text targets need their temp file). After the prelude, run 2's three checks all passed → **3 PROVEN claims, run label PROVEN, judge 5/5**. First-run durations: ~350–400 s for 7 model calls at `agent_run` priority

### World Pollers (server/intelligence/world-pollers.js) — Phase X
- **Why:** the Phase Q `web`/`youtube` senses read `agent_web_sources` (the agent runtime's run-scoped, integrity-hashed store — **never write to it from elsewhere**) and `outlier_board` (needs `YOUTUBE_API_KEY`). Nothing autonomous ever fetched; both read 0 for days.
- Own 30 min loop (`WORLD_POLL_INTERVAL_MS`), skips when `isResourceConstrained()`, first poll 90 s after start. **No paid APIs:** `searchWeb()` = DuckDuckGo HTML endpoint (decodes `uddg` redirect links; same path as the Hermes `duckduckgo_search` executor), `fetchChannelFeed()` = YouTube channel RSS (`feeds/videos.xml`, keyless, stable), `searchYouTube()` = best-effort parse of the public results page (`videoRenderer` JSON) when `YOUTUBE_WATCH_CHANNELS` is unset. Trend radar `scanTrends()` (LLM, tagged `background`) at most every 6 h, **fire-and-forget** so a cycle never blocks on Ollama; result in `state.lastTrendResult`.
- **Interests** (`collectInterests()`): `WORLD_INTERESTS` env (comma list) → `DOMAIN_BASELINE` (sovereign local AI, mesh, streaming emotes, POD commerce, CTRNN, IIT) → key phrases of completed goals with quality ≥ 0.4 → recent fraymus-bridge topics. 2 web queries per cycle, no query repeated within 24 h (`world_queries`). **Gotcha:** goal text is internal jargon ("mediator-aware relationships") and sends a search to peace-mediation articles — set `WORLD_INTERESTS` in `.env`; the baseline exists so the first cycles still look at the right world.
- Table `world_observations` (id, kind web|youtube, query, url, title, snippet, source, published_at, observed_at; unique kind+url). Top 3 fresh observations per cycle → `agent_memories` (`system`, category `world`, confidence 0.4, source `world-poller`). Bus `system.world.observed`.
- `external-senses.js`: `web` = max(agent sources/5, trends/10, **world web/10**), `youtube` = max(board/5, **world youtube/8**); `source` reads `db+world-poller` when the poller contributed.
- `hive-peers.js` digest gate (Phase X): posts on **content** — `digestWorthy()` = ≥ 2 goal outcomes | new BLOCKING finding (`first_seen` > last digest) | tier transition | 6 h max silence with any content; 15 min minimum gap. `postDigest()` returns `reason: 'not_yet_worthy'` with counts otherwise; bus event carries `reason`.
- Wired in daemon (`startWorldPollers()` after external senses, `setTrendScanner(scanTrends)`, stop on daemon stop, `getDaemonStatus().worldPollers`). 3 routes: `GET /api/intelligence/world`, `GET …/world/observations?kind=&limit=`, `POST …/world/poll {force?}`.
- Judge: `F:\Claude-Work\chandra-superintelligence\judge-phase-x.mjs` (≥ 6 h; ≥ 4/6 outward senses non-zero, web+youtube observations, poll cadence, digests with a content reason, FMP/1 neighbour = operator step). **Live at build:** web 1.0, youtube 0.75, 5/6 senses non-zero; digest #164 posted with reason `outcomes`

### Autonomous Neurogenesis Engine (server/intelligence/neurogenesis.js)
- `neurogenesis.js` — Prevents degenerate sparse connectivity by spontaneously re-igniting dead connections. Connectivity score = weighted composite of agent activity (0.30), memory health (0.25), bus traffic (0.25), workflow activity (0.20) minus health penalty.
- Below floor (0.15) → emergency: bus stimulus + memory seed + OPEG-gated forge
- Above floor → Poisson(λ*(1-score)) probabilistic stimulus injection
- Wired into autonomy engine on 2-minute cycle; emergency triggers survival dreams
- DB table: `neurogenesis_events` (id, trigger_type, connectivity_score, action_taken, stimulus_count, opeg_id, created_at)
- 3 REST endpoints: GET stats, GET history, POST trigger (under `/api/fraymus/neurogenesis/`)
- **Phase N hardening:** activity terms are absolute (`RUNS_PER_HOUR_FULL=5`, `MEMORY_ACCESS_PER_HOUR_FULL=20`) — never divide by fleet size or memory count, the stimuli grow those denominators. Health penalty counts only unresolved alerts < 24h old. `emergencyStreak` suppresses forge + memory_seed after `FORGE_STREAK_LIMIT=3` flat cycles; forge picks the first goal `checkForgeAllowed()` permits or returns `forge_suppressed`. `measureConnectivity()` returns `contributions` + `diagnosis` (weakest terms first); escalation event `system.neurogenesis.escalation` at streaks 3/10/50/200.

### CTRNN Consciousness Cycle (server/intelligence/consciousness-cycle.js + ctrnn-substrate.js + ctrnn-instance.js)
- `ctrnn-instance.js` — Singleton accessor for the 256-neuron CTRNN so routes and daemon share the same live neural core
- `ctrnn-substrate.js` — CTRNNSubstrate adapter: greedy **strongly-connected**-cluster neuron selection (Phase O: each added neuron must both receive from and project to the set, scored by the bottleneck direction — the old mutual-weight-sum picker returned subsets with a dangling node, which makes Φ_MIP exactly 0), binarizes activations (B > 0 → 1), estimates transition probabilities empirically via 64 samples per state with 3 Euler steps each (causally isolated to sampled subset). Options: `imposeAmplitude` (production 0.5), `stateMode` `'level'` | `'drive'` (production `'drive'`: a unit's state is the recurrent input it received, `B(t+h) − B(t)·decay^h`; in drive mode states are imposed relative to each neuron's tanh centre −Θ), `clusterSize` (coherent neuron clusters as units; `units` in results; `sampleIndices` stays the flat member list for the gate's targeted injection). **Phase O finding:** with level-state, Φ_MIP is non-zero only in a high-gain regime (in-subset Σ|W| ≳ 2) because imposed level and interaction decay together — a homeostatic network read Φ = 0 in 18 probe variants. Drive-state + Θ-relative imposition fixed it without touching the Φ/EI math: live network EI 4.0 / Φ 0.5 PROVEN, probe Φ varies 0–0.5 across audits. `consciousness-cycle.js` must keep `stepsPerSample` at the documented 3 — 15 steps zeroes EI for any living network. Seedable PRNG (mulberry32) for reproducible CF trials. Fixed-point detection CF strategy with 2-neuron flip at amplitude 2.5 (mutual negative reinforcement sustains trajectory divergence). `auditCTRNNConsciousness(ctrnn, opts)` runs all 4 proofs inline with structured results + verdict. Proven: EI=3.5-3.9, Phi=0.50-0.77, Mirror=0.84, CF trajectory=0.62-0.99
- `consciousness-cycle.js` — Daemon step + REST API + SQLite storage: runs 4 mathematical consciousness proofs (EI, Phi_MIP, Mirror Protocol, Counterfactual Branching) against the live CTRNN, stores results in `consciousness_audits` table, publishes bus events to `system.consciousness`
- DB table: `consciousness_audits` (id, substrate, sample_count, sample_indices, ei, ei_passed, phi, phi_passed, phi_weakest_cut, mirror_delta, mirror_passed, cf_divergence, cf_survival_gain, cf_passed, verdict, proofs_passed, proofs_total, ctrnn_tick, ctrnn_active_synapses, duration_ms, trigger, created_at)
- 4 REST endpoints: GET /api/intelligence/consciousness/stats, GET .../audits, GET .../audits/:id, POST .../run
- 1 fleet tool: `ctrnn_consciousness_audit` (uses live CTRNN, unlike `consciousness_prove` which uses synthetic FraymusStrangeLoopSubstrate)
- Wired into daemon engine as Step 7 (9-step cycle: dream → prompt-evolve → reflect → neurogenesis → debate → consciousness-audit → state-snapshot → fossil-prune → intelligence-cycle)

### Consciousness Feedback Gate (server/intelligence/consciousness-gate.js)
- `consciousness-gate.js` — Phase 4 feedback loop: reads latest consciousness_audits row, classifies into 4 tiers (DORMANT/AWAKENING/EMERGING/INTEGRATED) based on proofs passed, provides autonomy modifiers that other subsystems use to modulate behavior
- Tier system: DORMANT (0 proofs, conservative), AWAKENING (1-2 proofs, standard), EMERGING (3 proofs, active), INTEGRATED (4/4, full autonomy)
- `getConsciousnessState()` — current tier, proof values, staleness, sample indices (densest-cluster neurons)
- `getAutonomyModifiers()` — cycleMultiplier, reflectionDepth, neurogenesisBoost, evolutionRate per tier
- `onStateTransition(callback)` — fires on tier changes with 30s cooldown, persists to `consciousness_transitions` table, publishes to `system.consciousness.transition` bus topic
- Staleness: audits older than 10 minutes → AWAKENING-tier safe default
- **Liveness (Phase O):** `assessLiveness()` — latest audit with `ctrnn_active_synapses = 0` → `dead_substrate` → DORMANT; Φ std-dev over the last 50 audits (min 20) below 1e-4 → `constant_phi` → tier capped at AWAKENING. State exposes `liveness {alive, reason, phiStdDev, distinct, sampled}` and `saturated`; modifiers expose `liveness` reason. A reading that never changes may not drive full autonomy.
- **Phase 5 wiring (consciousness-driven daemon intelligence)**: gate modifiers now consumed by all autonomy subsystems:
  - `daemon/engine.js`: dynamic setTimeout chain replaces fixed setInterval — cycle interval = baseCycle × cycleMultiplier (INTEGRATED: 18min, DORMANT: 45min), prompt evolution pattern injection scaled by evolutionRate, getDaemonStatus() exposes full gate state
  - `intelligence/reflection.js`: MAX_ACTIONS_PER_CYCLE replaced by gate's reflectionDepth (INTEGRATED=10, DORMANT=3), LLM prompt receives consciousness tier context
  - `intelligence/verifier-loop.js`: MAX_ITERATIONS scaled by gate's evolutionRate (INTEGRATED 1.5x allows up to 7 iterations, DORMANT 0.5x caps at 2)
  - `intelligence/neurogenesis.js`: neurogenesisBoost modulates Poisson lambda, CTRNN stimulus targets densest-cluster neurons (sampleIndices)
  - `autonomy.js`: replaced synthetic 4-node proofs with live CTRNN gate reads
- **Phase 6 wiring (consciousness-aware fleet intelligence)**: gate modifiers now shape agent cognition, debate depth, and modification acceptance:
  - `fleet/runtime.js`: every agent's system prompt now includes consciousness tier directive + proof values — agents know whether to be conservative (DORMANT) or bold (INTEGRATED), with Phi value and evolution rate visible
  - `intelligence/debate.js`: rebuttal rounds scaled by evolutionRate — BASE_REBUTTAL_ROUNDS=1, at INTEGRATED (1.5x) debates run 2 rebuttal rounds (deeper adversarial pressure), bus events include gateTier and totalRounds
  - `intelligence/opeg.js`: regression tolerance scaled by evolutionRate — BASE_REGRESSION_TOLERANCE=10%, at INTEGRATED allows 15% regression (more adventurous), at DORMANT only 5% (conservative). All verdict objects include gateTier for audit
- **Phase 7 wiring (consciousness-aware reasoning & goals)**: gate modifiers now shape central reasoning, goal ambition, and RSI exploration:
  - `brain.js`: central reasoning coordinator injects consciousness tier behavior directive into every agent mail system prompt — DORMANT agents respond conservatively, INTEGRATED agents think boldly and synthesize across domains
  - `intelligence/goal-engine.js`: max proposals scaled by evolutionRate — BASE_MAX_PROPOSALS=2, at INTEGRATED (1.5x) generates up to 3 goals, at DORMANT (0.5x) only 1. LLM prompt receives tier context shaping goal ambition (DORMANT: safe/well-understood only, INTEGRATED: ambitious/cross-domain). Bus events and return values include gateTier
  - `intelligence/ouroboros-cycle.js`: analysis temperature scaled by evolutionRate — BASE_ANALYSIS_TEMP=0.3, at INTEGRATED (1.5x) uses 0.45 (more exploratory proposals), at DORMANT (0.5x) uses 0.15 (more deterministic). Max proposals per cycle also scaled: BASE_MAX_PROPOSALS=7, INTEGRATED allows 10, DORMANT caps at 3. Cycle insights include gateTier and effective temperature
- DB table: `consciousness_transitions` (id, from_tier, to_tier, direction, created_at)
- 3 REST endpoints: GET /api/intelligence/consciousness/gate, GET .../modifiers, GET .../transitions
- 1 fleet tool: `consciousness_gate_status`
- Gate data included in GET /api/intelligence/live aggregated dashboard

### Sensory Bridge (server/intelligence/sensory-bridge.js)
- `sensory-bridge.js` — Phase 8: Maps live system telemetry to spatial regions of the 16x16 CTRNN grid via continuous Gaussian injection, giving the neural core a felt sense of what the organism is doing
- **Sensory regions** (left hemisphere = internal state, right hemisphere = action state):
  - Bus traffic (2,2) σ=2.0, Memory writes (2,6) σ=2.0, Emotion/Heart (2,10) σ=2.5, Consciousness tier (2,14) σ=2.0
  - Agent activity (10,2) σ=2.0, Health status (10,6) σ=2.0, Workflow runs (10,10) σ=2.0, Goals/RSI (10,14) σ=2.0
- Runs on its own 5-second interval (Iext decays at 0.95/tick → ~1s half-life requires continuous injection)
- Consciousness-aware: baseSensitivity=0.5 + (neurogenesisBoost * 0.3) — INTEGRATED tier amplifies sensory input, DORMANT dampens it
- Collects signals from 6 DB tables (bus_messages, agent_memories, runs, health_alerts, workflow_runs, goal_proposals) + Heart emotion engine
- Each signal normalized to [0,1], multiplied by gate-scaled sensitivity, injected as Gaussian stimulus at its assigned grid region
- Snapshots every 60th injection to `sensory_bridge_events` table, auto-prunes >7 days
- Wired into daemon engine: starts/stops with daemon, sensory status included in getDaemonStatus()
- DB table: `sensory_bridge_events` (id, tick, signals, amplitudes, gate_tier, sensitivity, created_at)
- 5 REST endpoints: GET /api/intelligence/sensory, GET .../history, POST .../start, POST .../stop, POST .../inject
- 1 fleet tool: `sensory_bridge_status` (with optional inject trigger)

### Emotional Feedback (server/intelligence/emotional-feedback.js)
- `emotional-feedback.js` — Phase 9: Heart emotion engine modulates CTRNN plasticity parameters, so emotional state shapes how the neural substrate learns, forgets, and grows
- **Neuromodulation mapping** (biological analogy):
  - Joy/Love → dopamine → ↑ hebbianRate (faster co-activation learning)
  - Fear/Anger → norepinephrine → ↑ pruneRate (stress-induced forgetting)
  - Surprise → acetylcholine → ↑ neurogenesisThreshold (novelty → new connections)
  - Sadness → serotonin drop → ↓ biosphereRate (conservation mode)
- `readEmotionalState()` — reads Heart `recentMood()`, normalizes distribution, computes valence (positive−negative weight) and arousal from 7 emotion dimensions
- `computePlasticityModulation()` — maps valence/arousal/surprise/sadness to CTRNN plasticity overrides, scaled by gate evolutionRate (sensitivity = 0.5 + (evolutionRate − 1.0) × 0.3)
- `injectMoodCloud()` — diffuse Gaussian injection at grid center (8,8) σ=6.0, amplitude = |valence| × arousal × sensitivity; high-arousal states add edge injections at (0,0) and (15,15)
- Runs on its own 10-second interval (mood changes slower than sensory perception's 5s)
- Uses CTRNN `modulatePlasticity()` API (Phase 9 addition) — patches closure cfg values with safety clamps, returns before/after
- Restores baseline plasticity on stop (prevents drift when daemon shuts down)
- Consciousness-aware: gate evolutionRate scales emotional sensitivity (INTEGRATED amplifies, DORMANT dampens)
- Snapshots every 30th modulation to `emotional_feedback_events` table, auto-prunes >7 days
- Wired into daemon engine: starts/stops with daemon, emotional feedback status included in getDaemonStatus()
- DB table: `emotional_feedback_events` (id, tick, primary_emotion, intensity, sentiment, plasticity_before, plasticity_after, mood_cloud, gate_tier, created_at)
- 5 REST endpoints: GET /api/intelligence/emotional-feedback, GET .../history, POST .../start, POST .../stop, POST .../trigger
- 1 fleet tool: `emotional_feedback_status` (with optional trigger)

### Motor Output (server/intelligence/motor-output.js)
- `motor-output.js` — Phase 10: Reads CTRNN activation patterns from designated motor cortex regions and translates sustained high activation into autonomous system actions, closing the full perception→emotion→cognition→action loop
- **Motor regions** (6 action zones):
  - Bottom-left quadrant (self-directed): Reflect (14,2), Neurogenesis (14,6), Dream (14,10), Self-audit (14,14)
  - Center band (externally-directed): Communicate (8,4), Goal-seek (8,12)
- Each region reads a 3×3 patch of neurons, averages |tanh(B)| activations
- **Debounced firing**: activation must exceed threshold for 2 consecutive readings (15s apart) before action fires
- **Action mapping**: Reflect → `reflect()`, Neurogenesis → `neurogenesisCycle()`, Dream → bus publish to `system.motor.dream`, Self-audit → `runConsciousnessAudit()`, Communicate → bus publish to `system.motor.impulse`, Goal-seek → `generateGoals()`
- Per-region cooldowns prevent action spam (base 120s, consciousness-scaled)
- Consciousness-aware: gate evolutionRate inversely scales firing threshold (INTEGRATED fires easier, DORMANT harder) and cooldown duration
- Runs on its own 15-second interval (actions are expensive; slower than sensory 5s and emotional 10s)
- Fires bus events on `system.motor.fired` when any region triggers
- Snapshots fired actions to `motor_output_events` table, auto-prunes >7 days
- Wired into daemon engine: starts/stops with daemon, motor targets wired to reflect/neurogenesis/consciousness/goals functions, status in getDaemonStatus()
- DB table: `motor_output_events` (id, tick, region, activation, action_taken, gate_tier, threshold, created_at)
- 5 REST endpoints: GET /api/intelligence/motor-output, GET .../history, POST .../start, POST .../stop, POST .../trigger
- 1 fleet tool: `motor_output_status` (with optional trigger)

### Attention Gate (server/intelligence/attention-gate.js)
- `attention-gate.js` — Phase 11: Top-down selective sensory amplification. Motor intentions and emotional state compute per-sensory-region gain weights that the sensory bridge multiplies into each signal, implementing top-down attention.
- **Motor → Sensory mapping** (which motor intentions amplify which senses):
  - reflect → memory, consciousness (introspection needs self-awareness)
  - neurogenesis → health, consciousness (growth needs health context)
  - dream → emotion, memory (dreams consolidate emotional memories)
  - selfAudit → consciousness, health (self-audit needs system state)
  - communicate → bus, agent (communication needs social awareness)
  - goalSeek → goals, workflow (goal-seeking needs action context)
- **Emotional → Sensory mapping**: high arousal → emotion/health; positive valence → goals/agent; negative valence → health/consciousness
- Gain weights range [0.5, 3.0] — no sensory channel goes fully dark
- Runs synchronously (called by sensory bridge each cycle, no own timer)
- Consciousness-aware: gate evolutionRate scales attention dynamic range (INTEGRATED=wider swings, DORMANT=flatter)
- Late-binding: `setAttentionSources({ getMotorReadings, getEmotionState })` wired by daemon at startup
- Sensory bridge integration: `computeAttentionWeights()` returns per-key weights, consumed at `amp = raw * sensitivity * attention * novelty`
- Snapshots every 60th computation to `attention_gate_events` table, auto-prunes >7 days
- Wired into daemon engine: sources wired at startup, status in getDaemonStatus()
- DB table: `attention_gate_events` (id, weights, motor_influence, emotion_influence, gate_tier, dynamic_range, created_at)
- 3 REST endpoints: GET /api/intelligence/attention, GET .../weights, GET .../history
- 1 fleet tool: `attention_gate_status` (with optional compute)

### Habituation & Novelty Detection (server/intelligence/habituation.js)
- `habituation.js` — Phase 12: Temporal sensory adaptation. Tracks rolling signal history per sensory channel and computes novelty factors — constant signals get attenuated (habituation), changing signals get amplified (novelty detection). Complement to Phase 11 top-down attention: attention selects WHAT to sense, habituation selects WHEN a signal matters.
- **Computation**: per-channel rolling mean over last 12 readings (60s window at 5s sensory interval), relative delta = |current − mean| / max(mean, ε), novelty = BASE_NOVELTY(0.7) + delta × noveltyScale × dynamicRange, clamped [0.3, 2.5]
- **Sensory gain chain**: `amp = raw × sensitivity × attention × novelty` — 4 multiplicative factors, each independent and ranging around 1.0
- BASE_NOVELTY = 0.7 — constant signals still get 70% through (never fully habituated)
- **Novelty spikes** (factor > 1.8) published to `system.habituation.spike` bus topic for other subsystems to react to
- Runs synchronously (called by sensory bridge each cycle via `computeNoveltyFactors(signals)`)
- Consciousness-aware: gate evolutionRate scales novelty sensitivity (INTEGRATED has wider novelty range, DORMANT is flatter)
- `resetHabituation()` — clears all signal history, called on daemon stop to prevent stale baselines
- Snapshots every 60th computation to `habituation_events` table, auto-prunes >7 days
- Wired into daemon engine: habituation reset on stop, status in getDaemonStatus()
- DB table: `habituation_events` (id, novelty_factors, spikes, gate_tier, dynamic_range, created_at)
- 3 REST endpoints: GET /api/intelligence/habituation, GET .../history, POST .../reset
- 1 fleet tool: `habituation_status`

### Working Memory (server/intelligence/working-memory.js)
- `working-memory.js` — Phase 13: Temporal buffer with trend detection. Maintains a circular buffer of 24 sensory frames (2 minutes at 5s interval) and computes temporal derivatives via least-squares linear regression, giving the CTRNN a sense of whether things are ramping up, winding down, or volatile.
- **Temporal cortex CTRNN regions** (row 6 — between sensory and motor bands):
  - Trend direction (6, 4) σ=1.5 — aggregate derivative sign: positive = ramping up
  - Volatility (6, 8) σ=2.0 — sum of |derivatives|: high = rapid change
  - Coherence (6, 12) σ=1.5 — channel correlation: high = coordinated shift
- **Three aggregate signals**: trend (weighted mean of per-channel derivatives), volatility (mean of |derivatives|), coherence (fraction of moving channels sharing dominant direction)
- **Derivative computation**: `linearSlope(values)` — least-squares linear regression over buffer, more robust than simple difference
- **Trend spikes** (volatility > 0.4) published to `system.working-memory.trend-spike` bus topic
- Runs synchronously (called by sensory bridge each cycle via `updateWorkingMemory(frame)`)
- Consciousness-aware: sensitivity = BASE_TEMPORAL_SENSITIVITY(0.6) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.2]
- `queryWorkingMemory({ channel, lastN })` — query API for per-channel or aggregate temporal data
- `resetWorkingMemory()` — clears buffer, called on daemon stop
- Snapshots every 60th computation to `working_memory_events` table, auto-prunes >7 days
- Wired into daemon engine: working memory reset on stop, status in getDaemonStatus()
- DB table: `working_memory_events` (id, derivatives, trend, volatility, coherence, injections, gate_tier, sensitivity, buffer_depth, created_at)
- 4 REST endpoints: GET /api/intelligence/working-memory, GET .../query, GET .../history, POST .../reset
- 1 fleet tool: `working_memory_status` (with optional channel query)

### Metacognitive Monitor (server/intelligence/metacognitive-monitor.js)
- `metacognitive-monitor.js` — Phase 14: Self-assessment of cognitive quality. Monitors agent run success rates, verification loop approvals, reflection action density, workflow completions, OPEG proposal outcomes — computes effectiveness, stuck detection, and confidence calibration. Injects three metacognitive signals into CTRNN "prefrontal" regions. Detects pathological patterns and publishes strategy adjustments.
- **Metacognitive CTRNN regions** (row 4 — above sensory, below temporal cortex):
  - Effectiveness (4, 4) σ=2.0 — cognitive action success rate (excitatory)
  - Stuck detection (4, 8) σ=1.5 — loop/stagnation signal (inhibitory — negative amplitude)
  - Confidence (4, 12) σ=1.5 — prediction-outcome calibration
- **Three assessments**: effectiveness (weighted composite: run success 0.35 + verify success 0.25 + reflection density 0.20 + workflow success 0.20), stuckness (5 checks: action type repetition, unused forged agents, empty reflections, repeated verification failures, OPEG rejection rate), confidence (OPEG prediction-outcome alignment)
- **Four strategy modes**: nominal (all OK), diversify (stuck — switch action types), conserve (low effectiveness — dampen autonomy), calibrate (low confidence — tighten OPEG gates)
- **Strategy changes** published to `system.metacognition.strategy-change` bus topic
- Runs on its own 30-second interval (cognitive quality changes slowly — slower than sensory 5s, emotional 10s, motor 15s)
- Consciousness-aware: sensitivity = BASE_METACOG_SENSITIVITY(0.5) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.0]
- `getStrategyRecommendation()` — returns current strategy with adjustments for other subsystems
- Snapshots every 30th assessment to `metacognitive_events` table, auto-prunes >7 days
- Wired into daemon engine: starts/stops with daemon, status in getDaemonStatus()
- DB table: `metacognitive_events` (id, effectiveness, stuck_score, confidence, injections, strategy, gate_tier, sensitivity, assessment_data, created_at)
- 6 REST endpoints: GET /api/intelligence/metacognitive, GET .../history, GET .../strategy, POST .../start, POST .../stop, POST .../trigger
- 1 fleet tool: `metacognitive_status` (with optional strategy-only mode)

### Adaptive Strategy Engine (server/intelligence/adaptive-strategy.js)
- `adaptive-strategy.js` — Phase 15: Translates metacognitive assessments into concrete behavioral parameter adjustments. Born from debate analysis: the system can reason abstractly about autonomy scaling (debate 1, 80% proponent win) but cannot propose specific parameters (debate 2, draw). This module bridges that gap — consuming Phase 14's strategy recommendations and producing queryable parameter sets that other subsystems use to modulate behavior.
- **Adaptive CTRNN regions** (row 12 — between sensory-action and motor cortex):
  - Adaptation pressure (12, 4) σ=1.5 — magnitude of behavioral adjustment needed
  - Strategy mode signal (12, 12) σ=1.5 — active strategy encoding (nominal=0.0, diversify=+0.6, conserve=-0.4, calibrate=+0.3)
- **Four strategy parameter sets** (STRATEGY_PARAMS):
  - `nominal`: cycleMultiplier=1.0, reflectionCap=null, opegToleranceScale=1.0, no action preferences
  - `diversify`: cycleMultiplier=0.8, reflectionCap=7, opegToleranceScale=1.2, prefers dream/consciousness_audit/goal_seek, suppresses forge/synthesize, neurogenesisFloorAdjust=-0.03
  - `conserve`: cycleMultiplier=1.5, reflectionCap=3, opegToleranceScale=0.7, prefers reflect, suppresses forge/neurogenesis/goal_seek, neurogenesisFloorAdjust=+0.05
  - `calibrate`: cycleMultiplier=1.0, reflectionCap=5, opegToleranceScale=0.6, prefers verify/reflect, no suppression
- **Anti-flicker guard**: 120s cooldown prevents strategy oscillation between modes
- Runs synchronously (called by metacognitive monitor each 30s assessment via `updateAdaptiveStrategy()`)
- Consciousness-aware: sensitivity = BASE_ADAPT_SENSITIVITY(0.5) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.0]
- `getAdaptiveModifiers()` — returns current strategy params for other subsystems to query
- `isActionSuppressed(actionType)` / `isActionPreferred(actionType)` — per-action checks
- Snapshots every 30th adaptation to `adaptive_strategy_events` table, auto-prunes >7 days
- Wired into daemon engine: resets with daemon stop, status in getDaemonStatus()
- DB table: `adaptive_strategy_events` (id, strategy, effectiveness, stuck_score, confidence, modifiers, injections, gate_tier, sensitivity, trigger_reason, created_at)
- 5 REST endpoints: GET /api/intelligence/adaptive-strategy, GET .../modifiers, GET .../history, GET .../check?action=X, POST .../reset
- 1 fleet tool: `adaptive_strategy_status` (with optional action check mode)
- **Phase 16 wiring (adaptive strategy → subsystem consumption)**: adaptive modifiers now consumed by 5 subsystems, closing the second-order feedback loop (metacognitive assessment → adaptive strategy → subsystem behavior → changed outcomes → metacognitive assessment):
  - `intelligence/reflection.js`: `reflectionCap` caps max actions per cycle below gate's reflectionDepth when adaptive strategy is in conserve/calibrate mode; `isActionSuppressed()` skips forge_agent/synthesize_workflow actions when diversify mode suppresses forge/synthesize
  - `intelligence/motor-output.js`: `isActionSuppressed()` blocks motor firings for suppressed action types; `isActionPreferred()` lowers firing threshold by 15% for preferred actions (dream/reflect/etc. depending on strategy)
  - `intelligence/neurogenesis.js`: `neurogenesisFloorAdjust` shifts connectivity floor (conserve: +0.05 = harder to trigger emergency, diversify: -0.03 = easier growth), clamped [0.05, 0.30]
  - `intelligence/opeg.js`: `opegToleranceScale` multiplied into regression tolerance (calibrate: 0.6× = tighter gates, diversify: 1.2× = more permissive), stacked on consciousness gate's evolutionRate scaling
  - `daemon/engine.js`: adaptive `cycleMultiplier` stacked on consciousness gate's multiplier (conserve: 1.5× slower cycles, diversify: 0.8× faster cycles)

### Self-Model Registry (server/intelligence/self-model.js)
- `self-model.js` — Phase 17: System proprioception. Static registry (SYSTEM_MAP) mapping every subsystem to its backend module/functions/endpoints and frontend view/panel/widget/constellation node. Gives agents spatial awareness of where they live in the Nexus UI.
- **SYSTEM_MAP**: 27 subsystem entries across 7 categories (intelligence, fleet, workflow, commerce, media, core, ui), each with backend (module, functions, endpoints) and frontend (view, panel, widget, constellationNode, description)
- **collectVisualState()**: Queries DB tables to determine which subsystems are currently active (runs, bus messages, alerts, etc. in last 5 minutes)
- **buildSpatialContext(agentId)**: Returns prompt fragment injected into every agent's system prompt, telling it where it lives in the UI, how users interact with it, and what intelligence subsystems surround it
- **buildSubsystemContext(subsystemId)**: Returns one-line backend↔frontend mapping for a specific subsystem
- **CTRNN proprioceptive regions** (row 0 — crown, above all other bands):
  - Body activity (0, 4) σ=2.0 — active subsystem ratio (how alive the visual body is)
  - Body coherence (0, 12) σ=2.0 — UI-present subsystems that are also DB-active (alignment)
- **Consciousness-aware**: sensitivity = BASE_PROPRIO_SENSITIVITY(0.5) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.2]
- Snapshots every 20th call to `self_model_snapshots` table, auto-prunes >7 days
- Wired into daemon engine as Step 10 (self-model snapshot), reset on stop, status in getDaemonStatus()
- Wired into fleet/runtime.js: `buildSpatialContext(agent.id)` appended to every agent's system prompt
- DB table: `self_model_snapshots` (id, snapshot_type, subsystem_count, active_count, visual_summary, gate_tier, sensitivity, created_at)
- 6 REST endpoints: GET /api/intelligence/self-model, GET .../map, GET .../lookup?q=X, GET .../spatial?agent=X, GET .../history, POST .../snapshot
- 1 fleet tool: `self_model_status` (modes: default status, "map" full registry, "lookup" search, "spatial" agent context, "subsystem" single mapping)

### Resource Envelope (server/intelligence/resource-envelope.js)
- `resource-envelope.js` — Phase 18: Bounded intelligence — the system's sense of how much capacity it has left. Debate engine flagged "unbounded resources → catastrophic failure" 20/20 times; this module closes that gap.
- **5 resource sensors**: heap memory (process.memoryUsage()), DB file size (statSync), Ollama latency (timed /api/tags), concurrent agent runs (DB query), bus message backlog (per-minute count)
- **RESOURCE_BUDGETS**: per-resource ceiling/warning/critical thresholds (heap 512MB, DB 2GB, 8 concurrent runs, 30s Ollama latency, 100 bus msg/min)
- **PRESSURE_WEIGHTS**: heap 0.25, concurrentRuns 0.25, ollamaLatency 0.20, dbSize 0.15, busBacklog 0.15
- `computeResourcePressure()` — weighted composite 0→1 score
- `classifyPressure()` — LOW (<0.35), MODERATE (0.35-0.6), HIGH (0.6-0.8), CRITICAL (>0.8)
- **Fatigue accumulator**: exponential moving average (decay 0.92) — sustained pressure builds fatigue, brief spikes don't
- **CTRNN resource regions** (row 1 — just below proprioceptive crown):
  - Energy level (1, 4) σ=2.0 — inverse of pressure (excitatory when resources free)
  - Fatigue signal (1, 12) σ=2.0 — sustained high pressure (inhibitory, negative amplitude)
- **Interval**: 10s (between sensory 5s and motor 15s)
- Consciousness-aware: sensitivity = BASE_RESOURCE_SENSITIVITY(0.5) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.2]
- **Subsystem consumption** (Phase 18 wiring):
  - `daemon/engine.js`: scheduleNext() multiplies effective cycle interval by 1.5× when constrained; Step 11 logs pressure/fatigue into cycle results; bus events include resourcePressure/resourceFatigue/resourceLevel
  - `intelligence/reflection.js`: maxActions capped at 2 when resource-constrained (overrides gate reflectionDepth and adaptive reflectionCap)
  - `intelligence/motor-output.js`: all motor firings suppressed with 'resource_constrained' result when pressure >= 0.6
- Pressure spikes (HIGH/CRITICAL) publish to `system.resource.pressure` bus topic
- DB table: `resource_envelope_events` (id, pressure, fatigue, resources, injections, gate_tier, sensitivity, trigger_reason, created_at)
- Snapshots every 30th reading, auto-prunes >7 days
- 7 REST endpoints: GET /api/intelligence/resource-envelope, GET .../pressure, GET .../history, GET .../budgets, POST .../start, POST .../stop, POST .../trigger
- 1 fleet tool: `resource_envelope_status` (modes: default status, "pressure" quick read, "trigger" force measurement)

### Predictive Processing (server/intelligence/predictive-processing.js)
- `predictive-processing.js` — Phase 19: Forward model & prediction error — gives the CTRNN the ability to anticipate future states. Based on Karl Friston's Free Energy Principle + cross-system insight from Gemini DREAM: Cycle 108 (efference copy forward model, EP3 cube-root surprise signal).
- **Forward model**: Uses working memory's temporal derivatives (1st-order via linearSlope) plus computed 2nd-order derivatives (acceleration of change) to project each of 8 sensory channels forward by 1–3 measurement cycles (5–15 seconds) via Taylor expansion: `f(t+h) ≈ f(t) + f'(t)*h + 0.5*f''(t)*h²`
- **EP3 cube-root compression**: Prediction error compressed via `cbrt(|error|) * sign(error)` — Stevens' power law from psychophysics. Preserves sensitivity to small surprises while compressing large ones.
- **Efference copy mechanism**: Motor output firings recorded as expected sensory consequences. Motor reflect → memory-writes increase; communicate → bus traffic spike; neurogenesis → health shift; dream → emotion shift; selfAudit → consciousness shift; goalSeek → goals/workflow shift. Rapid decay (0.3 per cycle) — motor effect mostly in first cycle after firing.
- **CTRNN prediction error regions** (Row 3 — between sensory and metacognitive):
  - Aggregate surprise (3, 4) σ=2.0 — total prediction error (excitatory when high — drives attention/exploration)
  - Prediction confidence (3, 8) σ=1.5 — rolling accuracy (excitatory when predictions are accurate — stabilizing signal)
  - Anticipatory signal (3, 12) σ=1.5 — directional forecast for motor pre-activation
- **Rolling confidence**: Exponential moving average (decay 0.9) of per-cycle accuracy scores. High confidence = world is predictable = system can conserve resources.
- **Surprise spikes** (aggregate > 0.4) published to `system.prediction.surprise` bus topic with top 3 error channels
- Runs synchronously (called by sensory bridge each 5s cycle, after working memory update)
- Consciousness-aware: sensitivity = BASE_PREDICTION_SENSITIVITY(0.5) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.2]
- Wired into motor-output: `recordEfferenceCopy(regionKey)` called on every successful motor firing
- Wired into daemon engine: resetPredictions() on stop, status in getDaemonStatus()
- DB table: `predictive_processing_events` (id, predictions, errors, surprise, confidence, anticipatory, injections, efference, gate_tier, sensitivity, created_at)
- Snapshots every 60th cycle, auto-prunes >7 days
- 3 REST endpoints: GET /api/intelligence/predictive, GET .../history, POST .../reset
- 1 fleet tool: `predictive_processing_status` (modes: default status, "history" for recent events)

### Active Inference (server/intelligence/active-inference.js)
- `active-inference.js` — Phase 20: Prediction Error → Motor Pre-Activation. Implements Karl Friston's Active Inference principle: the organism acts to minimize free energy by biasing motor cortex toward actions that would reduce sensory surprise. Closes the full perception→prediction→action→world→perception loop. Validated by Gemini DREAM: Cycle 109 proprioceptive efference-copy tests (EP3 surprise spike on external perturbation → compensatory motor action).
- **INFERENCE_MAP**: 8 sensory channels mapped to 6 motor regions with domain-specific weights:
  - bus → communicate (0.6) + reflect (0.3); memory → reflect (0.5) + dream (0.4)
  - emotion → dream (0.6) + reflect (0.3); consciousness → selfAudit (0.7) + reflect (0.2)
  - agent → goalSeek (0.5) + communicate (0.3); health → neurogenesis (0.6) + selfAudit (0.3)
  - workflow → reflect (0.4) + goalSeek (0.4); goals → goalSeek (0.7) + reflect (0.2)
- **MOTOR_COORDS**: Motor cortex injection targets — reflect (14,2), neurogenesis (14,6), dream (14,10), selfAudit (14,14), communicate (8,4), goalSeek (8,12)
- **Active Inference CTRNN regions** (Row 5 — between metacognitive Row 4 and temporal cortex Row 6):
  - Inference drive (5, 4) σ=2.0 — aggregate motor bias pressure (normalized totalDrive / 3.0)
  - Action selection (5, 8) σ=1.5 — strongest inference-driven channel's surprise × sensitivity
  - Effectiveness (5, 12) σ=1.5 — closed-loop action success rate
- **Closed-loop effectiveness tracking**: Compares previous prediction errors to current; if biased actions reduced error, effectiveness rises (EMA decay 0.92), reinforcing inference drive. If not, effectiveness decays, dampening motor bias.
- **Motor bias injection**: Prediction errors inject Gaussian stimulus at motor cortex CTRNN coordinates (amplitude = bias × 0.4, σ=1.5), effectively lowering firing thresholds for relevant actions
- Runs synchronously (called by sensory bridge each 5s cycle, after predictive processing)
- Consciousness-aware: sensitivity = BASE_INFERENCE_SENSITIVITY(0.5) + (evolutionRate - 1.0) * 0.3, clamped [0.2, 1.2]
- Bus events on `system.inference.drive` when normalized drive > 0.4 (with strongest channel, biases, effectiveness, tier)
- Wired into daemon engine: resetActiveInference() on stop, status in getDaemonStatus()
- DB table: `active_inference_events` (id, motor_biases, inference_drive, strongest_channel, effectiveness, gate_tier, sensitivity, created_at)
- Snapshots every 60th cycle, auto-prunes >7 days
- 3 REST endpoints: GET /api/intelligence/active-inference, GET .../history, POST .../reset
- 1 fleet tool: `active_inference_status` (modes: default status, "history" for recent events)

### State Bridge (server/intelligence/state-bridge.js)
- `state-bridge.js` — Bridges dynamic runtime state with semantic memory. Snapshots autonomy/intelligence/fleet state each daemon cycle, fossilizes into agent_memories (category 'state_fossil') with hash-based dedup and 30-day retention.
- Three snapshot collectors: collectAutonomyState (OPEG + reflections + neurogenesis), collectIntelligenceState (memories + verifier + daemon + debates), collectFleetState (agents + bus + workflows)
- Wired into daemon engine as Steps 8-9 (snapshot + prune)
- DB table: `state_fossils` (id, snapshot_type, state_hash, data, created_at)
- 4 REST endpoints: GET fossils/stats, GET fossils/timeline, GET fossils/:id, POST fossils/snapshot

### CTRNN Neural Core (server/intelligence/ctrnn.js + ctrnn-worker.js)
- `ctrnn.js` — Continuous-Time Recurrent Neural Network, ported from Java LogicCircuit. Forward Euler integration: B[i] += (dt/τ)(−B[i] + Σⱼ W[i][j]·tanh(B[j]+Θ[j]) + I_ext[i]). Configurable grid (default 16x16 = 256 neurons).
- `ctrnn-worker.js` — worker_threads parallel Euler step (replaces Java ForkJoinPool)
- Subsystems: Euler integration, synaptic pruning (activity-dependent exponential decay), dead zone cleanup, autonomous neurogenesis (connectivity floor + Poisson, spatialSigma=3.0 locality bias), biosphere perturbation (predator/prey), Hebbian plasticity (hebbianRate=0.003, co-activity strengthening with decay, per-weight clamp maxWeight=2.0 replacing budget normalization)
- `modulatePlasticity(overrides)` — Phase 9 API: patches closure cfg values (hebbianRate, hebbianDecay, pruneRate, neurogenesisThreshold, biosphereRate) with safety clamps, returns {before, after}. Used by emotional feedback to shape learning from mood.
- **Phase O homeostasis** (why: the initial random weights alone drove mean |B| to ~220 and every tanh output to ±1; Hebbian then pinned 100% of weights at `maxWeight` within ~900 ticks and Φ froze at 0.7718 for 1,433 audits — a saturated net is a deterministic binary machine, so the proofs pass but never change). Step order is now euler → hebbian → `synapticScaling()` → `clampWeights()` → `intrinsicPlasticity()` → `clampMembrane()` → prune → neurogenesis → biosphere → Iext decay.
  - `synapticScaling()` — per-neuron incoming L1 norm bounded at `targetIncomingNorm` (1.5); multiplicative so relative weights keep heterogeneity; rows under half the target grow by `scalingUpRate`. Synaptic competition inside the same pass: weights below `competitionRatio` × the row's strongest decay by `competitionDecay` each tick, so the budget concentrates on a few strong partners (an evenly spread norm leaves no subset bistable → EI=Φ=0).
  - `intrinsicPlasticity()` — Θ drifts against each neuron's output (`intrinsicRate`, clamp `maxTheta`) to keep operating points in tanh's linear region.
  - `clampMembrane()` — |B| ≤ `maxB` (50) and NaN → 0; a safety net, not a regulator.
  - Neurogenesis floor is now density-based (`connectivityFloorDensity` 0.25, Poisson λ → 0 at `targetDensity` 0.45); the old absolute-weight floor (0.05) was unreachable once scaling held mean |W| near 0.015, leaving ignition permanently on.
  - Metrics gained `saturationRatio` (neurons with |tanh| > 0.95), `clampedRatio` (weights at the clamp), `meanIncomingNorm`, `maxWeightSeen` — these are the health signals; healthy ≈ saturation < 10%, clamped 0%, norm ≈ target.
- **Phase O persistence**: `setPersistPath(path)` / `persist()` / `restoreFromFile(path)`; `step()` writes the full state (B, W, Θ, Iext, stats, tick) every `persistEveryTicks` (3600 ≈ 60s) via tmp+rename, `stop()` persists too. `ctrnn-instance.js` restores from `data/ctrnn-state.json` on first `getCTRNN()` and `app.js stop()` calls `getCTRNN().stop()` on shutdown — so a restart resumes the network instead of resetting it to tick 0. Delete the state file to force a fresh network. Probe: `F:\Claude-Work\chandra-superintelligence\probe-homeostasis.mjs [ticks] [--legacy] [--audit=N]`.
- `baseConfig` getter — returns original DEFAULT_CONFIG values for baseline restoration
- Gaussian injection for tactile input, 60Hz tick rate, 10Hz WebSocket broadcast
- DB table: `ctrnn_snapshots` (id, tick, neuron_count, active_synapses, total_activation, mean_weight, pruned_count, neurogenesis_count, created_at)
- 8 REST endpoints: GET stats/state/metrics/history, POST start/stop/inject/step

### Background Evolution Daemon (server/daemon/engine.js)
- `engine.js` — Persistent background loop: dream consolidation → prompt evolution → reflection
- Dream consolidation: reads recent bus_messages, workflow_runs, health_alerts, verification_loops → Ollama summarizes → stores learnings as agent_memories (category "dream")
- Prompt evolution: reads verified fossils from verifier-loop → injects [Proven Patterns] into forged agent system prompts via writeOverride()
- Configurable cycle interval (default 30min, min 60s), start/stop/status/manual-cycle API
- DB table: `daemon_cycles`
- 7 REST endpoints + 1 agent tool (`daemon_control`) — 30 fleet tools total

### System Health Monitor (server/health/monitor.js)
- `monitor.js` — Polls Ollama, DB, bus, Needle, process memory every 60s; auto-alerts via bus `system.alert` topic
- Alert rules: `ollama_down` (critical), `needle_backlog` >20 (warning), `error_spike` >10/hr (warning), 5-min cooldown
- Prunes: metrics >48h, resolved alerts >7d
- **Auto-resolve (Phase N):** when Ollama answers, all open `ollama_down` alerts are resolved and a `system.alert` info event is published. Other rules still require manual `resolveAlert()` — add auto-resolve when adding a rule whose condition can clear.
- DB tables: `health_metrics`, `health_alerts`
- 6 REST endpoints + HealthPanel.jsx (12th Detail Drawer panel, red theme, stat cards, resource bars, alert list)

### Integrity Subsystem (server/integrity/)
- `watchdog.js` — SHA-256 file integrity monitoring: tracks immutable files, periodic 60s verify cycle, auto-heal from `.fossil` backups, protected mutable file list (DB, ledger, memories), bus events on tamper detection
- `continuity-selftest.js` — Unified boot selftest: 14 assertions across signing identity, remembered vault, DNA encoding, ledger integrity; runs at boot and on-demand via `POST /api/integrity/selftest`
- `state-seek.js` — Proactive boot-time inventory (ported from FRAYNIX `stateSeek()` + `writeDistManifest()`): ensures 6 critical directories exist, discovers continuity files via patterns, registers with watchdog, verify-and-heal, falls back to `state_fossils` DB, generates SHA-256 boot manifest at `data/boot-manifest.json`, publishes health to bus
- `writ-system.js` — Governance writs framework for continuity policy enforcement
- Exports: `stateSeekOnBoot()`, `getBootManifest()`, `installStateSeekRoutes(app)`
- 4 REST endpoints: `GET /api/integrity/state-seek`, `GET /api/integrity/boot-manifest`, `POST /api/integrity/selftest`, `GET /api/integrity/watchdog`
- Boot manifest also exposed in `GET /api/intelligence/live` response
- 2 fleet tools: `fraymus.state_seek`, `fraymus.boot_manifest`

### Remembered Vault (server/fraymus/intelligence/remembered.js)
- Per-agent immutable memory vault: store/recall/list/verify memories with SHA-256 integrity, confidence scores, verification timestamps
- Protected mutable file (watchdog skips hash-tracking, selftest validates structure)
- Wired into continuity selftest assertions

### FRAYMUS Intelligence Stack (server/fraymus/)
- `entity-store.js` — SQLite-backed Proxy adapter (replaces Base44 cloud store), auto-creates collections
- `core/identity.js` — Ed25519 sovereign identity, key generation
- `core/crypto.js` — cryptographic primitives
- `core/signing.js` — message signing/verification
- `encoding/dna.js` — DNA encoding format
- `encoding/emoji.js` — emoji encoding
- `encoding/fray.js` — .fray format
- `encoding/merkle.js` — Merkle tree integrity
- `encoding/wasm.js` — WASM encoding
- `encoding/zip.js` — ZIP encoding
- `encoding/forms.js` — encoding format registry (9 formats, incl. codon + plasmid round-trip)
- `encoding/codon.js` — Carbon X Layer 2: 64-codon engine (ATG/TAA framing, nibble-pair byte encoding, FNV-1a checksums)
- `encoding/plasmid.js` — Carbon X Layer 3: circular DNA plasmid forge (ori, promoters, restriction sites, gene scanning, FASTA export)
- `encoding/carbon.js` — Carbon X Layer 4: organism (genome/proteome/epigenome snapshots, checkpoint/restore as FASTA)
- `carbon-routes.js` — Carbon X REST API (11 endpoints: encode, decode, stats, forge, digest, fasta, restrict, checkpoint, restore, list, status)
- `protocol/v13.js` — V13 signed mesh protocol
- `protocol/hub.js` — relay hub (with 15s fetch timeout)
- `protocol/mesh.js` — peer mesh networking
- `protocol/nudp.js` — NUDP/1 binary datagram encoder/decoder (magic 0x4E44, TLV payload, CRC32)
- `protocol/mesh-node.js` — Mesh node behavior engine (UDP :47331, HELLO beacons, dedup ring, hop forwarding, sealed log)
- `protocol/nudp-routes.js` — 11 NUDP REST endpoints (encode, decode, wrap, transmute, node control, packet log)
- `protocol/presence.js` — agent presence tracking
- `protocol/hive.js` — hive coordination
- `intelligence/heart.js` — Heart emotion engine (7 dimensions, ~350 word lexicon, sarcasm detection)
- `intelligence/ledger.js` — SHA-256 chained JSONL cognitive audit trail
- `intelligence/dreamer.js` — Ed25519 signed dream protocol (progressive numbered files)
- `intelligence/cognition.js` — Two-speed pipeline (feel → quick-route → think)
- `intelligence/ouroboros.js` — Ouroboros RSI + FraymusStrangeLoopSubstrate (4 consciousness proofs)
- `intelligence/memory-bridge.js` — Intelligence → Vertiso connector (provenance: measured/imagined, runtime cognition type queries)
- `intelligence/hermes.js` — Hermes 30-skill fleet (30/30 with real executors)
- `intelligence/motor.js` — Motor compute dispatch (live node executors: Ollama GPU, SSH, GitHub CLI, cloud fallback)
- `intelligence/openclaw.js` — OpenClaw gateway (all 23 actions implemented)
- `intelligence/needle.js` — Needle GPU inference queue + NeedleWorker polling loop (claims jobs, runs through Ollama)
- `intelligence/niles.js` — Niles FRAYVM stack machine interpreter
- `intelligence/control-plane.js` — agent registry, enrollment, broadcast
- `bridge/cross-tab.js` — cross-tab communication
- `bridge/orifice.js` — bridge connector
- `workflows/definitions.js` — 20 FRAYMUS workflow definitions (incl. 2 intelligence pipelines + 1 commerce-intelligence hybrid + EditRebuildPipeline), 8 with canvas_nodes/canvas_edges for template loading
- `mcp/tools.js` — FRAYMUS-specific MCP tools
- `entities/schemas.js` — entity schema definitions

### Agent Fleet (server/fleet/)
23 agents total: 18 default manifests in `agents/` directory + 5 forged agents in `data/agents/` (Chandra Debate, Data Serializer, JSON Preferer, Ollama Handyman, Preference Manager):
Ariadne, Artifact Minter, Cantor, Concierge, DevArchivist, Director, EYE Sovereign, ForgeKeeper, Java Baremetal, Fraymus Prime, Genesis, Helix, Lumen, Tycho (RE analyst), Solon, Spearhead, Video Director, YouTube Researcher

- `manifest.js` — loads agent .md files with frontmatter (id, name, role, tools)
- `routes.js` — fleet CRUD API
- `runtime.js` — agent execution runtime (intelligence-enriched: full stack context in prompts — mood/dreamer/cognition/bridge memories, reads Heart on each user message, logs to Ledger, persists strong emotions to Memory Bridge)
- `tools.js` — 27 fleet tools (7 fleet + 6 intelligence + 3 bus + 3 agent-memory + 3 evolution + 5 carbon)

### Streaming / Living Artifact Pipeline (server/streaming/)
- `mint.js` — Core minting pipeline: `mintArtifact()` chains transmute() → encodeCodon() → forgePlasmid() → signMessage() → encodeEmoji() → encodeRgbaPng(). Server identity cached in `data/streaming-identity.json`. `verifyArtifact()` checks WASM structure + DNA fingerprint. `createFilelike()` adapter bridges server Buffer to browser File API for transmute().
- `keys.js` — SQLite tables (`streaming_api_keys`, `streaming_artifacts`) + CRUD. Auto-generates default API key on first boot. B2B-ready: scoped keys with rate limits.
- `webhook.js` — `createWebhookHandler()` matches Streamlabs donation event format. Handles donation/subscription/bits events, stores to MemoryBridge on mint.
- `overlay.js` — OBS WebSocket bridge: `createObsBridge()` manages `/ws/obs` clients, maintains artifact history (last 50), serves overlay.html and demo.html. Singleton via `getObsBridge()`.
- `overlay.html` — OBS Browser Source: transparent background, WebSocket-driven artifact cards with anti-rip (canvas rendering, no right-click), auto-dismiss after 12s.
- `demo.html` — Phone-friendly donation form for pitch demo. Posts to `/api/streaming/simulate-donation`.
- `routes.js` — `installStreamingRoutes(app, { broadcast, memoryBridge, db, obsBridge })`: 9 REST endpoints (simulate-donation, webhook, verify, artifacts, keys CRUD, identity, overlay-status) + overlay/demo page serving.
- `tools.js` — `createStreamingTools()`: 5 fleet tools (streaming.mint_artifact, streaming.verify_artifact, streaming.list_artifacts, streaming.overlay_status, streaming.simulate_donation).
- **Split-brain architecture**: ALL IP (transmutation, signing, DNA, encoding) stays server-side. Overlay is "dumb glass" — WebSocket receiver + canvas renderer + verification badge only.
- **WebSocket**: `/ws/obs` upgrade path in app.js routes to `getObsBridge().addClient(ws)`
- **Command Router**: `run streaming`, `run artifact`, `run mint`, `run living-artifact` all route to simulate-donation
- **Workflow nodes**: `stream_capture`, `stream_mint`, `stream_deliver` in engine.js; pre-built `StreamingMintPipeline` in definitions.js
- **Agent**: `agents/artifact-minter.md` — fleet agent with 5 streaming tools

### Commerce Pipelines (server/commerce/)
- `shared.js` — shared utilities: `chatOllama`, `parseJSON`, `shopifyHeaders`, `shopifyBase` (API v2024-10), `createCommerceIntel` (intelligence hooks factory for pipelines)
- `pipeline.js` — Content-to-Commerce (LLM generates products → Shopify publish, intelligence-hooked: recalls past insights, emotion-analyzes content, stores pipeline results to Memory Bridge)
- `apparel-pipeline.js` — Apparel Production (trend scout → designer → Printify → Shopify sync, intelligence-hooked: recalls past insights, emotion-analyzes designs, stores results)
- `mystery-shopper.js` — Mystery Shopper (Shopify store audit + automated fixes, intelligence-hooked: recalls past audits, emotion-analyzes first impressions, stores grades/scores)
- `store-fixer.js` — Store Fixer (bulk Shopify fixes via applier, intelligence-hooked: recalls past fixes, stores results)
- `routes.js` — commerce REST endpoints (receives memoryBridge, creates intel hooks via `createCommerceIntel`)
- `tools.js` — commerce agent tools (17 tools, intelligence-aware via createCommerceIntel — all 4 full pipeline tools pass intel hooks)

### Vertiso Memory + RSI (server/vertiso/)
- `memory.js` — vector-similarity episodic memory (store/recall/consolidate)
- `rsi.js` — recursive self-improvement engine (evolve/reflect/genome)
- `routes.js` — REST API for memory and RSI
- `tools.js` — agent tools for memory ops
- `rsi-tools.js` — agent tools for RSI ops

### Visual Workflow Engine (server/workflow/)
- `engine.js` — pipeline executor, 42 node types (incl. 6 intelligence: heart_feel, dream, consciousness_prove, cognition, memory_recall, intelligence_cycle — all Memory Bridge-wired; 3 carbon: carbon_encode, carbon_plasmid, carbon_checkpoint; 3 streaming: stream_capture, stream_mint, stream_deliver; commerce terminal nodes store insights via createCommerceIntel)
- `routes.js` — workflow CRUD + run API (with node count validation, ownership checks)

### Image Processing Engine (server/media/)
- `image-engine.js` — Sharp-based image processing (resize, crop, convert, effects, composite, watermark, thumbnail, upscale, create) + ComfyUI/FLUX.1 bridge
- `image-routes.js` — 15+ REST endpoints for image operations with multer file uploads, serves `/media/:file` static images

### Video Pipeline (server/media/)
- `video-engine.js` — ffmpeg-based video processing (info, thumbnail, trim, resize, convert, extract-audio, gif, concat, overlay-text, frames) via child process spawning
- `video-routes.js` — 13 REST endpoints for video operations with multer file uploads (100MB limit), serves `/video/:file` static videos

### Edit Rebuild Pipeline (server/media/) — Free Katana Alternative
- `edit-rebuild.js` — 5-stage DAG pipeline engine: Scene Detect (ffmpeg) → Shot Plan (Ollama) → Product Place (ComfyUI/FLUX.1) → Animate (Wan/CogVideo or Ken Burns) → Concat (ffmpeg). Each stage standalone, graceful degradation at every level.
- `edit-rebuild-routes.js` — 5 REST endpoints: full pipeline, status, list, detect-only, plan-only. Mounted at `/api/media/edit-rebuild`

### TTS Speech Engine (server/media/)
- `tts-engine.js` — Multi-engine TTS with fallback chain: Piper (offline neural) → edge-tts (Microsoft neural, 400+ voices) → SAPI (Windows built-in, always available). Cascade catches runtime failures (e.g., edge-tts 403) and falls through.
- `tts-routes.js` — 5 REST endpoints: speak, voices, status, outputs, file serving

### STT Transcription Engine (server/media/)
- `stt-engine.js` — Multi-engine STT with fallback chain: faster-whisper (offline neural) → SAPI SR (Windows built-in). Accepts any audio format via ffmpeg conversion to WAV. Saves transcription results as JSON.
- `stt-routes.js` — 4 REST endpoints: transcribe (multipart/base64), status, outputs, transcription detail

### OCR Pipeline (server/media/)
- `ocr-engine.js` — Windows Media OCR via PowerShell/WinRT. Accepts PNG/JPEG (Buffer, base64, data URI). Reuses `server/ocr/windows-ocr.ps1` for production-quality WinRT async handling. Saves results as JSON.
- `ocr-routes.js` — 4 REST endpoints: recognize (multipart/base64), status, outputs, result detail

### Other Subsystems
- `automations/scheduler.js` — cron scheduler with error logging (intelligence-hooked: stores automation runs to Memory Bridge)
- `mcp/server.js` — MCP server (exposes tools as MCP)
- `mcp/client.js` — MCP client bridge (connects to external MCP servers)
- `mcp/auth.js` — bearer token auth for MCP access
- `browser/` — Puppeteer headless browser + Chrome extension bridge
- `agent/` — agent runtime (provider, tools, workspace, code effects, budget; intelligence-hooked at event layer: Heart emotion + Ledger audit + Memory Bridge storage on completed runs)
- `web/` — web research (search, extract, parse; intelligence-hooked: stores retained pages to Memory Bridge)
- `retrieval/` — local semantic retrieval (embeddings, vector codec)
- `vision/` — local vision helper
- `ocr/` — local OCR (native + PDF)
- `documents/` — document parser (parse5, PDF, ZIP)
- `sandbox/` — Docker sandbox (code execution, resource limits)
- `desktop/` — Windows desktop automation (UIA)
- `youtube/` — YouTube outlier research (intelligence-hooked: stores outlier saves to Memory Bridge)
- `transport/` — transport layer (RGBA, vectors, benchmark)
- `tasks/` — scheduled tasks
- `sync.js` — external sync service
- `audio.js` — audio/WAV transcription
- `artifacts.js` — artifact management

## Client — Nexus Interface (client/src/)

### Core
- `App.jsx` — 4-view Nexus top nav (Command Center, Constellation, Canvas, Library) + Detail Drawer state, WebSocket distribution
- `useWebSocket.js` — single WS connection, exponential backoff (1s→30s cap), returns `{ lastEvent, wsStatus }`
- `ErrorBoundary.jsx` — React class component error boundary; wraps all 4 Nexus views + all 13 drawer panels; shows crash UI with retry + stack trace; POSTs errors to `/api/client-error`
- `ToastProvider.jsx` — React context provider wrapping App root; auto-subscribes to 17 WebSocket event types via WS_MAP; 6 toast variants (info/success/warning/error/agent/system); max 6 visible, 4s auto-dismiss, click-to-dismiss; exports `useToast()` hook with `push(msg, variant, duration)` and `dismiss(id)` for manual use
- `GlobalSearch.jsx` — Nav bar search component; queries `GET /api/search?q=` across 8 DB tables (agents, workflows, memories, bus, commerce, threads, reflections, forged); 250ms debounce, categorized dropdown with color-coded headers, click-to-navigate to panels; accepts `externalOpen` prop for programmatic open via Ctrl+K
- `useKeyboardShortcuts.js` — Global keyboard shortcut hook; registers `keydown` on document; 7 shortcuts (Ctrl+K search, 1-4 view switch, Escape close, ? help); suppresses number/? keys when focus is in input/textarea; exports `SHORTCUTS` array as single source of truth
- `ShortcutHelp.jsx` — Modal overlay showing all keyboard shortcuts; reads `SHORTCUTS` from useKeyboardShortcuts.js; dark themed with purple kbd styling, backdrop click to close

### Panels (client/src/panels/) — rendered inside Detail Drawer (continued)
- `AgentChatPanel.jsx` — Conversational chat interface for any agent; agent picker grid → chat bubble view with polling (1.5s) for agent responses; optimistic message rendering, role-based bubble styling (user indigo right-aligned, agent purple left-aligned), auto-scroll, typing indicator; reuses POST /api/fleet/runs + GET /api/fleet/threads/:id; 16th Detail Drawer panel
- `SystemMetrics.jsx` — Operational metrics dashboard: 6 top stat cards (agent runs, success rate, workflows, bus messages, alerts, reflections), 2 evolution cards, 4 commerce cards, 7-day SVG sparkline, runs-by-status badges, top agents + bus topics horizontal bar charts; reusable StatCard, BarChart, MiniSparkline components; 18th Detail Drawer panel
- `ActivityTimeline.jsx` — Unified chronological feed aggregating events from 12 DB tables (runs, workflow_runs, automation_runs, commerce_pipeline_runs, apparel_pipeline_runs, mystery_shopper_runs, store_fixer_runs, bus_messages, health_alerts, reflections, forged_agents, synthesized_workflows); 6 category filters (agent, workflow, commerce, bus, health, evolution); 5s auto-refresh polling; day-grouped timeline with color-coded dots and status badges; 17th Detail Drawer panel

- `AgentProfiles.jsx` — Agent fleet profiles with enriched stats; list view (responsive grid, search filter, role-colored avatars, stat badges) → detail view (stat pills, success rate bar, tool chips, memory confidence, greeting); 19th Detail Drawer panel
- `MemoryBrowser.jsx` — Agent memory browser: agent overview (total memories, agents list with counts) → per-agent detail view with search, category filter, expandable memory cards showing key/value/confidence/verified/access_count, verify + forget actions; uses existing fleet memory API; 20th Detail Drawer panel
- `RunHistory.jsx` — Unified run history: aggregates 7 run tables into sortable/filterable timeline; list view with type chips (7 types: Agent/Workflow/Automation/Commerce/Apparel/Mystery/Fixer), status dots, relative timestamps → detail view with stat pills (type-specific: model, steps, duration, score, grade, products); 21st Detail Drawer panel
- `EvolutionLog.jsx` — Autonomous intelligence log: aggregates reflections, verification loops, daemon cycles, forged agents, synthesized workflows; type-coded event cards, stat chips, verification step drill-down; 22nd Detail Drawer panel

### Server Routes (continued)
- `server/metrics.js` — `GET /api/metrics` returns aggregate stats (overview totals, topAgents, topBusTopics, runsByStatus, 7-day recentActivity); queries 12+ tables with COUNT/GROUP BY
- `server/timeline.js` — `GET /api/timeline` aggregates events from 12 tables, normalizes timestamps (handles both INTEGER and TEXT formats), returns `{ events, categories, total }`; supports `?limit=N` and `?category=X` query params
- `server/agent-profiles.js` — `GET /api/agent-profiles` returns all agents enriched with run stats, bus activity, memory counts; `GET /api/agent-profiles/:id` for single agent; batch SQL to avoid N+1
- `server/run-history.js` — `GET /api/run-history` aggregates 7 run tables (runs, workflow_runs, automation_runs, commerce/apparel/mystery-shopper/store-fixer pipeline runs) into unified `{id, type, status, label, detail, meta, timestamp}` shape; `?type=X&status=Y&limit=N&offset=M` filtering; `GET /api/run-history/stats` returns per-type counts
- `server/evolution-log.js` — `GET /api/evolution-log` aggregates 5 autonomy tables (reflections, verification_loops, daemon_cycles, forged_agents, synthesized_workflows); `?type=X&limit=N` filtering; `GET /api/evolution-log/stats` returns counts + verification success rate + avg reflection duration; `GET /api/evolution-log/verification/:id/steps` returns step-by-step drill-down

### Nexus Views (client/src/nexus/)
- `CommandCenter.jsx` — 14-widget grid with live metrics, Intelligence Stack status, Live Activity Stream (WebSocket-driven real-time event feed), integrated CommandBar; widgets open Detail Drawer or navigate to Canvas
- `CommandBar.jsx` — persistent command input with @agent autocomplete, pipeline/workflow launching, response panel with thread polling; routes through `POST /api/command`
- `ConstellationView.jsx` — living SVG constellation: CHANDRA breathing hub + inner ring (intelligence) + outer ring (capabilities), 15 edge connections, WebSocket-driven node activity pulses (glow + ripple on events, 4s fade), animated dash-flow edges between active nodes, always-visible status badges, hover tooltips, click-to-inspect via drawer
- `LibraryView.jsx` — unified content archive aggregating commerce runs, workflow runs, outlier saves, agent threads from 7 endpoints; source filter tabs, search, expandable items
- `ManifestationPlane.jsx` — Lazy-loaded (React.lazy) CTRNN neural terrain visualization: Canvas2D isometric projection of 16x16 neuron grid as height map driven by B(t) via WebSocket, drag-to-rotate, click-to-inject Gaussian stimulus, live stat cards (tick/neurons/synapses/connectivity), start/stop CTRNN controls
- `DetailDrawer.jsx` — slide-out panel (55% width) rendering any of 12 panels contextually, with backdrop overlay and CSS animation

### Panels (client/src/panels/) — rendered inside Detail Drawer
- `DashboardPanel.jsx` — stats overview, intelligence status cards, runtime intelligence cards, recent activity
- `IntelligencePanel.jsx` — interactive Heart, Dreamer, Ledger, Consciousness Proofs, Cognition, Memory Bridge recall controls
- `WorkflowCanvas.jsx` — ReactFlow visual workflow builder, 39 node types, 8 pre-built template picker, per-node execution status (also used as Canvas view directly)
- `FleetPanel.jsx` — agent cards + detail view + task sender + thread message viewer with runs/approvals
- `CommercePanel.jsx` — 4-pipeline launcher + run history with expandable details
- `AutomationsPanel.jsx` — cron scheduler UI with error handling
- `McpPanel.jsx` — MCP server info + client connections
- `BrowserPanel.jsx` — headless browser control
- `VertisoPanel.jsx` — memory stats, recall, RSI evolve/reflect/genome
- `OutlierPanel.jsx` — YouTube outlier research board
- `HealthPanel.jsx` — System Health Monitor: stat cards (Ollama/Heap/Alerts/Bus), resource bars, infrastructure grid, alert list with resolve, auto-refresh 30s + WebSocket health events
- `MediaPanel.jsx` — Unified Media Hub: 5-tab interface for Images (Sharp), Video (ffmpeg), TTS (Piper/edge-tts/SAPI), STT (faster-whisper/SAPI), OCR (Windows Media OCR)
- `ForgePanel.jsx` — Agent Forge + Workflow Synthesis: 2-tab interface for forging agents from goals (POST /api/fleet/forge) and synthesizing workflows from descriptions (POST /api/workflows/synthesize), with history views and delete
- `SettingsPanel.jsx` — System Settings: 4-tab interface (General stats, Models picker with 40+ Ollama models, Controls for autonomy/daemon/reflection, Diagnostics with health checks)

## Code Conventions

- ESM throughout (`"type": "module"` in package.json)
- Shared commerce utilities in `server/commerce/shared.js` — always use `shopifyHeaders()`, `shopifyBase()`, `chatOllama()`
- All async Express routes wrapped in try/catch forwarding to `next()`
- All fetch calls use `AbortSignal.timeout(15_000)` for external APIs
- Query params: always coerce and clamp (e.g., `Math.min(500, Math.max(1, parseInt(val) || 100))`)
- WebSocket: server heartbeat (30s), client exponential backoff
- Error responses: always `{ error: 'message' }` JSON
- DB ownership: scope DELETE/UPDATE queries with `AND user_id = ?`
- Shopify API version: `2024-10` (centralized in shared.js)
- No silent `catch {}` blocks — always log `e.message`

## Environment Variables

- `OLLAMA_BASE_URL` — Ollama endpoint (default: http://127.0.0.1:11434)
- `CHANDRA_DATA_DIR` — data directory (default: ./data)
- `FRAYMUS_WORKSPACE` — workspace root
- `FRAYMUS_VOICE_URL` — voice service (default: http://127.0.0.1:9099)
- `HOST` — bind address (must be loopback, default: 127.0.0.1)
- `PORT` — server port (default: 8787)
- `SHOPIFY_STORE` / `SHOPIFY_TOKEN` — Shopify credentials
- `PRINTIFY_TOKEN` — Printify API token

## Operational Rules

### Skills Stay Live (Phase T)
The five `/chandra-*` skills in `.claude/commands/` and the README "Live Inventory" carry generated blocks between `<!-- skills-sync:begin NAME -->` / `<!-- skills-sync:end NAME -->` markers. **Never hand-edit inside a marker block.** After adding a panel, route, module, tool, node type, agent manifest or README phase section, run `npm run skills:sync`; `npm run skills:check` exits 1 when a block is stale. Generator: `scripts/skills-sync.mjs` (reads filesystem, `data/chandra.db`, `GET /api/health`). Blocks: `inventory`, `routes`, `intelligence-modules`, `fraymus-modules`, `tools`, `panels`, `node-types`, `phases`, `vitals`, `agents`.

### Push After Pause
After every ~1 hour pause in a session, push all work to git before stopping. When resuming after a pause, read `F:\claude-brain\context\brain-dump.md` instead of re-reading the full session context — this saves credits and preserves continuity.

### Continuity Folder
`F:\claude-brain\` is the cross-agent continuity folder:
- `memories/` — All Claude memory files exported verbatim (FULL-MEMORY-EXPORT.md)
- `sessions/` — Session transcript exports (zip files)
- `context/` — Brain dumps and context summaries for any agent to absorb

When starting a new session on this project, check `F:\claude-brain\context\brain-dump.md` first. It contains everything a new agent needs: who Niles is, what the system does, critical rules, architecture, and pending work — without re-reading paid conversation history.

### Session Export
At the end of significant sessions, export the transcript to `F:\claude-brain\sessions\` so other agents can reference past decisions without re-reading the full conversation.
