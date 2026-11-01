#!/usr/bin/env python3
"""Loopback-only voice bridge: Windows speech, local SQLite memory, no cloud defaults."""
from __future__ import annotations

import argparse
import base64
import binascii
from contextlib import contextmanager
import importlib.util
import hashlib
import io
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import struct
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
import wave


LOG = logging.getLogger("local-voice")
MAX_BODY = 65536
MAX_TEXT = 4000
MAX_AUDIO = 24 * 1024 * 1024
MAX_LISTEN_BODY = 6 * 1024 * 1024
MAX_LISTEN_AUDIO = 4 * 1024 * 1024
MAX_TRANSCRIPT = 12000
MAX_RECOGNITION_OUTPUT = 256 * 1024
WHISPER_MODEL_ID = "Systran/faster-whisper-small.en"
WHISPER_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
DEFAULT_ORIGINS = frozenset(
    f"http://{host}:{port}"
    for host in ("127.0.0.1", "localhost")
    for port in (8787, 5173, 4173, 4178, 9099)
)


class BridgeError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


def validate_wav(data):
    if not isinstance(data, bytes) or not data or len(data) > MAX_AUDIO:
        raise BridgeError(502, "invalid_audio", "Speech provider returned invalid audio.")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (wav.getnframes() < 1 or wav.getnchannels() not in (1, 2)
                    or not 8000 <= wav.getframerate() <= 192000
                    or wav.getsampwidth() not in (1, 2, 3, 4)
                    or wav.getcomptype() != "NONE"):
                raise ValueError("unsupported WAV")
            expected = wav.getnframes() * wav.getnchannels() * wav.getsampwidth()
            if expected > MAX_AUDIO or len(wav.readframes(wav.getnframes())) != expected:
                raise ValueError("truncated WAV")
    except (wave.Error, EOFError, ValueError):
        raise BridgeError(502, "invalid_audio", "Speech provider returned invalid WAV audio.") from None
    return data


