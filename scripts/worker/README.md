# Chandra worker

Lets another machine on the private network paint pictures and render films for the hub.
One file, Python standard library only: `chandra_worker.py`.

## What was tested, and where

| | Status |
|---|---|
| The protocol (token, capability report, refusals, digest agreement between hub and worker) | Unit-tested: `test/workers.test.js` |
| A whole film through a worker: three backdrops painted, six lines voiced on the hub, film rendered, receipts checked | Tested 2026-11-10 with the worker running **on the hub PC itself**, reached over its Tailscale address |
| Hub falls back to its own card when the worker is down | Tested 2026-11-10 |
| **Running on fraymus-home (RTX 5070)** | **Not tested.** Nothing could be started on that machine from the hub: only its Ollama port answers. The steps below are what was done on the hub PC; the PyTorch build for a 50-series card is the one line that differs and has not been tried |

## Set up on the machine with the card (run these there)

1. **Get the code** — a checkout of this repository (the worker uses `server/media/pystudio` and `server/media/pyshim` from it) and of
   `fraymus-video-studio`.
2. **Image engine** — ComfyUI with SDXL, the same layout as the hub's (`F:\Chandra-Studio\INSTALLED.md` lists the exact versions, sources
   and SHA-256 hashes): ComfyUI v0.44.0, its own Python environment with PyTorch, `sd_xl_base_1.0.safetensors` in `models/checkpoints`,
   `sdxl_vae.safetensors` in `models/vae`. On an RTX 50-series card PyTorch must be a CUDA 12.8 build (`--index-url https://download.pytorch.org/whl/cu128`).
   About 12 GB of downloads.
3. **Film renderer** — the Python you point `--studio-python` at needs `numpy`, `pillow` and `scipy` (ComfyUI's environment already has them)
   and `ffmpeg` on PATH. `soundfile` is optional: without it Chandra's WAV stand-in is used.
4. **Token** — copy the hub's `data/worker-token.txt` to this machine. It is full trust: whoever holds it can make this machine render.
5. **Check, then run** (replace the paths; `--bind` is this machine's Tailscale address):

   ```
   python chandra_worker.py --check --bind 100.99.98.101 --token-file worker-token.txt --comfy-dir D:\Chandra-Studio\ComfyUI --comfy-python D:\Chandra-Studio\comfyui-env\Scripts\python.exe --studio-dir D:\fraymus-video-studio --studio-python D:\Chandra-Studio\comfyui-env\Scripts\python.exe --ollama-url http://127.0.0.1:11434
   ```

   `--check` prints what the machine can do and exits non-zero if either kind of work is not ready, naming what is missing.
   Drop `--check` to serve. Allow inbound TCP 47210 on the Tailscale interface in Windows Firewall.

6. **Tell the hub** — in the hub's `.env`: `CHANDRA_WORKERS=home=http://100.99.98.101:47210`, restart, then
   `GET /api/studio/workers?fresh=1` shows the worker, its card and whether `stills` and `video` are ready.

## What the hub sends and what it never sends

- **Stills:** prompts and sizes. **Video:** the script, the cast sprites, the backdrop pictures and the **already recorded** lines.
- The voices themselves stay on the hub: VoiceStudio is never called from the worker. Only finished WAV files travel.
- No program travels. The worker runs only ComfyUI, ffmpeg and the studio launcher that are already on it.

## Contract

`GET /health` · `POST /jobs {id, nonce, kind: "stills"|"video", spec, files}` · `GET /jobs/<id>` · `GET /jobs/<id>/files/<name>` ·
`POST /jobs/<id>/ack {nonce}`. Every request needs `Authorization: Bearer <token>`.

- The same `id` with the same content is the same job: a retry returns the running or finished job and never renders twice.
  The same `id` with different content is refused (409).
- One job at a time (429 while busy). A kind the machine cannot do is refused (422) with the reason.
- A finished job carries a receipt: the caller's nonce, the content digest, and the SHA-256 of every output. The hub checks all three
  before it uses a file, then acknowledges, and the worker deletes the job folder. Unacknowledged jobs are removed after 24 hours.

On Windows the film renders with one process (the studio's parallel mode uses `fork`); on Linux or macOS the worker uses the cores it has.
