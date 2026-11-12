# Teaching the models, and where Gemini fits — outline

*2026-11-12. Written after reading `carbon-one.txt` (two Gemini-generated plans for Fraynix-Agent-Workspace) and Vaughn's
Google AI Ultra plan, at his request: "outline it, and let's proceed with your recommendations to get the most function
and value from this".*

## 1. What the file offered, sorted

| Idea in the file | Here already | Verdict |
|---|---|---|
| Immutable judge, AST blocklist, `-I` Python | Skill Forge sandbox (`node --permission`, no writes, no child processes, env stripped, escape-probed) | keep ours |
| SkillWorkshop: spec → code + tests → register | Skill Forge: verified programs become `skill.*` fleet tools, calls measured, failures retired | keep ours |
| Git-worktree lineage, "black hole" of failed hashes | Self-modification kernel: worktree builds, failed builds never retried blindly, proposer credit, human merge | keep ours |
| Brier self-calibration | capability gauge reports Brier | have it |
| dREAM with 30 "ontological seed" fusion | the ungrounded kind just removed (`dream-ground.js`) | rejected |
| Clade meta-productivity, MAP-Elites islands | — | premature: the kernel has merged too little code for a lineage to mean anything |
| **Weight consolidation** (LoRA on verified work → GGUF → Ollama) | — | **the one new capability: build it** |

Defects in the file's code, so nobody drops it in: `skill_workshop.py` line 917 is a syntax error; the worktree
evaluator reports 10/10 whenever the exit code is 0 (its Wilson scores are invented); the RealitySeal gate is
`max(trust, 0.818) ≥ 0.618` and can never block; "predicted probability" is a hard-coded 0.85; `git_autosave_push` runs
`git add -A` and pushes on every dream and memory (it would commit `.env`); the φ⁷⁵ "seal" is a constant string;
`gpt-oss:120b-cloud` is a cloud model, not a local one.

## 2. The rule for "tools that make tools"

**Make it when execution can prove it; depend on it when it is data, physics or a trained model.** Logic — parsers,
solvers, checkers, search, glue — is made here and kept only after it has been run and checked (Skill Forge; the
reasoner's `search` strategy, where the model writes a puzzle's rules and fixed code searches: planning 0/6 → 12/12
held out). Weights, codecs, map data, web search and GPUs are dependencies. A made tool that was not executed before it
was kept is the failure seen twice on 2026-11-12 (dreams that passed 97 % and learned nothing; a smoke test that passed
on a key name).

## 3. Weight consolidation — the plan

**Why:** Chandra improves its prompts, memory, tools and strategies, but the models never learn. Every lesson lives
outside the weights and must be re-read every call.

**What it trains on (measured 2026-11-12; only verified work, never the gauge):**

| Source | Count | Why it is trustworthy |
|---|---|---|
| Goal runs Vaughn rated 👍 | 21 | a human judged them |
| Goal runs scored ≥ 0.6 that made real tool calls | 30 | real tool use that finished well — the fleet's known weakness is narrating calls instead of making them |
| Film scripts accepted by the checker, with the refused drafts before them | 39 films | the checker is code; refused → accepted pairs teach what passes |
| Verifier-passed programs | 3 | proved by execution |

Excluded on purpose: capability-gauge items (training on them would turn the gauge into a test of memorisation); runs
scored only by the local judge without tool calls or a human vote (half that score is a judge that agrees with itself
73 % of the time); anything the narration guard flagged.

**Steps:**
1. `server/intelligence/distill-data.js` — exports chat-format JSONL from those sources; each record carries its source,
   id and why it qualified; a fixed 20 % of each source (by hash of its id) is held out and never trained on;
   secrets-shaped strings are refused; `POST /api/intelligence/distill/export` writes `data/distill/<date>/`.
2. `scripts/colab/chandra-lora.ipynb` — Vaughn runs it in Colab (his Ultra plan's premium GPUs). Unsloth 4-bit QLoRA on
   `unsloth/Qwen3-14B` (the model that answers most agent calls, on fraymus-home), a few hundred steps, export GGUF
   Q4_K_M. Nothing in it needs a key; it reads the uploaded JSONL and writes the GGUF to his Drive.
3. Import: copy the GGUF to fraymus-home `D:\Models`, `ollama create qwen3-chandra:14b` there (a new model; Ollama's
   settings are not touched), add it to `MODEL_HOSTS` as a second home entry, **off for default calls** until measured.
4. Measure, paired, base vs adapter, on the held-out 20 %: (a) tool calls really made vs narrated; (b) scripts accepted
   on the first attempt; (c) the capability gauge on the same seeds — **must not fall** (the check for forgetting).
   Adopt only if (a) or (b) improves and (c) holds. Otherwise keep the base and record why.

**Honest expectation:** about 300 records is small. The first adapter may move little. The value of doing it now is
the pipeline and its measurement; it should be re-run as rated and verified work accumulates (Rate Outcomes votes are
the cheapest way to grow the best source).

## 4. Gemini — where it earns its keep without a runtime dependency

**Not in the app's runtime.** Calls from the running app would send prompts, memories and Vaughn's IP to Google and
make "free and offline" untrue; the GCP credits ($141.43) expire between 2027-01-27 and 2027-11-12 and calls past them
bill. The app stays local.

**Yes, in two bounded places:**
1. **Colab for training** (section 3). Only the training file leaves this machine; the result comes home and runs
   locally.
2. **A one-off outside referee for the measurements.** The memory gold set was graded by a local model that agrees with
   itself 73 % of the time (kappa 0.35). A stronger model grading a fixed sample once says how far the local judge is
   from a better one. `F:/Claude-Work/chandra-superintelligence/referee/gemini-referee.mjs`: reads `GEMINI_API_KEY`
   and `GEMINI_MODEL` from its own environment (Vaughn creates the key in AI Studio and sets it himself; the script
   never prints it), shows exactly what it would send and sends nothing without `--send`, caps the call count, and
   writes agreement figures beside the local judge's. Not imported by the server.

**For Vaughn's own work:** Deep Research, AI Studio and Antigravity are good tools to think with, as with this file.
What comes back is a pile of ideas to check against the code, not code to drop in.

## 5. Order, and where it stands

1. **Done:** the planning `search` strategy (0/6 → 6/6 on the paired items, 12/12 held out; the full gauge
   0.583 → 0.812, p = 0.004).
2. **Done:** the training-data exporter, tested; first real set 40 to train, 12 held out.
3. **Done:** the Colab notebook (cells parse; not run, it needs Vaughn's login), the import script (dry run passed on
   fraymus-home) and the measurement script (proven on qwen3:14b vs qwen3:8b: films 5/8 vs 1/8).
4. **Done:** the Gemini referee script (dry run: 12 tasks, 169 notes, ≈ 75,000 characters, nothing sent).
5. **Vaughn:**
   - **Train:** export a fresh set (`POST /api/intelligence/distill/export`), upload `train.jsonl` to the notebook in
     Colab with a GPU, paste its sha256, run all, download the `.gguf`. Then
     `node scripts/colab/import-adapter.mjs <file> --sha256 <hex>` and
     `node scripts/colab/measure-adapter.mjs --base qwen3:14b --candidate qwen3-chandra:14b`.
   - **Referee (optional):** create a key in AI Studio, then in a PowerShell window
     `$env:GEMINI_API_KEY = "<key>"`, `node gemini-referee.mjs --list-models`, then
     `node gemini-referee.mjs --send --model <id>`.
6. Record each result here. Re-train as rated work accumulates: every 👍 on Rate Outcomes adds to the strongest source.
