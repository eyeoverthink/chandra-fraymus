# Chandra-FRAYMUS — Phase History

Each phase has its own README documenting exactly what was built, which files changed, and what patterns were used. Any agent or contributor picking up work can read the latest phase README to know the full system state.

## Phase Index

| Phase | Title | Commit | Files Changed | README |
|-------|-------|--------|---------------|--------|
| 1 | Core Extraction — Base44 to local ESM | `c48e872` | Foundation | Pre-tracked |
| 2 | Intelligence REST Routes + Entity Schemas | `ede1889` | +routes, schemas, brain | Pre-tracked |
| 3 | Intelligence Stack → Autonomy + Dashboard | `6fb8287` | +autonomy, dashboard cards | Pre-tracked |
| 4 | Deep Integration — Memory Bridge + Workflow Nodes | `a1f1a25` | +bridge, workflow, fleet tools | Pre-tracked |
| 5 | Full Intelligence Wiring | `2a9f218` | +defs, canvas palette, memory bridge | Pre-tracked |
| 6 | Intelligence-Aware Fleet Agents | `f94293c` | +fleet runtime, memory search | Pre-tracked |
| 7 | Memory Bridge Through Workflow + Fleet | `05da88c` | +engine nodes, fleet wiring | Pre-tracked |
| 8 | Memory Recall Node + Dashboard Cards | `2ff3892` | +recall node/tool, health endpoint | Pre-tracked |
| 9 | Intelligence-Enriched Fleet + Autonomy Recall | `d41b096` | +fleet prompts, autonomy recall | Pre-tracked |
| 10 | Brain Intelligence + Commerce Hooks | `4c8533c` | +brain.js, commerce shared.js | Pre-tracked |
| 11 | Commerce Intelligence Completion | `8946889` | +4 pipelines wired, commerce tools | Pre-tracked |
| 12 | Runtime Intelligence Completion | `d88e7bd` | 9 files, 91 ins | [PHASE-12.md](PHASE-12.md) |
| 13 | Backend Visibility Completion | `021fab1` | 4 files, 351 ins | [PHASE-13.md](PHASE-13.md) |
| 14 | Workflow Canvas Polish | `6aa2f8d` | 4 files, 75 ins | [PHASE-14.md](PHASE-14.md) |
| 15 | Chandra Nexus — Unified Interface | `1fbdf04` | 10 files, 733 ins | [PHASE-15.md](PHASE-15.md) |
| 16 | Command Bar + Live Activity Stream | `9fdb842` | 7 files, 430 ins | [PHASE-16.md](PHASE-16.md) |
| 17 | Living Constellation | `05fc280` | 5 files, 174 ins | [PHASE-17.md](PHASE-17.md) |
| 18 | Offline-First Hardening | — | — | [PHASE-18.md](PHASE-18.md) |
| 19 | Hermes Full Fleet | — | — | [PHASE-19.md](PHASE-19.md) |
| 20 | Needle + Motor Live Dispatch | — | — | [PHASE-20.md](PHASE-20.md) |
| 21 | Deploy-as-API | — | — | [PHASE-21.md](PHASE-21.md) |
| 22 | Agent Live Bus | — | — | [PHASE-22.md](PHASE-22.md) |
| 23 | Event-Driven Orchestration + Agent Memory + Health | — | — | [PHASE-23.md](PHASE-23.md) |
| 24 | Agent Self-Evolution Engine | `a669e00` | 5 files | [PHASE-24.md](PHASE-24.md) |
| 25 | Generator-Verifier-Executor Loop | — | 4 files | [PHASE-25.md](PHASE-25.md) |
| 26 | Background Evolution Daemon | — | 4 files | [PHASE-26.md](PHASE-26.md) |
| 27 | NUDP/1 Sovereign Mesh Protocol | — | 7 files | [PHASE-27.md](PHASE-27.md) |
| 28 | Local Image Processing Engine | — | 6 files | [PHASE-28.md](PHASE-28.md) |
| 29 | Local Video Pipeline (ffmpeg) | — | 6 files | [PHASE-29.md](PHASE-29.md) |
| 30 | TTS Speech Engine | — | 6 files | [PHASE-30.md](PHASE-30.md) |
| 31 | Audio Transcription (STT) | — | 6 files | [PHASE-31.md](PHASE-31.md) |
| 32 | OCR Pipeline (Windows Media OCR) | — | 6 files | [PHASE-32.md](PHASE-32.md) |
| 33 | Media Hub Panel | — | 5 files | [PHASE-33.md](PHASE-33.md) |
| 34 | Error Boundary + System Resilience | — | 6 files | [PHASE-34.md](PHASE-34.md) |
| 35 | Agent Forge + Synthesis Panel | — | 4 files | [PHASE-35.md](PHASE-35.md) |
| 36 | System Settings Panel | — | 5 files | [PHASE-36.md](PHASE-36.md) |
| 37 | Notification Toast System | — | 3 files | [PHASE-37.md](PHASE-37.md) |

## Convention

Every new phase gets a `PHASE-{N}.md` in this directory with:
- **Summary** — what was built and why
- **Files Changed** — every file with what changed
- **Patterns Used** — architecture decisions for future reference
- **Running Counts** — system-wide totals (agents, tools, nodes, panels, etc.)
- **Navigation** — links to previous and next phase

This ensures any agent (Claude, Codex, or human) can pick up exactly where work left off.
