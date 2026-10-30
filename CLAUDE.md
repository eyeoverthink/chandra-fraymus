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
- **Client:** Vite + React, 4-view Nexus interface (Command Center, Constellation, Canvas, Library) + Detail Drawer for 9 panels, useWebSocket hook for live updates
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
- `encoding/forms.js` — encoding format registry (7 formats)
- `protocol/v13.js` — V13 signed mesh protocol
- `protocol/hub.js` — relay hub (with 15s fetch timeout)
- `protocol/mesh.js` — peer mesh networking
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
- `workflows/definitions.js` — 19 FRAYMUS workflow definitions (incl. 2 intelligence pipelines + 1 commerce-intelligence hybrid), 8 with canvas_nodes/canvas_edges for template loading
- `mcp/tools.js` — FRAYMUS-specific MCP tools
- `entities/schemas.js` — entity schema definitions

### Agent Fleet (server/fleet/)
17 agents defined as markdown manifests in `agents/` directory:
Ariadne, Cantor, Concierge, DevArchivist, Director, EYE Sovereign, ForgeKeeper, Java Baremetal, Fraymus Prime, Genesis, Helix, Lumen, Tycho (RE analyst), Solon, Spearhead, Video Director, YouTube Researcher

- `manifest.js` — loads agent .md files with frontmatter (id, name, role, tools)
- `routes.js` — fleet CRUD API
- `runtime.js` — agent execution runtime (intelligence-enriched: full stack context in prompts — mood/dreamer/cognition/bridge memories, reads Heart on each user message, logs to Ledger, persists strong emotions to Memory Bridge)
- `tools.js` — fleet management tools (7 fleet + 6 intelligence incl. memory_recall, intelligence_cycle)

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
- `engine.js` — pipeline executor, 36 node types (incl. 6 intelligence: heart_feel, dream, consciousness_prove, cognition, memory_recall, intelligence_cycle — all Memory Bridge-wired; commerce terminal nodes store insights via createCommerceIntel)
- `routes.js` — workflow CRUD + run API (with node count validation, ownership checks)

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
- `useWebSocket.js` — single WS connection, exponential backoff (1s→30s cap)

### Nexus Views (client/src/nexus/)
- `CommandCenter.jsx` — 10-widget grid with live metrics, Intelligence Stack status, Live Activity Stream (WebSocket-driven real-time event feed), integrated CommandBar; widgets open Detail Drawer or navigate to Canvas
- `CommandBar.jsx` — persistent command input with @agent autocomplete, pipeline/workflow launching, response panel with thread polling; routes through `POST /api/command`
- `ConstellationView.jsx` — living SVG constellation: CHANDRA breathing hub + inner ring (intelligence) + outer ring (capabilities), 15 edge connections, WebSocket-driven node activity pulses (glow + ripple on events, 4s fade), animated dash-flow edges between active nodes, always-visible status badges, hover tooltips, click-to-inspect via drawer
- `LibraryView.jsx` — unified content archive aggregating commerce runs, workflow runs, outlier saves, agent threads from 7 endpoints; source filter tabs, search, expandable items
- `DetailDrawer.jsx` — slide-out panel (55% width) rendering any of 9 panels contextually, with backdrop overlay and CSS animation

### Panels (client/src/panels/) — rendered inside Detail Drawer
- `DashboardPanel.jsx` — stats overview, intelligence status cards, runtime intelligence cards, recent activity
- `IntelligencePanel.jsx` — interactive Heart, Dreamer, Ledger, Consciousness Proofs, Cognition, Memory Bridge recall controls
- `WorkflowCanvas.jsx` — ReactFlow visual workflow builder, 36 node types, 8 pre-built template picker, per-node execution status (also used as Canvas view directly)
- `FleetPanel.jsx` — agent cards + detail view + task sender + thread message viewer with runs/approvals
- `CommercePanel.jsx` — 4-pipeline launcher + run history with expandable details
- `AutomationsPanel.jsx` — cron scheduler UI with error handling
- `McpPanel.jsx` — MCP server info + client connections
- `BrowserPanel.jsx` — headless browser control
- `VertisoPanel.jsx` — memory stats, recall, RSI evolve/reflect/genome
- `OutlierPanel.jsx` — YouTube outlier research board

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
