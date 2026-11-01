"""Mocked/offline contract tests; no model, dependency installation, or inference."""
import base64
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import tempfile
import wave
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "bin" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
bridge = load("whisper_bridge_tests", "local-voice-server.py")
worker = load("whisper_worker_tests", "whisper-transcribe.py")
MODEL = {"id": "Systran/faster-whisper-small.en", "revision": "a" * 40}
META = {"durationSeconds": 2.0, "sampleRate": 16000, "channels": 1, "sampleWidth": 2}


class LocalConfiguration(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="fraymus-whisper-config-")
        self.root = Path(self.directory.name).resolve()
        python = self.root / ".venv-asr" / "Scripts" / "python.exe"
        python.parent.mkdir(parents=True); python.write_bytes(b"test interpreter fixture only")
        model = self.root / "data" / "stt-models" / "small.en" / MODEL["revision"]
        model.mkdir(parents=True)
        files = {}
        for name in bridge.WHISPER_FILES:
            content = ("synthetic fixture " + name).encode()
            (model / name).write_bytes(content)
            files[name] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
        self.manifest = self.root / "data" / "stt-setup-manifest.json"
        self.manifest.write_text(json.dumps({"model": MODEL, "files": files}))
        self.config = {"schemaVersion": 1, "engine": "faster-whisper-cpu", "python": str(python),
                       "modelDir": str(model), "model": MODEL, "manifest": str(self.manifest),
                       "device": "cpu", "computeType": "int8", "cpuThreads": 4, "numWorkers": 1, "offline": True}
        self.path = self.root / "data" / "stt-config.json"
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.config))

    def tearDown(self):
        self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
        self.assertTrue(self.root.name.startswith("fraymus-whisper-config-"))
        self.directory.cleanup()

    def test_complete_local_manifest_and_pinned_runtime_are_accepted(self):
        self.assertEqual(bridge.validate_whisper_config(self.path, self.root), self.config)

    def test_model_corruption_extra_files_and_missing_files_fail_closed(self):
        directory = Path(self.config["modelDir"])
        for action in (lambda: (directory / "model.bin").write_bytes(b"corrupt"),
                       lambda: (directory / "extra.json").write_text("{}"),
                       lambda: (directory / "tokenizer.json").unlink()):
            action()
            with self.assertRaises(bridge.BridgeError) as result:
                bridge.validate_whisper_config(self.path, self.root)
            self.assertEqual(result.exception.code, "stt_unavailable")

    def test_cuda_mutable_revision_remote_interpreter_or_nonoffline_configuration_is_rejected(self):
        for change in [{"device": "cuda"}, {"computeType": "float32"}, {"cpuThreads": 8}, {"offline": False},
                       {"python": "https://unapproved.example/python.exe"}, {"extraCommand": "unsafe"},
                       {"model": {"id": MODEL["id"], "revision": "main"}}]:
            original = self.config.copy(); self.config.update(change); self.save()
            with self.subTest(change=change), self.assertRaises(bridge.BridgeError):
                bridge.validate_whisper_config(self.path, self.root)
            self.config = original

    def test_manifest_identity_hash_and_byte_counts_are_verified(self):
        original = json.loads(self.manifest.read_text())
        for mutate in [lambda value: value["model"].update({"revision": "b" * 40}),
                       lambda value: value["files"]["model.bin"].update({"sha256": "0" * 64}),
                       lambda value: value["files"]["model.bin"].update({"bytes": 1})]:
            value = json.loads(json.dumps(original)); mutate(value)
            self.manifest.write_text(json.dumps(value))
            with self.assertRaises(bridge.BridgeError):
                bridge.validate_whisper_config(self.path, self.root)

    def test_configured_invalid_never_falls_back_to_windows(self):
        with patch.object(bridge, "WhisperRecognition", side_effect=bridge.BridgeError(503, "stt_unavailable", "bad")), \
                patch.object(bridge, "WindowsRecognition", side_effect=AssertionError("must not fall back")):
            selected = bridge.configured_recognizer(self.path)
        self.assertEqual(selected.engine, "faster-whisper-cpu")
        self.assertEqual(selected.recognizers, [])

    def test_absent_configuration_uses_explicit_windows_baseline(self):
        sentinel = object()
        with patch.object(bridge, "WindowsRecognition", return_value=sentinel):
            self.assertIs(bridge.configured_recognizer(self.root / "absent.json"), sentinel)


