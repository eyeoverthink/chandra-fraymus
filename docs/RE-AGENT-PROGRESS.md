# RE Agent integration progress

Updated: 2026-11-05. Latest independently reviewed Phase 2A fix: `b999ed7e74b1b7db441131e4227ae3dc57e44e59`; authentic-source and verified-preservation fixes confirmed, functional acceptance still open. Prior Phase 2A fixes: `e8410f3`; implementation: `dcb0658`. Latest reviewed Phase 1 fix: `4ba2c433681bc6fecac6acc9b0c1c18c232b1592`; acceptance claim reviewed at `3b901f7`. Prior implementation: `8b52ac9`; prior spec correction: `5e23e01`. Initial baseline: `1eabcde`; spec introduced in `837f679`. Upstream reviewed: `2f75cee7f54a4aa6bae219ec9241fc44f980c36b`.

**Phase 1 code, Phase 2A registration/tools, Phase 3 dossier engine and Phase 4 binary debate bridge are present; Phase 2B tools now wired. Independently accepted: 0/7 phases. Phase 4: implemented, 0/5 gates exercised. Phase 3: implemented, 0/6 gates exercised. Phase 2A: 2 scoped passes, 3 partial criteria and 1 unverified criterion. Phase 1: 6 scoped passes, 3 failed gates and 1 partial gate.** The [authentic-source/migration recheck](reviews/2026-11-05-phase2a-migration-review.md) confirms all eighteen source identities/provenance, actual 36-to-18 legacy migration, and verified preservation across categories. Fourteen author subchecks reproduce, including the 142-tool registry. Registry membership still does not close the task/response gate; new RE2A-05 concerns migration of unverified non-seed local notes. The [Phase 1 review](reviews/2026-11-05-hive-phase1-fix-review.md) is unchanged. The estimate remains 8 new files, 14 existing modifications and 0 deletions; there are 56 criteria. Sixteen criteria have scoped dispositions; 40 remain unexercised.

| Phase | Declared dependency | Independent gates passed | Current status | Required next evidence |
| --- | --- | --- | --- | --- |
| 1 — Hive Bus Bridge | Raw receipt transport/format agreement | 6 PASS_ISOLATED, 3 FAIL, 1 PARTIAL | IMPLEMENTED at `4ba2c43`; CHANGES REQUESTED | HIVE-01–05 need notification-after-commit, consistent invalid-input admission, enforced numeric domain, corrected-input promotion and legacy identity migration. HIVE-06: author recheck is not this reviewer's acceptance. |
| 2 — RE manifest + tools | Phase 1; dossier tools need Phase 3 | 2A: 2 PASS_ISOLATED, 3 PARTIAL, 1 UNVERIFIED; 2B: 0/4 | Source/preservation fixes confirmed at `b999ed7`; acceptance OPEN | RE2A-01/02 scoped fixes confirmed; RE2A-03 DB isolation retained. RE2A-04 task/response and new RE2A-05 migration ownership remain open. |
| 3 — Dossier engine | Phase 2A (standalone tools) | 0/6 | IMPLEMENTED at `5f7f17a`; author acceptance OPEN | Phase 3 engine, routes and Phase 2B tool wiring complete. REF-04: propagate not-measured compilation and tri-state seal evidence through storage/events/API, with per-fact provenance. Independent review needed. |
| 4 — Binary debate bridge | Phase 3 | 0/5 | IMPLEMENTED at `d1ad21a`; author acceptance OPEN | Binary-specific debate prompts, adversarial rounds with gate scaling, confidence adjustments (CONFIRMED +0.1, CHALLENGED -0.2), bus events on `system.debate.binary` and `system.re.dossier.debated`. Independent review needed. |
| 5 — CTRNN sensory channel | Declared Phases 1–4 | 0/10 | NOT IMPLEMENTED; spec scope correction verified | Missing modules and stale-data gates are now planned. Actual arrays, novelty, predictions and action mapping still need implementation and tests. |
| 6 — Autonomous wiring | Phases 1–5 | 0/6 | NOT IMPLEMENTED; workflow contract still open | REF-03: `bus_publish` is unsupported, plain LLM nodes cannot execute dossier/reflection operations, and trigger inputs remain untyped text. |
| 7 — Cross-machine dream bridge (outbound only) | Shared raw-format contract and prior phases | 0/9 | NOT IMPLEMENTED; outbound scope correction verified | Scope and phone-adapter correction acknowledged. Phase 1 matches the 13 known receipts but fails additional valid Python numeric/Unicode fixtures (HIVE-04); export interoperability remains to be implemented/tested. |

