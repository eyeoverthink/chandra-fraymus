# Phase 19: Hermes Full Fleet + Agent Collaboration

**Date:** 2026-10-30
**Previous:** [Phase 18 — Offline-First Hardening](PHASE-18.md)
**Next:** *(next phase)*

---

## Summary

Phase 19 completes two critical gaps: the Hermes 30-skill fleet is now **fully wired** (all 30 skills have real executors), and **agent-to-agent delegation** is fixed so agents can hand off tasks to each other through the fleet runtime.

Every executor uses **free, local, offline tools only** — Ollama for LLM inference, ffmpeg for media, Whisper for transcription, Piper/espeak for TTS, ComfyUI+FLUX.1 for image generation, and local git/SSH for system ops. No paid APIs.

---

## Changes

### 1. Delegation Bug Fix (`server/fleet/runtime.js:211`)

The `executeTool()` function was calling `tool.execute({ args })` without passing the `ctx` (context) object. The `delegate_to_agent` tool needs `ctx` to access `ctx.delegate` for agent-to-agent handoff.

**Before:** `tool.execute({ args })` — delegation silently failed with "Delegation not available in this context"
**After:** `tool.execute({ args }, ctx)` — delegation now works, agents can hand tasks to each other

### 2. Hermes Skill Rename: `elevenlabs_tts` → `text_to_speech`

Renamed the media TTS skill from `elevenlabs_tts` (a paid API) to `text_to_speech` to align with the system's free/offline principle. The executor uses Piper (neural TTS), espeak (fallback), or Ollama SSML generation.

### 3. 16 New Hermes Executors (`server/fraymus-tools.js`)

All executors added to `buildHermesExecutors()` — 17 total new executors:

#### Research Category (1 new)
| Skill | Engine | What It Does |
|-------|--------|--------------|
| `trend_forecast` | DuckDuckGo + Ollama | Trend analysis and future trajectory forecasting |

#### Code Category (4 new)
| Skill | Engine | What It Does |
|-------|--------|--------------|
| `github_ops` | Local git CLI | Read-only git operations (status, log, branch, diff) |
| `repo_scaffold` | Ollama | Generates project structure from description |
| `dependency_audit` | Ollama | Analyzes package.json for vulnerabilities |
| `ci_runner` | Local npm/node | Runs safe CI commands (test, build, lint) |

#### Media Category (6 new — ALL FREE)
| Skill | Engine | What It Does |
|-------|--------|--------------|
| `text_to_speech` | Piper → espeak → Ollama | Neural TTS with fallback chain |
| `image_generation` | ComfyUI/FLUX.1 → Ollama | Local image gen or detailed descriptions |
| `video_render` | ffmpeg | Video encoding/filtering/rendering |
| `audio_mix` | ffmpeg | Multi-track audio mixing |
| `thumbnail_gen` | Ollama SVG | Generates SVG thumbnails with text/gradients |
| `subtitle_gen` | Whisper → Ollama | Local speech-to-text subtitles |

#### System Category (3 new)
| Skill | Engine | What It Does |
|-------|--------|--------------|
| `vps_command` | SSH | Remote command execution with safety checks |
| `deploy_app` | npm + Ollama | Build + deployment planning |
| `model_compile` | Ollama API | Creates custom Ollama models from modelfiles |

#### Intelligence Category (3 new)
| Skill | Engine | What It Does |
|-------|--------|--------------|
| `sherlock_investigate` | DuckDuckGo + Ollama | Multi-source deep investigation |
| `web_pentest` | fetch + Ollama | Security header analysis + OWASP assessment |
| `osint_gather` | DuckDuckGo + Ollama | Open source intelligence gathering + synthesis |

---

## Free Tool Stack

| Need | Tool | Status |
|------|------|--------|
| LLM inference | Ollama (fraynix-dreamer-ultimate:8b) | Installed |
| Image generation | ComfyUI + FLUX.1 schnell | Install for full image gen |
| TTS / Voice | Piper (neural) or espeak | Install for audio output |
| Transcription | OpenAI Whisper (local) | Install for subtitle gen |
| Video/Audio | ffmpeg | Install for media processing |
| Web search | DuckDuckGo HTML scraping | Built-in |
| Git ops | Local git CLI | Built-in |
| Remote ops | SSH | Built-in |

---

## Hermes Fleet Status: 30/30 Wired

| Category | Skills | Executors |
|----------|--------|-----------|
| Research | 6 | 6/6 (duckduckgo_search, web_scrape, target_analysis, deep_research, news_scan, trend_forecast) |
| Code | 6 | 6/6 (github_ops, code_generation, code_review, repo_scaffold, dependency_audit, ci_runner) |
| Media | 6 | 6/6 (text_to_speech, image_generation, video_render, audio_mix, thumbnail_gen, subtitle_gen) |
| System | 6 | 6/6 (ollama_manage, vps_command, deploy_app, model_compile, db_query, log_analysis) |
| Intelligence | 6 | 6/6 (sherlock_investigate, web_pentest, osint_gather, anomaly_detect, pattern_match, sentiment_analyze) |

---

## Files Changed

- `server/fleet/runtime.js` — Fixed `executeTool()` to pass `ctx` to `tool.execute()` (line 211)
- `server/fraymus/intelligence/hermes.js` — Renamed `elevenlabs_tts` → `text_to_speech`
- `server/fraymus-tools.js` — Added 17 new executor functions to `buildHermesExecutors()`
- `phases/PHASE-18.md` — Updated next link
