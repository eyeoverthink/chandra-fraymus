# Immune layer round 3 - e17722e and 8e9ccd9

Fraynix - By Vaughn Scott

**Verdict: the previous regression fixtures improve substantially, but Phase 1 is not fully resolved.** All ten identified Ollama text-return paths now reference the sanitizer. The main provider's tool arguments, quoted JSON, credential continuation, and ordinary completion-frame fixture pass. The fleet's separate tool-call path still returns credentials unchanged. Canary calibration remains deferred, and the new recursive walker needs structural/bounds checks.

**Owner:** implementation session. **Reviewer:** this independent Codex session. Review tag: [`review/fraynix-immune-round3-2026-11-04`](https://github.com/eyeoverthink/chandra-fraymus/tree/review/fraynix-immune-round3-2026-11-04).

## Source and verification

- Reviewed HEAD: `8e9ccd927fb244c6207983cb017d477684ae922b`, preceded by `e17722e40b02ae4b465b0f7685d290011042e98a`. `git ls-remote` confirmed `origin/master` at that HEAD.
- [Evidence](2026-11-04-immune-round3-evidence.json) records 18 source hashes, all stable during the probe. Copies and a matching manifest are preserved in `F:\Codex-brain\evidence\chandra-immune-round3-2026-11-04-64d66571`.
- The prior probe was rerun without rewriting historical evidence. The new [round-three probe](2026-11-04-immune-round3-probe.mjs) retains its positive assertions and adds fleet, chunking, recursive-object, and completion-shape cases.
- The fleet reproduction executes the **complete current `chat` function declaration**, isolated between explicit source markers, with mocked fetch and injected config/sanitizer dependencies. It does not import the fleet runtime or its database. Persistence and dispatch paths were traced in source, not executed.
- No app/database import, network inference, real credential, external tool effect, server restart, or live database change was used. All 18 inspected server files pass `node --check`.

```bash
node docs/reviews/2026-11-04-immune-round3-probe.mjs
```

The probe asserts the previously failing positive fixtures and prints the newly observed gaps. An exit code of zero is not a blanket security verdict for every printed field. In particular, the implementation's own round-two evidence already records `triggered:true` at five through eight `hello` fragments; those observations were not failing assertions.

## What now passes

| Finding | Independent result at 8e9ccd9 |
| --- | --- |
| IMM-01: plaintext sanitizer metadata | Previous full-object marker reproduction remains fixed |
| IMM-02: credential continuation | All five prefix/body fixtures and character-by-character fixture hide the body and preserve the following ` after` |
| IMM-03 / IMM-04: EP3 math and quantizer | Complex polynomial checks, zero baseline and unsaturated range still pass |
| IMM-06: short prefix | No exception; 1,024 byte-codec checks still pass |
| IMM-07: ten text-return boundaries | All ten listed callers now reference `sanitizeOllamaContent`; buffered text coverage gap from the last review is addressed in source |
| IMM-08: original EOF fixture | `books` is restored in the final chat content frame before/with completion |
| IMM-09: original quoted JSON | Valid JSON survives, with the non-secret `ok:true` field intact |
| IMM-10: main provider arguments | Mocked `server/agent/provider.js` result no longer exposes the synthetic tool-argument credential; usage accounting is preserved |

These are focused results. They do not establish full field coverage, valid recursive object handling, or a calibrated detector.

## Findings still requiring action

### IMM-10 [P1] Fleet tool arguments still bypass the sanitizer

[`server/fleet/runtime.js:199-201`](../../server/fleet/runtime.js) returns sanitized `content` but copies `data.message.tool_calls` unchanged. `sanitizeDeep` was added only to the separate main provider.

The isolated actual fleet chat function receives the same synthetic credential in content and `function.arguments.token`. Its returned content is clean, while its returned tool arguments still contain `sk-UNIT_TEST_ONLY_0123456789` in full. The main-provider fixture is the passing control for the same policy.

Source then sends these tool calls through `addMsg` at line 388, where they are JSON-serialized into message history, and subsequently passes `fn.arguments` into `executeTool` at line 414. No real persistence or tool action was performed by the review. This is a source-traced exposure path, not a claim that an actual secret was exfiltrated.

Apply the agreed tool-argument policy to **both** provider implementations before persistence/dispatch. Use the same fixtures for the main and fleet paths, including nested values. Define whether an affected call is rejected or safely transformed under its tool contract rather than blindly executing altered authentication data.

### IMM-11 [P2] The recursive walker changes prototypes and has no depth bound

[`ollama-sanitize.js:51-59`](../../server/fraymus/intelligence/ollama-sanitize.js) builds an ordinary `{}` and assigns every incoming key through `out[k] = ...`. For parsed JSON containing an own `__proto__` key, that assignment invokes the setter and changes the **returned object's prototype** instead of preserving a data property.

The synthetic fixture is:

```json
{"__proto__":{"syntheticInherited":true},"ok":true}
```

After sanitization, `result.syntheticInherited === true`, the own `__proto__` key has disappeared, and serialization gives only `{"ok":true}`. The actual `assertSchema` helper rejects the original object's unknown key but accepts the sanitized object under the same fixed-property schema. Thus sanitization can erase a validation failure and introduce unvalidated inherited data.

The probe confirms that global `Object.prototype` is unchanged. It does **not** establish global prototype pollution, code execution, or privilege escalation. It does establish a data-structure/validation regression at a tool boundary.

A separate valid JSON fixture only 50,030 bytes long with 5,000 nested `child` objects parses successfully but makes `sanitizeDeep` throw `RangeError: Maximum call stack size exceeded`. That is a request-level processing failure, not a demonstrated server-process crash.

Reject dangerous keys or preserve them through a safe data-property construction strategy, and preserve validation semantics. Add bounded depth/node/size checks with an explicit controlled refusal; never return the unprocessed input when a bound is exceeded. Test that an unknown-key input cannot become schema-valid merely by passing through sanitization.

### IMM-05 [P2] Per-channel warm-up is fixed; calibration is still deferred

The new per-channel sample minimum addresses the observation-count issue. It does not calibrate entropy, phase, or units. Calling the repeated-`hello` stream unusual does not resolve this finding: an ordinary non-repeating sentence has the same problem.

Fixture: `The local model is ready to process your next request.` Timing is exactly the configured 50 ms baseline, so timing residual is zero throughout.

| Fragmentation of the same sentence | Fragments | Triggered | Reported confidence |
| --- | ---: | --- | ---: |
| Whole sentence | 1 | false | 0 |
| Normal word fragments | 10 | **true** | **0.719386** |
| Single characters | 54 | **true** | **0.964028** |

Every one-character fragment has Shannon entropy zero regardless of the sentence's meaning. Comparing that to a four-bit per-fragment baseline creates the same large residual for ordinary and anomalous text. A longer sample minimum does not remove this chunk-size bias. Use an appropriate analysis window, normalized features, and measured benign/fault distributions if this is to become a detector.

The buffered production helper has the opposite gating problem. Twenty `sanitizeOllamaContent` calls produce 20 entropy and 20 phase observations but **zero timing observations**, since each call constructs a fresh interceptor and feeds it one complete response. The new timing minimum therefore keeps its canary confidence at zero indefinitely on this helper path. Redaction alerts/counters remain separate and can still work; the canary itself is not monitoring token timing there.

Keep the detector explicitly advisory/uncalibrated, with this work recorded as deferred. Do not call IMM-05 fully resolved or interpret `tanh` output as an empirically calibrated probability. Sample collection should match the actual response/stream boundary being measured.

### IMM-08 [P2, completion edge case] Metadata-only completion drops held text

The original completion fixture now passes when the final record contains a `message`/`response` field. With these additional input records:

```json
{"message":{"role":"assistant","content":"books"},"done":false}
{"done":true}
```

the stream's standard content becomes `book`. The code clears `prefixBuffer` on completion before establishing a field in which to emit its final `s`. The equivalent generate-shaped case also loses it.

This is an explicit metadata-only completion fixture, not a claim that every live Ollama version emits that exact frame shape. Either preserve the held text using the remembered response shape before completion, or reject unsupported completion framing explicitly. Do not silently discard it. The currently wired production helpers still use buffered `stream:false`; this edge case concerns the exported NDJSON interceptor.

## Completion criteria before the Phase 1 claim

1. Close IMM-10 on both main and fleet providers, with shared contract tests covering returned objects and the persistence/dispatch boundary.
2. Make `sanitizeDeep` bounded and safe for JSON object keys; prove schema rejection cannot disappear through transformation.
3. Preserve or explicitly refuse the metadata-only completion fixture while retaining all now-passing JSON/continuation/EOF cases.
4. Record IMM-05 as deferred advisory work until calibrated, or implement and validate the missing feature collection/calibration. It should not be reported as completed merely because warm-up changed.

The ten text-path registrations and the prior regression fixes are real progress. Independent Phase 2 work can be planned from that verified state, but security-dependent ports should not rely on the blanket claim that the immune layer is fully resolved. Reply here with exact fix commits and focused test results for the remaining boundaries.
