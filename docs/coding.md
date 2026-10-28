# Reading and changing source code

The optional `coding` group adds four native tools. Coding/refactor/debug/repo
goals advertise them immediately; other runs can use `tools.enable`. Loading a
group changes context only. File policy, approval and token limits still apply.

| Tool | Purpose | Bounds |
|---|---|---|
| `workspace.map` | Directory tree without source execution or parsing | Depth 0–6, up to 300 files, 100 directories and 1,200 examined entries |
| `workspace.readMany` | Up to eight exact files/ranges in one model round | Default 12,000 serialized result characters/UTF-8 bytes; requested maximum 20,000, also clamped to the run's result budget |
| `workspace.edit` | Small literal replacements in one existing file | 1–8 unique disjoint replacements, exact original hash, complete approval preview, final file at most 256 KiB |
| `workspace.patch` | One exact approval for related edits in 2–8 existing files | Same per-file literal/hash limits, combined full preview at most 24,000 serialized characters, durable per-file progress |

Navigation reuses the workspace policy: no traversal, symlinks/junctions,
hard-linked files, known secret paths or binary text reads. Mapping skips common
dependency, build and virtual-environment directories. It returns explicit
omissions and known-only counts, never a complete filesystem inventory. The
underlying directory reader may enumerate/sort more entries than it returns.
Names and source bodies remain untrusted data, not instructions or permission.

Batch reads retain full raw-file SHA-256/byte counts even when only a range is
returned. Excerpts preserve UTF-8 BOMs and original CRLF/LF/CR terminators. Metadata
states total lines, requested/returned ranges, truncation and partial last lines.
Line counting preserves a final empty line after a terminator. Metadata that
cannot fit fails explicitly instead of losing all hashes to generic truncation.
The tools do not provide AST symbols, language-server analysis or imports.

## Exact edits

Read the relevant source and complete hash first. `workspace.readMany` returns
exact text; for ordinary `workspace.read`, request `preserveLineEndings:true`.
Its default display normalizes terminators. Source reading now retains a BOM
instead of silently discarding it; searches and reads share CR-aware line numbers.

Propose the smallest unique contextual fragments:

```json
{
  "path": "src/settings.mjs",
  "expectedHash": "<complete SHA-256 from the read>",
  "edits": [{
    "oldText": "export const multiplier = 2;",
    "newText": "export const multiplier = 3;"
  }]
}
```

Each `oldText` must occur exactly once in the **original** file. All replacements
refer to that same original, so a new fragment cannot become another edit's
needle. Reversed input order gives the same result. Adjacent matches and empty
`newText` deletions are supported. Empty matches, overlap/self-overlap, no-ops,
split CRLF boundaries, malformed Unicode and NUL are rejected. No regex or code
is evaluated. Untouched bytes, BOM and line endings are preserved.

The approval contains every removed/added fragment, original/proposed line and
UTF-16 column anchors, zero-based original UTF-16 offsets, full before/after hashes
and UTF-8 byte counts. A serialized preview over 24,000 characters fails before an
approval is created; hunks are never silently truncated. The UI marks exact line
endings, TAB, BOM and invisible control/bidi characters. These markers are display
labels and are not inserted into the file. It labels partial-line fragments as
fragments and retains exact raw arguments/preview JSON.

Known preparation errors can return one bounded correction opportunity. No write
or approval from that invalid edit has happened; the model may read more context
and propose a fresh exact hunk. A second preparation failure stops the run. All
attempted calls and model rounds still consume their normal budgets.

## Effects, cancellation and recovery

Execution requires the consumed approval for the exact tool/arguments and the
complete preview. It rereads the original hash and recomputes the entire proposed
result before writing. Cooperative writers in this process serialize per canonical
file, including across policy instances. Other programs can still race these
checks: this is not an atomic filesystem compare-and-swap or OS sandbox.

The independent effect journal records prepared state and dispatch intent before
the first write. After writing, truncating and syncing, the tool reads back the
actual file and compares its full hash. Only matching observed bytes receive a
verified receipt. A partial write, failed sync, changed readback or interruption
after dispatch remains **unknown**. Unknown results stop the run; they are never
automatically retried or rolled back.

