# Chandra worker

Lets another machine on the private network paint pictures and render films for the hub.
One file, Python standard library only: `chandra_worker.py`.

## What was tested, and where

| | Status |
|---|---|
| The protocol (token, capability report, refusals, digest agreement between hub and worker) | Unit-tested: `test/workers.test.js`, `test/workers-tunnel.test.js` |
| A worker on the hub PC itself, reached over its Tailscale address | Tested 2026-11-10: backdrops, a film, comic pages; receipts checked |
| Hub falls back to its own card when the worker is down | Tested 2026-11-10 |
| **fraymus-home (RTX 5070), reached through an SSH tunnel** | **Tested 2026-11-10:** an 8-bit film (2 backdrops in 40 s, render 28 s with 8 processes, about 90 s end to end) and an explainer (105 s end to end; 12 min 47 s on the hub's own card). The film's own sprites were drawn by all eight render processes |
| Linux or macOS workers, two workers at once, a worker dying mid-job, the 24-hour clean-up | Not tested |

## How fraymus-home is set up (2026-11-10)

| What | Where |
|---|---|
| ComfyUI v0.44.0 (same commit as the hub) + Python 3.12 environment, PyTorch 2.11.0+cu128 | `E:\Chandra-Studio` |
| SDXL base 1.0 and the VAE fix | `D:\Models\comfyui` (ComfyUI finds them through `extra_model_paths.yaml`) |
| The video studio, with Vaughn's Windows fix and its own `.venv` | `E:\Projects\fraymus-video-studio` (used as it is, not replaced) |
| This worker, its launcher copy, `start-worker.ps1`, the token | `E:\Projects\chandra-worker` |
| Job files while a job runs | `D:\Scratch\chandra-worker` |

Every folder has a dated README and is listed in its parent's index. The scripts that did this are kept in
`F:\Claude-Work\chandra-superintelligence\fraymus-home\` on the hub.

- **Private.** The worker listens on `127.0.0.1` only, and so does ComfyUI. The hub reaches the worker through SSH
  (`CHANDRA_WORKERS=home=ssh://eyeov@100.99.98.101:47210` — the hub opens the tunnel and keeps it up). No firewall rule
  was added for the worker.
- **Sharing the card with Ollama.** Before painting, the worker asks the local Ollama to unload what it holds (the same as
  `ollama stop <model>`); Ollama's settings are untouched and it reloads on its next use. The receipt lists what was unloaded.
- **It starts by itself at sign-in (since 2026-11-11).** A scheduled task named `Chandra Worker` runs `launch-worker.ps1`
  45 seconds after `eyeov` signs in to Windows — hidden, without administrator rights, and it does nothing when the worker is
  already up. After a reboot nothing runs until someone signs in; until then the hub does the work on its own card and says why.
  By hand: `powershell -ExecutionPolicy Bypass -File E:\Projects\chandra-worker\start-worker.ps1`.
  Remove the task: `Unregister-ScheduledTask -TaskName 'Chandra Worker' -Confirm:$false`.
  Seen 2026-11-11: the PC rebooted overnight, the hub reported the worker unreachable, and a start by hand brought it back.
  **Proven through a real reboot the same morning:** boot 09:10:34, task fired 09:11:31, worker listening 09:11:34,
  and the hub's tunnel reached it (stills and video ready) with nothing done by hand.
- After changing `chandra_worker.py` or `server/media/pystudio/chandra_studio.py` here, copy them to `E:\Projects\chandra-worker` again.

## Setting up another machine

1. A checkout of `fraymus-video-studio`, with a Python that has `numpy`, `pillow`, `scipy` (and ideally `soundfile`), and `ffmpeg` on PATH.
2. ComfyUI with SDXL base 1.0 and `sdxl_vae.safetensors`. On an RTX 50-series card PyTorch must be a CUDA 12.8 build. Use Python 3.12.
3. Copy `chandra_worker.py`, `server/media/pystudio/chandra_studio.py` and the hub's `data/worker-token.txt` to it.
4. `python chandra_worker.py --check …` prints what the machine can do and exits non-zero, naming what is missing, if either kind of work is not ready.
5. Either listen on loopback and let the hub tunnel in (`name=ssh://user@host:port`, needs key login), or listen on the
   private address (`--bind <tailscale address>`, `name=http://host:port`) with a firewall rule limited to the private network.

Useful options: `--models-dir` (weights outside ComfyUI), `--ollama-url` (unload before painting), `--studio-workers N`
(0 = decide: 1 on Windows unless the studio has the spawn fix), `--studio-env KEY=VALUE` (for example
`STUDIO_WHISPER=small.en HF_HOME=… HF_HUB_OFFLINE=1` for exact word timing with no download), `--lowvram` (8 GB cards).

## What the hub sends and what it never sends

- **Stills:** prompts and sizes. **Video:** the script, the cast, the backdrop pictures and the **already recorded** lines.
- The voices themselves stay on the hub: VoiceStudio is never called from the worker. Only finished WAV files travel.
- No program travels. The worker runs only ComfyUI, ffmpeg and the studio launcher that are already on it.

## Contract

`GET /health` · `POST /jobs {id, nonce, kind: "stills"|"i2v"|"video", spec, files}` · `GET /jobs/<id>` · `GET /jobs/<id>/files/<name>` ·
`POST /jobs/<id>/ack {nonce}`. Every request needs `Authorization: Bearer <token>`.

- The same `id` with the same content is the same job: a retry returns the running or finished job and never renders twice.
  The same `id` with different content is refused (409).
- One job at a time (429 while busy). A kind the machine cannot do is refused (422) with the reason.
- `i2v` (1.3.0): `files: {"start.png"}`, `spec: {prompt, seconds 1–5, width, height, steps?, seed?, negative?}` → `clip.mp4` (24 fps).
  Wan 2.2 TI2V 5B through the local ComfyUI's native nodes; needs `diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`,
  `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` and `vae/wan2.2_vae.safetensors` under `--models-dir` **and** mapped in
  ComfyUI's `extra_model_paths.yaml`. Holds `--gpu-lock` for the whole clip and unloads Ollama first, like stills.
- A finished job carries a receipt: the caller's nonce, the content digest, and the SHA-256 of every output. The hub checks all three
  before it uses a file, then acknowledges, and the worker deletes the job folder. Unacknowledged jobs are removed after 24 hours.
