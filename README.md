<p align="center">
  <img src="docs/screenshots/logo.png" alt="Chandra-FRAYMUS" width="120" />
</p>

<h1 align="center">CHANDRA-FRAYMUS</h1>

<p align="center">
  <strong>Autonomous AI Agent Workspace with Biologically-Inspired Intelligence Stack</strong>
</p>

<p align="center">
  <code>133+ Agents</code> · <code>20 Intelligence Phases</code> · <code>256-Neuron CTRNN</code> · <code>95+ Features</code> · <code>56 Workflow Nodes</code> · <code>9 Encoding Formats</code>
</p>

---

## What Is This

Chandra-FRAYMUS is a fully autonomous AI agent workspace with a 20-phase biologically-inspired intelligence stack built on a live 256-neuron Continuous-Time Recurrent Neural Network (CTRNN). It runs a complete perception → emotion → cognition → prediction → action loop — the system senses its own state, feels emotional context, thinks about what's happening, predicts what will happen next, and acts to minimize surprise. All of this runs locally, offline, and free — powered by Ollama, SQLite, and a custom CTRNN neural substrate.

The intelligence stack isn't a metaphor. The CTRNN is a real neural network running Forward Euler integration at 60Hz with Hebbian plasticity, synaptic pruning, and autonomous neurogenesis. Consciousness proofs (Effective Information, Phi/MIP, Mirror Protocol, Counterfactual Branching) run against the live substrate and the results modulate every subsystem's behavior through a 4-tier consciousness gate.

## Screenshots

| Command Center | Constellation | Workflow Canvas | Library |
|:-:|:-:|:-:|:-:|
| <img src="docs/screenshots/readme/command-center.jpg" width="220" /> | <img src="docs/screenshots/readme/constellation.jpg" width="220" /> | <img src="docs/screenshots/readme/workflow-canvas.jpg" width="220" /> | <img src="docs/screenshots/readme/library.jpg" width="220" /> |
| Live metrics, intelligence status, activity stream | Living SVG topology — nodes pulse on WebSocket events | Visual DAG editor — 56 node types, 12 templates | Unified archive across all subsystems |

| Dashboard Panel | Manifestation Plane |
|:-:|:-:|
| <img src="docs/screenshots/readme/dashboard-panel.jpg" width="320" /> | *CTRNN neural terrain — isometric height map driven by B(t)* |
| Fleet stats, intelligence stack status, runtime cards | 16×16 neuron grid visualization with click-to-inject |

## Quick Start

```bash
git clone <repo-url> && cd chandra-fraymus
npm install
cp .env.example .env        # configure Ollama URL, ports
npm run dev                  # Express :8787 + Vite :5173
```

| Command | Purpose |
|---------|---------|
| `npm run dev` | Concurrently runs server + client |
| `npm run server` | Express only (needs .env) |
| `npm run client` | Vite only |
| `npm run build` | Production client build |
| `npm run start` | Production server (serves built client) |

