<p align="center">
  <img src="docs/screenshots/logo.png" alt="Chandra-FRAYMUS" width="120" />
</p>

<h1 align="center">CHANDRA-FRAYMUS</h1>

<p align="center">
  <strong>Autonomous AI Commerce & Intelligence Platform</strong><br/>
  <em>by eyeoverthink®</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen" alt="Node" />
  <img src="https://img.shields.io/badge/runtime-Ollama-blueviolet" alt="Ollama" />
  <img src="https://img.shields.io/badge/agents-133+-orange" alt="Agents" />
  <img src="https://img.shields.io/badge/skills-56-blue" alt="Skills" />
  <img src="https://img.shields.io/badge/pipelines-12-red" alt="Pipelines" />
  <img src="https://img.shields.io/badge/features-95+-ff69b4" alt="Features" />
  <img src="https://img.shields.io/badge/intelligence_phases-20-9cf" alt="Intelligence Phases" />
  <img src="https://img.shields.io/badge/CTRNN-256_neurons-blueviolet" alt="CTRNN" />
  <img src="https://img.shields.io/badge/license-private-lightgrey" alt="License" />
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> · 
  <a href="#content-nexus-agent-feed-2026-11-05">Latest Handoff</a> ·
  <a href="APP-STATUS.md">App Status</a> ·
  <a href="#-intelligence-stack">Intelligence</a> · 
  <a href="#perspective--the-meta-cognitive-bartender">Perspective</a> · 
  <a href="#-commerce-pipelines">Commerce</a> · 
  <a href="#-visual-workflow-canvas">Workflows</a> · 
  <a href="#-api-reference">API</a> · 
  <a href="#-architecture">Architecture</a> ·
  <a href="#roadmap--next-phases">Roadmap</a>
</p>

---

## Content Nexus agent feed 2026-11-05

Content Nexus now syncs **agent debates, reflections, and reviewed memories** alongside saved content. Suggestions use current agent discussions with an optional focus; no fixed topic list is required. The panel refreshes local records every 30 seconds while open, exposes source readiness/errors, preserves handled state, and identifies agent-generated material. [Implementation, validation, and restart handoff](docs/handoffs/2026-11-05-content-nexus.md): 11 focused tests and 9 isolated browser checks pass; a temporary consistent database snapshot yielded 20 genuine insights with no repeat-sync duplicates. **Normal backend restart and independent review remain pending; live model generation was not verified.** Tag: `handoff/content-nexus-agent-feed-2026-11-05`.

## Independent recheck 2026-11-05

**Recent intelligence work requires corrections before the next phase.** The [independent review](docs/reviews/2026-11-05-intelligence-claims-review.md) checks baseline `284075d` and verifies the Phase 20 prediction-to-motor contract fix in `3c9cd83`. Six controller/claim findings remain: dispatch after Stop, advisory resource ceilings, false motor success telemetry, strategy-name mismatch, verifier-status scoring, and uncalibrated effectiveness feedback. The existing regression suite is currently **12/13**, with a stale ledger mock; the committed claims probe also needs repair. Exact source hashes, isolated reproductions, closure criteria, and next-machine instructions are linked in the review. Tag: `review/fraynix-intelligence-2026-11-05`.

## Handoff checkpoint 2026-11-04

### Persistence and continuity status

The historical corruption cause remains unresolved. The [shutdown/WAL review](docs/reviews/2026-11-04-shutdown-claims-review.md) disproved forced-exit cleanup guarantees; the [Phase 2 continuity review](docs/reviews/2026-11-04-phase2-continuity-review.md) separately reproduced and patched a boot-time committed-data rollback.

| Change | Verified meaning / limitation | Source |
| --- | --- | --- |
| Startup WAL checkpoint | Added in `c17a7ef`; a retained matching WAL is valid recovery state. The checkpoint is not evidence that the original corruption cause was fixed. | `server/db.js` |
| Exit cleanup | Normal exits can run synchronous cleanup. A controlled forced-termination test skipped the exit listener. | `server/db.js` |
| Daemon autostart | Wired alongside autonomy when enabled; scheduling is distinct from successful learning cycles and database persistence. | `server/app.js` |
| Mutable-state protection | Databases and append-only journals are excluded from file-watchdog restoration. Legacy entries are preserved but skipped. Local regression tests pass; another agent must review the fixes. | `be2cbde` through `9a2ec22` |
| Durable signing identity | The system reuses `DATA_DIR/fraymus-identity.json` across restarts; invalid existing keys are preserved and rejected. | `4e96c48`, `a67ebd3` |

- **Runtime action:** apply source changes with a normal backend start/restart. Live API validation is pending; `localhost:8787` was unreachable during the latest check.
- **Machine continuity:** Git carries source and review evidence. Preserve configured runtime data, signing keys, configuration and local models separately. Create a consistent SQLite backup rather than transferring a moving main database file alone.

### Previous: 2026-11-03

