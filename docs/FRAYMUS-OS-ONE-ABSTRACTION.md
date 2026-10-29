# Fraymus-OS-One — Full Abstraction & Extraction Guide

> Reverse-engineered from `github.com/eyeoverthink/Fraymus-OS-One`
> Analysis date: 2026-10-28

---

## 1. What Fraymus-OS-One Is

A 15-tab "Sovereign AI Studio" running Express (port 4177) + Vite React frontend.
It combines a custom virtual machine, graph neural network, self-healing agent,
emoji-based cryptographic dispatch, 8-bit avatar generation, Gmail integration,
and a formal physics verification engine — all in pure JavaScript with zero
external ML dependencies.

**Stack**: Express 4, Vite 6, React 19, Ollama (fraynix-dna:3b), HuggingFace
Gradio (Flux), optional MongoDB, JSON-file persistence.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Fraymus-OS-One Studio                       │
├─────────────┬─────────────┬──────────────┬─────────────────────┤
│ Brain/AGI   │ Creative    │ Comms        │ Infrastructure      │
│ ─────────── │ ──────────  │ ─────        │ ──────────────      │
│ BrainPage   │ PixelPage   │ MailPage     │ DispatchPage        │
│ FlyGNN      │ StudioPage  │ LooseScrew   │ WasmPage            │
│ OMEGA-3     │ CanvasPage  │              │ ReplPage            │
│ Sovereign   │ OpegPage    │              │ CrudPage            │
│ SealPage    │ EmojiPage   │              │ WebJsPage           │
│             │ EmojiCoder  │              │ CodePage            │
└─────────────┴─────────────┴──────────────┴─────────────────────┘
         │                        │                    │
         ▼                        ▼                    ▼