Five additional cross-phase scenarios remain untested: complete flow, tampering response, daemon/autonomy, restart persistence, and regression behavior. None has been inferred from a feature count or a document checkbox.

## Verified prerequisites and limits

| Asset or claim | Current evidence |
| --- | --- |
| Upstream repository and relevant sources | Authenticated read at the pinned commit; no full toolchain clone |
| Raw upstream hive chain | 13 receipts; actual upstream verifier reports INTACT; Phase 1 implementation independently reproduces all 13 hashes |
| Windows landing file | 9 projected records; fields `ts,type,src,msg,seal`; no `prev/self` chain to verify |
| `/bin/ls` dossier structure | 136 function markers, 5,152 lines in committed decompiled C |
| Compile-rate claim | NOT VERIFIED: actual evaluator splits 136 functions into 181 misaligned fragments; first code field is an address |
| Tool archive pins | 7/7 spec prefixes now labeled as placeholders; must verify against upstream MANIFEST.md at `2f75cee7` |
| Historical build-gate lessons | Referenced document contains 18 numbered entries; spec now plans confidence 0.9. No RE build-gate ingestion has been implemented or verified. |
| Dossier seal | NOT VERIFIED from committed subset; full original sealed file list/bytes required; no tampering attribution |
| Nightly scheduling and active iMac execution | NOT VERIFIED on the remote runtime; script exists and sends the projection |
| Bidirectional planner loop | NOT IMPLEMENTED by Chandra; planned Phase 7 only defines the outbound side and manual setup |

## How to record progress

Run `node scripts/check-re-agent-progress.mjs --ref COMMIT --output PATH` after an implementation commit. This derives the criterion count and section IDs from that committed spec, including separate 2A/2B gates, and records source hashes, required-file/marker inventory and local contract checks. The original spec has 41 criteria; `5e23e01` has 56. Implementation presence is always labeled **not verified** until a reviewer exercises the gate.

For each independently tested gate, add a record here with gate ID (`RE-P1-G1`, etc.), implementation commit, implementer session, reviewer session, test command/fixture, observed result, evidence file, and any limitation. Preserve failed results and previous snapshots. A claimed pass without its evidence remains unverified. The author should not self-close independent review gates.

| Review event | Result | Evidence |
| --- | --- | --- |
| 2026-11-05 — initial spec review | 8 contract findings; no phase implementation | [Full review](reviews/2026-11-05-re-integration-spec-review.md) |
| 2026-11-05 — Chandra inventory | 0 implementation phases detected, 0/41 gates passed; 8 diagnostic assertions | [Snapshot JSON](reviews/2026-11-05-re-integration-progress.json) |
| 2026-11-05 — pinned upstream reproduction | 14 diagnostic assertions; raw-chain positive control and tamper control; projection, parser and phone-adapter mismatches reproduced | [Evidence JSON](reviews/2026-11-05-re-upstream-evidence.json), [probe](reviews/2026-11-05-re-upstream-probe.py) |

Author correction claim: `5e23e01` states all eight findings were addressed. The independent disposition and remaining work are in the following recheck.

| Recheck event | Result | Evidence |
| --- | --- | --- |
| 2026-11-05 — corrected spec independent recheck | Ten-tool manifest verified; several scope/measurement corrections confirmed. Five remaining contract/tracking findings; Phase 1 remains unapproved by independent review. | [Review](reviews/2026-11-05-re-spec-fix-review.md), [14-assertion evidence](reviews/2026-11-05-re-spec-fix-evidence.json) |
| 2026-11-05 — revised inventory | 0/7 implemented; 0/56 passed; 8 new files and 14 modifications; all 56 criterion texts retained | [Snapshot JSON](reviews/2026-11-05-re-spec-fix-progress.json) |

