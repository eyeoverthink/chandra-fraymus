# Independent review: FRAYMUS mathematical lineage engine

Reviewed source: `ed6f9992feef82a67c7a62b2e32297e3298b6c25` (`ed6f999`). Reviewer: Codex, in the independent-review role requested by Vaughn. Date: November 5, 2026, America/Los_Angeles (evidence timestamps use UTC).

**Verdict: IMPLEMENTED; CHANGES REQUESTED.** The six-file implementation and all 31 built-in examples are real. They establish a small classical numerical library with chart logging and prompt summaries. They do not establish general mathematical correctness, agent mastery, hardware execution, physical quantum computation, or a recovered learned state.

## Reproduction and scope

Run from the repository root:

```powershell
node docs/reviews/2026-11-05-lineage-independent-probe.mjs --output docs/reviews/2026-11-05-lineage-independent-evidence.json
```

The [probe](2026-11-05-lineage-independent-probe.mjs) reads exact source using `git show` at the reviewed commit, records source SHA-256 hashes, and evaluates it in isolated VM contexts. The [evidence](2026-11-05-lineage-independent-evidence.json) records **31/31 author examples, six syntax checks, and 21 diagnostic assertions**. Diagnostic assertions deliberately reproduce defects as well as positive controls; their passing does not mean feature acceptance.

Tests use actual `better-sqlite3` in-memory databases, the actual bus implementation, the actual fleet `executeTool` dispatch and prompt builder, and all seven route patterns on an ephemeral loopback Express server. Other prompt providers, result sealing, and unrelated permission services are stubbed; dispatch tests omit an agent permission context. No live application imports, database operations, daemon starts, restarts, models, hardware executors, or compiler invocations occur. Daemon/startup wiring is source-inspected, not live-validated. This review adds evidence and documentation only.

## Findings and closure criteria

### LCH-01 — P1: fleet argument wrapping disables four advertised modes

`server/fleet/tools.js:2118` declares `execute: async (params)` and reads `params.mode`. The actual executor at `server/fleet/runtime.js:311` calls `tool.execute({ args }, ctx)`. Thus `lineage_chart` receives `{ args: { mode: 'evaluate', ... } }` and selects its default `status` branch. The actual dispatch probe requests all five modes: each returns stats and records `lineage.status`; `read` does not add a reading, and `evaluate` returns no formula result. A direct bare-parameter call works, explaining how a narrower self-test could miss this.

Closure: follow the fleet executor's `{ args }` contract; exercise status/read/tiers/verify/evaluate through actual dispatch. Assert the distinct result shapes, one additional saved reading for `read`, requested tier verification, and numerical evaluation. Do not close this with direct tool-object calls alone.

### LCH-02 — P2: calculus formulas have no public JSON representation

`server/intelligence/lineage.js:167` and `:171` require JavaScript callback functions for `derivative(f, ...)` and `integrate(f, ...)`. The REST endpoint (`server/intelligence/lineage-routes.js:66`) and fleet schema accept JSON argument arrays. JSON cannot carry those callbacks. Requests with a formula string such as `"2*x"` return HTTP 400 (`f is not a function`), while the direct JavaScript callback control integrates to 9. The built-in calculus tests use callbacks and therefore do not test the advertised public interface.

Closure: define a bounded JSON function representation, such as polynomial coefficients or an allowlisted function identifier, and adapt it explicitly. Test derivatives and integrals through REST and fleet dispatch. Do not execute caller-provided source with `eval` or `Function`.

### LCH-03 — P2: evaluator accepts inherited methods and invalid numeric domains

`server/intelligence/lineage.js:524` looks up `tier.formulas[formulaName]` without checking ownership; `constructor` is accepted and evaluates `Object(123)` as though it were an algebra formula. This is an allowlist failure; the probe does **not** demonstrate arbitrary code execution.

Formula arguments also lack type/domain/finite-result validation. Through the actual API, `add('1', 1)` succeeds with `"11"`; quadratic coefficients `[0,1,1]` return HTTP 200 with `real: true` and both roots serialized as `null`; zero orbital radii return HTTP 200 with null velocity values. `hamming(0, 2**40)` silently truncates to zero under JavaScript's 32-bit bitwise conversion. Its comment specifies 32-bit operands, but the public contract does not reject wider values.

Closure: restrict to own formula properties; supply per-formula schemas for finite scalars, dimensions, integer widths, and mathematical domains. Handle degeneracies explicitly and return structured errors rather than successful null/concatenated results. Preserve legitimate non-real quadratic results as a documented case. Test the same invalid inputs through both public interfaces.

### LCH-04 — P2: valid quadratic inputs suffer catastrophic cancellation

The direct expression at `server/intelligence/lineage.js:78` returns roots `0` and `-10000000000000000` for `(a,b,c)=(1,1e16,1)`. The smaller root should be approximately `-1e-16`; the returned product is zero although Vieta requires `c/a = 1`. Inputs and the relevant results are finite, and `a` is nonzero: this is a numerical correctness defect within the advertised domain, separate from missing input validation. The single friendly quadratic example does not cover it.

Closure: use a cancellation-resistant computation, for example `q = -0.5 * (b + sign(b)*sqrt(discriminant))` with explicit zero/degenerate handling, roots `q/a` and `c/q`, and scaling where needed. Verify residuals and sum/product invariants with scale-aware tolerances across mixed signs, large magnitudes, repeated roots, and near-zero coefficients.

