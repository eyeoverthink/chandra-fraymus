# Voice stack on mac-hermes (delivered 2026-10-25)

## Owner preferences for voice work (always-on)
- FREE, LOCAL, OPEN-WEIGHTS tools only; no cloud accounts, no keys, no subscriptions. He asks
  for the FUNCTION ("real sounding voice", clone my own) before any product name — vet the
  whole availability state (weights/API/app separately) before proposing anything.
- Findings must be WIRED IN, not just found: deliver as launchers/HTTP adapters inside his
  apps (MyAIPartner's PARTNER_VOICE auto-detect pattern) and VERIFY with real traffic
  (HTTP 200s, played WAV files) before reporting success.
- The RTO00K0 twin: Moshi CUDA server + this adapter = the pending render/voice seat job
  (cadence-seat/bootstrap/FIRST_SESSION.md carries the plan).

## Components (all free, offline, verified)
- **Moshi** (Kyutai, full-duplex Dessa-like): deps in `hermes-memory-workspace/voice-deps/`,
  int4 weights in `~/voice-models/moshiko-mlx-q4/` (4.9 GB), launcher `~/bin/moshi-chat`.
  Verified boot: `[SERVER] model warmed up` + `connected!` + client start; [LAG] ticks on the
  8 GiB box during continuous speech — acceptable, recovers; smooth tier = CUDA box later.
- **F5-TTS-MLX** (his-voice cloning): deps in `voice-deps-f5/` + `jieba` unpacked from sdist;
  weights `~/voice-models/f5/model` (3.8 GB); wrapper `~/bin/myvoice`
  (setup: `--ref recording.m4a --reftext "exact words" --set`; use: `~/bin/myvoice "text"`).
  Verified: 5.95 s ref → 7.06 s generated WAV in ~47 s. The owner's real-voice ref is
  installed; its clone needed debugging (see the pitfall block — resolve before trusting
  its outputs).
- **partner-voice-server** (`~/bin/partner-voice-server`): stdlib HTTP on 127.0.0.1:9099
  matching MyAIPartner's PARTNER_VOICE adapter contract (GET /health, POST /speak → audio/wav;
  /listen = 501, duplex goes via moshi CLI). MyAIPartner auto-detects it on page load and
  speaks replies in the stored voice. Verified: /health 200, /speak 200.
- **Voicebox** (GUI voice studio, jamiepine/voicebox v0.5.0, MIT): DMG staged at
  `~/Downloads/Voicebox_0.5.0.dmg` (sha256 1ef6d28d17b96e1b331340831bf59ea2dd3c526dbbdcadb3d2b90f186e9b3070) —
  owner installs by double-click (right-click→Open for the unsigned first launch).

## F5-TTS debugging pitfalls (when clones come back tiny/garbage)
- NEVER pass `duration=` to f5-tts-mx generate on this build: explicit durations produce
  0.04–0.08 s outputs regardless of the requested value (control-tested against a ref that
  generates 7.06 s normally). Let the estimator run; fix length by editing the TEXT, not a
  duration argument.
- ALWAYS verify the ref-text matches the ACTUAL spoken words before blaming the engine: the
  clone conditions on the transcript, so a caption that differs from what the owner said
  produces garbage-tiny audio with everything else looking healthy. When the owner hands you
  a raw recording, ask for their exact words (or transcribe) before `--set`.
- Bisect voice-vs-stack with a SYNTHETIC CONTROL: re-run a known-good command (`say` +
  afconvert ref, the exact text that previously produced full-length output). If the control
  still generates full length, the stack is healthy and the problem is the new ref/caption —
  do not reinstall or re-download weights in that state.
- Debug order that avoids rabbit holes: repeat the known-good command verbatim → swap in the
  suspect ref → only then touch duration/env/model files. One variable at a time, one probe
  per variable; the HF cache (blobs dir) is rarely the culprit — check it late.

## Runtime rules
- **F5 ref-audio calibration (root-caused 10-26):** the reference must be RMS-normalized to ~0.087, peak <0.75, silence-trimmed; a hot/clipped phone-memo ref collapses the duration estimator (0.04–2.7 s garbage). `~/bin/myvoice --set` now auto-normalizes. Verify clones by transcribing the wav with **mlx-whisper** (installed in voice-deps-f5; accepts a numpy waveform — no ffmpeg needed) against the input text.
- **f5_tts_mlx 0.2.6:** explicit `duration=` is poison (~0.04 s ignored); `output_path` with multi-sentence text writes only the trailing chunk. Keep texts ≤2 sentences or pre-split client-side. mlx_whisper.transcribe default repo = whisper-tiny; pinned names like whisper-base 401.
- **Stale-server trap:** a changed partner-voice-server isn't `live` until the LISTENER pid is new — kill by `lsof -nP -iTCP:9099 -sTCP:LISTEN` pid, not by name (multiple old instances survive name-based kills and keep serving old code).
- Every mlx-based process needs the `mac_ver()` sitecustomize on PYTHONPATH (it lives inside
  both deps dirs; partner-voice-server self-re-execs with it). See mac-python-packaging skill.
- Port 9099 = the MyAIPartner probe target; keep it fixed or change both sides.
- Reference/clone audio needs NO ffmpeg on this box: macOS-native `say -o out.aiff` +
  `afconvert -f WAVE -d LEI16@24000 -c 1 in.aiff out.wav` produces the mono 24 kHz clone input
  (the format every clone tool here wants). myvoice applies it automatically to any input format.
- The voice server is headless: verify GENERATION by WAV header + byte size, not by playback —
  `afplay` is the owner's ears, not the check.
- After patching any long-running local server, confirm the NEW process actually holds the
  port before testing (`ps aux | grep <name>` for old pids, kill -9 all, restart, then probe):
  a patchless earlier instance keeps serving identical responses and makes a fix look inert
  (the giveaway is byte-identical output size before and after the code change).
- Don't run moshi + f5 concurrently on 8 GiB RAM; the voice server loads F5 per request (~40 s).
- F5-TTS-MLX 0.2.x Python API: `from f5_tts_mlx.generate import generate` then
  `generate(generation_text=..., ref_audio_path=..., ref_audio_text=..., output_path=...)` —
  there is no load_model/model kwarg; the function loads F5TTS.from_pretrained per call.
- The generate/output_path path truncates multi-sentence runs to the last chunk on some text
  shapes; the server stitches per-sentence chunks itself (concat with soundfile) — keep that
  stitching when editing the server, and sanity-check output duration vs word count.
- Fleet provenance: FraymusConvergence (Java agent, Φ-skills) is OWNER-authored (his Feb-era
  build) — assay CLAIM layers only (mirror≠cipher, timestamp hash≠signature), keep founder
  credit; see bridge msg 079.
