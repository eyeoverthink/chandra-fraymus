# Phase 3 dossier engine and Phase 2B — independent review

**Verdict: implementation present, changes requested.** `5f7f17a` adds the engine, five routes and real executors for the four previously deferred tools. However, the real upstream dossier parses as **zero functions, zero imports and zero annotations**, and downstream storage, bus, seal and compiler contracts have reproducible failures. No phase is independently accepted.

Reviewed implementation: `5f7f17a5a8a64c296be6156c4e15bac61f105636`; progress claim: `f2b6c2e`. Reviewer: Codex independent session `01a1a46f-ddc2-70c0-abde-3eaec155a571`. Evidence: [22-assertion probe](2026-11-05-phase3-independent-probe.mjs), [observations and source hashes](2026-11-05-phase3-independent-evidence.json). Successful diagnostic assertions include reproductions of defects; they are not acceptance passes.

Upstream fixture: `eyeoverthink/fraymus-re-agent`, `dossier-ls` at `2f75cee7f54a4aa6bae219ec9241fc44f980c36b`. Authenticated contents metadata and the probe verify these exact Git blobs:

| File | Git blob |
| --- | --- |
| decompiled.c | `7c61c5b00a778d62afa12bcc1c06325db8463128` |
| annotations.md | `5d2de19c3a5a38aa25b1fb41b2b130d0763fde20` |
| imports.txt | `c67e01e367bb73d422327bc0708f9ef082823bea` |
| binary.sha256 | `d7d4e85ed3e71aaf5a901926f95e4579e783b765` |
| dossier.seal | `2a9cada682e45598688f9f91a7772dc08966dd6d` |

## RE3-01 — P1: parser and evidence formats do not match upstream

The positional marker-slicing approach works on a synthetic `0x`-prefixed fixture. Its input contract is wrong for the actual source:

- Function markers use bare hexadecimal addresses: `// ==== FUN_100000718 @ 100000718 ====`. `parseDecompiledC()` requires `0x`, so it extracts **0 of 136** functions.
- Actual import output is a whitespace-column table with **90 numbered rows**. `parseImports()` expects pipe delimiters and extracts **zero**. The annotation document's denominator 78 is a different reported count; do not substitute it for this actual import-table row count.
- Annotation headings have bare addresses plus `(42 lines)`. Import evidence uses `- import verification: 3 verified -> ...`, and scores use `- red/blue agreement: ...`. None matches the implemented annotation patterns. Both real annotated functions and their verification evidence disappear.

There is also a grading false positive on compatible synthetic input: a string literal containing `printf`, paired with an annotation claim and import-table name, produces `grade: 'verified'`. The code uses `body.includes(name)`, so it does not establish an import call.

**Closure:** build parser fixtures from these exact producer files; support their actual address, table, annotation and score forms. Validate required artifacts and reject/report incompatible input instead of storing a measured empty summary. Keep measured counts/tool artifacts separate from model-derived semantic claims, and do not infer a verified call from a string/comment substring. Decompiler output is observed evidence, not proof of original program semantics.

## RE3-02 — P1: seal verification implements a different contract and misclassifies missing evidence

The upstream pipeline hashes the text rows emitted by `shasum -a 256`, then hashes that manifest. Its seal file contains `HEX_DIGEST  -`. The new verifier hashes `filename:HEX_DIGEST\n` and compares the entire trimmed seal file to a bare hex digest. Both the manifest bytes and seal parsing differ.

The probe shows that the engine accepts its own bare-digest format, but rejects the **same digest** with the producer's `  -` suffix. The actual committed upstream subset is labeled `invalid`, although the original sealed file list/state is not retained and generated files such as `ghidra.log` may be absent. The producer's shell redirection/seal-file state also needs explicit handling; simply excluding the current seal does not reconstruct the original manifest.

**Closure:** establish the producer-compatible per-file manifest and parse the actual seal record. Retain the exact original file list/digests needed for verification. Return `unverifiable` when that evidence is unavailable; reserve `invalid` for a mismatch against a known complete contract. Test a known valid producer fixture, known tampering and incomplete evidence separately.

## RE3-03 — P1: binary facts overwrite each other and queries lose data

Function memory keys are only `fn:<name>@<address>`, while memory uniqueness is `(agent_id,key)`. Two binaries containing `shared@0x1000` therefore overwrite each other. In the probe, binary A becomes unqueryable after B is processed, and only one function memory remains.

Additional query failures:

- `getDossier()` searches memory key/value for the SHA, but function SHA association exists only in `source`; it returns no function memories even for the single-binary control.
- `getDossierFunctions()` fetches at most 100 memories **before** filtering and pagination. A compatible 136-function dossier stores all 136 but lists only **99**; pagination cannot recover the missing functions.
- `re.query_dossier({ functionName: 'shared' })` throws an “at least one ... required” error even though the named argument is present.
- Function-detail matching uses substring matching rather than an exact binary/function identity.

**Closure:** persist a full binary-scoped function identity, query by that identity in SQL, and paginate/count after binary filtering. Support the advertised function-name query mode and exact detail matching. Test multiple binaries with overlapping names/addresses, 136+ functions and repeated ingestion. Define a migration for existing memories without silently discarding local knowledge.

## RE3-04 — P1: wrong bus call is swallowed and falsely reported successful

The actual bus signature is `publish(fromAgent, topic, payload)`. `processDossier()` calls `publish('system.re.dossier.processed', busEvent)` with two arguments. The real SQLite-backed bus rejects that call. The engine silently catches the failure and returns `busEvents: 1` regardless.

The probe records the actual two-argument attempt, a binding error, **zero** records on the required topic, and a returned event count of **one**.

