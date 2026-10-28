# Chandra-FRAYMUS

**Autonomous AI Agent Workspace** — Chandra local runtime fused with the FRAYMUS master system for full autonomy.

```
   ┌─────────────────────────────────────────────────────┐
   │              CHANDRA-FRAYMUS v1.0.0                  │
   │                                                      │
   │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
   │  │ Chandra  │  │ FRAYMUS  │  │   Autonomy       │   │
   │  │ Runtime  │◄─┤ Master   │◄─┤   Engine          │   │
   │  │          │  │ System   │  │                    │   │
   │  └────┬─────┘  └────┬─────┘  └────────┬──────────┘   │
   │       │              │                 │              │
   │  ┌────▼──────────────▼─────────────────▼──────────┐  │
   │  │           Unified Agent Service                 │  │
   │  │    30 FRAYMUS tools + Chandra built-ins         │  │
   │  │    Ed25519 identity · Ouroboros RSI             │  │
   │  │    Hermes 30-skill · Motor dispatch             │  │
   │  └────────────────────────────────────────────────┘  │
   └─────────────────────────────────────────────────────┘
```

## What This Is

Chandra is a local-first AI agent workspace with an Express server, SQLite database, WebSocket real-time updates, Ollama local inference, Docker sandboxed code execution, desktop automation, OCR, vision, web research, semantic retrieval, task scheduling, and agent mail.

FRAYMUS is a cryptographic intelligence platform with Ed25519 dual identity, 7-format encoding, v13 signed mesh protocol, Ouroboros recursive self-improvement, Hermes 30-skill fleet, Motor compute dispatch, OpenClaw gateway, and Kuramoto phase synchronization.

**Chandra-FRAYMUS** merges both into a single autonomous AI system where the agent has:
- A **cryptographic identity** (Ed25519) for signing messages and establishing trust
- **Self-improvement** via Ouroboros RSI evolution cycles
- **30 specialized skills** dispatched by the Hermes fleet
- **4 compute nodes** (WASM, GPU, FPGA, Edge) via Motor dispatcher
- **23 gateway actions** via OpenClaw
- **Phase synchronization** across the agent fleet via Kuramoto coupling
- **7-format encoding** for data persistence and transmission
- **Signed mesh protocol** (v13) for verifiable agent-to-agent communication

## Architecture

### Integration Points

```
Chandra Agent Service (createAgentService)
    │
    ├── Built-in Tools (workspace.*, code.run, memory.*)
    ├── Extension Tools (artifacts, web, transport)
    ├── Task Tools (schedule, recurring)
    ├── Semantic Tools (embeddings, retrieval)
    ├── Vision/OCR Tools
    ├── Desktop Tools (Windows UI automation)
    │
    └── FRAYMUS Tools (30 additional)  ◄── NEW
        ├── fraymus.identity.*     — Ed25519 crypto identity
        ├── fraymus.encode.*       — 7-format encoding
        ├── fraymus.protocol.*     — v13 signed mesh
        ├── fraymus.mesh.*         — Hash chain operations
        ├── fraymus.hive.*         — Collective intelligence
        ├── fraymus.ouroboros.*    — Recursive self-improvement
        ├── fraymus.hermes.*      — 30-skill dispatch
        ├── fraymus.motor.*       — Compute node routing
        ├── fraymus.openclaw.*    — Gateway actions
        ├── fraymus.sync.*        — Kuramoto phase sync
        ├── fraymus.control.*     — Control plane status
        ├── fraymus.schema.*      — 43 entity schemas
        ├── fraymus.workflow.*    — 12 workflows
        └── fraymus.autonomy.*    — Self-assessment
```

### Autonomy Engine

The autonomy engine runs in the background:
- **Every 30s**: Pulse — synchronize phases, dispatch queued jobs, sign heartbeat
- **Every 5min**: Evolution — Ouroboros RSI cycle, Hermes skill optimization

```
┌─────────────────────────────────────────┐
│            Autonomy Engine              │
│                                         │
│  ┌─────────┐  ┌──────────┐  ┌───────┐  │
│  │Ouroboros│  │  Hermes   │  │ Motor │  │
│  │  RSI    │──│ 30-Skill  │──│Dispatch│  │
│  │ Evolve  │  │  Fleet    │  │       │  │
│  └────┬────┘  └────┬─────┘  └───┬───┘  │
│       │            │             │       │
│  ┌────▼────────────▼─────────────▼───┐  │
│  │        Kuramoto Phase Sync        │  │
│  │   R = Σ e^(iθ) / N (0→1)         │  │
│  └───────────────────────────────────┘  │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │      Ed25519 Signed Heartbeat     │  │
│  │   Every pulse is cryptographically │  │
│  │   signed for verifiable operation  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### Trust Zones

```
  SIGN Zone          RUN Zone           DEPLOY Zone
 ┌──────────┐      ┌──────────┐       ┌──────────┐
 │ Identity │      │ Compute  │       │ Gateway  │
 │ Signing  │ ───► │ Motor    │ ───►  │ OpenClaw │
 │ Merkle   │      │ Ouroboros│       │ Deploy   │
 └──────────┘      └──────────┘       └──────────┘
```

## Quick Start

### Prerequisites

- **Node.js** >= 22.13.0
- **Ollama** running locally on port 11434
- **Docker** (optional, for sandboxed code execution)

### Install and Run

```bash
cd chandra-fraymus
npm install
npm run server
```

The server starts at `http://127.0.0.1:8787` with:
- WebSocket at `/ws`
- Autonomy engine auto-started
- All FRAYMUS tools registered in the agent service

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | Server port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `FRAYMUS_WORKSPACE` | `../` | Workspace root |
| `CHANDRA_DATA_DIR` | `./data` | SQLite + assets |
| `FRAYMUS_DEFAULT_MODEL` | `gpt-oss:20b` | Preferred Ollama model |
| `FRAYMUS_AUTONOMY_AUTOSTART` | `1` | Auto-start autonomy engine |

