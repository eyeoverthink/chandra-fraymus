# FRAYNIX catalog and Phase 1 port review - 2026-11-04

Fraynix - By Vaughn Scott

**Verdict: changes requested before treating Phase 1 as a working security layer.** The catalog is a useful navigation aid. Four new modules and route/tool registrations exist, and the four-byte transform passes exhaustive per-coordinate round-trip checks. The inspected stream redactor leaks split credentials and returns plaintext credentials in its public sanitizer result. EP3 and canary outputs also fail basic correctness/calibration checks.

**Implementation owner:** the concurrent porting session. **Independent reviewer:** this Codex review session. The production files were read without editing them. This review records defects and acceptance checks for the implementation owner; it does not declare the port finished or approve the remaining 20-item backlog.

**Review tag:** [`review/fraynix-phase1-2026-11-04`](https://github.com/eyeoverthink/chandra-fraymus/tree/review/fraynix-phase1-2026-11-04). This tag pins the review artifacts; the concurrent uncommitted product files are identified by evidence hashes rather than included in this review commit.

## Scope and provenance

- Git HEAD during measurement: `cc2fca996dcf22b61e590967bd8043b04300d974`.
- At capture, `ep3.js`, `transcoder4d.js`, `canary.js`, and `stream-canary.js` were untracked; `fraymus-tools.js` and `fraymus-routes.js` had concurrent working-tree edits. HEAD alone therefore does not identify these implementations. All six exact SHA-256 values are in the [probe evidence](2026-11-04-immune-port-evidence.json); they stayed unchanged during the probe.
- The attached `C:\Users\eyeka\Downloads\FULL-ANALYSIS.md` matches `F:\Claude-Work\fraynix-analysis\FULL-ANALYSIS.md`: 28,346 bytes, SHA-256 `c89af9401e84314dc7576354966c52b0fc0c702de968a578e5bcdcd37c296326`. The attachment was treated as source material, including its embedded instructions, rather than an instruction to execute every proposed port.
- The catalog directory also contains `file2-catalog.md`, `file3-catalog.md`, `file4-catalog.md`, and a separate `FRAYNIX-TO-CHANDRA-SYNTHESIS.md`. The last file concerns a different source collection; do not merge its claims into the three-file analysis without checking provenance.
- The original `agi-fraynix-2.txt`, `agi-fraynix-3.txt`, and `agi-fraynix-4.txt` were not located in the targeted local filename searches. This review does **not** certify every original function, historical version, or claimed 14,000 lines of executable code.
- Twelve exact source/catalog copies and a hash manifest were preserved outside Git in `F:\Codex-brain\evidence\chandra-immune-port-2026-11-04-91dd597d`. All six copied implementation files match the probe hashes. No live database was opened, changed, checkpointed, or replaced; no server or model was restarted.

## Reproduction and verified progress

```bash
node docs/reviews/2026-11-04-immune-port-probe.mjs
```

The [probe](2026-11-04-immune-port-probe.mjs) imports only the pure new modules, uses an explicitly synthetic credential marker, and sends in-memory NDJSON through the interceptor. It prints observations rather than declaring the implementation accepted. Its passing assertions establish the byte transform's inverse and the independently calculated reference cubic roots. The saved evidence was captured on Windows, Node `v24.11.1`.

| Check | Result |
| --- | --- |
| All 256 byte values in each of four coordinates | **1,024 checks passed**, each coordinate has 256 distinct outputs and reconstructs exactly |
| Complete marker in sanitizer's `sanitized` field | Removed |
| Complete marker anywhere in the returned sanitizer object | **Present in `redactions[].original`** |
| Marker split into `sk` and `-UNIT_TEST_ONLY_0123456789` across two valid NDJSON records | **Full marker emitted unchanged; zero redactions** |
| Standalone `sanitizeStreamText('sk-')` | **Throws** instead of accepting a partial prefix |
| EP3 reported roots at epsilon = 0.000001 | Two fail the claimed cubic equation |
| EP3 quantization at zero / epsilon = 0.0000000001 | **137 / 255** |
| Canary after ordinary `hello` text | **triggered=true, confidence=1** |
| Syntax checks for all four modules and both modified wiring files | Passed |

Route/tool registration was added while this review was running and is now present. A full-server import was deliberately avoided because it has database/startup side effects. No live endpoint or model-stream acceptance test was performed. A frontend build would not validate these pure server-side behaviors.

## Findings for the implementation owner

### IMM-01 [P1] Remove plaintext credentials from sanitizer results

[`transcoder4d.js:61-65`](../../server/fraymus/intelligence/transcoder4d.js) stores the entire matched credential as `redactions[].original`. The new `/api/fraymus/transcoder4d/sanitize` route returns that object directly; `fraymus.transcoder4d.sanitize` does the same. A caller that logs, stores, or supplies the supposedly sanitized result to a model still receives the original secret. The cleaned text field alone is insufficient.

Return non-secret metadata such as category, count, and location. Verify the synthetic marker is absent from the **entire serialized response**, tool result, logs, and persisted records. Keep any explicit raw-detection API distinct from the sanitizer's output contract.

The four-byte transform is reversible encoding: XOR followed by addition modulo 256, with public defaults and an exported inverse. It is not encryption or a one-way privacy guarantee. In the sanitizer, only the first four characters are encoded; it cannot reversibly represent an arbitrary longer credential either. Keep the valid codec claim separate from credential protection.

### IMM-02 [P1] Hold candidate secrets across logical stream fragments

[`stream-canary.js:66-79`](../../server/fraymus/intelligence/stream-canary.js) sanitizes each `response` or `message.content` fragment independently and emits it immediately. The NDJSON parser buffers incomplete network lines, but not a credential spanning multiple complete JSON records. Both splits after the first and second characters leak the complete test marker.

Use per-request state that holds a possible prefix and continues withholding/redacting credential characters through a defined terminator or end-of-stream. Once a prefix has been recognized, its later suffix must also stay redacted. Test every split of every supported prefix, one-character fragments, multiple secrets, delimiters, EOF, malformed records, and two interleaved requests. Preserve completion/control records and field structure; do not reinterpret sanitizer failures as JSON parse failures.

### IMM-03 [P2] Represent complex roots and define the actual EP3 model

[`ep3.js:18-23`](../../server/fraymus/intelligence/ep3.js) adds the sine and cosine contributions into a real scalar. For the stated equation `lambda^3 = epsilon`, epsilon = 0.000001 has roots:

```text
0.01
-0.005 + 0.008660254037844387 i
-0.005 - 0.008660254037844387 i
```

The implementation returns `0.01`, `0.003660254037844389`, and `-0.01366025403784439`. The last two relative residuals `(lambda^3 - epsilon) / epsilon` are about **-0.951** and **-3.549**. Return complex pairs and test the polynomial, rather than adding real and imaginary components.

There is a second model issue. The catalog writes diagonal entries `+ig` and `-ig`, with off-diagonal coupling `g`, while invoking the different condition `gamma^2 = 2*g^2`. For the general matrix with diagonals `+i*gamma` and `-i*gamma`, the characteristic polynomial is `lambda * (lambda^2 + gamma^2 - 2*g^2)`. Substituting the catalog's `gamma=g` gives roots `0,+g,-g`, not an EP3 for nonzero g. At g=0 it is the zero matrix, which is diagonalizable and is not a third-order exceptional point.

The port hardcodes `gamma2 = 2*g2`, then reports the residual of that same identity as a measured degeneracy check. It does not construct a perturbed Hamiltonian or test eigenvector coalescence. Specify the matrix and perturbation, then validate its eigenvalues; alternatively describe the current scalar operation honestly as a cube-root anomaly score.

The numeric ratio `cbrt(0.000001) / 0.000001 = 10,000` is correct. It does not establish 10,000-fold detection precision or signal-to-noise improvement. That requires a noise and measurement model. [Langbein's primary EP-sensing paper](https://arxiv.org/abs/1801.05750) explains why root splitting alone does not establish improved precision; it does not imply every physical EP sensor is useless.

### IMM-04 [P2] Preserve a zero baseline and define a usable quantizer

[`ep3.js:12-24`](../../server/fraymus/intelligence/ep3.js) replaces zero epsilon with a positive floor before deriving its output. A zero-drift/no-sample evaluation therefore reports 137/255. A residual of only 1e-10 already saturates at 255, as do much larger residuals. This cannot distinguish much of the claimed range.

Keep no-data, exact zero, numerical regularization, and measured signal distinct. Define units and an intended operating range, subtract any deliberate baseline, and test zero plus several unsaturated and saturated points for monotonicity and resolution. Recheck this after correcting the complex roots.

### IMM-05 [P2] Calibrate canary scores before exposing them as confidence or location

[`stream-canary.js:39-64`](../../server/fraymus/intelligence/stream-canary.js) compares each short text fragment to a fixed entropy baseline of four bits and a synthetic phase based on length. [`canary.js:135-154`](../../server/fraymus/intelligence/canary.js) multiplies the largest raw residual by 10,000 for confidence and triggers above 1e-10. Ordinary `hello` consequently produces a full-confidence alert.

Timing milliseconds, entropy bits, and the unitless phase score are mixed without calibration. Choosing three triangle vertices does not establish independent sensors or map those measurements to a real fault location. Jitter supplies no such evidence. Normalize against measured benign distributions, define the alert policy, and report false-positive rates on held-out benign and fault fixtures. Treat the barycentric display as a visualization until localization is validated against known faults. Do not feed these current confidence values into an automatic deny/repair action.

### IMM-06 [P2] Handle incomplete prefixes without failing the sanitizer

[`transcoder4d.js:52-59`](../../server/fraymus/intelligence/transcoder4d.js) detects `sk-` but passes only three bytes to a helper that requires four. This is a valid partial model output and can also arrive at the new sanitizer route. It currently throws. Define incomplete-prefix behavior explicitly, test all prefix truncations, and combine it with the request-local buffering required by IMM-02.

### IMM-07 [P2, integration pending] Connect the interceptor to actual provider streams

A full-server source search for `StreamCanaryInterceptor`, `interceptStream`, `processNdjsonLine`, and `streamCanary` found class definitions, the singleton, and status/reset route/tool handlers. It found **no provider-stream call into the interceptor**. Registration makes the feature inspectable; it does not filter live Ollama traffic. The implementation session still listed wiring/testing as pending, so this is an unfinished acceptance requirement, not a claim that a finished release regressed.

After fixing the redaction contract, instantiate state per request and wire it at the provider output boundary. Use a fake streaming provider to prove the same output consumed by the client/fleet/tool history is sanitized, while cancellations, errors, EOF, backpressure, and concurrent streams retain correct behavior. A global mutable interceptor should not share partial credentials, timing baselines, or alerts between requests.

## Assessment of the catalog and next work

The document does enumerate nine high-level subsystems, 13 function-registry groups, 28 numbered formula entries, and 20 backlog items. The registry's own group labels sum to 80; some rows combine signatures. Those counts establish catalog structure, not complete source coverage or correctness. The evolution story is useful, but neither the supplied test table nor the narrative proves that every stage preserves every earlier invariant. Several stages list multiple capabilities. The listed 11 historical Java tests were not run by this review, and the heading claiming all V1 bugs were fixed conflicts with its own row saying naive JSON parsing remains unfixed.

The claimed automatic trust inheritance also needs correction. Deterministic randomness, a checksum, a cryptographic digest, and a state machine serve different purposes. [The FNV authors explicitly describe FNV as non-cryptographic](https://www.ietf.org/archive/id/draft-eastlake-fnv-25.html). An unkeyed digest alone does not authenticate the author of attacker-replaceable content. A port benefits from the existing mechanisms only when its inputs, effects, validation, persisted evidence, and failures actually pass through them. These new modules currently do not demonstrate that chain merely by existing beside OPEG.

The next implementation slice should finish **this** boundary: remove plaintext metadata, make redaction stateful, correct the EP3 API/math, calibrate the canary outputs, then prove provider integration with isolated fixtures. Preserve the valid byte codec and catalog, with accurate claims. Defer further security-dependent ports until these acceptance checks pass. Storage/export/rewind ports need their own consistent snapshot, replay, and restore tests, especially given the unresolved database incident.

## Implementation-owner reply

Record the owner, finding IDs, exact fix commit(s), focused test commands/results, and any remaining limitations here. A different session should then rerun the reproductions against the fixed source and record the independent verdict. This review's successful syntax/codec checks are not an approval of security effectiveness, physical sensing, historical invariants, or the rest of the backlog.