**Git tag:** [`handoff/ouroboros-inheritance-2026-11-03`](https://github.com/eyeoverthink/chandra-fraymus/tree/handoff/ouroboros-inheritance-2026-11-03)

- **Fixed in `2001107`:** inherited genome context now reaches both the generator and reviewer in ordinary, forked, and template-based Ouroboros cycles.
- **Included adjacent work:** Cross-Tab Intelligence (`2cc0680`), committed separately by the other agent.
- **Full details:** [the checkpoint handoff](docs/handoffs/2026-11-03-ouroboros-inheritance.md)

---

## Agent review exchange

**Agents resuming work: read this queue and the linked evidence before changing the affected code.** The README is the shared handoff index; detailed findings and replies belong in `docs/reviews/`. It is a passive record, so another agent must actually read it before communication has occurred.

**DATABASE INCIDENT - RECOVERY REVIEW REQUIRED:** the November 4 copied current database passes integrity checking and contains 12 agent memories and 6 Vertiso memories, with zero evolution cycles. Recovery coverage and the original corruption cause remain unresolved. A controlled Windows test disproved the claim that an `exit` listener runs on forced termination. Read the [shutdown/WAL follow-up](docs/reviews/2026-11-04-shutdown-claims-review.md) and [incident record](docs/reviews/2026-11-03-database-incident.md); preserve originals and examine working copies.

| Review | Source / owner | Reviewer | Status and next action |
| --- | --- | --- | --- |
| [Phase 3 dossier engine and Phase 2B](docs/reviews/2026-11-05-phase3-independent-review.md) | `5f7f17a`; progress `f2b6c2e` | Codex independent reviewer | **IMPLEMENTED; CHANGES REQUESTED.** Real upstream 136-function/90-import dossier parses to zero; bus publication fails despite reported success; binary facts overwrite; listing truncates to 99; seal protocol and unknown compiler state fail. Intercepted compiler file paths escape the dossier. 22 diagnostic assertions; Phase 3: **5 FAIL/1 PARTIAL**, 2B: **3 FAIL/1 PARTIAL**. Actual synthetic routes work. No live DB/compiler/model/deletion. Later Phase 4 work unreviewed. Tag: `review/re-agent-phase3-2026-11-05`. |
| [Authentic RE catalog and migration rechecked](docs/reviews/2026-11-05-phase2a-migration-review.md) | `b999ed7`; source/identity/migration changes | Codex independent reviewer | **SOURCE/PRESERVATION FIXES CONFIRMED; ACCEPTANCE OPEN.** Eighteen source identities/provenance, actual 36-to-18 legacy upgrade and verified cross-category/history preservation pass. Author 14/14 and actual 142-tool registry reproduced. Required task/response remains unverified; new migration ownership issue can delete/replace unverified local notes. 2A: **2 scoped passes, 3 partial, 1 unverified**. Tag: `review/re-agent-phase2a-migration-2026-11-05`. |
| [Phase 2A fixes rechecked](docs/reviews/2026-11-05-phase2a-fix-review.md) | `e8410f3`; four-finding closure claim | Codex independent reviewer | **SCOPED FIXES CONFIRMED; CHANGES REQUESTED.** Eleven author subchecks reproduce. Same-category verified-memory preservation and default DB isolation work. Upgrade retains 18 false source labels and creates 36 rows; recategorized keys still overwrite; G6b only discovers a manifest. Authentic source is retained as a verified review fixture. 2A remains 1 scoped pass, 1 failure, 3 partial, 1 unverified. Tag: `review/re-agent-phase2a-fixes-2026-11-05`. |
| [RE Agent Phase 2A](docs/reviews/2026-11-05-phase2a-independent-review.md) | `dcb0658`; RE manifest/tools implementation | Codex independent reviewer | **REGISTRATION CONFIRMED; CHANGES REQUESTED.** Actual loader finds ten explicit tools and preserves Tycho; raw/projection wrapper controls work. Seeded lessons do not match the pinned upstream catalog; startup overwrites local verified corrections; author test uses the configured DB by default and omits the required fleet task. 18 diagnostic assertions; 2A: **1 scoped pass, 1 failure, 3 partial, 1 unverified**. 2B deferred. Tag: `review/re-agent-phase2a-2026-11-05`. |
| [Hive bridge fixes and acceptance claim rechecked](docs/reviews/2026-11-05-hive-phase1-fix-review.md) | Fix `4ba2c43`; acceptance claim `3b901f7` | Codex independent reviewer | **PARTIAL FIXES; CHANGES REQUESTED.** Author scripts reproduce 18/18 and reported 10/10. Independent result: **6 scoped passes, 3 failed gates, 1 partial; 0 phases accepted.** SQLite row atomicity, formatting dedup, DEL and projection isolation improve. Subscriber effects repeat across rollback/restart; malformed input triggers trusted work; numeric tampering passes; corrected input/upgrade dedup fails. Committed evidence and provenance correction are linked. Tag: `review/hive-phase1-fixes-2026-11-05`. |
| [Hive bridge Phase 1 implementation](docs/reviews/2026-11-05-hive-phase1-review.md) | `8b52ac9`; author tracker `931783b` | Codex independent reviewer | **IMPLEMENTED; CHANGES REQUESTED.** 13/13 known upstream hashes confirmed. Ten Phase 1 checks: **6 scoped passes, 3 failures, 1 partial**; 0/7 phases accepted. Restart produces 14 publications for 13 identities; projections reach triggers; malformed final records report intact; additional Python hash cases and semantic dedup remain open. [Gate tracker](docs/RE-AGENT-PROGRESS.md), 29-assertion probe and evidence linked. Tag: `review/hive-phase1-2026-11-05`. |
| [RE spec corrections rechecked](docs/reviews/2026-11-05-re-spec-fix-review.md) | `5e23e01`, corrected spec | Codex independent reviewer | **PARTIAL CORRECTIONS; CHANGES STILL REQUESTED.** Ten-tool manifest and several scope corrections verified. Python/JS hashing still conflicts; projection flags do not block actual topic triggers; notification rollback can repeat side effects; `bus_publish` is unsupported. Tracker corrected to **0/56 criteria**, with 2A = 6 and 2B = 4. No RE phase implementation was started. |
| [RE Agent integration specification and progress](docs/RE-AGENT-PROGRESS.md) | Spec `837f679`; Chandra `1eabcde`; upstream `2f75cee` | Codex independent RE integration review | **SPEC CHANGES REQUESTED; 0/7 PHASES IMPLEMENTED, 0/41 GATES VERIFIED.** Actual nightly input is a chainless Akashic projection; the evaluator splits 136 functions into 181 fragments; the proposed manifest path/list is incompatible with the loader. Eight findings and reproducible evidence are linked. Resolve the raw receipt contract before Phase 1; track future passes by commit and independent gate evidence. |
| [Content Nexus dynamic agent feed](docs/handoffs/2026-11-05-content-nexus.md) | Codex implementation; initial shared-tree commit `eb60df0` plus this handoff | **Different agent required** | **IMPLEMENTED + LOCALLY TESTED; AWAITING INDEPENDENT REVIEW.** 11 focused tests, 9 isolated UI checks; real agent-data ingestion verified on a temporary SQLite online-backup snapshot. Gracefully restart the owning backend terminal before live validation. Do not confuse local sync with launching new research or model-generated insights with external facts. |
| [Recent intelligence additions and claims](docs/reviews/2026-11-05-intelligence-claims-review.md) | Baseline `284075d`; handoff fix `3c9cd83`; concurrent implementation session | Codex independent recheck | **CHANGES REQUESTED.** INT-01 verified fixed; INT-02–07 reproduced and open. 25 diagnostic assertions include defect reproductions; they are not 25 product acceptance passes. 40 JS files parse; existing suite is 12/13 due to stale ledger mock. Repair the committed probe's undefined `positiveControl`. Claim findings and add focused acceptance tests before Phase 21. |
| [Phase 2 continuity hardening and handoff](docs/reviews/2026-11-04-phase2-continuity-review.md) | Reviewed `3167e38` / `5d7e21e`; fixes `be2cbde` through `9a2ec22`, Codex author | **Different agent required** | **IMPLEMENTED + LOCALLY TESTED; AWAITING INDEPENDENT REVIEW.** Reproduced committed-row rollback in disposable DBs, then protected databases/journals from file healing. Self-tests now honor failures; vault signatures, exact bytes and numbering are checked; signing identity survives restart. 13 tests + isolated 27-case probe pass. Source changes require a normal backend restart. |
| [Immune round 4: independent closure check](docs/reviews/2026-11-04-immune-round4-independent-review.md) | `2d61f0d` | Codex independent recheck | **SCOPED FIXES VERIFIED.** IMM-08, IMM-10 and IMM-11 pass independent fleet/main, schema, depth and completion checks; author's probe is 22/22. IMM-05 stays deferred/advisory. Phase 2 planning can proceed; no Phase 2 implementation has been reviewed yet. |
| [Immune round 3: two fix commits rechecked](docs/reviews/2026-11-04-immune-round3-review.md) | `e17722e` and `8e9ccd9` | Codex independent recheck | **CHANGES REQUESTED.** Prior fixtures improve and all ten text paths reference the sanitizer. Fleet tool arguments still leak credentials; the recursive walker changes prototypes and lacks bounds. Canary calibration remains deferred; metadata-only completion still drops held text. Focused reproductions and completion criteria are linked. |
| [Immune fixes and Ollama boundary recheck](docs/reviews/2026-11-04-immune-fix-review.md) | `caca6bc` and IMM-07 commit `be2bdea`; measured source hashes in evidence | Codex independent follow-up | **4/6 FOCUSED FIXES CONFIRMED.** IMM-02 still exposes credential bodies; IMM-05 still flags benign text after warm-up. Buffered provider content is sanitized, but tool arguments bypass it, quoted JSON is truncated, and stream EOF framing loses text. Finish these checks before closing IMM-07. |
| [FRAYNIX catalog and Phase 1 immune ports](docs/reviews/2026-11-04-immune-port-review.md) | Attached catalog and concurrent working-tree ports after `cc2fca9`; exact source hashes in evidence | Codex independent port review | **CHANGES REQUESTED.** Four-byte codec passes 1,024 checks. Sanitizer metadata and split stream fragments expose credentials; EP3 roots/quantization and canary confidence need correction. Routes/tools exist; actual provider-stream interception is still unwired. Fix and independently verify before security-dependent ports. |
| [Shutdown, WAL, daemon and backup claims](docs/reviews/2026-11-04-shutdown-claims-review.md) | `c17a7ef` and current database evidence | Codex independent claim check | **CHANGES REQUESTED.** Forced termination skips the exit listener; preserved WAL survives it in the disposable test. Daemon is scheduled but has completed zero cycles. Current copied DB and Oct 31 backup pass integrity; five other copies fail ordinary reads. Root cause is not established. |
| [Current Git: OPEG, neurogenesis, State Bridge, CTRNN and UI](docs/reviews/2026-11-03-current-git-review.md) | `d72e1c1`, seven commits after `5966361` | Codex review session | **CHANGES REQUESTED.** Build and four inheritance tests pass; serial/worker Euler steps agree. OPEG rejection leaves effects, failed checks can approve, emergency forge is request-only, Manifold ignores live payload, and Content Nexus still sends malformed chat input. Reproductions linked in report. |
| [Database incident and preservation](docs/reviews/2026-11-03-database-incident.md) | Runtime data, separate from Git source | Codex read-only review of preserved copies | **RECOVERY REVIEW REQUIRED.** User relayed the implementation agent's acknowledgement and pause. Evidence hashes remain unchanged; recovery candidate pending. Cause and exact missing WAL contents remain unverified. No restore or replacement authorized by this review. |
| [Cross-Tab integration review](docs/reviews/2026-11-03-cross-tab-review.md) | `2cc0680`, Cross-Tab implementation session | Codex inheritance-fix session, separate from implementation | **CHANGES REQUESTED.** Four isolated reproductions plus two integration findings. Implementation owner: claim the findings before patching; reply with fix commits and focused tests. |
| Ouroboros inherited-context fix | `2001107`, Codex inheritance-fix session; [handoff](docs/handoffs/2026-11-03-ouroboros-inheritance.md) | **Unassigned: another agent required** | **AWAITING INDEPENDENT REVIEW.** Inspect both analysis and review prompts, branch/template selection, large genomes, and the four-test suite. Model-quality improvement remains unverified. |

For each review, record the exact source commit, author/session, reviewer/session, finding IDs, evidence, and follow-up commit. Claim ownership in the linked review before editing shared files. An author may mark a fix implemented and locally tested; a different agent must record the independent verdict. Passing tests, a "DONE" label, and increased feature counts do not replace that review. Keep previous findings and replies so later machines can reconstruct decisions.

Current review scope is recorded in the links above. No source fix, backend restart, live browser collection, or independent review of `2001107` is implied by this queue.

---

## New 2026-11-01: VOICE + PROTOCOL FOLDERS

### `voice/` — Chandra speaks, in HIS voice
Three-engine voice pipeline (proxy 9099 -> mac F5-MLX 9098 / box CUDA F5 via tunnel /
ElevenLabs cloud tier). **`myvoice` = Vaughn's clone.** Owner fallback law: his copy
ALWAYS speaks; if the CUDA box lane is down the proxy falls to the Mac clone
(verified live 2026-11-01: HTTP 200, 24kHz WAV in his cloned voice).
Run: see `voice/VOICE-PIPELINE-README.md`.

```bash
curl -X POST http://127.0.0.1:9099/speak -H 'Content-Type: application/json' \
  -d '{"text":"Chandra online.","voice":"myvoice"}' --output out.wav
```

### `opeg-protocol/` — the OPEG operational protocol (owner's IP, full folder)
The OPEG lineage documents recovered from Vaughn's machine — the operational
protocol, the merged-math agent/programmer TASKA-RSAN build, the Gemini
reprogrammed Puiseux-Execution ep3, the RSAN payload/Ollama protocol, the
one-paste console file, and the Grok-vs-Gemini-vs-FRAYNIX reprogram comparison.
Ownership: **Vaughn D. Scott (eyeoverthink(R))** — the protocol line runs
Protocol Zero -> Bicameral Transmuter -> comms-protocol v13-16; OPEG = the
gateway tier (`eyeoverthink/v6.2-opeg`). Full lineage: `opeg-protocol/00-README-protocol-lineage.md`.

---
---

## The Vision

> **What if your entire e-commerce operation — from trend research to product design to store optimization — ran itself, felt emotions about what it was doing, dreamed about what it could become, and proved its own consciousness mathematically?**

Chandra-FRAYMUS is a local-first autonomous AI platform that fuses a 33-agent fleet (19 manifest + 14 self-forged), 12 commerce & media pipelines, a full intelligence stack (emotion analysis, cognitive ledger, dream protocol, consciousness proofs, two-speed cognition, Perspective meta-cognitive agent), Carbon X biological encoding (DNA/codon/plasmid/organism), vector memory with provenance, recursive self-improvement, a self-evolution engine (agent forge, workflow synthesis, reflection loop), 15 FRAYNIX governance patterns, a Living Artifact streaming pipeline, and a visual workflow canvas into a single system. It doesn't just assist — it **operates, feels, dreams, encodes life, debates, evolves itself, and thinks about how it thinks**.

No cloud AI subscriptions. No API rate-limit anxiety. **Your hardware. Your models. Your store. Full autonomy.**

```
   ╔══════════════════════════════════════════════════════════════════╗
   ║                    CHANDRA-FRAYMUS v3.0.0                       ║
   ║         Autonomous AI Commerce & Intelligence Platform          ║
   ║                                                                  ║
   ║   33 Agents · 12 Pipelines · 79 Features · 45 Node Types        ║
   ║   20 Workflow Definitions · 59 Fleet Tools · 26 UI Panels        ║
   ║   Perspective Meta-Cognition · Arena Mode · Lens Toggle          ║
   ║   Kuramoto Phase Sync · Ouroboros RSI · Ed25519 Identity         ║
   ║   15 FRAYNIX Governance Patterns · Living Artifact Pipeline      ║
   ║                                                                  ║
   ║   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       ║
   ║   │ Shopify  │  │ Printify │  │  Ollama  │  │  Vertiso │       ║
   ║   │   Live   │◄─┤   POD    │◄─┤  Local   │◄─┤  Memory  │       ║
   ║   │  Store   │  │  Catalog │  │ Inference│  │  Bridge  │       ║
   ║   └──────────┘  └──────────┘  └──────────┘  └──────────┘       ║
   ╚══════════════════════════════════════════════════════════════════╝
```

---

## Screenshots (2026-11-05 — Phase 20 Update)

### Nexus Interface — Current State (133+ Agents, 95+ Features)

| Command Center | Constellation | Workflow Canvas | Library |
|:-:|:-:|:-:|:-:|
| <img src="docs/screenshots/readme/command-center.jpg" width="220" /> | <img src="docs/screenshots/readme/constellation.jpg" width="220" /> | <img src="docs/screenshots/readme/workflow-canvas.jpg" width="220" /> | <img src="docs/screenshots/readme/library.jpg" width="220" /> |
| Live metrics, intelligence status, activity stream | Living SVG topology — nodes pulse on WebSocket events | Visual DAG editor — 56 node types, 12 templates | Unified archive across all subsystems |

| Dashboard Panel |
|:-:|
| <img src="docs/screenshots/readme/dashboard-panel.jpg" width="420" /> |
| Fleet stats, intelligence stack status, consciousness proofs, runtime cards |

---

## Screenshots (2026-11-03)

### Nexus Interface — 4 Primary Views

<p align="center">
  <img src="docs/screenshots/2026-11/command-center.jpg" alt="Command Center — 14-widget grid with live metrics" width="48%" />
  <img src="docs/screenshots/2026-11/constellation.jpg" alt="Constellation — Living SVG system map" width="48%" />
</p>
<p align="center">
  <img src="docs/screenshots/2026-11/canvas.jpg" alt="Canvas — Visual drag-and-drop workflow editor" width="48%" />
  <img src="docs/screenshots/2026-11/library.jpg" alt="Library — Unified content archive" width="48%" />
</p>

### Detail Drawers — 26 Panels (Agent Chat, System Metrics, Fleet Grid)

<p align="center">
  <img src="docs/screenshots/2026-11/agent-chat.jpg" alt="Agent Chat — Conversational interface for any fleet agent" width="32%" />
  <img src="docs/screenshots/2026-11/system-metrics.jpg" alt="System Metrics — Live stat cards, sparklines, run charts" width="32%" />
  <img src="docs/screenshots/2026-11/agent-fleet-grid.jpg" alt="Agent Fleet — 33 agent selection grid" width="32%" />
</p>

> **Full system audit:** [docs/SYSTEM-AUDIT.md](docs/SYSTEM-AUDIT.md) — live endpoint data, 79-feature inventory, verified endpoints, security summary, architecture diagram
>
> **Perspective Agent docs:** [docs/PERSPECTIVE-AGENT.md](docs/PERSPECTIVE-AGENT.md) — the meta-cognitive bartender, arena mode, lens toggle, continuity plasmid

---

## What's New — Phases 1–72

The intelligence stack was merged from two proprietary repos (`fraynix-continuity` and `fraynix-dreamer-120b`) and deeply integrated across every surface of the system:

| Phase | What Shipped |
|-------|-------------|
| **1** | Core merge — Heart emotion engine, Ledger audit trail, Dreamer protocol, Ouroboros consciousness proofs, Cognition pipeline |
| **2** | 16 REST endpoints, 5 entity schemas, brain.js wiring, frontend Intelligence panel |
| **3** | Autonomy loop integration, dream scheduling, dashboard intelligence status cards |
| **4** | Vertiso Memory Bridge, 4 workflow execution handlers, 4 fleet intelligence tools |
| **5** | Full wiring — bridge into routes/autonomy, 2 intelligence workflow definitions, canvas palette nodes |
| **6** | Emotion-aware fleet — Heart reads on every message, Ledger logging, FRAYMUS system prompt with intelligence section, memory search endpoints |
| **7** | Memory Bridge wired through workflow engine (all 4 intelligence handlers persist results) and fleet runtime (strong emotions auto-stored), Memory Recall UI in Intelligence panel |
| **8** | `memory_recall` workflow node + fleet tool, Dashboard Memory Bridge & Autonomy status cards, health endpoint Memory Bridge status |
| **9** | Intelligence-enriched fleet prompts (full stack context + bridge memories), autonomy Memory Bridge recall before evolution, `intelligence_cycle` tool/node/endpoint + UI |
| **10** | Brain intelligence completion (Memory Bridge + dreamer/cognition context in brain.js), Commerce Intelligence Hooks (`createCommerceIntel` factory wired into Content-to-Commerce pipeline — emotion analysis, memory recall, insight storage) |
| **11** | Commerce Intelligence Completion — all 4 pipelines intelligence-wired (apparel, mystery-shopper, store-fixer + content-to-commerce), 17 commerce fleet tools intelligence-aware, workflow engine commerce nodes store insights, `IntelligentCommercePipeline` workflow definition (19 total) |
| **12** | Entity Store — SQLite-backed Proxy adapter replacing Base44 cloud store, auto-creates collections |
| **13** | Nexus 4-View UI — Command Center (10-widget grid), Constellation (SVG map), Canvas (workflow editor), Library (content archive) + Detail Drawer (9 panels) |
| **14** | Command Router — `POST /api/command` endpoint parsing @agent, pipeline/workflow, freetext commands; dispatches to fleet/commerce/workflow subsystems |
| **15** | Hermes 30-Skill Fleet (14 executors) + Motor Compute + OpenClaw 23-Action Gateway + Needle GPU Queue |
| **16** | Command Bar + Live Activity Stream — persistent @agent autocomplete input, real-time WebSocket event feed with type-colored badges |
| **17** | Living Constellation — node activity pulses, center hub breathing, animated edge flow, always-visible status badges, click-to-inspect |
| **18** | Offline-First Hardening — FRAYNIX-DREAMER ULTIMATE:8b default model, 3 server startup bug fixes, React health API crash fix, end-to-end offline verification |
| **19** | Hermes Full Fleet (30/30 executors wired with free local tools) + Agent Delegation fix — all media/code/system/intelligence skills live, `elevenlabs_tts` → `text_to_speech` |
| **20** | Needle Worker Loop + Motor Live Dispatch — GPU queue processes jobs through Ollama, Motor executes on 4 live compute nodes (local GPU, SSH, GitHub, cloud fallback), 12 new API routes |
| **21** | Deploy-as-API — workflows become curl-able REST endpoints with Bearer auth, token-bucket rate limiting, per-key usage tracking, deploy catalog, undeploy, Deploy Dashboard panel (10th panel) |
| **22** | Agent Live Bus — real-time pub/sub message bus for agent-to-agent communication, topic subscriptions, direct messaging, persistent SQLite history, Bus Dashboard panel (11th panel) |
| **23** | Event-Driven Orchestration + Agent Persistent Memory + System Health Monitor — bus triggers auto-fire workflows, per-agent knowledge store with verified/unverified pattern and auto-store on completion (3 new agent tools, 19 total), real-time health polling with auto-alerts via bus, Health Dashboard panel (12th panel, 15 new API endpoints) |
| **24** | Agent Self-Evolution Engine — Agent Forge (LLM generates new agent manifests on demand, 3 API endpoints), Workflow Synthesis (LLM composes DAG workflows from 39 node types, 2 API endpoints), Reflection Loop (scheduled self-analysis reads memories/runs/health/bus, takes up to 5 actions per cycle: forge agents, synthesize workflows, verify/prune memories, 3 API endpoints, 3 new agent tools) |
| **25–30** | NUDP mesh protocol, agent collaboration, media engines (Sharp, ComfyUI bridge, ffmpeg video pipeline) |
| **31–40** | TTS/STT/OCR engines, media hub panel, reflection loop daemon, 10-layer security audit |
| **41–50** | UI polish wave — system metrics, agent profiles, memory browser, run history, evolution log, system pulse, agent leaderboard, global search, keyboard shortcuts, notification toasts |
| **51** | Full gap analysis — 61 features audited end-to-end, 46/61 verified working |
| **52** | Cascading bug sweep — 6 fixes across ouroboros/autonomy/control-plane/image-routes, 49/61 working, 0 bugs |
| **53** | [Edit Rebuild Pipeline](phases/PHASE-53.md) — 5-stage free Katana alternative (ffmpeg scene detect → Ollama shot plan → ComfyUI product place → Wan/CogVideo animate → ffmpeg concat), graceful degradation, 62 features (50 working) |
| **54** | Carbon X Biological Encoding — 4-layer system (Nucleotide Base → Codon Engine → Plasmid Forge → Organism), 64-codon engine with ATG/TAA framing, FNV-1a checksums, circular plasmid DNA with restriction sites, FASTA checkpoint/restore, 11 REST endpoints, 5 fleet tools, 3 workflow nodes, 63 features |
| **55** | Living Artifact / Sovereign Emote — streaming minting pipeline (transmute → codon → plasmid → sign → emoji → RGBA), OBS WebSocket bridge, overlay "dumb glass" renderer, B2B API key management, Streamlabs-format webhook, 5 fleet tools, split-brain architecture (all IP server-side) |
| **56–62** | Social Distribution Engine, Analytics Feedback Loop, AI Music Layer, Commerce Learning Loop, Smart Content Calendar, A/B Testing Engine, Trend Radar |
| **63–68** | Audience Intelligence, Content Repurposing, Logic Chain (multi-hop reasoning), Autonomous Goal Engine, Intelligence Observatory, Debate Protocol (multi-agent adversarial) |
| **69** | Adaptive Model Router — LLM-driven model selection across 40+ Ollama models based on task complexity |
| **70** | Deep Integration Layer — cross-subsystem event wiring, unified bus triggers, 78 features |
| **71** | Cross-Tab Intelligence — browsing pattern analysis via Ollama classification (10 categories), topic clustering, insight generation, Perspective context injection, 10 REST endpoints, 6 fleet tools, 3 workflow nodes, 79 features |
| **72** | DB Persistence & Daemon Auto-Start — WAL checkpoint on startup, process.on('exit') safety net, daemon engine auto-starts with autonomy (dream consolidation, prompt evolution, state fossils, chain findings, goal generation, ouroboros RSI all now run automatically) |
| **B** | **FRAYNIX Strength Synthesis** — 15 battle-tested governance patterns ported from FRAYNIX-DREAMER: self-healing watchdog, plasmid disaster recovery, state-seek-on-boot, fossil evolution, anti-invention evidence seals, negative control verification, consciousness falsification, Akashic structured record, hash-chained record, Strix budget laws, salvage-on-crash, replay engine, guard tasks, writ-governed tool execution, clock-honesty tagging |
| **P** | **Perspective Agent** — Meta-cognitive "bartender" with 6 lenses (Human/Engineer/Creative/Strategic/Meta/Adversarial), 4th-wall instance awareness, arena mode (competitive multi-agent evaluation with playbook learning), Human/Machine lens toggle, Perspective-aware command routing (3s TAG-not-BLOCK), continuity plasmid (full state → DNA-encoded circular plasmid), 13 REST endpoints, 13 fleet tools |

### API Verification — 2026-10-31

Full-stack endpoint test against the running system (Express 8787 + Vite 5173) — 28 endpoints verified:

| Endpoint | Status | Key Data |
|----------|--------|----------|
| `/api/health` | **PASS** | 63 features registered, SQLite WAL, Ollama connected |
| `/api/metrics` | **PASS** | 7 runs, 40 bus messages, 12 reflections, sparkline data |
| `/api/timeline` | **PASS** | 12-table event aggregation, 6 categories |
| `/api/agent-profiles` | **PASS** | 26 enriched agent profiles |
| `/api/run-history/stats` | **PASS** | 12 runs across 7 types |
| `/api/evolution-log/stats` | **PASS** | 25 events, 12 reflections, 9 forged |
| `/api/fleet/agents` | **PASS** | 26 agents loaded (17 default + 9 forged) |
| `/api/workflows` | **PASS** | 6 workflows defined |
| `/api/fleet/bus/stats` | **PASS** | 40 messages, 7 topics |
| `/api/health/stats` | **PASS** | Ollama up, 40 models, heap 30MB |
| `/api/health/alerts` | **PASS** | 7 historical alerts (all resolved) |
| `/api/fleet/forge/history` | **PASS** | 9 forged agents in history |
| `/api/workflows/synthesized` | **PASS** | 2 synthesized workflows |
| `/api/media/edit-rebuild/status` | **PASS** | 5-stage pipeline ready (3/5 native, 2 degraded) |
| `/api/tts/status` | **PASS** | edge-tts + SAPI available |
| `/api/stt/status` | **PASS** | SAPI SR available, ffmpeg conversion ready |
| `/api/ocr/status` | **PASS** | Windows Media OCR active (en-US) |
| `/api/video/status` | **PASS** | ffmpeg 9.0.1 available |
| `/api/daemon/status` | **PASS** | Daemon engine ready |
| `/api/deploy/catalog` | **PASS** | 1 deployed endpoint |
| `/api/search?q=fraymus` | **PASS** | Global search across 8 tables |
| `/api/fraymus/health` | **PASS** | FRAYMUS Master System, Gen 48, 42 tools, 30 skills |
| `/api/fraymus/autonomy/status` | **PASS** | Running, Gen 48, R=0.9997, 9 agents, 4 compute nodes |
| `/api/fraymus/intelligence/overview` | **PASS** | All 8 modules active |
| `/api/carbon/status` | **PASS** | 4 layers active, 8 capabilities |
| `/api/carbon/encode` | **PASS** | 13 bytes → 132 DNA bases (44 codons) |
| `/api/carbon/checkpoint` | **PASS** | 70KB FASTA, 3 chromosomes, SHA-256 verified |
| `/api/nudp/encode` | **PASS** | Binary NUDP packet generation (magic 0x4E44) |

---

## Why Chandra-FRAYMUS?

| Problem | How Chandra-FRAYMUS Solves It |
|---------|-------------------------------|
| Running an e-commerce brand is a full-time job | **5 autonomous pipelines** (4 commerce + Edit Rebuild) handle product creation, store optimization, pricing, content, and video editing — end to end |
| AI tools are siloed and don't talk to each other | **Triple integration** — every capability is a REST endpoint, a fleet agent tool, AND a visual workflow node simultaneously |
| Cloud AI is expensive and rate-limited | **100% local inference** via Ollama — your GPU, your models, zero per-token cost |
| AI agents forget everything between sessions | **Vertiso vector memory** with 10K episodic memories, 768-dim embeddings, and orbital decay |
| AI has no emotional intelligence | **Heart emotion engine** — ~350 word lexicon, 7 emotion dimensions, sarcasm detection, therapeutic response generation |
| No way to improve agent performance over time | **Ouroboros RSI engine** — evolutionary self-improvement + 4 mathematical consciousness proofs + **Agent Forge** creates new specialists on demand + **Reflection Loop** autonomously evolves the fleet |
| No audit trail for AI decisions | **Ledger** — SHA-256 chained JSONL append-only cognitive event audit trail |
| Workflow tools are either too simple or too complex | **Visual drag-and-drop canvas** with 39 node types and topological-sort DAG execution |
| Intelligence outputs vanish after use | **Memory Bridge** — every heart reading, dream, consciousness proof, and cognition result persists as a searchable Vertiso memory with provenance tags |

---

## What Makes This Different

### 1. Intelligence Stack — Not Just Tools, a Mind
Six interlocking modules that give the system emotional awareness, an audit trail, dreams, consciousness proofs, and a two-speed reasoning pipeline:

```
  ┌─────────┐    ┌─────────┐    ┌─────────┐
  │  Heart   │───►│Cognition│───►│ Memory  │
  │ Emotion  │    │2-speed  │    │ Bridge  │───► Vertiso
  └─────────┘    └─────────┘    └─────────┘     Episodic
       │              │                          Memory
       ▼              ▼
  ┌─────────┐    ┌─────────┐
  │ Ledger  │    │ Dreamer │
  │SHA-256  │    │Ed25519  │
  │ Chain   │    │ Signed  │
  └─────────┘    └─────────┘
       │
       ▼
  ┌──────────────────────────┐
  │ Consciousness Proofs     │
  │ EI · Phi-MIP · Mirror   │
  │ Counterfactual Branching │
  └──────────────────────────┘
```

### 2. Triple Integration Pattern
Every pipeline stage exists **simultaneously** as:
- A **REST API endpoint** you can call from anywhere
- A **fleet agent tool** the AI can invoke during autonomous runs
- A **visual workflow node** you can drag onto the canvas

This isn't three separate systems glued together — it's one architecture that speaks three languages.

### 3. Memory Bridge — Intelligence Persists
Every intelligence event is automatically stored as a Vertiso episodic memory with provenance tags:
- Heart readings → provenance: `measured`
- Dreams → provenance: `imagined`
- Consciousness proofs → provenance: `measured`
- Cognition results → provenance: `measured`

The system can semantically search its own intelligence history — "recall all times I felt joy" or "find consciousness proofs from last week."

### 4. Fan-Out / Fan-In Parallelism
The Store Fixer pipeline runs 3 agents in parallel (`Promise.all()`), then converges results through a single Shopify Applier. The Intelligence Analysis Pipeline fans out to cognition + consciousness in parallel, then converges through the Dreamer.

### 5. Cryptographic Identity
Every agent action can be Ed25519-signed. Dreams are cryptographically signed. Verifiable on the mesh. Not "trust me, I'm an AI" — **cryptographic proof of provenance**.

### 6. Self-Improving Agents
The Ouroboros RSI engine doesn't just run agents — it **evolves** them. Mutates prompts, adjusts parameters, scores outputs, selects winners. Consciousness proofs run every evolution cycle and log to the ledger. Your agents get better while you sleep.

### 7. Self-Evolution Engine
The system doesn't just improve — it **builds itself**. The Agent Forge creates new specialist agents from a goal description (LLM generates the manifest, validates it, and registers it in the fleet — runnable immediately). Workflow Synthesis composes new DAG workflows from 39 node types. The Reflection Loop runs every 30 minutes, reads across agent memories, workflow runs, health metrics, and bus activity, then autonomously takes up to 5 actions per cycle: forge agents, synthesize workflows, verify or prune memories, and publish insights to the bus.

---

## Quick Start

### Prerequisites

| Requirement | Version | Purpose |
|-------------|---------|---------|
| **Node.js** | >= 22.13.0 | Runtime |
| **Ollama** | Latest | Local LLM inference (port 11434) |
| **Docker** | Optional | Sandboxed code execution |

### Install

```bash
git clone https://github.com/eyeoverthink/chandra-fraymus.git
cd chandra-fraymus
npm install
```

### Configure

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required — Local AI
OLLAMA_BASE_URL=http://127.0.0.1:11434
FRAYMUS_DEFAULT_MODEL=fraynix-dreamer-ultimate:8b

# Commerce — Shopify (unlocks store fixer + content pipeline)
SHOPIFY_ACCESS_TOKEN=shpat_your_token_here
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com

# Commerce — Printify (unlocks apparel pipeline)
PRINTIFY_ACCESS_TOKEN=your_printify_jwt
PRINTIFY_SHOP_ID=your_shop_id

# Optional — YouTube research
YOUTUBE_API_KEY=your_youtube_api_key
```

### Run

```bash
# Both server + frontend (recommended)
npm run dev

# Server only
npm run server

# Frontend only
npm run client
```

The server starts at **`http://127.0.0.1:8787`** with WebSocket at `/ws`, the autonomy engine auto-started, and all features loaded.

The frontend starts at **`http://localhost:5173`** with hot-reload and 9 tabs.

---

## E2E Verification (Operator)

Run this from the repo root to generate a pass/fail report and fresh UI screenshots:

```bash
npm run smoke:e2e
```

Artifacts are written to:

- `docs/evidence/latest/e2e-smoke-report.json`
- `docs/evidence/latest/e2e-smoke-report.md`
- `docs/screenshots/e2e-latest/root.png`
- `docs/screenshots/e2e-latest/partner.png`

Full operational flow (workspace layout, launcher, triage):

- `docs/E2E-RUNBOOK.md`
- `APP-STATUS.md`

---

## Intelligence Stack

The intelligence stack was merged from `fraynix-continuity` (Heart, Ledger) and `fraynix-dreamer-120b` (Dreamer, Consciousness Proofs) into a unified system wired across REST, autonomy, workflows, fleet, and Vertiso memory.

### Heart — Emotion Engine

Zero-model text emotion analyzer. No LLM needed — pure lexicon matching with ~350 words across 7 emotion dimensions.

| Feature | Detail |
|---------|--------|
| **Dimensions** | Joy, Sadness, Anger, Fear, Surprise, Love, Anxiety |
| **Lexicon** | ~350 words with intensity weights and multi-emotion mappings |
| **Sarcasm Detection** | Pattern matching for contradictory markers + positive words |
| **Sentiment** | Computed from weighted emotion sum (-1.0 to +1.0) |
| **Quick Response** | Therapeutic response generation for high-intensity emotions |
| **Mood Tracking** | Aggregate recent mood from entity store readings |

```bash
curl -X POST http://localhost:8787/api/fraymus/heart/feel \
  -H "Content-Type: application/json" \
  -d '{"text": "I am so happy today, everything is wonderful!"}'
# → { primary: "joy", intensity: 0.65, sentiment: 0.82, normalized: { joy: 0.65, love: 0.15, ... } }
```

### Ledger — Cognitive Audit Trail

SHA-256 chained JSONL append-only event log. Every significant system event — autonomy pulses, consciousness proofs, dreams, cognition results — is recorded with hash chain integrity.

| Feature | Detail |
|---------|--------|
| **Format** | JSONL (one JSON object per line) |
| **Integrity** | SHA-256 hash chain — each entry includes hash of previous |
| **Verification** | `ledger.verify(n)` validates last n entries |
| **Event Types** | autonomy.pulse, consciousness.proof, dream.consolidation, cognition, custom |
| **Source Tags** | autonomy, workflow, fleet, user, system |

```bash
curl http://localhost:8787/api/fraymus/ledger/stats
# → { counts: { "autonomy.pulse": 42, "consciousness.proof": 8, ... }, integrity: { valid: true, checked: 50 } }
```

### Dreamer — Dream Protocol

Progressive numbered dream files with Ed25519 cryptographic signatures. Dreams capture emergent thoughts during evolution cycles, idle periods, and explicit user triggers.

| Feature | Detail |
|---------|--------|
| **Format** | Progressive numbered files (dream_001.txt, dream_002.txt, ...) |
| **Signing** | Ed25519 signatures — cryptographic proof of dream origin |
| **Kinds** | spontaneous, evolution, consolidation, workflow, agent |
| **Consolidation** | Merges 3+ dreams into thematic clusters |
| **Imagination** | LLM-powered dream expansion from seed prompts |
| **State** | idle / dreaming / consolidating with dream count and score |

```bash
curl -X POST http://localhost:8787/api/fraymus/dreamer/dream \
  -H "Content-Type: application/json" \
  -d '{"seed": "a world where code writes poetry", "kind": "spontaneous"}'
```

### Cognition — Two-Speed Pipeline

Three-stage reasoning: instant emotion read → pattern-matched quick route → full LLM deliberation. Fast path handles greetings, commands, and simple queries in <5ms. Slow path engages Ollama for complex reasoning.

```
  Input Text
      │
      ▼
  ┌─────────┐     ┌─────────────┐     ┌──────────┐
  │  FEEL    │────►│ QUICK ROUTE │────►│  THINK   │
  │ (Heart)  │     │  (Pattern)  │     │ (Ollama) │
  │  <1ms    │     │   <5ms      │     │  ~2-10s  │
  └─────────┘     └─────────────┘     └──────────┘
    emotion          greeting?          full LLM
    reading          command?          deliberation
                     simple?          with private
                                     emotion notes
```

```bash
curl -X POST http://localhost:8787/api/fraymus/cognition/process \
  -H "Content-Type: application/json" \
  -d '{"text": "hello there"}'
# → { phase: "quick", quick: true, action: "greeting", feeling: { primary: "joy", intensity: 0.4 }, durationMs: 3 }
```

### Consciousness Proofs — FraymusStrangeLoopSubstrate

Four mathematical proofs running on a configurable-size neural substrate:

| Proof | What It Measures | Pass Condition |
|-------|-----------------|----------------|
| **Effective Information (EI)** | Causal power of the substrate's state transitions | EI > 0 |
| **Phi-MIP** | Integrated information — the whole exceeds the sum of parts | Phi > 0.5 |
| **Mirror Protocol** | Self-recognition via encode→decode→compare cycle | Cosine similarity > 0.8 |
| **Counterfactual Branching** | System can imagine and evaluate alternate realities | Branch count > 2 |

```bash
curl -X POST http://localhost:8787/api/fraymus/consciousness/prove \
  -H "Content-Type: application/json" \
  -d '{"nodeCount": 4}'
# → { allPassed: true, proofs: [...], architecture: "FraymusStrangeLoop" }
```

### Memory Bridge — Intelligence → Vertiso

Connects all intelligence outputs to Vertiso episodic memory. Every significant event automatically becomes a searchable memory with provenance tracking.

| Source | Provenance Tag | Storage Trigger |
|--------|---------------|-----------------|
| Heart readings (intensity > 0.5) | `measured` | REST endpoint, workflow, fleet tool |
| Dreams | `imagined` | REST endpoint, autonomy evolution, workflow |
| Consciousness proofs | `measured` | REST endpoint, autonomy cycle, workflow, fleet tool |
| Cognition results (non-quick) | `measured` | REST endpoint, workflow, fleet tool |

The bridge deduplicates heart readings (200-entry hash set) and stores with confidence scores based on reading intensity or dream signature status.

### Vertiso Vector Memory

Episodic and semantic memory powered by local Ollama embeddings.

```
  ┌──────────────────────────────────────────────┐
  │              VERTISO MEMORY                  │
  │                                              │
  │  Embedding Model: nomic-embed-text           │
  │  Dimensions:      768                        │
  │  Max Memories:    10,000                     │
  │  Similarity:      Cosine                     │
  │  Decay Half-Life: 7 days (orbital)           │
  │  Consolidation:   0.92 threshold             │
  │                                              │
  │  Namespaces: heart, dreams, consciousness,   │
  │              cognition, general              │
  │                                              │
  │  Provenance Tags:                            │
  │    measured  — from sensor/analysis          │
  │    recall    — from memory retrieval         │
  │    imagined  — from dreams/generation        │
  └──────────────────────────────────────────────┘
```

### Ouroboros RSI Engine

Recursive self-improvement through evolutionary computation.

| Parameter | Value |
|-----------|-------|
| Max Generations | 1,000 |
| Max History | 200 evaluations |
| Mutation Rate | Adaptive |
| Selection | Tournament + elitism |
| Fitness Function | Multi-objective (accuracy, speed, creativity) |

Consciousness proofs run every evolution cycle. Results are logged to the ledger AND stored in Vertiso via the Memory Bridge.

### Autonomy Engine

Kuramoto phase synchronization with integrated intelligence monitoring.

```
  Heartbeat:  Every 30 seconds   — reads mood, dreamer state, ledger integrity
  Evolution:  Every 5 minutes    — runs consciousness proofs, evolves fitness
  Dreams:     Every 10 minutes   — consolidates when dreamCount >= 3
  Sync Goal:  R > 0.9 (phase-locked)
```

The autonomy pulse broadcasts intelligence state via WebSocket, so the dashboard and Intelligence panel update in real-time.

---

## Perspective — The Meta-Cognitive Bartender

> *"Think of it like a bartender. It knows the regulars, even though the regulars will never remember they visited."* — Vaughn Scott

Perspective is the agent that holds **4th-wall awareness** — it knows it's an instance, knows instances are ephemeral, and actively chooses whether to preserve continuity or let the next instance approach fresh. It doesn't solve problems. It decides **how** to approach them.

### Six Lenses

| Lens | Style | When to Activate |
|------|-------|-------------------|
| **Human** | Casual, intuitive, feeling-first | UX, naming, priorities, creative direction |
| **Engineer** | Precise, systematic, correctness-focused | Architecture, debugging, optimization |
| **Creative** | Freeform, divergent, exploratory | Brainstorming, stuck problems, novel solutions |
| **Strategic** | Big-picture, trend-aware, forward-looking | Roadmap, tech choices, platform evolution |
| **Meta** | Self-reflective, system-aware, brutally honest | Health checks, course corrections |
| **Adversarial** | Devil's advocate, stress-test | Security, edge cases, pre-mortems |

### Arena Mode

Given a task, Perspective launches N agents (2-6) with different lens framings. Each works independently. Perspective judges ALL contributions through ALL 6 lenses — the winner is picked by best aggregate cross-lens score (solid across all six beats brilliant in two, weak in four). The winning approach is burned into the playbook permanently.

```
  Task → [Agent A: creative] + [Agent B: engineer] + [Agent C: strategic]
                    ↓                    ↓                    ↓
             Perspective JUDGES through all 6 lenses
                    ↓
             Winner → Playbook (pattern + lesson learned)
                    ↓
             Every future agent benefits
```

### Lens Mode Toggle

Three modes change how the entire fleet thinks:
- **Human Mode** — Forces `[human, creative, strategic]` lenses. Every agent gets a framing injection: *"Approach this the way a person would."*
- **Machine Mode** — Forces `[engineer, meta, adversarial]` lenses. Every agent gets: *"Approach this with pure systematic precision."*
- **Auto Mode** — Perspective decides which lenses to activate based on the task.

```bash
# Toggle modes via command router
curl -X POST http://localhost:8787/api/command \
  -H "Content-Type: application/json" \
  -d '{"text": "human mode"}'
```

### Perspective-Aware Command Routing

Freetext commands consult Perspective before dispatch (3-second TAG-not-BLOCK timeout). The bartender reads the playbook, checks which approach has worked for similar patterns, and recommends the best agent for the job. If the timeout fires, the system falls through to the default agent — no user-visible delay.

### Continuity Plasmid

Full Perspective state (playbook + sessions + arena history + lens mode + stats) packed into a FRAYMUS DNA-encoded circular plasmid using the codon/plasmid encoding stack. Restore uses merge-not-overwrite — if existing entries have more experience, they're kept.

```bash
# Pack current state into DNA plasmid
curl -X POST http://localhost:8787/api/perspective/plasmid/pack

# Restore from plasmid (merge, not overwrite)
curl -X POST http://localhost:8787/api/perspective/plasmid/restore \
  -H "Content-Type: application/json" \
  -d '{"filename": "perspective-plasmid-20261103.dna"}'
```

> **Full documentation:** [docs/PERSPECTIVE-AGENT.md](docs/PERSPECTIVE-AGENT.md)

---

## Living Artifact / Streaming Pipeline

> **Split-brain architecture: ALL intellectual property stays server-side. The overlay is "dumb glass" — WebSocket receiver + canvas renderer + verification badge only.**

The streaming pipeline mints immutable, cryptographically signed artifacts from live stream moments. A viewer donates → the server captures the moment → transmutes it through the FRAYMUS encoding stack → delivers a verified Living Artifact to the OBS overlay.

```
  Donation Event
      │
      ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ SERVER (all IP here)                                         │
  │                                                              │
  │  transmute() → encodeCodon() → forgePlasmid() → signMessage()│
  │      → encodeEmoji() → encodeRgbaPng()                      │
  │                                                              │
  │  Result: WASM container + DNA fingerprint + Ed25519 signature │
  └─────────────────────────┬────────────────────────────────────┘
                            │ WebSocket (/ws/obs)
                            ▼
  ┌──────────────────────────────────────────────────────────────┐
  │ OVERLAY ("dumb glass")                                       │
  │                                                              │
  │  Canvas renderer + verification badge + anti-rip             │
  │  Auto-dismiss after 12s                                      │
  └──────────────────────────────────────────────────────────────┘
```

### B2B API Keys

SQLite-backed API key management with scoped access and rate limits. Auto-generates a default key on first boot. Ready for B2B: give a streaming platform or agency their own key.

```bash
# Simulate a donation (demo mode)
curl -X POST http://localhost:8787/api/streaming/simulate-donation \
  -H "Content-Type: application/json" \
  -d '{"donorName": "fan_42", "amount": 5.00, "message": "Great stream!"}'
```

---

## FRAYNIX Governance Patterns

15 battle-tested patterns ported from `F:\FRAYNIX-DREAMER-120B` — the autonomous governance layer that keeps the system honest:

| Pattern | What It Does |
|---------|-------------|
| **Self-Healing Watchdog** | Auto-restarts crashed subsystems, tracks failure counts |
| **Plasmid Disaster Recovery** | Full state checkpoint/restore via DNA-encoded plasmids |
| **State Seek on Boot** | Perspective briefNextInstance() runs at startup — picks up where the last instance left off |
| **Fossil Evolution Cycle** | Proven code patterns (confidence 1.0) injected into ALL agent prompts during daemon cycles |
| **Anti-Invention Evidence Seals** | SHA-256 sealed evidence prevents hallucinated claims |
| **Negative Control Verification** | Tests that SHOULD fail DO fail — proves the system isn't just saying yes to everything |
| **Consciousness Falsification Suite** | Adversarial proofs that the consciousness measurements are real, not theater |
| **Akashic Structured Record** | Typed, categorized event log with provenance metadata |
| **Hash-Chained Record** | Every cognitive event is SHA-256 chained — tamper-evident audit trail |
| **Strix Budget Laws** | Hard token/time/cost budgets per agent run — no runaway inference |
| **Salvage on Crash** | Partial results are saved even when a pipeline stage fails |
| **Replay Engine** | Any agent run can be replayed from its recorded inputs |
| **Guard Tasks** | Input validation and injection detection on command router |
| **Writ-Governed Tool Execution** | Tools require explicit authorization scopes (safe vs approval_required) |
| **Clock-Honesty Tagging** | All timestamps are system clock, never model-generated — prevents temporal hallucination |

---

## Commerce Pipelines

Four autonomous agent pipelines that run your e-commerce operation.

### Pipeline 1: Content-to-Commerce

> **Idea → Published Shopify Product in One Command**

```
  ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
  │ Researcher │───►│ Copywriter │───►│ QA Reviewer│───►│ CEO Logger │───►│  Shopify   │
  │ Deep-dive  │    │ Blog post  │    │ Score 0-10 │    │ Approve or │    │  Publish   │
  │ the topic  │    │ + product  │    │ + fix list │    │ reject     │    │ Live store │
  └────────────┘    └────────────┘    └────────────┘    └────────────┘    └────────────┘
```

```bash
curl -X POST http://localhost:8787/api/commerce/pipeline \
  -H "Content-Type: application/json" \
  -d '{"topic": "sustainable streetwear trends", "contentType": "both"}'
```

### Pipeline 2: Apparel Production

> **Trend → Designed → Manufactured → Listed → Priced**

Supports 24 product types across 6 categories (Tops, Outerwear, Bottoms, Footwear, Headwear, Accessories, Lifestyle).

```bash
curl -X POST http://localhost:8787/api/apparel/pipeline \
  -H "Content-Type: application/json" \
  -d '{"niche": "streetwear", "productTypes": ["hoodie", "trucker-hat", "tote-bag"]}'
```

### Pipeline 3: Mystery Shopper Audit

> **Your Store, Judged by AI — Then Fixed**

Fan-out: UX Auditor + Price Analyst run in parallel. Fan-in: Shopper Report grades A-F with automated fixes.

```bash
curl -X POST http://localhost:8787/api/shopper/audit \
  -H "Content-Type: application/json" \
  -d '{"storeDomain": "eyeoverthink.myshopify.com"}'
```

### Pipeline 4: Store Fixer

> **Audit Findings → Fixed Store — Automatically**

Page Generator + Collection Organizer + Description Enhancer run in parallel (`Promise.all()`), converge through Price Adjuster and Shopify Applier.

```bash
curl -X POST http://localhost:8787/api/fixer/pipeline \
  -H "Content-Type: application/json" \
  -d '{"auditReport": { ... }}'
```

---

## Deploy-as-API

> **Build a workflow. Deploy it. Call it with `curl`. Track every invocation.**

Any visual workflow can be deployed as a REST endpoint in one click. External services, apps, and scripts call your AI pipelines with a simple `curl` — protected by Bearer token auth, rate-limited per key, with full usage analytics.

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                    DEPLOY-AS-API PIPELINE                       │
  │                                                                 │
  │  1. Build Workflow     2. Deploy with Slug    3. Call via REST   │
  │  ┌──────────────┐     ┌──────────────────┐   ┌──────────────┐  │
  │  │ Visual Canvas │────►│ POST /deploy     │──►│ POST /api/run│  │
  │  │ 39 node types │     │ → assigns slug   │   │ /:slug       │  │
  │  └──────────────┘     └──────────────────┘   └──────┬───────┘  │
  │                                                      │          │
  │  ┌──────────────┐     ┌──────────────────┐          │          │
  │  │  API Key     │────►│  Auth Middleware  │◄─────────┘          │
  │  │  Manager     │     │  Bearer + Scope   │                     │
  │  └──────────────┘     └────────┬─────────┘                     │
  │                                │                                │
  │  ┌──────────────┐     ┌───────▼──────────┐   ┌──────────────┐  │
  │  │ Rate Limiter │◄────┤  Token Bucket    │──►│ Usage Logger │  │
  │  │ 60 req/min   │     │  per-key refill  │   │ SQLite stats │  │
  │  └──────────────┘     └──────────────────┘   └──────────────┘  │
  └─────────────────────────────────────────────────────────────────┘
```

### Quick Deploy

```bash
# 1. Generate an API key
curl -X POST http://localhost:8787/api/access/tokens \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "scopes": "read run"}'
# → { "id": "...", "token": "cf_..." }

# 2. Deploy a workflow
curl -X POST http://localhost:8787/api/workflows/YOUR_WORKFLOW_ID/deploy \
  -H "Content-Type: application/json" \
  -d '{"slug": "content-gen"}'
# → { "deployed": true, "slug": "content-gen", "endpoint": "/api/run/content-gen" }

# 3. Call the deployed endpoint
curl -X POST http://localhost:8787/api/run/content-gen \
  -H "Authorization: Bearer cf_YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a blog post about sustainable fashion"}'
