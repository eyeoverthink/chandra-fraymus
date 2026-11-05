# RE Agent integration: independent specification and progress review

Date: 2026-11-05. Reviewer: Codex independent RE integration review session.

**Verdict: specification changes requested before implementing the bridge contract.** The seven-phase document is present and pushed. None of the proposed Chandra integration phases is implemented at the reviewed commit; **0/7 phases and 0/41 phase acceptance criteria are independently verified**. This is expected for a plan, but "approved for implementation" does not establish that its protocol and existing-system assumptions are correct.

## Evidence boundary

- Chandra source: `1eabcde54f389b0cb6a5d260c15c0b4b91bc60c9`; specification introduced in `837f679`. The local HEAD and `origin/master` matched when checked. `eb60df0` and `837f679` are in that history. The RE addition in these commits is the specification, not Phase 1 implementation.
- Upstream: authenticated read of private `eyeoverthink/fraymus-re-agent`, pinned to **`2f75cee7f54a4aa6bae219ec9241fc44f980c36b`**. Only the relevant scripts, documentation, receipt files, and small dossier were downloaded into a temporary review snapshot. No large upstream tool distributions were cloned.
- The actual Windows landing file `C:/Users/eyeka/hive/hive_genesis.jsonl` was read without modification. It has nine records and the projected schema described below.
- [Chandra progress inventory and local contract probes](2026-11-05-re-integration-progress.json), produced by [the repeatable checker](../../scripts/check-re-agent-progress.mjs).
- [Upstream protocol/parser evidence](2026-11-05-re-upstream-evidence.json), produced by [the pinned-source Python probe](2026-11-05-re-upstream-probe.py).

The checker evaluates isolated parser/classifier functions, not the application. The Python probe verifies upstream Git blob identities before loading those definitions; append/export tests operate only on a checked temporary directory. No production DB was opened, no live bus event or RE task was issued, and no compiler, binary, SSH job, model, cron, or cross-machine export was executed. Diagnostic assertions reproducing defects are not phase acceptance passes.

## What is confirmed

The document has seven phase sections, each with five or six checkboxes: **41 phase criteria**, plus five cross-phase scenarios. Its file tables total **eight planned creations and eleven distinct existing-file modifications**, excluding later edits to newly created files. It plans no deletions. Those counts describe the current plan; they do not prove an implementation will preserve existing behavior or fit the estimate after the issues below are resolved.

There is useful upstream evidence. Its committed raw `hive/receipts.jsonl` has **13 receipts** and verifies with the upstream chain verifier. The Windows projection has nine records; these are distinct snapshots/formats. The committed `dossier-ls/decompiled.c` has **136 function markers and 5,152 newline-terminated lines**. The original Tycho manifest already exists as `agents/rea_analyst.md`, but it is a web/artifact reconstruction analyst, not the proposed binary dossier integration; its existence does not complete Phase 2.

## Findings

### RE-01 — P1 — Phase 1 is pointed at a projection that cannot support the promised chain verification

The spec treats `hive_genesis.jsonl` as raw chained receipts and requires `prev` and `self`. The actual upstream `cmd_feed_akashic()` produces only:

```text
ts, type, src, msg, seal
```

It truncates the claim to 120 characters, drops evidence and chain fields, and sometimes substitutes a shortened self-hash for a seal. The nightly script SCPs **this projected file**, not `hive/receipts.jsonl`. The nine records already landed on Windows have exactly that projected shape and no complete chain fields. A Chandra verifier cannot reconstruct omitted payloads or validate that chain from this file.

The upstream raw format instead has `organ`, `type`, `claim`, `evidence`, `seal`, `i`, `ts`, `prev`, and `self`. It has no `src`; the adapter must define a mapping such as `hive.<organ>:<type>`. The actual hash algorithm is Python `json.dumps(record_without_self, sort_keys=True)` with default spacing/escaping, recursively sorted keys, and `prev` included inside the payload. A generic JavaScript `JSON.stringify()` is not a specified interoperable canonicalization. Genesis uses 64 zeroes.

**Required resolution:** identify a transport for the original raw receipts and pin byte-level fixtures for ASCII, Unicode, nested objects, numeric values, and genesis. Preserve the existing Akashic feed as a separate projection if needed. Label projection integrity **unverifiable**, rather than calling missing chain data "INTACT" or claiming it proves tampering. Specify which statuses may publish trusted downstream events.

The source-repo scope says its scripts will not change. Transferring the raw ledger therefore needs an explicit independent transport/setup step or a documented scope adjustment; it does not happen under the current nightly job.

### RE-02 — P1 — The proposed manifest is undiscoverable as placed, and its tool list grants wildcard access if parsed unchanged

