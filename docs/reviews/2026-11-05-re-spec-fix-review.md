# RE integration spec correction recheck — 5e23e01

Date: 2026-11-05. Role: independent Codex reviewer, as explicitly requested by Vaughn. No Phase 1 implementation was started.

**Verdict: corrections confirmed in part; "all eight resolved" is not independently supported.** Commit `5e23e01769a393645270633b80e70ff3b225f724` is pushed and changes the spec and progress document only. The revised inventory is **8 new files / 14 existing modifications / 0 planned deletions**. There are **56 phase criteria**, not the claimed 47. Implementation remains **0/7 phases**, and independently passed integration criteria remain **0/56**.

## What improved

- The manifest is now at the supported top-level path and its example parses into **exactly ten distinct allowed tools**, including the two compile-rate tools. The existing Tycho manifest is preserved.
- Compiler measurements and LLM predictions are explicitly separated; missing clang returns null measurements, and the corrupted upstream 45/181 baseline is no longer treated as a measured per-function result.
- The Phase 5 plan now includes habituation, predictive processing, and active inference, with stale-data handling and expanded channel gates.
- Gate 2 is split into 2A and 2B, with dossier-dependent verification deferred until Phase 3.
- Phase 7 is labeled outbound-only, includes `i`, and no longer treats the phone-bundle adapter as a generic receipt import.
- Placeholder pins, eighteen historical build-gate entries, documented-versus-reproduced confidence, and tri-state seal terminology are acknowledged.

Those are specification corrections, not implemented or tested runtime capabilities. The unresolved details below matter before declaring the bridge contract ready.

## Remaining findings

### REF-01 — P1 — Hashing instructions still contradict the actual producer

RE-01's format distinction is substantially improved, but Phase 1 still prescribes:

```text
JSON.stringify(payloadWithoutSelf, sortedKeys)
Python-compatible canonicalization (sorted keys, no extra spacing)
```

The same document correctly says the producer uses Python `json.dumps(..., sort_keys=True)` with **default spacing**. Those formulas do not produce identical bytes. A JavaScript array replacer also filters keys recursively; a list of top-level receipt keys silently removes nested `evidence` fields.

The recheck uses the previously pinned upstream fixture, without changing its claim or timestamp. Python's canonical bytes reproduce the recorded `self`. Compact sorted JavaScript JSON does not. The literal sorted-key replacer produces an empty evidence object instead of the fixture's two evidence fields. The SHA-256 values and exact strings are in [the evidence](2026-11-05-re-spec-fix-evidence.json).

**Closure:** remove the incompatible formulas. Define one normative recursive serialization contract matching the actual producer, including default separators, ASCII escaping, nested keys, numbers and UTF-8 byte encoding. Pin known Python-produced bytes and hashes. Require import and export to use that same contract and reject unsupported values rather than silently normalizing them differently.

### REF-02 — P1 — A false verification flag does not enforce the trust boundary or delivery guarantees

The revised spec sends both raw and projected dossier events to **`hive.fra-pipeline:dossier`**, while requiring projection events not to launch trusted downstream actions. The existing exact-topic trigger engine does not inspect `chainVerified`.

The probe uses the actual bus and trigger code with an in-memory database and a counter-only workflow executor. Publishing `{ chainVerified: false, sourceFormat: 'projection' }` on the specified topic invokes the saved workflow **once** and increments its firing count. The false flag is even present in the workflow prompt; it is not an enforcement mechanism.

The updated "watermark after successful publish" rule also does not establish the promised crash safety. Existing `publish()` writes the event and invokes subscribers synchronously. In a transaction that publishes and then rolls back before a watermark write, the row disappears but the subscriber has already run. Retrying gives **one durable event and two subscriber invocations** in the probe. An implementation that merely adds a transaction would still need to address the notification boundary.

**Closure:** choose an enforceable boundary—such as a separate unverified topic namespace that trusted triggers never subscribe to, or deterministic trust admission before trigger dispatch. Define delivery as durable receipt/event persistence plus explicit replay/idempotency semantics. If subscriber side effects must be exactly-once, specify the durable outbox/deferred-notification and consumer-dedup design needed to support that claim. Add the missing helper/consumer changes to the inventory. Do not rely on an LLM reading a false flag in a text prompt to enforce trust.

This is a contract reproduction against current shared helpers, not a claim that a nonexistent Phase 1 module already contains these defects.

### REF-03 — P2 — The revised workflow still contains an unsupported operation and no actual dossier/reflection execution path

The actual classifier recognizes the revised `llm`, `memory_recall`, and `debate_run` types, but returns **`unknown` for `bus_publish`**. Replacing three unsupported names with another unsupported name does not close RE-04.

The proposed one-node `llm` workflow that "calls the reflect endpoint" also cannot do so under the current executor. Its branch sends text to Ollama and stores returned text. It does not execute tools, read dossier files, call the dossier engine, or call reflection. Labeling that node "Parse Dossier" and putting an instruction in its prompt does not perform the Phase 3 parser/grader/store operation.