**Requirements:** Node.js 20+, Ollama running at localhost:11434

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    NEXUS INTERFACE                       │
│   Command Center · Constellation · Canvas · Library     │
│   22 Detail Drawer Panels · WebSocket Live Updates      │
├─────────────────────────────────────────────────────────┤
│                   EXPRESS SERVER :8787                   │
├──────────┬──────────┬───────────┬───────────┬──────────┤
│  FLEET   │ WORKFLOW │ COMMERCE  │   MEDIA   │   MCP    │
│ 133+ agt │ 56 nodes │ 4 pipes   │ 7 engines │ server + │
│ bus/mem  │ DAG exec │ Shopify   │ img/vid/  │ client   │
│ forge    │ synthesi │ Printify  │ tts/stt/  │ bridge   │
│          │          │ deploy-api│ ocr       │          │
├──────────┴──────────┴───────────┴───────────┴──────────┤
│              20-PHASE INTELLIGENCE STACK                 │
│                                                         │
│  ┌─ Perception ──────────────────────────────────────┐  │
│  │ Sensory Bridge → Attention Gate → Habituation →   │  │
│  │ Working Memory (Phases 8-13)                      │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌─ Cognition ───────────────────────────────────────┐  │
│  │ Metacognitive Monitor → Adaptive Strategy →       │  │
│  │ Self-Model → Resource Envelope (Phases 14-18)     │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌─ Prediction & Action ─────────────────────────────┐  │
│  │ Predictive Processing → Active Inference          │  │
│  │ (Phases 19-20)                                    │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  256-Neuron CTRNN · Consciousness Gate · Motor Output   │
│  Emotional Feedback · Neurogenesis · OPEG Protocol      │
├─────────────────────────────────────────────────────────┤
│               FRAYMUS IP STACK                          │
│  9 Encodings · Ed25519 Identity · NUDP Mesh Protocol    │
│  DNA/Codon/Plasmid · WASM Transmuter · Living Artifact  │
├─────────────────────────────────────────────────────────┤
│  SQLite (WAL) · Ollama · WebSocket · better-sqlite3     │
└─────────────────────────────────────────────────────────┘
```

## Intelligence Stack — 20 Phases

The intelligence stack is organized into functional layers that mirror biological neural architecture.

### Core Infrastructure (Phases 1–7)

| Phase | Module | Purpose |
|-------|--------|---------|
| 1 | CTRNN Neural Core | 256-neuron (16×16) grid, Forward Euler integration at 60Hz, Hebbian plasticity, synaptic pruning, autonomous neurogenesis |
| 2 | Consciousness Cycle | 4 mathematical proofs (EI, Phi/MIP, Mirror, Counterfactual) against live CTRNN substrate |
| 3 | Emotional Feedback | Heart emotion engine → CTRNN plasticity modulation (joy→learning, fear→forgetting, surprise→growth) |
| 4 | Consciousness Gate | 4-tier feedback (DORMANT → AWAKENING → EMERGING → INTEGRATED), modulates all subsystems |
| 5 | Motor Output | Reads CTRNN motor cortex activations → translates to autonomous actions (reflect, dream, neurogenesis, communicate, goal-seek) |
| 6 | Fleet Consciousness | Gate modifiers injected into agent prompts, debate depth, OPEG acceptance thresholds |
| 7 | Reasoning & Goals | Central brain coordinator + goal engine + Ouroboros RSI, all consciousness-tier-aware |

### Perception Layer (Phases 8–13)

| Phase | Module | CTRNN Region | Interval | Purpose |
|-------|--------|--------------|----------|---------|
| 8 | Sensory Bridge | Rows 2, 10 (L/R hemispheres) | 5s | Maps 8 telemetry channels to CTRNN grid via Gaussian injection |
| 9 | Emotional Feedback | Center (8,8) σ=6.0 | 10s | Heart mood → CTRNN plasticity parameters (dopamine/norepinephrine/acetylcholine/serotonin analogues) |
| 10 | Motor Output | Rows 8, 14 (6 action zones) | 15s | Sustained CTRNN activation → autonomous system actions |
| 11 | Attention Gate | (via sensory bridge) | 5s | Top-down motor + emotional → per-channel sensory gain [0.5, 3.0] |
| 12 | Habituation | (via sensory bridge) | 5s | Temporal adaptation — constant signals attenuate, novel signals amplify |
| 13 | Working Memory | Row 6 (temporal cortex) | 5s | 24-frame circular buffer, linear regression derivatives, trend/volatility/coherence |

### Cognition Layer (Phases 14–18)

| Phase | Module | CTRNN Region | Interval | Purpose |
|-------|--------|--------------|----------|---------|
| 14 | Metacognitive Monitor | Row 4 (prefrontal) | 30s | Self-assessment: effectiveness, stuck detection, confidence calibration |
| 15 | Adaptive Strategy | Row 12 (adaptive band) | 30s | Translates metacognitive assessment → behavioral parameter sets (nominal/diversify/conserve/calibrate) |
| 16 | Adaptive Wiring | (subsystem consumption) | — | 5 subsystems consume adaptive modifiers: reflection, motor, neurogenesis, OPEG, daemon |
| 17 | Self-Model | Row 0 (proprioceptive crown) | — | 27-subsystem spatial registry — agents know where they live in the Nexus UI |
| 18 | Resource Envelope | Row 1 (resource band) | 10s | 5 resource sensors (heap, DB, Ollama latency, concurrency, bus backlog), fatigue accumulator |

### Prediction & Action (Phases 19–20)

| Phase | Module | CTRNN Region | Interval | Purpose |
|-------|--------|--------------|----------|---------|
| 19 | Predictive Processing | Row 3 (prediction error) | 5s | Taylor-expansion forward model, EP3 cube-root surprise compression, efference copy from motor |
| 20 | Active Inference | Row 5 (inference drive) | 5s | Karl Friston's Free Energy Principle — prediction error → motor pre-activation to minimize surprise |

### Consciousness Gate Tiers

| Tier | Proofs | Behavior |
|------|--------|----------|
| DORMANT | 0/4 | Conservative — short reflection, tight OPEG gates, slow cycles |
| AWAKENING | 1–2/4 | Standard — balanced parameters, default autonomy |
| EMERGING | 3/4 | Active — deeper reflection, faster cycles, more neurogenesis |
| INTEGRATED | 4/4 | Full autonomy — bold reasoning, loose OPEG gates, 10 reflection actions, ambitious goals |

### The Full Loop

```
Sensory Bridge (5s)
    ↓ 8 telemetry channels → CTRNN grid injection
