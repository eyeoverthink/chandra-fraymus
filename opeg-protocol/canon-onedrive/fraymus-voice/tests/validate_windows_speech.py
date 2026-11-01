"""Explicit real-Windows smoke check; never invoked by unittest discovery."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import wave


ROOT = Path(__file__).resolve().parents[1]
TEXT = "Fraymus local voice is ready."


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def validate(port, receipt_path):
    if sys.platform != "win32":
        raise RuntimeError("This explicit smoke check requires Windows.")
    # Read-only connection probe: never stop or replace an existing listener.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise RuntimeError(f"Port {port} already has a listener; choose another unused port.")
    scratch_root = ROOT / ".test-scratch"
    scratch_root.mkdir(exist_ok=True)
    client = build_opener(ProxyHandler({}), NoRedirect())
    base = f"http://127.0.0.1:{port}"
    receipt = {"timestampUtc": datetime.now(timezone.utc).isoformat(),
               "text": TEXT, "voice": "default", "baseUrl": base,
               "provider": "real-windows-system-speech", "success": False}
    process = None
    try:
        with tempfile.TemporaryDirectory(prefix="windows-speech-", dir=scratch_root) as directory:
            with open(Path(directory) / "bridge.log", "wb") as log:
                command = [sys.executable, "-B", str(ROOT / "bin" / "local-voice-server.py"),
                           "--host", "127.0.0.1", "--port", str(port),
                           "--data-dir", str(Path(directory) / "memory")]
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           creationflags=subprocess.CREATE_NO_WINDOW)
                receipt["ownedPid"] = process.pid
                try:
                    deadline = time.monotonic() + 35
                    while True:
                        if process.poll() is not None:
                            raise RuntimeError(f"Owned bridge exited during startup ({process.returncode}).")
                        try:
                            with client.open(base + "/health", timeout=2) as response:
                                health = json.loads(response.read())
                            break
                        except (URLError, TimeoutError, OSError):
                            if time.monotonic() >= deadline:
                                raise RuntimeError("Owned bridge did not become healthy in 35 seconds.") from None
                            time.sleep(0.1)
                    receipt["health"] = health
                    if not health["capabilities"]["tts"]:
                        raise RuntimeError("Real Windows speech is unavailable according to health.")
                    if health["capabilities"]["cloud_memory"] or health["capabilities"].get("cloud_stt"):
                        raise RuntimeError("Unexpected cloud memory or cloud STT capability.")
                    request = Request(base + "/speak", method="POST",
                                      data=json.dumps({"text": TEXT, "voice": "default"}).encode(),
                                      headers={"Content-Type": "application/json"})
                    started = time.monotonic()
                    with client.open(request, timeout=75) as response:
                        audio = response.read(24 * 1024 * 1024 + 1)
                        receipt["httpStatus"] = response.status
                        receipt["contentType"] = response.headers.get_content_type()
                    receipt["elapsedSeconds"] = round(time.monotonic() - started, 3)
                    if receipt["contentType"] != "audio/wav" or audio[:4] != b"RIFF" or audio[8:12] != b"WAVE":
                        raise RuntimeError("Speech did not return RIFF/WAVE audio.")
                    with wave.open(io.BytesIO(audio), "rb") as wav:
                        frames, rate = wav.getnframes(), wav.getframerate()
                        channels, width = wav.getnchannels(), wav.getsampwidth()
                        compression = wav.getcomptype()
                        samples = wav.readframes(frames)
                    if (compression != "NONE" or frames <= 0 or rate <= 0
                            or len(samples) != frames * channels * width
                            or not any(samples)):
                        raise RuntimeError("Speech output is empty, silent, truncated, or not PCM.")
                    receipt.update({"success": True, "byteLength": len(audio),
                                    "sha256": hashlib.sha256(audio).hexdigest(),
                                    "format": "RIFF/WAVE PCM", "sampleRate": rate,
                                    "channels": channels, "sampleWidthBytes": width,
                                    "frames": frames, "durationSeconds": round(frames / rate, 6),
                                    "microphoneUsed": False, "referenceRecordingUsed": False,
                                    "remoteRequestsMade": False})
                finally:
                    # Terminate only the process owned by this Popen handle.
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
                    receipt["ownedProcessStopped"] = process.poll() is not None
    except Exception as error:
        receipt["error"] = f"{type(error).__name__}: {error}"
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0 if receipt["success"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=19099)
    parser.add_argument("--receipt", type=Path, default=ROOT / "test-output" / "windows-sapi-receipt.json")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be 1 through 65535")
    raise SystemExit(validate(args.port, args.receipt))
