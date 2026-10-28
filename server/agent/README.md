# Local agent runtime

`createAgentService({ db, workspace, ollamaUrl, fetchImpl = fetch, onEvent,
extraTools = [], resolveAttachments, cloud, codeExecutor })` is a synchronous factory. `db` is an
open `better-sqlite3` connection. Tests also exercise the compatible synchronous
`node:sqlite` API; the runtime does not import or depend on that experimental API.
The factory creates only its own `agent_*` tables. Do not create two live services
on one database: initialization marks every unfinished previous run interrupted.

The returned methods are:

- `await capabilities()`: local Ollama inventory and explicit model metadata,
  tools and default budgets. Inventory is cached 30 seconds (5 seconds after an
  inventory error), metadata lookups have concurrency 3 and a shared 10-second
  deadline. An unavailable capability remains unknown with a `capabilityError`;
  it is never invented from a model's name.
- `await start({ requestId?, conversationId?, goal, model, budget?, attachments?, provider?, allowCloud? })`:
  persists a run and returns its initial record, then executes it in a background
  queue. Reusing a request ID returns the same run if normalized input matches;
  changed input throws `AgentError` with `code: 'idempotency_conflict'`. Omitted
  request ID is random; omitted conversation ID defaults to the request ID.
- `get(id)`: run record or `null`; `list()`: most recent 100 runs.
- `events(id, afterSequence = 0)`: ordered durable events after that sequence,
  at most 1,000. Reconnect using the last received sequence.
- `cancel(id)`: idempotent cancellation, aborting provider/tool waits.
- `approve(id, { approvalId, approved })`: decides exactly the pending persisted
  tool request. Unknown/used/wrong-run approval IDs and extra decision fields
  fail. Rejection cancels the run. Approved arguments are immutable and hashed;
  approval is consumed once immediately before execution.

Runs expose `id`, `runId`, `requestId`, `conversationId`, `goal`, `model`, `provider`, `allowCloud`,
`budget`, attachment IDs, `status`, `output`, `error`, actual `usage`, timestamps,
and `approval`/`pendingApproval` (the same pending request or `null`). Statuses
are `queued`, `running`, `awaiting_approval`, `completed`, `failed`, `cancelled`.
Methods throw errors for invalid input, unknown run IDs in mutations, invalid
approvals, and configuration errors; failed background work is reported durably.

## Events and completed requests

Each event is `{ runId, sequence, type, data, createdAt }`. `onEvent(event)` is
an optional notification sink; failure to deliver does not lose persisted data.
For a read followed by an answer, events include:

```json
{"type":"status","data":{"status":"queued"}}
{"type":"status","data":{"status":"running"}}
{"type":"usage","data":{"inputTokens":100,"outputTokens":10,"totalTokens":110,"costUsd":0,"provider":"ollama","actual":true}}
{"type":"tool_started","data":{"name":"workspace.read","callId":"...","arguments":{"path":"notes.txt"}}}
{"type":"tool_result","data":{"name":"workspace.read","callId":"...","result":{"path":"notes.txt","sha256":"...","content":"..."}}}
{"type":"usage","data":{"inputTokens":220,"outputTokens":35,"totalTokens":255,"costUsd":0,"provider":"ollama","actual":true}}
{"type":"text_delta","data":{"text":"The answer based on the file."}}
{"type":"completed","data":{"output":"The answer based on the file."}}
```

Usage fields are cumulative actual Ollama counts, with additional conservative
input-estimate fields. `text_delta` is an actual completed Ollama response chunk;
the implementation uses `stream:false`, so this is not token streaming. A write
adds `approval_required` with `{ approvalId, callId, name, arguments, preview }`
before `tool_started`. Terminal failures use `{ error, code }`; cancellation
uses `{ reason }`. Tool failures are bounded `{ ok:false, error, code }` results,
so the model can report a limitation instead of claiming success.

`context_compacted` records removal of old completed messages from model context:
`removedHistoryMessages`, `remainingHistoryMessages`, `totalRemovedHistoryMessages`,
`historyMessagesAtStart`, before/after estimates and the unchanged input limit.
Its `preservedCurrentGoal`, `preservedCurrentToolContext` and
`preservedNativeCallIds` flags describe the protected current-run portion. This
does not delete the durable conversation or refund already consumed usage.

## Budgets

All optional budget fields have bounded numeric ranges. Defaults:

| Field | Default | Meaning |
|---|---:|---|
| `maxSteps` | 8 | Model rounds; a tool round needs a subsequent interpretation round |
| `maxToolCalls` | 12 | Total tool calls; at most eight per model response |
| `maxInputTokens` | 16384 | Per-call context budget and Ollama `num_ctx`; explicit lower limits remain honored |
| `maxOutputTokens` | 2048 | Cumulative actual generated tokens, including tool arguments |
| `maxTotalTokens` | 24000 | Cumulative actual prompt plus generated tokens across rounds |
| `maxDurationMs` | 180000 | Includes queueing, model calls, tool calls and approval wait |
| `maxToolResultChars` | 12000 | Serialized JSON result bound |
| `maxOutputChars` | 32000 | User-visible cumulative answer bound |
| `maxCostUsd` | 0 | Per-run API budget; optional cloud requires explicit positive value |

Before each call, UTF-8 byte counts plus protocol/schema overhead conservatively
estimate ordinary text tokens. Before **every model round**, old completed
conversation messages may be removed from the loaded history prefix, oldest
pairs first, as current tool results or enabled definitions grow. Each removal
emits a durable `context_compacted` event. The original current goal, all current
assistant/tool messages, native call IDs and active-tool ordering are preserved.
If those protected items alone exceed the input limit, the run still fails
`budget_context`; compaction does not shrink current results or enlarge any
budget. Image estimates are explicitly model-dependent: 4096 plus decoded
kilobytes per image. Actual input/output counts must be present in the response;
missing counts fail the run. Actual limits are checked before tool side effects
or displaying the reply, and no further requests are made after exceeding them.
A local provider can still produce one over-budget response before its actual
usage is known; provider options are limits requested from Ollama, not a proof of
tokenization. `costUsd:0` describes the local API, not electricity/hardware costs.

## Built-in tools and execution boundaries

`workspace.list/read/search`, `memory.search/remember`, `workspace.write`, and
`code.run` are real tools. Memory is scoped by conversation. Reads/searches are
bounded UTF-8 operations. Workspace paths must be relative, contain no traversal,
secret/key/credential components, symlinks, junctions, hard-linked files, Windows
device names or alternate data streams, and remain within the configured root
after realpath. Writes require an existing parent and either `createOnly:true`
or an exact SHA-256 `expectedHash`; the precondition is rechecked after approval.
Approved writes can replace the full file, so UI previews must show arguments.

Node filesystem checks reduce accidental escape and reject ordinary link attacks;
they are not an OS sandbox or an atomic defense against an adversary racing
directory replacement. Use an isolated workspace whose parent permissions are
controlled, and an OS sandbox if hostile concurrent filesystem activity matters.

Code execution is selected by server configuration, never a model argument or
run request. Supplying the following trusted executor enables the Docker seam:

```js
codeExecutor: {
  kind: 'docker',
  health: async () => ({ available: true, kind: 'docker', engine: 'docker', /* safe health facts */ }),
  run: async (args, { signal }) => ({ /* actual execution and cleanup receipt */ })
}
```

Only exact `kind:'docker'` objects with `health`/`run` functions are accepted.
The host adapter must enforce Linux-container isolation, no network, no host
mounts, immutable images, resource/deadline/output limits and cleanup. In this
mode `code.run` can execute unattended within run budgets. The model system
instruction describes that boundary; workspace writes still require exact human
approval and cannot be performed through a mounted host workspace.

The service checks health before each execution; the executor must also perform
its own fresh preflight. Unavailable health, launch errors, invalid receipts or
cleanup failure stop the action without a host fallback. A receipt is accepted
only with `sandboxed:true`, `engine:'docker'`, `isolation:'docker-linux'`,
`network:false`, `hostMounts:false`, `cleanup.removed:true`, boolean `ok`, and
string `stdout`/`stderr`. This is a trusted adapter contract, not an inference
from stdout claiming isolation. Core tests mock this seam; actual Docker image,
network/mount denial and cleanup checks belong to the adapter's integration tests.

For backward compatibility, omitting `codeExecutor` retains the approved host
implementation. The host app should choose this mode only through explicit
configuration; Docker failures must never select it automatically. This mode
invokes Node or Python directly with no shell, a reduced environment, workspace
working directory, a 15-second maximum deadline and 32-KiB output bound.
**Approved host code has the user's file/network permissions** and can bypass
file-tool policies. Cancellation kills its direct process; descendants may outlive
it. Its preview and receipt identify `mode:'host'` and `sandboxed:false`.