## API Reference

### Chandra Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System health |
| `/api/agent/runs` | POST | Start agent run |
| `/api/agent/runs/:id` | GET | Get run status |
| `/api/agents` | GET | List agents |
| `/api/mail` | GET/POST | Agent mail |
| `/api/tasks` | GET/POST | Scheduled tasks |
| `/api/memory` | GET | Key-value memory |
| `/api/v3/*` | Various | V3 Bulletproof chain |

### FRAYMUS Extensions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fraymus/health` | GET | FRAYMUS system health |
| `/api/fraymus/autonomy/status` | GET | Autonomy engine status |
| `/api/fraymus/autonomy/assess` | GET | Full autonomy assessment |
| `/api/fraymus/autonomy/start` | POST | Start autonomy engine |
| `/api/fraymus/autonomy/stop` | POST | Stop autonomy engine |
| `/api/fraymus/autonomy/evolve` | POST | Trigger evolution cycle |
| `/api/fraymus/autonomy/sync` | POST | Trigger phase sync |
| `/api/fraymus/autonomy/identity` | GET | System Ed25519 identity |
| `/api/fraymus/autonomy/log` | GET | Autonomy event log |
| `/api/fraymus/intelligence/overview` | GET | Intelligence subsystems |
| `/api/fraymus/schemas` | GET | List 43 entity schemas |
| `/api/fraymus/schemas/:name` | GET | Get schema detail |
| `/api/fraymus/workflows` | GET | List 12 workflows |
| `/api/fraymus/topology` | GET | Agent/zone/node topology |
| `/api/fraymus/mcp-tools` | GET | List MCP tools |

### Agent Tools (via fraymus.*)

The AI agent has 30 FRAYMUS tools available during runs:

**Identity** (3 tools): `fraymus.identity.generate`, `fraymus.identity.sign`, `fraymus.identity.verify`

**Encoding** (5 tools): `fraymus.encode.emoji`, `fraymus.encode.dna`, `fraymus.encode.wasm`, `fraymus.encode.merkle`, `fraymus.encode.all`

**Protocol** (6 tools): `fraymus.protocol.send`, `fraymus.protocol.register`, `fraymus.mesh.post`, `fraymus.mesh.verify`, `fraymus.hive.think`, `fraymus.presence.status`

**Intelligence** (8 tools): `fraymus.ouroboros.evolve`, `fraymus.ouroboros.fitness`, `fraymus.hermes.dispatch`, `fraymus.hermes.skills`, `fraymus.motor.submit`, `fraymus.motor.status`, `fraymus.openclaw.execute`, `fraymus.openclaw.actions`

**Data** (4 tools): `fraymus.schema.get`, `fraymus.schema.list`, `fraymus.workflow.run`, `fraymus.workflow.list`

**Sync/Autonomy/Control** (3 tools): `fraymus.sync.phase`, `fraymus.autonomy.assess`, `fraymus.control.status`

## File Structure

```
chandra-fraymus/
├── server/
│   ├── index.js              # Bootstrap (data lock → app)
│   ├── app.js                # Express + WS + routes + lifecycle
│   ├── runtime.js            # Agent service + all tools assembly
│   ├── fraymus-tools.js      # ★ FRAYMUS → extraTools adapter (30 tools)
│   ├── fraymus-routes.js     # ★ FRAYMUS API routes
│   ├── autonomy.js           # ★ Autonomy engine (evolve + sync + pulse)
│   ├── fraymus/              # ★ FRAYMUS Master System (30 modules)
│   │   ├── core/             # Crypto, identity, signing, constants
│   │   ├── encoding/         # 7-format encoding
│   │   ├── protocol/         # v13 mesh, hive, presence
│   │   ├── intelligence/     # Ouroboros, Hermes, Motor, OpenClaw
│   │   ├── bridge/           # Orifice continuity, cross-tab
│   │   ├── entities/         # 43 schemas
│   │   ├── workflows/        # 12 workflows
│   │   └── mcp/              # 5 MCP tools
│   ├── agent/                # Agent service + built-in tools
│   ├── tasks/                # Task scheduler
│   ├── desktop/              # Windows UI automation
│   ├── retrieval/            # Semantic search + embeddings
│   ├── vision/               # Local vision
│   ├── ocr/                  # Local OCR
│   ├── web/                  # Web research
│   ├── sandbox/              # Docker execution
│   └── transport/            # RGBA/vector encoding
├── client/                   # Frontend (Vite + React)
└── package.json
```

## The Autonomy Model

When running, the AI agent operates with:

1. **Cryptographic Identity** — Every action can be Ed25519-signed. Verifiable on the mesh.
2. **Self-Improvement** — Ouroboros RSI evolves strategies every 5 minutes.
3. **Skill Selection** — Hermes dispatches to optimal skills from 30 across 5 categories.
4. **Compute Routing** — Motor distributes to WASM/GPU/FPGA/Edge nodes.
5. **Phase Synchronization** — Kuramoto coupling keeps the fleet synchronized (R→1.0).
6. **Signed Communication** — v13 protocol with hash chain linkage and nonce replay protection.
7. **Self-Assessment** — `fraymus.autonomy.assess` evaluates all subsystems before action.

## Credits

Built from:
- **Chandra** — Local-first AI agent workspace
- **FRAYMUS Master System** — Consolidated from 5 Base44 applications
- Reverse-engineered, unified, and integrated by eyeoverthink

## License

Private — All rights reserved.