The proposed file is `server/fleet/agents/re-analyst.md`. The real loader reads the top-level `agents/` directory relative to the configured data layout, plus `DATA_DIR/agents` overrides. It does not scan `server/fleet/agents/`.

The example also uses a YAML multiline `tools:` list. Chandra's actual parser supports comma-separated frontmatter and treats an empty `tools:` value as the default `'*'`. The isolated reproduction returns **wildcard permissions**, while a comma-separated positive control returns the intended nine tools. The fleet matcher accepts every registered tool for `'*'`.

**Required resolution:** use the supported top-level manifest location and frontmatter, or deliberately extend discovery/parser support with compatibility tests. Require an exact allowlist assertion; seeing an agent name in a list is insufficient. Preserve the existing distinct Tycho agent unless an explicitly reviewed migration is intended.

### RE-03 — P1 — The proposed compile-rate measure is a model prediction, and the upstream numeric baseline is parser-corrupted

Phase 2 defines `re.compile_rate` as asking Ollama whether C would compile. Phase 3 then labels compile rates as measured facts, stores a boolean `compileStatus`, and Phase 6 proposes to use improvements/regressions as an OPEG decision metric. A model opinion does not supply a compiler measurement.

The upstream script does use `clang -fsyntax-only`, but its `blocks()` function incorrectly groups `re.split()` output in threes even though each match contributes three captures **plus an inter-match fragment**. The actual 136-function dossier becomes **181 fragments**. The first supposed function is:

```text
name = "// decompiled: ls  image: /bin/ls\n"
addr = "FUN_100000718"
c    = "100000718"
```

The same regex's `findall()` produces 136 proper function records. Consequently the quoted **45/181 = 24.9%** is not a reliable per-function compile-rate baseline. This review did not run a compiler or establish the corrected numerator.

**Required resolution:** keep LLM compile predictions explicitly separate from compiler results; fix and verify function extraction; retain function-address identity, compiler invocation/version, return code and diagnostics; then recompute a real baseline before using it as a measured OPEG metric. An unavailable compiler means **not measured**, not a confident boolean or zero. Do not seed "verified" memories from the corrupted ratio.

### RE-04 — P2 — Phase 6 configuration does not match the existing workflow and trigger capabilities

The proposed workflow uses `start`, `agent_run`, and `end`. The actual `nodeKind()` classifier returns `unknown` for all three; `memory_recall` is a supported positive control. It reads `node.data.query`, uses the Memory Bridge, and does not implement the proposed `config.category = binary_dossier` agent-memory query. The example also lacks the real saved-workflow edge/data contract.

The trigger engine currently supports an exact topic mapped to a saved workflow ID. It has no configured verdict predicate, direct reflection callback, or direct publish-alert action. It supplies a truncated text prompt, not a structured `{{dossierPath}}` binding. Adding a definition object alone does not ensure a saved workflow row exists for `fireTrigger()` to load. The gate's bus-history URL is also incorrect: the actual route is `/api/fleet/bus/history/:topic`, not `/api/bus/history?topic=...`.

**Required resolution:** specify supported nodes or the executor changes needed for new ones, real canvas nodes/edges, workflow installation, typed receipt-to-dossier inputs, conditional verdict handling, and correct routes. Include a real saved-workflow fixture and assertions that CONFIRMED does not trigger a CHALLENGED alert. The changes may exceed the current eleven-file estimate.

### RE-05 — P2 — The Phase 5 file list omits a module required by its own habituation gate

Phase 5 proposes edits to sensory bridge, attention gate, and working memory, but its gate requires habituation of `binary_insight`. The real habituation module iterates a fixed eight-channel `SENSORY_KEYS` list. Passing `binary_insight` into it yields **no novelty factor for that channel**; the sensory bridge then defaults the missing factor to 1. This is reproduced without importing the live app.

Predictive processing and active inference also have fixed channel sets/maps. Their expected RE coverage should be stated explicitly rather than inferred from the new sensory coordinate. The proposed three-part amplitude also needs an idle test: a stale latest compile rate must not imply fresh RE activity indefinitely.

**Required resolution:** include habituation in the modification plan and test sustained input, a new-dossier spike, idle/stale data, and zero/unknown measurements. If prediction/action coverage is intended, include and verify those mappings too. Recount the file estimate after deciding that scope.

### RE-06 — P2 — The gates are not strictly ordered by their actual dependencies

Phase 2 must verify dossier ingestion, storage, and querying, while Phase 3 introduces the core parser/grader/store that should implement those operations. Thin Phase 2 tool wrappers cannot pass those functional gates until Phase 3 exists; duplicating an ad-hoc parser in Phase 2 would undermine the intended shared engine.

**Required resolution:** move the shared dossier foundation earlier, combine the relevant foundation gates, or split Phase 2 registration checks from its post-Phase-3 behavior checks. Record dependencies per gate and do not pass a wrapper/stub as a working dossier processor. The progress tracker currently follows the declared phase order and records this unresolved dependency.

