# Reasoning choices and explicit run limits

In the partner's Agent connection panel, open **Reasoning and run limits**. These
controls affect new interactive Agent runs. They are not saved as browser
preferences, copied to scheduled tasks, or applied to an already retained request.
Direct/Demo modes do not use them. Defaults remain conservative.

## Model reasoning

**Model default** omits an override. A local model may advertise boolean on/off
controls, named levels, or no usable controls. The dropdown comes from that
model's current normalized `/api/show` response. Boolean `false` is distinct from
the named string `"false"`; values retain their exact type, case and text.
Missing metadata does not prove a model has no reasoning. See the
[Ollama thinking contract](https://docs.ollama.com/capabilities/thinking).

An explicit choice is validated when work starts and against a fresh model
inspection immediately before every `/api/chat`, including later tool rounds.
Unsupported or revoked choices fail before generation rather than silently using
the model default. Refresh controls or choose Model default deliberately. Fresh
inspection reduces alias races; it is not an atomic lock against another local
program changing a model between inspection and inference.

These overrides currently apply only to local Ollama. Cloud requests reject an
explicit reasoning override; their existing opt-in, priced allowlist and USD
ceiling still apply. Scheduled payloads keep model-default reasoning and their
own separately approved budgets. A scheduled receipt with an unexpected override
cannot attach to a frozen occurrence.

Run records retain the requested override and exact limits. They do not establish
the model's effective reasoning quality or depth. Lower settings can reduce
generated reasoning while increasing mistakes, retries or total input usage.
No setting is automatically chosen because a task appears easy or expensive.

## Limit profiles

| Profile | Input per round | Cumulative output | Cumulative input + output | Duration |
|---|---:|---:|---:|---:|
| Default, ordinary run | 16,384 | 2,048 | 24,000 | 180 seconds |
| Default with 3–4 images | 32,768 | 2,048 | 64,000 | 180 seconds |
| Default with desktop grant | 32,768 | 2,048 | 64,000 | 300 seconds |
| Extended, explicitly selected | 32,768 | 4,096 | 64,000 | 300 seconds |

Custom limits allow 1,024–32,768 input tokens, 1–8,192 cumulative output tokens,
1–200,000 cumulative total tokens and 100–600,000 milliseconds. All four values
are explicit integers. Custom/Extended replace these fields after modality
defaults; they do not change file permissions, approvals, tool/step limits or the
cloud USD ceiling. A larger ceiling is permission to spend more, not a promise
that a model or task will succeed. Small incompatible ceilings can fail before a
model request or later tool effect.

Input preflight deliberately counts serialized context bytes conservatively;
it can reject before the model's native token window is full. The input cap
includes prior context, current native tool calls/results and private reasoning
continuations. Output accounting keeps the complete provider `eval_count`,
including generated reasoning. It does not subtract hidden text. Duration includes
queueing and approval wait. No ceiling expands automatically, and failures never
trigger a paid fallback or automatic retry under a larger budget.

## Private tool-loop continuation

Reasoning-capable tool loops may need their previous assistant continuation. The
local adapter retains a bounded trace in a private WeakMap keyed by its own
normalized response, then consumes it once for the same local run. Only that
in-memory local assistant message receives it. It is excluded from enumerable
provider results, saved chat history, run/event records and direct-mode transfer.
Normal final answer content is still model-generated content; this field boundary
is not a semantic redactor for anything a model might say.

A continuation must be well-formed and fit 32,768 UTF-16 units and 65,536 UTF-8
bytes. Malformed/oversized tool continuation stops with actual reported usage
retained. Even a globally valid trace must fit the current run's input cap before
any returned tool prepares or executes. Answer-only traces are discarded rather
than treated as visible answers or needed continuations. Empty final content and
output-limit finishes remain explicit failures. See
[Ollama tool-loop examples](https://docs.ollama.com/capabilities/tool-calling).

The app does not persist raw traces. This is an application field/storage boundary,
not secure memory erasure or a guarantee about operating-system memory behavior.

## Recovery and evidence

The exact selected override and numeric limits enter the durable request hash.
Changing them under an existing request ID conflicts. Null/omitted thinking both
normalize to the previous default request shape, preserving existing hashes.
Boolean false is never omitted by a truthiness check.

After an uncertain creation response, recovery serializes only the stored original
request. Current model choices, refreshed metadata and edited controls cannot
rewrite that body. Stored run inspection reports its recorded settings. New-run
controls do not modify a past or currently running request.

Controlled provider/service tests cover typed identity, old hashes, cloud rejection,
fresh metadata changes, private continuation lifetime/storage, output accounting,
pre-effect context bounds and scheduled integrity. Frontend request/recovery and
actual React rendering tests are separate from live UI automation, which remains
stopped. Local-model fixture results and failures are retained separately and do
not establish a general reasoning-quality or cost advantage.
