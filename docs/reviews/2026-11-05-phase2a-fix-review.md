# Phase 2A fixes — independent recheck of `e8410f3`

**Verdict: scoped fixes confirmed; Phase 2A still requires changes.** The submitted script reproduces **11 successful subchecks**. These are not eleven declared acceptance gates: Phase 2A still has six, and the task/response criterion is not exercised. Independent phase acceptance remains 0/7.

Reviewed commit: `e8410f30c7344cd291014e01cb3c971725d65dcf`; preceding implementation: `dcb0658`. Independent reviewer: Codex session `01a1a46f-ddc2-70c0-abde-3eaec155a571`. [Pinned-source probe](2026-11-05-phase2a-fix-probe.mjs), [13-assertion evidence](2026-11-05-phase2a-fix-evidence.json), [original review](2026-11-05-phase2a-independent-review.md). Diagnostic assertions include reproductions of remaining defects.

## Finding disposition

| Finding | Independent disposition |
| --- | --- |
| RE2A-01 — upstream provenance | PARTIAL. New local IDs and reconstructed-source labels are more honest; the required source lessons are still absent and old false attributions remain on upgrade. |
| RE2A-02 — destructive seeding | PARTIAL. Verified rows in category `build_gate` are preserved byte-for-byte. Existing keys recategorized into another category are still overwritten and downgraded. |
| RE2A-03 — test database isolation | SCOPED FIX CONFIRMED. Data override precedes DB-owning imports; migration prepares the disposable schema. The inherited sentinel database remains byte-identical. Cleanup has a remaining limitation below. |
| RE2A-04 — functional fleet gates | OPEN. G6b loads a manifest; it does not submit a task or observe an agent response. The mismatched spec endpoint is unchanged. |

## Confirmed improvements

On a clean disposable database, the new seeder creates eighteen `build_gate_L*` entries with reconstructed-source labels. After a same-category entry is corrected locally, upgraded to confidence 1.0 and verified, another seed skips all eighteen and leaves the **entire corrected row unchanged**, including value, source, access count and verification stamp. This fixes the common restart overwrite reproduced in the original review.

The revised acceptance script sets `CHANDRA_DATA_DIR` before dynamically importing the migration/database modules. Its location directly under the repository root lets the existing manifest loader find the real default manifests; that path reasoning is correct. The reviewer supplied an extra inherited data directory containing a deliberately non-database sentinel file. All eleven subchecks passed, the script selected its own disposable directory, and the sentinel bytes were unchanged. No live database was opened by this review.

## Remaining source and upgrade gap — RE2A-01

Renaming the catalog to L1–L18 changes its identity and disclaimer; it does not import the actual eighteen lessons required by the spec. The reconstructed entries remain at confidence 0.9, and the lookup description still calls them patterns from upstream `BUILD-GATES.md`.

The exact upstream source is available on this machine and is now retained as a review fixture: [BUILD-GATES.md at `2f75cee7`](fixtures/re-build-gates-2f75cee7.md). Its Git blob is **`43377715d18c7d892fa71c3dab3167da070f6936`**, matching the upstream source verified in the earlier review. It is evidence, not a production seeding change. The source need not be reconstructed from conversation or fetched from the iMac to finish this work.

There is also an upgrade defect. Actual `dcb0658` seeding writes eighteen `build_gate_1`…`build_gate_18` rows. Running the new code against that same disposable database adds eighteen `build_gate_L*` rows and retains the old ones:

- **36 total rows**, rather than a migration to the intended source catalog.
- **18 old false `BUILD-GATES.md` source attributions** remain intact.
- A JDK lookup returns four entries mixing old numeric and new local IDs.
- The lookup omits each memory's `source`, so the agent does not receive the new disclaimer through this tool's result.

**Closure:** import the authentic numbered source with its commit/blob, separate any reconstructed suggestions, and define an evidence-preserving migration for already-seeded rows. Return provenance to tool consumers. Do not simply delete or overwrite local verified corrections when reconciling old entries. Test both clean installation and actual prior-version data.

## Remaining identity-scope overwrite — RE2A-02

[re-tools.js](../../server/fleet/re-tools.js), lines 49–57, checks existing keys only inside `category = 'build_gate'`. But [storeMemory()](../../server/fleet/agent-memory.js) identifies an existing record by `(agent_id, key)` across **all categories**.

The probe stores `build_gate_L1` as a locally verified correction in category `local_fix`, at confidence 1.0. Seeding misses it, calls the upsert, replaces its value/source/category, reduces confidence to 0.9, and retains its old non-null `verified_at`. It reports eighteen new rows even though one was actually an update.

**Closure:** make the skip/insert policy use the same identity scope as persistence, or use an actual insert-only operation and count only inserts. Preserve existing values and verification regardless of recategorization. Keep the now-passing same-category regression as a positive control.

## Functional acceptance is still missing — RE2A-04

G6b calls `loadManifests().get('re-analyst')` and checks its ten tools. That proves discovery. It does not establish that the agent can run, invoke the configured tools under the fleet's permissions, or produce a response. The script itself acknowledges that no `POST /api/fleet/runs` test occurs.

The source and model-backed task/response requirements have not been revised in the spec. The original `/api/agents` versus `/api/fleet/agents` mismatch and Tycho functional regression also remain untested. Mark these unverified or partial; do not translate manifest discovery into an accepted functional gate.

**Closure:** exercise the declared API task and response in isolated persistence, label deterministic model fixtures separately from live-model evidence, and test Tycho's functional regression. Keep the four 2B tools deferred until their dossier engine exists.

## Test cleanup and tracking

The revised script registers its exit cleanup before importing the database module. On this Windows run, cleanup left `chandra.db` in `.test-2a-39cb8798`; cleanup runs before the later database-close exit handler and silently catches removal failures. Default DB isolation is confirmed, but cleanup is incomplete. Close disposable persistence before removing it and report cleanup failures.

Automatic approval review rejected both recursive and non-recursive reviewer cleanup attempts with “blocked by policy.” The disposable fixture was left at `F:\Fraymus-Skill-Lab\chandra-fraymus\.test-2a-39cb8798\chandra.db`; the live `data/chandra.db` was not touched.

The commit contains only `re-tools.js` and the acceptance script. It does **not** contain the claimed progress-tracker update. This review updates the tracker while retaining the prior baseline and the reproduced eleven-subcheck author result.

Current six-criterion ledger remains **1 PASS_ISOLATED, 1 FAIL, 3 PARTIAL, 1 UNVERIFIED**. G4 remains failed because authentic source import/upgrade and full identity-safe preservation remain incomplete; G6 remains unverified. Phase 1 findings are unchanged. This review makes no production changes.

Reproduce with the pinned upstream directory:

```powershell
node docs/reviews/2026-11-05-phase2a-fix-probe.mjs --upstream PATH_TO_PINNED_UPSTREAM --output PATH_TO_NEW_EVIDENCE.json
```

The probe evaluates pinned seeder/memory bodies with in-memory SQLite, tests current and prior-version seeds, and reruns the submitted script only after verifying its import/isolation ordering. No model call, fleet run or live server restart occurs. Tag: `review/re-agent-phase2a-fixes-2026-11-05`.
