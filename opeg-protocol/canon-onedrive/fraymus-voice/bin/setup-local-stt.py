#!/usr/bin/env python3
"""Explicit operator setup for a pinned, local Windows CPU speech recognizer.

Never imported or launched by the voice request path. No microphone access or inference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
VERSION = "1.2.1"
FASTER_WHEEL_SHA256 = "79a66ad50688c0b794dd501dc340a736992a6342f7f95e5811be60b5224a26a7"
MODEL_ID = "Systran/faster-whisper-small.en"
REVISION = "d1d751a5f8271d482d14ca55d9e2deeebbae577f"
MODEL_FILES = {
    "config.json": {"bytes": 2657, "gitBlobSha1": "ced3fd5bbb3e9f7664658065d2d36164712cf1d5"},
    "model.bin": {"bytes": 483545366, "sha256": "62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a"},
    "tokenizer.json": {"bytes": 2128466, "gitBlobSha1": "15d7bdf9ba25718ca2504eec6a8f02bc55af0a6a"},
    "vocabulary.txt": {"bytes": 422309, "gitBlobSha1": "ee695b8d3e3c10d488304e04468efec4ca27554a"},
}
MAX_MODEL_BYTES = 600 * 1024 * 1024
MAX_MODEL_FILE_BYTES = 500 * 1024 * 1024
MAX_WHEEL_BYTES = 200 * 1024 * 1024
MAX_WHEEL_TOTAL_BYTES = 512 * 1024 * 1024
MAX_WHEELS = 48
MAX_METADATA_BYTES = 4 * 1024 * 1024
LOCK_REL = "requirements/windows-asr-py312.lock"
LOCK_JSON_REL = "requirements/windows-asr-py312.lock.json"


class SetupError(Exception):
    """A deliberately safe operator-facing error, without response/signed URLs."""


def note(message):
    print(message, flush=True)


def canonical(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def owned(relative):
    """Reject links/junctions and resolve every setup path inside this checkout."""
    target = ROOT / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise SetupError("Setup paths must remain inside the voice checkout")
    cursor = ROOT
    for part in Path(relative).parts:
        cursor = cursor / part
        if cursor.is_symlink() or (hasattr(cursor, "is_junction") and cursor.is_junction()):
            raise SetupError("Setup refuses symlinks or junctions in its owned paths")
    if not target.resolve().is_relative_to(ROOT):
        raise SetupError("Setup path escaped the voice checkout")
    return target


def clean_env(*, offline=False):
    # No inherited HF/PIP tokens, Python injection variables or cloud credentials.
    allowed = ("SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT")
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    temporary = owned("data/stt-tmp")
    temporary.mkdir(parents=True, exist_ok=True)
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PIP_CONFIG_FILE": os.devnull,
                "TEMP": str(temporary), "TMP": str(temporary),
                "PIP_DISABLE_PIP_VERSION_CHECK": "1", "HF_HOME": str(owned("data/stt-hf-cache")),
                "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})
    if offline:
        env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1"})
    return env


def run(command, label, *, timeout=180, offline=False):
    """Bound process time/output; never relay URLs or arbitrary child error text."""
    note(f"{label}...")
    kwargs = {"cwd": ROOT, "env": clean_env(offline=offline), "stdin": subprocess.DEVNULL,
              "stdout": subprocess.PIPE, "stderr": subprocess.STDOUT, "shell": False}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(command, **kwargs)
    output = bytearray()
    overflow = threading.Event()

    def consume():
        try:
            while True:
                chunk = process.stdout.read(4096)
                if not chunk:
                    return
                if len(output) + len(chunk) > 128 * 1024:
                    overflow.set()
                    return
                output.extend(chunk)
        finally:
            process.stdout.close()

    reader = threading.Thread(target=consume, daemon=True)
    reader.start()
    started = last = time.monotonic()
    try:
        while process.poll() is None:
            elapsed = time.monotonic() - started
            if overflow.is_set() or elapsed > timeout:
                raise SetupError(f"{label} exceeded its {'output' if overflow.is_set() else 'time'} limit")
            if time.monotonic() - last >= 10:
                note(f"{label}: still running ({int(elapsed)} s)")
                last = time.monotonic()
            time.sleep(0.1)
    except BaseException:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        reader.join(timeout=2)
        raise
    reader.join(timeout=2)
    if overflow.is_set() or reader.is_alive():
        raise SetupError(f"{label} did not produce a bounded, closed result")
    if process.returncode:
        # Package/HTTP errors can contain signed URLs or machine-specific details.
        raise SetupError(f"{label} failed (exit {process.returncode}); no runtime configuration was committed")
    return output.decode("utf-8", errors="strict").strip()


def check_url(url, purpose):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower()
    allowed = host == "pypi.org" if purpose == "pypi" else host == "files.pythonhosted.org" if purpose == "wheel" else (
        host == "huggingface.co" or host.endswith(".huggingface.co") or host.endswith(".hf.co"))
    if parsed.scheme != "https" or "@" in parsed.netloc or parsed.port not in (None, 443) or not allowed:
        raise SetupError("Download attempted to leave the approved public HTTPS hosts")


class Redirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def __init__(self, purpose):
        super().__init__()
        self.purpose = purpose

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        check_url(newurl, self.purpose)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def open_public(url, purpose):
    check_url(url, purpose)
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity", "User-Agent": "fraymus-voice-local-stt-setup/1"})
    try:
        response = urllib.request.build_opener(Redirects(purpose)).open(request, timeout=30)
        check_url(response.url, purpose)
        if response.status != 200 or response.headers.get("Content-Encoding", "identity").lower() != "identity":
            response.close()
            raise SetupError("Public download returned an unsupported response")
        return response
    except (urllib.error.URLError, OSError, ValueError):
        raise SetupError("Public HTTPS request failed; no credentials or alternate repository were used") from None


def metadata(url, purpose):
    started = time.monotonic()
    chunks = []
    count = 0
    with open_public(url, purpose) as response:
        while True:
            chunk = response.read1(65536)
            if not chunk:
                break
            count += len(chunk)
            if count > MAX_METADATA_BYTES or time.monotonic() - started > 60:
                raise SetupError("Public package/model metadata exceeded its size or time bound")
            chunks.append(chunk)
    data = b"".join(chunks)
    try:
        result = json.loads(data)
    except (ValueError, UnicodeError):
        raise SetupError("Public package/model metadata was invalid JSON") from None
    if not isinstance(result, dict):
        raise SetupError("Public metadata must be a JSON object")
    return result


def hashes(path):
    size = path.stat().st_size
    sha = hashlib.sha256()
    git = hashlib.sha1(f"blob {size}\0".encode("ascii"))
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
            git.update(chunk)
    return {"bytes": size, "sha256": sha.hexdigest(), "gitBlobSha1": git.hexdigest()}


def matches(path, expected):
    if not path.is_file() or path.stat().st_size != expected["bytes"]:
        return False
    actual = hashes(path)
    return all(actual[key] == expected[key] for key in ("sha256", "gitBlobSha1") if key in expected)


def download(url, destination, expected, purpose):
    if matches(destination, expected):
        note(f"Verified cached {destination.name} ({expected['bytes']:,} bytes)")
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = owned(str(destination.relative_to(ROOT)) + ".partial-" + uuid.uuid4().hex)
    started = last = time.monotonic()
    count = 0
    note(f"Downloading {destination.name} ({expected['bytes']:,} bytes)")
    try:
        with open_public(url, purpose) as response, temporary.open("xb") as target:
            declared = response.headers.get("Content-Length")
            if declared is not None and (not declared.isdecimal() or int(declared) != expected["bytes"]):
                raise SetupError("Public file Content-Length did not match its pinned metadata")
            while True:
                chunk = response.read1(1024 * 1024)
                if not chunk:
                    break
                count += len(chunk)
                if count > expected["bytes"] or time.monotonic() - started > 600:
                    raise SetupError("Public file download exceeded its pinned size or ten-minute limit")
                target.write(chunk)
                if time.monotonic() - last >= 5:
                    note(f"{destination.name}: {count:,}/{expected['bytes']:,} bytes")
                    last = time.monotonic()
        if not matches(temporary, expected):
            raise SetupError("Downloaded file did not match its pinned public size/hash")
        os.replace(temporary, destination)
    except (urllib.error.URLError, OSError):
        raise SetupError("Public file transfer failed; its partial file was not installed") from None
    finally:
        # One exact, validated task-owned file only; no recursive cleanup.
        if temporary.exists():
            temporary.unlink()


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = owned(str(path.relative_to(ROOT)) + ".partial-" + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as output:
            json.dump(value, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def pypi_file(name, version, filename):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not re.fullmatch(r"[A-Za-z0-9_.+!-]+", version):
        raise SetupError("Invalid package identity in lock assets")
    data = metadata(f"https://pypi.org/pypi/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}/json", "pypi")
    if canonical(data.get("info", {}).get("name", "")) != canonical(name) or data.get("info", {}).get("version") != version:
        raise SetupError("PyPI release identity did not match the lock")
    entries = [entry for entry in data.get("urls", []) if entry.get("filename") == filename and entry.get("packagetype") == "bdist_wheel" and not entry.get("yanked")]
    if len(entries) != 1:
        raise SetupError("Locked wheel is missing, ambiguous or yanked on PyPI")
    entry = entries[0]
    if not isinstance(entry.get("size"), int) or not 0 < entry["size"] <= MAX_WHEEL_BYTES or not re.fullmatch(r"[0-9a-f]{64}", entry.get("digests", {}).get("sha256", "")):
        raise SetupError("PyPI wheel size/hash metadata is invalid")
    check_url(entry["url"], "wheel")
    if canonical(name) == "faster-whisper" and (version != VERSION or entry["digests"]["sha256"] != FASTER_WHEEL_SHA256):
        raise SetupError("faster-whisper does not match the reviewed release fingerprint")
    return entry


def lock_text(wheels):
    return "# Windows x64 / CPython 3.12. Generated by the explicit setup --resolve-lock command.\n# All runtime wheels are pinned; installation uses --no-index --require-hashes.\n" + "".join(f"{wheel['name']}=={wheel['version']} --hash=sha256:{wheel['sha256']}\n" for wheel in wheels)


def read_lock():
    try:
        value = json.loads(owned(LOCK_JSON_REL).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise SetupError("Windows ASR lock assets are missing/invalid; operator must run --resolve-lock") from None
    wheels = value.get("wheels")
    if value.get("schemaVersion") != 1 or value.get("python") != "3.12" or value.get("platform") != "win_amd64" or not isinstance(wheels, list) or not 0 < len(wheels) <= MAX_WHEELS:
        raise SetupError("Windows ASR wheel lock has unsupported framing")
    names = set()
    for wheel in wheels:
        if not isinstance(wheel, dict) or set(wheel) != {"name", "version", "filename", "bytes", "sha256"}:
            raise SetupError("Wheel lock entry has an invalid schema")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", wheel["name"]) or wheel["name"] in names or not re.fullmatch(r"[A-Za-z0-9_.+!-]+", wheel["version"]):
            raise SetupError("Wheel lock package identity is invalid or duplicated")
        names.add(wheel["name"])
        if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.whl", wheel["filename"]) or not isinstance(wheel["bytes"], int) or not 0 < wheel["bytes"] <= MAX_WHEEL_BYTES or not re.fullmatch(r"[0-9a-f]{64}", wheel["sha256"]):
            raise SetupError("Wheel lock filename/size/hash is invalid")
        identity = wheel["filename"][:-4].split("-")
        if canonical(identity[0]) != wheel["name"] or identity[1] != wheel["version"]:
            raise SetupError("Wheel filename differs from its pinned package identity")
    if sum(wheel["bytes"] for wheel in wheels) > MAX_WHEEL_TOTAL_BYTES or not any(wheel["name"] == "faster-whisper" and wheel["version"] == VERSION and wheel["sha256"] == FASTER_WHEEL_SHA256 for wheel in wheels):
        raise SetupError("Wheel lock exceeds its total limit or lacks the reviewed faster-whisper release")
    if owned(LOCK_REL).read_text(encoding="utf-8") != lock_text(wheels):
        raise SetupError("Text and JSON ASR locks disagree")
    return wheels


def resolve_lock():
    """Maintenance mode: resolve public wheels, verify each, then publish exact locks."""
    wheelhouse = owned("data/stt-resolve-wheelhouse")
    wheelhouse.mkdir(parents=True, exist_ok=True)
    if any(wheelhouse.iterdir()):
        raise SetupError("Lock resolution requires an empty data/stt-resolve-wheelhouse; existing files were left untouched")
    pypi_file("faster-whisper", VERSION, f"faster_whisper-{VERSION}-py3-none-any.whl")
    run([sys.executable, "-I", "-m", "pip", "--isolated", "download", "--only-binary=:all:", "--index-url", "https://pypi.org/simple", "--no-cache-dir", "--disable-pip-version-check", "--no-input", "--timeout", "20", "--retries", "2", "--dest", str(wheelhouse), f"faster-whisper=={VERSION}"], "Resolve public Windows wheels", timeout=600)
    paths = sorted(wheelhouse.iterdir())
    if not 0 < len(paths) <= MAX_WHEELS or any(not path.is_file() or path.suffix != ".whl" or path.stat().st_size > MAX_WHEEL_BYTES for path in paths) or sum(path.stat().st_size for path in paths) > MAX_WHEEL_TOTAL_BYTES:
        raise SetupError("Resolved wheels exceeded their file/count/total bounds")
    wheels = []
    for path in paths:
        parts = path.stem.split("-")
        if len(parts) < 5:
            raise SetupError("Resolver returned a malformed wheel filename")
        name, version = canonical(parts[0]), parts[1]
        public = pypi_file(name, version, path.name)
        expected = {"bytes": public["size"], "sha256": public["digests"]["sha256"]}
        if not matches(path, expected):
            raise SetupError("Resolved wheel failed independent PyPI size/SHA256 verification")
        wheels.append({"name": name, "version": version, "filename": path.name, **expected})
        note(f"Verified {name}=={version} ({public['size']:,} bytes)")
    wheels.sort(key=lambda wheel: wheel["name"])
    owned("requirements").mkdir(parents=True, exist_ok=True)
    atomic_json(owned(LOCK_JSON_REL), {"schemaVersion": 1, "python": "3.12", "platform": "win_amd64", "index": "https://pypi.org/simple", "wheels": wheels})
    owned(LOCK_REL).write_text(lock_text(wheels), encoding="utf-8", newline="\n")
    read_lock()
    note(f"Recorded {len(wheels)} wheels / {sum(wheel['bytes'] for wheel in wheels):,} bytes in {LOCK_REL}")


def verify_model_metadata():
    data = metadata(f"https://huggingface.co/api/models/{MODEL_ID}/revision/{REVISION}?blobs=true", "model")
    if data.get("id") != MODEL_ID or data.get("sha") != REVISION or data.get("private") is not False or data.get("gated") is not False:
        raise SetupError("Model metadata is not the pinned public, ungated repository revision")
    files = {entry["rfilename"]: entry for entry in data.get("siblings", []) if entry.get("rfilename") in MODEL_FILES}
    if set(files) != set(MODEL_FILES) or sum(value["bytes"] for value in MODEL_FILES.values()) > MAX_MODEL_BYTES:
        raise SetupError("Pinned model file set/total is invalid")
    for name, expected in MODEL_FILES.items():
        public = files[name]
        if public.get("size") != expected["bytes"] or expected["bytes"] > MAX_MODEL_FILE_BYTES:
            raise SetupError("Public model file size differs from the pinned record")
        if "sha256" in expected:
            if public.get("lfs", {}).get("sha256") != expected["sha256"] or public.get("lfs", {}).get("size") != expected["bytes"]:
                raise SetupError("Model LFS SHA256 differs from the reviewed revision")
        elif public.get("blobId") != expected["gitBlobSha1"]:
            raise SetupError("Model Git blob identity differs from the reviewed revision")


LOAD_CHECK = r'''
import importlib.metadata as metadata, json, os, pathlib, sys
def audit(event, args):
    if event == 'socket.connect':
        raise RuntimeError('Offline model validation attempted a network connection')
sys.addaudithook(audit)
model_dir = pathlib.Path(sys.argv[1])
expected = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8'))['wheels']
if sys.prefix == sys.base_prefix or sys.version_info[:2] != (3, 12) or not sys.flags.isolated or os.environ.get('HF_HUB_OFFLINE') != '1':
    raise RuntimeError('Validation requires isolated offline venv Python')
for filename in ('model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt'):
    if not (model_dir / filename).is_file():
        raise RuntimeError('A complete local model/tokenizer is required')
packages = {item['name']: metadata.version(item['name']) for item in expected}
if any(packages[item['name']] != item['version'] for item in expected):
    raise RuntimeError('Installed distribution differs from its hash lock')
import ctranslate2
from faster_whisper import WhisperModel
if 'int8' not in ctranslate2.get_supported_compute_types('cpu'):
    raise RuntimeError('This CPU/runtime cannot execute INT8')
model = WhisperModel(str(model_dir), device='cpu', compute_type='int8', cpu_threads=4,
                     num_workers=1, local_files_only=True, use_auth_token=False)
if model.model.device != 'cpu' or model.model.compute_type not in ('int8', 'int8_float32'):
    raise RuntimeError('Runtime did not honor the configured CPU INT8 execution')
print(json.dumps({'modelLoaded':True, 'inferencePerformed':False, 'device':model.model.device,
                  'requestedComputeType':'int8', 'computeType':model.model.compute_type, 'cpuThreads':4, 'numWorkers':1,
                  'offline':True, 'pythonVersion':sys.version.split()[0], 'packages':packages}))
'''


def setup(*, verify_only=False):
    wheels = read_lock()
    model_dir = owned(f"data/stt-models/small.en/{REVISION}")
    wheelhouse = owned("data/stt-wheelhouse")
    python = owned(".venv-asr/Scripts/python.exe")
    if not verify_only:
        for wheel in wheels:
            public = pypi_file(wheel["name"], wheel["version"], wheel["filename"])
            if public["size"] != wheel["bytes"] or public["digests"]["sha256"] != wheel["sha256"]:
                raise SetupError("Public wheel release differs from the checked-in lock")
            destination = owned("data/stt-wheelhouse/" + wheel["filename"])
            bootstrap = owned("data/stt-resolve-wheelhouse/" + wheel["filename"])
            if not destination.exists() and matches(bootstrap, wheel):
                destination.parent.mkdir(parents=True, exist_ok=True)
                # Same-volume move of one verified file; no traversal or recursive cleanup.
                os.replace(bootstrap, destination)
            download(public["url"], destination, wheel, "wheel")
        verify_model_metadata()
        for name, expected in MODEL_FILES.items():
            download(f"https://huggingface.co/{MODEL_ID}/resolve/{REVISION}/{name}?download=true", owned(str(model_dir.relative_to(ROOT)) + "/" + name), expected, "model")
        if not python.exists():
            venv_dir = owned(".venv-asr")
            if venv_dir.exists() and any(venv_dir.iterdir()):
                raise SetupError("Existing .venv-asr is incomplete; it was left untouched")
            run([sys.executable, "-I", "-m", "venv", str(venv_dir)], "Create isolated ASR environment", timeout=120)
        cfg = owned(".venv-asr/pyvenv.cfg").read_text(encoding="utf-8").lower()
        if "include-system-site-packages = false" not in cfg:
            raise SetupError("ASR environment must not inherit global site packages")
        run([str(python), "-I", "-m", "pip", "--isolated", "install", "--no-index", "--find-links", str(wheelhouse), "--require-hashes", "--only-binary=:all:", "--no-deps", "--disable-pip-version-check", "--no-input", "-r", str(owned(LOCK_REL))], "Install verified wheels offline", timeout=300, offline=True)
    for wheel in wheels:
        if not matches(owned("data/stt-wheelhouse/" + wheel["filename"]), wheel):
            raise SetupError("Cached wheel failed its exact lock integrity check")
    files = {}
    for name, expected in MODEL_FILES.items():
        path = owned(str(model_dir.relative_to(ROOT)) + "/" + name)
        if not matches(path, expected):
            raise SetupError("Local model failed its pinned size/hash integrity check")
        actual = hashes(path)
        files[name] = {"bytes": actual["bytes"], "sha256": actual["sha256"]}
    run([str(python), "-I", "-m", "pip", "--isolated", "check"], "Check isolated dependency consistency", offline=True)
    result = run([str(python), "-I", "-c", LOAD_CHECK, str(model_dir), str(owned(LOCK_JSON_REL))], "Load exact local model on CPU INT8 without inference", timeout=180, offline=True)
    try:
        validation = json.loads(result.splitlines()[-1])
    except (ValueError, IndexError):
        raise SetupError("Offline CPU model load did not return a valid receipt") from None
    if validation.get("modelLoaded") is not True or validation.get("inferencePerformed") is not False:
        raise SetupError("Offline CPU model load receipt is incomplete")
    manifest_path = owned("data/stt-setup-manifest.json")
    config = {"schemaVersion": 1, "engine": "faster-whisper-cpu", "python": str(python), "modelDir": str(model_dir),
              "model": {"id": MODEL_ID, "revision": REVISION}, "manifest": str(manifest_path),
              "device": "cpu", "computeType": "int8", "cpuThreads": 4, "numWorkers": 1, "offline": True}
    if verify_only:
        config_path = owned("data/stt-config.json")
        if not config_path.is_file() or config_path.stat().st_size > 65536 or not manifest_path.is_file() or manifest_path.stat().st_size > MAX_METADATA_BYTES:
            raise SetupError("Saved runtime configuration/manifest is missing or exceeds its bound")
        saved_config = json.loads(config_path.read_text(encoding="utf-8"))
        saved_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(saved_config, dict) or any(saved_config.get(key) != value for key, value in config.items()) or not isinstance(saved_manifest, dict) or saved_manifest.get("model") != config["model"] or saved_manifest.get("files") != files or saved_manifest.get("wheels") != wheels:
            raise SetupError("Saved runtime configuration/manifest differs from the verified local installation")
        note(json.dumps({"ok": True, "verifiedOnly": True, "model": {"id": MODEL_ID, "revision": REVISION}, "modelBytes": sum(item["bytes"] for item in files.values()), "validation": validation}, indent=2))
        return
    manifest = {"schemaVersion": 1, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "engine": "faster-whisper-cpu", "python": str(python), "modelDir": str(model_dir),
                "model": {"id": MODEL_ID, "revision": REVISION}, "files": files,
                "publicFileIntegrity": MODEL_FILES, "wheels": wheels,
                "modelBytes": sum(item["bytes"] for item in files.values()), "wheelBytes": sum(item["bytes"] for item in wheels),
                "locks": {LOCK_REL: hashes(owned(LOCK_REL))["sha256"], LOCK_JSON_REL: hashes(owned(LOCK_JSON_REL))["sha256"]},
                "validation": validation}
    atomic_json(manifest_path, manifest)
    atomic_json(owned("data/stt-config.json"), config)
    note(json.dumps({"ok": True, "config": str(owned("data/stt-config.json")), "manifest": str(manifest_path), "modelBytes": manifest["modelBytes"], "wheelBytes": manifest["wheelBytes"], "wheels": len(wheels), "validation": validation}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    exclusive = parser.add_mutually_exclusive_group()
    exclusive.add_argument("--resolve-lock", action="store_true", help="Explicit maintenance: resolve current Windows dependencies, independently verify PyPI hashes and write locks")
    exclusive.add_argument("--verify-only", action="store_true", help="Offline integrity/dependency/model-load check; no downloads, installation or config writes")
    args = parser.parse_args()
    if sys.platform != "win32" or sys.version_info[:2] != (3, 12) or platform.machine().lower() not in ("amd64", "x86_64"):
        raise SetupError("This reviewed setup is restricted to Windows x64 and Python 3.12")
    if args.resolve_lock:
        resolve_lock()
    else:
        setup(verify_only=args.verify_only)


if __name__ == "__main__":
    try:
        main()
    except (SetupError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, SetupError) else "Setup encountered a local file/runtime error; configuration was not committed"
        note(json.dumps({"ok": False, "error": message}))
        sys.exit(1)
    except KeyboardInterrupt:
        note(json.dumps({"ok": False, "error": "Operator cancelled setup; no new runtime configuration was committed"}))
        sys.exit(130)
