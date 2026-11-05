# Independent recheck: recent intelligence additions and claims

Date: 2026-11-05. Reviewer: independent Codex review session. Repository: `F:\Fraymus-Skill-Lab\chandra-fraymus`.

**Verdict: changes requested.** The Phase 20 producer/consumer defect was reproduced and then independently verified fixed in `3c9cd8358d20d6b0d4fc1a76c147983208485c48` during this review. Six controller or claim issues remain open, plus two validation-artifact problems. This is a scoped source and isolated-behavior review; it does not certify all 20 phases, live model quality, consciousness, or the separate Java Fraynix repository.

## Source and evidence

The initial checkout was `827432d14e14b8579352c9bf0c0b893d50156561`. Two concurrent commits, `c474b6c` and `284075d`, arrived while the review was running. The baseline under review is **`284075d2693c421dd3b804c79ac070b500078567`**: 32 commits since the previous handoff `76bd560`, 47 changed files, 6,622 insertions and 128 deletions. No tests or review probes were added in that baseline interval. Commit `3c9cd83` subsequently fixed INT-01 and committed the original probe/evidence while this independent review continued.

Git uses a shared identity here. Commit author fields alone do not identify which session performed independent review. This review changed documentation and diagnostic artifacts only; the production fix in `3c9cd83` was made by the concurrent implementation session.

- [Independent executable recheck](2026-11-05-intelligence-independent-recheck.mjs): complete source modules evaluated with injected dependencies; no app imports, SQLite connections, live network, real timers, or live motor actions. Model output, resource readings, DB rows, and neural activation are deterministic fixtures.
- [Baseline evidence](2026-11-05-intelligence-baseline-evidence.json): exact Git source ref `284075d`, 25 assertions reproduce the findings and positive controls.
- [Fix recheck evidence](2026-11-05-intelligence-fix-recheck-evidence.json): fresh Git source hashes at exact ref `3c9cd83`, 25 assertions confirm the corrected handoff and reproduce the other findings.
- [Syntax and existing-test evidence](2026-11-05-intelligence-validation.json): 40 changed JavaScript files parse; existing regression suite is 12/13; the committed claims probe throws a ReferenceError.

An assertion in a diagnostic probe can confirm that a defect exists. **25 diagnostic assertions passing does not mean 25 product acceptance tests passed.** The source hashes and expectation labels distinguish those meanings.

## Recent progress actually present

The new files implement sensory sampling, attention/habituation weights, temporal working memory, a metacognitive monitor, strategy modifiers, a self-model registry, resource telemetry, forward predictions, and motor-region dispatch. Daemon startup wires the timers and target callbacks; the sensory bridge calls working memory, prediction, and active inference in order. These are substantial executable additions.

The late corrections also have concrete source support: `c474b6c` propagates Shopify item failures instead of always returning draft publication success, counts reflection actions with `result.ok === true`, and caps OPEG regression tolerance at 15. `284075d` changes run/workflow scoring to the actual `done`/`success` terminal labels. These source changes are useful; this review did not contact Shopify, run commerce, or establish live end-to-end success. The remaining verifier-label mismatch is INT-06 below.

## Findings and closure criteria

### INT-01 — P1 — Phase 20 consumed a nonexistent prediction field: fixed in scope

Baseline: [active-inference.js](../../server/intelligence/active-inference.js) read `predictiveResult.ep3Surprise`, while [predictive-processing.js](../../server/intelligence/predictive-processing.js) already applies the signed cube root when constructing `errors` and returns no `ep3Surprise` field. [sensory-bridge.js](../../server/intelligence/sensory-bridge.js) passes that object directly, without an adapter.

A bus perturbation of 0 to 1 produced `errors.bus = 1`, but zero motor biases or bias injections. Adding the missing field as a positive-control adapter immediately produced biases. This disproved the baseline claim that the full prediction-to-motor path was closed.

**Independent fix result:** `3c9cd83` reads `errors[channel]` directly. With the same real producer output, the fresh recheck returns `communicate: 0.3`, `reflect: 0.15`, drive `0.15`, and two motor-region injections. This specific handoff is verified fixed. Real motor execution and reduction of real-world prediction error remain outside that result.

### INT-02 — P1 — Stop returns before the motor loop finishes dispatching new actions: open

Source: [motor-output.js](../../server/intelligence/motor-output.js), `motorCycle()` around lines 190–233 and `stopMotorOutput()` around 307–314; daemon stop calls this same stop function.

The loop awaits one target, then dispatches subsequent targets without checking whether the loop was stopped or replaced. Stop only clears the interval and sets the status flag. In the isolated start/stop reproduction, reflection was already awaiting completion when Stop returned `{ stopped: true }`. Resolving that request then dispatched **neurogenesis, a consciousness audit, and goal generation after Stop**, while status remained `running: false`.