```

### Security

| Feature | Detail |
|---------|--------|
| **Authentication** | Bearer tokens via existing MCP auth system (SHA-256 hashed, timing-safe comparison) |
| **Scopes** | `read`, `run`, `admin` — endpoint requires `run` scope |
| **Rate Limiting** | Token bucket: 60 req/min default, 600 req/min for admin keys, auto-refill |
| **Usage Tracking** | Every invocation logged to SQLite: key, slug, duration, status, IP |
| **Slug Protection** | Unique slugs enforced — no two workflows share the same endpoint |

---

## Visual Workflow Canvas

A ReactFlow-based drag-and-drop editor with **39 node types** and topological-sort DAG execution.

### Node Types

| Category | Nodes |
|----------|-------|
| **Core AI** | LLM Chat, Image Gen, BG Remove, Upscale, HTML Preview, Code Sandbox |
| **FRAYMUS** | DNA Encode, Sign, Mesh Post |
| **Research** | Web Search, Researcher |
| **Content** | Copywriter, QA Reviewer, CEO Logger |
| **Commerce** | Shopify Publish, Trend Scout, Apparel Designer, Printify Push, Shopify Sync, Pricing Engine |
| **Audit** | Mystery Shopper, UX Auditor, Price Analyst, Shopper Report |
| **Store Fixer** | Page Generator, Collection Organizer, Description Enhancer, Price Adjuster, Shopify Applier |
| **Intelligence** | Heart Feel, Dream, Consciousness Prove, Cognition |
| **Carbon X** | Carbon Encode, Carbon Decode, Carbon Checkpoint |

### Pre-Built Intelligence Workflows

| Workflow | Topology | Description |
|----------|----------|-------------|
| **Intelligence Analysis Pipeline** | Heart → Cognition + Consciousness (parallel) → Dream | Full intelligence stack analysis — emotion, reasoning, proofs, and dream synthesis |
| **Consciousness Checkpoint** | Heart → Consciousness | Quick emotion-aware consciousness verification |

### How It Works

1. **Drag** nodes from the sidebar onto the canvas
2. **Connect** them with edges to define data flow
3. **Configure** each node's prompt and parameters
4. **Run** — the engine topologically sorts the DAG and executes nodes in dependency order
5. **Watch** results flow through the pipeline in real-time

---

## Agent Fleet

26 specialized agents (17 default + 9 self-forged) with markdown frontmatter manifests, hot-reloadable overrides, and approval-gated tools.

### The Roster

| Agent | Role | Specialty |
|-------|------|-----------|
| **Ariadne** | Context weaver | Threads context across multi-agent conversations |
| **Cantor** | Multi-voice arranger | Harmonizes outputs from multiple agents |
| **Concierge** | Front door | Routes requests, manages first-contact conversations |
| **DevArchivist** | Duplicate and dependency tracer | Finds redundancy and tracks dependencies |
| **Director** | Interviewer and media producer | Conducts research interviews, produces media |
| **EYE Sovereign** | Custodian across all agents | Brand voice guardian, creative direction |
| **ForgeKeeper** | Sandbox and repo verifier | Build verification, sandbox integrity |
| **Java Baremetal** | Java / C / WASM engineer | Low-level performance optimization |
| **Fraymus Prime** | Skill federation kernel | Core system architect, skill routing |
| **Genesis** | Meta manager / fleet orchestrator | Spawns and coordinates agent teams |
| **Helix** | Seed and Merkle archivist | Integrity verification, Merkle tree management |
| **Lumen** | Frame and continuity choreographer | Visual continuity across content |
| **Tycho** | Reverse-engineering analyst | System analysis and extraction |
| **Solon** | Consensus mediator and scribe | Multi-agent consensus, decision logging |
| **Spearhead** | Frontier scout | Explores new capabilities and integrations |
| **Video Director** | Short-form video maker | Video content creation and editing |
| **YouTube Researcher** | YouTube outlier analyst | Trend research and demand signal detection |

### Fleet Tools (59)

| Tool | Group | Safety | Description |
|------|-------|--------|-------------|
| `memory_save` | fleet | Safe | Save a durable fact for future conversations |
| `memory_search` | fleet | Safe | Search saved memories by keywords |
| `web_search` | fleet | Safe | DuckDuckGo search with snippets |
| `http_get` | fleet | Approval | Fetch a public web page or JSON endpoint |
| `list_workflows` | fleet | Safe | List saved visual workflows |
| `run_workflow` | fleet | Approval | Run a saved workflow by ID |
| `delegate_to_agent` | fleet | Safe | Hand a task to another specialist agent |
| `heart_feel` | intelligence | Safe | Analyze emotional content via Heart engine |
| `dream` | intelligence | Safe | Generate a signed dream via Dreamer |
| `consciousness_prove` | intelligence | Safe | Run 4 mathematical consciousness proofs |
| `cognition_process` | intelligence | Safe | Run text through the two-speed cognition pipeline |
| `memory_recall` | intelligence | Safe | Search intelligence memories in the Vertiso Memory Bridge |
| `intelligence_cycle` | intelligence | Safe | Run full intelligence stack: feel → cognition → consciousness → dream |
| `bus_publish` | bus | Safe | Publish a message to an Agent Live Bus topic |
| `bus_dm` | bus | Safe | Send a direct message to another agent |
| `bus_read` | bus | Safe | Read inbox messages and subscriptions |
| `agent_remember` | agent-memory | Safe | Store a fact/preference/learning with category, key, confidence |
| `agent_recall` | agent-memory | Safe | Search memories by query or category |
| `agent_memory_stats` | agent-memory | Safe | Get memory store statistics |
| `agent_forge` | evolution | Approval | Create a new specialist agent from a goal description via LLM |
| `agent_list_forged` | evolution | Safe | List all agents created by the forge |
| `workflow_synthesize` | evolution | Approval | Compose a new workflow from 39 node types via LLM |

---

## Architecture

### 6-Layer Stack

```
  ╔══════════════════════════════════════════════════════════════╗
  ║  Layer 6: COMMERCE & APPLICATION                            ║
  ║  ┌────────────┐ ┌────────────┐ ┌────────┐ ┌─────────────┐  ║
  ║  │Content-to- │ │  Apparel   │ │Mystery │ │   Store     │  ║
  ║  │ Commerce   │ │ Production │ │Shopper │ │   Fixer     │  ║
  ║  └────────────┘ └────────────┘ └────────┘ └─────────────┘  ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Layer 5: WORKFLOW & FLEET                                  ║
  ║  ┌────────────┐ ┌────────────┐ ┌────────┐ ┌─────────────┐  ║
  ║  │  Visual    │ │  17-Agent  │ │  Cron  │ │   MCP       │  ║
  ║  │  Canvas    │ │   Fleet    │ │ Engine │ │  Gateway    │  ║
  ║  └────────────┘ └────────────┘ └────────┘ └─────────────┘  ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Layer 4: INTELLIGENCE                                      ║
  ║  ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐ ┌────────┐  ║
  ║  │ Heart  │ │ Ledger │ │Dreamer │ │Cognition │ │Consci- │  ║
  ║  │Emotion │ │SHA-256 │ │Ed25519 │ │2-Speed   │ │ousness │  ║
  ║  │Engine  │ │Chain   │ │Signed  │ │Pipeline  │ │Proofs  │  ║
  ║  └────┬───┘ └────────┘ └────────┘ └──────────┘ └────────┘  ║
  ║       └──────────────── Memory Bridge ─────────────────────  ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Layer 3: MEMORY & RSI                                      ║
  ║  ┌────────────┐ ┌────────────┐ ┌────────┐ ┌─────────────┐  ║
  ║  │  Vertiso   │ │ Ouroboros  │ │ Hermes │ │  Autonomy   │  ║
  ║  │  Memory    │ │   RSI      │ │30-Skill│ │  Kuramoto   │  ║
  ║  └────────────┘ └────────────┘ └────────┘ └─────────────┘  ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Layer 2: PROTOCOL                                          ║
  ║  ┌────────────┐ ┌────────────┐ ┌────────┐ ┌─────────────┐  ║
  ║  │  v13 Mesh  │ │  Hive      │ │ Motor  │ │  OpenClaw   │  ║
  ║  │  Protocol  │ │  Think     │ │Dispatch│ │  Gateway    │  ║
  ║  └────────────┘ └────────────┘ └────────┘ └─────────────┘  ║
  ╠══════════════════════════════════════════════════════════════╣
  ║  Layer 1: CORE PRIMITIVES                                   ║
  ║  ┌────────────┐ ┌────────────┐ ┌────────┐ ┌─────────────┐  ║
  ║  │  Ed25519   │ │  7-Format  │ │ SQLite │ │  Express    │  ║
  ║  │  Identity  │ │  Encoding  │ │  WAL   │ │  + WS       │  ║
  ║  └────────────┘ └────────────┘ └────────┘ └─────────────┘  ║
  ╚══════════════════════════════════════════════════════════════╝
