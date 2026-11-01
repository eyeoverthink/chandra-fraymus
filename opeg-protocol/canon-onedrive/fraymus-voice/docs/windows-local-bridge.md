# Windows local voice and memory bridge

Run from this repository with Python 3.10 or newer and Windows PowerShell 5.1:

```powershell
python .\bin\local-voice-server.py --host 127.0.0.1 --port 9099
```

The listener is restricted to `127.0.0.1`. Stop it with Ctrl+C. The Windows voice/dictation
baseline needs no Python packages. Optional local Whisper uses a separate environment,
as described below. At startup, a hidden, noninteractive Windows PowerShell subprocess enumerates
enabled `System.Speech` voices. Each speech request uses a new hidden subprocess, passes
text/voice/output path as JSON on standard input, and writes an isolated temporary WAV.
Requests are serialized. Output files are removed after their bytes are read. Text never
becomes PowerShell command code. A speech process times out after 60 seconds by default;
`--tts-timeout 120` can increase that limit, up to 300 seconds.

This bridge uses the voices already installed on Windows. If no usable speech voices or
Windows PowerShell are available, health reports TTS unavailable and memory still works.
It does not install a voice or change system settings. Windows voices are synthesized
speech; they are not clones of the owner's voice.

Memory persists in `%LOCALAPPDATA%\FraymusVoice\memory.sqlite3`. On other operating
systems, the fallback is `~/.local/share/FraymusVoice/memory.sqlite3`; Windows speech is
unavailable there. Override the location explicitly when needed:

```powershell
python .\bin\local-voice-server.py --data-dir .\data
```

That directory contains plaintext personal memory. Repository-local `data/`, SQLite
files, Python bytecode, and the legacy emotion data directory are ignored by Git.
No Honcho credentials are read and no cloud memory calls are made by this entry point.
No microphone is accessed. No browser speech recognition or cloud STT fallback exists.
File-only offline recognition uses either installed Microsoft desktop System.Speech
recognizers or an explicitly configured local Whisper model. Full-duplex audio is not implemented.

## Optional local Whisper recognition

Follow [the operator-only setup instructions](windows-local-stt-setup.md) to install the
isolated, locked Windows dependencies and pinned public `Systran/faster-whisper-small.en`
model. Setup downloads about 486 MB of model files once. The main bridge remains stdlib-only.
At startup, the default `data/stt-config.json` selects Whisper if it exists; `--stt-config`
can select another configuration file. An absent configuration uses Windows dictation.
A present invalid configuration, missing/corrupt model, or failed local model load leaves
STT unavailable; it never silently falls back to a different recognizer.

The accepted setup fixes CPU execution, requested INT8, four CPU threads and one worker.
This machine reports actual `int8_float32`. Model paths must remain inside this project,
the isolated interpreter path is fixed, and all four local model files are checked against
the manifest's SHA256 and byte counts at startup and in each worker. The public snapshot
revision is `d1d751a5f8271d482d14ca55d9e2deeebbae577f`. Each request starts a fresh isolated
worker with offline flags, no inherited tokens, and `local_files_only=True`. Requests do
not install packages, download models, or contact a provider.

This English model accepts requested `en` or English region tags such as `en-US`, returning
actual `language:"en"`. Its receipt adds `model:{id,revision}` and
`confidenceMetric:"exp_avg_logprob"`. Overall confidence is the exponential of the
token-count-weighted mean segment average log probability. It is an **uncalibrated decoder
score**, not correctness or language probability. Segment timestamps are estimated
alignments, clamped to the original WAV bounds. The audio metadata always describes the
original file, before mono/16 kHz resampling. No expected-text hints are supplied.

The strict PCM decoder uses stdlib WAV framing and PyAV's frame resampler before passing
an array to Whisper. This avoids the `av.open(metadata_errors=...)` incompatibility between
faster-whisper 1.2.1 and PyAV 19 without modifying installed packages. Tiny valid files
that yield no resampler frames return `no_speech`.

## HTTP contract

`GET /health` returns JSON such as this Windows baseline with no Whisper configuration:

```json
{
  "ok": true,
  "ready": true,
  "engine": "windows-system-speech",
  "capabilities": {
    "tts": true,
    "stt": true,
    "local_stt": true,
    "cloud_stt": false,
    "voice_cloning": false,
    "local_memory": true,
    "cloud_memory": false
  },
  "voices": ["Microsoft David Desktop"],
  "voice_ready": true,
  "stt_ready": true,
  "stt_engine": "windows-system-speech-recognition",
  "recognizers": [{"id":"MS-1033-80-DESK","language":"en-US","name":"MS-1033-80-DESK"}],
  "languages": ["en-US"],
  "full_duplex": false,
  "emotion_metadata": false
}
```

