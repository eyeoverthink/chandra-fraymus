"""Chandra worker — lets another machine on the private network paint pictures and render films for the hub.

Standard library only. Run it on a machine with a graphics card (for example fraymus-home):

    python chandra_worker.py --bind 100.99.98.101 --token-file worker-token.txt \
        --comfy-dir D:/Chandra-Studio/ComfyUI --comfy-python D:/Chandra-Studio/comfyui-env/Scripts/python.exe \
        --studio-dir D:/fraymus-video-studio --studio-python D:/Chandra-Studio/comfyui-env/Scripts/python.exe
    python chandra_worker.py --check ...        # say what this machine can and cannot do, then exit

The hub never accepts connections; it calls the worker. Three small contracts, borrowed from the Agent
Workspace's claim / nonce / acknowledge protocol:

  capability   GET  /health               what this machine has: card, memory, which kinds of work are ready
  work         POST /jobs                 {id, nonce, kind, spec, files} -> one job at a time. The same id with
                                          the same content is the SAME job (a retry never runs twice); the same
                                          id with different content is refused.
               GET  /jobs/<id>            state, stage, progress, and on completion a receipt bound to the nonce
               GET  /jobs/<id>/files/<n>  an output file
               POST /jobs/<id>/ack        {nonce} -> the hub has the outputs; the job folder is deleted
  artifact     every output is listed with its size and SHA-256 in the receipt

Kinds: "stills" (SDXL-family checkpoints through a local ComfyUI; an item may name another checkpoint that is on
disk), "i2v" (a still set in motion by Wan 2.2 TI2V 5B through the same ComfyUI, native nodes only), "mesh" (a
picture made into a 3-D model, .glb, by Hunyuan3D 2.0 through ComfyUI's native nodes) and "video" (fraymus-video-studio through Chandra's launcher, with the spoken lines
already recorded by the hub and sent along, so no voice leaves the hub's machine), "matte" (U^2-Net subject mask
on the CPU with onnxruntime, the model rembg uses, from --u2net) and "inpaint" (SDXL repaints the transparent part of
a picture through a latent noise mask, under the card lock) — the two halves of scene → layers.

Every request needs "Authorization: Bearer <token>". The token is full trust: whoever holds it can make this
machine render. Bind to the private (Tailscale) address, never to a public one. Job files are data; the only
programs the worker runs are ComfyUI, ffmpeg and the studio launcher that sit on this machine.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.5.0"
KINDS = ("stills", "i2v", "mesh", "video", "inpaint", "matte")
HERE = os.path.dirname(os.path.abspath(__file__))
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,60}$")
MAX_BODY = 96 * 1024 * 1024
JOB_TTL_S = 24 * 3600
STILL_TIMEOUT_S = 900
VIDEO_TIMEOUT_S = 3600
I2V_TIMEOUT_S = 1800
I2V_FPS = 24
# Wan 2.2 TI2V 5B, as Comfy-Org repackages it (the same three files fraymus-video-studio's studio/i2v.py uses)
WAN_FILES = {"unet": ("diffusion_models", "wan2.2_ti2v_5B_fp16.safetensors"),
             "clip": ("text_encoders", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
             "vae": ("vae", "wan2.2_vae.safetensors")}
WAN_NEGATIVE = ("static, still image, frozen, blurry, low quality, distorted, deformed, morphing, melting, extra limbs, "
                "duplicate, changing face, melting eyes, new features, text, letters, watermark, subtitles, colour shift, flicker, jpeg artifacts")
MODULES = ["numpy", "PIL", "scipy", "soundfile"]


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def job_digest(kind: str, spec: dict, files: dict) -> str:
    """Identity of a job's content: the same request always hashes the same, whatever the key order."""
    canon = json.dumps({"kind": kind, "spec": spec, "files": {k: sha256_bytes(v) for k, v in sorted(files.items())}}, sort_keys=True, separators=(",", ":"))
    return sha256_bytes(canon.encode())


def norm_line(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "").lower()).strip()


def http_json(url: str, payload=None, timeout=30):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, data, {"Content-Type": "application/json"} if data is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return json.loads(body) if body[:1] in (b"{", b"[") else {}


def sdxl_workflow(item: dict, checkpoint: str, vae: str | None) -> dict:
    wf = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": item["width"], "height": item["height"], "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": item["prompt"], "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": item["negative"], "clip": ["4", 1]}},
        "3": {"class_type": "KSampler", "inputs": {"seed": item["seed"], "steps": item["steps"], "cfg": item["cfg"], "sampler_name": "dpmpp_2m", "scheduler": "karras",
                                                    "denoise": 1, "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["10", 0] if vae else ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "chandra-worker", "images": ["8", 0]}},
    }
    if vae:
        wf["10"] = {"class_type": "VAELoader", "inputs": {"vae_name": vae}}
    return wf


def clean_still(item: dict) -> dict:
    def even64(v, d):
        try:
            v = int(v)
        except (TypeError, ValueError):
            v = d
        return min(1536, max(512, round(v / 64) * 64))
    prompt = str(item.get("prompt") or "").strip()[:1500]
    if not prompt:
        raise ValueError("every still needs a prompt")
    return {"prompt": prompt, "negative": str(item.get("negative") or "blurry, low quality, watermark, text, deformed")[:600],
            "width": even64(item.get("width"), 1024), "height": even64(item.get("height"), 1024),
            "steps": min(60, max(8, int(item.get("steps") or 28))), "cfg": min(15.0, max(1.0, float(item.get("cfg") or 6.5))),
            "seed": int(item["seed"]) if isinstance(item.get("seed"), int) else int.from_bytes(os.urandom(4), "big"),
            "checkpoint": str(item["checkpoint"]) if SAFE_NAME.match(str(item.get("checkpoint") or "")) else None}


def wan_workflow(image_name: str, c: dict) -> dict:
    """Wan 2.2 TI2V 5B image-to-video, native ComfyUI nodes (graph from fraymus-video-studio studio/i2v.py)."""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": WAN_FILES["unet"][1], "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": WAN_FILES["clip"][1], "type": "wan", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": WAN_FILES["vae"][1]}},
        "4": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 8.0}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": c["prompt"], "clip": ["2", 0]}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": c["negative"], "clip": ["2", 0]}},
        "7": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "8": {"class_type": "Wan22ImageToVideoLatent", "inputs": {"vae": ["3", 0], "width": c["width"], "height": c["height"],
                                                                   "length": c["frames"], "batch_size": 1, "start_image": ["7", 0]}},
        "9": {"class_type": "KSampler", "inputs": {"model": ["4", 0], "seed": c["seed"], "steps": c["steps"], "cfg": 5.0, "sampler_name": "uni_pc",
                                                    "scheduler": "simple", "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["8", 0], "denoise": 1.0}},
        "10": {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        "11": {"class_type": "SaveImage", "inputs": {"filename_prefix": c["prefix"], "images": ["10", 0]}},
    }


def clean_i2v(spec: dict, job_id: str) -> dict:
    """Wan wants sizes in multiples of 32 and 4n+1 frames; 5B is trained at 1280x704, so the long side stays <= 1280."""
    def mult32(v, d):
        try:
            v = int(v)
        except (TypeError, ValueError):
            v = d
        return min(1280, max(256, round(v / 32) * 32))
    prompt = str(spec.get("prompt") or "").strip()[:1500]
    if not prompt:
        raise ValueError("a motion clip needs a prompt saying what moves")
    try:
        seconds = float(spec.get("seconds") or 2)
    except (TypeError, ValueError):
        seconds = 2.0
    frames = int(round(min(5.0, max(1.0, seconds)) * I2V_FPS)) + 1
    frames = max(5, (frames - 1) // 4 * 4 + 1)
    return {"prompt": prompt, "negative": str(spec.get("negative") or WAN_NEGATIVE)[:800],
            "width": mult32(spec.get("width"), 960), "height": mult32(spec.get("height"), 544), "frames": frames,
            "steps": min(30, max(8, int(spec.get("steps") or 20))),
            "seed": int(spec["seed"]) if isinstance(spec.get("seed"), int) else int.from_bytes(os.urandom(4), "big"),
            "prefix": f"chandra-i2v-{job_id}"}


def inpaint_workflow(image_name: str, c: dict, checkpoint: str, vae: str | None) -> dict:
    """SDXL repaints only the masked area of a picture. The picture's alpha is the mask (transparent = repaint: ComfyUI's
    LoadImage gives MASK = 1 - alpha). The hub pre-fills the hole with the surrounding colours, so a plain checkpoint
    with a latent noise mask works without an inpainting model."""
    wf = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": c["prompt"], "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": c["negative"], "clip": ["4", 1]}},
        "11": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "12": {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["10", 0] if vae else ["4", 2]}},
        "13": {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["12", 0], "mask": ["11", 1]}},
        "3": {"class_type": "KSampler", "inputs": {"seed": c["seed"], "steps": c["steps"], "cfg": c["cfg"], "sampler_name": "dpmpp_2m", "scheduler": "karras",
                                                    "denoise": c["denoise"], "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["13", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["10", 0] if vae else ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": c["prefix"], "images": ["8", 0]}},
    }
    if vae:
        wf["10"] = {"class_type": "VAELoader", "inputs": {"vae_name": vae}}
    return wf