class DecoderContracts(unittest.TestCase):
    def segment(self, text="One.", logprob=-0.2, tokens=2, start=0, end=1):
        return SimpleNamespace(text=text, avg_logprob=logprob, tokens=list(range(tokens)), start=start, end=end)

    def model(self, values, duration=2.0):
        calls = []
        def transcribe(audio, **options):
            calls.append(options)
            return iter(values), SimpleNamespace(duration=duration, language_probability=0.9999)
        return SimpleNamespace(transcribe=transcribe), calls

    def test_empty_resampler_flush_is_no_speech_without_decoder_call(self):
        model, calls = self.model([self.segment()])
        with patch.object(worker, "pcm_for_whisper", return_value=None):
            self.assertEqual(worker.complete(model, Path("tiny.wav"), META), {"status": "no_speech"})
        self.assertEqual(calls, [])

    def test_pcm_short_clip_with_no_resampled_frames_has_explicit_empty_result(self):
        frame = SimpleNamespace(sample_rate=0)
        av = SimpleNamespace(AudioFrame=SimpleNamespace(from_ndarray=lambda *a, **kw: frame),
                             AudioResampler=lambda **kw: SimpleNamespace(resample=lambda source: []))
        numpy = SimpleNamespace(frombuffer=lambda *a, **kw: SimpleNamespace(reshape=lambda *a: "packed PCM"),
                                concatenate=lambda *a: self.fail("empty frames must not be concatenated"))
        with tempfile.TemporaryDirectory(prefix="fraymus-pcm-short-") as directory:
            target = Path(directory) / "tiny.wav"
            with wave.open(str(target), "wb") as output:
                output.setnchannels(1); output.setsampwidth(2); output.setframerate(48000)
                output.writeframes(b"\x01\x00")
            metadata = {"durationSeconds": 1 / 48000, "sampleRate": 48000, "channels": 1, "sampleWidth": 2}
            with patch.dict("sys.modules", {"av": av, "numpy": numpy}):
                self.assertIsNone(worker.pcm_for_whisper(target, metadata))

    def test_full_generator_score_uses_logprobs_and_tokens_without_phrase_or_language_probability_hints(self):
        model, calls = self.model([self.segment(), self.segment("Two.", -0.8, 4, 1, 2)])
        with patch.object(worker, "pcm_for_whisper", return_value="synthetic array"):
            result = worker.complete(model, Path("synthetic.wav"), META)
        self.assertEqual(result["status"], "ok")
        self.assertAlmostEqual(result["confidence"], math.exp(-0.6))
        self.assertAlmostEqual(result["segments"][0]["confidence"], math.exp(-0.2))
        self.assertIsNone(calls[0]["initial_prompt"]); self.assertIsNone(calls[0]["hotwords"])
        self.assertFalse(calls[0]["condition_on_previous_text"])
        self.assertEqual(calls[0]["language"], "en")

    def test_decoder_time_grid_is_clamped_to_original_audio_and_not_called_exact_alignment(self):
        model, _ = self.model([self.segment(start=-0.02, end=2.2)])
        with patch.object(worker, "pcm_for_whisper", return_value="array"):
            result = worker.complete(model, Path("fixture.wav"), META)
        self.assertEqual(result["segments"][0]["startSeconds"], 0)
        self.assertEqual(result["segments"][0]["durationSeconds"], 2)

    def test_no_speech_incomplete_output_limit_and_bad_scores_are_not_partial_successes(self):
        for values, duration, status in [([], 2, "no_speech"), ([self.segment()], 1, "incomplete"),
                                         ([self.segment("x" * 12001)], 2, "output_limit"),
                                         ([self.segment(logprob=math.nan)], 2, "failed"),
                                         ([self.segment(logprob=0.1)], 2, "failed")]:
            model, _ = self.model(values, duration)
            with self.subTest(status=status), patch.object(worker, "pcm_for_whisper", return_value="array"):
                result = worker.complete(model, Path("fixture.wav"), META)
            self.assertEqual(result["status"], status)
            self.assertNotIn("segments", result)

    def test_generator_failure_is_not_converted_to_successful_partial_results(self):
        def segments():
            yield self.segment()
            raise RuntimeError("synthetic late decoder failure")
        model = SimpleNamespace(transcribe=lambda *args, **kwargs: (segments(), SimpleNamespace(duration=2)))
        with patch.object(worker, "pcm_for_whisper", return_value="array"), self.assertRaises(RuntimeError):
            worker.complete(model, Path("fixture.wav"), META)

    def test_receipt_preserves_model_metric_language_and_original_audio(self):
        provider = bridge.WhisperRecognition.__new__(bridge.WhisperRecognition)
        provider.model, provider.config_path = MODEL, Path("server-config.json")
        provider.recognizers = [{"id": "fixture", "language": "en"}]
        provider._run = lambda script, payload, timeout: {"status": "ok", "model": MODEL,
            "confidenceMetric": "exp_avg_logprob", "confidence": 0.6, "language": "en",
            "segments": [{"text": "Words.", "confidence": 0.5, "startSeconds": 0, "durationSeconds": 2}]}
        result = provider.recognize(b"synthetic already validated bytes", META, "en-US")
        self.assertEqual(result["model"], MODEL); self.assertEqual(result["language"], "en")
        self.assertEqual(result["confidence"], 0.6); self.assertEqual(result["confidenceMetric"], "exp_avg_logprob")
        self.assertEqual(result["audio"], META)
        with self.assertRaises(bridge.BridgeError) as failure:
            provider.recognize(b"bytes", META, "fr-FR")
        self.assertEqual(failure.exception.code, "language_unavailable")

    def test_whisper_process_is_isolated_offline_and_ignores_ambient_hf_tokens(self):
        provider = bridge.WhisperRecognition.__new__(bridge.WhisperRecognition)
        provider.executable = "C:\\operator-venv\\python.exe"
        process = SimpleNamespace(stdin=io.BytesIO(), stdout=io.BytesIO(b'{"status":"ready"}'), returncode=0,
                                  wait=lambda timeout: 0, poll=lambda: 0, kill=lambda: None)
        with patch.object(bridge.subprocess, "Popen", return_value=process) as spawn, \
                patch.object(bridge, "recognition_process_job", return_value=lambda: None), \
                patch.dict(bridge.os.environ, {"HF_TOKEN": "synthetic-token", "OPENAI_API_KEY": "synthetic-key"}):
            provider._run(None, {"operation": "health"}, 25)
        arguments, options = spawn.call_args
        self.assertEqual(arguments[0][1], "-I")
        self.assertTrue(arguments[0][2].endswith("whisper-transcribe.py"))
        self.assertEqual(options["env"]["HF_HUB_OFFLINE"], "1")
        self.assertEqual(options["env"]["HF_HUB_DISABLE_IMPLICIT_TOKEN"], "1")
        self.assertNotIn("HF_TOKEN", options["env"]); self.assertNotIn("OPENAI_API_KEY", options["env"])
        self.assertFalse(options["shell"])


if __name__ == "__main__":
    unittest.main()