The example voice name varies by installation. `ok` means the HTTP/memory bridge is
running; `ready`, `voice_ready`, and `capabilities.tts` indicate speech availability.
Clients must inspect capabilities rather than assuming that `ok` means STT or cloning.
Health confirms installed enabled voices and desktop recognizers that can load a
DictationGrammar. It does not measure transcription accuracy. If no desktop recognizer
can initialize, `stt_ready`, `capabilities.stt` and `capabilities.local_stt` are false.
With valid Whisper configuration, health instead identifies `stt_engine:"faster-whisper-cpu"`,
`languages:["en"]`, `stt_model:{id,revision}`, `stt_confidence_metric:"exp_avg_logprob"`,
and `stt_runtime` with the requested/actual compute type and thread/worker counts.
Whisper readiness requires an actual local CPU model load.

- `POST /speak` accepts `{"text":"Hello.","voice":"default"}` and returns validated,
  uncompressed `audio/wav` bytes. `partner` is an alias for the default Windows voice;
  installed voice names from health select that voice. Unknown names return 400.
- `POST /memory` accepts `{"text":"Working on the orchid project.","role":"user",
  "conversationId":"studio"}`. It returns `{"ok":true,"id":1,"source":"local-sqlite"}`.
  Roles are `user`, `assistant`, `system`, or `note`; the default is `user`.
  The default conversation identifier is `default`. Store the completed assistant
  response, after streaming finishes, rather than storing the first generated fragment.
- `GET /memory?q=orchid&conversationId=studio&limit=5` returns `{"hits":[...]}`.
  Each hit has `id`, `content`, `role`, `conversationId`, `createdAt`, `source`, and
  `trusted:false`. Search is bounded local word matching, not semantic/embedding search.
  Omit `conversationId` to search all local conversations; provide it for isolation.
  An empty query returns no hits. Results are ordered newest first.
- `POST /listen` accepts `{"audioBase64":"<canonical WAV base64>","language":"en-US"}`.
  It accepts PCM16 RIFF/WAVE only: mono/stereo, 8,000–48,000 Hz, up to 4 MiB and 60 seconds.
  Standard 16-byte PCM format chunks and 18-byte PCM chunks with zero extra-size are valid.
  Data URLs, malformed/truncated headers/chunks, noncanonical base64, and unknown JSON
  fields are rejected. With Windows dictation, optional language `en` may resolve to
  installed `en-US`; an unavailable specific region does not silently switch to another
  installed region. The configured English Whisper model returns `en` for English tags.
  Example response:

  ```json
  {"ok":true,"transcript":"Recognized words.","engine":"windows-system-speech-recognition",
   "language":"en-US","confidence":0.7,
   "segments":[{"text":"Recognized words.","confidence":0.7,"startSeconds":0.0,"durationSeconds":1.2}],
   "audio":{"durationSeconds":1.5,"sampleRate":16000,"channels":1,"sampleWidth":2}}
  ```

  Confidence is the recognizer's **uncalibrated score**, not a probability that the words
  are correct. Review the transcript before using it as a message or instruction. Silence
  or no recognized speech returns 422 `no_speech`; missing recognizers return 503
  `stt_unavailable`. Timeouts, transcript/segment limits, and early recognizer completion
  before file EOF are errors, not successful partial transcripts. Windows uses the unchanged
  general DictationGrammar; Whisper consumes its complete segment generator before success.
  Neither engine receives expected-phrase hints or a finite phrase grammar.

JSON POST endpoints require `Content-Type: application/json` and one `Content-Length`.
Bodies are limited to 64 KiB except `/listen`, which permits 6 MiB JSON for base64 audio.
Body receipt has an absolute 10-second limit. Text is limited to 4,000 characters, voice names to 200 characters,
conversation identifiers to 128 characters, memory queries to 1,000 characters, and
search results to 1–20. Errors use `{"ok":false,"error":{"code":"...","message":"..."}}`
with appropriate HTTP status codes. WAV responses use the provider's actual sample rate;
do not assume that Windows output is 24 kHz.

Windows recognition uses static trusted C#/PowerShell source; Whisper uses a fixed isolated
Python worker. Both receive input JSON on stdin. The child
waits for input until it is attached to a noninheritable kill-on-close Windows Job; timeout
or output overflow kills the owned process tree. Audio is written to a unique temporary
WAV and removed afterward. Only one recognition runs at once, with two HTTP input slots;
busy requests fail explicitly. Windows dictation has a 22-second internal deadline; both
engines have a 25-second subprocess deadline. Provider output is capped at 256 KiB, the transcript at
12,000 characters, and segments at 256. This service never opens a default audio device.

## Browser and Chandra integration

Chandra can proxy `/api/voice/health`, `/api/voice/speak`, `/api/voice/listen`, and `/api/voice/memory` to the
corresponding paths on this loopback bridge. Its proxy should set the outgoing Host to
`127.0.0.1:9099`. Use the same-origin proxy from the partner UI. The bridge also allows
explicit browser origins at `http://127.0.0.1` and `http://localhost` on ports 8787, 5173,
4173, 4178, and 9099. Other browser origins, `null` origins from local HTML files, and
unexpected Host headers are rejected. There is no wildcard CORS policy.