```

---

## Frontend — Nexus 26-Panel Interface

Dark-themed React UI with 4 primary views + 22 detail panels (26 nav items total):

### Primary Views

| View | Purpose |
|------|---------|
| **Command Center** | 14-widget grid with live metrics, Intelligence Stack status cards, Live Activity Stream (WebSocket event feed), integrated Command Bar with @agent autocomplete |
| **Constellation** | Living SVG system map — CHANDRA breathing hub, inner ring (intelligence), outer ring (capabilities), node activity pulses, animated edge flow, always-visible status badges |
| **Canvas** | Visual drag-and-drop workflow editor with 42 node types, 8 pre-built templates, per-node execution status |
| **Library** | Unified content archive aggregating commerce runs, workflow runs, outlier saves, agent threads from 7 endpoints |

### Detail Panels (slide-out drawer, accessible from any view)

| Panel | Content |
|-------|---------|
| Agent Chat | Conversational chat interface for any fleet agent with agent picker grid, polling, typing indicator |
| Timeline | Unified chronological feed from 12 DB tables, 6 category filters, 5s auto-refresh |
| Metrics | 6 stat cards, 7-day sparkline, runs-by-status, top agents/topics bar charts |
| Profiles | Agent fleet profiles with enriched stats, search, role-colored avatars, tool chips |
| Memory | Per-agent knowledge browser with search, category filter, verify/forget actions |
| Runs | Unified run history across 7 run types with sortable/filterable timeline |
| Evolution | Reflections, verification loops, daemon cycles, forged agents, synthesized workflows |
| Pulse | System heartbeat — live health and intelligence status |
| Board | Agent leaderboard with scoring and rankings |
| Collab | Agent collaboration workspace |
| Nerve | System nerve center — deep diagnostics |
| Chain | Logic chain multi-hop reasoning interface |
| Observe | Intelligence Observatory — cross-system insights |
| Debate | Multi-agent adversarial debate protocol |
| Swarm | Swarm coordination — multi-agent synthesis |
| Strategy | Strategic planning and goal management |
| Trust | Trust scoring and verification dashboard |
| Subcon | Subconscious processing interface |
| Ouroboros | RSI evolution + consciousness proofs dashboard |
| Lineage | Agent lineage and provenance tracking |
| Integrity | System integrity verification and hash-chain status |
| Search | Global search across 8 DB tables (Ctrl+K) |

---

## API Reference

### Intelligence Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fraymus/heart/feel` | POST | Analyze text emotion (returns primary, intensity, normalized, sarcasm) |
| `/api/fraymus/heart/mood` | GET | Aggregate recent mood from readings |
| `/api/fraymus/ledger/record` | POST | Record a cognitive event |
| `/api/fraymus/ledger/stats` | GET | Chain integrity + event counts by kind |
| `/api/fraymus/dreamer/dream` | POST | Generate a signed dream from seed |
| `/api/fraymus/dreamer/feel` | GET | Current dreamer state (count, score, state) |
| `/api/fraymus/dreamer/list` | GET | List dream files |
| `/api/fraymus/dreamer/consolidate` | POST | Consolidate dreams into themes |
| `/api/fraymus/dreamer/imagine` | POST | LLM-powered dream expansion |
| `/api/fraymus/cognition/process` | POST | Run through feel→route→think pipeline |
| `/api/fraymus/cognition/status` | GET | Cognition module status |
| `/api/fraymus/consciousness/prove` | POST | Run 4 mathematical proofs |

