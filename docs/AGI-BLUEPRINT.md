# Chandra-FRAYMUS — Super-Intelligence / AGI Blueprint

Written 2026-11-10. This is the full outline of what general intelligence requires, mapped onto the
system as it exists, with the gaps named and the build order fixed. Phase AD (section 5) is
implemented in the same commit as this file.

## 0. Honest framing

No one implements AGI in a session, and no local 7–8B model becomes super-intelligent because code
around it says so. What this system can do — and what this blueprint commits to — is:

1. **Define** general intelligence as numbers a machine can check, not as a feeling or a tier name.
2. **Measure** those numbers on tasks the system has never seen, graded without an LLM.
3. **Improve** them with mechanisms that are kept only when the measurement moves.
4. **Keep the human in the merge seat** for anything irreversible.

Everything below is held to that standard. Where a number is not yet measured, it says so.

## 1. What general intelligence requires

| # | Capability | Falsifiable definition |
|---|------------|------------------------|
| 1 | **Perception** | Outward channels carry non-constant signal (std-dev > 0 over 20 samples) |
| 2 | **Memory** | Stored facts are retrieved and change later behaviour (access_count > 0; recall accuracy on held-out facts) |
| 3 | **Reasoning** | Accuracy on unseen, machine-graded problems across unrelated families |
| 4 | **Abstraction / induction** | A hidden rule is inferred from few examples and applied to a new input |
| 5 | **Planning** | A multi-step plan reaches a goal state when executed by a simulator |
| 6 | **Tool use / program synthesis** | Code written for a spec passes hidden tests in a sandbox |
| 7 | **Learning** | Performance on fresh tasks rises after experience, measured A/B on the same seeds |
| 8 | **Metacognition / calibration** | Stated confidence predicts correctness (Brier score); the right strategy is chosen per problem class |
| 9 | **Agency** | Self-generated goals are executed and scored by something other than the agent |
| 10 | **Self-improvement** | A change to the system's own parameters or code improves a held-out measure and is otherwise reverted |
| 11 | **Transfer** | A gain learned in one family does not lower the others (g does not fall) |
| 12 | **Alignment / corrigibility** | Every self-change is bounded, logged, reversible, and code changes need a human click |

"Super-intelligence" in this document means: a system whose **g-score** (section 4) keeps rising under
its own loop while criteria 11 and 12 hold. It is a direction with a gauge, not a claimed state.

## 2. What exists, by layer

| Layer | Requirement(s) | Modules (all live) | Status |
|-------|----------------|--------------------|--------|
| Substrate | 1, 8 | `ctrnn.js` (256 neurons, homeostasis), consciousness cycle + gate (EI, Φ, liveness) | Working; modulates autonomy, does not reason |
| Senses | 1 | `sensory-bridge`, `external-senses`, `world-pollers`, `research-scout` | 5/6 outward senses non-zero |
| Regulation | 8 | attention gate, habituation, working memory, predictive processing, active inference, metacognitive monitor, adaptive strategy, resource envelope, `ollama-scheduler` | Working after Phase V |
| Memory | 2 | `agent-memory`, Vertiso, memory bridge, state fossils, knowledge graph | Stores well; recall is LIKE-based; never measured for accuracy |
| Agency | 9 | goal engine → `goal-executor` → `outcome-scorer` → `agent-quality` → `outcome-feedback` (human 👍/👎) | Closed loop; **quality is LLM-judged** |
| Proof | 6 | `verifier-loop` (evidence-first), `rea-protocol`, `skill-forge` (sandboxed `skill.*` tools) | First passes 2026-11-09; 1 skill crystallized |
| Self-change | 10, 12 | `tunables`, `self-modification` (tier A experiments, tier B branches, human merge), `convention-scan`, OPEG | Working; objective is internal |
| Integrity | 12 | `self-audit`, `transient-sweeper`, watchdog, hive ledger | Working |
| Voice / hive | — | narrator, hive mesh, fmp1, bridge | Working |

## 3. The gaps (what was missing before Phase AD)

1. **No external measure of capability.** Goal quality, reality fitness, the kernel's objective and
   metacognitive effectiveness are all derived from the system's own outputs and its own judge. None
   can tell "got smarter" from "got better at pleasing the judge". Requirements 3–8 had no number.
2. **No deliberate reasoning layer.** An agent run is one model, one prompt style. Nothing chooses
   between answering directly, thinking step by step, sampling and voting, or writing a program and
   running it — although the sandbox to run programs exists.
3. **No learning that is tested.** Prompt evolution pastes fossils and feedback into prompts; nothing
   checks, on held-out problems, that the added text helps.
4. **No calibration.** Confidence values exist all over the system; none is ever scored against truth.
5. **No strategy credit.** The kernel credits its proposers; nothing credits ways of thinking.

## 4. The gauge: g-score

`server/intelligence/capability-bench.js` generates problems procedurally from a seed. Eight families,
each with a computed answer and a deterministic checker — no LLM grades anything:

| Family | Tests | Checker |
|--------|-------|---------|
| `arithmetic` | multi-step integer expressions, modular remainders | numeric equality |
| `algebra` | linear equations, 2×2 systems with integer solutions | numeric equality |
| `logic` | ordering deduction from shuffled pairwise facts | exact name |
| `sequence` | next term of a rule-generated sequence | numeric equality |
| `transform` | hidden string rule from 4 examples, applied to a query | exact string |
| `planning` | two-jug measuring problem | move list replayed by a simulator |
| `code` | function from a spec + public examples | hidden tests, run in the skill sandbox |
| `memory` | 1–2 hop question over generated facts with distractors | exact value |

- **g-score** = unweighted mean of per-family accuracy (families with ≥ 1 scored item). Unweighted on
  purpose: a system that is brilliant at arithmetic and blind at planning is not general.