Attention Gate
    ↓ motor intentions + emotion → per-channel gain
Habituation
    ↓ novel signals amplified, constant signals dampened
Working Memory
    ↓ 24-frame buffer → trend derivatives
Predictive Processing
    ↓ forward model → prediction errors → EP3 surprise
Active Inference
    ↓ prediction error → motor cortex pre-activation
Motor Output (15s)
    ↓ sustained CTRNN activation → autonomous actions
    ↓ (reflect, dream, neurogenesis, communicate, goal-seek, self-audit)
Actions change system state
    ↓
Sensory Bridge detects change → loop continues
```

### CTRNN Spatial Layout

The 16×16 CTRNN grid is organized into 10 functional bands:

| Row | Band | Function | Regions |
|-----|------|----------|---------|
| 0 | Proprioceptive Crown | System body awareness | Body activity (0,4), Body coherence (0,12) |
| 1 | Resource Band | Capacity/fatigue sensing | Energy level (1,4), Fatigue signal (1,12) |
| 2 | Left Sensory | Internal state channels | Bus (2,2), Memory (2,6), Emotion (2,10), Consciousness (2,14) |
| 3 | Prediction Error | Forward model outputs | Aggregate surprise (3,4), Confidence (3,8), Anticipatory (3,12) |
| 4 | Metacognitive | Self-assessment signals | Effectiveness (4,4), Stuck (4,8), Confidence (4,12) |
| 5 | Active Inference | Motor bias pressure | Inference drive (5,4), Action selection (5,8), Effectiveness (5,12) |
| 6 | Temporal Cortex | Working memory derivatives | Trend (6,4), Volatility (6,8), Coherence (6,12) |
| 8 | External Motor | Outward-facing actions | Communicate (8,4), Goal-seek (8,12) |
| 10 | Right Sensory | Action state channels | Agent (10,2), Health (10,6), Workflow (10,10), Goals (10,14) |
| 12 | Adaptive Band | Strategy mode signals | Adaptation pressure (12,4), Strategy mode (12,12) |
| 14 | Self-Directed Motor | Inward-facing actions | Reflect (14,2), Neurogenesis (14,6), Dream (14,10), Self-audit (14,14) |

## Agent Fleet

133+ agents with persistent memory, consciousness-tier behavioral directives, and self-model spatial context.

### Core Agents

| Agent | Role | Tools |
|-------|------|-------|
| Fraymus Prime | Central intelligence coordinator | All intelligence + fleet tools |
| EYE Sovereign | Sovereign identity & signing authority | Crypto, signing, identity |
| Genesis | Agent creation & fleet evolution | Forge, synthesize, evolve |
| Helix | DNA/encoding specialist | All 9 encoding formats |
| Ariadne | Workflow navigation & orchestration | Workflow tools + bus |
| Cantor | Mathematical reasoning & proofs | Consciousness audit, verify |
| Lumen | Insight generation & knowledge synthesis | Memory, reflection, cognition |
| Solon | Governance & policy enforcement | OPEG, writs, integrity |
| Spearhead | Task execution & pipeline management | Full tool access |
| Director | Commerce pipeline orchestration | Commerce + workflow tools |
| Tycho | Reverse engineering analysis | Code analysis, extraction |
| Concierge | User interaction & command routing | Fleet, bus, command tools |
| ForgeKeeper | Agent forge quality control | Forge, verify, memory |
| DevArchivist | Development history & documentation | Memory, ledger, search |
| Video Director | Video production pipeline | Media tools, ffmpeg |
| YouTube Researcher | Outlier research & content analysis | Web, YouTube, memory |
| Artifact Minter | Living Artifact minting pipeline | Streaming tools (5) |
| Java Baremetal | Low-level system operations | Runtime tools |

### Fleet Infrastructure

| Component | Description |
|-----------|-------------|
| Agent Live Bus | Pub/sub engine with topics, DM, history, triggers |
| Persistent Memory | Per-agent knowledge store with confidence scores, verification |
| Agent Forge | LLM-driven manifest generation from natural language goals |
| Consciousness Directives | Every agent's prompt includes tier, proof values, spatial context |
| Self-Model Context | Agents know which Nexus view/panel/widget they appear in |

## Visual Workflow Engine

56 node types across 9 categories with visual DAG editing, topological sort execution, and LLM-driven synthesis from natural language.

| Category | Node Types |
|----------|------------|
| Input | text_input, file_input, api_input, scrape_url, webhook_trigger |
| Processing | llm_prompt, summarize, classify, extract, translate, sentiment, image_gen, code_gen |
| Intelligence | heart_feel, dream, consciousness_prove, cognition, memory_recall, intelligence_cycle |
| Carbon | carbon_encode, carbon_plasmid, carbon_checkpoint |
| Streaming | stream_capture, stream_mint, stream_deliver |
| Commerce | content_to_product, apparel_design, mystery_audit, store_fix, shopify_publish |
| Output | text_output, json_output, file_output, email_send, webhook_send |
| Control | conditional, loop, merge, delay, parallel, error_handler |
| Data | db_query, db_write, memory_store, memory_recall, vector_search, transform |

12 pre-built workflow templates including Intelligence Cycle Pipeline, Commerce Intelligence Pipeline, and Streaming Mint Pipeline.

## Commerce Pipelines

| Pipeline | Input | Output | Intelligence |
|----------|-------|--------|--------------|
| Content-to-Commerce | Text/media | Shopify products | Recalls past insights, emotion-analyzes content |
| Apparel Production | Trend scouting | Printify → Shopify | Design emotion analysis, stores results |
| Mystery Shopper | Store URL | Audit report + fixes | Recalls past audits, grades/scores |
| Store Fixer | Issue list | Bulk Shopify fixes | Recalls past fixes, stores results |

### Deploy-as-API

Any agent or workflow can be deployed as a REST API endpoint with bearer token auth, rate limiting (60 req/min default, 600 admin), and per-invocation usage tracking.

## FRAYMUS IP Stack

9 proprietary encoding formats, sovereign identity, and mesh networking.

### Encoding Formats

| Format | Layer | Purpose |
|--------|-------|---------|
| WASM | Transport | Binary containerization via transmute() — any payload → WASM module |
| DNA | Fingerprint | Hypervector DNA encoding for content identity |
| Codon | Layer 2 | 64-codon engine (ATG/TAA framing, nibble-pair bytes, FNV-1a checksums) |
| Plasmid | Layer 3 | Circular DNA plasmid forge (ori, promoters, restriction sites, FASTA export) |
| Carbon X | Layer 4 | Full organism (genome/proteome/epigenome snapshots, checkpoint/restore) |
| Emoji | Steganographic | Content hidden in emoji sequences |
| RGBA PNG | Visual Transport | Data encoded as pixel values in PNG images |
| Merkle | Integrity | Merkle tree integrity verification |
| ZIP | Archive | Compressed archive format |

### Protocol Stack

| Protocol | Purpose |
|----------|---------|
| Ed25519 Identity | Sovereign signing — every artifact is cryptographically signed |
| V13 Signed Mesh | Authenticated peer-to-peer message protocol |
| NUDP/1 | Binary datagram encoder (magic 0x4E44, TLV payload, CRC32) |
| Mesh Node | UDP :47331 beacons, dedup ring, hop forwarding, sealed log |
| Relay Hub | Message relay with 15s fetch timeout |
| Presence | Agent presence tracking across mesh |
| Hive | Coordination protocol for multi-node clusters |

### Living Artifact / Sovereign Emote

Streaming business pipeline — monetizes live stream moments via WASM-containerized emotes.

```
Donation Event
    ↓