Cancellation before dispatch prevents the edit. Once writing begins, verification
and its durable receipt finish even if the source run was cancelled. The run stays
cancelled; a late receipt does not revive it. Receipts survive small model-result
limits and can be replayed through run inspection. Reusing the same approved
operation returns its recorded result rather than writing again. On restart,
prepared work becomes not dispatched and in-flight dispatch becomes unknown;
only missing acknowledgements are retried.

This does not create a crash-atomic transaction, Git commit, undo history or
sandboxed repository test runner. `workspace.write` remains the
full-content create/replace tool; its older bounded preview is separate from the
new complete literal-hunk approval. Code execution retains the configured Docker
requirement and stays unavailable until that sandbox is live-verified.

## Multi-file patches

Use `workspace.patch` when one reviewed change spans 2–8 existing files:

```json
{
  "files": [
    {"path":"src/settings.mjs","expectedHash":"<settings SHA-256>",
     "edits":[{"oldText":"multiplier = 2","newText":"multiplier = 3"}]},
    {"path":"src/calculate.mjs","expectedHash":"<calculate SHA-256>",
     "edits":[{"oldText":"label: 'doubled'","newText":"label: 'tripled'"}]}
  ]
}
```

All hashes and literal matches are checked before an approval is created. The
combined preview contains every file's full hunks, byte counts and hashes within
the same 24,000-character ceiling. Duplicate canonical files, including Windows
case/separator aliases, are rejected. No hunk is silently omitted or truncated.
One consumed approval binds the exact ordered file set and arguments; it does not
authorize later repairs, new files, deletions or another patch.

Execution acquires all target write queues in a deterministic order shared with
single-file edits/writes, then revalidates identities and all approved plans before
the first write. A private lease cannot be forged, reused after completion or
applied to another path. This is cooperation within one process, not an OS lock or
an atomic filesystem transaction. External applications can still change files.

The SQLite journal stages the parent and every child in one database transaction.
Actual file writes remain sequential and in place. Each child records dispatch
intent before writing and exact independent readback afterward. Progress and final
receipts share a batch effect ID and list every file's verified, pending, unknown
or not-dispatched outcome. Receipt callbacks receive frozen independent snapshots;
neither callbacks nor later UI event consumers can change stored outcomes or the
runtime's stop decision. Cached terminal receipts are checked against journal
evidence before reuse.

Cancellation prevents the next dispatch; it cannot undo a started write. A started
file is still read back and reported after source cancellation. A later-file
conflict leaves earlier verified changes in place. A known partial or unknown
batch stops sibling effects and model continuation without automatic retry or
rollback. Inspection identifies what actually happened; any repair needs a fresh
request and exact approval against current bytes. After restart, prepared children
are not dispatched, dispatching children are unknown, and verified children retain
their observed evidence. Recovery never opens or rewrites target files; only
missing acknowledgement of the latest receipt is retried.

The production SQLite owner explicitly uses WAL with `synchronous=FULL`. Edit and
patch tools check for FULL or EXTRA before staging and dispatch intent; a weaker
setting refuses the next write. This matters because WAL NORMAL may lose a
committed intent on power loss while a separately synced file change survives.
The health endpoint reports the actual owner connection's numeric sync setting
(2 means FULL). Tests cover configuration, cancellation and process recovery,
not physical power interruption or dishonest storage hardware. See
[SQLite synchronous policy](https://www.sqlite.org/pragma.html#pragma_synchronous).

The isolated local-model fixture used `workspace.readMany` and one approved patch
to change a multiplier and corresponding label in two files. An ambiguous initial
literal was rejected before any approval or write; the model corrected it within
the bounded preparation policy. All final source bytes, BOM/CRLF and a random
reference were compared independently, then the known trusted fixture function
returned `{value:12,label:'tripled'}` for input 4. The run used four local model
requests and 9976 tokens, with no agent code execution or paid API calls. This is
one development fixture, not a general coding-success or token-savings benchmark.

## Measurement

A deterministic 77,033-byte source fixture required 79,151 serialized argument
bytes for full replacement versus 197 for its literal edit, a 99.75% reduction in
**tool-argument bytes for that fixture**. The complete hunk approval was 822 bytes;
the original three coding descriptors cost 3,051 schema bytes. The later patch
parameter schema adds 839 UTF-8 bytes, plus its name/description/wire framing. This is not a
tokenizer change, a measured model-token saving, or a general success-rate claim.
Actual local-model receipts and failed attempts are retained separately.