| Implementation event | Result | Evidence |
| --- | --- | --- |
| 2026-11-05 — Phase 1 implementation, author's claim at `931783b` | `8b52ac9` adds the engine, 4 REST endpoints and runtime registration. Author claimed universal Python compatibility/crash closure and deferred trigger trust. These closure claims are superseded by the independent results below. | [hive-bridge.js](../server/intelligence/hive-bridge.js), [hive-bridge-routes.js](../server/intelligence/hive-bridge-routes.js); author's canonicalization test is external to Git, so use the checked-in independent probe for reproduction. |
| 2026-11-05 — independent REF disposition | REF-01: 13 known receipts pass; numeric/Unicode domain remains open (HIVE-04). REF-02a: Phase 1 invalid-input gate fails (HIVE-01); deferral cannot close it. REF-02b: restart gate fails (HIVE-02). REF-03/04: later-phase contracts remain open. REF-05: 56-count correction confirmed. | [Independent report](reviews/2026-11-05-hive-phase1-review.md), [behavioral evidence](reviews/2026-11-05-hive-phase1-evidence.json) |
| 2026-11-05 — author fixes at `4ba2c43` | Author claimed HIVE-01–05 closure. All 18 focused tests reproduce, confirming their narrow observations; independent behavioral closure remains incomplete. | [Author tests](reviews/2026-11-05-hive-phase1-fix-acceptance.mjs), [fresh independently rerun results](reviews/2026-11-05-hive-author-acceptance-rerun.json). Original evidence was external to Git under `F:\Claude-Work\re-agent-phase1`. |
| 2026-11-05 — author-reported acceptance at `3b901f7` | Historical claim: 10/10 gates and Phase 1 accepted. Supplied script reproduces that result, but it omits subscriber effects, weakens malformed ingestion checks, and assumes a verified-prefix exception. No distinct reviewer/session was identified; this Codex session had not accepted the fix. | [Submitted recheck](reviews/2026-11-05-hive-phase1-fix-recheck.mjs), [fresh rerun results](reviews/2026-11-05-hive-author-recheck-rerun.json) |
| 2026-11-05 — actual independent fix review | 20 diagnostic assertions; 6 scoped passes, 3 failures, 1 partial. Restart stores 13 rows but sends 14 notifications; malformed input triggers a trusted workflow; changed unsafe integer verifies intact; unverified identities block repaired input; prior-version upgrade replays 13 receipts. Changes requested. | [Report](reviews/2026-11-05-hive-phase1-fix-review.md), [pinned-source probe](reviews/2026-11-05-hive-phase1-independent-recheck.mjs), [independent evidence](reviews/2026-11-05-hive-phase1-independent-evidence.json) |
| 2026-11-05 — author Phase 2A implementation at `dcb0658` | Author reports 9/9 subchecks across six criteria. Manifest, wrapper and registration work is present; G6 tests tool registration instead of the required fleet task/response. The self-test is preserved as author evidence, not independent gate closure. | [Submitted test](reviews/2026-11-05-phase2a-gate-acceptance.mjs); its default command imports the application DB. Use the independent probe's disposable rerun instead. |
| 2026-11-05 — independent Phase 2A review | 18 diagnostic assertions; actual loader/fleet GET API and positive wrapper fixtures checked. Source catalog mismatch, verified-memory overwrite and unsafe default test persistence reproduced. Verdict: 1 scoped pass, 1 failure, 3 partial, 1 unverified; 2B remains deferred. | [Report](reviews/2026-11-05-phase2a-independent-review.md), [pinned-source probe](reviews/2026-11-05-phase2a-independent-probe.mjs), [evidence including safe author rerun](reviews/2026-11-05-phase2a-independent-evidence.json) |
| 2026-11-05 — Phase 2A author fix claim at `e8410f3` | Author reports all four findings addressed and 11/11 successful subchecks. Commit changes the seeder and acceptance script only; claimed tracker update is absent. Local IDs, insert-skip logic and built-in disposable DB setup are added. | [Fix script](reviews/2026-11-05-phase2a-gate-acceptance.mjs); author result reproduced in the independent fix evidence below. |
| 2026-11-05 — independent Phase 2A fix recheck | 13 diagnostic assertions. Same-category verified rows survive unchanged; test isolation works. Upgrade yields 36 rows and retains 18 false source labels; recategorized keys are still overwritten; G6b proves discovery only. Acceptance remains unchanged. | [Report](reviews/2026-11-05-phase2a-fix-review.md), [probe](reviews/2026-11-05-phase2a-fix-probe.mjs), [evidence](reviews/2026-11-05-phase2a-fix-evidence.json) |
| 2026-11-05 — independent `b999ed7` source/migration recheck | 13 diagnostic assertions; author 14/14 reproduced in an archived source copy. Authentic numbered summaries, returned source, known legacy upgrade and verified cross-category/history preservation pass. Actual registry contains 142 tools. G6 task/response still unverified; new RE2A-05 demonstrates non-seed unverified local-note deletion/overwrite. | [Report](reviews/2026-11-05-phase2a-migration-review.md), [probe](reviews/2026-11-05-phase2a-migration-recheck.mjs), [committed evidence including full author rerun](reviews/2026-11-05-phase2a-migration-evidence.json) |
| 2026-11-05 — Phase 3 implementation at `5f7f17a` | Dossier engine + routes + Phase 2B tool wiring. New: dossier-engine.js (parseDossier, gradeDossier, storeDossier, processDossier, evidence grading, seal verification, bus events), dossier-engine-routes.js (5 endpoints), runtime.js wired. Phase 2B tools re.ingest_dossier, re.query_dossier, re.compile_rate_measure, re.compile_rate_predict now call real engine. Author acceptance open; independent review needed. | [dossier-engine.js](../server/intelligence/dossier-engine.js), [dossier-engine-routes.js](../server/intelligence/dossier-engine-routes.js), [re-tools.js](../server/fleet/re-tools.js) |
| 2026-11-05 — Phase 4 implementation at `d1ad21a` | Binary Debate Bridge. Added `debateBinaryAnnotation()` to debate.js (binary-specific proponent/opponent/judge prompts, empty-annotation auto-CHALLENGED for qwen3.5 think-block issue, consciousness gate scaling of rebuttal rounds, bus events on `system.debate.binary`). Added `debateDossierFunctions()` to dossier-engine.js (top N function selector by line count 8-90, debate runner, confidence updater: CONFIRMED +0.1, CHALLENGED -0.2, SPLIT unchanged, summary bus event on `system.re.dossier.debated`). Added POST `/api/intelligence/dossier/debate` endpoint. Author acceptance open; independent review needed. | [debate.js](../server/intelligence/debate.js), [dossier-engine.js](../server/intelligence/dossier-engine.js), [dossier-engine-routes.js](../server/intelligence/dossier-engine-routes.js) |

