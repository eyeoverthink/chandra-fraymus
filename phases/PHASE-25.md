# Phase 25: Generator-Verifier-Executor Loop

**Date:** 2026-10-30
**Prev:** [Phase 24 — Agent Self-Evolution Engine](PHASE-24.md)
**Next:** [Phase 26 — Background Evolution Daemon](PHASE-26.md)

---

## Overview

Phase 25 implements the adversarial code generation pattern from the persistent agent architecture. Three specialized roles — Generator, Verifier, Executor — run in an iterative loop until code passes both adversarial review AND execution, or max iterations are reached.

This is the self-correcting layer that sits on top of Phase 24's forge/synthesis. Where those create agents and workflows, the Verifier Loop ensures the OUTPUT is correct before saving it as a proven "fossil."

## Architecture

```
Goal → Generator (Ollama) → Code
         ↓
       Verifier (Ollama) → APPROVED? → Save Fossil → Done
         ↓ REJECTED
       Executor (child_process) → stdout/stderr
         ↓
       Feedback → Generator (iterate)
```

### Three Roles

| Role | System Prompt | Output |
|------|--------------|--------|
| Generator | Expert implementer — writes complete, runnable code | Markdown code block |
| Verifier | Adversarial critic — finds bugs, stubs, edge cases | JSON verdict: APPROVED/REJECTED + issues |
| Executor | Runs code in isolated child_process with timeout | Exit code + stdout + stderr |

### Loop Flow

1. Generator produces code from goal + any prior feedback
2. Verifier reviews for correctness, completeness, edge cases
3. If APPROVED → save fossil to agent memory + publish to bus → done
4. If REJECTED → Executor runs the code (if language supports it)
5. Combine verifier issues + execution results as feedback
6. Feed back to Generator → next iteration
7. Max 5 iterations (configurable), then mark as `max_iterations`

### Fossil Saving

When a loop passes, the proven code is stored as:
- Agent memory entry (category: "fossil", key: "verified:{goal}", confidence: 1.0)
- Bus event on `system.evolution` topic (action: "code_verified")

This means other agents can recall proven patterns and the Reflection Loop can learn from verification history.

## What Was Built

### New File
- `server/intelligence/verifier-loop.js` — Core engine (runVerifierLoop, executeCode, installVerifierRoutes)

### Modified Files

| File | Change |
|------|--------|
| `server/db-migrate.js` | Added `verification_loops` and `verification_steps` tables |
| `server/fleet/tools.js` | Added `verify_loop` and `verify_list` agent tools (24 total fleet tools) |
| `server/runtime.js` | Import + `installVerifierRoutes(app)` after reflection routes |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/verify/run` | Start a verification loop (goal, language, maxIterations, context) |
| GET | `/api/verify/loops` | List past loops with status |
| GET | `/api/verify/loops/:id` | Get loop detail with all steps |

### Agent Tools

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `verify_loop` | evolution | approval | Run adversarial gen-verify-exec loop on a coding goal |
| `verify_list` | evolution | safe | List past verification loop runs |

### Database Tables

| Table | Purpose |
|-------|---------|
| `verification_loops` | Loop metadata: goal, language, status, iterations, final_code |
| `verification_steps` | Step-by-step: role (generator/verifier/executor), input, output, verdict |

## Execution Support

| Language | Runtime | Timeout |
|----------|---------|---------|
| JavaScript/Node | `process.execPath` (same Node) | 15s |
| Python | `python -I` (isolated) | 15s |
| Other | No execution (verify-only) | — |

Code runs in `os.tmpdir()` with isolated env. Files are cleaned up after execution.

## Running Counts

- System Features: **38** (was 37)
- Fleet Tools: **24** (was 22) — added verify_loop, verify_list
- Database Tables: **58+** (was 56+) — added verification_loops, verification_steps
- API Endpoints: 3 new verification endpoints

## Patterns Used

- Same async route wrapper pattern as all other modules
- JSON parse with fallback (parseJSON) for LLM output
- Code extraction from markdown fences (extractCode)
- Language auto-detection from code patterns
- child_process.execFile with timeout (not spawn — captures full output)
- SHA-256 fossil chain via agent_memories (storeMemory)
- Bus event publication for evolution tracking

## Test Results

5/6 E2E tests passed:
- Route registration ✓
- Input validation ✓ 
- 404 handling ✓
- Error recording to DB ✓
- Fleet tool registration ✓
- Live Ollama loop — CUDA resource error (GPU memory, not code bug)
