# Local image helper

Agent tasks can explicitly select **Local vision helper (Gemma3)** under Image
handling. This lets a tool-capable local text model, such as GPT-OSS 20B, ask an
installed local vision model about an attached PNG or JPEG. The default remains
direct image input to the selected primary model, which must advertise vision.
There is no automatic routing after a direct image request fails.

Helper mode records `imageMode:"local-tool"` in the immutable run request. The
primary receives source references, dimensions and hashes, without image pixels.
`artifact.analyzeImage` accepts an attached `assetId`, a question of at most 1024
characters and an optional 1–1024 helper output-token ceiling (default 256).
Omit the optional ceiling to use its default; zero is invalid. The returned
observation includes the exact source SHA-256, helper model tag/digest, dimensions,
actual input/output usage and limitations.

The helper uses `gemma3:latest` at the configured loopback Ollama endpoint. It
validates local-only completion and vision metadata and the exact model digest
before and after inference. Missing or unsuitable models cause a reported
failure, without downloads or another provider. Mutable-tag checks are best
effort, not an atomic guarantee against an operator changing the model during a
request. Keep the model stable while a task runs.

Each helper call is stateless: a fixed source-data policy, one question and one
image, with no tool definitions or conversation history. Source images and machine
observations are untrusted data. They grant no permission for file, network or
desktop actions. The image must be attached to the current run and pass its source
hash check before the helper is contacted. Helper-mode conversations remain local
for subsequent turns, including after recovery; cloud inference cannot reuse
their private context. Previously persisted uploads remain on disk when merely
deselected in the interface. This feature adds no upload deletion policy.

Both helper input and output count toward the same run totals and output limit as
the primary model. A conservative image-input estimate and requested output
ceiling are reserved before inference. Known actual counts replace those holds;
partially reported usage records the known dimension as actual and holds only the
missing dimension. Unknown usage survives cancellation and process restart. Late
accounting cannot revive a terminal run. Actual overages remain visible without
clamping, and known input above the run's per-request ceiling stops further
effects. A new SQLite generation ledger shares aggregation with existing
embedding accounting; legacy embedding rows are preserved.

No reasoning or raw image base64 is stored in the generation ledger. Original
uploads, bounded observations and run receipts follow existing local retention.
The helper is limited to attached PNG/JPEG images: it does not capture a desktop,
render PDF pages or enable screen automation. Existing desktop image-input
verification remains disabled. No Docker, paid API, model download or GUI action
is needed for helper inference.

## Observed limits

On two saved synthetic images, Gemma3 identified both rectangle colors correctly
and abstained on a no-image control, but misread the six-digit strings on both
images. Gemma4's earlier tests returned incorrect repeated values across native
tool, ordinary user and companion-image transports. Capability metadata does not
prove reliable perception. Exact OCR, small text and consequential values need
independent verification against the original source.

The isolated two-model check asked GPT-OSS to use the native helper on one image.
It received no pixels, called Gemma3, reported the correct yellow rectangle, cited
the source hash and helper identity, and stated that digit transcription remained
unverified. Total usage was 4211 local tokens, including 393 helper input and two
helper output tokens. An initially overstrict checker expected the literal model
tag in prose; the answer named Gemma 3 and its receipt recorded the exact tag and
digest. The corrected checker independently validated the same saved events and
SQLite row without another model call. This is one development fixture, not a
general accuracy benchmark or verified desktop control.

Contract references: [Ollama vision](https://docs.ollama.com/capabilities/vision)
and [chat API](https://docs.ollama.com/api/chat).
