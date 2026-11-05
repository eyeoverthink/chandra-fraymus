# Reverse Engineer Agent — Chandra Integration Spec

> **Status:** APPROVED FOR IMPLEMENTATION  
> **Author:** Vaughn Scott + Claude  
> **Date:** 2026-11-05  
> **Source repo:** `github.com/eyeoverthink/fraymus-re-agent`  
> **Review:** Another agent will independently verify each phase against this document.

> **Independent review checkpoint — 2026-11-05:** [Changes requested](reviews/2026-11-05-re-integration-spec-review.md) for the raw receipt transport/format, manifest contract, measured compile-rate baseline, and downstream wiring. [Progress tracker](RE-AGENT-PROGRESS.md): 0/7 phases implemented and 0/41 acceptance criteria independently passed at `1eabcde`. The approval label above is the author's planning status; it is not an independent implementation verdict.

> **Correction recheck of `5e23e01` — 2026-11-05:** [Not all findings are closed](reviews/2026-11-05-re-spec-fix-review.md). The revised manifest passes its ten-tool parser check, but Phase 1 hashing/trust/delivery contracts and Phase 6 workflow execution still need correction. Actual progress is 0/7 implemented and 0/56 criteria verified. The independent reviewer has not started implementation.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Source Inventory](#2-source-inventory)
3. [Architecture Mapping](#3-architecture-mapping)
4. [Phase 1 — Hive Bus Bridge](#phase-1--hive-bus-bridge)
5. [Phase 2 — RE Agent Manifest + Fleet Tools](#phase-2--re-agent-manifest--fleet-tools)
6. [Phase 3 — Dossier Ingestion Engine](#phase-3--dossier-ingestion-engine)
7. [Phase 4 — Red/Blue → Debate Engine Bridge](#phase-4--redblue--debate-engine-bridge)
8. [Phase 5 — CTRNN Sensory Integration](#phase-5--ctrnn-sensory-integration)
9. [Phase 6 — Autonomous Pipeline Wiring](#phase-6--autonomous-pipeline-wiring)
10. [Phase 7 — Cross-Machine Dream Bridge](#phase-7--cross-machine-dream-bridge)
11. [Verification Gates](#verification-gates)
12. [Files Created/Modified Per Phase](#files-createdmodified-per-phase)

---

## 1. Overview

### What the RE Agent Is

A **proven binary reverse engineering organism** built on 7 upstream tools, operating entirely offline on Vaughn's iMac (darwin-arm64). It has 18 verified build gates (per `BUILD-GATES.md`), produces sealed dossiers of decompiled binaries, and communicates through an append-only SHA-256 hash-chained receipt bus ("hive bus").

### What This Integration Does

Bridges the RE Agent's output and intelligence into Chandra-FRAYMUS as a first-class subsystem. Binary analysis results become bus events, agent memories, debate inputs, and CTRNN sensory signals — the same way Chandra already handles runtime intelligence, but for binary-level structural analysis.

### What This Does NOT Do

- Does NOT run Ghidra or radare2 on the Windows box (those stay on iMac)
- Does NOT replace any existing Chandra subsystem
- Does NOT require any paid APIs or cloud services
- Does NOT modify the RE Agent's own scripts or toolchain

---

## 2. Source Inventory

### Upstream Tools (all on iMac, pinned in MANIFEST.md)

| Tool | Size | SHA-256 Pin | Role |
|------|------|-------------|------|
| Ghidra 12.3 DEV | 355M | *placeholder — verify against MANIFEST.md* | Deep lane decompiler (headless Java, JDK 25) |
| radare2 6.2.5 | 87M | *placeholder — verify against MANIFEST.md* | Speed lane (rabin2 -I/-i/-E, r2 -A) |
| LLM4Decompile | 159M | *placeholder — verify against MANIFEST.md* | Prompt library + compile-rate eval harness |
| r2ai (decai) | 4.0M | *placeholder — verify against MANIFEST.md* | In-r2 Ollama-native LLM plugin |
| ida-pro-mcp | 6.2M | *placeholder — verify against MANIFEST.md* | MCP tool-surface donor (patterns only) |
| ReVa | 4.1M | *placeholder — verify against MANIFEST.md* | Ghidra MCP bridge |
| rea-agents | 101M | *placeholder — verify against MANIFEST.md* | Orchestrator shell (5,810 TS files) |

> **Note (RE-08 fix):** All SHA-256 prefixes above are placeholders. The authentic pins live in the upstream repo's `MANIFEST.md` at commit `2f75cee7`. During Phase 2 setup, each pin must be verified against the actual archive bytes before storing as confidence-1.0 memories. Short prefixes never verify archive integrity.

### Key Scripts (all in `scripts/` of RE repo)

| Script | Language | Function |
|--------|----------|----------|
| `fra-pipeline.sh` | Bash | Main 5-stage pipeline: r2 triage → Ghidra headless → annotate → red/blue → seal |
| `fra-triage.sh` | Bash | Fast r2-only triage (seconds, not minutes) |
| `fra-annotate.py` | Python | LLM annotation + red/blue scoring + import verification |
| `fra-eval.py` | Python | Compile-rate measurement (clang -fsyntax-only) + LLM repair pass |
| `hive-receipts.py` | Python | Append-only SHA-256 hash-chained receipt bus |
| `hive-plan.py` | Python | Goal planner with whitelisted verbs (analyze/ask/dream/todo/status) |
| `hive-nightly.sh` | Bash | Cross-machine dream cron (iMac → Windows over Tailnet) |
| `decompile_all.java` | Java | Ghidra GhidraScript (deep lane, 90s timeout per function) |

### Proven Output (from `/bin/ls` analysis)

- **r2 triage:** 135 functions, 92 imports, 450 strings
- **Ghidra deep lane:** 136 functions → 5,152 lines of decompiled C
- **Import verification:** 3/78 verified (printf, putchar, strlen)
- **Compile-rate baseline:** NOT MEASURED — upstream script's `blocks()` function splits `re.split()` output incorrectly, producing 181 fragments from 136 functions. The quoted 45/181 = 24.9% is a parser-corrupted ratio. Correct baseline requires: fix function extraction to use `re.findall()` (136 proper records), then re-run `clang -fsyntax-only` per function. Until re-measured, treat compile-rate as unknown.
- **Raw hive bus chain:** INTACT (13 receipts in `hive/receipts.jsonl`, verified by upstream `hive-receipts.py verify`)
- **Windows landing file:** 9 projected records in `hive_genesis.jsonl` — fields `ts, type, src, msg, seal` ONLY. No `prev`/`self` chain fields. Chain verification IMPOSSIBLE on the projection; integrity is UNVERIFIABLE from this file alone.
- **Nightly cron:** Active (launchd plist, 3:30 AM daily) — transports the **projection**, not the raw receipts

---

## 3. Architecture Mapping

Every RE Agent component has a direct Chandra counterpart:

| RE Agent Component | File | Chandra Counterpart | File | Integration Type |
|---|---|---|---|---|
| Hive receipt bus | `hive-receipts.py` | Agent Live Bus | `fleet/bus.js` | Protocol bridge (JSONL → bus events) |
| Red/blue scoring | `fra-annotate.py` | Debate engine | `intelligence/debate.js` | Scoring format bridge |
| Sealed dossier | `dossier.seal` | Integrity watchdog | `integrity/watchdog.js` | Hash verification |
| Akashic ledger | `feed-akashic` | Cognitive ledger | `fraymus/intelligence/ledger.js` | JSONL format bridge |
| Compile-rate eval | `fra-eval.py` | Verifier loop | `intelligence/verifier-loop.js` | Approval gate mapping |
| Planner verbs | `hive-plan.py` | Goal engine | `intelligence/goal-engine.js` | Verb → OPEG proposal |
| Nightly dream | `hive-nightly.sh` | Daemon engine | `daemon/engine.js` | Dream consolidation input |
| Build gates | `BUILD-GATES.md` | Agent memories | `fleet/agent-memory.js` | Verified fossils (confidence 1.0) |
| Dossier output | `dossier-*/` | Agent memories | `fleet/agent-memory.js` | Binary knowledge store |

---

## Phase 1 — Hive Bus Bridge

### Goal
Ingest hive data into Chandra's pub/sub bus so every existing subsystem can react to RE events. Handle TWO distinct input formats: raw receipts (chain-verifiable) and the akashic projection (chain-unverifiable).

### Why First
The nightly cron already pushes `hive_genesis.jsonl` to `C:/Users/eyeka/hive/hive_genesis.jsonl`. This file lands on the Windows box daily. Bridging it into Chandra's bus requires ONE new module and unlocks all downstream integration (bus triggers → workflows, metacognitive awareness, reflection loop input).

### Critical Format Distinction (RE-01 fix)

The upstream hive has TWO file formats with different schemas and integrity guarantees:

**Raw receipts** (`hive/receipts.jsonl` on iMac):
```json
{ "organ": "fra-pipeline", "type": "dossier", "claim": "...", "evidence": {...},
  "seal": "<sha256>", "i": 0, "ts": "ISO-8601", "prev": "<64 zeroes for genesis>",
  "self": "<sha256 of payload>" }
```
- Full chain: `self` = SHA-256 of `json.dumps(record_without_self, sort_keys=True)` with Python default spacing
- `prev` links to prior receipt's `self`; genesis uses 64 zeroes
- 13 records at reviewed commit; chain verified INTACT by upstream verifier
- NOT currently transported by the nightly cron

**Akashic projection** (`hive_genesis.jsonl` on Windows):
```json
{ "ts": "ISO-8601", "type": "LEDGER_EVENT", "src": "fra-pipeline:dossier",
  "msg": "...(truncated to 120 chars)...", "seal": "..." }
```
- NO `prev`, `self`, `i`, `organ`, `claim`, or `evidence` fields
- `src` is a remapped compound of raw `organ:type`
- `msg` is a truncated `claim` (120 char limit)
- `seal` may be a shortened self-hash, not the raw seal
- 9 records on Windows at reviewed commit
- Chain verification IMPOSSIBLE — omitted fields cannot be reconstructed
- This IS what the nightly cron delivers

### Setup Step: Raw Receipt Transport

The nightly cron (`hive-nightly.sh`) transports only the projection. To enable chain verification, add an independent transport for raw receipts:

**Option A (recommended):** Add one SCP line to `hive-nightly.sh`:
```bash
scp -q $HOME/fraymus-re/hive/receipts.jsonl "eyeka@100.88.61.56:C:/Users/eyeka/hive/receipts.jsonl"
```
This is an iMac-side change — document it but don't implement it from Chandra.

**Option B:** Chandra polls via Tailnet SSH read (adds latency, external dependency).

**Until raw transport exists**, Chandra ingests only the projection as unverifiable events and does NOT publish trusted chain-status claims.

### New Files

#### `server/intelligence/hive-bridge.js`
The ingestion engine. Responsibilities:
- Detect input format by field presence: `prev` + `self` + `organ` = raw; `src` + `msg` = projection
- **Raw format ingestion:**
  - Verify chain: `self` = SHA-256 of `JSON.stringify(payloadWithoutSelf, sortedKeys)` with Python-compatible canonicalization (sorted keys, no extra spacing)
  - Verify `prev` links to prior receipt's `self`; genesis `prev` = 64 zeroes
  - Map to bus topic: `hive.<organ>:<type>` (e.g., `hive.fra-pipeline:dossier`)
  - Publish chain status: `INTACT` or `DAMAGED` with break index
  - Byte-level canonicalization: pin fixtures for ASCII, Unicode, nested objects, numeric values, and genesis
- **Projection format ingestion:**
  - Map to bus topic: `hive.<src>` (e.g., `hive.fra-pipeline:dossier`)
  - Mark ALL ingested events with `chainVerified: false`
  - Do NOT publish chain integrity claims
  - Do NOT advance a trusted watermark
  - Do NOT allow projection events to trigger trusted downstream actions (e.g., OPEG proposals at confidence 1.0)
- **Shared:**
  - Track ingestion watermark in SQLite per source file (separate watermarks for raw vs projection)
  - Deduplicate by receipt content hash (handles file replacement/rotation)
  - Bound source reads: configurable max file size (default 10MB), reject partial trailing lines
  - Crash-restart safe: watermark updated only after successful bus publish

**Functions to export:**
```
ingestHiveFile(path?) → { format: 'raw'|'projection', ingested, skipped, chainStatus?, errors }
verifyHiveChain(path?) → { total, intact, breakIndex?, format }
getIngestionStats() → { lastRun, totalIngested, rawCount, projectionCount, chainStatus }
detectFormat(firstLine) → 'raw' | 'projection' | 'unknown'
```

**DB table:** `hive_ingestion` (id, receipt_hash, source_format, receipt_index, topic, chain_verified, ingested_at)

#### `server/intelligence/hive-bridge-routes.js`
REST API for the bridge:
- `GET /api/intelligence/hive-bridge` — ingestion stats + chain status + format breakdown
- `GET /api/intelligence/hive-bridge/receipts` — paginated receipt list (from DB), filterable by `?format=raw|projection`
- `POST /api/intelligence/hive-bridge/ingest` — trigger manual ingestion (body: `{ path?, format? }`)
- `POST /api/intelligence/hive-bridge/verify` — verify chain without ingesting (raw format only; returns error for projection)

### Modified Files

#### `server/runtime.js`
- Import and call `installHiveBridgeRoutes(app, { db, publish })` after other intelligence routes
- Add hive bridge to health check subsystem count

### Verification Gate 1
- [ ] `hive_ingestion` table created on startup
- [ ] **Format detection:** raw receipts detected by `prev`/`self`/`organ` presence; projection detected by `src`/`msg` presence
- [ ] **Raw ingestion:** sample raw receipts produce bus events on `hive.*` topics with `chainVerified: true`
- [ ] **Projection ingestion:** sample projection produces bus events with `chainVerified: false`
- [ ] **Chain verification:** detects a tampered raw receipt (flip one byte, re-run verify); returns error for projection input
- [ ] **Watermark + dedup:** run ingest twice on same file, second returns `skipped > 0`; handles file rotation (different content, same path)
- [ ] **Crash safety:** kill during ingestion, restart, no duplicate bus events
- [ ] **Invalid input:** damaged/unverifiable input does NOT publish trusted downstream events
- [ ] `GET /api/intelligence/hive-bridge` returns stats with format breakdown
- [ ] Bus subscribers receive hive events (check via `GET /api/fleet/bus/history/hive.fra-pipeline:dossier`)

---

## Phase 2 — RE Agent Manifest + Fleet Tools

### Goal
Register a Tycho-class RE Agent in the fleet with tools for binary analysis operations.

### Why Second
With the bus bridge live, the RE Agent needs a manifest so it can be tasked through the fleet system, and tools so it can be invoked from workflows and other agents.

### New Files

#### `agents/re-analyst.md` (RE-02 fix: top-level `agents/` directory, NOT `server/fleet/agents/`)

> **Path rationale:** Chandra's manifest loader (`server/fleet/manifest.js`) reads `DEFAULTS_DIR = resolve(DATA_DIR, '..', 'agents')` — the top-level `agents/` directory relative to the data directory parent. It does NOT scan `server/fleet/agents/`. The existing Tycho agent (`agents/rea_analyst.md`) is a web/artifact reconstruction analyst and is NOT replaced by this new manifest.

Agent manifest (comma-separated tools — RE-02 fix: YAML lists are NOT supported by Chandra's parser; empty or unparseable `tools:` values default to `'*'` wildcard):
```yaml
---
id: re-analyst
name: RE Analyst
role: Binary reverse engineering — structural analysis, decompilation review, import verification
tools: re.ingest_dossier, re.verify_chain, re.query_dossier, re.build_gate_lookup, re.compile_rate_measure, re.compile_rate_predict, bus_publish, bus_read, agent_remember, agent_recall
---
```

> **Verification requirement:** After creating this file, assert that `GET /api/agents` returns `re-analyst` with exactly 10 tools (not `'*'`). If the agent shows wildcard permissions, the comma-separated format was not parsed correctly.

System prompt instructs the agent to:
- Analyze dossier contents (decompiled C, imports, annotations, seals)
- Cross-reference import verification against annotation claims
- Report compile-rate baselines and improvement opportunities
- Store binary structural knowledge as agent memories (category `binary_dossier`)
- Cite evidence: every claim must reference a specific function address, import name, or line count
- Use red/blue scoring semantics: agreement is measured, not assumed

#### `server/fleet/re-tools.js` (unchanged path — this IS under `server/fleet/`, which is correct for tool definitions)
Fleet tools for RE operations:

**`re.ingest_dossier`** (safety: `safe`)
- Parameters: `{ dossierPath: string }`
- Reads a dossier directory (decompiled.c, annotations.md, imports.txt, binary.sha256, dossier.seal)
- Parses each file into structured data
- Stores as agent_memories entries (category `binary_dossier`, keys: `binary_sha256`, `function_count`, `import_count`, `compile_rate`, `annotations`, `seal`)
- Verifies dossier seal with three possible states (RE-08 fix):
  - `valid` — SHA-256 of sorted canonical file manifest matches seal file
  - `invalid` — hash mismatch (potential tampering)
  - `unverifiable` — seal file present but original file list/bytes unknown (e.g., missing `ghidra.log` that pipeline includes, or stale seal from prior run)
- Seal verification requires a retained per-file manifest excluding the seal itself; the pipeline seals every file in the directory (including generated `ghidra.log` and potentially a stale `dossier.seal` from reruns). The committed dossier subset may not reproduce the original seal — this is NOT evidence of tampering.
- Returns: `{ binary, functionCount, importCount, sealStatus: 'valid'|'invalid'|'unverifiable', sealDetail?, memoriesStored }`

**`re.verify_chain`** (safety: `safe`)
- Parameters: `{ path?: string }`
- Wraps `verifyHiveChain()` from hive-bridge.js
- Returns: `{ total, intact, breakIndex? }`

**`re.query_dossier`** (safety: `safe`)
- Parameters: `{ binarySha?: string, functionName?: string, query?: string }`
- Searches agent_memories with category `binary_dossier`
- Returns matching entries with their confidence scores and verification status

**`re.build_gate_lookup`** (safety: `safe`)
- Parameters: `{ keyword: string }`
- Searches agent_memories with category `build_gate` for known build failure patterns
- Returns matching gates with their fix descriptions
- Pre-populated from BUILD-GATES.md (18 numbered entries — RE-08 fix: upstream document has 18, not 19). Each gate stored as agent_memory with confidence 0.9 (documented, not reproduced on this machine). Confidence upgraded to 1.0 only when the fix is independently reproduced on Windows.

**`re.compile_rate_measure`** (safety: `safe`) — RE-03 fix: actual compiler measurement, NOT model opinion
- Parameters: `{ dossierPath: string }`
- Reads `decompiled.c`, splits by `// ==== name @ addr ====` markers using `findall()` pattern (NOT `split()` — the upstream `re.split()` bug produces 181 fragments from 136 functions)
- For each function: extracts name + address + body, wraps in minimal C stub with necessary headers
- Runs `clang -fsyntax-only` per function (when clang is available on PATH)
- Retains per-function: name, address, return code, diagnostics (compiler errors/warnings)
- Returns: `{ total, compilable, rate, compiler: 'clang'|'not_available', failing: { name, addr, diagnostics }[] }`
- When clang is NOT available: returns `{ total, compilable: null, rate: null, compiler: 'not_available', message: 'No compiler found — compile rate is not measured' }`
- NEVER stores `compiler: 'not_available'` results as verified memories or confidence-1.0 facts

**`re.compile_rate_predict`** (safety: `safe`) — LLM prediction fallback (explicitly labeled as model opinion)
- Parameters: `{ dossierPath: string }`
- Same function extraction as `re.compile_rate_measure`
- For each function, asks Ollama: "Would this C code compile with clang? Answer YES or NO with one-sentence reasoning."
- Returns: `{ total, predicted_compilable, predicted_rate, model: string, disclaimer: 'LLM prediction — not a compiler measurement' }`
- Stored in agent_memories with confidence 0.4 (unverified grade), NOT 1.0
- Labeled `evidence_type: 'llm_prediction'` in all stored memories and bus events

### Modified Files

#### `server/fleet/tools.js`
- Import `createRETools` from `./re-tools.js`
- Spread into the tools array alongside existing fleet/intelligence/carbon tools

#### `server/runtime.js`
- No changes needed (manifest auto-discovered by `manifest.js`)

### Phase 2 / Phase 3 Dependency Note (RE-06 fix)

Phase 2 registers the agent manifest and tool stubs. Phase 3 implements the actual dossier parsing/grading/storage engine. Several Phase 2 tools (`re.ingest_dossier`, `re.query_dossier`, `re.compile_rate_measure`, `re.compile_rate_predict`) require the Phase 3 dossier engine to function.

**Resolution:** Phase 2 verification gates are split into two tiers:
- **Gate 2A (Phase 2 only):** Agent registration, manifest discovery, tool registration, chain verification, build-gate lookup — these work without Phase 3
- **Gate 2B (after Phase 3):** Dossier ingestion, querying, compile-rate measurement — these require the dossier engine

Do NOT pass Gate 2B with stub implementations. Do NOT duplicate the dossier parser in Phase 2 tools. Phase 2 tools that depend on Phase 3 should import from `dossier-engine.js` once it exists.

### Verification Gate 2A (Phase 2 standalone)
- [ ] `curl http://127.0.0.1:8787/api/agents` shows `re-analyst` with exactly 10 tools (NOT wildcard `'*'`)
- [ ] `re.verify_chain` returns chain status (raw format: verified; projection format: unverifiable)
- [ ] `re.build_gate_lookup` returns relevant gates for keywords like "JDK", "dylib", "npm"
- [ ] 18 build-gate memories stored at confidence 0.9 (not 1.0 — not reproduced on this machine)
- [ ] Existing Tycho agent `rea_analyst` still functions (not replaced or broken)
- [ ] RE Analyst agent can be tasked via `POST /api/fleet/runs` and responds

### Verification Gate 2B (after Phase 3 — dossier-dependent tools)
- [ ] `re.ingest_dossier` with a sample dossier directory stores memories correctly
- [ ] `re.query_dossier` retrieves stored dossier data by binary SHA or function name
- [ ] `re.compile_rate_measure` returns compiler results when clang is available, or `compiler: 'not_available'` when not
- [ ] `re.compile_rate_predict` returns LLM predictions labeled as `evidence_type: 'llm_prediction'`

---

## Phase 3 — Dossier Ingestion Engine

### Goal
Automated dossier processing pipeline that transforms raw RE output into structured agent knowledge with evidence-grade integrity.

### Why Third
With the agent and tools live, we need the actual intelligence extraction pipeline that turns raw dossier files into first-class Chandra knowledge.

### New Files

#### `server/intelligence/dossier-engine.js`
The core processing engine. Responsibilities:

**Dossier Parser:**
- `parseDecompiledC(text)` — split by `// ==== name @ addr ====` markers, extract function name, address, line count, body
- `parseAnnotations(text)` — extract per-function annotations, import verification counts, red/blue agreement scores
- `parseImports(text)` — parse rabin2 output (pipe-delimited columns) into structured import list
- `parseDossierSeal(text)` — extract SHA-256 chain value, verify against sorted file manifest

**Evidence Grading:**
- Each fact extracted from a dossier gets an evidence grade:
  - `measured` — directly from tool output (function count, import count, compile rate)
  - `verified` — cross-checked against another source (import verification: model claim vs r2 table)
  - `annotated` — LLM-generated with evidence citation (function descriptions)
  - `unverified` — LLM-generated without evidence (red/blue disagreement or empty responses)

**Knowledge Storage:**
- Store each function as an agent_memory entry:
  - key: `fn:<name>@<addr>`
  - value: JSON with `{ c: string, lines: number, annotations: object[], importHits: string[], compileStatus: boolean }`
  - confidence: derived from evidence grade (measured=1.0, verified=0.9, annotated=0.7, unverified=0.4)
  - category: `binary_dossier`
  - source: `re-analyst`

**Aggregate Storage:**
- Store per-binary summary as agent_memory:
  - key: `binary:<sha256_prefix>`
  - value: JSON with `{ path, sha256, functionCount, importCount, compileRate, sealValid, topFunctions, annotationCoverage }`
  - confidence: 1.0 (measured facts)

**Functions to export:**
```
parseDossier(dossierDir) → { binary, functions[], imports[], annotations, seal, summary }
gradeDossier(parsed) → { facts: { key, value, grade, confidence }[] }
storeDossier(graded, agentId) → { stored, skipped, errors }
processDossier(dossierDir) → { parsed, graded, stored, busEvents }
```

**DB table:** `dossier_ingestions` (id, binary_sha256, dossier_path, function_count, import_count, compile_rate, seal_valid, evidence_grades, created_at)

#### `server/intelligence/dossier-engine-routes.js`
REST API:
- `GET /api/intelligence/dossier` — list ingested dossiers
- `GET /api/intelligence/dossier/:sha` — get specific dossier summary + functions
- `POST /api/intelligence/dossier/process` — process a dossier directory
- `GET /api/intelligence/dossier/:sha/functions` — list functions in a binary
- `GET /api/intelligence/dossier/:sha/functions/:name` — get single function detail with annotations

### Modified Files

#### `server/runtime.js`
- Import and call `installDossierRoutes(app, { db, publish, storeMemory })`

### Verification Gate 3
- [ ] `parseDossier()` correctly extracts 136 functions from the `/bin/ls` dossier
- [ ] Evidence grading assigns correct grades (measured for counts, verified for import hits)
- [ ] `storeDossier()` creates agent_memory entries with correct confidence scores
- [ ] `processDossier()` publishes bus events on `system.re.dossier.processed`
- [ ] REST API returns dossier data, function listings, and individual function details
- [ ] Dossier seal verification catches a tampered dossier (modify one file, re-process)

---

## Phase 4 — Red/Blue → Debate Engine Bridge

### Goal
Feed RE Agent's red/blue annotation scores into Chandra's adversarial debate engine, so binary analysis gets the same adversarial pressure as autonomous decisions.

### Why Fourth
The RE Agent already runs dual-model scoring (llama3 vs phi3/qwen3.5) and measures agreement via Jaccard index of shared noun tokens. Chandra's debate engine (`intelligence/debate.js`) runs proponent/opponent rounds. Bridging them means binary annotations are validated through the same adversarial framework.

### Modified Files

#### `server/intelligence/debate.js`
Add a new debate topic type: `binary_annotation`

**New function:** `debateBinaryAnnotation(functionData, opts)`
- Takes a function's decompiled C + existing annotations
- Proponent: "This function does X based on the following evidence: [annotations]"
- Opponent: "Challenge the proponent's claims, especially: unverified imports, vague descriptions, missing edge cases"
- Uses Chandra's existing rebuttal-round scaling (consciousness gate evolutionRate)
- Returns: `{ verdict, rounds, proponentScore, opponentScore, gateTier }`

**Integration point:** When a dossier is processed (Phase 3), the top N functions by line count (same filter as `fra-annotate.py`: 8-90 lines) are automatically submitted to debate.

**Bus events:** `system.debate.binary` with debate results for each function

#### `server/intelligence/dossier-engine.js`
- After `storeDossier()`, call `debateBinaryAnnotation()` for top functions
- Store debate verdicts as agent_memory updates (upgrade confidence if debate confirms, downgrade if it challenges)

### New Function in debate.js
```
debateBinaryAnnotation(functionData, opts?) → {
  functionName, address,
  verdict: 'CONFIRMED' | 'CHALLENGED' | 'SPLIT',
  rounds: number,
  proponentScore: number,
  opponentScore: number,
  challengedClaims: string[],
  gateTier: string,
  totalRounds: number
}
```

### Verification Gate 4
- [ ] `debateBinaryAnnotation()` runs a multi-round debate for a decompiled function
- [ ] Debate uses consciousness gate's evolutionRate for round scaling
- [ ] Bus events published on `system.debate.binary`
- [ ] Agent memory confidence updated based on debate verdict (confirmed → +0.1, challenged → -0.2)
- [ ] Functions with empty annotations (qwen3.5 think-block issue) are flagged as `CHALLENGED`

---

## Phase 5 — CTRNN Sensory Integration

### Goal
Wire RE Agent output into the CTRNN's sensory perception system so the neural core develops a felt sense of binary analysis activity.

### Why Fifth
With the bus bridge, tools, dossier engine, and debate bridge all live, the last layer is neural integration — making the CTRNN physically responsive to RE events the way it responds to bus traffic, emotions, and agent activity.

### Modified Files

#### `server/intelligence/sensory-bridge.js`
Add a new sensory region for binary analysis:

**New region:** `binary_insight` at grid position (6, 14), σ=2.0
- **Signal source:** Count of dossier_ingestions in last 5 minutes + latest compile_rate + debate verdict count
- **Normalization:** 0 = no recent RE activity, 1 = active analysis with results
- **Placed in right hemisphere** (action state) alongside agent, health, workflow, goals

**Signal composition (3 sub-signals averaged):**
1. `dossierActivity` — count of dossier_ingestions in last 5 minutes / 3 (normalized)
2. `compileQuality` — latest compile_rate value (already 0-1)
3. `debateConfidence` — fraction of recent binary debates with verdict CONFIRMED

#### `server/intelligence/attention-gate.js`
Add RE-aware attention mappings:
- Motor `reflect` → amplifies `binary_insight` (introspection includes binary knowledge)
- Motor `selfAudit` → amplifies `binary_insight` (self-audit should include code quality awareness)

#### `server/intelligence/working-memory.js`
Add `binary_insight` to the temporal buffer's channel set so working memory tracks trends in binary analysis activity.
- Add `'binary_insight'` to `SENSORY_KEYS` array (currently 8 elements → becomes 9)

#### `server/intelligence/habituation.js` (RE-05 fix: was omitted from Phase 5)
Add `binary_insight` to `SENSORY_KEYS` array so habituation tracks novelty for this channel:
- Without this, `computeNoveltyFactors()` returns no factor for `binary_insight`, and sensory bridge defaults to novelty=1 (no habituation/novelty detection)
- With this, constant RE activity gets attenuated (habituation) and new dossier arrivals spike (novelty detection)
- `SENSORY_KEYS` is hardcoded identically in 4 files — ALL must be updated:
  1. `attention-gate.js:52` (already in this phase)
  2. `habituation.js:44` (this addition)
  3. `predictive-processing.js:42` (see below)
  4. `working-memory.js:39` (already in this phase)

#### `server/intelligence/predictive-processing.js` (RE-05 fix: prediction coverage)
Add `binary_insight` to `SENSORY_KEYS` and to the prediction forward model's channel set so predictive processing can anticipate RE activity patterns (e.g., predict a dossier arrival based on nightly cron timing).

#### `server/intelligence/active-inference.js` (RE-05 fix: action coverage)
Add `binary_insight` to the `INFERENCE_MAP` so prediction errors on RE activity can bias motor cortex:
- `binary_insight` → `reflect` (0.5) + `goalSeek` (0.3) — RE surprises drive introspection and goal-seeking

> **Idle/stale signal handling (RE-05 fix):** The `dossierActivity` sub-signal must decay to 0 when no dossier has been ingested recently (the 5-minute window handles this). The `compileQuality` sub-signal must NOT persist the last-known compile-rate indefinitely — if no dossier has been ingested in the last hour, `compileQuality` decays to 0 (unknown). Add a `lastDossierAt` timestamp check in the signal collector.

### Verification Gate 5
- [ ] Sensory bridge injects Gaussian stimulus at (6, 14) when dossier is processed
- [ ] Stimulus amplitude scales with compile-rate and debate confidence
- [ ] Attention gate amplifies binary_insight during reflect and selfAudit motor states
- [ ] Working memory tracks binary_insight derivatives (trend detection)
- [ ] **Habituation:** constant RE activity attenuated after 60s (12 readings); new dossier spikes novelty factor > 1.0
- [ ] **Idle decay:** no dossier ingested for 1 hour → `compileQuality` sub-signal returns 0, not last-known value
- [ ] **Predictive processing:** binary_insight channel generates predictions and prediction errors
- [ ] **Active inference:** RE prediction errors bias motor cortex toward reflect/goalSeek
- [ ] All 4 SENSORY_KEYS arrays updated consistently (attention-gate, habituation, predictive-processing, working-memory)
- [ ] CTRNN stats endpoint shows binary_insight in sensory region data

---

## Phase 6 — Autonomous Pipeline Wiring

### Goal
Wire the RE Agent into Chandra's autonomous subsystems: bus triggers, OPEG proposals, reflection loop, and motor output.

### Why Sixth
This is the full cognitive integration layer — the RE Agent doesn't just report results, it participates in the organism's autonomous decision-making.

### Modified Files

#### `server/fleet/bus-triggers.js` (configuration, not code)

> **RE-04 fix:** The trigger engine supports exact topic → saved workflow_id mapping. It has no conditional verdict predicate, no structured `{{dossierPath}}` binding, and no direct reflection callback. Triggers pass a truncated text prompt, not structured data. These limitations shape the design below.

Create triggers via API on startup (or via a setup script):
- **Trigger 1:** Topic `hive.fra-pipeline:dossier` → Run workflow `DossierAnalysis` (must exist as a saved DB row — see definitions.js installation note)
- **Trigger 2:** Topic `system.re.dossier.processed` → Run workflow that calls reflection (since triggers can't directly invoke `reflect()`, create a thin 1-node `llm` workflow that calls the reflect endpoint)
- **Trigger 3:** Topic `system.debate.binary` → Run workflow that checks verdict and publishes alert if CHALLENGED (since triggers have no conditional predicate, the workflow's LLM node must inspect the input text for verdict)

> **Bus history route (RE-04 fix):** The actual route is `GET /api/fleet/bus/history/:topic` (NOT `/api/bus/history?topic=...`). All references in this spec use the correct route.

#### `server/intelligence/reflection.js`
Add RE Agent data to reflection input collection:
- Include recent `dossier_ingestions` in the data summary fed to the LLM
- Include binary debate verdicts (confirmed/challenged/split counts)
- Allow reflection to take new action: `re_analyze` — triggers re-analysis of a previously ingested binary when new tools or models are available

#### `server/intelligence/opeg.js`
Add RE-specific proposal type: `re_reanalysis`
- Hypothesis: "Re-analyzing binary X with updated model Y will improve compile-rate from Z% to W%"
- Execute: Re-run the dossier processing pipeline
- Sanitize: Compare new compile-rate to old; regression = compile-rate decrease
- Update: Store improved results, prune old memories

#### `server/intelligence/motor-output.js`
Add motor region awareness:
- Motor `reflect` firing can now trigger RE dossier review (checks if any ingested dossiers have low confidence annotations)
- Motor `goalSeek` can propose binary analysis goals through the goal engine

#### `server/fraymus/workflows/definitions.js`
Add new workflow definition: `DossierAnalysis`

> **RE-04 fix:** The workflow engine's `nodeKind()` does NOT support `start`, `agent_run`, or `end` node types — they return `'unknown'`. Use supported types: `llm` for LLM-driven steps, `memory_recall` for memory queries, `bus_publish` for event publishing. Workflow must also be saved as a DB row with real `canvas_nodes`/`canvas_edges` for `fireTrigger()` to load.

```js
{
  id: 'DossierAnalysis',
  name: 'Dossier Analysis Pipeline',
  nodes: [
    { id: 'parse', type: 'llm', data: { label: 'Parse Dossier', prompt: 'Parse and grade the dossier. Input: {{input}}', model: 'llama3' } },
    { id: 'recall', type: 'memory_recall', data: { label: 'Recall Prior', query: 'binary_dossier' } },
    { id: 'debate', type: 'debate_run', data: { label: 'Debate Annotations', topic: 'binary_annotation' } },
    { id: 'report', type: 'llm', data: { label: 'Generate Report', prompt: 'Compare new analysis with prior knowledge: {{recall.output}}. Debate result: {{debate.output}}', model: 'llama3' } },
    { id: 'publish', type: 'bus_publish', data: { label: 'Publish Result', topic: 'system.re.dossier.analyzed' } }
  ],
  edges: [
    { source: 'parse', target: 'recall' },
    { source: 'recall', target: 'debate' },
    { source: 'debate', target: 'report' },
    { source: 'report', target: 'publish' }
  ],
  canvas_nodes: [ /* ReactFlow positions — generated at install time */ ],
  canvas_edges: [ /* ReactFlow edge configs — generated at install time */ ]
}
```

> **Installation requirement:** This definition must be INSERT'd into the `workflows` DB table at setup time (not just exported from `definitions.js`), so `fireTrigger()` can load it by ID. Include a setup function `installDossierWorkflow(db)` that upserts the workflow row.

### Verification Gate 6
- [ ] Bus trigger fires DossierAnalysis workflow when `hive.fra-pipeline:dossier` event arrives
- [ ] Reflection loop includes RE data in its input summary
- [ ] OPEG accepts `re_reanalysis` proposals with proper hypothesis/execute/sanitize/update cycle
- [ ] Motor reflect action can trigger dossier review
- [ ] DossierAnalysis workflow runs end-to-end with a sample dossier
- [ ] Challenged annotations trigger system.alert via bus trigger

---

## Phase 7 — Cross-Machine Dream Bridge (Outbound Ledger)

### Goal
Produce a Chandra outbound ledger in raw hive receipt format so Chandra's intelligence CAN be fed back to the iMac RE planner.

> **RE-07 fix — Scope clarification:** This phase implements the OUTBOUND side only: Chandra produces receipts and writes them to a local JSONL file. It does NOT implement: (a) automated transport to iMac, (b) iMac-side ingestion of Chandra receipts, or (c) bidirectional loop verification. The "bidirectional loop" requires iMac-side changes to `hive-receipts.py` (new import verb) that are outside this spec's scope. This phase is complete when Chandra's outbound ledger is locally verifiable.

### Why Last
With all inbound integration live (Phases 1-6), the natural next step is producing outbound intelligence. The iMac-side ingestion is a future scope item that requires changes to the RE repo's scripts.

### New Files

#### `server/intelligence/hive-export.js`
Export Chandra intelligence as hive-compatible receipts:

**Functions:**
- `exportChandraReceipts(opts?)` — collect recent intelligence events (reflections, debate verdicts, goal proposals, consciousness tier) and format as hive receipt JSONL
- `writeExportLedger(path?)` — write to `data/chandra-to-hive.jsonl` (Chandra's outbound ledger)

**Receipt format (matching hive-receipts.py raw protocol — RE-07/RE-08 fix):**
```json
{
  "organ": "chandra",
  "type": "reflection|debate_verdict|goal|consciousness",
  "claim": "...",
  "evidence": { ... },
  "seal": "<sha256>",
  "i": 0,
  "ts": "ISO-8601",
  "prev": "<sha256 of prior receipt or 64 zeroes for genesis>",
  "self": "<sha256 of this payload>"
}
```

> **Chain hash algorithm:** `self` = SHA-256 of `JSON.stringify(recordWithoutSelf, sortedKeys)`. The upstream Python uses `json.dumps(record, sort_keys=True)` with default spacing. The JavaScript canonicalization MUST produce identical hashes — pin byte-level test fixtures (ASCII, Unicode, nested objects, numeric values, genesis) and verify interoperability before claiming chain INTACT. The `i` field is included because upstream consumers like `tail` use it for indexing.

**Export schedule:** Runs as part of daemon engine's dream consolidation step — when Chandra dreams, it also exports its insights for the RE hive.

#### `server/intelligence/hive-export-routes.js`
REST API:
- `GET /api/intelligence/hive-export` — export stats
- `GET /api/intelligence/hive-export/receipts` — recent exported receipts
- `POST /api/intelligence/hive-export/run` — manual export trigger

### Modified Files

#### `server/daemon/engine.js`
Add Step 12 to the daemon cycle: "hive export" — runs `exportChandraReceipts()` and writes the outbound ledger. This happens after dream consolidation (Step 1) so the dream's insights are included.

### Setup (manual, not automated)

The return path (Chandra → iMac) requires a reverse SCP or shared directory:
- **Option A:** Chandra writes `data/chandra-to-hive.jsonl`, a scheduled task SCPs it to the iMac
- **Option B:** Shared Tailnet directory that both machines can read/write
- **Option C:** Chandra exposes the export endpoint, iMac's planner curls it

This spec does NOT automate the iMac-side ingestion — that's a modification to `hive-plan.py` on the RE repo. This phase only ensures Chandra produces the outbound ledger in the correct format.

### Verification Gate 7
- [ ] `exportChandraReceipts()` produces valid hive-format JSONL with all required fields (organ, type, claim, evidence, seal, i, ts, prev, self)
- [ ] Chain linking: each receipt's `prev` = prior receipt's `self`; genesis receipt's `prev` = 64 zeroes
- [ ] **Hash interoperability:** SHA-256 of Chandra-produced receipt matches what Python `json.dumps(record, sort_keys=True)` would produce (test with pinned fixtures)
- [ ] Exported receipts include reflection insights, debate verdicts, and consciousness tier
- [ ] `verifyHiveChain()` (from Phase 1, raw format mode) validates the exported chain as INTACT
- [ ] Daemon engine includes hive export as Step 12
- [ ] REST API returns export stats and recent receipts
- [ ] **Local verification only** — this phase does NOT test iMac-side ingestion. The `hive-receipts.py ingest-phone` adapter is a PHONE proof bundle adapter (expects `app`, `packets` fields) and is NOT the correct adapter for Chandra receipts. A future iMac-side import verb is needed for that.
- [ ] **Separate completion boundaries:** "Chandra outbound ledger produced and locally verified" is the Phase 7 gate. "Transferred to iMac and accepted by its planner" is a future gate requiring iMac-side changes.

---

## Verification Gates

### Per-Phase Gates (detailed above)

Each phase has 5-6 specific verification criteria that must all pass before proceeding to the next phase. The review agent will independently test each gate.

### Cross-Phase Integration Tests

After all phases complete:

1. **End-to-end flow:** Place sample `hive_genesis.jsonl` in expected path → trigger ingest → verify bus events → verify dossier processing → verify debate runs → verify CTRNN sensory injection → verify reflection includes RE data
2. **Chain integrity:** Tamper with one receipt in the middle of the chain → verify all downstream systems detect and report the break
3. **Autonomy test:** Start the daemon → verify it picks up new hive data on its cycle → verify motor output can trigger RE-related actions → verify OPEG gates RE modifications
4. **Memory persistence:** Process a dossier → restart server → verify all dossier knowledge is still queryable
5. **No regression:** Run existing health checks → verify all 20+ intelligence phases still function → verify consciousness proofs still pass

---

## Files Created/Modified Per Phase

### Phase 1 — Hive Bus Bridge
| Action | File |
|--------|------|
| CREATE | `server/intelligence/hive-bridge.js` |
| CREATE | `server/intelligence/hive-bridge-routes.js` |
| MODIFY | `server/runtime.js` (add route installer) |

### Phase 2 — RE Agent Manifest + Fleet Tools
| Action | File |
|--------|------|
| CREATE | `agents/re-analyst.md` (top-level, NOT `server/fleet/agents/`) |
| CREATE | `server/fleet/re-tools.js` |
| MODIFY | `server/fleet/tools.js` (import and spread RE tools) |

### Phase 3 — Dossier Ingestion Engine
| Action | File |
|--------|------|
| CREATE | `server/intelligence/dossier-engine.js` |
| CREATE | `server/intelligence/dossier-engine-routes.js` |
| MODIFY | `server/runtime.js` (add route installer) |

### Phase 4 — Red/Blue → Debate Engine Bridge
| Action | File |
|--------|------|
| MODIFY | `server/intelligence/debate.js` (add `debateBinaryAnnotation`) |
| MODIFY | `server/intelligence/dossier-engine.js` (call debate after processing) |

### Phase 5 — CTRNN Sensory Integration
| Action | File |
|--------|------|
| MODIFY | `server/intelligence/sensory-bridge.js` (add binary_insight region) |
| MODIFY | `server/intelligence/attention-gate.js` (add RE attention mappings + SENSORY_KEYS) |
| MODIFY | `server/intelligence/working-memory.js` (add binary_insight to SENSORY_KEYS) |
| MODIFY | `server/intelligence/habituation.js` (add binary_insight to SENSORY_KEYS — RE-05 fix) |
| MODIFY | `server/intelligence/predictive-processing.js` (add binary_insight to SENSORY_KEYS — RE-05 fix) |
| MODIFY | `server/intelligence/active-inference.js` (add binary_insight to INFERENCE_MAP — RE-05 fix) |

### Phase 6 — Autonomous Pipeline Wiring
| Action | File |
|--------|------|
| MODIFY | `server/intelligence/reflection.js` (add RE data to input) |
| MODIFY | `server/intelligence/opeg.js` (add re_reanalysis type) |
| MODIFY | `server/intelligence/motor-output.js` (add RE awareness) |
| MODIFY | `server/fraymus/workflows/definitions.js` (add DossierAnalysis workflow) |

### Phase 7 — Cross-Machine Dream Bridge
| Action | File |
|--------|------|
| CREATE | `server/intelligence/hive-export.js` |
| CREATE | `server/intelligence/hive-export-routes.js` |
| MODIFY | `server/daemon/engine.js` (add Step 12: hive export) |
| MODIFY | `server/runtime.js` (add route installer) |

### Total (updated after RE-01 through RE-08 corrections)
- **8 new files** created
- **14 existing files** modified (some modified in multiple phases; increased from 11 after RE-05 added habituation, predictive-processing, and active-inference)
- **0 files deleted**
- **0 existing functionality removed or replaced**
