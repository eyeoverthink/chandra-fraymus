# Independent fix recheck: intelligence phases 21–24

Reviewed fix: `19a598103f012ea5b6837f0bf67dd9be9f584cb2`. Original implementation: `862e1ad`; [original nine-finding review](2026-11-06-phases21-24-review.md). Reviewer: Codex, independent-review role requested by Vaughn. Date: November 6, 2026, America/Los_Angeles; evidence timestamps use UTC.

**Verdict: two findings closed within isolated scope; seven partially addressed.** The claim that all nine original findings are resolved is not supported. Several important primary defects are fixed: actual neural input changes, all three fleet action paths run, ordinary Stop/reset discards stale narrative results, correct Heart/gate fields reach prompts, zero ratings survive, and configured REST/fleet dream artifacts pass real Ed25519 verification. Remaining cases below prevent full phase acceptance.

All **six changed JavaScript files parse**. The [recheck probe](2026-11-06-phases21-24-fix-probe.mjs) executes **25 diagnostic assertions**; [evidence](2026-11-06-phases21-24-fix-evidence.json) contains source hashes, observations, public signature material and reviewer dispositions. Diagnostic assertions include explicit defect reproductions; passing them does not mean feature acceptance.

## Findings with remaining work

### INT-21-03 — PARTIAL; remaining P1: stale cleanup unlocks a new lifecycle

The new in-flight guard prevents ordinary scheduled overlap, and lifecycle tokens suppress completions after ordinary Stop/reset. Both corrected cases pass.

The lock is still a global boolean. At `self-narrative.js:334`, an old generation's `finally` unconditionally sets `generationInFlight = false`, even if Stop/reset/start has already created a new generation and request. The controlled-timer probe reproduces:

1. Old request A is pending.
2. Stop/reset/start creates a new lifecycle; request B starts and owns the lock.
3. A resolves. Its result is correctly discarded, but its `finally` clears B's lock.
4. The next interval starts C while B is pending.
5. C completes, then B completes and overwrites C's newer narrative.

This is not the original unguarded stale commit: that part is fixed. It is an ownership race in the new cleanup. The probe records three model calls and two commits in the new lifecycle, with the older B response left as current.

Closure: make cleanup conditional on the lifecycle/request that owns the in-flight slot, or retain an owner promise/request ID. Test ordinary stop, reset, restart, stale `finally`, failure and out-of-order completion. Define cancellation results for waiting callers rather than returning an unrelated cached narrative.

### INT-22-01 — PARTIAL; remaining P2: the neutral guard measures the wrong quantity

The one-element trajectory now returns finite stable values. The neutral compound regression remains unchanged.

`heart.js:292` sums **normalized** values. Its no-lexicon fallback has seven values of 0.12, totaling **0.84**; that passes the new 0.15 minimum. The actual `Heart.feel('table pencil notebook')` still returns primary neutral, zero raw emotion scores, and compounds **awe, jealousy and hope**.

Closure: use raw evidence/support from the analysis or an explicit evidence/confidence flag, not the sum of a fallback-normalized vector. Retain an explicit bittersweet positive control and a neutral no-lexicon control through actual `Heart.feel`. Define the intended scope of the still module-global, process-local history. The compound vocabulary remains a fixed table.

### INT-24-01 — PARTIAL; remaining P2: self-model freshness still conflicts with its producer

The previous 180-second sensory/emotional/resource false-stale cases now pass. Known zero effectiveness now produces a degraded score of 0.3 rather than a healthy-looking 0.5. These are confirmed improvements.

`FRESHNESS_BOUNDS.selfModel` remains **600 seconds** (`intelligence-monitor.js:68`). The self-model persists only every **20th** `selfModelSnapshot()` call; the daemon calls that once per cycle. Its unscaled default is **30 minutes per cycle**, so the ordinary base snapshot interval is **10 hours**, with gate/resource scheduling able to alter it. Manual calls could add snapshots, but are not a guaranteed heartbeat.

A schema-correct self-model record becomes stale at 601 seconds in the probe, well before an ordinary next persisted snapshot is due. A missing first snapshot is labeled idle but can still count as degraded. The blanket threshold problem is reduced, not fully removed.

Closure: use an explicit liveness heartbeat/live subsystem state or a producer-aware freshness contract including startup grace. Do not infer stopped or degraded cognition solely from a sparsely persisted body snapshot. Test the self-model across its actual configured cadence as well as the three already-fixed producer periods.

### INT-21-01 — PARTIAL; original P1 API failure fixed, P2 placement discrepancy remains

All three consumers now call public `inject(x,y,sigma,amplitude)` with corrected width/strength order; actual CTRNN input changes and inhibitory amplitude is negative. Those primary fixes pass against the real public object.

The row/column claim is still inconsistent with placement. The code labels narrative injection as **row 2, column 8**, but calls `inject(2,8,...)`, which places it at **x=2/y=8**, i.e. column 2/row 8 under the core's indexing (`ix = i % gridSize`, `iy = floor(i/gridSize)`). The observed narrative field is substantially stronger at row 8/column 2 than row 2/column 8. Dream and monitor calls keep the same first-coordinate-as-row convention; the registry still describes horizontal rows.