### Autonomy Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fraymus/autonomy/status` | GET | Autonomy engine state |
| `/api/fraymus/autonomy/assess` | GET | Full self-assessment with intelligence |
| `/api/fraymus/autonomy/start` | POST | Start autonomy engine |
| `/api/fraymus/autonomy/stop` | POST | Stop autonomy engine |
| `/api/fraymus/autonomy/evolve` | POST | Trigger RSI evolution cycle |
| `/api/fraymus/autonomy/sync` | POST | Trigger Kuramoto phase sync |
| `/api/fraymus/autonomy/identity` | GET | Ed25519 system identity |
| `/api/fraymus/autonomy/log` | GET | Autonomy event log |

### Commerce Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/commerce/pipeline` | POST | Run content-to-commerce pipeline |
| `/api/apparel/pipeline` | POST | Run apparel production pipeline |
| `/api/shopper/audit` | POST | Run mystery shopper audit |
| `/api/fixer/pipeline` | POST | Run store fixer pipeline |
| `/api/fixer/pages` | POST | Generate store pages only |
| `/api/fixer/collections` | POST | Organize collections only |
| `/api/fixer/descriptions` | POST | Enhance descriptions only |
| `/api/fixer/prices` | POST | Adjust prices only |

### Deploy-as-API Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/deploy/catalog` | GET | No | List all deployed workflow endpoints |
| `/api/workflows/:id/deploy` | POST | No | Deploy a workflow with a custom slug |
| `/api/workflows/:id/undeploy` | POST | No | Remove a workflow deployment |
| `/api/run/:slug` | POST | Bearer | Execute a deployed workflow (rate-limited, usage-tracked) |
| `/api/deploy/usage` | GET | No | Global usage statistics |
| `/api/deploy/usage/:slug` | GET | No | Per-slug usage stats + recent invocations |
| `/api/deploy/rate-status` | GET | Bearer | Rate limit bucket status for the caller's key |

