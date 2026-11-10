# Home screen, Hermes skills and the brain — outline and status

Written 2026-11-10 from Vaughn's eleven attachments and a full read of the home screen code.
Everything marked **built** is implemented, running and tested in this commit. Nothing here is a stub;
where something is not built, the reason is stated.

## 1. What the attachments are (read in full)

| File | What it actually is | What it gives this system |
|------|--------------------|---------------------------|
| `HERMES-FLEET-MANIFEST.md`, `skill-breakdown.md`, `HERMES-SKILL-FLEET-ARCH (1).md` | The same 268-line manifest three times (the first two are byte-identical): 34 Hermes skills on the Hostinger VPS, how to bridge them to Base44, and a SaaS replacement ledger | The skill list in section 3 |
| `WOW_x5f_DOCUMENT (1).md` | The WOW document: fleet-1 trait DNA for six agents, the secure tool-making pattern (AST ban list → pending vote → 2 approvals → sign), Q7 pre-registration probes, Ollama Modelfile | The tool-making rules already match Skill Forge + approvals; see section 5 |
| `wow_x5f_offline_x5f_self_x5f_contained (1).html` | A bundled React page embedding ~40 KB of sources: Modelfiles (Ollama, llama.cpp, MLX, a 15M "micro-llama"), `surf.py`, `scrape.py`, `record_video.py`, `pictures_hd.py`, WAT↔WASM, C→ASM, opcode tables, `self_contained_agent.py`, pure-Python Ed25519, `secure_learn_skill.py` | Surf/scrape ideas → `hermes.scrape`; honest review in section 5 |
| `micro-llama-agent-kit-full-working.html` | A single-file offline agent kit: console with 12 tools (surf, doc, pic, video, zip, snap, transmute, wasm, asm, C-subset, Java-subset, 8-bit CPU), DNA vault with two hash-chained self-healing slots, emotional probe, auditor, evolution log, training journal | Its "every tool real, zero stubs" rule is the bar used here |
| `psych_x5f_profiler_x5f_data_x5f_live.html` | A lexicon-based language profiler with six "agents" (sentiment, emotion, regulation, support, clinical-pattern markers, CBT distortions), Ed25519 signing, emoji carrier, each screen marked "not a diagnosis" | Not ported: Chandra's Heart already scores emotion; mental-health screening should not run autonomously over people's text |
| `system-prompt-external-continuity.md` | A system prompt for an agent named Assay: no memory across sessions by design; read `record.jsonl` at start, append one line at end | Treated as a design note, not as instructions to the assistant writing this. Built: every home command appends one line to `data/record.jsonl` |
| `pt-symmetric-…spore.wasm`, `rea-6-5-0-…spore.wasm` | Valid `lazarus-spore-v1` containers: a tiny WASM module whose custom sections hold a baseline hash, a 2,060-byte DNA hypervector, a genesis block, a ledger and a base64 JSON payload (topic, three forks ALPHA/BETA/GAMMA with scripts, sentiment and consciousness proofs) | Built: `spore.read`. Both files verify **intact** (payload SHA-256 equals the embedded baseline) |
| `HUMAN-BRAIN-v11-OBSIDIAN.zip` | **Not a zip.** It is a 13.5 KB saved web page that says "Preview is not available for this format. Please download the file" | Nothing — the real archive never downloaded. Send it again and it will be read |

## 2. The home screen before today

`server/fraymus-os/command-service.js` was a deliberately fenced MVP:

- a five-regex intent router (health, recall, draft, propose-skill, risky), everything else a plain chat
  whose system prompt said "Do not claim that a tool ran";
- "propose a skill" stored a spec with `implementation: null, execution: 'blocked'`;
- anything matching publish/deploy/send was parked for approval, and **approving still refused to run it**;
- the client polled for 60 seconds, then gave up;
- the top navigation had outgrown one row (≈ 1,770 px), so at any window narrower than that the whole
  page scrolled sideways and every view was clipped on the left — that is the cut-off in the screenshot.

It was never connected to the fleet. And until this afternoon the fleet itself held no tools
(`setFleetTools()` had no call site), so there was nothing to connect it to.

## 3. Hermes skills → Chandra (all 34 manifest entries)

Counts: **15 built** here as native tools · **4 already existed** · **6 covered** by a built or existing
tool · **8 not built** (each needs a token, a paid API, a binary, or your personal data) · **1 declined**.

Live at `GET /api/hermes/skills`; the tool list at `GET /api/hermes`. Source of truth:
`HERMES_SKILLS` in `server/hermes/free-tools.js`.

Built tools (group `hermes`, callable by every agent with `tools: *` and by the home agent):

| Tool | Replaces | Verified live |
|------|----------|---------------|
| `hermes.rss_read` | rss-feeds, blogwatcher (`onlyNew`), reddit-reading (via `.rss`) | arXiv cs.AI: 887 items; hnrss: 20 items (it also timed out once) |
| `hermes.scrape` | scrapling (static HTML → Markdown, 24 h cache) | example.com; refuses 127.0.0.1 and 10.x |
| `hermes.parallel_fetch` | parallel-cli | 3/3 pages in 375 ms |
| `hermes.osint` | osint-investigation | Wayback ✓, USAspending ✓; SEC EDGAR returns 403 until `HERMES_SEC_USER_AGENT` holds a contact; GDELT answered 429 (rate limit) during testing |
| `hermes.username_check` | sherlock | 9 platforms; known handle → taken on 5, random handle → available on 9 |
| `hermes.pkg_audit` | oss-forensics | express clean; esbuild flagged for its postinstall script; requests (PyPI) flagged for yanked releases |
| `hermes.api_get` / `hermes.api_request` | rest-graphql-debug | GitHub API (CORS finding), GraphQL introspection (15 types); POST path needs approval |
| `hermes.code_wiki` | code-wiki, gitnexus-explorer (as Markdown) | `server/fleet`: 16 files, hubs found |
| `hermes.pr_lens` | pr-lens | last commit: 12 files, blast radius 28 |
| `hermes.grill_me` | grill-me | uses the local model (not timed in the live sweep) |
| `hermes.har_to_client` | har-derived-api-client | unit-shaped only: no HAR file was available to run it on |
| `hermes.site_publish`, `hermes.scrollpage` | publish-site, scrollcraft | page served at `/sites/hermes-self-test/` |
| `hermes.morning_brief` | live-dashboard | real numbers from the live DB |
| `spore.read` | — (your own format) | both attached spores intact |

