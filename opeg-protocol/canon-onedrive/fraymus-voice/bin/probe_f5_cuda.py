"""probe_f5_cuda — load F5-TTS v1 (CUDA) and clone the stored ref for a test sentence.

Run on the seat:
  %USERPROFILE%/voice-venv/Scripts/python.exe %USERPROFILE%/hermes-memory-workspace/fraymus-voice/bin/probe_f5_cuda.py
Acceptance: full-length output at his measured pace + f5tts.transcribe round-trip
contains every input word.
"""
import os
import sys
import time

STORE = os.path.expanduser(r"~\voice-models\my-voice")

TEXT = "Welcome back. Your voice is awake again."

# torchaudio>=2.9 on Windows routes .load() through torchcodec (not installable here);
# fall back to soundfile-based loading
def _fix_torchaudio_load():
    import torchaudio as _ta, soundfile as _sf, torch as _t
    if getattr(_ta, "_pvs_load_shim", False):
        return
    _orig = _ta.load
    def _load(uri, *a, **kw):
        try:
            return _orig(uri, *a, **kw)
        except Exception:
            data, sr = _sf.read(uri, always_2d=True, dtype="float32")
            return _t.from_numpy(data.T), sr
    _ta.load = _load
    _ta._pvs_load_shim = True

_fix_torchaudio_load()

print("loading F5TTS v1_Base (CUDA)...", flush=True)
t0 = time.time()
from f5_tts.api import F5TTS
f5tts = F5TTS()
print(f"load: {time.time()-t0:.1f}s device={f5tts.device}", flush=True)

ref_txt = open(os.path.join(STORE, "ref.txt")).read().strip()
t0 = time.time()
wav, sr, _spec = f5tts.infer(
    ref_file=os.path.join(STORE, "ref.wav"),
    ref_text=ref_txt,
    gen_text=TEXT,
    remove_silence=False,
)
dur = len(wav) / sr
print(f"infer wall: {time.time()-t0:.1f}s -> {dur:.2f}s audio @ {sr} (gen pace {dur/max(len(TEXT.split()),1):.2f}s/word)", flush=True)

import soundfile as sf
out = os.path.join(STORE, "probe_out.wav")
sf.write(out, wav, sr, subtype="PCM_16")
print("wrote:", out, os.path.getsize(out), "bytes", flush=True)

print("transcribing the output...", flush=True)
t0 = time.time()
txt = f5tts.transcribe(out)
words_out = str(txt).lower().split()
words_in = TEXT.lower().split()
missing = [w for w in words_in if w not in words_out]
print(f"transcribe: {time.time()-t0:.1f}s ->", str(txt)[:300], flush=True)
print("ROUND-TRIP:", "PASS" if not missing else f"MISSING {missing}", flush=True)