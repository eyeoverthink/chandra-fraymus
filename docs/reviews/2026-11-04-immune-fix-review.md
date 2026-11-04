# Independent recheck of caca6bc and ongoing Ollama wiring

Fraynix - By Vaughn Scott

**Verdict: four of the six claimed fixes pass the focused independent checks; IMM-02 and IMM-05 remain open.** The IMM-07 integration, subsequently committed as `be2bdea`, now sanitizes buffered text at several provider boundaries, but its protection is incomplete. This review also reproduces credential exposure in tool arguments, malformed structured output, and incorrect end-of-stream framing.

**Implementation owner:** concurrent porting session. **Reviewer:** this Codex follow-up session. Product files and the live database were not modified. Review artifacts are pinned by tag [`review/fraynix-immune-fixes-2026-11-04`](https://github.com/eyeoverthink/chandra-fraymus/tree/review/fraynix-immune-fixes-2026-11-04).

## Provenance and scope

- `caca6bce6000fc32d4a010a152d06def91d0886c` is the local HEAD and was confirmed as `origin/master` by `git ls-remote`. The previous review commit `06afc25` is its parent. The reported push is confirmed.
- The four core modules were tested at their committed `caca6bc` versions. During the review the implementation agent added `ollama-sanitize.js` and edited the provider, commerce, creation, distribution, fleet, FRAYMUS tools, and routes. Those integration edits were still uncommitted at measurement; they are identified by the 12 source hashes in the [evidence](2026-11-04-immune-fix-evidence.json), not attributed to `caca6bc`. They subsequently landed as `be2bdea`; all 12 measured source files were checked against that commit and match after Git line-ending normalization, and their current bytes still match the captured hashes.
- All 12 source files were copied with a matching hash manifest to `F:\Codex-brain\evidence\chandra-immune-followup-2026-11-04-ef74e344`. The measured sources stayed stable during the probe. Later edits beyond `be2bdea` need another check against their own commit.
- No production app or fleet runtime was imported, no database was opened, and no network/model call or server restart was performed. The local provider module and the commerce/creation helpers were exercised with mocked fetch responses in an isolated Node process. Distribution and fleet wiring were inspected in source only because importing their runtimes has database side effects.

## Reproduction

```bash
node docs/reviews/2026-11-04-immune-fix-probe.mjs
```

The [follow-up probe](2026-11-04-immune-fix-probe.mjs) asserts the confirmed codec/math/metadata corrections and records the remaining failures. It is a diagnostic review probe, not a declaration that every acceptance condition passes. If the in-progress sanitizer file is absent, it explicitly skips that boundary section while retaining the core-module checks.

The previous probe was also rerun without replacing its historical evidence. Its exact full-marker reproduction now disappears, but that narrow check misses exposed credential suffixes. Its scalar-root residual calculation is also obsolete after the new complex-root API; the new probe checks the actual complex polynomial directly.

## Status of the original findings

| Finding | Independent verdict | Evidence / limit |
| --- | --- | --- |
| IMM-01, plaintext in sanitizer metadata | **Focused reproduction resolved** | The complete serialized sanitizer object no longer contains the synthetic credential. Reversible four-byte encoding still is not a secrecy guarantee; the file comment claiming unrecoverability remains inaccurate. |
| IMM-02, credentials across fragments | **OPEN, P1** | Prefix-only buffering removes the exact original marker but emits the credential body on subsequent fragments. Reproduced for all five prefixes and one-character fragments. |
| IMM-03, invalid EP3 roots/model claim | **Focused reproduction resolved** | Actual `{re, im}` roots satisfy the cubic with relative residuals at most 2.2e-16. The module now describes a cube-root anomaly score and drops the tautological degeneracy claim. This does not validate a physical EP3 sensor. |
| IMM-04, zero baseline/saturating quantizer | **Focused reproduction resolved** | Zero returns 0. Epsilon values 1e-10, 1e-8, 1e-6, 1e-4 and 1e-2 give 42, 85, 128, 170 and 212, followed by 255 at 1. No immediate saturation. |
| IMM-05, uncalibrated canaries | **PARTIAL, remains open, P2** | One `hello` no longer triggers. Four benign `hello` fragments at exactly the expected 50 ms interval trigger with confidence 0.777507. Warm-up and tanh are not benign-distribution calibration. |
| IMM-06, short-prefix exception | **Focused reproduction resolved** | `sanitizeStreamText('sk-')` no longer throws. The four-byte codec still passes 1,024 exhaustive per-coordinate checks. |
| IMM-07, actual provider integration | **In progress, partial** | Mocked main provider plus commerce/creation helpers remove credentials from buffered text. Other output fields and several direct Ollama paths remain uncovered. No live curl/model validation was performed by this review. |

## Remaining and newly reproduced failures

### IMM-02 [P1] Keep redacting until the credential ends

The new [`stream-canary.js`](../../server/fraymus/intelligence/stream-canary.js) buffers partial **prefixes**, but does not retain an "inside credential" state after a full prefix is recognized. For these valid successive fragments:

```text
"sk-"
"UNIT_TEST_ONLY_0123456789"
" after"
```

the output is:

```text
[REDACTED:4D(58,83,170,158)]UNIT_TEST_ONLY_0123456789 after
```

The complete private body remains visible while the redaction counter reports success. The same defect occurs for `ghp_`, `github_pat_`, `xai-`, and `xoxb-`, and when every character is a separate model fragment. Checking only that the original full marker is absent produces a false pass.

Maintain request-local prefix and credential-continuation states through a defined terminator/EOF. Assert that the private body and significant suffixes are absent from output, metadata, and persisted records across every split, not only that the prefix changed. Keep ordinary text after the terminator intact.

### IMM-10 [P1] Apply the output policy to tool-call arguments before persistence or dispatch

The in-progress [`server/agent/provider.js`](../../server/agent/provider.js) sanitizes `data.message.content` while copying `data.message.tool_calls` unchanged. The mocked provider returns an ordinary message plus:

```json
{"function":{"name":"synthetic_tool","arguments":{"token":"sk-UNIT_TEST_ONLY_0123456789"}}}
```

The content marker is removed, but the complete marker survives in the returned tool arguments. The fleet chat wrapper has the same source pattern; its message persistence serializes tool calls. A content-only test therefore does not verify the provider's complete output boundary.

Define and enforce the policy for nested argument strings before those values are saved or dispatched: reject the affected call, or sanitize only where the tool contract explicitly permits it. Do not silently turn credentials needed by a tool into invalid placeholders and execute anyway. Test the complete returned message/tool object, nested arrays/objects, stored histories, and tool dispatch with synthetic markers. The probe demonstrates exposure in the main provider result; it does not execute or claim an actual external exfiltration.

### IMM-09 [P2] Preserve structured output when redacting string values

[`transcoder4d.js`](../../server/fraymus/intelligence/transcoder4d.js) ends a match only at an ASCII space. The new [`sanitizeOllamaContent`](../../server/fraymus/intelligence/ollama-sanitize.js) applies that scan to entire model-generated text, including JSON used by existing callers.

```text
Input:  {"token":"sk-UNIT_TEST_ONLY_0123456789","ok":true}
Output: {"token":"[REDACTED:4D(58,83,170,83)]
```

The sanitizer consumes the closing quote and all later fields. `JSON.parse` fails with an unterminated string. This is not merely a changed credential value: the structured result is destroyed.

For structured output, preserve syntax and non-secret fields while applying the policy to string values, or reject the result explicitly. For text/stream output, define delimiter rules covering quotes, whitespace, punctuation, escapes and EOF. Add fixtures that verify both marker removal and preservation of surrounding structure/content. The probe tests the shared helper directly; it does not claim a live workflow failure was observed.

### IMM-05 [P2] Warm-up delays the same false positive

With a deterministic 50 ms interval matching the code's timing expectation, the timing residual is exactly zero. Four normal `hello` fragments still give entropy residual 2.0780719 and confidence 0.777507, causing an alert. The new `minSamples=10` counts observations across all three channels, so four fragments produce 11 observations and already pass the gate.

The RMS drift still mixes milliseconds, bits, and a synthetic length score before comparison. `tanh(maxResidual / 2)` bounds a number but does not make it a calibrated probability. Retain this as advisory telemetry until normal-model fixtures, normalized features, and measured false-positive/false-negative rates justify an operational threshold. Require enough observations per relevant channel, rather than treating three measurements of one fragment as three independent samples.

### IMM-08 [P2] Flush buffered text in the correct field before completion

`interceptStream()` emits a held suffix as a new `{flushed: ...}` record after any `done:true` record. The benign chat fixture containing `books` returns `book` in `message.content`, then `done:true`, then `{flushed:"s"}`. A consumer of standard Ollama content fields loses the final character; a consumer stopping at completion cannot recover it.

Flush safe text into the appropriate `response` or `message.content` field before the completion record, preserving role/message metadata. Test benign suffixes that overlap every supported prefix, a terminal newline and no terminal newline, zero-content completion frames, and both generate/chat record shapes. The new buffered helper uses `flush=true` and avoids this particular failure; the exported streaming iterator remains incorrect.

## IMM-07 boundary wiring assessment

The current choice to keep `stream:false` and sanitize the collected content preserves the existing provider response contract. Independent mocked tests confirm the content is sanitized and actual usage `{inputTokens:3, outputTokens:5, costUsd:0}` is preserved. Commerce and creation helpers also return sanitized text under mocked fetch. Per-call prefix state is newly allocated rather than shared between requests.

This is **buffered text sanitization**, not live NDJSON stream interception. The helper constructs an interceptor after the whole response is available and calls `processToken` once with `flush=true`. Its timing canary consequently records zero timing samples, even after two sanitizations; it has not measured provider/token latency. Aggregate counters should not be presented as evidence of live stream monitoring.

Coverage also remains incomplete. Source inspection still finds private `chatOllama` implementations in [`strategy.js`](../../server/intelligence/strategy.js) and [`subconscious.js`](../../server/intelligence/subconscious.js) returning raw model content; the music path and Vertiso `/api/generate` rewrite path also directly consume model text outside the new helper. The claim in `ollama-sanitize.js` that every chat/provider return path is wired is therefore too broad. Enumerate supported paths and test or explicitly document exclusions before closing IMM-07.

All 12 inspected server files passed `node --check`. The implementation fix commit contains no new regression-test files; focused automated cases for the remaining contracts should accompany the fixes. Passing syntax and happy-path text redaction do not establish security coverage.

## Next owner action and independent recheck

Fix IMM-02 and the tool-argument policy first, then preserve JSON/EOF framing and calibrate advisory canary output. Finish the declared provider coverage without silently changing tool semantics, usage accounting, error handling, or cancellation. Reply here with exact fix commits and reproducible focused checks. Keep this verdict distinct from the original report and any later work-in-progress changes.