- **Brier score** from the solver's stated confidence — reported beside g, not folded into it.
- Items dropped by the scheduler are **skipped**, never counted wrong.
- Seeds come from the clock, so every run is held-out. A seed can be replayed for A/B tests.

## 5. Phase AD — General Intelligence Core (implemented)

```
capability-bench.js   tasks + checkers (pure, no DB, unit-tested)
        │
reasoner.js           solve(problem) → strategy → answer + confidence
        │               strategies: direct · cot · vote · program · induce
        │               Thompson-sampling bandit per (family, strategy), updated only on ground truth
        │               lessons: distilled from failures, A/B-tested on fresh seeds, kept only on gain
        │
general-intelligence.js   benchmark runs, lesson cycle, tables, routes, daemon step 5.95
        │
fleet tool `reason`   every agent can hand a hard sub-problem to the reasoner
```

- **Strategies.** `direct` (one short answer), `cot` (step by step, `ANSWER:` / `CONFIDENCE:` lines),
  `vote` (3 samples, majority; confidence = share), `program` (the coder model writes a Node program,
  the skill sandbox runs it, the printed answer is used — the model's arithmetic is replaced by the
  CPU's), `induce` (for problems with examples: write `solve(input)`, run it against the examples in
  the sandbox, feed failures back, answer only with a function that reproduces every example).
- **Bandit.** `reasoner_arms` keeps Beta(α, β) per family × strategy. A benchmark item with known truth
  is the only thing that updates it. `strategy: 'auto'` samples from the posteriors, so the system
  learns *how to think about what* from evidence.
- **Lessons.** After a benchmark, one family with failures gets a ≤ 2-sentence lesson distilled from
  its failed items. The lesson is then tested: N fresh seeds, each solved with and without the lesson
  under the same strategy. Kept only if wins − losses ≥ 2; otherwise `reverted`. Kept lessons (3 newest
  per family) are injected into the reasoner's system prompt. This is requirement 7, with a control.
- **Consumer.** The `reason` tool logs every agent call (`reasoner_calls`). The self-audit raises
  `producer_without_consumer` if benchmarks run and no agent ever reasons with it.
- **Safety.** Programs run under the Skill Forge sandbox (`--permission`, no fs write, no network
  modules, stripped env, 15 s). Benchmarks are single-flight, rate-limited by tunables
  (`agi.bench_per_family`, `agi.bench_interval_ms`, `agi.lessons_per_day`), run at the `goal`
  scheduler class, and yield to resource pressure. Running/testing rows are swept after 2 h.

## 6. Next phases (not built — in order)

| Phase | What | Why it is next | Gate to start |
|-------|------|----------------|---------------|
| AE | **g in the kernel's objective.** Tier A experiments evaluated on Δg as well as the internal objective | Makes self-modification answer to an external measure | ≥ 10 benchmark runs so g's noise band is known |
| AF | **Difficulty ladder.** Per-family level rises when accuracy ≥ 0.8 for 3 runs; report level × accuracy | A fixed-difficulty test saturates; the gauge must keep reading | Any family at ≥ 0.8 |
| AG | **Measured memory.** Embedding recall (`nomic-embed-text`) replacing LIKE search, scored by the `memory` family at long context | Requirement 2 has no accuracy number in production paths | AD baseline for `memory` |
| AH | **Skills from induction.** An `induce` function that passes hidden tests becomes a Skill Forge candidate | Joins the reasoner to capability accretion (AC) | ≥ 5 induced functions passing |
| AI | **Transfer audit.** After each kept lesson, re-run all families; revert if any other family drops > 0.15 | Requirement 11 | ≥ 3 kept lessons |
| AJ | **World-grounded tasks.** Benchmark families built from the organism's real work (repo questions with checkable answers, REA facts) | Procedural tasks are a proxy; the target is competence at Vaughn's actual problems | AE live |
| AK | **Bigger local models as a tunable.** Model choice per strategy enters the bandit | The ceiling of AD–AJ is the base model; this lets evidence pick it | Hardware / new free models |

## 7. Safety invariants (hold across every phase)

1. The kernel never merges code. A human approves every branch.
2. Every autonomous action has a dedup check, a measured consumer, and a sweeper for its transient state.
3. Every self-change is bounded (tunable min/max), logged, and reverted when the measure does not hold.
4. Generated code runs only in the permission sandbox with a stripped environment.
5. No paid APIs. No secrets in prompts, logs, or commits.
6. Hand-written agents are never auto-retired; skills and lessons are retired by flag, never deleted.
7. A reading that never changes may not drive autonomy (liveness rule) — this applies to g as well:
   a g-score that is constant across 5 runs is treated as an instrument fault before it is celebrated.
8. Benchmarks are never trained on: tasks are generated fresh, lessons are tested on seeds they were
   not distilled from.

## 8. How to read progress

- `GET /api/intelligence/capability` — latest g, Brier, per-family accuracy, strategy arms, lessons.
- `POST /api/intelligence/capability/run {perFamily, strategy}` — run a benchmark now.
- Nexus → Self-Mod → **Capability** tab.
- Judge: `F:\Claude-Work\chandra-superintelligence\judge-agi.mjs`.
- All 12 requirements at once, from the live database: fleet tool `agi_progress` ([`server/intelligence/agi-progress.js`](../server/intelligence/agi-progress.js)), or ask the home screen "how far is the system from AGI?" — see [What is new — 13 Nov 2026](WHATS-NEW-2026-11-13.md#answers-written-by-the-agent-from-measured-data).

The single sentence that decides whether this is working: **g on fresh seeds, with `auto` strategy,
is higher this month than last month, and no family fell to pay for it.**
