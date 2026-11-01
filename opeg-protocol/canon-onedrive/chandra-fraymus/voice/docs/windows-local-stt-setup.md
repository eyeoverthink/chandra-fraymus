# Isolated local Windows speech recognition setup

This is an explicit operator setup. The voice server and model requests never install
packages or download models. It uses Windows x64 / Python 3.12, a dedicated `.venv-asr`,
and the public `Systran/faster-whisper-small.en` English model on CPU with INT8
computation, four threads and one worker. No microphone, paid API, GPU, Docker, account,
or Hugging Face token is needed. Package/model downloads require public HTTPS once;
runtime model loading and transcription are configured offline.

From the voice checkout, using the existing Python 3.12 interpreter:

```powershell
python bin/setup-local-stt.py
```

The checked-in `requirements/windows-asr-py312.lock` and matching `.lock.json` list
every downloaded runtime wheel with its exact version, filename, size and SHA256.
Setup independently checks those entries against public PyPI release metadata,
downloads only wheels, and installs with `--no-index --require-hashes --no-deps`
from its verified local wheelhouse. Global Python packages/configuration are untouched.
The interpreter's bundled `ensurepip` creates pip inside the new environment.

The pinned model revision is `d1d751a5f8271d482d14ca55d9e2deeebbae577f`.
Its four required files total **486,098,798 bytes**: `model.bin`, `config.json`,
`tokenizer.json`, and `vocabulary.txt`. The binary's SHA256 and other files' Git blob
IDs must match the pinned public repository metadata; the final manifest additionally
records every file's SHA256. Limits are 500 MiB per model file, 600 MiB total model
data, 200 MiB per wheel, 512 MiB total wheels, and 48 wheels. HTTPS redirects stay on
approved PyPI/Hugging Face/CDN hosts. Downloads/processes have time/output bounds;
partial downloads cannot become installed model files.

Only after wheel integrity, dependency checks, model integrity, and a successful
offline CPU INT8 load does setup atomically write `data/stt-config.json`, pointing to
`data/stt-setup-manifest.json`. The manifest contains exact wheel/model hashes and the
load receipt, including requested and actual computation types. On this CPU,
`compute_type='int8'` resolves to `int8_float32` (INT8 weights with floating point
operations for remaining layers); a fallback to pure float computation is rejected.
Model loading does not establish recognition accuracy and performs no
transcription. The bridge reads configuration on startup; coordinate its restart
separately. No Windows recognizer fallback is implied by this configuration.

All mutable assets stay in ignored `.venv-asr/` and `data/`. The setup process passes
only a small environment allowlist to children, disables implicit Hugging Face tokens,
uses its own HF cache, requires the local tokenizer, and validates with
`HF_HUB_OFFLINE=1`, `local_files_only=True`, and `use_auth_token=False`.
The load check rejects Python socket connections. This is not an OS network sandbox.

For a repeatable offline check without downloading, installing or writing config:

```powershell
python bin/setup-local-stt.py --verify-only
```

To deliberately regenerate the wheel lock, a maintainer may run the following with an
empty `data/stt-resolve-wheelhouse` and review/commit the changed lock assets:

```powershell
python bin/setup-local-stt.py --resolve-lock
```

That maintenance command resolves only the reviewed `faster-whisper==1.2.1` release
from public PyPI, independently verifies every resolved wheel against PyPI SHA256 and
size metadata, and records the entire dependency closure before any installation.
It never refreshes the model revision or changes an existing lock automatically during
ordinary setup. The model fingerprint and top-level release wheel fingerprint are
reviewed constants in the setup script.

Before enabling an ASR quality claim, compare held-out human speech and fixed synthetic
phrases, silence and noise on this machine. Record expected/actual text, word error
rate, cold/warm latency, memory, full-audio completion and cancellation. Decoder scores
are uncalibrated and do not prove transcript correctness.

Primary references: [faster-whisper](https://github.com/SYSTRAN/faster-whisper),
[CTranslate2 Windows requirements](https://opennmt.net/CTranslate2/installation.html),
[public model files](https://huggingface.co/Systran/faster-whisper-small.en/tree/main),
and [Hugging Face offline/token settings](https://huggingface.co/docs/huggingface_hub/en/package_reference/environment_variables).