Closure: choose and document a consistent coordinate convention across calls, event metadata, registry and display. If first-coordinate bands are intended, describe columns/x-bands and update the diagram; if literal rows are intended, convert coordinates consistently. Assert actual field location, width and sign. The earlier closure criteria explicitly included coordinate meaning, so this is a remaining contract item rather than a claim that the API repair failed.

### INT-23-01 — PARTIAL; normal signing works, unsigned outcomes are hidden

The daemon now passes the exported Dreamer singleton into the module. `fraymus-tools.js` creates that Dreamer with a null identity and populates identity asynchronously; explicit readiness/error reporting therefore matters.

The recheck injects the **actual Dreamer class**, actual identity/sign/verify primitives and an ephemeral Ed25519 key. Artifact file operations are intercepted in RAM. A normal REST solve creates dream 1 and a normal fleet solve creates dream 2; **both signatures verify against the exact captured body**. The committed evidence contains their public key, bodies and signatures, but no private key. This verifies the repaired supported paths with a configured signer, not the live daemon's loaded identity.

With an invalid signing identity, actual Dreamer catches the signing failure and returns a numbered unsigned artifact. The solver still returns a normal HTTP 200 result with dream number 3, no signing-status field and no failure status. Only the first two artifacts have signatures. It discards the Dreamer's `signed` result.

Closure: propagate recording/signing readiness and outcome separately from a dream number, including `signed: false` or a structured signer error. Retain the successful REST/fleet signature controls and add missing/failed identity cases. Do not infer a signed artifact from an ordinal alone.

### INT-21-05 — PARTIAL; zeros fixed, failure classification and neural use remain incorrect

All four zero ratings (coherence, awareness, novelty, feasibility) now remain zero. The false dream-queue assertion is removed, and model exceptions produce a visible `llm_failed` response. Those changes pass.

However, `dream-solver.js:189` infers failure from **novelty 0.2 + feasibility 0.1 + zero associations**, rather than recording whether the model call threw. A valid model response with exactly those ratings is falsely marked `llm_failed` in the probe. Conversely, an actual model exception still produces novelty 0.2 and injects a **positive creative-spark amplitude of 0.15** at base sensitivity.

Closure: set an explicit execution-outcome flag in the error path, independent of model-provided scores. Validate the full model schema, preserve zeros, and suppress or separately label failure-driven neural input. Keep model opinions separate from independently measured ability or success.

### INT-23-02 — PARTIAL; save failures surfaced, read projections and counters remain inconsistent

Rejected inserts are now logged; direct solve returns `status: 'storage_failed'`, and its ordinary topic event explicitly carries `stored: false`. The probe confirms that outcome, then confirms a subsequent successful retry stores its row. Keeping the event on the same topic is acceptable when consumers honor the durability flags.

Remaining issues:

- `getDreamSolverStatus()` drops the failure status from `lastSolution`, so the subsequent status GET presents a failed-save result without that flag.
- Narrative/monitor `snapshotsStored` still count invocations. In this probe both report nonzero counts while their sampled-history tables contain **zero rows**.
- Cached counters/last state remain process-local rather than restored from history. Sampled history is legitimate, but the returned labels must reflect it.

Closure: preserve the outcome/durability fields in status/history projections and return accurate stored-row counts or clearly named invocation counts. Document sampled/process-local state versus persisted state. Retain rejection/retry tests and add projection/restart checks.

## Scoped closures

| Finding | Verified disposition |
| --- | --- |
| INT-21-02 | **PASS_ISOLATED.** Actual fleet executor invokes all three requested actions; model-call and assessment counts change and correct result shapes return. |
| INT-21-04 | **PASS_ISOLATED.** Actual Heart averages and the gate's top-level four-proof field reach the narrative collector correctly. |

Partial findings include additional passing subcases; the two-closure count does not mean only two code changes worked. Primary neural API repair, zero preservation, trajectory repair, ordinary lifecycle guards, signed normal solves and explicit storage failure are all confirmed above.

**0/4 new phases independently accepted.** Phase 21 retains lifecycle/placement/outcome work; Phase 22 retains neutral false positives; Phase 23 retains signing/outcome/durability work; Phase 24 retains liveness/placement/counter work. This recheck does not recertify earlier intelligence or RE integration phases.

## Reproduction and next-agent handoff

```powershell
node docs/reviews/2026-11-06-phases21-24-fix-probe.mjs --output PATH_TO_NEW_EVIDENCE.json
```

The probe pins source to the fix commit using `git show`, retains the baseline fixture helpers, and uses in-memory SQLite with actual producer schemas, actual CTRNN/fleet/bus/Express bodies and controlled timers/model outputs. Unrelated permission/result-sealing services remain fixtures. It uses real local Ed25519 operations with an ephemeral RAM-only key and intercepted Dreamer artifact files; this is not a live identity test. No live app/DB imports, HTTP requests to the live service, runtime starts/stops, model/compiler calls or file deletions occur. The baseline probe/report remain intact at `862e1ad`.

Fix ownership of the scheduler lock first. Then gate neutral compounds on real evidence and record explicit model outcomes. Finish coordinate consistency, self-model liveness and outcome/signature projections. Provide corrected-behavior tests at the next pinned fix commit; keep the successful controls so regressions are visible. No production source was changed by this reviewer.

Tag: `review/intelligence-phases21-24-fixes-2026-11-06`.

Fraynix - By Vaughn Scott
