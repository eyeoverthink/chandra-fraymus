# MANIFEST — chandra-fraymus (the load-map for agents + the app)

> Owner: Vaughn D. Scott — eyeoverthink® Productions LLC. Private.
> Purpose: ANY agent (Chandra runtime, the partner app, a fresh seat) reads this
> ONE file and knows what lives here, where, and what to pull for what.
> Branch: `master` · current commit: `01cf653` · 454 tracked files.

| Path | What it is | Pull it when you need |
|---|---|---|
| `README.md` | The platform: vision, quick start, intelligence stack, commerce pipelines, API reference, architecture | explaining the platform, selling it, wiring docs |
| `MANIFEST.md` | This load-map | orienting before anything |
| `INTEGRATION.md` | The integrated-agent design + evidence: Chandra (server/SQLite ledger/policy) + MyAIPartner (conversation/attachments/approvals) + fraymus-voice (speech, STT, voice memory) | wiring the apps together |
| `voice/` | **Chandra's voice** — 3-engine pipeline: Mac F5-MLX clone (live/proven), box CUDA F5 via :9097 tunnel (0.48s/word), ElevenLabs tier in Base44. `myvoice` = Vaughn's clone; owner fallback law: his copy ALWAYS speaks | **voice/speech for Chandra — start at `voice/VOICE-PIPELINE-README.md`** |
| `voice/bin/partner-voice-proxy` | The contract port :9099 with the owner-fallback law | running the merged voice front |
| `voice/bin/local-voice-server.py` | The Mac/Windows local bridge (+Honcho memory, emotion) | self-hosting the voice server |
| `voice/bin/probe_f5_cuda.py` | CUDA F5 self-test + clone proof on the box | bringing the fast lane up |
| `opeg-protocol/` | **The OPEG operational protocol — Vaughn's IP** (7 docs + lineage): Empirical-Grounding FULL, Clear-Writing/Goalobject, TASKA-RSAN merged math, Gemini Ep3 Puiseux execution, RSAN/Ollama payloads, One-paste console, Grok-vs-Gemini comparison. Lineage: Protocol Zero → Bicameral → v13-16, OPEG = gateway tier | **the protocol layer — start at `opeg-protocol/00-README-protocol-lineage.md`** |
| `server/` | The platform runtime (193 files): 26-agent fleet brain, autonomy engine, command router, commerce (Shopify/Printify), Ouroboros RSI, Vertiso memory bridge, SQLite run ledger + policy boundary, audio, automations, daemon | running/extending the platform |
| `server/agent-profiles.js` + `server/agents/` | The agent definitions (roles, budgets, skills) | minting/routing agents |
| `agents/` | The 17-fleet character sheets (ariadne, cantor, concierge, dev_archivist, director, eye_sovereign…) | persona/casting for the fleet |
| `client/` | The web UI (workflow canvas dashboard, React/JSX, global search) | UI work |
| `phases/` | PHASE-12 … build phases — the platform's evolution log | history / what changed when |
| `docs/` | Skill + subsystem docs: audio, coding, desktop, local-vision/OCR, execution audit, reasoning budgets, FRAYMUS-OS-ONE abstraction, SYSTEM-AUDIT | per-domain know-how |
| `extension/` | The browser extension (manifest/popup/content/background) | the extension build |
| `assets/`, `scripts/`, `test/`, `.claude/` | Images, utility scripts, 16 tests, Claude config | support |

## The two doors (the new 2026-11-01 folders)
1. **Voice door:** `voice/VOICE-PIPELINE-README.md` → one curl on :9099 → Chandra speaks in Vaughn's cloned voice.
2. **Protocol door:** `opeg-protocol/00-README-protocol-lineage.md` → the owned protocol line + the operational docs.

Secrets live ONLY on the box / Base44 / hub (`00-VAUGHN` law in fraymus-mind) — never here.