### Code readiness and durable execution receipts

`capabilities.codeExecution` contains `mode:'docker'|'host'`,
`sandboxedConfigured`, `approvalRequired`, `available`, `sandboxed`, and
`checkedAt`. Docker health may additionally expose allowlisted `kind`, `engine`,
`isolation`, `reason`, `engineVersion`, `languages`, `images`, and numeric
`limits:{timeoutMs,maxOutputBytes,memoryBytes,pids,maxConcurrent}`. Its static
`policy:{network:false,hostMounts:false}` describes the configured boundary.
Arbitrary adapter properties, credentials and exception text are not exposed.

The top-level `sandboxed` flag and `codeExecution.sandboxed` are true only when
Docker health currently reports verified availability. Configuration alone sets
only `sandboxedConfigured:true`. This health snapshot covers code execution,
not every host file or memory tool, and is refreshed separately from the model
inventory cache. The `code.run` tool's `execution` metadata matches this snapshot;
other tools explicitly report their workspace/memory/tool mode and approval need.

Historical actions must use their own metadata, not today's capabilities. Host
approval previews include `preview.execution`. Actual code `tool_result` events
include `data.execution` and `data.receipt` (receipt facts excluding output), and
normal-sized results also contain `result.execution`. Docker facts include
network/mount policy, image, language, limits, termination reason and cleanup.
If output is truncated, the bounded result preserves `ok`, `sandboxed`, `engine`,
`exitCode`, and a preview; full receipt metadata remains outside the truncated
text in the durable event. Error receipts retain their execution-mode snapshot
and set `sandboxed:false` because no verified successful receipt was returned.

Ollama HTTP endpoints are restricted to explicit loopback hosts, redirects are
rejected, JSON responses are bounded, and automatic cloud fallback is absent.
Cloud-tagged names and explicit `remote_host`/`remote_model` metadata are blocked
by normalization, inventory, inspection and inference independently. Inference
re-inspects a model before each request so an alias retargeted after inventory
caching cannot silently become a remote call. Inventory preserves remote metadata
and marks blocked entries `allowed:false,cloud:true`; these are not selectable
through the local provider even if optional OpenAI cloud is enabled. This relies
on an honest Ollama server's metadata; a loopback proxy or hostile server can lie,
so network egress isolation is needed for a stronger local-only guarantee. Normal chat
works on completion models with no tool capability. Native tool invocation is
enabled only when `/api/show` explicitly advertises `tools`. Image input requires
explicit `vision`. Missing/unsupported capabilities produce honest errors.

Tool/attachment output is labeled untrusted data in model context; these labels
do not prove immunity to prompt injection. Exact approval, narrow tools, path
checks, budgets, and host permissions remain the enforcement boundaries.

## Additional tools

Register descriptors before creating the service:

```js
{
  name: 'artifact.inspect',
  group: 'documents', // optional; omit for tools always advertised
  description: 'Read an uploaded artifact as untrusted data.',
  parameters: {
    type: 'object', properties: { id: { type: 'string', maxLength: 128 } },
    required: ['id'], additionalProperties: false
  },
  approvalRequired: false,
  // Optional: produce a reviewable preview before asking for approval.
  prepare: async ({ args, signal, workspace, workspacePolicy, run }) => ({ id: args.id }),
  execute: async ({ args, signal, workspace, workspacePolicy, run, approvalId }) => ({ /* JSON data */ })
}
```

Names are unique and cannot override built-ins. Schemas support fixed objects,
arrays, strings, booleans, integers/numbers, required fields, enum, string lengths
and pattern, numeric bounds, and array lengths. Unsupported constraints fail at
registration; unknown argument properties fail before any tools in that model
round execute. Results must serialize to JSON and are bounded automatically.
Extra tools must honor `signal`, bound their own I/O, and gate external/network
side effects appropriately with `approvalRequired:true`. The service can stop
waiting for an uncooperative tool, but cannot revoke its OS permissions or undo
its side effects. No `web.fetch` tool is built in.

### Optional tool-group discovery

Descriptors can supply a short lowercase `group` identifier. Ungrouped built-in
and custom tools are always advertised to tool-capable models. When any group
is registered, the service also advertises the reserved native tool
`tools.enable({group})`, whose enum lists existing groups only. With no groups,
that tool is absent. Custom tools cannot override it or any built-in name.

