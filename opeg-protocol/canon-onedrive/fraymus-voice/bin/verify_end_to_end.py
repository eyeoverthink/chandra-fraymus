"""verify_end_to_end — POST /speak to the bridge and confirm the clone round-trips.

Run on the seat:
  %USERPROFILE%/voice-venv/Scripts/python.exe %USERPROFILE%/hermes-memory-workspace/fraymus-voice/bin/verify_end_to_end.py
"""
import json
import os
import urllib.request

STORE = os.path.expanduser(r"~\voice-models\my-voice")

text = "Nola is on the fast machine now. This is your voice, verified."
req = urllib.request.Request(
    "http://127.0.0.1:9099/speak",
    data=json.dumps({"text": text, "voice": "nola"}).encode(),
    headers={"Content-Type": "application/json"})
r = urllib.request.urlopen(req, timeout=180)
wav = r.read()
print("speak HTTP", r.status, "-", len(wav), "bytes")

out = os.path.join(STORE, "bridge_verify.wav")
with open(out, "wb") as f:
    f.write(wav)
print("wrote", out)
import soundfile as sf
d, sr = sf.read(out)
print(f"{len(d)/sr:.2f}s @ {sr} (pace {len(d)/sr/max(len(text.split()),1):.2f}s/word)")

from f5_tts.infer.utils_infer import transcribe
txt = transcribe(out)
print("ROUND-TRIP:", txt)
missing = [w for w in text.lower().split() if w not in str(txt).lower()]
print("VERDICT:", "PASS" if not missing else f"MISSING {missing}")