**Closure:** call the real bus contract, log/return publication errors and count only successful publications. Test an actual subscriber/history path, publication failure and coherent storage/event behavior. Do not treat an intended event as an observed event.

## RE3-05 — P1: compiler “temp files” can overwrite/delete evidence outside the dossier

`re.compile_rate_measure` builds `_compile_test_${fn.name}.c` inside the input dossier, writes it, and unconditionally unlinks it. Function names come directly from a permissive marker regex.

With marker name `../../../outside_forensic_record`, the actual `join()` result escapes the dossier directory. The dependency-intercepted probe records write/delete calls targeting that outside path and replacement of a pre-existing virtual record. A normal name also overwrites/deletes a pre-existing `_compile_test_shared.c` dossier artifact. **No real outside file was written or deleted in this review.**

The resulting path is also interpolated into an `execSync()` shell command. This is an unnecessary shell boundary for input-derived names/paths; shell behavior is platform-dependent and no command-injection payload was executed here.

**Closure:** use a new dedicated temporary directory and generated filenames unrelated to marker text; keep all writes outside source evidence. Spawn clang with an argument vector, enforce path containment and clean up only files created by that invocation. Add path-traversal and pre-existing-artifact tests before treating this tool as safe for arbitrary dossiers.

## RE3-06 — P1: compiler absence becomes a false measurement; results are not integrated

The tool classifies every write/spawn/timeout failure as a failed function compilation. A controlled missing-clang dependency returns `compiled: 0, failed: 1, compileRate: 0`, without `compiler: 'not_available'` or null measured rate. That reproduces the exact measurement/opinion/unknown distinction the earlier spec required.

A controlled successful compiler result returns 100%, but stored function `compileStatus`, aggregate `compile_rate` and summary `compileRate` remain null. There are no minimal Ghidra type/header stubs, per-function return codes, or complete diagnostics; only five truncated error examples are returned. A successful syntax check would measure acceptance of the supplied translation unit, not equivalence to the original binary.

**Closure:** distinguish compiler unavailable/infrastructure failures from compiler diagnostics, implement the declared return schema and tri-state unknowns, supply the necessary compilation context and retain per-function results. Persist normalized measured metrics with their tool/context provenance for later retrieval and sensory consumers. Test available, unavailable, noncompiling and timed-out cases independently.

## RE3-07 — P2: prediction note is honest, but structured evidence contract is incomplete

The tool does explicitly say “LLM opinion, NOT a compiler measurement.” That part is confirmed. It samples five functions and returns a model response, but does not return `evidence_type: 'llm_prediction'`, a model identifier or enforced confidence 0.4, and does not store the specified unverified prediction memories/events. A model fixture returning `predictedRate: 900` is accepted without range/schema validation.

**Closure:** validate and bound the prediction object, distinguish model-reported confidence from the system evidence grade, and carry the required structured opinion/provenance labels through returned and persisted results. Do not claim this is a compiler measurement or a per-function evaluation when it is a five-function sample estimate.

## Gate disposition

| Criterion | Independent result | Observation |
| --- | --- | --- |
| RE-P3-G1 — real 136-function dossier | FAIL | Extracts zero functions |
| RE-P3-G2 — evidence grades | FAIL | Real annotation/import evidence unparsed; synthetic string mention promoted |
| RE-P3-G3 — memory/confidence | FAIL | Binary identity collision and incomplete queries |
| RE-P3-G4 — processed bus event | FAIL | Actual bus rejects wrong arity; count falsely reports one |
| RE-P3-G5 — REST data/functions | PARTIAL | Actual synthetic ingest/list/detail handlers work; declared `/process` is 404 and function completeness fails |
| RE-P3-G6 — seal validation | FAIL | Producer format/algorithm and unverifiable distinction fail |
| RE-P2B-G1 — ingestion tool | FAIL | Wired executor reproduces parser/storage defects |
| RE-P2B-G2 — query tool | FAIL | Name-only mode, identity and completeness fail |
| RE-P2B-G3 — measurement tool | FAIL | Missing compiler becomes false zero measurement; unsafe file handling and no persisted results |
| RE-P2B-G4 — prediction tool | PARTIAL | Opinion note exists; structured/persisted evidence contract incomplete |

Phase 3: **5 failed criteria, 1 partial**. Phase 2B: **3 failed criteria, 1 partial**. All ten now have independent dispositions; no Phase 3 or 2B gate is accepted. Existing Phase 1/2A findings remain unchanged. The new route is `POST /api/intelligence/dossier/ingest`, whereas the spec declares `/process`; correct or alias the contract explicitly.

## Reproduction, safety and handoff

```powershell
node --experimental-vm-modules docs/reviews/2026-11-05-phase3-independent-probe.mjs --upstream PATH_TO_PINNED_UPSTREAM --output PATH_TO_NEW_EVIDENCE.json
```

The probe checks exact upstream blobs and evaluates the pinned production bodies with disposable SQLite, the actual bus and actual Express handlers. Filesystem writes/unlinks at the compiler boundary, subprocess calls and Ollama responses are intercepted using VM synthetic modules. No actual compiler/shell/model or file deletion is executed. The upstream dossier is read-only; synthetic source fixtures are created only in a fresh temporary directory. No live app/DB import, production source fix or server restart occurs.

The marker-slicing strategy, route registration and removal of stub errors are present. Acceptance still requires the real producer fixtures and the storage/event/evidence invariants above. Fix RE3-01–07 and provide focused regression evidence before treating dossier knowledge as trusted input to debate or CTRNN. Concurrent debate work is outside this review. Tag: `review/re-agent-phase3-2026-11-05`.