Initial activation uses only the original request:

- `documents` activates when attachment IDs are present.
- `web` activates for an HTTP(S) URL or explicit web/internet/research/browse terms.
- `transport` activates for RGBA, XYZW, transport, spectrum, frequency or packet terms.

Other groups can be loaded deliberately with `tools.enable`. It returns
`{group,enabled:true,tools:[names],alreadyEnabled}` rather than duplicating full
schemas in the result. Newly activated definitions append for subsequent model
rounds and remain visible for that run only. This append-only ordering preserves
existing native aliases and call history in the Responses adapter. Activation
does not inherit from another run's assistant messages, tool output or previews.

Discovery selects context; it is **not a permission boundary**. Actual calls still
validate against the full registered tool map, whether or not their definitions
were advertised. Existing exact approvals, attachment/run scope, cancellation,
schema checks and all budgets remain in force. Discovery itself consumes an
ordinary tool call and model round; expanded definitions must fit the remaining
context/token budgets and do not silently enlarge them. Schema-invalid group
names receive the same bounded validation feedback as other known tools and
perform no activation or side effects.

Each model round and its conservative input estimate use the current active
definitions. The attachment resolver's preview allowance uses only the initial
selected definitions, preserving room that inactive schemas would consume.
Capabilities continue to list the full registry, with `group:null` for ungrouped
tools. `toolDiscovery` reports `enabled`, `enableTool`, `permissionBoundary:false`,
group/name lists and activation guidance. System guidance tells the model how to
enable groups, cite exact web source URLs and provided line references, and avoid
claiming complete reading from excerpts/search matches.

Known, correctly framed tool calls receive bounded validation feedback rather
than argument coercion. The entire response is validated before any execution
or approval preparation. If any call is schema-invalid, every call in that round
returns a durable failure: invalid calls include the expected schema; otherwise
valid siblings report `round_validation_failed`. The first invalid round is
retryable; a second invalid round ends the run. These attempted calls, corrective
model rounds and actual usage consume the existing budgets. Rejected rounds emit
no `tool_started` or `approval_required` events and perform no tool side effects.
Malformed JSON/framing, oversized argument payloads and unknown tools remain
fatal. This repair mechanism cannot verify the truthfulness of a final answer.

## Attachments

With no resolver, nonempty attachment input fails immediately. With a resolver,
`attachments` contains at most four short artifact IDs, not paths or base64:

```js
resolveAttachments: async (ids, { run, signal, maxTextBytes }) => ({
  images: ['CANONICAL_BASE64_BYTES'], // optional, four images, 4 MiB each
  text: 'extracted reference text'    // optional, <=32000 characters
})
```

`maxTextBytes` is a 0–24000 aggregate excerpt allowance after SYSTEM, goal,
eligible tool definitions and 512 bytes of overhead. The resolver should allocate
that budget across text assets, preserve artifact IDs and expose a chunk-reading
tool for omitted content. It must not silently drop the user's goal.

The host adapter must validate asset ownership, MIME type, real image format,
extraction behavior and storage paths. The service bounds canonical base64 and
decoded bytes (16 MiB total), appends extracted text under an untrusted-data
boundary, and places images only on the current user message. Only IDs are
persisted in the request. Images/extracted content are not inserted into later
conversation turns. Larger text assets should use a separate chunk-reading tool;
this hook does not imply an OCR or audio/video capability. Image+tool models may
need `maxInputTokens:16384` or more because of conservative context estimates.

## Provider extension seam and tests

`provider.js` implements `id`, `local`, `listModels(signal)`,
`inspectModel(model, signal)`, and `chat({model,messages,tools,maxOutputTokens,
maxInputTokens,signal}) -> {message,usage,finishReason}`. Future providers must
return actual token/cost usage and advertise capabilities. The optional adapter
below implements OpenAI Responses only; arbitrary provider URLs/registration are
not exposed to requests.

## Optional budget-capped OpenAI Responses

Disabled by default. Configuration is server-owned, never accepted in a run body:

```js
cloud: {
  enabled: true,
  apiKey: serverSuppliedKey, // no automatic environment/key lookup in this module
  maxRunCostUsd: 1,         // optional server ceiling, default 1 USD
  models: {
    'EXACT_MODEL_NAME': {
      inputUsdPerMillion: 1,  // EXAMPLE ONLY; set verified current upper-bound rates
      outputUsdPerMillion: 2, // EXAMPLE ONLY; not a model price recommendation
      tools: true,           // explicit server capability settings, default false
      vision: false
    }
  }
}
```

The host must maintain correct upper-bound rates for the chosen model/service
tier. Missing, zero, unknown, or invalid pricing disables cloud. Misconfiguration
does not stop the local provider. Keys are never returned in capabilities or run
records. No model listing or other cloud call occurs just to render capabilities.

`capabilities.models` appends configured entries with this shape:

```js
{
  name: 'EXACT_MODEL_NAME', provider: 'openai', cloud: true, local: false,
  allowed: true, tools: true, vision: false,
  capabilities: ['completion', 'tools'],
  rates: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
  pricingSource: 'server_configuration'
}
```

Select by **provider plus name**; model names can overlap. Top-level capabilities
include `cloudEnabled`, `localOnly`, `cloud:{enabled,maxRunCostUsd,error?}` and
`providers:[{id:'ollama',local:true,available},{id:'openai',cloud:true,available}]`.
Cloud selection must send `provider:'openai',allowCloud:true` plus a positive
`budget.maxCostUsd` at or below the server ceiling. Explicit consent permits
transmitting this run's goal, selected attachments, conversation history, tool
schemas and subsequent tool results to OpenAI. Default requests use Ollama;
inference failures never trigger a provider switch.

Before generation, the adapter calls the Responses input-token counting endpoint,
checks exact input count against the context budget, caps generation by remaining
output/cumulative tokens and affordable cost (minimum 16 output tokens), and
persists a worst-case reservation through the service before requesting a
response. Actual cost uses all reported input/output tokens, including reasoning,
at configured full rates; cached-input discounts are deliberately not assumed.
After cancellation, transport errors or missing usage, the reservation remains
with `costStatus:'uncertain'`. There are no retries or additional model calls.
This is a per-run ceiling, not a daily/account-wide budget; configure provider
account limits separately for aggregate controls. Uncertain invoices cannot be
reconciled automatically by this runtime.

The adapter uses a fixed `https://api.openai.com/v1` origin, bounded non-streaming
JSON, rejected redirects, `store:false`, disabled automatic input truncation,
function tools only, and preserved call IDs/reasoning items across tool rounds.
No paid built-in tools, remote MCP, hosted code interpreter, or background mode
are enabled. Configured capabilities remain the server operator's responsibility.
Cloud images require valid PNG/JPEG/WebP signatures and explicit configured vision.

Implementation references (official OpenAI documentation, consulted 2026-10-26):
[function calling](https://developers.openai.com/api/docs/guides/function-calling),
[token counting](https://developers.openai.com/api/docs/guides/token-counting),
and [Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

Mapping review confirmed that the [input-token-count endpoint](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count)
accepts the shared `model`, `input`, `instructions`, `tools` and
`parallel_tool_calls` fields used here. Count requests omit generation-only
settings. Persisted assistant turns use valid EasyInputMessage strings; native
response output/reasoning items are passed back intact, with original call IDs.
This was checked against current primary documentation and mocked round trips;
no live cloud inference or credentials were used for validation.

Measured with the current tagged extensions and Docker-mode descriptions, the
full registry contains 19 definitions and 9,036 UTF-8 schema bytes. Discovery
changes the initial context as follows (short synthetic goals, mocked inference
and health; no network or Docker execution):

| Initial request | Definitions | Schema bytes | Conservative input estimate |
|---|---:|---:|---:|
| Ordinary workspace question | 8 | 3,562 | 5,506 |
| Web research URL | 13 | 6,197 | 8,155 |
| One text attachment | 11 | 5,244 | 7,325 |
| RGBA/XYZW transport question | 11 | 4,719 | 6,669 |

The ordinary request advertises about 61% fewer schema bytes than the full
registry. The default context capacity is 16384; requests may explicitly choose
smaller limits, while several images may need 32768. This changes context capacity
only: cumulative token, output, duration, step, tool-call and monetary defaults
remain unchanged. Estimates deliberately exceed ordinary token counts, and tool
results/history also consume the remaining window.

Run `node --test test/agent*.test.js`. Tests use temporary directories/databases,
mock model HTTP responses, actual bounded Node subprocesses and no model weights,
paid requests or live services.