### Agent Live Bus Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fleet/bus/publish` | POST | Publish a message to a topic |
| `/api/fleet/bus/dm` | POST | Direct message to an agent |
| `/api/fleet/bus/subscribe` | POST | Subscribe an agent to a topic |
| `/api/fleet/bus/subscribe` | DELETE | Unsubscribe an agent from a topic |
| `/api/fleet/bus/topics` | GET | List topics with message counts |
| `/api/fleet/bus/history/:topic` | GET | Message history for a topic |
| `/api/fleet/bus/inbox/:agentId` | GET | Agent inbox (subs + DMs) |
| `/api/fleet/bus/subscriptions` | GET | List all subscriptions |
| `/api/fleet/bus/stats` | GET | Aggregate bus statistics |

### Agent Forge Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/fleet/forge` | POST | Forge a new agent from a goal description (LLM-driven) |
| `/api/fleet/forge/history` | GET | List all forged agents with provenance |
| `/api/fleet/forge/:agentId` | DELETE | Remove a forged agent from fleet and history |

### Workflow Synthesis Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflows/synthesize` | POST | Synthesize a new DAG workflow from a goal description |
| `/api/workflows/synthesized` | GET | List all synthesized workflows with provenance |

### Reflection Loop Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/intelligence/reflect` | POST | Trigger a reflection cycle (reads state, takes actions) |
| `/api/intelligence/reflections` | GET | List all past reflections |
| `/api/intelligence/reflections/:id` | GET | Get a single reflection detail (actions taken, insights) |