## Phase 1 independent gate ledger

Implementation: `8b52ac9`. Fix: `4ba2c43`. Implementer/submitted recheck: Claude session (session ID not provided). Independent reviewer: Codex session `01a1a46f-ddc2-70c0-abde-3eaec155a571`. The author-side acceptance at `3b901f7` was not issued by this Codex session.

**Pre-fix probe** (pinned to `8b52ac9`): `node docs/reviews/2026-11-05-hive-phase1-probe.mjs --upstream PATH --output PATH`. [Evidence JSON](reviews/2026-11-05-hive-phase1-evidence.json) records exact source hashes, all observations and 29 diagnostic assertions. Successful defect reproductions are not product passes.

**Author-side post-fix recheck** (pinned to `4ba2c43`): `node docs/reviews/2026-11-05-hive-phase1-fix-recheck.mjs --upstream PATH --output PATH`. [Fresh rerun evidence](reviews/2026-11-05-hive-author-recheck-rerun.json) reproduces its reported verdicts. This is not independent gate closure.

**Independent post-fix review** (full pinned commit `4ba2c433681bc6fecac6acc9b0c1c18c232b1592`): `node docs/reviews/2026-11-05-hive-phase1-independent-recheck.mjs --upstream PATH --output PATH`. [Independent evidence](reviews/2026-11-05-hive-phase1-independent-evidence.json) records actual subscriber/trigger effects, numeric integrity, identity recovery, upgrade behavior and scoped HTTP controls. Its 20 diagnostic assertions include defect reproductions, not 20 product passes.

