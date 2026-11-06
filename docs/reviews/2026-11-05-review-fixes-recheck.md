# Independent recheck of the 13-fix claim

Reviewed: `817ddfe4872318b1971c4239be8cfcf758450cbc`. Baselines: lineage `ed6f999`, dossier/Phase 2B `5f7f17a`. Reviewer: Codex, independent reviewer as requested by Vaughn. Date: November 5, 2026, America/Los_Angeles; evidence timestamps are UTC.

**Verdict: five findings closed within isolated test scope; eight partially addressed. The claim that all 13 findings are resolved is not supported.** All four changed files parse. The expanded lineage self-test is **33/33**. The independent probe has **35 diagnostic assertions**, covering working fixes and remaining failures. A passing diagnostic assertion is not feature acceptance.

## Remaining work, ordered by impact

### RE3-05 — P1, PARTIAL: compiler cleanup can delete a reused directory

The important original improvements are present: symbol names no longer determine filenames, and clang receives an argument vector via `execFileSync`. A marker named `../../../outside_forensic_record` now results in `fn_0.c` and does not escape through its symbol text.

However, `server/fleet/re-tools.js:241` chooses the predictable sibling path `_compile_test_${Date.now()}` and uses `mkdirSync(..., { recursive: true })`, which allows an existing directory. Line 267 recursively removes that entire directory in `finally`, without establishing exclusive ownership. A controlled clock and intercepted filesystem show that an existing `preexisting-forensic-record.md` in that directory is removed alongside generated files. Same-parent requests choosing the same millisecond can also share the directory. **All compiler writes/removals were intercepted; no pre-existing host file was changed.**

Closure: obtain an exclusively created directory using `mkdtempSync` under a controlled temporary root; verify containment and ownership before cleanup. Test pre-existing directories, concurrent invocations and cleanup failures. Never recursively remove a directory merely because its name looks generated.

### RE3-01 — P1, PARTIAL: real imports and semantic verification still fail

All **136 functions** and **two annotation sections** from the pinned upstream dossier now parse. The original bare-address failure is fixed. But `parseImports()` (`server/intelligence/dossier-engine.js:169`) expects the bind column immediately after the ordinal. The actual `rabin2` rows include `vaddr` before bind and may have an empty library:

```text
nth vaddr       bind type lib name
1   0x1000042ac NONE FUNC     __assert_rtn
```

Result: **zero of 90 real imports** are parsed. The previously reported grading defect also remains at lines 323–325: `fn.body.includes(imp.name)` promotes a string-literal mention of `printf` to a verified import hit when paired with a model annotation. Annotation parsing additionally records `none matched` as a verified import name when the upstream count is zero; that is not an import identity.

Closure: parse the actual producer header/columns, including vaddr and absent library; assert all 90 exact import identities. Respect zero verification counts and preserve per-function/model provenance. Do not treat string/comment substrings or repeated model assertions as verified calls.

### RE3-02 — P1, PARTIAL: seal completeness is guessed

Both a synthetic `shasum`-shaped seal (`digest  -`) and the older `filename:hash` recipe now pass their own controls. This confirms the suffix/parser improvement and support for two manifest encodings.

The original producer-compatible completeness contract is still absent. `server/intelligence/dossier-engine.js:283` guesses that fewer than five files means `unverifiable`, otherwise `invalid`. The actual retained upstream directory contains nine entries including its seal, but lacks original generated evidence such as `ghidra.log`; it is still labeled **invalid**. A known two-file fixture is valid before mutation and labeled **unverifiable**, rather than invalid, after mutation. File count cannot distinguish missing evidence from a known complete manifest mismatch. The producer's seal-file/redirection state is also not reconstructed.

Closure: retain the exact original manifest/file list and hashing contract, including the handling of the seal itself. Verify against that evidence. Use `unverifiable` when it is unavailable and `invalid` for a mismatch against a known complete contract, independent of the number of files.

### RE3-03 — P1, PARTIAL: normal queries improve, full identity and upgrade continuity remain incomplete

Normal binaries with different 16-character SHA prefixes now retain overlapping function names/addresses. SQL pagination retrieves **100 + 36 = 136** functions, SHA detail returns function memories, and the name-only fleet tool works. These are confirmed improvements.

Remaining defects:

- The full accepted binary identity is reduced to 16 characters in memory keys and lookup. Two declared 64-character SHA values sharing that prefix overwrite the same function fact; querying A returns B's source. This test uses accepted declared identities, **not two actual colliding binaries or a discovered SHA-256 collision**. Keep the complete identity in storage; a short prefix can remain a display label.
- `getDossierFunction()` (`server/intelligence/dossier-engine.js:674`) uses unescaped `LIKE`: requesting `sha%` returns the function `shared`. Parameterization prevents SQL injection but does not make wildcard matching exact. Underscores in normal symbol names also have wildcard meaning.
- There is no upgrade migration for prior `fn:name@address` records. A preserved legacy fact with the correct full binary SHA in `source` is invisible to the new lookup. Re-ingesting creates new prefixed facts rather than reconciling old records and their local history.

Closure: retain full binary/name/address identities; use exact name equality or escaped literal matching; migrate/reconcile legacy records without discarding verified/local knowledge. Test a populated old database as well as clean ingestion. Validate declared SHA syntax and report absent/unknown binary identity explicitly.

### RE3-06 — P1, PARTIAL: missing compiler is unknown, other infrastructure errors are still false measurements

The version preflight now returns `compiler: 'not_available'`, null counts/rate and no writes when clang is unavailable. The successful compiler fixture returns a rate through the argv interface. These are confirmed controls, not execution of a real compiler.

Inside the per-function catch, filesystem errors and compiler timeouts still increment `failed` as if the compiler rejected the C source. A timeout and an intercepted EACCES both produce `compileRate: 0` in this probe. After a successful compiler fixture, the stored function `compileStatus`, `dossier_ingestions.compile_rate`, and summary `compileRate` are still **null**. Necessary stub/header context and complete per-function diagnostics/return codes remain absent; only a truncated error sample is returned.

Closure: separate compiler diagnostics from invocation, timeout and filesystem failures; keep incomplete measurements unknown or explicitly partial. Retain compilation context and per-function tool outcomes. Persist normalized measured metrics and provenance for later retrieval/sensory consumers. A syntax check is not proof of semantic equivalence to the binary.

### RE3-07 — P2, PARTIAL: opinion labels added; schema, model identity and persistence incomplete

The response now includes `evidence_type: 'llm_prediction'`, evidence confidence `0.4`, a sample size and the honest opinion note. Numeric `900` is clamped to 100, and confidence strings are restricted. These fixes are confirmed.

The model response `{"predictedRate":"900",...}` still passes unchanged because only numeric values enter range validation. No opinion memories or prediction events are stored. The code dynamically requests a default export from `config.js`, which has named exports only; the resulting exception is swallowed and the returned model stays `unknown`. The actual model selection lives in `chatOllama` (`opts.model`, environment, fallback), not that nonexistent config export. The test omits a default export, matching that part of the actual config contract, without importing the live config/application.

Closure: validate the complete response type/schema, reject or normalize nonnumeric percentages, resolve and pass the same model ID that is reported, and persist opinion-grade results/events with their provenance. Keep the sample estimate distinct from per-function compiler outcomes.

### LCH-03 — P2, PARTIAL: some evaluator guards work; invalid results still succeed

Inherited Object methods, internal callback functions, `a=0` quadratics, string addition and out-of-width Hamming operands are now rejected. Public polynomial calculus is available without evaluating caller source.

Through actual isolated HTTP handlers, remaining cases return status 200:

| Request | Observed result | Required contract |
| --- | --- | --- |
| `polynomialEval(["2",3], 2)` | string `"62"` | Validate finite numeric coefficients and evaluation point |
| `hamming(1.5, 0)` | integer `1` | Require unsigned integers, not truncated fractions |
| `visViva(0, 0)` | null numeric fields | Reject invalid radii / report domain failure |

Closure: complete per-formula argument/domain validation and finite-result checks. Validate all array members and numeric dimensions. Do not silently serialize nonfinite results as successful nulls.

### LCH-04 — P2, PARTIAL: cancellation fixed, repeated zero roots regress

The old `[1,1e16,1]` case now returns the smaller nonzero root and satisfies the product invariant. But `q = -0.5*(b+sign(b||1)*sqrt(discriminant))` and `c/q` (`server/intelligence/lineage.js:102`) give `0/0` for **`quadratic(1,0,0)`**, whose roots should both be zero. Both output roots are NaN internally and become null in a successful API response. The expanded 33-example suite does not catch this.

Closure: handle `q=0`, repeated zero roots and scaled/overflow cases explicitly; retain residual and Vieta invariant tests with sensible tolerances. Add the exact `x²=0` public-API regression alongside the original cancellation case.

## Confirmed scoped closures

