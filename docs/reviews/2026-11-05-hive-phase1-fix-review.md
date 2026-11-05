# Hive bridge fix recheck — `4ba2c43` / `3b901f7`

**Independent verdict: partial fixes confirmed; changes still requested. Phase 1 is not independently accepted.** The implementation agent's 18 tests and its reported 10/10 gate results reproduce, but those tests omit observable failures in delivery, ingestion admission and receipt identity. This review records **6 scoped passes, 3 failed gates and 1 partial gate**. No production code was changed.

Implementation reviewed: `4ba2c433681bc6fecac6acc9b0c1c18c232b1592`. Acceptance claim/tracker: `3b901f731f1147e878a6b91b89cf015c347325ef`; intermediate tracker: `dd8f28a`. Upstream receipt blob remains `9fcb7465a12abc80117c45c02c9d064a15ed81cf` at upstream `2f75cee7f54a4aa6bae219ec9241fc44f980c36b`. Reviewer: this Codex independent review session (`01a1a46f-ddc2-70c0-abde-3eaec155a571`). The implementation/recheck session ID was not supplied; shared Git identities do not establish reviewer independence.

Evidence:

- [Independent pinned-source probe](2026-11-05-hive-phase1-independent-recheck.mjs) and [20-assertion observations](2026-11-05-hive-phase1-independent-evidence.json).
- Independently rerun [author acceptance results: 18/18](2026-11-05-hive-author-acceptance-rerun.json) and [author recheck results: reported 10/10](2026-11-05-hive-author-recheck-rerun.json). These confirm what the supplied scripts test, not the completeness of their acceptance criteria.
- [Original review](2026-11-05-hive-phase1-review.md) and failed baseline remain unchanged.

## Fixes confirmed

The 13 known upstream receipts still verify and ingest correctly. Identical and whitespace-reserialized raw receipts now deduplicate on a clean database. Projection events use `hive.unverified.*`; the actual trusted-topic trigger does not run for them. DEL U+007F escaping matches Python. Complete malformed suffixes are now reported by `verifyHiveChain()`. A rejected checkpoint or controlled process exit rolls back both SQLite event and ingestion rows. The isolated installer, HTTP stats, subscribers and history checks continue to work.

These are real improvements. They do not establish the stronger claims below.

## Remaining findings

### HIVE-02 — P1, still open: notifications escape the SQLite transaction

[hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 295–305, wraps the existing `publish()` in `db.transaction()`. But [bus.js](../../server/fleet/bus.js), lines 53–61, synchronously invokes subscribers and broadcasts **before** the outer transaction commits. The original review explicitly warned that wrapping this function alone was insufficient.

Two independent reproductions distinguish durable rows from delivered events:

| Controlled fault | SQLite result | Observable consumer result |
| --- | --- | --- |
| Own fixture child exits after notification, before commit | Zero event/checkpoint rows before retry; exactly 13 receipt rows after retry | External temporary-file observer records **14 notifications for 13 identities**; first receipt delivered twice |
| Disposable SQLite trigger rejects checkpoint insert | Event and checkpoint rows both roll back | Subscriber runs once and actual bus-trigger dispatcher starts the counter-only workflow once; its asynchronous completion leaves one workflow-run row |
| Retry after removing that fixture constraint | One durable receipt row | **Two subscriber deliveries and two workflow executions** for that receipt |

The author's recheck counts persisted `bus_messages` rows as “deliveries.” Its crash hook is still named `EXIT_AFTER_COMMITTED_BUS_PUBLICATION`, although this publication is now inside an uncommitted transaction. Zero orphaned rows demonstrate row atomicity; they do not undo effects already sent to subscribers.

**Closure:** persist event/checkpoint state atomically, notify after commit through recoverable delivery, and define consumer idempotency. Test both external notification logs and actual trigger dispatch across rollback/restart. `RE-P1-G7` remains failed for delivered events even though its durable-row subcheck passes.

### HIVE-03 / HIVE-01 — P1, still open: malformed input can be admitted as trusted

[hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 236–248 and 278–288, calculates ingestion trust from only the parsed records. It does not incorporate `malformed` into that trust decision. Lines 315–328 also report status from that parsed subset.

One byte changed in the last of 13 newline-terminated receipts now gives `verifyHiveChain().intact === false`, which is fixed. However, `ingestHiveFile()` on the **same file** returns `chainStatus: 'INTACT'`, publishes **12 verified receipts on trusted topics**, and invokes the actual trusted-topic trigger once. It includes a malformed-record diagnostic, but that diagnostic does not prevent trusted dispatch. Partial trailing input still returns `intact: true`, despite the spec requiring rejection of partial trailing lines.

The new recheck uses this assertion:

```js
ingested.chainStatus !== 'INTACT' || ingested.malformed?.length > 0
```

The right side makes it pass while the status is still `INTACT`. Its G8 check also explicitly accepts seven trusted-prefix publications from a damaged chain. The declared Phase 1 invalid-input gate has not been changed to authorize that policy.

**Closure:** use one validated input/admission result for verification, status and dispatch. Reject/quarantine malformed or partial batches before trusted publication. If verified-prefix processing is intended, specify its boundaries and downstream policy explicitly, then obtain independent acceptance against that revised contract. The current gate cannot pass by silently changing the test expectation. `RE-P1-G8` remains failed.

### HIVE-04 — P1, still open: unsupported numbers are not rejected before hashing

DEL is fixed. The new comment narrows the claimed domain, but [hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 78–81 and 188, does not enforce a safe numeric domain or preserve number lexemes before `JSON.parse()` loses information. Five of the eight Python-generated compatibility cases still mismatch: supplementary-plane key ordering, integral floats, small/large float formatting and an unsafe integer.

There is now stronger integrity evidence than an interoperability failure:

1. Python seals a fixture whose evidence value is `9007199254740992`.
2. Change the final numeric digit to `9007199254740993` without changing `self`.
3. Python recomputes a different expected hash for that changed content.
4. JavaScript rounds the changed value back to the former number. The bridge reports **`intact: true`**, returns `INTACT` on ingestion, and publishes a trusted event.

This is a lossy-parser alias, not a break of SHA-256. A source-code comment cannot prevent an out-of-domain value from receiving a trusted status. The supplied recheck only adds a DEL case, and one of its Python comparisons parses both strings before comparing their values, which cannot prove byte-exact serialization.

**Closure:** reject unsupported number/key forms before lossy conversion, or preserve and canonicalize them according to the upstream contract. Add Python-grounded tamper and compatibility fixtures. `RE-P1-G5` remains failed on this one-byte numeric change, as well as the partial-input requirement.

### HIVE-05 — P1, partially fixed: unverified identities suppress corrected receipts

[hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 204–211 and 274–286, uses the supplied `self` as the dedup key even when it has not verified. The dedup lookup happens before the trust decision.

Ingest a file tampered at index 7, retaining its original `self` values. Seven records reach trusted topics and six reach unverified topics. Then ingest the original, intact 13-receipt file: it reports `INTACT` but **skips all 13**, leaving only seven trusted receipt rows. The six corrected receipts never reach their trusted topics because their unverified predecessors reserved those identities.

**Closure:** do not let unverified claimed identities occupy the verified namespace. Define promotion/replacement behavior and content identity for quarantined input. Test damaged-first/corrected-second ingestion and require all valid corrected receipts to be delivered under the intended trust policy. Ordinary formatting dedup is confirmed, but it does not close recovery behavior.

### HIVE-05 — P2, additional upgrade gap: legacy checkpoints are not migrated

The earlier implementation stored trimmed-line hashes; the fix stores raw `self` hashes. `ensureHiveBridgeTable()` has no migration or compatibility lookup for existing rows. An isolated database populated by actual `8b52ac9` code contains 13 receipt events. Opening it with `4ba2c43` and ingesting the same file adds all 13 again: **26 durable events**.

**Closure:** migrate/version existing identities safely or recognize already-stored legacy receipts before publication. Test a real prior-version database upgrade. `RE-P1-G6` is partial: the clean-database formatting test passes, while recovery and upgrade behavior do not.

### HIVE-06 — P2, tracking: the acceptance attribution and evidence handoff are unsupported

The tracker in `3b901f7` calls the post-fix verdict independent while retaining “Reviewer: this Codex independent review session.” This Codex session had only reviewed `8b52ac9` at that point and had **not** accepted `4ba2c43`. No separate reviewer/session identity is recorded for the claimed closure. Git's shared author identity and co-author name cannot resolve that provenance. Treat the submitted recheck as author-side evidence unless a separate reviewer is identified.

The purported evidence JSON files were also outside Git under `F:\Claude-Work\re-agent-phase1`; links such as `../../F:/Claude-Work/...` do not resolve from the repository. This review commits fresh rerun JSON results so another machine can inspect them. The author scripts remain unchanged.

**Closure:** record author and independent reviewer/session separately, link committed evidence, and report the actual scoped verdict. This review supplies that independent verdict: changes requested. The earlier review tag still points to the earlier review; it is not a Phase 1 acceptance tag.

## Current independent ledger

| Gate | Author recheck reports | Independent result | Reason |
| --- | --- | --- | --- |
| G1 | PASS_ISOLATED | PASS_ISOLATED | Actual installer and runtime wiring checked; full application boot not run |
| G2 | PASS_ISOLATED | PASS_ISOLATED | Valid formats detected |
| G3 | PASS_ISOLATED | PASS_ISOLATED | Valid 13-receipt fixture ingests correctly |
| G4 | PASS_ISOLATED | PASS_ISOLATED | Projection isolation confirmed with actual trigger code |
| G5 | PASS | FAIL | Numeric tampering accepted; partial input still treated as intact |
| G6 | PASS | PARTIAL | Clean formatting dedup fixed; corrected-input and prior-version upgrade gaps |
| G7 | PASS | FAIL | Durable row atomicity fixed; subscriber/workflow delivery still repeats |
| G8 | PASS | FAIL | Malformed input still reaches trusted dispatch; prefix exception not in declared gate |
| G9 | PASS_ISOLATED | PASS_ISOLATED | Actual isolated HTTP stats route works |
| G10 | PASS_ISOLATED | PASS_ISOLATED | Actual subscribers/history work for valid input |

The other 46 phase criteria and five cross-phase scenarios remain unverified. This reviewer remains independent and has not started Phase 2A.

## Reproduction and limits

```powershell
node docs/reviews/2026-11-05-hive-phase1-independent-recheck.mjs --upstream PATH_TO_PINNED_UPSTREAM --output PATH_TO_NEW_EVIDENCE.json
```

The probe verifies the upstream Git blob and uses `git show` at full pinned commits for production function bodies. It injects disposable SQLite and the actual bus/trigger code; the workflow executor records invocations only. HTTP routes run on an ephemeral loopback port. The crash observer writes only to a temporary local file, and only the probe's own child exits. No live database is opened, replaced or checkpointed. No live server is restarted or killed.

The original diagnostic probe intentionally pinned the failed baseline and asserted the defects. That made it reproducible historical evidence, not a fix acceptance test. A separate fix probe is appropriate; changing the pin and computing verdicts cannot compensate for weakened assertions or missing side-effect observations. Twenty diagnostic assertions here likewise include defect reproductions and are not twenty product acceptance passes.

Next: implementation owner addresses the remaining HIVE-01–05 behavior, adds meaningful acceptance tests, and supplies fix commits for another independent review. Tag for this review: `review/hive-phase1-fixes-2026-11-05`.