### LCH-05 — P2: failed chart persistence still announces success

`server/intelligence/lineage.js:448` catches and discards insertion errors, then publishes the ordinary chart-read event and returns age 17 / 31 passed. An in-memory trigger that rejects only lineage inserts leaves **zero** readings and an empty lineage prompt, yet the actual bus contains one ordinary chart-read event and the returned object has no error. A restart cannot restore a reading that was never saved. This does not prove historical data loss; it reproduces missing failure reporting and inconsistent chart state.

Closure: report persistence status and a logged error, and distinguish a completed verification from a durably saved chart. Publish a normal saved-chart event only after successful storage, or explicitly mark a failed/non-durable event. Test rejection, subsequent retry, and restored prompt/state. Table initialization and bus errors are also silently swallowed and should be observable.

### LCH-06 — P2: a failed foundational tier remains labeled mastered

`server/intelligence/lineage.js:435` initializes `currentAge = 0`. If Arithmetic fails, the loop breaks without changing that value. `buildLineageContext()` (`:559`) includes every tier with `age <= currentAge`, so it still states `Mastered: Peano axioms, basic operations`. A VM-only fault injected into `add` makes Arithmetic pass only 2/4 checks; the persisted age remains zero and the prompt nevertheless labels Arithmetic mastered.

Closure: represent no verified tier distinctly from successful age zero; derive the displayed domains from passed prerequisites. Assert that failure of the first tier yields no mastered domain, failure of any later tier retains only preceding successful tiers, and recovery updates the prompt correctly.

## Claim-by-claim assessment

| Claim | Independent result |
| --- | --- |
| Six files, 620-line engine, six age tiers, 31 passing self-tests | Confirmed at the reviewed commit; all six changed files parse. |
| Quadratic 2/3, 3-4-5 triangle, Euler's identity | Confirmed as floating-point numerical examples. Euler's imaginary component is approximately `1.22e-16`, as expected from numerical trigonometry. General correctness is not established. |
| Vis-viva gives 7672.6 m/s | Confirmed: `7672.598648385014` for the supplied circular radius `6.771e6` m and default Earth parameter. It is a calculation from fixed inputs; there is no live ISS measurement/data feed in this module. |
| Hadamard produces equal superposition | The classical calculation returns two amplitudes `0.7071067811865475` with squared norm approximately one. This is a numerical representation of the basis-state operation, not execution on quantum hardware. |
| Hardware primitives / 32 ZMM registers | Metadata constants and ordinary JavaScript operations are present. Capacity arithmetic `16384 = 256*64 = 32*512` is consistent, but there is no host capability detection or SIMD/register execution here. Intel documents the 32-by-512-bit register layout specifically for AVX-512; it is not a universal property of the current host. [Intel AVX-512 documentation](https://www.intel.com/content/www/us/en/developer/articles/technical/intel-avx-512-instructions.html). |
| Real MOSFET physics | A simplified square-law calculation exists with configurable `Vth`, defaulting to `0.618`. The axiom text hardcodes that threshold; it is not a universal device constant. For comparison, TI documents a MOSFET threshold range of 1.1–1.8 V under stated conditions. Label the assumptions and units rather than treating this default as physical grounding. [TI application brief](https://www.ti.com/document-viewer/lit/html/SBAA753/GUID-D7D35C31-2F71-4BB6-8959-9B4A80000371). |
| Full SVD / general linear algebra | The routines are 2-by-2; `svd2x2` returns singular values, not the complete `U`, `Sigma`, `V` factorization. Hamming uses scalar 32-bit bitwise operations, not a 16,384-bit vector implementation. |
| Daemon boot chart read and status | Source wiring confirmed: `startDaemon()` calls `readChart('daemon-boot')` at `server/daemon/engine.js:594`; daemon status includes lineage stats. `server/app.js:402` autostarts the daemon unless `FRAYMUS_AUTONOMY_AUTOSTART=0`. No live daemon was started for this review. |
| Every agent prompt / every-session chart protocol | The fleet prompt builder appends a chart summary after a reading exists; the actual builder probe confirms it. A fresh chart database yields no block, and prompt construction performs no read/re-verification. The identity's `EVERY session` instruction is stronger than the daemon-start hook. This review does not establish injection into other agent runtimes. |
| Mathematical mastery / amnesia recovery | The age is computed from native library examples, independent of any model's answers. The prompt is a domain/status summary, not an injected curriculum or recovered agent memory. Successful SQLite logging persists test records; no model competence or previously learned state is assessed/restored. |
| Verification hash / timing | The hash is a 16-hex-character prefix of SHA-256 over serialized test outcomes. It does not attest source, external measurements, model knowledge, or host hardware. Millisecond timings are local observations, not a performance guarantee. |
| Committed and pushed | Remote `refs/heads/master` independently returned the full `ed6f999` hash during review. Git identity metadata is not independent session authorship evidence. |

## Next-agent handoff

Fix LCH-01 first, then make the numerical evaluator's public contract explicit (LCH-02 through LCH-04) and chart state reliable (LCH-05/LCH-06). Keep the 31 examples as useful smoke checks and add meaningful boundary/invariant/interface tests. Describe the injected status as **verified library checks**, not measured agent mastery.

This lineage review is separate from the seven-phase RE integration tracker. It does not close the earlier Phase 3 findings or independently accept later RE phases. Preserve existing review baselines and unrelated work. The review tag is `review/lineage-engine-2026-11-05`.

Fraynix - By Vaughn Scott
