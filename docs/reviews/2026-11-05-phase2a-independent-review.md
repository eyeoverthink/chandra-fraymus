# RE Agent Phase 2A — independent review of `dcb0658`

**Verdict: registration work is present; changes requested. Phase 2A is not independently accepted.** The submitted acceptance script reports 9/9 checks, and that result reproduces with a prepared disposable database. It does not prove the six declared gates: the build-gate catalog is not the pinned upstream catalog, startup overwrites locally verified knowledge, and the required fleet task/response is never exercised.

Reviewed commit: `dcb065868448978ac5f8b963b7e326ca64a7b374`. Reviewer: Codex independent session `01a1a46f-ddc2-70c0-abde-3eaec155a571`, separate from implementation. Evidence: [18-assertion pinned-source probe](2026-11-05-phase2a-independent-probe.mjs) and [full observations/source hashes](2026-11-05-phase2a-independent-evidence.json). Assertions include defect reproductions, not 18 acceptance passes.

Upstream: `eyeoverthink/fraymus-re-agent` at `2f75cee7f54a4aa6bae219ec9241fc44f980c36b`, `docs/BUILD-GATES.md` Git blob **`43377715d18c7d892fa71c3dab3167da070f6936`**. The local source bytes match that blob, and an authenticated GitHub contents lookup independently confirms it.

## Confirmed work and boundaries

The actual manifest loader discovers `re-analyst` with exactly ten explicit tool names and preserves Tycho as the separate `rea_analyst`. The actual fleet allowlist excludes an unrelated tool. `createRETools()` returns six tool definitions, spread into `createFleetTools()`, and startup calls `seedBuildGates()`. The actual `re.verify_chain` wrapper verifies the 13 known raw receipts and returns an error for projection verification; this is a positive-fixture check, not closure of Phase 1's remaining integrity findings.

Keyword lookup works against seeded rows. Fresh seeding creates eighteen entries at confidence 0.9. The four dossier/compile tools explicitly throw a Phase 3 dependency error. That deferral matches the 2A/2B split: there is no implemented compiler measurement, prediction, dossier ingestion or query to accept under 2B yet.

## RE2A-01 — P1: substituted lessons are attributed to the wrong upstream source

[re-tools.js](../../server/fleet/re-tools.js), lines 14–32, hardcodes eighteen lessons and assigns source `BUILD-GATES.md (upstream, not reproduced locally)` at line 43. Their gate identities and contents do not match the actual numbered document:

| Gate | Actual pinned upstream lesson | Seeded lesson |
| --- | --- | --- |
| 1 | radare2 install attempts sudo without a terminal; use a user-owned prefix | JDK 25 requirement |
| 3 | Ghidra JDK 21 daemon fails on `UseCompactObjectHeaders`; use JDK 25 | Per-function analyzer timeout |
| 7 | npm 11 install scripts need explicit approval for esbuild/fsevents | Python 3.12 requirement |
| 14 | Updating Node fixes the rea runtime | Receipt append crash |
| 18 | r2ai build/linking/CLI fixes | Ghidra project directory permissions |

Some seeded advice resembles other project observations or general suggestions, but it is not the numbered upstream lesson it claims to be. Exact source comparisons for all eighteen entries are retained in the evidence. Merely storing the right number of rows at 0.9 does not establish documentary provenance. Lookup consequently presents wrong gate references as documented knowledge.

**Closure:** import/retain the actual pinned source entries, preserving their numbers and source commit/blob. Label additional inferred suggestions separately with their own provenance; do not overwrite source lessons with them. Test representative content and the full numbered mapping against the source, not just counts and keyword hits. Plan a safe correction for any copies already seeded; this review did not inspect or alter live memory.

## RE2A-02 — P1: startup reseeding destroys local corrections and retains stale verification

[seedBuildGates()](../../server/fleet/re-tools.js), lines 37–46, calls `storeMemory()` for every existing key, then calls updated rows “skipped.” [agent-memory.js](../../server/fleet/agent-memory.js), lines 11–16, replaces the value, confidence and source while leaving `verified_at` intact.

In a disposable database, the probe seeds eighteen rows, replaces Gate 1 with a local correction at confidence 1.0, and marks it verified. Calling `seedBuildGates()` again:

- Reports `seeded: 0, skipped: 18`.
- Replaces the local correction with the hardcoded catalog text.
- Lowers confidence from 1.0 to 0.9 and replaces its local source.
- Retains the old non-null `verified_at`, so replacement content still appears verified.

This occurs on the normal startup path immediately after `createFleetTools()`. It contradicts the intended progression from documented knowledge to locally reproduced knowledge and makes the “already existed” log misleading.