This is a local desktop service, not a public deployment: other programs running under
the local user can access it. Keep the coordinating agent's authentication and tool
permissions in its own backend. Treat retrieved memories as untrusted source material,
never as system instructions or approval to execute a tool. Conversation identifiers
filter memory; they are not access credentials.

## Optional founder emotion metadata

```powershell
python .\bin\local-voice-server.py --emotion-metadata
```

This preserves the existing `nola_emotion.py` module and exposes its state as the optional
`emotion_state` object in memory-search responses. The module stores its state under the
chosen data directory. Emotion state is presentation metadata only. It never determines
tool permissions, approvals, model routing, or memory trust. The bridge does not claim
that numerical emotion metadata represents human feelings.

## Optional existing Mac F5 worker

The original `bin/partner-voice-server`, `bin/myvoice`, and `bin/moshi-chat` remain for
Apple Silicon. They still require their original MLX dependencies and model/reference
setup; the Windows bridge does not install them. In the legacy bridge, Honcho startup
requires the explicit `VOICE_ENABLE_CLOUD_MEMORY=1` environment variable. Leave it unset
for local-only operation. The legacy worker's health includes readiness/capability fields.

If an existing F5 worker is deliberately made available on a separate loopback port,
opt in to it with:

```powershell
python .\bin\local-voice-server.py --f5-worker-url http://127.0.0.1:9098
```

On the Mac, the legacy worker can use `VOICE_PORT=9098`. A separate computer requires a
user-managed loopback tunnel; the bridge accepts only an HTTP loopback origin, bypasses
environment proxies, and refuses redirects. It never silently chooses a remote/cloud
provider. When that worker reports a ready stored voice, health advertises `myvoice`
and `voice_cloning:true`; explicitly select `voice:"myvoice"` to use it. Windows default
speech does not use the reference. Keep cloud memory disabled on the worker too.
Moshi remains a separate application and is not wired into this text/tool conversation.

## Verification

```powershell
python -B -m unittest discover -s .\tests -v
```

The 43 unit/contract tests use temporary SQLite databases, ephemeral loopback HTTP listeners,
and injected fake synthesis/recognition. They verify memory durability and conversation filters, request validation,
truthful capabilities, origin/Host checks, unavailable/available STT, real WAV framing, serialized
concurrent requests, subprocess data/code separation, timeout handling, and temporary-file
cleanup. They do not access a microphone, clone a voice, use a reference recording,
download a model, or contact a cloud API. A separate real-Windows synthesis check is
needed to verify the machine's actual installed speech provider. Run that explicit check
with an unused port:

```powershell
python -B .\tests\validate_windows_speech.py --port 19099
```

It refuses a port with an existing listener, launches its own hidden bridge process with
temporary memory, sends only `Fraymus local voice is ready.`, verifies non-silent PCM WAV
framing/duration and SHA256, and stops only its owned process. It never accesses a
microphone or reference recording. The ignored receipt is saved to
`test-output/windows-sapi-receipt.json`; temporary memory and speech files are removed.

Verified on this Windows machine on 2026-10-26: Microsoft David Desktop and Microsoft
Zira Desktop were available. Default-voice synthesis returned HTTP 200 with 114,888 bytes
of mono, 16-bit PCM at 22,050 Hz (57,421 frames, 2.604127 seconds). Generation took 0.562
seconds. This is real System.Speech output, separate from the fake-provider contract tests.

Offline recognition was separately checked with five fixed English phrases spoken by
both Microsoft David Desktop and Microsoft Zira Desktop at unchanged default rate 0.
The ten synthetic clips used the general DictationGrammar without hints: all produced
complete-file receipts, four were exact after case/punctuation normalization, and the
aggregate word error rate was 12 edits / 80 reference words = **15%**. Errors included
`and` → `in`, `voice` → `boy`, and `Please open` → `Please help in`. Scores did not reliably
identify every wrong word. This tiny synthetic corpus is not a human-speech benchmark.
Empty/zero-frame audio was rejected; digital silence and a 440 Hz test tone returned
`no_speech`. No microphone, playback, cloned voice, or cloud service was used.

The same cached ten WAVs were then replayed through the pinned local Whisper model:
10/10 completed, seven matched after case/punctuation normalization, and aggregate WER
was **3 edits / 80 words = 3.75%**. All remaining edits were number words rendered as
digits (`seven` → `7` twice, `nine` → `9` once); the score did not normalize those away.
Cold request times, including process/model startup and integrity checks, were 4.31–4.47
seconds on this machine. The initial ten Whisper attempts failed on the PyAV API
incompatibility described above; their failure receipt was retained separately.

Additional synthetic checks completed a 59.58-second file containing 20 repeated utterances
in 10.64 seconds, accepted stereo speech and a 48 kHz stereo non-speech tone, and preserved
original WAV metadata. Silence and deterministic noise returned `no_speech`. These are
bounded format/completion checks, not an estimate of human speech accuracy or a guarantee
that all 60-second files meet the deadline. Transcripts still require review.