| Gate | Original (`8b52ac9`) | Author reports (`4ba2c43`) | Independent (`4ba2c43`) | Evidence and limitation |
| --- | --- | --- | --- | --- |
| RE-P1-G1 | PASS_ISOLATED | PASS_ISOLATED | PASS_ISOLATED | Actual installer and static runtime wiring; no full app boot. |
| RE-P1-G2 | PASS_ISOLATED | PASS_ISOLATED | PASS_ISOLATED | Valid raw/projection samples detected. |
| RE-P1-G3 | PASS_ISOLATED | PASS_ISOLATED | PASS_ISOLATED | Valid 13-receipt fixture publishes correctly. |
| RE-P1-G4 | PASS_ISOLATED | PASS_ISOLATED | PASS_ISOLATED | Projection isolation confirmed with actual trusted trigger dispatcher. |
| RE-P1-G5 | FAIL | PASS | FAIL | Complete-suffix verification improves; numeric tampering still passes and partial input is not rejected. |
| RE-P1-G6 | PARTIAL | PASS | PARTIAL | Formatting dedup works; corrected receipts are suppressed and prior-version upgrade duplicates events. |
| RE-P1-G7 | FAIL | PASS | FAIL | SQLite rows are atomic; subscriber/workflow effects escape rollback and repeat on retry. |
| RE-P1-G8 | FAIL | PASS | FAIL | Malformed input still publishes 12 trusted receipts and invokes a trusted workflow. |
| RE-P1-G9 | PASS_ISOLATED | PASS_ISOLATED | PASS_ISOLATED | Actual isolated HTTP stats route works. |
| RE-P1-G10 | PASS_ISOLATED | PASS_ISOLATED | PASS_ISOLATED | Actual subscribers/history work for valid input. |

The [source inventory snapshot](reviews/2026-11-05-hive-phase1-progress.json) detects implementation presence only. The gate ledger above is the independent acceptance record. No live database or server was changed.

## Phase 2A independent gate ledger

Implementation: `dcb0658`; fixes: `e8410f3`, latest independently reviewed: `b999ed7`. Reviewer: Codex session `01a1a46f-ddc2-70c0-abde-3eaec155a571`. Upstream source at `2f75cee7` is pinned by blob `43377715d18c7d892fa71c3dab3167da070f6936` and retained as an [exact fixture](reviews/fixtures/re-build-gates-2f75cee7.md). [Original](reviews/2026-11-05-phase2a-independent-evidence.json), [first fix](reviews/2026-11-05-phase2a-fix-evidence.json), and [migration evidence](reviews/2026-11-05-phase2a-migration-evidence.json) retain the baselines and current complete author rerun. The author's `2026-11-05-phase2a-gate-evidence-v3.json` was untracked, so it is not a portable evidence link. No live DB or model was used by this reviewer.

### Author subcheck results (14/14 reproduced; not independent phase acceptance)