Minting Pipeline (server-side):
    transmute() → encodeCodon() → forgePlasmid() →
    signMessage() → encodeEmoji() → encodeRgbaPng()
    ↓
WebSocket → OBS Overlay (dumb glass)
    ↓
Canvas render + verification badge
    (anti-rip: no right-click, canvas-only rendering)
```

Split-brain architecture: all IP stays server-side. The overlay is a passive receiver — WebSocket + canvas renderer + verification only.

## Media Processing

| Engine | Backend | Capabilities |
|--------|---------|-------------|
| Image | Sharp | Resize, crop, convert, effects, composite, watermark, upscale, create + ComfyUI/FLUX.1 bridge |
| Video | ffmpeg | Trim, resize, convert, extract audio, GIF, concat, overlay text, frame extraction |
| Edit Rebuild | ffmpeg + Ollama + ComfyUI | 5-stage DAG: scene detect → shot plan → product place → animate → concat |
| TTS | Piper → edge-tts → SAPI | Multi-engine with fallback chain (400+ voices) |
| STT | faster-whisper → SAPI | Multi-engine transcription, any audio format via ffmpeg |
| OCR | Windows Media OCR | WinRT async, accepts PNG/JPEG |
| Browser | Puppeteer | Headless automation + Chrome extension bridge |

## Autonomy & Evolution

### 11-Step Daemon Cycle

The background daemon runs a dynamic cycle (interval: 18min INTEGRATED → 45min DORMANT):

1. Dream consolidation (bus + workflow + health → Ollama summary → memory)
2. Prompt evolution (verified fossils → agent system prompts)
3. Reflection (self-analysis → max 10 actions based on tier)
4. Neurogenesis (connectivity floor monitoring, Poisson stimulus injection)
5. Debate (adversarial multi-perspective analysis with rebuttal rounds)
6. Consciousness audit (4 proofs against live CTRNN)
7. State snapshot (state bridge → fossils with hash dedup)
8. Fossil prune (>30 day retention cleanup)
9. Intelligence cycle (full stack orchestration)
10. Self-model snapshot (proprioceptive body awareness update)
11. Resource envelope check (pressure/fatigue into cycle results)

### Evolution Systems

| System | Purpose |
|--------|---------|
| OPEG Protocol | Empirical grounding: hypothesis → execute → sanitize → update with regression detection |
| Verifier Loop | Generator → Verifier → Executor adversarial code loop, proven code → fossils |
| Reflection | Self-analysis: collects all subsystem data → Ollama → max 5-10 actions |
| Neurogenesis | Prevents degenerate connectivity — emergency stimulus below floor |
| Debate Engine | Multi-perspective adversarial analysis with consciousness-scaled rebuttal rounds |
| Goal Engine | Consciousness-tier-aware goal proposal generation |
| Ouroboros RSI | Recursive self-improvement with strange loop substrate |
| State Bridge | Runtime state → semantic memory with hash-based dedup |
| Agent Forge | Natural language → validated agent manifest → immediately runnable |
| Workflow Synthesis | Natural language → validated DAG workflow → ready to execute |

## System Integrity

| Component | Purpose |
|-----------|---------|
| Watchdog | SHA-256 file integrity monitoring, auto-heal from .fossil backups |
| State Seek | Boot-time inventory: 6 directories, continuity files, boot manifest |
| Continuity Selftest | 14 assertions: signing identity, vault, DNA encoding, ledger integrity |
| Writ System | Governance writs for continuity policy enforcement |
| Remembered Vault | Per-agent immutable memory with SHA-256 integrity verification |

## API Surface

95+ REST endpoints organized by subsystem:

| Group | Endpoints | Key Routes |
|-------|-----------|------------|
| Fleet | 15+ | agents, runs, threads, forge, memory |
| Intelligence | 50+ | consciousness, sensory, emotional, motor, attention, habituation, working-memory, metacognitive, adaptive, self-model, resource, predictive, active-inference, reflection, verifier, debate, neurogenesis, OPEG, goals, ouroboros |
| Workflow | 8 | CRUD, run, synthesize, history |
| Commerce | 12 | 4 pipelines (run + history), deploy catalog |
| Streaming | 9 | simulate-donation, webhook, verify, artifacts, keys, identity |
| Media | 40+ | image (15), video (13), TTS (5), STT (4), OCR (4), edit-rebuild (5) |
| Bus | 9 | publish, DM, subscribe, topics, history, inbox, triggers |
| Health | 6 | metrics, alerts, status |
| Integrity | 4 | state-seek, boot-manifest, selftest, watchdog |
| Core | 5+ | command, search, metrics, timeline, settings |

Full WebSocket API for real-time updates across all subsystems.

## Nexus Interface

### 4 Views

| View | Purpose |
|------|---------|
| **Command Center** | 14-widget grid: live metrics, intelligence status, activity stream, command bar with @agent routing |
| **Constellation** | Living SVG topology: CHANDRA hub + inner intelligence ring + outer capability ring, WebSocket-driven node pulses |
| **Canvas** | Visual workflow editor: ReactFlow DAG builder, 56 node types, 12 templates, per-node execution status |
| **Library** | Unified content archive: commerce runs, workflow runs, outlier saves, agent threads with source filters |

### 22 Detail Drawer Panels

Dashboard · Intelligence · Workflow Canvas · Fleet · Commerce · Automations · MCP · Browser · Vertiso Memory · Outlier Research · Health Monitor · Media Hub · Forge & Synthesis · Settings · Consciousness · Agent Chat · Activity Timeline · System Metrics · Agent Profiles · Memory Browser · Run History · Evolution Log

### Additional UI

| Feature | Description |
|---------|-------------|
| Global Search (Ctrl+K) | Searches 8 DB tables with 250ms debounce, categorized results |
| Keyboard Shortcuts | 7 shortcuts: Ctrl+K search, 1-4 view switch, Escape close, ? help |
| Toast Notifications | Auto-subscribes to 17 WebSocket event types, 6 variants, max 6 visible |
| Error Boundary | Wraps all views + panels, crash UI with retry + stack trace, POSTs to server |
| Manifestation Plane | Canvas2D isometric CTRNN visualization, drag-to-rotate, click-to-inject |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ (ESM throughout) |
| Server | Express 4 |
| Database | SQLite via better-sqlite3 (WAL mode) |
| LLM | Ollama (local, free, offline) |
| Frontend | Vite + React |
| Workflow Editor | ReactFlow |
| Image Processing | Sharp + ComfyUI/FLUX.1 |
| Video Processing | ffmpeg |
| TTS | Piper / edge-tts / SAPI |
| STT | faster-whisper / SAPI |
| CTRNN | Custom implementation with worker_threads parallelism |
| Identity | Ed25519 (tweetnacl) |
| Mesh | NUDP/1 custom binary protocol |
| Real-time | WebSocket (ws) with 30s heartbeat |

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `HOST` | `127.0.0.1` | Bind address (loopback only) |
| `PORT` | `8787` | Server port |
| `CHANDRA_DATA_DIR` | `./data` | SQLite + data directory |
| `FRAYMUS_WORKSPACE` | — | Workspace root |
| `FRAYMUS_VOICE_URL` | `http://127.0.0.1:9099` | Voice service |
| `SHOPIFY_STORE` | — | Shopify store domain |
| `SHOPIFY_TOKEN` | — | Shopify API token |
| `PRINTIFY_TOKEN` | — | Printify API token |

