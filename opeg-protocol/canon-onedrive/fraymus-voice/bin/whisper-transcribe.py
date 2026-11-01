#!/usr/bin/env python3
"""Trusted local-file Whisper worker; invoked only by the bounded voice bridge.

The isolated interpreter/dependencies/model are installed by the operator setup CLI.
This worker never downloads a model, accepts a network URL, or opens a microphone.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import wave


ENGINE = "faster-whisper-cpu"
METRIC = "exp_avg_logprob"
MAX_PROTOCOL = 65536


def offline_environment():
    keep = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"}
    for name in list(os.environ):
        if name.upper() not in keep:
            del os.environ[name]
    os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1",
                       "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                       "DO_NOT_TRACK": "1", "OMP_NUM_THREADS": "4", "MKL_NUM_THREADS": "4",
                       "OPENBLAS_NUM_THREADS": "4", "CUDA_VISIBLE_DEVICES": ""})


def pcm_for_whisper(audio_path, metadata):
    """Decode our strict PCM16 subset without faster-whisper's av.open compatibility path."""
    import av
    import numpy as np
    with wave.open(str(audio_path), "rb") as source:
        actual = {"durationSeconds": source.getnframes() / source.getframerate(),
                  "sampleRate": source.getframerate(), "channels": source.getnchannels(),
                  "sampleWidth": source.getsampwidth()}
        if actual != metadata or source.getcomptype() != "NONE":
            raise ValueError("original WAV metadata")
        raw = source.readframes(source.getnframes())
        if len(raw) != source.getnframes() * source.getnchannels() * 2:
            raise ValueError("complete PCM frames")
    frame = av.AudioFrame.from_ndarray(np.frombuffer(raw, dtype="<i2").reshape(1, -1),
                                      format="s16", layout="mono" if metadata["channels"] == 1 else "stereo")
    frame.sample_rate = metadata["sampleRate"]
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    frames = resampler.resample(frame) + resampler.resample(None)
    # A valid clip shorter than the resampling filter's support can yield no
    # samples even after flushing. There is no speech to decode in that case.
    if not frames:
        return None
    samples = np.concatenate([part.to_ndarray().reshape(-1) for part in frames]).astype(np.float32) / 32768.0
    if not len(samples) or abs(len(samples) / 16000 - metadata["durationSeconds"]) > 0.001:
        raise ValueError("complete resampled stream")
    return samples


def complete(model, audio_path, metadata):
    """Consume the whole generator. Limits/errors never return successful partial text."""
    samples = pcm_for_whisper(audio_path, metadata)
    if samples is None:
        return {"status": "no_speech"}
    segments, information = model.transcribe(
        samples, language="en", task="transcribe", beam_size=5, temperature=0,
        condition_on_previous_text=False, initial_prompt=None, prefix=None, hotwords=None,
        vad_filter=True, vad_parameters={"min_silence_duration_ms": 500},
        word_timestamps=False, log_progress=False,
    )
    duration = metadata["durationSeconds"]
    # The decoder resamples internally to 16 kHz; duration may round by a resampled frame.
    if not math.isfinite(information.duration) or abs(information.duration - duration) > max(0.001, 1 / metadata["sampleRate"]):
        return {"status": "incomplete"}
    checked, characters, weighted_logprob, weights = [], 0, 0.0, 0
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        characters += len(text) + (1 if checked else 0)
        if characters > 12000 or len(checked) >= 256:
            return {"status": "output_limit"}
        logprob = float(segment.avg_logprob)
        if not math.isfinite(logprob) or logprob > 0:
            return {"status": "failed"}
        weight = max(1, len(segment.tokens))
        weighted_logprob += logprob * weight
        weights += weight
        start, end = float(segment.start), float(segment.end)
        if not math.isfinite(start) or not math.isfinite(end) or end < start:
            return {"status": "failed"}
        # Decoder timestamps are estimated alignments, not exact word boundaries.
        # Clamp their timestamp-grid rounding to the original file's bounds.
        start = max(0.0, min(duration, start))
        end = max(start, min(duration, end))
        checked.append({"text": text, "confidence": math.exp(logprob),
                        "startSeconds": start, "durationSeconds": end - start})
    if not checked:
        return {"status": "no_speech"}
    return {"status": "ok", "language": "en", "segments": checked,
            "confidence": math.exp(weighted_logprob / weights)}


def main():
    result = {"status": "failed", "engine": ENGINE, "confidenceMetric": METRIC}
    try:
        # Parent attaches the worker to its kill-on-close Job before sending JSON.
        payload = sys.stdin.buffer.read(MAX_PROTOCOL + 1)
        if len(payload) > MAX_PROTOCOL:
            raise ValueError("protocol size")
        request = json.loads(payload)
        if not isinstance(request, dict) or request.get("operation") not in ("health", "recognize"):
            raise ValueError("operation")
        offline_environment()
        bridge_source = Path(__file__).with_name("local-voice-server.py")
        spec = importlib.util.spec_from_file_location("local_voice_worker_contract", bridge_source)
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        config = bridge.validate_whisper_config(request.get("configPath"))
        result["model"] = config["model"]
        from faster_whisper import WhisperModel
        model = WhisperModel(config["modelDir"], device="cpu", compute_type="int8",
                             cpu_threads=4, num_workers=1, local_files_only=True)
        if str(model.model.device) != "cpu" or str(model.model.compute_type) not in ("int8", "int8_float32"):
            raise ValueError("CPU device")
        if request["operation"] == "health":
            result.update({"status": "ready", "language": "en", "computeTypeRequested": "int8",
                           "computeTypeActual": str(model.model.compute_type), "cpuThreads": 4, "numWorkers": 1})
        else:
            if request.get("language") != "en":
                raise ValueError("language")
            audio_path = Path(request.get("path", ""))
            if not audio_path.is_absolute() or not audio_path.is_file() or audio_path.stat().st_size > bridge.MAX_LISTEN_AUDIO:
                raise ValueError("private WAV path")
            audio, metadata, silent = bridge.listen_audio(base64.b64encode(audio_path.read_bytes()).decode("ascii"))
            if metadata != request.get("audio"):
                raise ValueError("original audio metadata")
            result.update({"status": "no_speech"} if silent else complete(model, audio_path, metadata))
    except BaseException:
        # Do not emit exception messages, host paths, tokens, or successful partial text.
        result["status"] = "failed"
    output = json.dumps(result, ensure_ascii=True, allow_nan=False, separators=(",", ":")).encode("ascii")
    if len(output) > 256 * 1024:
        output = json.dumps({"status": "output_limit", "engine": ENGINE, "confidenceMetric": METRIC,
                             "model": result.get("model")}, separators=(",", ":")).encode("ascii")
    sys.stdout.buffer.write(output)


if __name__ == "__main__":
    main()
