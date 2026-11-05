# Phase 2A authentic-source/migration recheck — `b999ed7`

**Verdict: substantial scoped fixes confirmed; Phase 2A is not yet complete.** The author suite reproduces **14/14 subchecks**, including construction of the actual fleet registry with 142 tools and all six RE tools. The declared task-and-response criterion remains unverified. A new migration-ownership finding requires attention before relying on automatic startup cleanup.

Reviewed commit: `b999ed7e74b1b7db441131e4227ae3dc57e44e59`. Independent reviewer: Codex session `01a1a46f-ddc2-70c0-abde-3eaec155a571`. Evidence: [13-assertion independent probe](2026-11-05-phase2a-migration-recheck.mjs), [results including the complete author rerun](2026-11-05-phase2a-migration-evidence.json). Assertions include both passing controls and defect reproductions.

## Confirmed closure within scope

| Prior finding | Current disposition |
| --- | --- |
| RE2A-01 — authentic source/provenance | SCOPED FIX CONFIRMED. All eighteen numbered summaries correspond to the retained upstream document. Source reaches lookup consumers. Actual known legacy seed rows migrate correctly. |
| RE2A-02 — verified memory identity scope | SCOPED FIX CONFIRMED. Verified numeric entries survive across categories without row mutation; verified historical L-prefixed corrections are retained. |
| RE2A-03 — disposable DB testing | PRIOR FIX RETAINED. DB override precedes DB imports. The expanded registry import also initializes cwd-based filesystem state, so this reviewer reran it in an archived source copy with its own cwd/workspace. |
| RE2A-04 — functional fleet task | OPEN. Building a registry proves registration, not execution and a response. |

The [retained source](fixtures/re-build-gates-2f75cee7.md) is still the exact upstream Git blob `43377715d18c7d892fa71c3dab3167da070f6936` from upstream `2f75cee7`. The new entries are summaries, not verbatim copies; their numbering, lesson identities and remedies now follow that source.

Independent checks establish:

- A fresh seed creates eighteen distinct numbered entries at confidence 0.9.
- Repeating the unchanged seed produces no row mutations.
- JDK/dylib/npm lookups return numbered entries and source provenance.
- Actual `dcb0658` plus `e8410f3` seeding creates 36 legacy rows; the new code updates eighteen numeric rows and removes eighteen unverified reconstructed rows, leaving eighteen authentic entries.
- A verified recategorized numeric row survives byte-for-byte.
- A verified historical L1 correction survives; in that fixture, nineteen rows are intentional: eighteen source lessons plus the retained historical correction.

These observations close the original source substitution and verified-identity reproductions within their tested scope. They are progress beyond the earlier reviews.

## RE2A-04 — still open: registry membership is not a task and response

The new G6b executes `createFleetTools({ workflowStore: null })`, builds a name set, and checks that the manifest's six RE tool names appear. That is a meaningful registration check. It still performs no `POST /api/fleet/runs`, starts no fleet run, observes no run completion and checks no assistant response.

The spec's sixth criterion explicitly requires an agent task through the fleet API and a response. Neither the spec nor this user's instructions replaced it with registry membership. Fourteen passing subchecks cannot close that missing test. The first criterion's `/api/agents` versus manifest-backed `/api/fleet/agents` mismatch and Tycho's functional regression also remain partial.

**Closure:** in isolated persistence/runtime, submit a task to RE Analyst, poll the run/thread to completion and assert a response. Exercise an authorized RE tool through the actual execution/permission path, and retain a Tycho regression. A deterministic Ollama fixture can verify routing and execution; label that separately from live-model quality. No production server boot is required merely to prove this flow in a test harness.

## RE2A-05 — P2, new: migration changes local notes without checking seed ownership

The new migration selects every `re-analyst` row whose key matches `build_gate_%`, regardless of category or source. Numeric entries that are not verified are overwritten with source lessons. Every unverified key matching `build_gate_L\d+` is deleted, even outside the L1–L18 range produced by the earlier seeder.

The missing condition is ownership/provenance: `verified_at IS NULL` does not establish that a row was created by either legacy seeder.

In a disposable database **without running any legacy seeder**, the probe creates two local operator notes:

| Key | Category/source | Startup migration result |
| --- | --- | --- |
| `build_gate_L77` | `local_fix`, operator work in progress, confidence 0.8, unverified | Deleted |
| `build_gate_3` | `local_fix`, pending local correction, confidence 0.8, unverified | Value/source/category replaced with the upstream seed |

The first key was never generated by either previous eighteen-entry seeder. Both records have operator provenance rather than a known legacy seed source. The existing verified-row protection works; this is an additional issue introduced by the new automatic cleanup/update policy.

**Closure:** limit repair/deletion to known legacy seed ownership and known versions/keys. Preserve or quarantine other local/in-progress entries instead of treating all unverified matching names as disposable. Record migration actions and original values/provenance. Keep the now-passing actual 36-to-18 upgrade and verified-history cases as controls, and add local non-seed rows with overlapping names.

## Isolation and artifact limits

The new full-registry import reaches `fraymus-tools.js`, which instantiates Ledger and Dreamer. Those constructors use `process.cwd()/data/ledger` and `process.cwd()/data/dreams` independently of `CHANDRA_DATA_DIR`. A disposable database alone is therefore narrower than a wholly disposable runtime.

This review did not import the application into the live workspace. The probe archives pinned `server/`, `agents/`, the package manifest and the test script to a new temporary source copy, links installed dependencies, and runs the author script with cwd/workspace inside that copy. Its persistence and constructor-created filesystem state are confined there. No fleet/model task or live server restart occurred. Temporary fixtures are retained; no cleanup deletion was attempted in this review.

The author left its v3 evidence JSON untracked while linking it from the progress file. Disposable databases can be discarded; acceptance evidence needs to travel with the review. The committed independent JSON now contains a fresh complete fourteen-subcheck rerun, exact source hashes and the separate migration observations. The existing untracked author file was not staged or changed by this reviewer.

## Current six-criterion ledger

| Criterion | Independent result | Scope |
| --- | --- | --- |
| RE-P2A-G1 | PARTIAL | Discovery/allowlist confirmed; declared host-registry endpoint remains wrong |
| RE-P2A-G2 | PASS_ISOLATED | Prior positive wrapper controls unchanged; Phase 1 defects remain open |
| RE-P2A-G3 | PASS_ISOLATED | Authentic keyword results now include source provenance |
| RE-P2A-G4 | PARTIAL | Fresh/source/known-upgrade and verified preservation pass; local non-seed migration ownership remains open |
| RE-P2A-G5 | PARTIAL | Tycho manifest preserved; functional model-backed regression unverified |
| RE-P2A-G6 | UNVERIFIED | Actual registry confirmed; task/response missing |

Result: **2 scoped passes, 3 partial criteria, 1 unverified criterion**. This improves on the earlier failed G4 result without claiming phase completion. Independent phase acceptance remains **0/7**; Phase 1 and Phase 2B statuses are unchanged.

Remote `origin/master` was independently confirmed at `b999ed7` before this review commit. `9f40b41` had already been pushed, as recorded by the preceding review. Current Git state proves the successful push; it does not establish the cause of earlier remote errors.

Reproduce:

```powershell
node docs/reviews/2026-11-05-phase2a-migration-recheck.mjs --output PATH_TO_NEW_EVIDENCE.json
```

Requires local Node dependencies, Git and Python. The upstream fixture is already committed. This review changes only review artifacts/documentation, not production code or live memory. Tag: `review/re-agent-phase2a-migration-2026-11-05`.
