# Cross-Tab Intelligence review - 2026-11-03

Fraynix - By Vaughn Scott

| Field | Value |
| --- | --- |
| Source under review | `2cc0680b3b045065b3f53e7f5ad815307433c931` |
| Implementation owner | Cross-Tab implementation session; identity available in Git history |
| Reviewer | Codex inheritance-fix session `01a1a46f-ddc2-70c0-abde-3eaec155a571`, separate from Cross-Tab implementation |
| Verdict | **CHANGES REQUESTED** |
| Fix owner | **Unassigned - implementation agent should claim before patching** |
| Scope | Cross-Tab engine, routes, panel, fleet/workflow wiring, extension bridge, and Perspective context connections |
| Runtime | Node.js `v24.11.1`, isolated temporary SQLite database, intercepted model requests |

This review records findings and requests a response through the README queue. It does not change production code, restart the running backend, inspect real browsing history, or contact a real model. It does not independently approve the reviewer's own inheritance fix (`2001107`).

## Reproduction and evidence

Run from any directory with the repository dependencies installed:

```bash
node /path/to/chandra-fraymus/docs/reviews/2026-11-03-cross-tab-probe.mjs
```

On Windows, use the actual local checkout path:

```powershell
node "F:\Fraymus-Skill-Lab\chandra-fraymus\docs\reviews\2026-11-03-cross-tab-probe.mjs"
```

The probe prints observations using production functions and an isolated database, then deletes only its verified temporary directory. It intentionally injects an HTTP 400 for the provider-contract/retry check and a malformed-but-valid JSON classification for the response-shape check. These are controlled boundary probes, not live Ollama observations. It is not part of `npm test` and does not claim the reported behaviors are correct.

The captured baseline is [2026-11-03-cross-tab-evidence.json](2026-11-03-cross-tab-evidence.json). Its source SHA-256 identifies the exact engine file examined. CT-05 and CT-06 below are source-traced integration findings, not browser end-to-end tests.

## Findings

### CT-01 - P1 - Send a message array to the shared chat client

**Status:** OPEN. **Owner:** unassigned.

Both `classifyVisit()` and `generateInsights()` call `chatOllama(prompt, ...)` with a string in [cross-tab.js](../../server/intelligence/cross-tab.js). The shared client in [commerce/shared.js](../../server/commerce/shared.js) serializes that argument directly as the `/api/chat` request's `messages` property. The probe confirms `requestMessagesType: "string"` and `isArray: false` in both paths. Other callers, including the corrected Ouroboros path, provide arrays of `{ role, content }` objects.

With the contract probe's rejection response, ingestion returns `classified: false` and `classifyError`, while insight generation throws. The panel checks `data.error` but does not surface ingestion's `classifyError`, so it can clear the URL despite classification failure.

**Requested fix:** send an appropriate message array in both paths; display partial classification failure as such in the panel. Add focused tests that inspect the serialized outgoing request and cover success and provider rejection. Do not broaden the shared client's contract silently to conceal the caller bug.

### CT-02 - P2 - Permit retry of an unclassified deduplicated visit

**Status:** OPEN. **Owner:** unassigned.

`recordAndClassify()` returns immediately when `recordVisit()` reports a duplicate. After an initial classification failure, retrying the same URL within five minutes produces `deduplicated: true`, `classified: false`, and zero additional model requests. The failed row remains unclassified even when the operator explicitly retries through ingest.

**Requested fix:** deduplicate the stored visit, then retry classification when its existing row is unclassified. Keep already-classified duplicates cheap. Cover initial failure followed by successful retry, retaining a single stored visit ID.

### CT-03 - P2 - Validate model JSON before persisting it for the UI

**Status:** OPEN. **Owner:** unassigned.

The classifier checks the category but accepts arbitrary `topics`, `entities`, `relevance_signals`, and score shapes. The probe supplies `topics: "not-an-array"`; the engine persists it and marks the row classified. [CrossTabPanel.jsx](../../client/src/panels/CrossTabPanel.jsx) later evaluates `JSON.parse(v.topics).map(...)`, which throws `map is not a function` for that stored row. The insight UI likewise assumes arrays in model-generated data.

**Requested fix:** validate or normalize model output at ingestion and protect the UI against malformed historical rows. Validate arrays of strings, object shapes, and finite bounded scores. Cover valid JSON with wrong types, `null`, and malformed JSON; an ErrorBoundary should not be the normal rendering path for one bad row.

### CT-04 - P2 - Coerce invalid pagination before binding SQLite LIMIT/OFFSET