def listen_audio(encoded):
    """Canonical base64 and strict RIFF PCM16 validation before a recognizer sees it."""
    if not isinstance(encoded, str) or not encoded:
        raise BridgeError(400, "invalid_base64", "audioBase64 must contain canonical base64 WAV bytes.")
    if len(encoded) > ((MAX_LISTEN_AUDIO + 2) // 3) * 4:
        raise BridgeError(413, "audio_too_large", "Recognition audio exceeds 4 MiB.")
    try:
        if len(encoded) % 4:
            raise ValueError("padding")
        data = base64.b64decode(encoded, validate=True)
        if base64.b64encode(data).decode("ascii") != encoded:
            raise ValueError("noncanonical")
    except (ValueError, binascii.Error):
        raise BridgeError(400, "invalid_base64", "audioBase64 must contain canonical base64 without a URL prefix or whitespace.") from None
    if len(data) > MAX_LISTEN_AUDIO:
        raise BridgeError(413, "audio_too_large", "Recognition audio exceeds 4 MiB.")
    try:
        if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE" or struct.unpack_from("<I", data, 4)[0] != len(data) - 8:
            raise ValueError("RIFF framing")
        position, count, format_info, pcm = 12, 0, None, None
        while position < len(data):
            count += 1
            if count > 4096 or len(data) - position < 8:
                raise ValueError("chunk framing")
            tag = data[position:position + 4]
            if any(byte < 32 or byte > 126 for byte in tag):
                raise ValueError("invalid FourCC")
            length = struct.unpack_from("<I", data, position + 4)[0]
            start, end = position + 8, position + 8 + length
            padded = end + (length & 1)
            if padded > len(data):
                raise ValueError("truncated chunk")
            if tag == b"fmt ":
                if format_info is not None or pcm is not None or length not in (16, 18):
                    raise ValueError("format chunk")
                kind, channels, sample_rate, byte_rate, alignment, bits = struct.unpack_from("<HHIIHH", data, start)
                if (kind != 1 or channels not in (1, 2) or not 8000 <= sample_rate <= 48000
                        or bits != 16 or alignment != channels * 2 or byte_rate != sample_rate * alignment
                        or (length == 18 and struct.unpack_from("<H", data, start + 16)[0] != 0)):
                    raise ValueError("unsupported PCM")
                format_info = (channels, sample_rate, alignment)
            elif tag == b"data":
                if format_info is None or pcm is not None or not length:
                    raise ValueError("data chunk")
                pcm = data[start:end]
            position = padded
        if format_info is None or pcm is None:
            raise ValueError("missing PCM")
        channels, sample_rate, alignment = format_info
        if len(pcm) % alignment:
            raise ValueError("partial frame")
        duration = len(pcm) / alignment / sample_rate
        if duration <= 0 or duration > 60:
            raise ValueError("duration")
    except (ValueError, struct.error):
        raise BridgeError(400, "invalid_wav", "Use a complete PCM16 WAV: mono/stereo, 8000–48000 Hz, and no more than 60 seconds.") from None
    return data, {"durationSeconds": duration, "sampleRate": sample_rate,
                  "channels": channels, "sampleWidth": 2}, not any(pcm)


def recognition_process_job(process):
    """Keep the owned PowerShell/compiler tree bounded to its parent lifetime."""
    if sys.platform != "win32":
        raise BridgeError(503, "stt_unavailable", "Offline desktop recognition requires Windows.")
    import ctypes
    from ctypes import wintypes
    class Basic(ctypes.Structure):
        _fields_ = [("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong),
                    ("flags", wintypes.DWORD), ("minWork", ctypes.c_size_t), ("maxWork", ctypes.c_size_t),
                    ("active", wintypes.DWORD), ("affinity", ctypes.c_size_t),
                    ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD)]
    class Extended(ctypes.Structure):
        _fields_ = [("basic", Basic), ("io", ctypes.c_ulonglong * 6),
                    ("processMemory", ctypes.c_size_t), ("jobMemory", ctypes.c_size_t),
                    ("peakProcess", ctypes.c_size_t), ("peakJob", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes, kernel.CreateJobObjectW.restype = [wintypes.LPVOID, wintypes.LPCWSTR], wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes, kernel.SetInformationJobObject.restype = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD], wintypes.BOOL
    kernel.OpenProcess.argtypes, kernel.OpenProcess.restype = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE
    kernel.AssignProcessToJobObject.argtypes, kernel.AssignProcessToJobObject.restype = [wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    job, handle = kernel.CreateJobObjectW(None, None), None
    try:
        limits = Extended(); limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; no inherited/named handle.
        if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise OSError("job limits")
        handle = kernel.OpenProcess(0x0101, False, process.pid)
        if not handle or not kernel.AssignProcessToJobObject(job, handle):
            raise OSError("job assignment")
    except OSError:
        if job:
            kernel.CloseHandle(job)
        raise BridgeError(503, "stt_unavailable", "Windows recognition process cleanup could not be established.") from None
    finally:
        if handle:
            kernel.CloseHandle(handle)
    closed, lock = [False], threading.Lock()
    def close():
        with lock:
            if not closed[0]:
                kernel.CloseHandle(job); closed[0] = True
    return close


class WindowsSpeech:
    """Static PowerShell code; text, voice and output path travel as JSON on stdin."""
    engine = "windows-system-speech"
    _DISCOVER = r"""$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $names = @($speaker.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
    ConvertTo-Json -InputObject @{ voices = $names } -Compress
} finally { $speaker.Dispose() }
"""
    _SPEAK = r"""$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($request.voice) { $speaker.SelectVoice([string]$request.voice) }
    $speaker.SetOutputToWaveFile([string]$request.output)
    $speaker.Speak([string]$request.text)
    $speaker.SetOutputToNull()
} finally { $speaker.Dispose() }
"""

    def __init__(self, timeout=60):
        self.timeout = timeout
        self.voices = []
        self.executable = shutil.which("powershell.exe") if sys.platform == "win32" else None
        if self.executable:
            try:
                result = self._run(self._DISCOVER, {}, timeout=20)
                payload = json.loads(result.stdout.lstrip("\ufeff"))
                self.voices = [v for v in payload.get("voices", []) if isinstance(v, str) and v]
            except (BridgeError, ValueError, TypeError):
                LOG.warning("Windows speech is unavailable; memory remains available.")

    def _run(self, script, payload, timeout):
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        try:
            result = subprocess.run(
                [self.executable, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                input=json.dumps(payload, ensure_ascii=True), text=True,
                encoding="utf-8", errors="replace", capture_output=True,
                timeout=timeout, check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            raise BridgeError(504, "speech_timeout", "Speech generation timed out.") from None
        except OSError:
            raise BridgeError(503, "speech_unavailable", "Windows speech could not start.") from None
        if result.returncode:
            # Provider errors can include user text or local paths; do not return/log stderr.
            raise BridgeError(502, "speech_failed", "Windows speech generation failed.")
        return result

    def synthesize(self, text, voice):
        if not self.voices:
            raise BridgeError(503, "tts_unavailable", "No enabled Windows speech voices are available.")
        if voice in ("default", "partner"):
            voice = ""
        elif voice not in self.voices:
            raise BridgeError(400, "unknown_voice", "Select a voice advertised by /health.")
        with tempfile.TemporaryDirectory(prefix="fraymus-voice-") as directory:
            output = Path(directory) / "speech.wav"
            self._run(self._SPEAK, {"text": text, "voice": voice, "output": str(output)}, self.timeout)
            try:
                if output.stat().st_size > MAX_AUDIO:
                    raise BridgeError(502, "invalid_audio", "Speech output exceeds the audio limit.")
                return output.read_bytes()
            except OSError:
                raise BridgeError(502, "missing_audio", "Speech provider did not produce audio.") from None


class WindowsRecognition:
    """File-only installed desktop recognizer. Never opens the microphone/default device."""
    engine = "windows-system-speech-recognition"
    _DISCOVER = r"""$ErrorActionPreference = 'Stop'
$null = [Console]::In.ReadToEnd()
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$available = @()
foreach ($info in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
    if ($info.Id -notmatch '^MS-[0-9]+-[0-9]+-DESK$') { continue }
    $recognizer = $null
    try {
        $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
        $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $available += @{ id = $info.Id; language = $info.Culture.Name; name = $info.Name }
    } catch { } finally { if ($recognizer) { $recognizer.Dispose() } }
}
ConvertTo-Json -InputObject @{ recognizers = $available } -Depth 4 -Compress
"""
    _RECOGNIZE = r"""$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Speech
$source = @'
using System;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Threading;
public class LocalSpeechSegment {
    public string text { get; set; }
    public double confidence { get; set; }
    public double? startSeconds { get; set; }
    public double? durationSeconds { get; set; }
}
public class LocalSpeechReceipt {
    public string status { get; set; }
    public string language { get; set; }
    public List<LocalSpeechSegment> segments { get; set; }
}
public static class LocalFileSpeech {
    public static LocalSpeechReceipt Recognize(string path, string id, int milliseconds) {
        var segments = new List<LocalSpeechSegment>();
        var completed = new ManualResetEventSlim(false);
        var gate = new object();
        bool overflow = false, failed = false, inputEnded = false;
        int characters = 0;
        string language = null;
        using (var recognizer = new SpeechRecognitionEngine(id)) {
            language = recognizer.RecognizerInfo.Culture.Name;
            recognizer.LoadGrammar(new DictationGrammar());
            recognizer.SetInputToWaveFile(path);
            recognizer.InitialSilenceTimeout = TimeSpan.FromSeconds(61);
            recognizer.BabbleTimeout = TimeSpan.FromSeconds(61);
            recognizer.EndSilenceTimeout = TimeSpan.FromMilliseconds(500);
            recognizer.EndSilenceTimeoutAmbiguous = TimeSpan.FromMilliseconds(750);
            recognizer.SpeechRecognized += (sender, args) => {
                if (args.Result == null || String.IsNullOrWhiteSpace(args.Result.Text)) return;
                bool cancel = false;
                lock (gate) {
                    string text = args.Result.Text.Trim();
                    int next = characters + text.Length + (segments.Count > 0 ? 1 : 0);
                    if (next > 12000 || segments.Count >= 256) { overflow = true; cancel = true; }
                    else {
                        characters = next;
                        var audio = args.Result.Audio;
                        segments.Add(new LocalSpeechSegment {
                            text = text,
                            confidence = Math.Max(0.0, Math.Min(1.0, args.Result.Confidence)),
                            startSeconds = audio == null ? (double?)null : audio.AudioPosition.TotalSeconds,
                            durationSeconds = audio == null ? (double?)null : audio.Duration.TotalSeconds
                        });
                    }
                }
                if (cancel) recognizer.RecognizeAsyncCancel();
            };
            recognizer.RecognizeCompleted += (sender, args) => {
                if (args.Error != null || (args.Cancelled && !overflow)) failed = true;
                inputEnded = args.InputStreamEnded;
                completed.Set();
            };
            recognizer.RecognizeAsync(RecognizeMode.Multiple);
            if (!completed.Wait(milliseconds)) {
                recognizer.RecognizeAsyncCancel();
                completed.Wait(1000);
                return new LocalSpeechReceipt {status="timeout", language=language, segments=new List<LocalSpeechSegment>()};
            }
            lock (gate) {
                return new LocalSpeechReceipt {status=overflow ? "output_limit" : failed ? "failed" : !inputEnded ? "incomplete" : segments.Count == 0 ? "no_speech" : "ok",
                    language=language, segments=new List<LocalSpeechSegment>(segments)};
            }
        }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @([System.Speech.Recognition.SpeechRecognitionEngine].Assembly.Location, 'System.dll', 'System.Core.dll')
$receipt = [LocalFileSpeech]::Recognize([string]$request.path, [string]$request.recognizerId, 22000)
ConvertTo-Json -InputObject $receipt -Depth 6 -Compress
"""

    def __init__(self):
        self.executable = shutil.which("powershell.exe") if sys.platform == "win32" else None
        self.recognizers = []
        if self.executable:
            try:
                payload = self._run(self._DISCOVER, {}, 12)
                for item in payload.get("recognizers", []):
                    if (isinstance(item, dict) and isinstance(item.get("id"), str)
                            and re.fullmatch(r"MS-[0-9]+-[0-9]+-DESK", item["id"])
                            and isinstance(item.get("language"), str) and item["language"]):
                        self.recognizers.append({"id": item["id"][:200], "language": item["language"][:35],
                                                 "name": str(item.get("name", ""))[:200]})
            except (BridgeError, ValueError, TypeError, AttributeError):
                LOG.warning("Offline Windows recognition is unavailable; no cloud fallback is enabled.")

    def _run(self, script, payload, timeout):
        if script is None:
            command = [self.executable, "-I", str(Path(__file__).with_name("whisper-transcribe.py"))]
        else:
            encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
            command = [self.executable, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]
        environment = {key: value for key, value in os.environ.items()
                       if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"}}
        if script is None:
            environment.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
                                "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                                "DO_NOT_TRACK": "1", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
                                "OPENBLAS_NUM_THREADS": "4", "CUDA_VISIBLE_DEVICES": ""})
        process, reader, writer, close_job = None, None, None, None
        parts, total, overflow = [], [0], threading.Event()
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                env=environment, shell=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            close_job = recognition_process_job(process)

            def collect():
                try:
                    while True:
                        chunk = process.stdout.read(min(65536, MAX_RECOGNITION_OUTPUT + 1 - total[0]))
                        if not chunk:
                            return
                        total[0] += len(chunk)
                        if total[0] > MAX_RECOGNITION_OUTPUT:
                            overflow.set()
                            process.kill()
                            return
                        parts.append(chunk)
                except OSError:
                    return

            reader = threading.Thread(target=collect, daemon=True)
            reader.start()
            def write():
                try:
                    process.stdin.write(json.dumps(payload, ensure_ascii=True).encode("ascii"))
                    process.stdin.close()
                except OSError:
                    pass
            writer = threading.Thread(target=write, daemon=True)
            writer.start()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                raise BridgeError(504, "recognition_timeout", "Offline speech recognition timed out.") from None
            reader.join(timeout=1)
            if reader.is_alive():
                raise BridgeError(502, "recognition_failed", "Recognition output did not close correctly.")
            if overflow.is_set():
                raise BridgeError(502, "output_limit", "Recognition output exceeded its limit.")
            if process.returncode:
                raise BridgeError(502, "recognition_failed", "Offline Windows speech recognition failed.")
            result = json.loads(b"".join(parts).decode("utf-8-sig"))
            if not isinstance(result, dict):
                raise ValueError("provider object")
            return result
        except (OSError, UnicodeError, ValueError):
            raise BridgeError(502, "recognition_failed", "Offline Windows speech recognition could not complete.") from None
        finally:
            if process is not None:
                if close_job is not None:
                    close_job()
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=2)
                if reader is not None:
                    reader.join(timeout=1)
                if writer is not None:
                    writer.join(timeout=1)
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()

    def recognize(self, audio, metadata, language=None):
        if not self.recognizers:
            raise BridgeError(503, "stt_unavailable", "No usable offline Windows speech recognizer is installed.")
        candidates = self.recognizers
        if language:
            exact = [item for item in candidates if item["language"].casefold() == language.casefold()]
            candidates = exact or ([item for item in candidates if item["language"].split("-")[0].casefold() == language.casefold()] if "-" not in language else [])
            if not candidates:
                raise BridgeError(400, "language_unavailable", "The requested offline recognition language is not installed.")
        selected = next((item for item in candidates if item["language"] == "en-US"), candidates[0])
        with tempfile.TemporaryDirectory(prefix="fraymus-listen-") as directory:
            wav = Path(directory) / "input.wav"
            wav.write_bytes(audio)
            result = self._run(self._RECOGNIZE, {"path": str(wav), "recognizerId": selected["id"]}, 25)
        return self._checked_receipt(result, metadata, selected["language"])

    def _checked_receipt(self, result, metadata, language):
        status = result.get("status")
        if status == "no_speech":
            raise BridgeError(422, "no_speech", "No recognizable speech was found in this audio.")
        if status == "timeout":
            raise BridgeError(504, "recognition_timeout", "Offline speech recognition exceeded its time limit.")
        if status == "output_limit":
            raise BridgeError(502, "output_limit", "Recognition transcript exceeded its output limit.")
        if status == "incomplete":
            raise BridgeError(502, "recognition_incomplete", "Offline recognizer stopped before reaching the end of the audio; no partial transcript was returned.")
        if status != "ok" or result.get("language") != language:
            raise BridgeError(502, "recognition_failed", "Offline Windows speech recognition failed.")
        segments = result.get("segments")
        if not isinstance(segments, list) or not 1 <= len(segments) <= 256:
            raise BridgeError(502, "recognition_failed", "Recognizer returned invalid segments.")
        checked = []
        for segment in segments:
            if (not isinstance(segment, dict) or not isinstance(segment.get("text"), str)
                    or not segment["text"].strip() or isinstance(segment.get("confidence"), bool)
                    or not isinstance(segment.get("confidence"), (int, float))
                    or not math.isfinite(segment["confidence"]) or not 0 <= segment["confidence"] <= 1):
                raise BridgeError(502, "recognition_failed", "Recognizer returned an invalid transcript or confidence.")
            item = {"text": segment["text"].strip(), "confidence": segment["confidence"]}
            for key in ("startSeconds", "durationSeconds"):
                value = segment.get(key)
                if value is not None:
                    if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                            or value < 0 or value > metadata["durationSeconds"] + 1 / metadata["sampleRate"]):
                        raise BridgeError(502, "recognition_failed", "Recognizer returned invalid audio timing.")
                    item[key] = value
            if ("startSeconds" in item and "durationSeconds" in item
                    and item["startSeconds"] + item["durationSeconds"] > metadata["durationSeconds"] + 1 / metadata["sampleRate"]):
                raise BridgeError(502, "recognition_failed", "Recognizer returned timing outside the audio.")
            checked.append(item)
        transcript = " ".join(item["text"] for item in checked)
        if len(transcript) > MAX_TRANSCRIPT:
            raise BridgeError(502, "output_limit", "Recognition transcript exceeds 12000 characters.")
        confidence = sum(item["confidence"] * len(item["text"]) for item in checked) / sum(len(item["text"]) for item in checked)
        return {"ok": True, "transcript": transcript, "engine": self.engine,
                "language": language, "confidence": confidence,
                "segments": checked, "audio": metadata}


def validate_whisper_config(config_path, project_root=None):
    """Server-owned configuration + complete local file integrity; never fetch a model."""
    root = Path(project_root or Path(__file__).resolve().parents[1]).resolve()
    try:
        path = Path(config_path)
        if not path.is_file() or path.stat().st_size > 65536:
            raise ValueError("config size")
        config = json.loads(path.read_text(encoding="utf-8"))
        required = {"schemaVersion", "engine", "python", "modelDir", "model", "manifest", "device",
                    "computeType", "cpuThreads", "numWorkers", "offline"}
        if not isinstance(config, dict) or set(config) != required or config["schemaVersion"] != 1:
            raise ValueError("config schema")
        if (config["engine"] != "faster-whisper-cpu" or config["device"] != "cpu" or config["computeType"] != "int8"
                or type(config["cpuThreads"]) is not int or config["cpuThreads"] != 4
                or type(config["numWorkers"]) is not int or config["numWorkers"] != 1 or config["offline"] is not True):
            raise ValueError("runtime settings")
        model = config["model"]
        if (not isinstance(model, dict) or set(model) != {"id", "revision"} or model["id"] != WHISPER_MODEL_ID
                or not isinstance(model["revision"], str) or not re.fullmatch(r"[a-f0-9]{40}", model["revision"])):
            raise ValueError("model pin")
        python, directory, manifest_path = (Path(config[key]) for key in ("python", "modelDir", "manifest"))
        if not all(value.is_absolute() for value in (python, directory, manifest_path)):
            raise ValueError("absolute paths")
        expected_python = root / ".venv-asr" / "Scripts" / "python.exe"
        expected_directory = root / "data" / "stt-models" / "small.en" / model["revision"]
        if (python.resolve() != expected_python.resolve() or not python.is_file()
                or directory.resolve() != expected_directory.resolve() or not directory.is_dir()
                or root not in directory.resolve().parents
                or manifest_path.resolve() != (root / "data" / "stt-setup-manifest.json").resolve()
                or not manifest_path.is_file() or manifest_path.stat().st_size > 1024 * 1024):
            raise ValueError("configured paths")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("model", {}).get("id") != model["id"] or manifest.get("model", {}).get("revision") != model["revision"]:
            raise ValueError("manifest identity")
        files = manifest.get("files")
        if not isinstance(files, dict) or set(files) != set(WHISPER_FILES):
            raise ValueError("manifest files")
        if {entry.name for entry in directory.iterdir()} != set(WHISPER_FILES):
            raise ValueError("unmanifested model files")
        for name in WHISPER_FILES:
            entry, target = files[name], directory / name
            if (not isinstance(entry, dict) or not isinstance(entry.get("sha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", entry["sha256"])
                    or type(entry.get("bytes")) is not int or not 1 <= entry["bytes"] <= 600 * 1024 * 1024
                    or target.is_symlink() or not target.is_file() or target.stat().st_size != entry["bytes"]):
                raise ValueError("model file bounds")
            digest = hashlib.sha256()
            with target.open("rb") as stream:
                for part in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(part)
            if digest.hexdigest() != entry["sha256"]:
                raise ValueError("model integrity")
        return config
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise BridgeError(503, "stt_unavailable", "Configured offline Whisper setup or model integrity is invalid; repair the operator setup. No Windows fallback was selected.") from None


class UnavailableRecognition:
    engine = "faster-whisper-cpu"
    recognizers = []
    reason = "Configured offline Whisper is unavailable. Repair its setup or remove its configuration to deliberately return to Windows recognition."


class WhisperRecognition(WindowsRecognition):
    engine = "faster-whisper-cpu"
    confidence_metric = "exp_avg_logprob"
    confidence_kind = "Uncalibrated decoder score: exp(token-count-weighted mean segment avg_logprob), not correctness probability or language_probability."

    def __init__(self, config_path):
        self.config_path, self.recognizers = Path(config_path).resolve(), []
        self.reason = UnavailableRecognition.reason
        config = validate_whisper_config(self.config_path)
        self.executable, self.model = config["python"], dict(config["model"])
        result = self._run(None, {"operation": "health", "configPath": str(self.config_path)}, 25)
        if result.get("status") != "ready" or result.get("model") != self.model:
            raise BridgeError(503, "stt_unavailable", self.reason)
        self.recognizers = [{"id": self.model["id"] + "@" + self.model["revision"], "language": "en", "name": "Whisper small.en CPU INT8"}]
        self.runtime = {key: result[key] for key in ("computeTypeRequested", "computeTypeActual", "cpuThreads", "numWorkers") if key in result}

    def recognize(self, audio, metadata, language=None):
        if language and language.split("-")[0].casefold() != "en":
            raise BridgeError(400, "language_unavailable", "This pinned Whisper model supports English only.")
        with tempfile.TemporaryDirectory(prefix="fraymus-whisper-") as directory:
            wav = Path(directory) / "input.wav"
            wav.write_bytes(audio)
            result = self._run(None, {"operation": "recognize", "configPath": str(self.config_path),
                                     "path": str(wav), "language": "en", "audio": metadata}, 25)
        if result.get("model") != self.model or result.get("confidenceMetric") != self.confidence_metric:
            raise BridgeError(502, "recognition_failed", "Configured Whisper identity or score metadata did not match.")
        receipt = self._checked_receipt(result, metadata, "en")
        confidence = result.get("confidence")
        if (isinstance(confidence, bool) or not isinstance(confidence, (int, float))
                or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise BridgeError(502, "recognition_failed", "Whisper returned an invalid decoder score.")
        receipt.update({"confidence": confidence, "confidenceMetric": self.confidence_metric, "model": self.model})
        return receipt


def configured_recognizer(config_path):
    path = Path(config_path)
    if not path.exists() and not path.is_symlink():
        return WindowsRecognition()
    try:
        return WhisperRecognition(path)
    except (BridgeError, OSError, ValueError, TypeError):
        return UnavailableRecognition()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class LocalF5Worker:
    """Explicit opt-in connection to an existing loopback F5 worker, never a cloud URL."""
    def __init__(self, url):
        parsed = urlparse(url)
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost")
                or parsed.username or parsed.password or parsed.path not in ("", "/")
                or parsed.query or parsed.fragment):
            raise ValueError("F5 worker must be an HTTP loopback origin without credentials or a path")
        # Pin localhost to its numeric loopback address and ignore proxy environment variables.
        self.url = f"http://127.0.0.1:{parsed.port or 80}"
        self.client = build_opener(ProxyHandler({}), NoRedirect())

    def ready(self):
        try:
            with self.client.open(self.url + "/health", timeout=2) as response:
                health = json.loads(response.read(MAX_BODY + 1))
                return isinstance(health, dict) and bool(health.get("ok") and health.get("voice_ready"))
        except (OSError, ValueError, HTTPError, URLError):
            return False

    def synthesize(self, text):
        request = Request(self.url + "/speak", data=json.dumps({"text": text, "voice": "myvoice"}).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.client.open(request, timeout=120) as response:
                if response.headers.get_content_type() != "audio/wav":
                    raise BridgeError(502, "invalid_audio", "F5 worker did not return WAV audio.")
                return response.read(MAX_AUDIO + 1)
        except (OSError, HTTPError, URLError):
            raise BridgeError(503, "worker_unavailable", "The configured local F5 worker is unavailable.") from None


class LocalMemory:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY, content TEXT NOT NULL, role TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            )""")
            connection.execute("CREATE INDEX IF NOT EXISTS memory_conversation ON memories(conversation_id, id)")

    @contextmanager
    def _connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def observe(self, content, role, conversation_id):
        with self._connect() as connection:
            cursor = connection.execute(
                "INSERT INTO memories(content,role,conversation_id) VALUES(?,?,?)",
                (content, role, conversation_id),
            )
            return cursor.lastrowid

    def search(self, query, limit=5, conversation_id=None):
        if not query.strip():
            return []
        words = list(dict.fromkeys(re.findall(r"\w+", query, flags=re.UNICODE)))[:12]
        if not words:
            return []
        conditions = ["content LIKE ? ESCAPE '\\'" for _ in words]
        parameters = ["%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for word in words]
        sql = "SELECT id,content,role,conversation_id,created_at FROM memories WHERE (" + " OR ".join(conditions) + ")"
        if conversation_id is not None:
            sql += " AND conversation_id = ?"
            parameters.append(conversation_id)
        sql += " ORDER BY id DESC LIMIT ?"
        parameters.append(limit)
        with self._connect() as connection:
            return [{"id": row["id"], "content": row["content"], "role": row["role"],
                     "conversationId": row["conversation_id"], "createdAt": row["created_at"],
                     "source": "local-sqlite", "trusted": False}
                    for row in connection.execute(sql, parameters)]


class VoiceService:
    def __init__(self, memory, synth=None, f5_worker=None, emotion=None, recognizer=None):
        self.memory = memory
        self.synth = synth if synth is not None else WindowsSpeech()
        self.f5_worker = f5_worker
        self.emotion = emotion
        self.speech_lock = threading.Lock()
        self.recognizer = recognizer if recognizer is not None else WindowsRecognition()
        self.recognition_lock = threading.Lock()
        self.listen_http_slots = threading.BoundedSemaphore(2)

    def health(self):
        f5_ready = bool(self.f5_worker and self.f5_worker.ready())
        voices = list(self.synth.voices)
        if f5_ready:
            voices.append("myvoice")
        tts = bool(voices)
        recognizers = list(self.recognizer.recognizers)
        stt = bool(recognizers)
        return {"ok": True, "ready": tts,
                "engine": self.synth.engine if self.synth.voices else ("f5-tts-worker" if f5_ready else "unavailable"),
                "capabilities": {"tts": tts, "stt": stt, "local_stt": stt, "cloud_stt": False, "voice_cloning": f5_ready,
                                 "local_memory": True, "cloud_memory": False},
                "voices": voices, "voice_ready": tts, "full_duplex": False,
                "stt_ready": stt, "stt_engine": self.recognizer.engine,
                "recognizers": recognizers, "languages": sorted({item["language"] for item in recognizers}),
                **({"stt_model": self.recognizer.model} if hasattr(self.recognizer, "model") else {}),
                **({"stt_confidence_metric": self.recognizer.confidence_metric,
                    "stt_confidence_description": self.recognizer.confidence_kind} if hasattr(self.recognizer, "confidence_metric") else {}),
                **({"stt_runtime": self.recognizer.runtime} if hasattr(self.recognizer, "runtime") else {}),
                **({"stt_unavailable_reason": self.recognizer.reason} if not stt and hasattr(self.recognizer, "reason") else {}),
                "emotion_metadata": self.emotion is not None}

    def speak(self, text, voice):
        if not self.speech_lock.acquire(timeout=5):
            raise BridgeError(503, "speech_busy", "Speech generation is busy; retry shortly.")
        try:
            if voice == "myvoice" and self.f5_worker:
                audio = self.f5_worker.synthesize(text)
            else:
                audio = self.synth.synthesize(text, voice)
            return validate_wav(audio)
        finally:
            self.speech_lock.release()

    def emotion_state(self):
        # Presentation metadata only: never used for tool authority, permissions, or routing.
        if self.emotion is not None:
            return self.emotion.state()
        return None

    def listen(self, body):
        if set(body) - {"audioBase64", "language"}:
            raise BridgeError(400, "unknown_fields", "Recognition accepts only audioBase64 and optional language.")
        language = body.get("language")
        if language is not None and (not isinstance(language, str) or len(language) > 35
                                     or not re.fullmatch(r"[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*", language)):
            raise BridgeError(400, "invalid_field", "language must be a supported language tag such as en-US.")
        if "language" in body and language is None:
            raise BridgeError(400, "invalid_field", "language must be a language tag when provided.")
        if not self.recognition_lock.acquire(timeout=1):
            raise BridgeError(503, "recognition_busy", "Offline speech recognition is busy; retry shortly.")
        try:
            audio, metadata, silent = listen_audio(body.get("audioBase64"))
            if not self.recognizer.recognizers:
                raise BridgeError(503, "stt_unavailable", "No usable offline Windows speech recognizer is installed.")
            if silent:
                raise BridgeError(422, "no_speech", "The audio is silent; no speech can be recognized.")
            return self.recognizer.recognize(audio, metadata, language)
        finally:
            self.recognition_lock.release()


def text_field(body, name="text", maximum=MAX_TEXT, default=None):
    value = body.get(name, default)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise BridgeError(400, "invalid_field", f"{name} must be a nonempty string of at most {maximum} characters.")
    return value.strip()


class VoiceHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, service, origins=DEFAULT_ORIGINS):
        if address[0] != "127.0.0.1":
            raise ValueError("The voice bridge must bind to 127.0.0.1")
        self.service, self.origins = service, frozenset(origins)
        super().__init__(address, VoiceHandler)


class VoiceHandler(BaseHTTPRequestHandler):
    server_version = "FraymusLocalVoice/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, fmt, *args):
        # Never log memory queries, transcripts, request bodies, or provider diagnostics.
        return

    def _check_origin(self):
        origin = self.headers.get("Origin")
        if origin is not None and origin not in self.server.origins:
            raise BridgeError(403, "origin_denied", "This browser origin is not allowed.")
        host = self.headers.get("Host", "")
        port = self.server.server_address[1]
        if host not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
            raise BridgeError(403, "host_denied", "Use the local voice bridge address.")

    def _send(self, status, data, content_type="application/json"):
        # On Windows, closing a socket with an unread small POST body can reset it
        # before the client receives the error response. Discard bounded bodies only.
        if not getattr(self, "_body_read", False):
            lengths = self.headers.get_all("Content-Length", [])
            if (len(lengths) == 1 and len(lengths[0]) <= 10 and lengths[0].isdigit()
                    and int(lengths[0]) <= MAX_BODY
                    and self.headers.get("Transfer-Encoding") is None):
                self.rfile.read(int(lengths[0]))
                self._body_read = True
        if content_type == "application/json":
            data = json.dumps(data, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin in self.server.origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        if data:
            self.wfile.write(data)

    def _body(self, maximum=MAX_BODY):
        if len(self.headers.get_all("Content-Type", [])) != 1 or self.headers.get_content_type() != "application/json":
            raise BridgeError(415, "content_type", "Use Content-Type: application/json.")
        if self.headers.get("Transfer-Encoding") is not None:
            raise BridgeError(400, "transfer_encoding", "Chunked request bodies are not supported.")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
            raise BridgeError(411, "content_length", "Provide one valid Content-Length header.")
        if len(lengths[0]) > 10:
            raise BridgeError(413, "body_too_large", "Request body exceeds its endpoint size limit.")
        length = int(lengths[0])
        if length > maximum:
            raise BridgeError(413, "body_too_large", "Request body exceeds its endpoint size limit.")
        try:
            self._body_read = True
            deadline = time.monotonic() + 10
            parts, remaining = [], length
            while remaining:
                left = deadline - time.monotonic()
                if left <= 0:
                    raise TimeoutError("body deadline")
                self.connection.settimeout(left)
                chunk = self.rfile.read1(min(65536, remaining))
                if not chunk:
                    break
                parts.append(chunk); remaining -= len(chunk)
            data = b"".join(parts)
            if len(data) != length:
                raise ValueError("incomplete body")
            body = json.loads(data.decode("utf-8"))
        except (UnicodeError, ValueError, RecursionError):
            raise BridgeError(400, "invalid_json", "Provide a complete UTF-8 JSON object.") from None
        except TimeoutError:
            raise BridgeError(408, "body_timeout", "JSON request body did not arrive within 10 seconds.") from None
        if not isinstance(body, dict):
            raise BridgeError(400, "invalid_json", "Provide a JSON object.")
        return body

    def _execute(self, action):
        try:
            self._check_origin()
            action()
        except BridgeError as error:
            self._send(error.status, {"ok": False, "error": {"code": error.code, "message": error.message}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except sqlite3.Error:
            self._send(503, {"ok": False, "error": {"code": "memory_unavailable", "message": "Local memory is unavailable."}})
        except Exception:
            LOG.error("Request failed; no transcript or provider diagnostics recorded.")
            self._send(500, {"ok": False, "error": {"code": "internal_error", "message": "The local bridge could not complete this request."}})

    def do_OPTIONS(self):
        def action():
            if urlparse(self.path).path not in ("/health", "/memory", "/speak", "/listen"):
                raise BridgeError(404, "not_found", "Unknown endpoint.")
            method = self.headers.get("Access-Control-Request-Method", "")
            requested = {h.strip().lower() for h in self.headers.get("Access-Control-Request-Headers", "").split(",") if h.strip()}
            if method not in ("GET", "POST") or not requested.issubset({"content-type"}):
                raise BridgeError(403, "preflight_denied", "This method or header is not allowed.")
            self.send_response(204)
            origin = self.headers.get("Origin")
            if origin in self.server.origins:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
        self._execute(action)

    def do_GET(self):
        def action():
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                self._send(200, self.server.service.health())
            elif parsed.path == "/memory":
                if len(parsed.query) > 8192:
                    raise BridgeError(414, "query_too_long", "Memory query is too long.")
                try:
                    query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=10)
                except ValueError:
                    raise BridgeError(400, "invalid_query", "Too many memory query fields.") from None
                text = query.get("q", [""])[0]
                if len(text) > 1000:
                    raise BridgeError(400, "query_too_long", "Memory search is limited to 1000 characters.")
                try:
                    limit = int(query.get("limit", ["5"])[0])
                    if not 1 <= limit <= 20:
                        raise ValueError("limit")
                except ValueError:
                    raise BridgeError(400, "invalid_limit", "limit must be an integer from 1 through 20.") from None
                conversation = query.get("conversationId", [None])[0]
                if conversation is not None:
                    conversation = text_field({"conversationId": conversation}, "conversationId", 128)
                result = {"hits": self.server.service.memory.search(text, limit, conversation)}
                emotion = self.server.service.emotion_state()
                if emotion is not None:
                    result["emotion_state"] = emotion
                self._send(200, result)
            else:
                raise BridgeError(404, "not_found", "Unknown endpoint.")
        self._execute(action)

    def do_POST(self):
        def action():
            path = urlparse(self.path).path
            if path == "/listen":
                if not self.server.service.listen_http_slots.acquire(timeout=0.1):
                    raise BridgeError(503, "recognition_busy", "Offline recognition request slots are busy; retry shortly.")
                try:
                    self._send(200, self.server.service.listen(self._body(MAX_LISTEN_BODY)))
                finally:
                    self.server.service.listen_http_slots.release()
                return
            if path not in ("/speak", "/memory"):
                raise BridgeError(404, "not_found", "Unknown endpoint.")
            body = self._body()
            text = text_field(body)
            if path == "/speak":
                voice = text_field(body, "voice", 200, "default")
                self._send(200, self.server.service.speak(text, voice), "audio/wav")
            else:
                role = text_field(body, "role", 16, "user")
                if role not in ("user", "assistant", "system", "note"):
                    raise BridgeError(400, "invalid_role", "role must be user, assistant, system, or note.")
                conversation = text_field(body, "conversationId", 128, "default")
                row_id = self.server.service.memory.observe(text, role, conversation)
                self._send(200, {"ok": True, "id": row_id, "source": "local-sqlite"})
        self._execute(action)


def load_emotion(directory):
    source = Path(__file__).with_name("nola_emotion.py")
    spec = importlib.util.spec_from_file_location("fraymus_emotion_metadata", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.get_engine(str(directory))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9099)
    default_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "FraymusVoice"
    parser.add_argument("--data-dir", type=Path, default=default_data)
    parser.add_argument("--tts-timeout", type=int, default=60)
    parser.add_argument("--f5-worker-url", help="Explicit opt-in HTTP loopback F5 worker origin")
    parser.add_argument("--stt-config", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "stt-config.json",
                        help="Operator-owned offline Whisper config; absent uses Windows desktop recognition")
    parser.add_argument("--emotion-metadata", action="store_true", help="Expose founder emotion state as presentation metadata only")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535 or not 1 <= args.tts_timeout <= 300:
        parser.error("port must be 1..65535 and tts-timeout must be 1..300 seconds")
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
    try:
        worker = LocalF5Worker(args.f5_worker_url) if args.f5_worker_url else None
        if worker and urlparse(worker.url).port == args.port:
            parser.error("the F5 worker must use a different loopback port from this bridge")
        emotion = load_emotion(args.data_dir / "emotion") if args.emotion_metadata else None
        service = VoiceService(LocalMemory(args.data_dir / "memory.sqlite3"),
                               WindowsSpeech(args.tts_timeout), worker, emotion, configured_recognizer(args.stt_config))
        server = VoiceHTTPServer((args.host, args.port), service)
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(1, f"Could not initialize the local voice bridge ({type(error).__name__}).\n")
    LOG.info("Listening at http://%s:%d; cloud memory/STT disabled; file-only offline STT ready=%s.", args.host, args.port, bool(service.recognizer.recognizers))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
