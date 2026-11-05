# Content Nexus: live agent insights and source diagnostics

Owner: Vaughn Scott. Implementation and validation: Codex Content Nexus session, 2026-11-05. Status: **implemented and locally tested; independent review and normal backend restart pending**. A concurrent session committed the initial shared-tree implementation as `eb60df0` and the recency/README handoff as `837f679`; this final handoff adds per-source sync outcomes and records the actual scope. The shared Git identity does not distinguish session authorship.

## Problem observed

The supplied screenshot showed zero items and suggested that clicking Ingest All Sources would populate the feed. Read-only live API and SQLite checks showed that Nexus and the five original input sources contained no saved items, with the browsing table absent. The ingester only copied existing records, swallowed source failures, and had no connection to the agents' intelligence outputs.

The same database contained 35 debates, 134 reflections, and 450 agent memories at inspection time. Those counts are not quality or verification claims. They established that useful internal source material existed outside the feed.

Vaughn clarified that topics should evolve from agents' discussions and thought processes, with optional personal suggestions rather than a fixed list. Initial interests supplied: AI, local models, and Fraynix development. The implementation leaves focus optional and does not hardcode those interests into the ranking.

## Resulting behavior

- A sixth **Agent insights** source reads completed debates, nonempty reflection insights, and reviewed memories. No agent engines are imported or started by this collector. Each item carries source table, record ID, kind, participants where available, and an explicit `agent_generated` provenance label. Reviewed memory does not become independently verified external fact.
- Opening the panel syncs saved records and refreshes them every 30 seconds while open. This is local synchronization; it does not launch new research, debates, trend scans, or external browsing. Existing fleet tools and workflow nodes retain their API contracts; fleet recommendations now accept optional focus.
- Sources shows all six inputs, including empty and unavailable ones, plus navigation to the relevant tools. Missing tables and malformed web records have distinct diagnostics rather than silently appearing as a successful zero-item import.
- Numeric browsing actionability and zero trend scores are preserved. Only classified browsing visits qualify. Web records can use retained text when no summary exists. Unsafe URL protocols are excluded from rendered links and thumbnails.
- Sync updates changed records, avoids unchanged duplicates, and preserves handled state. Agent insights show recently surfaced material first. Recommendations reserve candidates for recent agent thinking so older high-scoring items cannot permanently lock the candidate pool.
- Recommendations receive current agent discussion context, real pending item IDs, and optional user guidance. Unknown IDs, invented titles, duplicate IDs, and unsupported action names are rejected or replaced with the saved item's actual identity/title. The optional focus field persists in browser storage and can be left blank.
- HTTP and model failures are shown as errors. A failed initial feed load no longer presents a false empty-feed diagnosis. The handled buttons explicitly record an action already taken; they do not claim to launch commerce, publish content, or run a pipeline.

The existing trend scanner remains a separate subsystem. The commit description "trend detection" in `eb60df0` should not be read as adding a new external discovery or verification engine in this change.

## Changed integration points

| Surface | Role |
| --- | --- |
| `server/intelligence/content-nexus-agents.js` | Read existing intelligence outputs with traceable provenance |
| `server/intelligence/content-nexus.js` | Agent ingestion, source diagnostics, deduplicated updates, ranking candidates and grounded recommendations |
| `server/intelligence/content-nexus-routes.js` | Source details, ingestion outcomes, focus input and request validation |
| `server/fleet/tools.js` | Document the agent source and expose optional recommendation focus to agents |
| `client/src/panels/ContentNexusPanel.jsx` | Live sync, sources/setup, provenance, optional focus, loading/errors and honest action labels |
| `client/src/nexus/DetailDrawer.jsx`, `client/src/App.jsx` | Navigation from a source card to its existing panel |

No schema migration or source-history deletion is required. New source/type values use the existing Nexus table. The original source tables are read, never rewritten by ingestion.

## Validation and practical limits

1. `node --test test/content-nexus.test.js`: **11/11 pass** against in-memory SQLite, using the source modules' actual table DDL. Covers all six sources, unavailable tables, repeat ingestion, updates preserving handled state, classification/score contracts, malformed records, dynamic agent inputs, recommendation identity validation, and HTTP routes.
2. `node scripts/check-content-nexus.mjs`: **9/9 browser checks**, zero uncaught browser errors. Uses actual routes and the bundled React panel with an in-memory fixture DB and deterministic model responses. Checks automatic sync, agent filtering/provenance, source navigation, optional focus, visible HTTP failure, empty setup guidance, and narrow-layout overflow. [UI evidence](../reviews/2026-11-05-content-nexus-ui-evidence.json), [populated fixture screenshot](../reviews/2026-11-05-content-nexus-feed.png), [empty fixture screenshot](../reviews/2026-11-05-content-nexus-empty.png).
3. A SQLite online backup was made from a read-only connection to the running database. All subsequent ingestion writes occurred **only in that temporary snapshot**, not the live DB. The new collector surfaced **20 genuine agent items from 175 eligible records**. Repeating sync added **0** duplicates. The unavailable browsing source remained visible as such. [Snapshot evidence and source hashes](../reviews/2026-11-05-content-nexus-snapshot-evidence.json).
4. Production client build and syntax checks pass. The Vite bundle-size warning remains; this change does not solve global bundle splitting.
5. The broader continuity/inheritance regression run was **22/23** when combined with the original ten Nexus tests. Its sole failure is the previously documented healthy-ledger fixture using `.verified` instead of the real `.valid` contract. That unrelated failure was not changed or concealed. With the added Nexus recency case the focused Nexus suite remains 11/11; this is not a claim that the entire repository suite is green.
6. A live Ollama `/api/tags` request timed out at five seconds. Recommendation request construction and output validation are tested with fixture model responses. Successful live model generation and quality are **not** claimed.

The live backend still had its earlier process and API loaded at the final check. The backend runs in another session's terminal, which was not exposed as a controllable terminal window. No forced process termination, debugger injection, database replacement, raw live DB copying, or data repair was used to apply this feature.

## Apply and review on the next machine

Use a normal graceful shutdown in the terminal that owns the backend, wait for it to exit, then run `npm run server` with the existing data directory. Vite can deliver the client changes through HMR, or use the normal production build/start flow. **Do not launch a second server against the same live data directory.** The remaining application step requires control of the owning terminal.

After restart, open Content Nexus. The panel should sync local source material and show Agent insights without requiring a fixed topic list. Check Sources for unavailable inputs. In Recommendations, enter `AI, local models, Fraynix development` as optional guidance if desired, or leave focus blank to follow the agents' evolving discussions. Generate recommendations once the local model is responsive.

Independent reviewer: inspect provenance and the pending-item restrictions; confirm that recent discussions enter the recommendation candidate pool; test HTTP errors as distinct from empty data; verify repeated updates preserve handled state; and verify real runtime behavior after the normal restart. Do not call fixture screenshots live-data proof or call the snapshot run a production deployment. Tag: `handoff/content-nexus-agent-feed-2026-11-05`.