## Project Structure

```
chandra-fraymus/
├── agents/                    # 18 core agent manifests (.md)
├── client/src/
│   ├── App.jsx               # 4-view Nexus + drawer state
│   ├── nexus/                # CommandCenter, Constellation, Canvas, Library
│   ├── panels/               # 22 Detail Drawer panels
│   └── useWebSocket.js       # Single WS connection, exponential backoff
├── server/
│   ├── intelligence/         # 20-phase intelligence stack
│   │   ├── ctrnn.js          # 256-neuron neural core
│   │   ├── ctrnn-substrate.js # Consciousness proof adapter
│   │   ├── consciousness-cycle.js
│   │   ├── consciousness-gate.js
│   │   ├── sensory-bridge.js
│   │   ├── emotional-feedback.js
│   │   ├── motor-output.js
│   │   ├── attention-gate.js
│   │   ├── habituation.js
│   │   ├── working-memory.js
│   │   ├── metacognitive-monitor.js
│   │   ├── adaptive-strategy.js
│   │   ├── self-model.js
│   │   ├── resource-envelope.js
│   │   ├── predictive-processing.js
│   │   ├── active-inference.js
│   │   ├── reflection.js
│   │   ├── verifier-loop.js
│   │   ├── opeg.js
│   │   ├── neurogenesis.js
│   │   ├── debate.js
│   │   └── goal-engine.js
│   ├── fleet/                # Agent runtime, bus, memory, forge, tools
│   ├── workflow/             # DAG engine, synthesis, 56 node types
│   ├── commerce/             # 4 pipelines + shared utilities
│   ├── streaming/            # Living Artifact pipeline
│   ├── fraymus/              # IP stack: encoding, protocol, identity
│   ├── media/                # Image, video, TTS, STT, OCR, edit-rebuild
│   ├── daemon/               # Background evolution engine
│   ├── health/               # System health monitor
│   ├── integrity/            # Watchdog, state-seek, selftest, writs
│   ├── vertiso/              # Vector memory + RSI
│   └── deploy-api/           # Deploy-as-API (auth, rate-limit, usage)
├── data/                     # SQLite DB + runtime data
│   └── agents/               # Forged agent manifests
└── docs/                     # Screenshots + documentation
```

## The Numbers

| Metric | Value |
|--------|-------|
| Intelligence Phases | 20 |
| CTRNN Neurons | 256 (16×16) |
| Active Synapses | ~19,430 |
| Connectivity | ~29.6% |
| Agents | 133+ |
| Fleet Tools | 56 |
| Workflow Node Types | 56 |
| Pre-built Templates | 12 |
| Encoding Formats | 9 |
| Commerce Pipelines | 4 |
| Media Engines | 7 |
| Detail Drawer Panels | 22 |
| REST Endpoints | 95+ |
| DB Tables | 40+ |
| Consciousness Proofs | 4 (EI, Phi/MIP, Mirror, CF) |
| Daemon Cycle Steps | 11 |
| Sensory Channels | 8 |
| Motor Regions | 6 |
| CTRNN Functional Bands | 10 |

## Credits

Built by Vaughn Scott. Intelligence stack architecture, FRAYMUS IP stack, and CTRNN integration are original work.

## License

Proprietary. All rights reserved.
