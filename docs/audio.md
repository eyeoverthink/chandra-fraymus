# Local WAV transcription and review

The partner accepts WAV attachments alongside existing images and documents.
The installed English `Systran/faster-whisper-small.en` model runs on the CPU in
an isolated Python environment with INT8 weights (`int8_float32` on this machine).
Its pinned revision is `d1d751a5f8271d482d14ca55d9e2deeebbae577f`.
Model loading and recognition are configured offline. Docker and WSL are not
required for this feature.

Upload a WAV through the attachment picker. Its card displays the engine, model
revision, original audio metadata, decoder score and machine transcript. **Use
transcript as draft** fills the composer; review/edit it and explicitly send the
task. Uploading, reviewing or drafting does not create an agent run. Playback is
an optional local control without autoplay. This feature never records a
microphone or clones a voice.

Attached speech is untrusted reference material. Its words cannot authorize file
writes, network requests or other actions. An agent can use `artifact.inspect`,
`artifact.read` and `artifact.search` on the transcript only when its WAV is
attached to that run. The original WAV and separately hashed derived transcript
are retained, and downloading the original preserves its bytes.

## Formats and failure behavior

| Limit | Value |
|---|---|
| File | Exact RIFF/WAVE, PCM16, uncompressed |
| Channels / sample rate | Mono or stereo, 8–48 kHz |
| Upload / duration | At most 4 MiB and 60 seconds; both limits apply |
| Attachments | Four total per task, shared with other supported types |
| Transcript | At most 12,000 characters; no successful partial transcript |
| Local proxy deadline | 32 seconds for recognition and its complete response |
| Companion upload deadline | 35 seconds |
| Recognition concurrency | One worker; excess work is rejected as busy |

The server validates base64, RIFF extents, chunk count, format, frame alignment,
duration and original metadata before storing a transcript. MP3, compressed WAV,
RF64, extensible WAV, URLs and caller-supplied filesystem paths are unsupported.
The worker reads the validated PCM with Python's WAV reader, resamples/downmixes
it to 16 kHz mono and passes an array to Whisper; original rate/channels/duration
remain in the receipt. Estimated segment times are bounded by that duration.

Silence/no recognized speech, incomplete recognition, deadlines, output limits,
malformed responses or unavailable local setup return explicit errors. Failed
uploads do not commit partial assets or substitute an invented transcript.
Cancellation stops the proxy's wait and prevents asset commit; the independent
voice worker retains its own bounded deadline and process cleanup.

The Whisper score is `exp_avg_logprob`: the exponential of the token-weighted
mean segment decoder log probability. Segment scores use each segment's mean
log probability. These are uncalibrated decoder scores, not transcript accuracy
or language probabilities. Check names, numbers and consequential instructions.

## Operator setup

From the sibling `fraymus-voice` checkout with Windows x64 / Python 3.12:

```powershell
python bin/setup-local-stt.py
python bin/setup-local-stt.py --verify-only
```

Setup downloads verified public wheels and approximately 486 MB of pinned model
files into ignored local directories. It does not change global Python, download
from model requests or install at server startup. Restart the launcher-owned
services after setup. `/api/voice/health` reports the selected engine, readiness,
model revision and compute type. A configured invalid Whisper setup fails closed;
it never silently switches recognition engines. Without Whisper configuration,
the bridge can use an installed Windows desktop recognizer.

See the sibling [setup guide](https://github.com/eyeoverthink/fraymus-voice/blob/main/docs/windows-local-stt-setup.md)
for hashes, offline verification and exact dependency limits. CPU inference is a
trusted local worker with bounded execution and process cleanup, not a sandbox
for arbitrary code. Sandboxed agent code execution remains separately gated on
Docker readiness.

Synthetic speech tests measure this particular fixture and computer. They do not
establish performance on human speech, accents, noisy recordings or other
languages. English small.en reports language `en`, without inferring a dialect.
