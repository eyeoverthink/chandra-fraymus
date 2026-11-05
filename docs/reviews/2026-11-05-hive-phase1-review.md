# Hive bridge Phase 1 — independent implementation review

**Verdict: changes requested; Phase 1 is implemented, but not complete.** The 13 known upstream receipt hashes really do match. Independent checks produce **6 scoped passes, 3 failures and 1 partial result** against the ten Phase 1 criteria. No phase is independently accepted.

Reviewed implementation: `8b52ac96d1ce65782d21bd4c770e2fb8bdd2873b`. The later tracker-only commit `931783b` does not change that implementation. Upstream: `2f75cee7f54a4aa6bae219ec9241fc44f980c36b`; receipt file Git blob: `9fcb7465a12abc80117c45c02c9d064a15ed81cf`. Reviewer: Codex independent review session, separate from the implementation session. Review tag: `review/hive-phase1-2026-11-05`.

Evidence: [29-assertion diagnostic probe](2026-11-05-hive-phase1-probe.mjs), [behavioral results and source hashes](2026-11-05-hive-phase1-evidence.json), [committed-source inventory](2026-11-05-hive-phase1-progress.json). The assertions reproduce defects as well as successful controls; 29 diagnostic assertions do **not** mean 29 product acceptance passes.

## Findings

### HIVE-01 — P1: damaged and unverified input still reaches actionable topics