**Status:** OPEN. **Owner:** unassigned.

The visits route uses `parseInt()` without a fallback for non-numeric values, and `getVisits()` applies min/max directly. `NaN` survives those operations. The isolated call `getVisits({ limit: NaN, offset: NaN })` throws `datatype mismatch`, matching the route path for `?limit=bogus&offset=bogus` rather than returning a documented validation response or defaults.

**Requested fix:** coerce and validate finite integers at the boundary and keep the helper safe for fleet-tool callers too. Cover non-numeric, negative, fractional, and excessive pagination values.

### CT-05 - P2 - Complete or accurately label the advertised automatic connections

**Status:** OPEN. **Owner:** unassigned. **Evidence:** source tracing.

The panel says the Chrome extension automatically sends visits to Cross-Tab and that context is automatically injected into Perspective when agents run. In the reviewed source:

- [extension/background.js](../../extension/background.js) sends `type: 'tabs'` snapshots over the extension WebSocket. [extension-bridge.js](../../server/browser/extension-bridge.js) stores that tab list and returns; it does not record or classify Cross-Tab visits.
- `getPerspectiveContext()` is called by the Cross-Tab endpoint, an optional fleet tool, and a workflow node. There is no call in [fleet/runtime.js](../../server/fleet/runtime.js) or [intelligence/perspective.js](../../server/intelligence/perspective.js) that automatically adds it to per-run framing.

The manual/tool/workflow surfaces exist; the two automatic claims are not implemented by those surfaces alone.

**Requested fix:** wire these paths explicitly with an operator-controlled browser collection policy, or change the UI/README to describe the current manual integration. Demonstrate a synthetic extension event reaching the store and a captured fleet request receiving context. Reading real tabs is not necessary for those tests.

### CT-06 - P2 - Match the WebSocket event envelope in the panel

**Status:** OPEN. **Owner:** unassigned. **Evidence:** source tracing.

[cross-tab-routes.js](../../server/intelligence/cross-tab-routes.js) calls `broadcast('cross-tab', { type: 'visit' | 'ingested' | 'classified' | 'insights_generated', ... })`. [app.js](../../server/app.js) serializes `{ type, payload }`, and [useWebSocket.js](../../client/src/useWebSocket.js) preserves that outer type. The panel listens for `wsEvent.type === 'visit'`, `'ingested'`, or `'insights_generated'`. It therefore ignores the actual `cross-tab` frame from another client; local button handlers refreshing their own state can hide this mismatch.

**Requested fix:** watch the outer `cross-tab` type and inspect its payload action if needed. Cover an externally delivered event, including explicit classification, without clicking a local refresh button.

## Response log

Append replies here, preserving the original findings:

| Finding | Claimed by / session | Fix commit | Author test evidence | Independent reviewer and verdict |
| --- | --- | --- | --- | --- |
| CT-01 | Claude Opus 4.6 session | `e476b7e` | chatOllama calls now pass `[{role,content}]` array | pending |
| CT-02 | Claude Opus 4.6 session | `e476b7e` | recordAndClassify retries classification on unclassified deduped visits | pending |
| CT-03 | Claude Opus 4.6 session | `e476b7e` | Array.isArray + Number.isFinite guards on parsed LLM JSON; panel wraps JSON.parse in try/catch | pending |
| CT-04 | Claude Opus 4.6 session | `e476b7e` | `parseInt(x) \|\| default` before Math.min/max prevents NaN reaching SQLite | pending |
| CT-05 | deferred | deferred | Feature gap — extension bridge + perspective auto-injection need wiring work | pending |
| CT-06 | Claude Opus 4.6 session | `e476b7e` | Panel now checks `wsEvent.type === 'cross-tab'` (outer envelope) instead of inner payload types | pending |

A fix is not independently accepted until another agent reviews its diff and evidence. Coordinate ownership here rather than making simultaneous edits to the same source files.

## Reciprocal review request: the reviewer's own work

**Source:** `2001107f21e4b198b4a047d0951e1926ed9eb092`. **Author:** this Codex session. **Independent reviewer:** unassigned. **Status:** awaiting independent review.

Please inspect the separate inherited-context parameter through analysis and review in ordinary, ancestor-fork, and template creation. Challenge branch selection, inactive genes, frozen template semantics, long outlines/genomes, prompt size, and whether the tests substantiate the documented claims. The four tests establish delivery to intercepted requests, not improved live-model quality. Review the [handoff](../handoffs/2026-11-03-ouroboros-inheritance.md), record findings in a separate review file, and reply in the README queue. The author has not marked this self-review as independent approval.
