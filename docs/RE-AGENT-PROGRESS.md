# RE Agent integration progress

Updated: 2026-11-05. Chandra baseline: `1eabcde54f389b0cb6a5d260c15c0b4b91bc60c9`. Spec commit: `837f679`. Upstream reviewed: `2f75cee7f54a4aa6bae219ec9241fc44f980c36b`.

**Specification exists and is pushed. Spec corrections for all 8 review findings (3 P1 blockers + 5 P2 issues) applied. Implementation: 0/7 phases. Independently passed phase criteria: 0/47 (expanded from 41 after RE-05/RE-07 additions).** The independent [specification review](reviews/2026-11-05-re-integration-spec-review.md) findings have been addressed in the spec. The spec's updated count is 8 new files, 14 existing modifications and 0 deletions.

| Phase | Declared dependency | Independent gates passed | Current status | Required next evidence |
| --- | --- | --- | --- | --- |
| 1 — Hive Bus Bridge | Raw receipt transport/format agreement | 0/10 | SPEC CORRECTED; ready to implement | RE-01 resolved: dual-format (raw + projection) ingestion, chain verification only on raw, projection marked unverifiable, crash safety, dedup, bounded reads. |
| 2 — RE manifest + tools | Phase 1; dossier tools need Phase 3 | 0/4 (Gate 2A) + 0/4 (Gate 2B) | SPEC CORRECTED; ready to implement | RE-02/03/06/08 resolved: correct manifest path (`agents/`), comma-separated tools, split compile-rate (measure vs predict), 18 gates at confidence 0.9, split gates 2A/2B for Phase 3 dependency. |
| 3 — Dossier engine | Phase 2A (standalone tools) | 0/6 | SPEC CORRECTED | Parse 136 real functions; tri-state seal (valid/invalid/unverifiable); graded storage; RE-08 seal manifest caveats. |
| 4 — Binary debate bridge | Phase 3 | 0/5 | NOT IMPLEMENTED | Execute the actual rounds, gate scaling, events and confidence policy. |
| 5 — CTRNN sensory channel | Declared Phases 1–4 | 0/10 | SPEC CORRECTED | RE-05 resolved: habituation, predictive-processing, active-inference all now included; idle/stale decay defined; all 4 SENSORY_KEYS arrays updated. |
| 6 — Autonomous wiring | Phases 1–5 | 0/6 | SPEC CORRECTED | RE-04 resolved: supported node types (`llm`, `memory_recall`, `debate_run`, `bus_publish`), saved workflow DB row, correct bus history route. |
| 7 — Cross-machine dream bridge (outbound only) | Shared raw-format contract and prior phases | 0/9 | SPEC CORRECTED | RE-07/08 resolved: outbound-only scope, `i` field included, hash interoperability fixtures, ingest-phone NOT the right adapter, separate completion boundaries. |

Five additional cross-phase scenarios remain untested: complete flow, tampering response, daemon/autonomy, restart persistence, and regression behavior. None has been inferred from a feature count or a document checkbox.

## Verified prerequisites and limits

| Asset or claim | Current evidence |
| --- | --- |
| Upstream repository and relevant sources | Authenticated read at the pinned commit; no full toolchain clone |
| Raw upstream hive chain | 13 receipts; actual upstream verifier reports INTACT |
| Windows landing file | 9 projected records; fields `ts,type,src,msg,seal`; no `prev/self` chain to verify |
| `/bin/ls` dossier structure | 136 function markers, 5,152 lines in committed decompiled C |
| Compile-rate claim | NOT VERIFIED: actual evaluator splits 136 functions into 181 misaligned fragments; first code field is an address |
| Tool archive pins | 7/7 spec prefixes now labeled as placeholders; must verify against upstream MANIFEST.md at `2f75cee7` |
| Historical build-gate lessons | Referenced document contains 18 numbered entries; spec corrected from 19 to 18; stored at confidence 0.9, not 1.0 |
| Dossier seal | NOT VERIFIED from committed subset; full original sealed file list/bytes required; no tampering attribution |
| Nightly scheduling and active iMac execution | NOT VERIFIED on the remote runtime; script exists and sends the projection |
| Bidirectional planner loop | NOT IMPLEMENTED by Chandra; planned Phase 7 only defines the outbound side and manual setup |

## How to record progress

Run `node scripts/check-re-agent-progress.mjs --ref COMMIT --output PATH` after an implementation commit. This produces a committed-source snapshot, all 41 original gate texts, source hashes, required-file/marker inventory, and local contract checks. Implementation presence is always labeled **not verified** until a reviewer exercises the gate.

For each independently tested gate, add a record here with gate ID (`RE-P1-G1`, etc.), implementation commit, implementer session, reviewer session, test command/fixture, observed result, evidence file, and any limitation. Preserve failed results and previous snapshots. A claimed pass without its evidence remains unverified. The author should not self-close independent review gates.

| Review event | Result | Evidence |
| --- | --- | --- |
| 2026-11-05 — initial spec review | 8 contract findings; no phase implementation | [Full review](reviews/2026-11-05-re-integration-spec-review.md) |
| 2026-11-05 — Chandra inventory | 0 implementation phases detected, 0/41 gates passed; 8 diagnostic assertions | [Snapshot JSON](reviews/2026-11-05-re-integration-progress.json) |
| 2026-11-05 — pinned upstream reproduction | 14 diagnostic assertions; raw-chain positive control and tamper control; projection, parser and phone-adapter mismatches reproduced | [Evidence JSON](reviews/2026-11-05-re-upstream-evidence.json), [probe](reviews/2026-11-05-re-upstream-probe.py) |

| 2026-11-05 — spec corrections | All 8 findings addressed: RE-01 dual-format, RE-02 manifest path, RE-03 compile-rate split, RE-04 workflow nodes, RE-05 habituation+prediction, RE-06 gate split, RE-07 outbound-only, RE-08 pins+gates+seal | Spec diff in implementation commit |

Next action: implement Phase 1 (hive-bridge.js) with dual-format ingestion and test against sample data. This does not initiate live receipt ingestion or modifications to the iMac toolchain. Tag: `review/re-agent-integration-spec-2026-11-05`.