| Finding | Result and limits |
| --- | --- |
| LCH-01 | **PASS_ISOLATED.** Actual fleet dispatch handles all five modes correctly; read persists an additional chart and evaluate returns numerical results. |
| LCH-02 | **PASS_ISOLATED.** New polynomial derivative/integral operations produce 12 and 9 through REST and actual fleet dispatch. Generic JavaScript callbacks remain internal. Validation gaps are tracked under LCH-03. |
| LCH-05 | **PASS_ISOLATED.** Rejected lineage insertion reports `persisted: false` and an error, logs it, and publishes no ordinary saved-chart event. A subsequent retry persists, publishes and restores the context. |
| LCH-06 | **PASS_ISOLATED.** Failed Arithmetic yields no verified tier or mastered domain; failed Algebra retains only Arithmetic. Minor remaining representation inconsistency: `getCurrentAge()` returns null, while stats expose the internal `-1` sentinel. Normalize that boundary. |
| RE3-04 | **PASS_ISOLATED.** Actual three-argument SQLite bus publication succeeds. Rejected publication is logged and returns `busPublished: false`. The claim that every silent catch was replaced is broader than the source: cleanup/config and several other catches still swallow errors. |

The first-tier/persistence tests mutate only isolated VM fixtures. They do not modify the production formulas or database. A chart's passing native examples still do not measure model competence or recover previously learned knowledge.

## Progress against the exact RE checklists

Finding closure and phase-checklist results are different scopes. For example, the narrow returned-prediction-label criterion passes with a mocked model, while the broader RE3-07 persistence/schema/provenance contract remains partial.

| Gate | Result at `817ddfe` | Evidence |
| --- | --- | --- |
| RE-P3-G1 | PASS_ISOLATED | 136 real producer function markers parse |
| RE-P3-G2 | FAIL | 0/90 imports; false verified string mention |
| RE-P3-G3 | PARTIAL | Normal storage works; full identity/migration incomplete |
| RE-P3-G4 | PASS_ISOLATED | Actual bus success and failure paths |
| RE-P3-G5 | PARTIAL | REST returns 136; exact detail/declared `/process` contract unresolved |
| RE-P3-G6 | FAIL | No retained original manifest; count-based completeness heuristic |
| RE-P2B-G1 | PARTIAL | Ingestion works for functions; import/evidence/seal failures remain |
| RE-P2B-G2 | PARTIAL | Normal queries work; exact identity/legacy continuity unresolved |
| RE-P2B-G3 | PARTIAL | Compiler missing case fixed; cleanup and infrastructure measurement unsafe/incomplete |
| RE-P2B-G4 | PASS_ISOLATED | Returned opinion label exists in the controlled model response |

Phase 3: **2 scoped passes, 2 failures, 2 partial**. Phase 2B: **1 scoped pass, 3 partial**. **0/7 RE phases independently accepted.** Phase 1/2A findings and later Phase 4–7 implementation remain outside this recheck. The 26 previously exercised RE criteria remain 26; lineage checks and diagnostic assertions do not inflate that denominator.

## Reproduction and next-machine handoff

```powershell
node --experimental-vm-modules docs/reviews/2026-11-05-review-fixes-recheck.mjs --upstream PATH_TO_PINNED_UPSTREAM --output PATH_TO_NEW_EVIDENCE.json
```

The [probe](2026-11-05-review-fixes-recheck.mjs) pins all production bodies via `git show`; the [evidence](2026-11-05-review-fixes-evidence.json) records source hashes, exact upstream blob identities, observations and reviewer dispositions. The upstream files are the same verified blobs at `eyeoverthink/fraymus-re-agent` commit `2f75cee7f54a4aa6bae219ec9241fc44f980c36b` used in the original review.

Actual bus, fleet dispatch, memory and Express handlers run against in-memory SQLite. Model/subprocess/compiler writable-filesystem boundaries are VM fixtures; removals are recorded against a virtual file map. Only harmless review input/evidence files are created in a fresh retained temporary directory named in the evidence. No live DB/application imports, server restarts, model/compiler calls or real deletions occur. Four source syntax checks and the probe syntax check pass. The dispositions are reviewer assessments of these specific observations, not a general automatic acceptance oracle.

Next work: make compiler directories exclusive first, then finish the real import/evidence/seal contracts, full-identity/legacy queries and stored measurement/opinion results. Repair the zero-root and evaluator validation cases before claiming lineage numerical correctness. Retain the original probes as historical failure baselines; add new corrected-behavior evidence at the next fix commit. Review tag: `review/lineage-dossier-fixes-2026-11-05`.

Fraynix - By Vaughn Scott