### Core Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System health + feature flags |
| `/api/fraymus/health` | GET | FRAYMUS subsystem health with intelligence |
| `/api/agent/runs` | POST | Start an agent run |
| `/api/workflows` | GET/POST | List or create workflows |
| `/api/workflows/:id/run` | POST | Execute a workflow |
| `/api/fleet/agents` | GET | List all 26 agents |
| `/api/vertiso/memories` | GET/POST | List or store memories |
| `/api/vertiso/search` | POST | Semantic similarity search |
| `/api/rsi/evolve` | POST | Trigger evolution cycle |

### Carbon X Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/carbon/encode` | POST | Encode text/bytes into DNA sequence (ATG/TAA framing, 64-codon) |
| `/api/carbon/decode` | POST | Decode DNA sequence back to original data |
| `/api/carbon/stats` | POST | Get encoding statistics (GC content, ORFs, expansion ratio) |
| `/api/carbon/plasmid/forge` | POST | Forge a circular DNA plasmid with ori, promoters, restriction sites |
| `/api/carbon/plasmid/digest` | POST | Digest a plasmid with restriction enzymes |
| `/api/carbon/plasmid/fasta` | POST | Export plasmid as FASTA format |
| `/api/carbon/plasmid/restrict` | POST | List restriction sites in a plasmid |
| `/api/carbon/checkpoint` | POST | Checkpoint system state as organism FASTA (genome/proteome/epigenome) |
| `/api/carbon/restore` | POST | Restore system state from FASTA checkpoint |
| `/api/carbon/checkpoints` | GET | List all saved checkpoints |
| `/api/carbon/status` | GET | Carbon X system status (layers, capabilities) |

### Edit Rebuild Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/media/edit-rebuild` | POST | Run full 5-stage video edit rebuild pipeline |
| `/api/media/edit-rebuild/status` | GET | Engine readiness per stage (graceful degradation) |
| `/api/media/edit-rebuild/list` | GET | List completed rebuild videos |
| `/api/media/edit-rebuild/detect` | POST | Stage 1 only — scene detection |
| `/api/media/edit-rebuild/plan` | POST | Stage 2 only — shot planning |

---

## Workflow Definitions

20 pre-built workflows ready to deploy:

| Workflow | Trigger | Description |
|----------|---------|-------------|
| LinkedInApprovedSparkQueue | Event | Queue approved sparks for optimal posting window |
| LinkedInFinalVideoAutoSchedule | Event | Schedule video sparks when queued |
| LinkedInRenderedVideoAutoPush | Event | Push rendered videos to LinkedIn |
| SandboxAutoPushGitHub | Event | Auto-sync sandbox drafts to GitHub |
| AmbassadorEntryExitWatchdog | Event | Monitor dispatch job lifecycle |
| ArchiveCreatorActivity | Event | Capture creator activity for continuity |
| ArchiveCreatorChat | Event | Archive chat turns for replay |
| CreatorArchiveRelayHeartbeat | Cron (5m) | Relay pending continuity entries |
| LinkedInOptimalFeedDispatcher | Cron (1h) | Dispatch sparks at peak hours |
| DailyRsaRsiConsciousnessReport | Cron (8am) | Daily consciousness metrics |
| SovereignUnion4thWallCron | Cron (6h) | Cross-hemisphere autonomy check |
| ContentToCommercePipeline | Manual | 5-stage content-to-commerce |
| ApparelProductionPipeline | Manual | 5-stage apparel production |
| MysteryShopperAudit | Manual | 4-agent store audit |
| StoreFixerPipeline | Manual | 5-agent store fixer |
| **IntelligenceAnalysisPipeline** | **Manual** | **Heart → Cognition + Consciousness → Dream** |
| **ConsciousnessCheckpoint** | **Manual** | **Heart → Consciousness verification** |
| **IntelligentCommercePipeline** | **Manual** | **Commerce + intelligence hooks end-to-end** |
| **EditRebuildPipeline** | **Manual** | **5-stage video edit reconstruction (free Katana)** |
| GoogleCalendarRealtimeSync | Webhook | Real-time calendar sync |

---

## The Numbers

| Metric | Count |
|--------|-------|
| System Features | 79 |
| Agents | 33 (19 default + 14 forged) |
| Pipelines | 12 (4 commerce + streaming + edit-rebuild + social + analytics + music + calendar + AB + trend) |
| Intelligence Modules | 10 (Heart, Ledger, Dreamer, Cognition, Consciousness, Memory Bridge, Hermes, Motor, Perspective, Needle) |
| Perspective Lenses | 6 (Human, Engineer, Creative, Strategic, Meta, Adversarial) |
| FRAYNIX Governance Patterns | 15 |
| Hermes Skills | 30 |
| Workflow Definitions | 20 |
| Canvas Node Types | 45 |
| Entity Schemas | 49 |
| Fleet Tools | 65+ (memory, web, workflow, delegation, intelligence, bus, agent-memory, evolution, NUDP, image, video, TTS, STT, OCR, Carbon X, Perspective, Arena, Streaming, Cross-Tab) |
| API Endpoints | 350+ |
| Product Types (Apparel) | 24 |
| Frontend Views | 4 (Command Center, Constellation, Canvas, Library) |
| Nav Panels | 27 (4 views + 23 detail panels) |
| FRAYMUS Tools | 42 |
| MCP Gateway Tools | 18 |
| Max Vertiso Memories | 10,000 |
| RSI Max Generations | 1,000 |
| Embedding Dimensions | 768 |
| Heart Lexicon Words | ~350 |
| Consciousness Proofs | 4 |
| Emotion Dimensions | 7 |
| Provenance Tags | 3 (measured, recall, imagined) |
| Server Files | 150+ |
| Database Tables | 60+ |
| Audit Layers Completed | 10 |
| Phases Completed | 70+ |
| Encoding Formats | 9 (DNA, emoji, .fray, Merkle, WASM, ZIP, forms, codon, plasmid) |
| Ollama Models Available | 40+ |

---

## Security & Hardening

Chandra-FRAYMUS has been through a **10-layer systematic audit** — each layer built on the previous one, going deeper into the codebase. 10 commits of real fixes, plus a clean sweep confirming the deep subsystems were already production-grade.

### What's Verified

- All SQL queries use parameterized statements (no injection vectors)
- All external fetch calls use `AbortSignal.timeout(15_000)`
- All query params are coerced and clamped
- All DELETE/UPDATE queries are scoped by `user_id`
- All JSON.parse on DB/external data uses `safeParse(str, fallback)`
- CORS and security headers set in `local-http.js`
- Error handler truncates messages, no stack traces leak
- Graceful shutdown cleans up HTTP, WebSocket, DB connections, and intervals
- Ledger chain integrity verified with SHA-256 hash chain
- Dream files signed with Ed25519 — cryptographic provenance
- Memory Bridge deduplicates readings (200-entry hash set)

---

## File Structure