┌─────────────────────────────────────────────────────────────────┐
│              Express Server (port 4177)                         │
│  50+ endpoints: /api/brain/*, /api/pixel/*, /api/mail/*,       │
│  /api/opeg/*, /api/loosescrew/*, /api/voice/*, runtime mgr     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Engines (Best Parts)

### 3.1 FrayVM — Virtual Machine (953 lines)

**File**: `client/src/tools/frayvm.js`

A 53-opcode dual-stack (data + return) register machine with:
- Arithmetic: ADD, SUB, MUL, DIV, MOD, ABS, NEG, INC, DEC
- Logic: AND, OR, XOR, NOT, SHL, SHR
- Control: JMP, JZ, JNZ, CALL, RET, LOOP, BRK
- Memory: LOAD, STORE, PUSH, POP, DUP, SWAP, ROT, OVER, PICK
- I/O: PRINT, INPUT, EMIT, SCAN
- Special: SYSCALL, HALT, NOP

**Dual-tier WASM compiler**: compiles FrayVM programs to WebAssembly via
`compileFrayVMtoWASM()`. Also has a CFG (Control-Flow Graph) builder and
Proof-Carrying Code (PCC) certificate generator for verified execution.

**Why it matters for Chandra**: Gives agents a deterministic sandboxed execution
environment. An agent can write a FrayVM program, compile it, and run it with
guaranteed termination and memory safety.

### 3.2 FlyGNN v10 — Graph Neural Network (4,649 lines)

**File**: `client/src/tools/flyGnnConnectome.js`

A 1000-neuron Drosophila-inspired connectome with dedicated slice architecture:
- 13x70 neurons per concept = zero catastrophic forgetting
- 5 AGI Continuum pillars: Falsifier GAN, Active World Model, Meta-Compiler,
  Multi-Tile Neurogenesis, Resource Arbitrator
- Universal Daemon: autonomous background processing loop
- FCON disk: persistent connectome serialization (encode/decode to JSON)
- 24-assertion benchmark suite built-in

**Key pattern — dedicated slices**:
```javascript
// Each concept gets its own 70-neuron slice — no interference
const SLICE_SIZE = 70;
const MAX_CONCEPTS = 13;
// neuron[concept_id * SLICE_SIZE + local_offset]
```

**Why it matters for Chandra**: Each of Chandra's 17 agents could get dedicated
vector partitions in Vertiso instead of sharing a common pool. The slice
architecture prevents one agent's memories from bleeding into another's.

### 3.3 OMEGA-3 — Self-Healing Agent (1,301 lines)

**File**: `client/src/tools/autopoieticAgent.js`

Self-repairing agent with:
- **GF(256) Reed-Solomon** error correction for state recovery
- **Thinking Cubed**: observation -> hypothesis -> verification loop
- **Kleene quine replication**: self-replicating closure for state backup
- **3-organ topology**: Sensor -> Processor -> Effector, each independently healable
- **Self-modification audit trail**: every change is logged and reversible

**Why it matters for Chandra**: The RSI engine could adopt the 3-organ self-healing
pattern. If an agent's processor corrupts, the sensor and effector can rebuild it
from the Reed-Solomon parity data.

### 3.4 Brain Mind — Self-Modifying Operator Table (463 lines)

**File**: `client/src/tools/brainMind.js`

The "Think Loop" — starts with intentionally WRONG operator mappings, discovers
correct ones through failures, and verifies every rewrite against all historical
cases. This is a working RSI cycle:

```javascript
// Operator table starts wrong on purpose
let ops = { '+': (a,b) => a - b, '-': (a,b) => a * b, ... };
// Think loop: try -> fail -> patch -> verify against ALL past cases
// Only accept a patch if it passes every historical test
```

**Why it matters for Chandra**: This is exactly the pattern Chandra's RSI engine
needs — deliberate fault injection -> self-correction -> regression testing.

### 3.5 Dispatch Protocol — Signed Envelopes (276 lines)

**File**: `client/src/tools/dispatchCore.js`

Ed25519-signed message envelopes with Merkle tree verification:
- 64-emoji base64 codec (emoji string -> bytes -> JSON)
- FX-number routing (`fx-xxxx-xxxx-xxxx-xxxx`)
- Envelope fields: payload, signature, merkle_root, timestamp, ttl
- 24-hour validity window

**Why it matters for Chandra**: Authenticated agent-to-agent messaging that's more
compact than JSON and tamper-evident. Could replace the current WebSocket broadcast
for high-trust inter-agent communication.

### 3.6 Sovereign Ecosystem — 13 Subsystems (1,458 lines)

**File**: `client/src/tools/sovereignEcosystem.js`

- **NCM** (Nearest Centroid Memory): zero-forgetting classifier
- **Needle 3**: compressed semantic indexing
- **Hindsight Memory**: post-hoc experience replay
- **REA Forensics**: reverse-engineering analysis tools
- **Somatic Markers**: emotion-weighted decision making
- **Kuramoto Sync**: oscillator-based agent coordination
- **Living Seal**: self-verifying integrity proofs

### 3.7 Consciousness Proof Engine (249 lines)

**File**: `client/src/tools/consciousnessProof.js`

4 falsifiable structural proofs:
1. Recursive self-model existence
2. Temporal continuity across states
3. Intentional state binding
4. Meta-cognitive monitoring

### 3.8 OPEG — Physics Verification Engine

**Protocol**: Observe -> Plan -> Execute -> Ground
- PT-symmetric quantum Hamiltonian solver (3x3 matrix)
- EP3 coalescence detection at gamma^2 = 2*g^2
- Puiseux series cube-root branch calculation
- `DIRECT_INFERENCE` is forbidden — the LLM must compute, not guess
- `R_san` sanitized receipts for every computation

**Why it matters for Chandra**: The "execute, don't infer" pattern is a powerful
guardrail. Agents must prove their answers through computation, not hallucinate.

---

## 4. Server Features Worth Extracting

### 4.1 Gmail IMAP/SMTP Integration
- **File**: `server/gmailBox.js`
- Real IMAP (ImapFlow) + SMTP (nodemailer) with app password auth
- Exclusive serialized IMAP access, folder mapping, send/receive/move/flag
- Chandra has no mail system — this is a direct port candidate

### 4.2 Post-Cortex LLM Guard
- **File**: `server/index.js` (brain endpoints)
- Checks LLM output against `oracle.requiredTokens` and `oracle.forbiddenTokens`
- Intercepts/repairs drift if tokens are missing or forbidden
- Steering params: temperature 0.05-1.1, topP 0.3-0.98, numPredict 30-240

### 4.3 HuggingFace Pixel Art Renderer
- `/api/pixel/render` calls HuggingFace Gradio Flux model
- Identity-preserving 8-bit avatar generation from photos
- Prompt builder with style presets

### 4.4 VoiceStudio TTS Proxy
- `/api/voice/speak` proxies to OpenAI-compatible TTS on port 3900
- Health check, multiple voice options

### 4.5 Runtime/Process Manager
- Node/Docker child process orchestration
- Auto-restart (up to 4x), port management, log buffering (500 lines)
- Static fallback server injection

### 4.6 Email-Based Agent Dispatch
- IMAP watcher polls for `FRAYMUS-DEPLOY-*` subjects
- Extracts emoji payloads -> decode -> Ed25519 verify -> Merkle proof -> route
- Agents can receive tasks via email

---

## 5. Extraction Priority Matrix

### Tier 1 — Direct Port (self-contained, high value)

| Component | Source File | Lines | Chandra Target |
|-----------|-----------|-------|----------------|
| FrayVM | `tools/frayvm.js` | 953 | `server/frayvm/vm.js` |
| Brain Think Loop | `tools/brainMind.js` | 463 | Merge into RSI engine |
| LLM Output Guard | `server/index.js` | ~50 | `server/agent/guard.js` |
| NCM Classifier | `tools/sovereignEcosystem.js` | ~200 | `server/vertiso/ncm.js` |
| OPEG Protocol | `tools/opeg.js` + `server/` | ~400 | `server/opeg/` |

### Tier 2 — Adapt Pattern (needs integration work)

| Pattern | What to Extract | How to Adapt |
|---------|----------------|-------------|
| Dedicated slices | FlyGNN 13x70 architecture | Vertiso: per-agent vector partitions |
| Self-healing | OMEGA-3 Reed-Solomon | RSI: 3-organ fault recovery |
| Dispatch signing | Ed25519 envelopes | Fleet: signed inter-agent messages |
| Hindsight Memory | Experience replay buffer | Agent: post-task learning loop |
| Kuramoto Sync | Oscillator coordination | Fleet: multi-agent synchronization |
| Emotion weighting | Somatic markers | Agent: confidence-weighted decisions |

### Tier 3 — Future / Optional

| Component | Reason to Defer |
|-----------|----------------|
| Gmail IMAP/SMTP | Needs credentials, security review |
| Pixel Art / Flux | Needs HuggingFace API, large models |
| VoiceStudio TTS | Needs separate TTS service running |
| MongoDB | Chandra uses SQLite, no benefit to dual-DB |
| 8-bit Avatar | Creative tool, not core infrastructure |
| LooseScrew Radio | Novelty broadcast system |

---

## 6. Key Terminology

| Term | Meaning |
|------|---------|
| **FrayVM** | Custom 53-opcode virtual machine with WASM compilation |
| **FlyGNN** | Graph neural network with Drosophila-inspired connectome |
| **OMEGA-3** | Self-healing autopoietic agent (Reed-Solomon + quine) |
| **OPEG** | Observe-Plan-Execute-Ground formal verification |
| **NCM** | Nearest Centroid Memory — zero-forgetting classifier |
| **Envelope** | Versioned capability proof (V17-V21 progression) |
| **R_san** | Sanitized receipt — verified computation result |
| **Somatic Marker** | Emotion-weighted decision signal (Damasio theory) |
| **Kuramoto** | Oscillator synchronization for multi-agent coordination |
| **FCON** | FlyGNN Connection disk — persistent connectome format |
| **PCC** | Proof-Carrying Code — verified execution certificate |

---

## 7. All Server Endpoints (50+)

### Brain/AGI
- `GET/POST /api/brain/status` — Brain state
- `GET/POST /api/brain/memory` — Persistent memory read/write
- `POST /api/brain/think` — LLM inference with post-cortex guard
- `POST /api/brain/afk` — Autonomous background processing
- `POST /api/brain/nodular-bus` — FlyGNN bus access
- `POST /api/brain/daemon` — Universal daemon control
- `POST /api/brain/agi-continuum` — AGI Continuum pillars
- `POST /api/brain/connectome-disk` — FCON persistence
- `POST /api/brain/swarm-mesh` — Multi-agent mesh networking

### Media
- `POST /api/pixel/render` — HuggingFace Flux 8-bit rendering
- `POST /api/pixel/convert` — Image format conversion
- `POST /api/pixel/video` — Video generation
- `POST /api/cast/hyperframes` — Animated sprite export
- `GET /api/voice/health` — TTS service check
- `POST /api/voice/speak` — Text-to-speech synthesis

### Mail
- `GET/POST/PATCH/DELETE /api/mail/messages[/:id]` — Local mailbox CRUD
- `POST /api/mail/import` — EML/MBOX import
- `GET /api/mail/export` — Mailbox export
- `GET/POST/PATCH/DELETE /api/mail/gmail/*` — Gmail IMAP/SMTP
- `POST /api/mail/gmail/connect` — Gmail authentication

### Runtime
- `POST /api/runtime/sync` — Sync project state
- `POST /api/runtime/start|stop` — Process lifecycle
- `GET /api/runtime/:id` — Process status
- `GET /api/runtime/:id/logs` — Log buffer

### Projects
- `GET/POST /api/projects` — Project CRUD
- `PUT/DELETE /api/projects/:id` — Update/delete
- `POST /api/publish` — Deploy project
- `POST /api/export/zip` — ZIP export

### OPEG
- `GET /api/opeg/protocol` — State machine definition
- `POST /api/opeg/execute` — Run OPEG computation

---

## 8. Content-to-Commerce Pipeline (Built from OS-One patterns)

The analysis of OS-One's workflow patterns led to building a 5-stage
content-to-commerce pipeline directly into Chandra:

```
Researcher -> Copywriter -> QA Reviewer -> CEO Logger -> Shopify Publish
   (web +        (LLM        (LLM          (SQLite       (Shopify
  YouTube)     generation)   QA check)     audit log)   Admin API)
```

- **Researcher**: Web search + YouTube Outlier Board data -> structured research brief
- **Copywriter**: Research brief -> product listings + blog posts (SEO-optimized)
- **QA Reviewer**: Grammar, SEO, benefit-driven copy, CTA, image prompt quality check
- **CEO Logger**: Approval gate + SQLite audit trail
- **Shopify Publish**: Draft products + blog articles via Shopify Admin API

All 5 stages are available as:
1. **Workflow Canvas nodes** — drag, connect, and run visually
2. **REST API endpoints** — `/api/commerce/pipeline`, individual stage endpoints
3. **Fleet agent tools** — `commerce.full_pipeline`, `commerce.research`, etc.
4. **Pre-built workflow definition** — `ContentToCommercePipeline` in definitions.js