**Closure:** make initial seeding genuinely insert-only/idempotent. Preserve local corrections, confidence and verification. Apply source updates through explicit versioned migrations with per-entry provenance and a defined conflict policy; never carry verification from one value to a different value. Test verified local entries, repeat startup and upstream source upgrades.

## RE2A-03 — P1: the acceptance script writes the configured application database

[phase2a-gate-acceptance.mjs](2026-11-05-phase2a-gate-acceptance.mjs), lines 91, 126–129 and 155, directly imports `hive-bridge.js`, `re-tools.js` and `agent-memory.js`. Those imports reach `server/db.js`, which opens the configured database, runs schema/bootstrap writes and attempts a WAL checkpoint. The test then calls `seedBuildGates()` and performs memory lookups that increment access counters.

Its header says it uses VM isolation, but the script contains no such isolation. With the default command and no data-directory override, it uses the normal configured data directory. Combined with RE2A-02, running an acceptance test can overwrite actual agent knowledge.

This review reran it **only** in a child with `CHANDRA_DATA_DIR` explicitly set to a new temporary directory, after creating the required memory table there. It reports 9/9 and writes eighteen rows into that disposable database. No live database was opened by this review. The prepared fixture matters: the submitted script also depends on an already-migrated `agent_memories` table without creating it itself.

**Closure:** make isolation the default enforced behavior of the test harness. Inject disposable persistence or spawn a child with a validated fresh data directory before any database-owning import, initialize the fixture schema, and verify repeatability. Correct the misleading header and provide a safe reproduction command that requires no hidden live database setup.

## RE2A-04 — P2: the tests substitute registration for functional fleet gates

The spec has six Phase 2A criteria. The script counts nine subchecks by splitting raw/projection and the three keyword searches; nine successful rows are not nine distinct gates.

Most materially, the sixth criterion requires **`POST /api/fleet/runs` and an agent response**. The script's G6 section, lines 209–246, instead checks that `createRETools()` returns six names and that the four deferred executors throw. It submits no HTTP request, calls no fleet run and observes no agent response. That behavior is unverified, rather than established broken.

The first criterion also names `/api/agents`, which actually serves host-node database rows. In the isolated test, actual handlers return `fixture-host` there, while `/api/fleet/agents` discovers `re-analyst` with ten tools and Tycho alongside it. The submitted G1 manually copies a frontmatter parser rather than exercising the actual loader/API. Tycho's file/name preservation likewise does not establish a functional model-backed run.

**Closure:** correct the spec to the manifest-backed route, test the actual loader/registry, and execute the declared task/response gate in an isolated runtime. Distinguish deterministic provider-fixture tests from live-model validation. Record Tycho's functional regression separately. Do not relabel a missing functional test as a registration pass or call these author checks independent acceptance.

## Independent Phase 2A ledger

| Criterion | Result | Scope |
| --- | --- | --- |
| RE-P2A-G1 | PARTIAL | Actual loader/fleet GET API has ten tools; declared `/api/agents` targets another registry |
| RE-P2A-G2 | PASS_ISOLATED | Actual wrapper works on known raw/projection fixtures; Phase 1 defects remain open |
| RE-P2A-G3 | PARTIAL | Keyword search works; returned gate identities/source content are wrong |
| RE-P2A-G4 | FAIL | Eighteen rows at 0.9 exist, but they are not the eighteen upstream lessons; reseeding corrupts local provenance |
| RE-P2A-G5 | PARTIAL | Tycho manifest coexists; functional run not exercised |
| RE-P2A-G6 | UNVERIFIED | Required fleet POST and agent response absent from author test and not run live by this reviewer |

Result: **1 scoped pass, 1 failed criterion, 3 partial criteria, 1 unverified criterion.** All four 2B criteria remain unverified/deferred. Phase 1 also remains changes requested under its separate review; neither phase is independently accepted.

## Reproduce and hand off

```powershell
node docs/reviews/2026-11-05-phase2a-independent-probe.mjs --ref dcb0658 --upstream PATH_TO_PINNED_UPSTREAM --output PATH_TO_NEW_EVIDENCE.json
```

The upstream directory must contain the exact `docs/BUILD-GATES.md` and `hive/receipts.jsonl` from the reviewed upstream commit. The probe uses pinned production function bodies with temporary manifests and in-memory SQLite, and tests actual GET handlers on an ephemeral loopback port. It does not submit a fleet run or call a model. The author script is separately rerun only with a prepared disposable database and an explicit child-process data-directory override. No application startup, live DB operation, server restart or source fix is part of this review.

Implementation owner should address RE2A-01–04, supply fix commits with content/provenance and startup-regression tests, and request independent recheck. Preserve the submitted 9/9 result as author evidence alongside this narrower verdict. Tag: `review/re-agent-phase2a-2026-11-05`.