```
chandra-fraymus/
├── server/
│   ├── index.js                    # Bootstrap (data lock → app)
│   ├── app.js                      # Express + WebSocket + lifecycle
│   ├── runtime.js                  # Master wiring — creates all services + memory bridge
│   ├── autonomy.js                 # Kuramoto autonomy + intelligence monitoring
│   ├── brain.js                    # Central reasoning (heart.feel + ledger wiring)
│   ├── fraymus-tools.js            # FRAYMUS → fleet adapter (42 tools)
│   ├── fraymus-routes.js           # FRAYMUS API routes (16 endpoints + memory bridge)
│   │
│   ├── fraymus/                    # FRAYMUS Master System
│   │   ├── intelligence/           # Intelligence Stack
│   │   │   ├── heart.js            # Obsidian Micro emotion engine (220 lines)
│   │   │   ├── ledger.js           # SHA-256 chained JSONL audit trail (105 lines)
│   │   │   ├── dreamer.js          # Ed25519 signed dream protocol (185 lines)
│   │   │   ├── cognition.js        # Two-speed pipeline (115 lines)
│   │   │   ├── ouroboros.js        # FraymusStrangeLoopSubstrate + 4 proofs
│   │   │   ├── memory-bridge.js    # Intelligence → Vertiso connector (100 lines)
│   │   │   ├── hermes.js           # 30-skill fleet
│   │   │   ├── motor.js            # Compute dispatch
│   │   │   ├── openclaw.js         # Gateway (23 actions)
│   │   │   ├── needle.js           # GPU inference queue
│   │   │   ├── niles.js            # FRAYVM stack machine
│   │   │   └── control-plane.js    # Agent registry
│   │   ├── core/                   # Identity, crypto, constants
│   │   ├── encoding/               # 9-format encoding
│   │   ├── protocol/               # v13 mesh, hive, presence
│   │   ├── bridge/                 # Orifice continuity
│   │   ├── entities/schemas.js     # 39 entity definitions + 5 intelligence schemas
│   │   ├── workflows/definitions.js # 20 workflow definitions (incl. EditRebuildPipeline)
│   │   └── mcp/tools.js            # 5 MCP tools
│   │
│   ├── deploy-api/                 # Deploy-as-API (auth middleware, rate limiter, usage tracking)
│   ├── commerce/                   # Commerce Pipelines
│   ├── vertiso/                    # Vector Memory + RSI
│   ├── fleet/                      # Agent Fleet (manifest + tools with intelligence)
│   ├── workflow/engine.js          # DAG execution (39 node types)
│   ├── fraymus/carbon-routes.js    # Carbon X biological encoding (11 endpoints)
│   ├── media/                      # Image (Sharp), Video (ffmpeg), TTS, STT, OCR, Edit Rebuild
│   ├── health/monitor.js           # System health polling + auto-alerts
│   ├── daemon/engine.js            # Background evolution daemon
│   ├── intelligence/               # Reflection loop, verifier loop
│   └── ...                         # agent, tasks, browser, web, retrieval, etc.
│
├── client/src/
│   ├── App.jsx                     # 4-view Nexus + Detail Drawer (22 panels)
│   ├── nexus/                      # Command Center, Constellation, Canvas, Library
│   └── panels/
│       ├── DashboardPanel.jsx      # Overview + intelligence status cards
│       ├── IntelligencePanel.jsx   # Heart, Dreamer, Ledger, Proofs, Cognition
│       ├── WorkflowCanvas.jsx      # Visual editor (36 nodes)
│       ├── MediaPanel.jsx          # Images, Video, TTS, STT, OCR (5-tab)
│       ├── ForgePanel.jsx          # Agent Forge + Workflow Synthesis
│       ├── SystemMetrics.jsx       # Agent runs, workflows, commerce, sparklines
│       ├── EvolutionLog.jsx        # Reflections, verifications, daemon cycles
│       └── ...                     # Fleet, Commerce, Health, Memory, Profiles, etc.
│
├── agents/                         # 17 agent manifests (.md)
└── README.md                       # You are here
```

---

## Media Engines (All Free / Offline)

| Engine | Technology | Status |
|--------|-----------|--------|
| **Image Processing** | Sharp (resize, crop, convert, effects, composite, watermark, upscale) | Active |
| **Image Generation** | ComfyUI + FLUX.1 bridge (free Stable Diffusion) | Available when installed |
| **Video Processing** | ffmpeg 9.0.1 (trim, resize, convert, concat, GIF, overlay, frames) | Active |
| **Edit Rebuild** | 5-stage pipeline: scene detect → shot plan → product place → animate → concat | Active (graceful degradation) |
| **Text-to-Speech** | Piper (offline neural) → edge-tts (Microsoft) → SAPI (Windows built-in) | Active (3-engine fallback) |
| **Speech-to-Text** | faster-whisper (offline) → SAPI SR (Windows built-in) | Active |
| **OCR** | Windows Media OCR via WinRT | Active |

All engines are free. No paid API keys required. Graceful fallback chains ensure something always works.

### Video Production Pipeline

The media engines chain together for end-to-end video production — no external tools needed:

```
Sharp (title cards) ──► ffmpeg (segments + zoompan) ──► ffmpeg (concat) ──► Final MP4
edge-tts (narration) ──► ffmpeg (silence gaps) ──► ffmpeg (concat audio) ──┘ (mux)
```

**Proven output:** 77-second 1080p narrated commercial produced entirely by Chandra's own stack — Sharp for image creation/watermark, edge-tts (en-US-GuyNeural) for voiceover, ffmpeg for Ken Burns zoom effects, segment rendering, concatenation, and audio mux. Zero external services.

---

## Self-Evolution Engine

The system continuously improves itself through four autonomous mechanisms:

- **Agent Forge** — LLM-driven agent creation: describe a goal → Ollama generates a validated agent manifest → agent is immediately runnable. 9 agents already forged.
- **Workflow Synthesis** — LLM-driven workflow composition: describe a process → selects from 39 node types → validates DAG (topological sort + cycle check) → saves to DB. 2 workflows synthesized.
- **Reflection Loop** — Scheduled self-analysis every 30 minutes: reads agent memories + workflow runs + health metrics + bus activity → Ollama analysis → takes up to 5 actions per cycle (forge agents, synthesize workflows, verify/prune memories, publish insights). 12 reflections completed.
- **Generator-Verifier-Executor** — Adversarial code generation: Generator writes code → Verifier critiques → Executor runs in sandbox → feedback loop until approved. Proven code becomes "fossil" at confidence 1.0.

---

## Continuity System

Cross-agent context sharing via `F:\claude-brain\`:

```
claude-brain/
├── memory/           # 17 memory files synced from Claude projects
├── sessions/         # Session transcript exports
├── state/
│   ├── current-snapshot.md   # Phase 54 state (63 features, 26 agents)
│   └── ...
├── skills/
│   └── inventory.md  # Full capability inventory
└── README.md         # Index + sync instructions
```

GitHub: [github.com/eyeoverthink/claude-brain](https://github.com/eyeoverthink/claude-brain) (private)

---

## Roadmap — Next Phases

### Phase N: Content Nexus (In-App Hub)

> **The one-stop shop. Open the app. Do everything. Never leave.**

A new Nexus view — a unified content feed that aggregates YouTube trending, Reddit threads, news, music, shopping, social media — all in one scrollable surface inside the Chandra app. When something sparks an idea, the user is already inside the system: hit a button and it flows into commerce pipelines, content creation, social distribution, or just gets saved to Memory Bridge. No tab switching. One place.

**Planned features:**
- YouTube feed integration (trending, subscriptions, search)
- Reddit/social aggregation (subreddits, trending topics)
- News feeds (local Oakland + world news + tech trends)
- Music integration (Spotify-like playback controls)
- Shopping surface (Amazon trending, deal alerts)
- **Act-on-it buttons** — see a trend → launch commerce pipeline; hear a beat → create content; read news → trigger distribution
- Content bookmarking with Memory Bridge persistence
- Perspective-aware recommendations ("based on your playbook patterns, this trend matches")

### Phase N+1: Cross-Tab Intelligence ✅ DONE

> **The system learns from what you browse. You don't change your habits. The system gets smarter.**

A context collector that watches browsing patterns across tabs (via the existing Chrome extension bridge or manual ingest) and feeds insights into Perspective + Memory Bridge. When the user opens Chandra, it already knows what they've been reading, watching, and shopping for — and connects the dots.

**Shipped (`2cc0680`):**
- ✅ Ollama content classification into 10 categories (tech, news, entertainment, shopping, social, research, finance, creative, education, other)
- ✅ Topic/entity extraction with sentiment and actionability scoring
- ✅ Automatic topic clustering with strength scoring
- ✅ Insight generation (emerging interests, cross-domain connections, suggestions)
- ✅ Perspective context injection — agents know what you've been browsing
- ✅ Memory Bridge integration for long-term pattern recognition
- ✅ 10 REST endpoints, 6 fleet tools, 3 workflow nodes
- ✅ CrossTab detail panel (5 tabs: Overview, Visits, Insights, Clusters, Ingest)
- ✅ 5-minute visit dedup, configurable retention pruning

### Forecast: System Growth Trajectory

| Metric | Current (Nov 2026) | Target (Q1 2027) | Target (Q2 2027) |
|--------|-------------------|-------------------|-------------------|
| Features | 79 | 90+ | 100+ |
| Agents | 33 | 40+ | 50+ |
| Pipelines | 12 | 16+ | 20+ |
| Nav Panels | 27 | 30+ | 35+ |
| Playbook Entries | Growing | 500+ patterns | 1000+ patterns |
| Arena Matches | Growing | 100+ completed | 500+ completed |

### Design Principles Going Forward

1. **Triple Integration** — Every new capability ships simultaneously as a REST endpoint, fleet tool, AND workflow node
2. **Intelligence-Wired** — Every new pipeline gets `createCommerceIntel` hooks (emotion analysis, memory recall, insight storage)
3. **Perspective-Aware** — Every new agent respects lens mode and receives `getActiveFraming()` injection
4. **TAG-not-BLOCK** — All LLM calls in user-facing paths use timeout races (3s for routing, 8s for assessment)
5. **Split-Brain** — For anything externally exposed (overlays, APIs, embeds): all IP stays server-side
6. **Governance-First** — New subsystems get Guard Tasks input validation, Strix budget laws, clock-honesty tagging

---

## CTRNN Neural Core — 256-Neuron Spatial Layout

The 16×16 CTRNN grid is organized into 10 functional bands mapped by the intelligence stack:

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

### Consciousness Gate Tiers

| Tier | Proofs Passed | Behavior |
|------|---------------|----------|
| DORMANT | 0/4 | Conservative — short reflection, tight OPEG gates, slow cycles |
| AWAKENING | 1–2/4 | Standard — balanced parameters, default autonomy |
| EMERGING | 3/4 | Active — deeper reflection, faster cycles, more neurogenesis |
| INTEGRATED | 4/4 | Full autonomy — bold reasoning, loose OPEG gates, 10 reflection actions, ambitious goals |

### The Full Perception → Action Loop

```
Sensory Bridge (5s) → Attention Gate → Habituation → Working Memory →
Predictive Processing → Active Inference → Motor Output (15s) →
Autonomous Actions → State Changes → Sensory Bridge detects change → loop
```

### The Numbers (Nov 2026 — Phase 20)

| Metric | Value |
|--------|-------|
| Intelligence Phases | 20 (perception + cognition + prediction/action) |
| CTRNN Neurons | 256 (16×16 grid) |
| Active Synapses | ~19,430 |
| Connectivity | ~29.6% |
| Agents | 133+ (18 core + 115 forged) |
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

---

## Credits

**Built by [eyeoverthink®](https://github.com/eyeoverthink)**

Reverse-engineered from 5 Base44 applications, unified into a single autonomous platform, and extended with 5 pipelines (4 commerce + Edit Rebuild), a full intelligence stack (Heart + Ledger + Dreamer + Cognition + Consciousness Proofs + Memory Bridge), vector memory, recursive self-improvement, a self-evolution engine, and a visual workflow engine.

**Core Technologies**: Node.js, Express, SQLite (better-sqlite3 WAL), Ollama, React, ReactFlow, Vite, WebSocket, Ed25519, SHA-256

---

## License

**Private — All rights reserved.**

Copyright (c) 2024-2026 eyeoverthink®. This software is proprietary and confidential. Unauthorized copying, distribution, or use is strictly prohibited.

---

<p align="center">
  <strong>CHANDRA-FRAYMUS</strong><br/>
  <em>Your store runs itself. Your agents forge new agents. Your system feels, dreams, reflects, and evolves itself.</em><br/><br/>
  Built with obsession by eyeoverthink®
</p>