Further, the current executor chooses `upstreamText || opts.prompt || node.data.prompt`; a bus trigger supplies `opts.prompt`. It has no general `{{input}}`/`{{recall.output}}`/`{{debate.output}}` interpolation. `memory_recall` queries the Memory Bridge, not the `agent_memories` category store the dossier plan uses. The trigger still passes at most 500 characters of payload text. A real saved workflow record and edges are now planned, which fixes one part of the earlier issue, but not these execution contracts.

**Closure:** name the real parser/tool/action adapters and required executor changes, or specify direct deterministic subscriptions for these operations. Use supported node data contracts; define how the validated dossier reference reaches the parser, how agent memories are retrieved, and how verdict predicates publish alerts. Verify those actions with spies/receipts, not generated text that says they happened.

### REF-04 — P2 — Unknown measurement and seal states are not propagated consistently through storage

Phase 2's updated tool contract returns `rate: null` when clang is unavailable and introduces `sealStatus: valid|invalid|unverifiable`. Phase 3 still declares `compileStatus: boolean` per function, `sealValid` in aggregate storage, and aggregate confidence 1.0 for the summary. The storage and bus-event contract does not explain how it preserves unavailable compiler results, incomplete seal evidence, or model-only predictions.

The core measurement/prediction distinction and tri-state terminology are improved; their downstream representation still needs to be reconciled.

**Closure:** make compiler status explicitly measured-pass/measured-fail/not-measured, with measurement provenance. Carry the tri-state seal status and missing-evidence reason through parser, graded facts, memories, summaries, events and API responses. Assign evidence grades per fact instead of allowing an aggregate confidence value to imply that unknown fields were verified. Require a no-compiler and missing-manifest storage round-trip test.

### REF-05 — P2 — Progress totals and one API gate still use incorrect contracts

Actual checklists at `5e23e01` contain:

| Section | Criteria |
| --- | ---: |
| 1 | 10 |
| 2A | 6 |
| 2B | 4 |
| 3 | 6 |
| 4 | 5 |
| 5 | 10 |
| 6 | 6 |
| 7 | 9 |
| **Total** | **56** |

The author's tracker says 47 and lists Gate 2A as four criteria. The five cross-phase scenarios are additional to this total. I corrected the tracker counts and updated the checker to derive counts from the actual sections, preserve 2A/2B identifiers, and accept either the original or revised file estimate. The old checker had baseline-specific assertions and would not run successfully against the expanded spec; that review tooling issue is fixed in this review.

The manifest verification gate still points at `/api/agents`, which queries the general `agents` table. Manifest-backed fleet tools are exposed through **`/api/fleet/agents`** and `/api/fleet/agents/:id`. Use those endpoints to assert the exact allowlist. The comma-separated manifest itself independently passes the ten-tool parser check.

## Original finding disposition

| Original finding | Independent result at 5e23e01 |
| --- | --- |
| RE-01 — receipt format/hash contract | Partial. Dual formats and transport distinction corrected; REF-01/02 remain. |
| RE-02 — manifest path and allowlist | Core contract verified: top-level path and ten-tool list. Gate URL still needs REF-05 correction. |
| RE-03 — measured versus predicted compilation | Core distinction and unavailable-compiler response corrected. Downstream storage needs REF-04. Upstream parser is not fixed by a Chandra spec change. |
| RE-04 — workflows/triggers | Still open; REF-03. Corrected history URL and saved-row installation note are acknowledged. |
| RE-05 — channel coverage | Spec correction verified: missing modules and stale-data gates added. No runtime channel integration exists yet. |
| RE-06 — ordering | Spec gate split verified: 2A is standalone, 2B waits for Phase 3. Dependent tools must not masquerade as working before then. |
| RE-07 — return path | Outbound-only scope and adapter correction verified. Hash interoperability still depends on REF-01. |
| RE-08 — provenance/seals | Placeholders, eighteen entries, and documented-confidence correction verified. Storage propagation remains REF-04; archive bytes and complete original seal manifest remain unverified. |

## Reproduction and progress

- [Fourteen isolated contract assertions](2026-11-05-re-spec-fix-evidence.json), including positive controls and remaining-problem reproductions: `node docs/reviews/2026-11-05-re-spec-fix-probe.mjs`.
- [Updated 56-criterion source snapshot](2026-11-05-re-spec-fix-progress.json): `node scripts/check-re-agent-progress.mjs --ref 5e23e01`.
- The generic inventory checker was also run against `1eabcde`; it still produces the original 41 criteria and eleven-file modification estimate. The original evidence remains unchanged.

These are documentation and contract checks, not 22 passed product acceptance gates. Source hashes are retained. No production DB, model, remote runtime or trusted workflow was used; the workflow mock only counts calls. No RE implementation is present at the reviewed commit. Remain at **0/7 phases implemented and 0/56 criteria verified**, with Phase 1 contract changes requested. Publication tag: `review/re-agent-spec-round2-2026-11-05`.
