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

### Autonomous Neurogenesis Engine (server/intelligence/neurogenesis.js)
- `neurogenesis.js` — Prevents degenerate sparse connectivity by spontaneously re-igniting dead connections. Connectivity score = weighted composite of agent activity (0.30), memory health (0.25), bus traffic (0.25), workflow activity (0.20) minus health penalty.
- Below floor (0.15) → emergency: bus stimulus + memory seed + OPEG-gated forge
- Above floor → Poisson(λ*(1-score)) probabilistic stimulus injection
- Wired into autonomy engine on 2-minute cycle; emergency triggers survival dreams
- DB table: `neurogenesis_events` (id, trigger_type, connectivity_score, action_taken, stimulus_count, opeg_id, created_at)
- 3 REST endpoints: GET stats, GET history, POST trigger

### CTRNN Consciousness Cycle (server/intelligence/consciousness-cycle.js + ctrnn-substrate.js + ctrnn-instance.js)
- `ctrnn-instance.js` — Singleton accessor for the 256-neuron CTRNN so routes and daemon share the same live neural core
- `ctrnn-substrate.js` — CTRNNSubstrate adapter: samples 4-8 neurons from strategic grid positions (corners, center cross, quarter points), binarizes activations (B > 0 → 1), estimates transition probabilities empirically via 32 samples per state with 15 Euler steps each. `auditCTRNNConsciousness(ctrnn, opts)` runs all 4 proofs inline with structured results + verdict
- `consciousness-cycle.js` — Daemon step + REST API + SQLite storage: runs 4 mathematical consciousness proofs (EI, Phi_MIP, Mirror Protocol, Counterfactual Branching) against the live CTRNN, stores results in `consciousness_audits` table, publishes bus events to `system.consciousness`
- DB table: `consciousness_audits` (id, substrate, sample_count, sample_indices, ei, ei_passed, phi, phi_passed, phi_weakest_cut, mirror_delta, mirror_passed, cf_divergence, cf_survival_gain, cf_passed, verdict, proofs_passed, proofs_total, ctrnn_tick, ctrnn_active_synapses, duration_ms, trigger, created_at)
- 4 REST endpoints: GET /api/intelligence/consciousness/stats, GET .../audits, GET .../audits/:id, POST .../run
- 1 fleet tool: `ctrnn_consciousness_audit` (uses live CTRNN, unlike `consciousness_prove` which uses synthetic FraymusStrangeLoopSubstrate)
- Wired into daemon engine as Step 7 (9-step cycle: dream → prompt-evolve → reflect → neurogenesis → debate → consciousness-audit → state-snapshot → fossil-prune → intelligence-cycle)

### State Bridge (server/intelligence/state-bridge.js)
- `state-bridge.js` — Bridges dynamic runtime state with semantic memory. Snapshots autonomy/intelligence/fleet state each daemon cycle, fossilizes into agent_memories (category 'state_fossil') with hash-based dedup and 30-day retention.
- Three snapshot collectors: collectAutonomyState (OPEG + reflections + neurogenesis), collectIntelligenceState (memories + verifier + daemon + debates), collectFleetState (agents + bus + workflows)
- Wired into daemon engine as Steps 8-9 (snapshot + prune)
- DB table: `state_fossils` (id, snapshot_type, state_hash, data, created_at)
- 4 REST endpoints: GET fossils/stats, GET fossils/timeline, GET fossils/:id, POST fossils/snapshot

### CTRNN Neural Core (server/intelligence/ctrnn.js + ctrnn-worker.js)
- `ctrnn.js` — Continuous-Time Recurrent Neural Network, ported from Java LogicCircuit. Forward Euler integration: B[i] += (dt/τ)(−B[i] + Σⱼ W[i][j]·tanh(B[j]+Θ[j]) + I_ext[i]). Configurable grid (default 16x16 = 256 neurons).
- `ctrnn-worker.js` — worker_threads parallel Euler step (replaces Java ForkJoinPool)
- Subsystems: Euler integration, synaptic pruning (activity-dependent exponential decay), dead zone cleanup, autonomous neurogenesis (connectivity floor + Poisson), biosphere perturbation (predator/prey)
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