This goes beyond allowing one in-flight request to finish: previously unstarted actions begin after the stop acknowledgement. Long callbacks can also overlap interval invocations because there is no in-flight cycle guard.

Closure: use a run-generation/cancellation token checked before every new dispatch and after every await, serialize cycles, and define whether Stop awaits the current action. Prove that stopping or restarting during a deferred handler dispatches no later actions from the old run.

### INT-03 — P2 — Resource ceilings do not bound an exhausted individual resource: open

Source: [resource-envelope.js](../../server/intelligence/resource-envelope.js), budgets around 36–50, pressure aggregation around 150–168, constraint decision around 330–332. Claim: `CLAUDE.md` Resource Envelope section says the module closes the unbounded-resources gap.

Each ratio is capped at 1 and then averaged with weights. A resource cannot contribute more than its weight, even when greatly over its ceiling. With other readings quiet, **1,024 MB heap against a 512 MB ceiling produces pressure 0.25, LOW, unconstrained**. Sixteen active runs against an eight-run ceiling produces the same result. The real motor consumer still executes all four injected target handlers in both cases. Ollama unavailable alone produces pressure 0.2 and permits those handlers as well.

The positive control confirms that motor dispatch does suppress all handlers when the aggregate constraint is actually true. The defect is the individual-budget enforcement, not an absent call to the envelope.

Closure: keep weighted pressure as telemetry, but add per-resource critical/exhausted admission checks and dependency-specific availability checks. Test each resource independently, combined pressure, recovery, and whether DB capacity includes WAL growth. Until then describe this as advisory aggregate pressure, not a hard resource envelope.

### INT-04 — P2 — Failed and suppressed motor attempts become success telemetry: open

Source: [motor-output.js](../../server/intelligence/motor-output.js), catch around 182–185, efference copy around 220–229, firing counters/history/event around 241–266.

`fireAction()` catches an exception and returns `{ error }`. The caller treats every truthy result as success, emits `result: 'ok'`, and records an efference copy. A deliberately failing reflection handler reproduced exactly that behavior: the error was logged, but the motor report said `ok` and told the predictor reflection had executed. Truthy `{ skipped: ... }` results have the same classification problem.

Separately, when all six regions were resource-suppressed, no target handler ran, but `firings` still increased by six and a `system.motor.fired` event was published without per-item result status. Persisted `action_taken` likewise lacks that distinction. This can corrupt the measurements that subsequent adaptation uses.

Closure: define explicit executed/successful/failed/skipped outcomes; preserve errors in history and events; update success counters and efference copies only for actually executed actions. Keep attempt counts separately. Cover exceptions, returned failures, skipped actions, missing handlers, suppression, and success.

### INT-05 — P2 — Strategy action names do not match motor region names: open

Source: [adaptive-strategy.js](../../server/intelligence/adaptive-strategy.js), strategy lists around 59–69 and predicates around 221–229; [motor-output.js](../../server/intelligence/motor-output.js) passes raw region keys around 206–216.

Conserve suppresses `goal_seek`, but motor asks about `goalSeek`. The isolated integration test shows the actual goal handler running under conserve. A matching-name positive control suppresses neurogenesis correctly. Diversify similarly prefers `consciousness_audit`/`goal_seek`, while the motor keys are `selfAudit`/`goalSeek`, so those preferences do not reach their intended regions.

Closure: share canonical action identifiers or translate region keys at the boundary. Test each strategy against every motor region, including preference thresholds and suppression, rather than testing the strategy getter alone.

### INT-06 — P2 — Successful verification loops still look unsuccessful to metacognition: open

Source: [metacognitive-monitor.js](../../server/intelligence/metacognitive-monitor.js), success query around 106 and failure query around 202; producer [verifier-loop.js](../../server/intelligence/verifier-loop.js) stores terminal status `passed` around 190–194.

The late `284075d` correction fixes run and workflow labels but leaves verification queries using `APPROVED`. That is the model's verdict string, not the stored successful loop status. The probe runs the real verifier producer against deterministic model replies with all execution/filesystem dependencies forbidden, collects its three `passed` rows, and passes those rows through the monitor's status predicates.

Result: verification success **0**, stuck score **0.333**, effectiveness **0.275**, strategy **conserve** despite three successful loop records. A positive control using invented DB status `APPROVED` yields success **1**, stuck score **0**, effectiveness **0.525**, strategy **nominal**. The production system can dampen itself because it misreads its own successful work.