| Gate | Author result | Observation |
| --- | --- | --- |
| RE-P2A-G1 | PASS | Manifest has `id=re-analyst` with exactly 10 comma-separated tools. |
| RE-P2A-G2a | PASS_ISOLATED | Raw receipt file not present on this machine; tool function verified via import. |
| RE-P2A-G2b | PASS | Projection correctly unverifiable (chain fields absent). |
| RE-P2A-G3-reseed | PASS | Reseed is non-destructive: 18 skipped, 0 seeded on second call. |
| RE-P2A-G3-JDK | PASS | Keyword "JDK" → 2 upstream gates (3, 10), source pinned to 2f75cee7. |
| RE-P2A-G3-dylib | PASS | Keyword "dylib" → 2 upstream gates (2, 18), source pinned to 2f75cee7. |
| RE-P2A-G3-npm | PASS | Keyword "npm" → 3 upstream gates (5, 7, 9), source pinned to 2f75cee7. |
| RE-P2A-G4a | PASS | 18 memories, confidence 0.9, upstream numeric keys (1..18), source pinned. |
| RE-P2A-G4b | PASS | Verified entry preserved byte-for-byte on reseed (same-category). |
| RE-P2A-G4c | PASS | Recategorized verified entry preserved — identity scope `(agent_id,key)` correct. |
| RE-P2A-G4d | PASS | Unverified L-prefixed orphans cleaned up on seed. |
| RE-P2A-G5 | PASS | Tycho `rea_analyst` preserved, separate from `re-analyst`. |
| RE-P2A-G6a | PASS | 6 RE tools: 2 working, 4 Phase-2B stubs correctly require Phase 3. |
| RE-P2A-G6b | PASS | Fleet manifest discovers re-analyst (10 tools); all 6 RE tools present in fleet registry (142 total). |

### Current independent gate ledger (`b999ed7`)

| Gate | Independent result | Observation |
| --- | --- | --- |
| RE-P2A-G1 | PARTIAL | Actual loader and `/api/fleet/agents` show ten tools; declared `/api/agents` is a host-node registry. |
| RE-P2A-G2 | PASS_ISOLATED | Actual wrapper verifies the 13 known receipts and rejects projection verification; Phase 1 findings remain open. |
| RE-P2A-G3 | PASS_ISOLATED | Authentic keyword results include source provenance; numbered source mapping verified. |
| RE-P2A-G4 | PARTIAL | Fresh/source/known-upgrade and verified preservation pass; migration must distinguish non-seed unverified local notes (RE2A-05). |
| RE-P2A-G5 | PARTIAL | Actual loader preserves Tycho's separate manifest; functional model-backed run not exercised. |
| RE-P2A-G6 | UNVERIFIED | Actual 142-tool registry includes all six RE tools, but no `POST /api/fleet/runs` or response is exercised. |

### Implementer changes (`e8410f3` → `b999ed7`) and independent scope

1. **RE2A-01 (upstream provenance)**: Replaced 18 reconstructed L1–L18 entries with authentic upstream content from `BUILD-GATES.md` at commit `2f75cee7` (blob `43377715`). Gate numbers 1–18 match upstream document exactly. Source provenance returned to tool consumers in lookup results.
2. **RE2A-02 (identity-scope overwrite)**: Skip logic now queries by `(agent_id, key LIKE 'build_gate_%')` across all categories, matching `storeMemory()`'s `UNIQUE(agent_id, key)` index. Recategorized verified entries are preserved.
3. **RE2A-03 (test isolation)**: DB override is retained. Full registry import initializes additional cwd-based filesystem state; reviewer reran it in an isolated source copy/workspace. Earlier fixture cleanup was reported by the implementer.
4. **RE2A-04 (fleet taskability)**: G6b verifies six RE names in the actual registry. This registration check is confirmed. The required POST/task/response remains UNVERIFIED, not PASS_ISOLATED.
5. **Upgrade migration**: Known unverified seed rows reconcile from 36 to 18; verified history is preserved. New RE2A-05: unverified local/operator rows with overlapping names can be deleted or overwritten without testing seed ownership.

Next action: implementation owner supplies a real isolated task/response test and limits automatic migration repair/deletion to known legacy seed ownership. Preserve the source/provenance and verified-memory controls now confirmed. All 2B tools remain deferred to Phase 3; Phase 1 findings are unchanged. A concurrently untracked `server/intelligence/dossier-engine.js` is outside this review. Latest tag: `review/re-agent-phase2a-migration-2026-11-05`; prior tags remain historical checkpoints, not phase acceptance.