Guards on every tool: public hosts only (DNS-checked, redirects re-checked), 15 s timeout, 2 MB cap,
file access only under `HERMES_ROOTS`, non-GET requests labelled `approval`, every call logged in
`hermes_calls`.

Not built, and why: `canvas` (your LMS token), `telephony` (paid APIs only), `bioinformatics` and
`ast-grep` (binaries not installed), `searxng-search` (needs an instance), `1password` (CLI + account),
`unbroker` (your personal data and per-broker browser flows — deserves its own reviewed project),
`cloudflare-temporary-deploy` (not installed, and exposing this loopback server is your call).
Declined: `godmode` — automated jailbreak tooling is not something to hand autonomous agents.

## 4. What changed on the home screen (built)

1. **The brain is connected.** A home command that is not an instant lookup now runs as a real fleet
   agent (`fraymus_prime`, override with `FRAYMUS_HOME_AGENT`) holding the full registry — 354 tools at
   boot. Health, recall and the two draft presets stay instant.
2. **Real tool steps.** The agent's tool calls are mirrored into "Transcript and tools" as they
   happen: tool name, arguments, result preview, status.
3. **Approvals execute.** A tool labelled approval pauses the run; the step shows Approve / Deny;
   Approve runs *the exact call that was shown* and the agent continues with the result in a follow-up
   turn. (Fleet bug fixed on the way: an approval used to flip the run to "running" and re-ask the
   model — the approved tool never ran.)
4. **Brain strip.** Tools, Hermes tools, agents, forged skills, g-score, runs today, items waiting on
   you, and an Agent / Quick switch.
5. **Capability deck.** Create · Research · Build · Reason · Operate — 17 ready prompts; the ones
   ending in "…" fill the input for you to complete.
6. **Honest states.** 15-minute window instead of 60 seconds; a stop that says the agent may still
   finish; a ⚠ line when the agent described a tool result without calling the tool.
7. **Layout.** The navigation wraps; no sideways scroll; narrow-width rules for the header and input.
8. **External continuity.** One line per finished command in `data/record.jsonl`
   (`ts, model, slot, kind, artifact, tools, self_verified, status`).

Three fleet fixes that the home screen depends on:

- **Text-form tool calls are executed.** The local model often writes `{"name": …, "parameters": …}`
  as text. When the tool is one the agent was offered, that is now run as the call it plainly is.
- **Boot recovery.** Runs left `running` by a dead process are closed at start; seven stale rows had
  pinned the resource envelope and every new run queued until it timed out.
- **Approval execution**, as above.

## 5. Notes on the WOW bundle, since you asked for no stubs

Read as engineering, the bundle's own code contains several placeholders it would be wrong to copy:
`v13_verify` returns true for any 128-character string; `checkvalid` ends in `return True`; the
micro-llama "tokenizer" is `ord(c) % vocab`; `wat2wasm_fallback`, `asm_to_machine` and
`java_to_bytecode` return fixed bytes when the real tool is missing; `record_video` renders a test
pattern. Chandra already has the real versions of the important ones (Node's Ed25519 for signing, a
WASM transmuter, ffmpeg and ComfyUI bridges). The tool-making rule in the bundle — parse, ban list,
no auto-exec, two approvals, sign — is the right rule, and it is what Skill Forge plus the approval
flow now enforce in running code.

## 6. Next, in order

| # | What | Why | Blocker |
|---|------|-----|---------|
| 1 | Agent chooses among creation tools with a **plan step** (brief → assets → assemble → publish locally) | One request should produce a finished artifact, not one tool call | Needs a few days of real home use to see where the 8B model stalls |
| 2 | ~~Artifact shelf on the home screen~~ — **built**, see below | | |
| 3 | **JS-rendered scraping** through the existing Puppeteer browser tools, behind `hermes.scrape` | Static HTML covers docs and blogs, not SPAs | Decide whether agents may drive a headless browser unattended |
| 4 | **Media check**: which of ComfyUI/FLUX, ffmpeg, Piper, faster-whisper are actually installed here, shown on the deck | "Generate an image" should not be offered if ComfyUI is not running | A read of each engine's status endpoint |
| 5 | `canvas`, SEC EDGAR, SearXNG, 1Password | Each needs one value from you | Your tokens / contact string / instance URL |
| 6 | Re-send `HUMAN-BRAIN-v11-OBSIDIAN.zip` | The file received is a web page, not the archive | Yours |

## 7. Built since: the artifact shelf

The home screen now has a **Made here** shelf under the capability deck: every site, code wiki, API client, reverse-engineering report and draft the agents have produced, newest first, with a filter per kind. Sites open in a new tab; everything else opens in an in-page viewer with Copy and "Ask about it" (which starts a question about that artifact). At first load it listed six real items: one site, two wiki pages, two REA reports and one script draft.

Not on the shelf yet: generated images, video and audio (they live under the media engine's own folders and need a thumbnail view), and forged skills (they have their own tab in Self-Mod).