def clean_inpaint(spec: dict, job_id: str) -> dict:
    def num(v, d, lo, hi, cast=int):
        try:
            return min(hi, max(lo, cast(v)))
        except (TypeError, ValueError):
            return d
    return {"prompt": str(spec.get("prompt") or "empty background scenery, nobody in it, same style and lighting")[:1200],
            "negative": str(spec.get("negative") or "person, people, character, figure, animal, face, body, text, watermark, blurry")[:600],
            "steps": num(spec.get("steps"), 30, 10, 60), "cfg": num(spec.get("cfg"), 6.0, 1.0, 12.0, float), "denoise": num(spec.get("denoise"), 0.9, 0.3, 1.0, float),
            "seed": int(spec["seed"]) if isinstance(spec.get("seed"), int) else int.from_bytes(os.urandom(4), "big"),
            "prefix": f"chandra-inpaint-{job_id}"}


def u2net_mask(model_path: str, image_path: str, out_path: str) -> dict:
    """Salient-object matte with U^2-Net (the model rembg uses), run on the CPU with onnxruntime: 320x320 input,
    ImageNet normalisation after dividing by the image maximum, the first output through min-max, back to full size."""
    import numpy as np
    import onnxruntime as ort
    from PIL import Image
    t0 = time.time()
    im = Image.open(image_path).convert("RGB")
    small = np.asarray(im.resize((320, 320), Image.LANCZOS), dtype=np.float32)
    small = small / max(1e-6, float(small.max()))
    mean, std = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)
    x = ((small - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    pred = sess.run(None, {sess.get_inputs()[0].name: x})[0][0, 0]
    lo, hi = float(pred.min()), float(pred.max())
    pred = (pred - lo) / max(1e-6, hi - lo)
    mask = Image.fromarray((pred * 255).astype(np.uint8)).resize(im.size, Image.LANCZOS)
    mask.save(out_path)
    a = np.asarray(mask, dtype=np.float32) / 255
    return {"engine": "u2net (onnxruntime, CPU)", "width": im.size[0], "height": im.size[1], "share": round(float((a > 0.5).mean()), 4), "seconds": round(time.time() - t0, 2)}


HUNYUAN3D_CKPT = "hunyuan3d-dit-v2_fp16.safetensors"


def hunyuan3d_workflow(image_name: str, c: dict) -> dict:
    """Hunyuan3D 2.0 single-view image-to-shape, the graph of Comfy-Org's template 3d_hunyuan3d_image_to_model.json."""
    return {
        "1": {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": HUNYUAN3D_CKPT}},
        "2": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "3": {"class_type": "CLIPVisionEncode", "inputs": {"clip_vision": ["1", 1], "image": ["2", 0], "crop": "center"}},
        "4": {"class_type": "Hunyuan3Dv2Conditioning", "inputs": {"clip_vision_output": ["3", 0]}},
        "5": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 1.0}},
        "6": {"class_type": "EmptyLatentHunyuan3Dv2", "inputs": {"resolution": c["resolution"], "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {"model": ["5", 0], "positive": ["4", 0], "negative": ["4", 1], "latent_image": ["6", 0], "seed": c["seed"],
                                                    "steps": c["steps"], "cfg": c["cfg"], "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0}},
        "8": {"class_type": "VAEDecodeHunyuan3D", "inputs": {"samples": ["7", 0], "vae": ["1", 2], "num_chunks": 8000, "octree_resolution": c["octree"]}},
        "9": {"class_type": "VoxelToMesh", "inputs": {"voxel": ["8", 0], "algorithm": "surface net", "threshold": 0.6}},
        "10": {"class_type": "SaveGLB", "inputs": {"mesh": ["9", 0], "filename_prefix": c["prefix"]}},
    }


def clean_mesh(spec: dict, job_id: str) -> dict:
    def num(v, d, lo, hi, cast=int):
        try:
            return min(hi, max(lo, cast(v)))
        except (TypeError, ValueError):
            return d
    return {"steps": num(spec.get("steps"), 30, 10, 60), "cfg": num(spec.get("cfg"), 5.5, 3.0, 9.0, float),
            "resolution": 3072, "octree": num(spec.get("octree"), 256, 128, 384),
            "seed": int(spec["seed"]) if isinstance(spec.get("seed"), int) else int.from_bytes(os.urandom(4), "big"),
            "prefix": f"chandra-mesh/{job_id}"}


class GpuFileLock:
    """The card lock every agent on this machine agrees on (2026-11-12 handoff, section 9).

    Same contract as fraymus-video-studio's studio/gpu_lock.py, so the two never paint at once: create the file
    exclusively, write the PID, hold it for the whole GPU job, delete it after; a lock older than `stale_s` is stale;
    waiters retry every 0.25 s for up to `wait_s`. The first line stays the bare PID the studio writes; a second line
    says who holds it and why. While held, the file's time is renewed every 60 s, so a long job never looks stale.
    """

    def __init__(self, path: str, holder: str, stale_s: float = 900, wait_s: float = 600):
        self.path, self.holder, self.stale_s, self.wait_s = path, holder, stale_s, wait_s
        self._fd = None
        self._stop = threading.Event()
        self._beat = None

    @staticmethod
    def read(path: str, stale_s: float = 900):
        """What the lock says right now, or None when nobody holds it."""
        if not path or not os.path.exists(path):
            return None
        try:
            age = time.time() - os.path.getmtime(path)
            with open(path, encoding="utf-8", errors="replace") as f:
                lines = f.read(400).splitlines()
        except OSError:
            return None
        return {"pid": (lines[0].strip() if lines else ""), "holder": (lines[1].strip() if len(lines) > 1 else "unknown (fraymus-video-studio writes only a PID)"),
                "ageS": round(age), "stale": age > stale_s, "mine": bool(lines) and lines[0].strip() == str(os.getpid())}

    def acquire(self, on_wait=None):
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        deadline = time.time() + self.wait_s
        while True:
            try:
                self._fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR)
                os.write(self._fd, f"{os.getpid()}\n{self.holder}\n".encode())
                self._beat = threading.Thread(target=self._renew, daemon=True)
                self._beat.start()
                return
            except FileExistsError:
                seen = GpuFileLock.read(self.path, self.stale_s)
                if seen and seen["stale"]:
                    try: os.remove(self.path)
                    except OSError: pass
                    continue
                if time.time() > deadline:
                    who = f"PID {seen['pid']} ({seen['holder']}), held {seen['ageS']} s" if seen else "another process"
                    raise TimeoutError(f"the card is locked by {who} at {self.path}; waited {round(self.wait_s)} s")
                if on_wait and seen:
                    on_wait(seen)
                time.sleep(0.25)

    def _renew(self):
        while not self._stop.wait(60):
            try: os.utime(self.path, None)
            except OSError: return

    def release(self):
        self._stop.set()
        if self._fd is not None:
            os.close(self._fd)
            self._fd = None
            try: os.remove(self.path)
            except OSError: pass


class Worker:
    def __init__(self, a):
        self.a = a
        self.name = a.name or socket.gethostname()
        self.work = os.path.abspath(a.work_dir)
        os.makedirs(self.work, exist_ok=True)
        with open(a.token_file, encoding="utf-8") as f:
            self.token = f.read().strip()
        if len(self.token) < 24:
            raise SystemExit("the token file must hold at least 24 characters")
        self.jobs: dict[str, dict] = {}
        self.lock = threading.Lock()
        self.busy: str | None = None
        self.comfy_child = None
        self.launcher = os.path.abspath(a.launcher or os.path.join(HERE, "..", "..", "server", "media", "pystudio", "chandra_studio.py"))
        self.shim = os.path.abspath(a.shim_dir or os.path.join(HERE, "..", "..", "server", "media", "pyshim"))
        self._cap = None
        self._cap_at = 0.0

    # ── capability ───────────────────────────────────────────────────────────────────────────────────
    def gpus(self):
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
            return [{"name": p[0].strip(), "totalMB": int(p[1]), "usedMB": int(p[2])} for p in (line.split(",") for line in out.strip().splitlines()) if len(p) == 3]
        except Exception:
            return []

    def comfy_alive(self):
        try:
            return http_json(self.a.comfy_url + "/system_stats", timeout=3)
        except Exception:
            return None

    def _models(self, sub):
        found = set()
        for base in (os.path.join(self.a.comfy_dir or "", "models"), self.a.models_dir):
            try:
                found.update(f for f in os.listdir(os.path.join(base, sub)) if f.lower().endswith((".safetensors", ".ckpt")))
            except Exception:
                pass
        return sorted(found)

    def render_workers(self):
        """How many processes the studio may use for frames. Its parallel mode needs fork, or the spawn fix in studio/core.py."""
        if self.a.studio_workers > 0:
            return self.a.studio_workers
        cores = max(1, min(8, (os.cpu_count() or 2) - 1))
        if sys.platform != "win32":
            return cores
        try:
            with open(os.path.join(self.a.studio_dir, "studio", "core.py"), encoding="utf-8") as f:
                return cores if "initializer=_init_worker" in f.read() else 1
        except Exception:
            return 1

    def capabilities(self, fresh=False):
        if self._cap and not fresh and time.time() - self._cap_at < 60:
            return self._cap
        stills = {"ready": False, "problems": [], "checkpoint": None, "vae": None}
        if not self.a.comfy_dir or not os.path.exists(os.path.join(self.a.comfy_dir, "main.py")):
            if self.comfy_alive():
                stills["problems"].append("ComfyUI answers but --comfy-dir is not set, so its models cannot be listed")
            else:
                stills["problems"].append("ComfyUI is not installed here (--comfy-dir)")
        else:
            cks = self._models("checkpoints")
            want = self.a.checkpoint
            stills["checkpoint"] = want if want in cks else None
            if not stills["checkpoint"]:
                stills["problems"].append(f"checkpoint {want} is not in models/checkpoints (found: {', '.join(cks) or 'none'})")
            stills["vae"] = self.a.vae if self.a.vae in self._models("vae") else None
            if not self.comfy_alive() and not (self.a.comfy_python and os.path.exists(self.a.comfy_python)):
                stills["problems"].append("ComfyUI is not running and --comfy-python is not set to start it")
        stills["ready"] = not stills["problems"]

        video = {"ready": False, "problems": [], "soundfile": None, "python": None}
        if not self.a.studio_dir or not os.path.exists(os.path.join(self.a.studio_dir, "studio", "__main__.py")):
            video["problems"].append("fraymus-video-studio is not here (--studio-dir)")
        if not os.path.exists(self.launcher):
            video["problems"].append(f"the studio launcher is missing ({self.launcher})")
        py = self.a.studio_python or sys.executable
        try:
            probe = "import importlib.util as u, json; print(json.dumps({m: u.find_spec(m) is not None for m in %r}))" % MODULES
            mods = json.loads(subprocess.run([py, "-I", "-c", probe], capture_output=True, text=True, timeout=30).stdout.strip().splitlines()[-1])
            missing = [m for m in ("numpy", "PIL", "scipy") if not mods.get(m)]
            if missing:
                video["problems"].append(f"{py} lacks {', '.join(missing)}")
            video["soundfile"] = "installed" if mods.get("soundfile") else ("stand-in" if os.path.exists(os.path.join(self.shim, "soundfile.py")) else None)
            if not video["soundfile"]:
                video["problems"].append("neither the soundfile package nor Chandra's stand-in is available")
            video["python"] = py
        except Exception as e:
            video["problems"].append(f"could not run {py}: {e.__class__.__name__}")
        if not shutil.which("ffmpeg"):
            video["problems"].append("ffmpeg is not on PATH")
        video["ready"] = not video["problems"]
        video["workers"] = self.render_workers() if self.a.studio_dir else None
        video["wordTiming"] = "faster-whisper " + self.studio_env().get("STUDIO_WHISPER", "") if "STUDIO_WHISPER" in self.studio_env() else "estimated from text length"
        i2v = {"ready": False, "problems": [], "engine": "wan2.2-ti2v-5b"}
        if not self.a.comfy_dir or not os.path.exists(os.path.join(self.a.comfy_dir, "main.py")):
            i2v["problems"].append("ComfyUI is not installed here (--comfy-dir)")
        else:
            missing = [f"{sub}/{name}" for sub, name in WAN_FILES.values() if name not in self._models(sub)]
            if missing:
                i2v["problems"].append("Wan 2.2 files missing: " + ", ".join(missing))
            if not os.path.exists(os.path.join(self.a.comfy_dir, "comfy_extras", "nodes_wan.py")):
                i2v["problems"].append("this ComfyUI has no Wan nodes (comfy_extras/nodes_wan.py)")
            if not self.comfy_alive() and not (self.a.comfy_python and os.path.exists(self.a.comfy_python)):
                i2v["problems"].append("ComfyUI is not running and --comfy-python is not set to start it")
        if not shutil.which("ffmpeg"):
            i2v["problems"].append("ffmpeg is not on PATH")
        i2v["ready"] = not i2v["problems"]
        mesh = {"ready": False, "problems": [], "engine": "hunyuan3d-2.0"}
        if not self.a.comfy_dir or not os.path.exists(os.path.join(self.a.comfy_dir, "main.py")):
            mesh["problems"].append("ComfyUI is not installed here (--comfy-dir)")
        else:
            if HUNYUAN3D_CKPT not in self._models("checkpoints"):
                mesh["problems"].append(f"checkpoints/{HUNYUAN3D_CKPT} is missing")
            if not os.path.exists(os.path.join(self.a.comfy_dir, "comfy_extras", "nodes_hunyuan3d.py")):
                mesh["problems"].append("this ComfyUI has no Hunyuan3D nodes (comfy_extras/nodes_hunyuan3d.py)")
            if not self.comfy_alive() and not (self.a.comfy_python and os.path.exists(self.a.comfy_python)):
                mesh["problems"].append("ComfyUI is not running and --comfy-python is not set to start it")
        mesh["ready"] = not mesh["problems"]
        stills["checkpoints"] = self._models("checkpoints") if self.a.comfy_dir else []
        # inpaint = the stills machinery with a mask; matte = U^2-Net on the CPU (no card, no lock)
        inpaint = {"ready": stills["ready"], "problems": list(stills["problems"]), "engine": "sdxl + latent noise mask"}
        matte = {"ready": False, "problems": [], "engine": "u2net (onnxruntime, CPU)", "model": self.a.u2net}
        if not self.a.u2net or not os.path.exists(self.a.u2net):
            matte["problems"].append(f"the U^2-Net model is not at {self.a.u2net} (--u2net)")
        try:
            import importlib.util as _u
            for m in ("onnxruntime", "numpy", "PIL"):
                if not _u.find_spec(m):
                    matte["problems"].append(f"the worker's Python has no {m}")
        except Exception as e:
            matte["problems"].append(f"could not check packages: {e.__class__.__name__}")
        matte["ready"] = not matte["problems"]
        self._cap = {"stills": stills, "i2v": i2v, "mesh": mesh, "video": video, "inpaint": inpaint, "matte": matte}
        self._cap_at = time.time()
        return self._cap

    def studio_env(self):
        """Extra environment for the render, from --studio-env KEY=VALUE. Word timing by Whisper is off unless a model is named, so nothing is downloaded."""
        extra = {}
        for item in self.a.studio_env or []:
            k, _, v = item.partition("=")
            if k.strip():
                extra[k.strip()] = v
        if "STUDIO_WHISPER" not in extra:
            extra["STUDIO_NO_WHISPER"] = "1"
        return extra

    def health(self):
        lock = GpuFileLock.read(self.a.gpu_lock) if self.a.gpu_lock else None
        return {"ok": True, "name": self.name, "host": socket.gethostname(), "version": VERSION, "platform": sys.platform, "gpus": self.gpus(),
                "capabilities": self.capabilities(), "busy": self.busy, "jobs": len(self.jobs),
                "gpuLock": {"path": self.a.gpu_lock, "held": bool(lock) and not lock["stale"], **(lock or {})} if self.a.gpu_lock else None}

    # ── jobs ─────────────────────────────────────────────────────────────────────────────────────────
    def job_dir(self, jid):
        return os.path.join(self.work, jid)

    def public(self, j):
        return {k: j[k] for k in ("id", "kind", "state", "stage", "progress", "error", "files", "receipt", "digest", "createdAt", "seconds")}

    def expire(self):
        now = time.time()
        for jid, j in list(self.jobs.items()):
            if j["state"] in ("done", "error") and now - j["createdAt"] > JOB_TTL_S:
                shutil.rmtree(self.job_dir(jid), ignore_errors=True)
                self.jobs.pop(jid, None)

    def submit(self, body):
        jid, nonce, kind = body.get("id"), body.get("nonce"), body.get("kind")
        if not isinstance(jid, str) or not SAFE_ID.match(jid):
            return 400, {"error": "id must be 3-61 letters, digits, - or _"}
        if not isinstance(nonce, str) or len(nonce) < 16:
            return 400, {"error": "nonce must be at least 16 characters"}
        if kind not in KINDS:
            return 400, {"error": "kind must be one of " + ", ".join(KINDS)}
        spec = body.get("spec") if isinstance(body.get("spec"), dict) else {}
        files = {}
        for name, b64 in (body.get("files") or {}).items():
            if not SAFE_NAME.match(str(name)):
                return 400, {"error": f"bad file name: {str(name)[:40]}"}
            try:
                files[name] = base64.b64decode(b64, validate=True)
            except Exception:
                return 400, {"error": f"file {name} is not base64"}
        digest = job_digest(kind, spec, files)
        with self.lock:
            self.expire()
            old = self.jobs.get(jid)
            if old:
                if old["digest"] != digest:
                    return 409, {"error": "this id was already used for different content", "digest": old["digest"]}
                return 200, {**self.public(old), "duplicate": True}        # the same job: never run twice
            cap = self.capabilities()[kind]
            if not cap["ready"]:
                return 422, {"error": f"this machine cannot do {kind}: " + "; ".join(cap["problems"])}
            if self.busy:
                return 429, {"error": "busy", "busy": self.busy}
            d = self.job_dir(jid)
            shutil.rmtree(d, ignore_errors=True)
            os.makedirs(os.path.join(d, "in"))
            os.makedirs(os.path.join(d, "out"))
            for name, data in files.items():
                with open(os.path.join(d, "in", name), "wb") as f:
                    f.write(data)
            j = {"id": jid, "kind": kind, "nonce": nonce, "digest": digest, "spec": spec, "state": "running", "stage": "starting", "progress": 0.0,
                 "error": None, "files": [], "receipt": None, "createdAt": time.time(), "seconds": None, "lines": {}}
            self.jobs[jid] = j
            self.busy = jid
        threading.Thread(target=self.run, args=(j,), daemon=True).start()
        return 202, self.public(j)

    def run(self, j):
        t0 = time.time()
        try:
            {"stills": self.run_stills, "i2v": self.run_i2v, "mesh": self.run_mesh, "video": self.run_video, "inpaint": self.run_inpaint, "matte": self.run_matte}[j["kind"]](j)
            out_dir = os.path.join(self.job_dir(j["id"]), "out")
            j["files"] = [{"name": n, "bytes": os.path.getsize(os.path.join(out_dir, n)), "sha256": sha256_file(os.path.join(out_dir, n))}
                          for n in sorted(os.listdir(out_dir)) if os.path.isfile(os.path.join(out_dir, n)) and SAFE_NAME.match(n)]
            j["seconds"] = round(time.time() - t0, 1)
            # The receipt binds this result to the request: the caller's nonce, the content digest and every output's hash
            j["receipt"] = {"id": j["id"], "nonce": j["nonce"], "digest": j["digest"], "worker": self.name, "kind": j["kind"], "seconds": j["seconds"],
                            "outputs": {f["name"]: f["sha256"] for f in j["files"]}, "detail": j.get("detail"), "finishedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            j["state"], j["stage"], j["progress"] = "done", "done", 1.0
        except Exception as e:
            j["state"], j["error"], j["seconds"] = "error", f"{e.__class__.__name__}: {e}"[:600], round(time.time() - t0, 1)
        finally:
            with self.lock:
                self.busy = None

    # ── stills ───────────────────────────────────────────────────────────────────────────────────────
    def ensure_comfy(self):
        stats = self.comfy_alive()
        if stats:
            return stats
        if not (self.a.comfy_python and os.path.exists(self.a.comfy_python)):
            raise RuntimeError("ComfyUI is not running and cannot be started (--comfy-python)")
        port = self.a.comfy_url.rsplit(":", 1)[-1].strip("/")
        self.comfy_child = subprocess.Popen([self.a.comfy_python, "main.py", "--listen", "127.0.0.1", "--port", port, "--disable-auto-launch"] + (["--lowvram"] if self.a.lowvram else []),
                                            cwd=self.a.comfy_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + 240
        while time.time() < deadline:
            stats = self.comfy_alive()
            if stats:
                return stats
            if self.comfy_child.poll() is not None:
                raise RuntimeError(f"ComfyUI exited while starting (code {self.comfy_child.returncode})")
            time.sleep(1.5)
        raise RuntimeError("ComfyUI did not answer within 240 s")

    def free_ollama(self):
        """Give the card to the render: ask a local Ollama to unload whatever it holds."""
        if not self.a.ollama_url:
            return []
        freed = []
        try:
            for m in http_json(self.a.ollama_url + "/api/ps", timeout=5).get("models", []):
                http_json(self.a.ollama_url + "/api/generate", {"model": m["name"], "keep_alive": 0}, timeout=30)
                freed.append(m["name"])
        except Exception:
            pass
        return freed

    def run_stills(self, j):
        items = [clean_still(it) for it in (j["spec"].get("items") or [])][:8]
        if not items:
            raise ValueError("no stills were asked for")
        cap = self.capabilities()["stills"]
        lock = None
        if self.a.gpu_lock:
            j["stage"] = "waiting for the card"
            lock = GpuFileLock(self.a.gpu_lock, f"chandra-worker stills {j['id']} ({len(items)} picture{'s' if len(items) != 1 else ''})")
            lock.acquire(on_wait=lambda seen: j.__setitem__("stage", f"waiting for the card (held by {seen['holder'][:60]}, {seen['ageS']} s)"))
        try:
            self.paint(j, items, cap)
        finally:
            if lock:
                lock.release()

    def paint(self, j, items, cap):
        j["stage"] = "freeing the card"
        freed = self.free_ollama()
        j["stage"] = "starting ComfyUI"
        self.ensure_comfy()
        out_dir = os.path.join(self.job_dir(j["id"]), "out")
        detail = {"unloaded": freed, "checkpoint": cap["checkpoint"], "gpuLock": self.a.gpu_lock or None, "items": []}
        on_disk = set(self._models("checkpoints"))
        try:
            for i, item in enumerate(items):
                j["stage"], j["progress"] = f"painting {i + 1} of {len(items)}", i / len(items)
                s0 = time.time()
                # an item may ask for another SDXL-family checkpoint; only a file that is really on disk is used
                ckpt = item["checkpoint"] if item.get("checkpoint") in on_disk else cap["checkpoint"]
                try:
                    pid = http_json(self.a.comfy_url + "/prompt", {"prompt": sdxl_workflow(item, ckpt, cap["vae"])}, timeout=60).get("prompt_id")
                    if not pid:
                        raise RuntimeError("ComfyUI refused the workflow")
                    image, deadline = None, time.time() + STILL_TIMEOUT_S
                    while time.time() < deadline and not image:
                        time.sleep(1.5)
                        entry = http_json(f"{self.a.comfy_url}/history/{pid}", timeout=10).get(pid)
                        if not entry:
                            continue
                        if (entry.get("status") or {}).get("status_str") == "error":
                            raise RuntimeError("ComfyUI reported a render error")
                        images = [im for o in (entry.get("outputs") or {}).values() for im in (o.get("images") or [])]
                        image = images[0] if images else None
                    if not image:
                        raise RuntimeError(f"no image after {STILL_TIMEOUT_S} s")
                    q = urllib.parse.urlencode({"filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": image.get("type", "output")})
                    with urllib.request.urlopen(f"{self.a.comfy_url}/view?{q}", timeout=60) as r:
                        data = r.read()
                    name = f"still-{i:02d}.png"
                    with open(os.path.join(out_dir, name), "wb") as f:
                        f.write(data)
                    detail["items"].append({"ok": True, "file": name, "checkpoint": ckpt, "seed": item["seed"], "width": item["width"], "height": item["height"], "steps": item["steps"], "seconds": round(time.time() - s0, 1)})
                except Exception as e:
                    detail["items"].append({"ok": False, "error": f"{e.__class__.__name__}: {e}"[:300], "seconds": round(time.time() - s0, 1)})
        finally:
            try:
                http_json(self.a.comfy_url + "/free", {"unload_models": True, "free_memory": True}, timeout=15)
            except Exception:
                pass
        j["detail"] = detail
        if not any(it["ok"] for it in detail["items"]):
            raise RuntimeError("no still could be painted: " + detail["items"][0].get("error", "unknown"))

    # ── i2v: a still set in motion ───────────────────────────────────────────────────────────────────
    def run_i2v(self, j):
        """start.png + a motion prompt -> clip.mp4 (24 fps). Holds the card lock for the whole job, like stills."""
        c = clean_i2v(j["spec"], j["id"])
        start = os.path.join(self.job_dir(j["id"]), "in", "start.png")
        if not os.path.exists(start):
            raise ValueError("start.png is missing")
        lock = None
        if self.a.gpu_lock:
            j["stage"] = "waiting for the card"
            lock = GpuFileLock(self.a.gpu_lock, f"chandra-worker i2v {j['id']} ({c['frames']} frames, Wan 2.2)")
            lock.acquire(on_wait=lambda seen: j.__setitem__("stage", f"waiting for the card (held by {seen['holder'][:60]}, {seen['ageS']} s)"))
        made, input_name = [], f"chandra-i2v-{j['id']}.png"
        input_path = os.path.join(self.a.comfy_dir, "input", input_name)
        try:
            j["stage"] = "freeing the card"
            freed = self.free_ollama()
            j["stage"] = "starting ComfyUI"
            self.ensure_comfy()
            os.makedirs(os.path.dirname(input_path), exist_ok=True)
            shutil.copyfile(start, input_path)
            t0 = time.time()
            pid = http_json(self.a.comfy_url + "/prompt", {"prompt": wan_workflow(input_name, c)}, timeout=60).get("prompt_id")
            if not pid:
                raise RuntimeError("ComfyUI refused the Wan workflow")
            images, deadline = None, time.time() + I2V_TIMEOUT_S
            while time.time() < deadline and images is None:
                time.sleep(2)
                el = time.time() - t0
                j["stage"], j["progress"] = f"animating ({round(el)} s)", min(0.9, el / 400)
                entry = http_json(f"{self.a.comfy_url}/history/{pid}", timeout=10).get(pid)
                if not entry:
                    continue
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    msgs = [m[1].get("exception_message", "") for m in status.get("messages", []) if m and m[0] == "execution_error"]
                    raise RuntimeError("ComfyUI reported an error: " + (msgs[0][:300] if msgs else "unknown"))
                if status.get("completed"):
                    images = [im for o in (entry.get("outputs") or {}).values() for im in (o.get("images") or [])]
            if not images:
                raise RuntimeError(f"no frames after {I2V_TIMEOUT_S} s")
            gen_s = round(time.time() - t0, 1)
            j["stage"], j["progress"] = "encoding", 0.93
            frames_dir = os.path.join(self.job_dir(j["id"]), "frames")
            os.makedirs(frames_dir, exist_ok=True)
            out_root = os.path.realpath(os.path.join(self.a.comfy_dir, "output"))
            for k, im in enumerate(sorted(images, key=lambda x: x["filename"])):
                q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
                with urllib.request.urlopen(f"{self.a.comfy_url}/view?{q}", timeout=60) as r:
                    data = r.read()
                with open(os.path.join(frames_dir, f"f{k + 1:05d}.png"), "wb") as f:
                    f.write(data)
                p = os.path.realpath(os.path.join(out_root, im.get("subfolder", ""), im["filename"]))
                if p.startswith(out_root + os.sep):
                    made.append(p)
            clip = os.path.join(self.job_dir(j["id"]), "out", "clip.mp4")
            enc = subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(I2V_FPS), "-i", os.path.join(frames_dir, "f%05d.png"),
                                  "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", clip],
                                 capture_output=True, text=True, timeout=300)
            if enc.returncode != 0:
                raise RuntimeError("ffmpeg could not encode the frames: " + enc.stderr.strip()[-300:])
            shutil.rmtree(frames_dir, ignore_errors=True)
            j["detail"] = {"engine": "wan2.2-ti2v-5b", "frames": len(images), "fps": I2V_FPS, "width": c["width"], "height": c["height"],
                           "steps": c["steps"], "seed": c["seed"], "generateSeconds": gen_s, "unloaded": freed, "gpuLock": self.a.gpu_lock or None}
        finally:
            for p in made + [input_path]:
                try: os.remove(p)
                except OSError: pass
            try:
                http_json(self.a.comfy_url + "/free", {"unload_models": True, "free_memory": True}, timeout=15)
            except Exception:
                pass
            if lock:
                lock.release()

    # ── matte and inpaint: a scene split into layers ─────────────────────────────────────────────────
    def run_matte(self, j):
        """image.png -> mask.png (8-bit, same size; white = the subject). CPU only, so no card lock."""
        src = os.path.join(self.job_dir(j["id"]), "in", "image.png")
        if not os.path.exists(src):
            raise ValueError("image.png is missing")
        j["stage"] = "finding the subject (U^2-Net)"
        j["detail"] = u2net_mask(self.a.u2net, src, os.path.join(self.job_dir(j["id"]), "out", "mask.png"))

    def run_inpaint(self, j):
        """image.png (alpha 0 = repaint) -> plate.png. Holds the card lock like stills."""
        c = clean_inpaint(j["spec"], j["id"])
        src = os.path.join(self.job_dir(j["id"]), "in", "image.png")
        if not os.path.exists(src):
            raise ValueError("image.png is missing")
        cap = self.capabilities()["stills"]
        lock = None
        if self.a.gpu_lock:
            j["stage"] = "waiting for the card"
            lock = GpuFileLock(self.a.gpu_lock, f"chandra-worker inpaint {j['id']}")
            lock.acquire(on_wait=lambda seen: j.__setitem__("stage", f"waiting for the card (held by {seen['holder'][:60]}, {seen['ageS']} s)"))
        made, input_name = [], f"chandra-inpaint-{j['id']}.png"
        input_path = os.path.join(self.a.comfy_dir, "input", input_name)
        try:
            j["stage"] = "freeing the card"
            freed = self.free_ollama()
            j["stage"] = "starting ComfyUI"
            self.ensure_comfy()
            os.makedirs(os.path.dirname(input_path), exist_ok=True)
            shutil.copyfile(src, input_path)
            t0 = time.time()
            pid = http_json(self.a.comfy_url + "/prompt", {"prompt": inpaint_workflow(input_name, c, cap["checkpoint"], cap["vae"])}, timeout=60).get("prompt_id")
            if not pid:
                raise RuntimeError("ComfyUI refused the inpaint workflow")
            image, deadline = None, time.time() + STILL_TIMEOUT_S
            while time.time() < deadline and not image:
                time.sleep(1.5)
                j["stage"] = f"repainting the background ({round(time.time() - t0)} s)"
                entry = http_json(f"{self.a.comfy_url}/history/{pid}", timeout=10).get(pid)
                if not entry:
                    continue
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    msgs = [m[1].get("exception_message", "") for m in status.get("messages", []) if m and m[0] == "execution_error"]
                    raise RuntimeError("ComfyUI reported an error: " + (msgs[0][:300] if msgs else "unknown"))
                images = [im for o in (entry.get("outputs") or {}).values() for im in (o.get("images") or [])]
                image = images[0] if images else None
            if not image:
                raise RuntimeError(f"no picture after {STILL_TIMEOUT_S} s")
            q = urllib.parse.urlencode({"filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": image.get("type", "output")})
            with urllib.request.urlopen(f"{self.a.comfy_url}/view?{q}", timeout=60) as r:
                data = r.read()
            with open(os.path.join(self.job_dir(j["id"]), "out", "plate.png"), "wb") as f:
                f.write(data)
            out_root = os.path.realpath(os.path.join(self.a.comfy_dir, "output"))
            p = os.path.realpath(os.path.join(out_root, image.get("subfolder", ""), image["filename"]))
            if p.startswith(out_root + os.sep):
                made.append(p)
            j["detail"] = {"engine": "sdxl inpaint (latent noise mask)", "checkpoint": cap["checkpoint"], "steps": c["steps"], "denoise": c["denoise"], "seed": c["seed"],
                           "generateSeconds": round(time.time() - t0, 1), "unloaded": freed, "gpuLock": self.a.gpu_lock or None}
        finally:
            for p in made + [input_path]:
                try: os.remove(p)
                except OSError: pass
            try:
                http_json(self.a.comfy_url + "/free", {"unload_models": True, "free_memory": True}, timeout=15)
            except Exception:
                pass
            if lock:
                lock.release()

    # ── mesh: a picture made into a 3-D model ────────────────────────────────────────────────────────
    def run_mesh(self, j):
        """start.png -> model.glb (Hunyuan3D 2.0 shape, no texture). Holds the card lock like stills and i2v."""
        c = clean_mesh(j["spec"], j["id"])
        start = os.path.join(self.job_dir(j["id"]), "in", "start.png")
        if not os.path.exists(start):
            raise ValueError("start.png is missing")
        lock = None
        if self.a.gpu_lock:
            j["stage"] = "waiting for the card"
            lock = GpuFileLock(self.a.gpu_lock, f"chandra-worker mesh {j['id']} (Hunyuan3D 2.0)")
            lock.acquire(on_wait=lambda seen: j.__setitem__("stage", f"waiting for the card (held by {seen['holder'][:60]}, {seen['ageS']} s)"))
        made, input_name = [], f"chandra-mesh-{j['id']}.png"
        input_path = os.path.join(self.a.comfy_dir, "input", input_name)
        try:
            j["stage"] = "freeing the card"
            freed = self.free_ollama()
            j["stage"] = "starting ComfyUI"
            self.ensure_comfy()
            os.makedirs(os.path.dirname(input_path), exist_ok=True)
            shutil.copyfile(start, input_path)
            t0 = time.time()
            sent = http_json(self.a.comfy_url + "/prompt", {"prompt": hunyuan3d_workflow(input_name, c)}, timeout=60)
            pid = sent.get("prompt_id")
            if not pid:
                raise RuntimeError("ComfyUI refused the Hunyuan3D workflow: " + json.dumps(sent.get("node_errors") or sent.get("error") or {})[:300])
            files, deadline = None, time.time() + I2V_TIMEOUT_S
            while time.time() < deadline and files is None:
                time.sleep(2)
                el = time.time() - t0
                j["stage"], j["progress"] = f"shaping ({round(el)} s)", min(0.9, el / 180)
                entry = http_json(f"{self.a.comfy_url}/history/{pid}", timeout=10).get(pid)
                if not entry:
                    continue
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    msgs = [m[1].get("exception_message", "") for m in status.get("messages", []) if m and m[0] == "execution_error"]
                    raise RuntimeError("ComfyUI reported an error: " + (msgs[0][:300] if msgs else "unknown"))
                if status.get("completed"):
                    files = [f for o in (entry.get("outputs") or {}).values() for v in o.values() if isinstance(v, list)
                             for f in v if isinstance(f, dict) and str(f.get("filename", "")).lower().endswith(".glb")]
            if not files:
                raise RuntimeError(f"no .glb after {I2V_TIMEOUT_S} s" if files is None else "ComfyUI finished without a .glb")
            f0 = files[0]
            q = urllib.parse.urlencode({"filename": f0["filename"], "subfolder": f0.get("subfolder", ""), "type": f0.get("type", "output")})
            with urllib.request.urlopen(f"{self.a.comfy_url}/view?{q}", timeout=120) as r:
                data = r.read()
            with open(os.path.join(self.job_dir(j["id"]), "out", "model.glb"), "wb") as f:
                f.write(data)
            out_root = os.path.realpath(os.path.join(self.a.comfy_dir, "output"))
            p = os.path.realpath(os.path.join(out_root, f0.get("subfolder", ""), f0["filename"]))
            if p.startswith(out_root + os.sep):
                made.append(p)
            j["detail"] = {"engine": "hunyuan3d-2.0", "steps": c["steps"], "cfg": c["cfg"], "octree": c["octree"], "seed": c["seed"],
                           "bytes": len(data), "generateSeconds": round(time.time() - t0, 1), "unloaded": freed, "gpuLock": self.a.gpu_lock or None}
        finally:
            for p in made + [input_path]:
                try: os.remove(p)
                except OSError: pass
            try:
                http_json(self.a.comfy_url + "/free", {"unload_models": True, "free_memory": True}, timeout=15)
            except Exception:
                pass
            if lock:
                lock.release()

    # ── video ────────────────────────────────────────────────────────────────────────────────────────
    def voice_for(self, jid, text):
        j = self.jobs.get(jid)
        if not j or j["state"] != "running":
            return None
        name = j["lines"].get(norm_line(text))
        path = os.path.join(self.job_dir(jid), "in", name) if name else None
        return path if path and os.path.exists(path) else None

    def run_video(self, j):
        spec, d = j["spec"], self.job_dir(j["id"])
        style, fmt = spec.get("recipe") or spec.get("style"), spec.get("format", "16:9")
        pages_only = spec.get("pagesOnly") is True
        if style not in ("8bit", "2bit", "cartoon", "comic-strip", "explainer"):
            raise ValueError("recipe must be 8bit, 2bit, cartoon, comic-strip or explainer")
        if pages_only and style != "comic-strip":
            raise ValueError("only a comic can be made as pages alone")
        if fmt not in ("16:9", "9:16", "1:1"):
            raise ValueError("unknown format")
        script = os.path.join(d, "in", "script.md")
        if not os.path.exists(script):
            raise ValueError("script.md is missing")
        silent = spec.get("voice") == "silent"
        for line in spec.get("lines") or []:
            if not SAFE_NAME.match(str(line.get("file", ""))) or not os.path.exists(os.path.join(d, "in", line["file"])):
                raise ValueError(f"voice file missing for a line: {str(line.get('file'))[:40]}")
            j["lines"][norm_line(line.get("text"))] = line["file"]
        cap = self.capabilities()["video"]
        out_dir = os.path.join(d, "render")
        env = {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOME") if k in os.environ}
        env.update({"PYTHONUNBUFFERED": "1", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "NO_PROXY": "127.0.0.1,localhost," + self.a.bind,
                    "STUDIO_TTS_URL": f"http://{self.a.bind}:{self.a.port}/voice/{j['id']}", "STUDIO_TTS_TOKEN": self.token,
                    "PYTHONPATH": os.pathsep.join([self.a.studio_dir] + ([self.shim] if cap["soundfile"] != "installed" else []))})
        env.update(self.studio_env())
        if os.path.exists(os.path.join(d, "in", "cast.json")):
            env["CHANDRA_SPRITES"] = os.path.join(d, "in", "cast.json")
        workers = str(self.render_workers())
        args = [cap["python"], self.launcher, "render", script] + (["--set", "video=false"] if pages_only else []) + ["--recipe", style, "-o", out_dir, "--workers", workers, "--voice", "silent" if silent else "http", "--format", fmt]
        j["stage"] = "rendering"
        tail = []
        p = subprocess.Popen(args, cwd=self.a.studio_dir, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
        killer = threading.Timer(VIDEO_TIMEOUT_S, p.kill)
        killer.start()
        try:
            for line in p.stderr:
                line = line.rstrip()
                if not line:
                    continue
                tail.append(line)
                del tail[:-40]
                m = re.match(r"^\[studio\] (\w+)(?: (\d+)%)?", line)
                if m:
                    stage, pct = m.group(1), int(m.group(2) or 0)
                    j["stage"] = {"plan": "voicing", "audio": "mixing", "frames": "rendering", "encode": "encoding"}.get(stage, stage)
                    j["progress"] = {"plan": 0.08, "audio": 0.18, "encode": 0.93}.get(stage, 0.22 + 0.7 * pct / 100)
            p.wait()
        finally:
            killer.cancel()
        result = None
        try:
            with open(os.path.join(out_dir, "result.json"), encoding="utf-8") as f:
                result = json.load(f)
        except Exception:
            pass
        if p.returncode != 0 or not (result and result.get("ok")):
            shown = [l for l in tail if not l.startswith("[studio]")][-4:] or tail[-2:]
            raise RuntimeError(f"the studio stopped (exit {p.returncode}): " + " | ".join(shown)[:400])
        kept = 0
        for path in result.get("files") or []:
            base = os.path.basename(path)
            if os.path.exists(path) and SAFE_NAME.match(base):
                shutil.copyfile(path, os.path.join(d, "out", base))
                kept += 1
        made = os.listdir(os.path.join(d, "out"))
        if not pages_only and not any(n.endswith("_master.mp4") for n in made):
            raise RuntimeError("the studio finished without a master video")
        if pages_only and not any(re.match(r"page_\d+\.png$", n) for n in made):
            raise RuntimeError("the studio finished without any comic page")
        shutil.rmtree(out_dir, ignore_errors=True)
        j["detail"] = {"duration_s": result.get("duration_s"), "render_s": result.get("render_s"), "workers": int(workers), "files": kept,
                       "castInstalled": any("[chandra] cast" in l for l in tail), "python": cap["python"]}

    def ack(self, jid, nonce):
        j = self.jobs.get(jid)
        if not j:
            return 404, {"error": "no such job"}
        if not hmac.compare_digest(str(nonce or ""), j["nonce"]):
            return 403, {"error": "nonce does not match"}
        if j["state"] == "running":
            return 409, {"error": "still running"}
        shutil.rmtree(self.job_dir(jid), ignore_errors=True)
        self.jobs.pop(jid, None)
        return 200, {"acknowledged": True}


def make_handler(w: Worker):
    class H(BaseHTTPRequestHandler):
        server_version = "chandra-worker/" + VERSION
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def send(self, code, obj=None, raw=None, ctype="application/json"):
            body = raw if raw is not None else json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def authed(self):
            got = self.headers.get("Authorization", "")
            return got.startswith("Bearer ") and hmac.compare_digest(got[7:].strip(), w.token)

        def body(self):
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            if not self.authed():
                return self.send(401, {"error": "unauthorized"})
            parts = [p for p in self.path.split("?")[0].split("/") if p]
            if parts == ["health"]:
                return self.send(200, w.health())
            if len(parts) == 2 and parts[0] == "jobs":
                j = w.jobs.get(parts[1])
                return self.send(200, w.public(j)) if j else self.send(404, {"error": "no such job"})
            if len(parts) == 4 and parts[0] == "jobs" and parts[2] == "files" and SAFE_NAME.match(parts[3]) and SAFE_ID.match(parts[1]):
                path = os.path.join(w.job_dir(parts[1]), "out", parts[3])
                if parts[1] in w.jobs and os.path.isfile(path):
                    with open(path, "rb") as f:
                        return self.send(200, raw=f.read(), ctype="application/octet-stream")
            return self.send(404, {"error": "not found"})

        def do_POST(self):
            if not self.authed():
                return self.send(401, {"error": "unauthorized"})
            parts = [p for p in self.path.split("?")[0].split("/") if p]
            try:
                body = self.body()
            except Exception as e:
                return self.send(400, {"error": f"bad request body: {e}"[:200]})
            if parts == ["jobs"]:
                code, obj = w.submit(body)
                return self.send(code, obj)
            if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "ack":
                code, obj = w.ack(parts[1], body.get("nonce"))
                return self.send(code, obj)
            if len(parts) == 2 and parts[0] == "voice":           # the studio asking for a line the hub already recorded
                path = w.voice_for(parts[1], body.get("text"))
                if not path:
                    return self.send(404, {"error": "no recording for that line"})
                with open(path, "rb") as f:
                    return self.send(200, raw=f.read(), ctype="audio/wav")
            return self.send(404, {"error": "not found"})
    return H


def main(argv=None):
    import urllib.parse  # noqa: F401  (used by run_stills)
    ap = argparse.ArgumentParser(description="Chandra worker: stills and film renders for the hub, over the private network")
    ap.add_argument("--bind", default=os.environ.get("CHANDRA_WORKER_BIND", "127.0.0.1"), help="address to listen on: this machine's Tailscale address")
    ap.add_argument("--port", type=int, default=int(os.environ.get("CHANDRA_WORKER_PORT", "47210")))
    ap.add_argument("--token-file", default=os.environ.get("CHANDRA_WORKER_TOKEN_FILE", "worker-token.txt"))
    ap.add_argument("--name", default=os.environ.get("CHANDRA_WORKER_NAME"))
    ap.add_argument("--work-dir", default=os.environ.get("CHANDRA_WORKER_DIR", os.path.join(HERE, "work")))
    ap.add_argument("--comfy-dir", default=os.environ.get("CHANDRA_WORKER_COMFY_DIR"))
    ap.add_argument("--comfy-python", default=os.environ.get("CHANDRA_WORKER_COMFY_PYTHON"))
    ap.add_argument("--comfy-url", default=os.environ.get("CHANDRA_WORKER_COMFY_URL", "http://127.0.0.1:8188"))
    ap.add_argument("--checkpoint", default="sd_xl_base_1.0.safetensors")
    ap.add_argument("--vae", default="sdxl_vae.safetensors")
    ap.add_argument("--models-dir", default=os.environ.get("CHANDRA_WORKER_MODELS_DIR", ""), help="a folder with checkpoints/ and vae/ outside ComfyUI (listed in its extra_model_paths.yaml)")
    ap.add_argument("--studio-workers", type=int, default=0, help="processes for frame rendering; 0 = decide (1 on Windows unless the studio has the spawn fix)")
    ap.add_argument("--studio-env", action="append", default=[], metavar="KEY=VALUE", help="extra environment for the render, e.g. STUDIO_WHISPER=small.en HF_HOME=D:/Models/huggingface HF_HUB_OFFLINE=1")
    ap.add_argument("--lowvram", action="store_true", help="start ComfyUI with --lowvram (cards with 8 GB)")
    ap.add_argument("--ollama-url", default=os.environ.get("CHANDRA_WORKER_OLLAMA_URL", ""), help="a local Ollama to unload before painting, e.g. http://127.0.0.1:11434")
    ap.add_argument("--gpu-lock", default=os.environ.get("CHANDRA_WORKER_GPU_LOCK", ""), help="the card lock shared with other agents on this machine, e.g. D:/Models/fraymus/gpu.lock (held for every stills job)")
    ap.add_argument("--u2net", default=os.environ.get("CHANDRA_WORKER_U2NET", r"D:\Models\fraymus\rembg\models\u2net\u2net.onnx"), help="U^2-Net ONNX file for the matte kind (rembg's model; never downloaded by the worker)")
    ap.add_argument("--studio-dir", default=os.environ.get("CHANDRA_WORKER_STUDIO_DIR"))
    ap.add_argument("--studio-python", default=os.environ.get("CHANDRA_WORKER_STUDIO_PYTHON"))
    ap.add_argument("--launcher", default=None)
    ap.add_argument("--shim-dir", default=None)
    ap.add_argument("--allow-any-address", action="store_true", help="permit binding to 0.0.0.0 (not recommended)")
    ap.add_argument("--check", action="store_true", help="print what this machine can do and exit")
    a = ap.parse_args(argv)
    if a.bind in ("0.0.0.0", "::") and not a.allow_any_address:
        raise SystemExit("refusing to listen on every address; pass this machine's private address with --bind")
    w = Worker(a)
    if a.check:
        h = w.health()
        print(json.dumps(h, indent=2))
        return 0 if all(c["ready"] for c in h["capabilities"].values()) else 1
    srv = ThreadingHTTPServer((a.bind, a.port), make_handler(w))
    print(f"chandra-worker {VERSION} '{w.name}' listening on http://{a.bind}:{a.port}", flush=True)
    for kind, c in w.capabilities().items():
        print(f"  {kind}: {'ready' if c['ready'] else 'NOT ready - ' + '; '.join(c['problems'])}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if w.comfy_child and w.comfy_child.poll() is None:
            w.comfy_child.kill()
    return 0


if __name__ == "__main__":
    import urllib.parse
    sys.exit(main())
