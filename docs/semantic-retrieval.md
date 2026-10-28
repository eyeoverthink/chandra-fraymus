# Local semantic retrieval

The optional `semantic` tool group finds passages with related meaning in an
attached text file, extracted PDF, readable ZIP member or local WAV transcript.
It uses the already installed local `nomic-embed-text:latest` model through Ollama.
No cloud embeddings, model downloads, OCR or Docker are involved. If the model is
missing or its metadata is unsuitable, retrieval reports the failure.

`artifact.semanticStatus` inspects or initializes metadata for the exact source
scope without running an embedding inference. `artifact.semanticSearch` builds or
resumes the selected index, then embeds the query and ranks candidate passages by
cosine similarity. It defaults to at most 32 new chunks per call; callers can
explicitly choose 0–128. Zero queries only an already complete index. An incomplete
index returns progress and no ranked hits. Indexing does not mean the assistant
read the document or proved a passage true.

Each source window contains at most 1000 UTF-16 code units with 120 units of
overlap. Boundaries preserve surrogate pairs and CRLF. Whitespace-only windows
are omitted; all non-whitespace source characters remain covered. At most 1024
candidate windows are accepted. Explicitly select a PDF `page` or ZIP `entry` to
narrow larger documents. Results retain exact offsets and available page/member
references. Only sources attached to the current run may be accessed, even if an
index already exists from an earlier run.

Indexes are keyed by source and scope hashes, the exact local model digest,
document/query prefixes and chunk policy. Source vectors use checksummed float32
storage, with fixed dimensions and integrity verification on each read. A changed
source or model uses a separate index. Limits are 32 indexes and 64 MiB of vector
blobs; SQLite metadata, original uploads and extracted text consume additional
space. There is no automatic eviction. `artifact.semanticForget` requires approval
for the exact attached-source index and removes only derived cache rows; original
uploads and extracted text remain. A corrupt cache fails closed and may require
operator repair rather than automatic rebuilding.

Embedding requests reserve a conservative UTF-8 input estimate before dispatch.
Known actual `prompt_eval_count` adds to the run's input and total token counters;
`auxiliaryInputTokens` is a subset of input tokens, not another charge to add.
`reservedInputTokens` is an outstanding hold, separate from known actual usage.
Unknown dispatched usage retains its hold across cancellation and restart. A late
known result updates accounting without reviving a terminal run. Known overages
are recorded without clamping and block further effects. Scheduled runs retain
their lifetime reservation when usage is uncertain and need attention. Explicit
settlement can release a completed occurrence's hold; failures and cancellations
retain the scheduler's conservative reservation policy.

The request uses `search_document: ` and `search_query: ` prefixes and
`truncate:false`. Metadata is checked before and after each inference. These
checks detect model changes; they cannot make a mutable local Ollama tag atomic
against an operator changing it during inference. Keep the local model stable
while indexing. Query embeddings are not persisted or automatically retried.

## RGBA experiment

The vector codec also supports experimental adaptive signed8 packing into four
byte channels, with one float32 scale per vector and checksummed framing. This is
lossy quantization; grouping four components does not turn them into physical
XYZW coordinates. A strict RGBA PNG codec can transport the packed bytes exactly,
but arbitrary image viewers, compositing, rescaling and screenshots are not a
valid transport. No image is sent to a language model by this retrieval path.
Production search keeps float32 vectors until broader accuracy evidence justifies
changing it.

The recorded local experiment used six project documents, 50 chunks, eight
hand-authored queries and 768-dimensional embeddings. Float32 and signed8 agreed
on all eight top hits and all top-three sets. Both selected a hand-labelled
relevant document for six of eight queries, so the two failures remain visible.
Including framing and scales, vector bytes fell from 178240 to 44840 (74.84%).
The corresponding exact PNG carriers were 164404 and 37960 bytes. This is a small
project-specific corpus, not a general retrieval benchmark or a measured language
model token saving. The run consumed 11102 local embedding input tokens.

API and model contracts:
[Ollama embed API](https://docs.ollama.com/api/embed),
[Ollama embeddings](https://docs.ollama.com/capabilities/embeddings),
[Nomic model card](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5).