Closure: use the producer's actual terminal vocabulary, distinguish failed terminal outcomes from running work, and add a shared fixture covering all statuses and their effect on strategy selection. These are fixture-based contract results, not statistics from the user's live DB.

### INT-07 — P2 — Effectiveness is an error-trend heuristic, not the claimed action-success feedback: open

Source: [active-inference.js](../../server/intelligence/active-inference.js), previous-error comparison around 131–151, direct bias calculation around 169, separate effectiveness injection around 207–215. Claims: source commentary and `CLAUDE.md` around 369–370 say biased actions reducing errors reinforce drive, and failure dampens motor bias.

The estimator compares consecutive error magnitudes whether or not any motor action ran. No executed-action outcome or action identity enters that calculation. Direct bias is `surprise * weight * sensitivity`; effectiveness is not a factor. With the same current bus error and gate modifiers, improving and worsening error histories produce effectiveness **0.54** versus **0.46**, but identical biases (`communicate: 0.15`, `reflect: 0.075`) and identical drive **0.075**. No motor target was executed in these trials.

The separate cortical injection could influence later neural dynamics indirectly; this probe does not rule that out. It does establish that the direct reinforcement/dampening claim and label "action success rate" exceed what is measured. The inspected path is a fixed heuristic controller; the results do not establish causal action effectiveness or a learned policy.

Closure: either label this accurately as error-trend telemetry, or connect executed-action receipts and the relevant subsequent observations to a tested feedback rule. Show improvement versus a no-action baseline and avoid rewarding unrelated error reductions.

### INT-08 — P2 — Validation artifacts are currently inconsistent: open

1. `node --test test/continuity-hardening.test.js test/ouroboros-inheritance.test.js` returns **12 passed, 1 failed**. The failing healthy-ledger mock returns `{ verified: true }`, but the real ledger returns `{ valid: true }`. Commit `4d80a67` correctly changed the consumer to read `.valid`; it did not update the fixture. This is a stale test I originally authored, not evidence that the corrected production ledger contract is broken. Update both healthy and unhealthy mock contracts and add a real-ledger contract assertion.
2. The original claims probe committed in `3c9cd83` now references `positiveControl` in the evidence object after removing its declaration. Running it throws **`ReferenceError: positiveControl is not defined`**. Its committed evidence predates the correction and cannot stand in for a successful rerun of that edited script. Preserve the historical evidence and regenerate a clearly identified post-fix result after correcting the artifact.

The independently named recheck supplied here restores explicit positive controls and can run either Git baseline or corrected source. It does not modify the implementation session's committed probe.

## Reproduction and validation

From the repository root:

```powershell
# Reproduce the reviewed baseline from Git, even after the working tree changes.
node docs/reviews/2026-11-05-intelligence-independent-recheck.mjs --ref 284075d

# Independently verify the handoff correction and reproduce remaining findings.
node docs/reviews/2026-11-05-intelligence-independent-recheck.mjs --ref 3c9cd83 --expect-fixed-contract

# Existing tests use a temporary CHANDRA_DATA_DIR; no live data is opened.
node --test test/continuity-hardening.test.js test/ouroboros-inheritance.test.js
```

The scripts assert the state described in this report. As findings are fixed, retain the baseline reproduction and write new acceptance expectations rather than weakening assertions to make an old result appear green. Optional `--output PATH` writes JSON only when explicitly supplied.

All 40 changed `.js` files at `3c9cd83` passed `node --check`. This checks parsing, not import-graph boot safety or behavior. No frontend files changed in the baseline code diff; screenshots and documentation do not verify runtime behavior. No live server restart, browser collection, benchmark run, database recovery, or production data operation was performed. The prior continuity fixes still require a different agent's independent review; this session does not self-approve them.

## Implementation handoff

Keep the next slice focused on the control loop before adding Phase 21: INT-02 stop/serialization, INT-04 truthful outcomes, INT-06 status contracts, INT-05 canonical action identifiers, INT-03 admission limits, then INT-07 calibrated feedback or corrected labeling. Repair INT-08 so future machines have runnable evidence. This review's published tag is `review/fraynix-intelligence-2026-11-05`.

| Finding | Implementation owner | Independent status | Follow-up commit |
| --- | --- | --- | --- |
| INT-01 | Concurrent implementation session | Scoped fix independently verified | `3c9cd83` |
| INT-02 through INT-07 | Unclaimed | Reproduced; changes requested | Pending |
| INT-08 | Test/probe maintainers; stale ledger mock originally authored by this reviewer | Failures recorded; correction required | Pending |

Implementation owner: claim the relevant rows before changing shared source, record fix commits and acceptance tests, and keep the baseline evidence. A different session should verify each new fix against the criteria above. The next machine can reconstruct the result from Git and these files without access to chat history.