In [hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 192–214, raw and projected input share canonical `hive.*` topics. A damaged chain still publishes every record; records before the break are marked verified. With receipt 7 altered, verification correctly returns `DAMAGED`, but ingestion publishes all 13 records and grants `chainVerified: true` to seven of them.

More directly, a projection carrying `_hive.chainVerified: false` on `hive.fra-pipeline:dossier` invokes the actual [bus trigger dispatcher](../../server/fleet/bus-triggers.js) once. That dispatcher selects by topic and does not enforce the flag. The probe uses the real bus and trigger code, a stored workflow, and a counter-only workflow executor; it does not execute a real autonomous action.

**Impact:** tagging an event as unverified does not prevent its consumption as a trusted action input. Gate `RE-P1-G8` explicitly requires damaged/unverifiable input not to publish trusted downstream events. Deferring enforcement to Phase 6 cannot close this existing Phase 1 gate.

**Closure:** define and test deterministic admission before actionable publication. Quarantine invalid batches, or use an enforced untrusted namespace/policy that all trusted consumers reject. State any verified-prefix exception explicitly in the contract and test it; do not infer it from a boolean flag. Repeat the projection-to-trigger test and require zero trusted workflow invocations.

### HIVE-02 — P1: a restart duplicates a committed publication

[hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 205–224, calls `publish()` before saving `hive_ingestion`. The real bus commits its row and synchronously notifies subscribers inside `publish()`. A process interruption between publication and the ingestion insert therefore leaves no checkpoint for an event already delivered.

The fixture exits its own child process at exactly that point. After reopening the same disposable SQLite database, there is **1 bus receipt and 0 ingestion rows**. Retrying the 13-receipt file produces **14 receipt publications for 13 identities**, with the first receipt delivered twice. Advisory `hive.chain.status` events are excluded from these counts.

**Impact:** the author's description is compatible with at-least-once delivery, which permits duplicates. It does not satisfy gate `RE-P1-G7`, whose text requires “no duplicate bus events,” or establish safe replay of subscriber side effects. Content-hash lookup cannot help when its row was never saved.

**Closure:** choose an explicit delivery contract. For the current gate, couple durable event identity and ingestion bookkeeping atomically, then deliver after commit through a recoverable outbox or equivalent design. Subscribers need idempotency where retries can repeat effects. Simply wrapping the current `publish()` call in a transaction is insufficient because it notifies subscribers before that transaction commits. If the product intentionally chooses at-least-once delivery, revise the gate and independently verify idempotent downstream handling before claiming crash safety.

### HIVE-03 — P1: malformed final records disappear before verification

[hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 146–153, drops the final nonblank line whenever JSON parsing fails, including a complete newline-terminated record. Verification then assesses only the remaining prefix.

Changing one byte of the real thirteenth line from `{` to `!` results in `{ total: 12, intact: true }`. Ingestion publishes twelve verified receipts and reports `INTACT` with no errors. A file containing only a malformed record becomes `{ total: 0, intact: true, format: 'unknown' }`. An incomplete final line is also silently ignored, although the spec says to reject partial trailing lines.

There is also no complete record-schema check: a hash-consistent raw record missing `type` verifies as intact and publishes to `hive.review:undefined`.

**Impact:** gate `RE-P1-G5` fails its one-byte tampering test when the change damages JSON syntax at the end. The reported status can conceal input corruption instead of identifying it.

**Closure:** validate every nonblank record and required fields before trusted dispatch. Reject or explicitly report partial input and its boundary; never describe a silently truncated input as fully intact. Add final-line syntax corruption, incomplete input, malformed-only input and missing-field acceptance tests.

### HIVE-04 — P2: 13 matching receipts do not prove the full Python serialization contract

The implemented serializer fixes the previous compact-JSON mismatch for all 13 known receipts. Nested ASCII and ordinary Unicode text controls also match Python. However, independently generated `json.dumps(..., sort_keys=True)` receipts fail in six additional cases:

| Case | Mismatch |
| --- | --- |
| DEL, U+007F | Python escapes it; `pythonJsonString()` emits it literally |
| Supplementary-plane versus BMP object keys | JavaScript UTF-16 sorting differs from Python code-point ordering |
| Integral float `1.0` | Parsing and `JSON.stringify()` turn it into `1` |
| Small float `1e-7` | Exponent formatting differs |
| Large float `1e20` | Decimal/exponent formatting differs |
| Integer `9007199254740993` | Ordinary JavaScript parsing loses integer precision |

The relevant implementation is lines 33–79 and the `JSON.parse` call at line 168 of [hive-bridge.js](../../server/intelligence/hive-bridge.js). These are valid Python-produced JSON fixtures; they are not claims that the pinned 13 receipts already contain these values.

**Impact:** legitimate future numeric or Unicode evidence can be rejected as damaged. REF-01 is fixed for the known dataset, but the unrestricted compatibility claim remains too broad.

**Closure:** preserve the numeric information needed for the upstream serializer, implement its supported domain, or explicitly narrow and enforce a producer/consumer format before lossy parsing. Keep real upstream fixtures and the cross-language edge-case matrix in repository tests. Do not substitute a new canonical JSON standard unless the producer contract changes with it.

### HIVE-05 — P2: deduplication follows line bytes rather than receipt identity

[hive-bridge.js](../../server/intelligence/hive-bridge.js), lines 175–190, deduplicates a hash of the trimmed serialized line. The unchanged receipt `self` is not the ingestion identity.

Two controls work: an identical second ingestion skips all 13 receipts, and genuinely new content replacing the file at the same path is ingested once. But replacing that same path with a whitespace-reserialized version of the original 13 receipts still verifies intact and publishes all 13 again. Stored ingestion rows grow from 13 to 26 for the same receipt identities.

**Impact:** transfer tooling that reserializes JSON can repeat downstream work. The literal identical-input and new-content rotation checks pass; the spec's “receipt content hash” wording does not clearly define semantic identity. Gate `RE-P1-G6` is therefore **PARTIAL**, rather than treating an unstated byte-normalization rule as an unambiguous gate failure.

**Closure:** specify stable identity and its source/format scope. For verified raw records, the validated upstream `self` is an available identity; define a suitable canonical projection identity separately. Verify same-path replacement, formatting changes, new receipts and separate source streams. The current table also lacks the per-source file identity/watermark described in the spec.

## Gate ledger

All results apply to `8b52ac9`, tested by the independent reviewer using the committed probe and pinned fixtures. `PASS_ISOLATED` records the observed scope; it does not imply live deployment or a complete application startup test.

| Criterion | Result | Independent observation |
| --- | --- | --- |
| RE-P1-G1 — startup table | PASS_ISOLATED | Actual route installer creates table; actual runtime import/call inspected. Full application boot not run. |
| RE-P1-G2 — formats | PASS_ISOLATED | Valid raw and projection samples detected. |
| RE-P1-G3 — raw publication | PASS_ISOLATED | Thirteen valid receipts published with verified metadata. |
| RE-P1-G4 — projection metadata | PASS_ISOLATED | Projection is flagged false; verification API rejects it. This does not pass G8. |
| RE-P1-G5 — tampering | FAIL | Structured tampering detected; malformed last record silently discarded. HIVE-03. |
| RE-P1-G6 — dedup/rotation | PARTIAL | Identical bytes/new content work; formatting-only replacement replays identities. HIVE-05. |
| RE-P1-G7 — crash/restart | FAIL | Fourteen publications for thirteen identities. HIVE-02. |
| RE-P1-G8 — invalid input | FAIL | Damaged file publishes verified-prefix events; unverified projection invokes trigger. HIVE-01. |
| RE-P1-G9 — stats | PASS_ISOLATED | Actual isolated HTTP route returns raw/projection counts. |
| RE-P1-G10 — bus delivery/history | PASS_ISOLATED | Actual subscribers and actual history route receive dossier events. |

The other 46 phase criteria and five cross-phase scenarios remain unexercised. The generic inventory script's default zero independent-pass count is not a behavioral verdict; this ledger and the behavioral JSON supply the independent results.

## Claim disposition and next machine

The tracker at `931783b` accurately identifies that Phase 1 code exists. Its stronger closure claims need correction: REF-01 has known-fixture success with HIVE-04 still open; REF-02b fails the existing restart gate; REF-02a cannot defer while Phase 1's trust gate remains unchanged. REF-03 workflow execution and REF-04 downstream evidence storage remain legitimate later-phase work. The corrected total of 56 phase criteria is confirmed.

The implementation agent's external `test-canonicalization.mjs` copies the hashing functions and uses a machine-specific source path. It is useful fixture evidence, but was not included in the three-file implementation commit and does not exercise publication/restart/trigger behavior. The repository probe evaluates the actual pinned production function bodies instead.

To reproduce, provide a directory containing `hive/receipts.jsonl` from the pinned upstream commit. The probe checks the exact Git blob before testing. Existing local Node dependencies, Python and Git are required; no RE toolchain install is needed.

```powershell
node docs/reviews/2026-11-05-hive-phase1-probe.mjs --upstream PATH_TO_PINNED_UPSTREAM --output PATH_TO_NEW_EVIDENCE.json
node scripts/check-re-agent-progress.mjs --ref 8b52ac9 --output PATH_TO_NEW_INVENTORY.json
```

The VM harness removes import/export declarations and injects disposable SQLite, the real bus implementation and local fixture reads. HTTP tests run on an ephemeral loopback port. Only workflow execution is a counter-only mock. The controlled interruption exits only the probe's own child process. No live Chandra database was opened, migrated, replaced or checkpointed; no live server was restarted or killed. Production source is unchanged by this review.

Implementation owner should address HIVE-01–05, retain these failed baselines, and supply fix commits plus focused acceptance tests. Recheck those commits independently before marking Phase 1 complete or relying on its trusted downstream contract.