### RE-07 — P2 — Phase 7 is an outbound-ledger stage, not an established bidirectional loop

The spec explicitly excludes iMac-side ingestion and leaves return transport manual, while the surrounding claim says the capstone closes the bidirectional loop. Those are different completion boundaries.

The proposed round-trip through `hive-receipts.py ingest-phone` is not a generic receipt import. The actual adapter expects a phone proof bundle with `app`, `packets`, and related fields. Feeding a single Chandra reflection receipt produces a **phone-headroom proof_bundle with zero packets**, losing the reflection claim. A JSONL file is not its JSON bundle format either. A chain can remain valid while this adapter destroys the intended semantics. Phase 7's example also omits the `i` field used by upstream receipt consumers such as `tail`.

**Required resolution:** define a true receipt-compatible import/merge contract and raw-format export fixtures. Separate "Chandra outbound ledger produced and locally verified" from "transferred to iMac and accepted by its planner." A final acceptance record must show both transport and preserved organ/type/claim/evidence semantics; a hash-only or phone-shaped round-trip does not establish that.

### RE-08 — P2 — Source pins, gate counts, and seal verification need evidence reconciliation

All seven SHA prefixes in the spec's tool table differ from the corresponding prefixes in the pinned upstream `MANIFEST.md`. For example, Ghidra is written as `6e8c79...`, while the manifest records `3d0373cc057f0a52`. These should be identified as placeholders or replaced with authentic provenance; neither short prefix independently verifies archive bytes.

The referenced upstream `docs/BUILD-GATES.md` has **18 numbered entries**, not the claimed 19. Find and cite the nineteenth receipt before pre-populating 19 verified lessons. Documentation of a historical build fix also needs its original evidence/provenance; confidence 1.0 should not silently imply that the fix was reproduced on this Windows machine.

The stored dossier seal does not reproduce from the committed non-seal files using the candidate sorted `sha256sum` manifest. The pipeline seals every file present in the directory, including a generated `ghidra.log` that is absent from the committed subset, and it can include an old `dossier.seal` on reruns. Ordering, filenames, inclusion rules and exact bytes need a retained manifest. **This mismatch is not a finding of tampering.** The available subset is not enough to establish the original seal.

**Required resolution:** correct source inventory references, retain a complete canonical per-file seal manifest excluding the seal itself, define rerun behavior, and distinguish valid/invalid/unverifiable dossier states. Add a missing-file case to the seal gate rather than testing only byte tampering.

## Phase 1 implementation admission criteria

The next implementation slice should start by resolving RE-01 and adding fixtures, not by trusting the existing projected file as a chained ledger. Before claiming Gate 1 complete, require:

1. A raw receipt sample and the projected ledger are recognized as different formats; canonical hashes interoperate with the actual Python producer.
2. A damaged/unverifiable input does not publish trusted downstream events or advance a trusted watermark. Verify behavior, not just a status label.
3. Repeated imports and crash/restart tests preserve stable receipt identity. Define durable delivery and idempotent consumers; a row index alone does not identify a rotated or replaced source ledger.
4. Source reads and HTTP parameters are bounded; a partial trailing line from an in-progress transfer is handled deliberately. Imported dossier paths remain data until validated against the intended local dossier root.
5. The correct bus topics/routes are exercised using temporary DBs and actual subscribers, with no production hive replay during review.

These complement the author's six Gate 1 criteria. They are requirements to make the bridge concrete and testable, not implementation claims.

## Progress and reproducibility

The durable [phase tracker](../RE-AGENT-PROGRESS.md) lists each phase, dependencies, gate counts and blockers. The JSON evidence records all 41 criterion texts and their independent status. New files or matching source strings are tracked as implementation presence only; they never automatically pass a behavior gate.

```powershell
node scripts/check-re-agent-progress.mjs --ref 1eabcde --output docs/reviews/2026-11-05-re-integration-progress.json
python docs/reviews/2026-11-05-re-upstream-probe.py --upstream PATH_TO_PINNED_UPSTREAM --output docs/reviews/2026-11-05-re-upstream-evidence.json
```

The Python probe requires the exact reviewed Git blobs; fetch those files at the pinned upstream commit or use the matching source snapshot. Do not expect it to accept a later fixed upstream revision as the old defect reproduction. No archive is installed by either probe.

After each implementation commit, run the source inventory against that commit, add actual independent gate-test evidence, and update the tracker. Record the implementer and reviewer sessions separately. The current source window has **eight local diagnostic checks and fourteen pinned-upstream diagnostic checks**; these are contract evidence, not 22 completed integration gates. Publication tag: `review/re-agent-integration-spec-2026-11-05`.
