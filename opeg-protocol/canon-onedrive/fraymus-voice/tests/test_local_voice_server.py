"""Contract tests use fake synthesis, temporary memory, and ephemeral loopback ports."""
from concurrent.futures import ThreadPoolExecutor
import base64
import http.client
import importlib.util
import io
import json
import math
from pathlib import Path
import subprocess
import struct
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.parse import urlencode
import wave


SOURCE = Path(__file__).resolve().parents[1] / "bin" / "local-voice-server.py"
SPEC = importlib.util.spec_from_file_location("local_voice_server", SOURCE)
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


def wav_bytes(sample_rate=16000, channels=1, sample_width=2, frames=160, value=0):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        sample = int(value).to_bytes(sample_width, "little", signed=sample_width > 1)
        wav.writeframes(sample * channels * frames)
    return output.getvalue()


class FakeSpeech:
    engine = "test-fake"
    voices = ["Test Voice"]

    def __init__(self):
        self.active = 0
        self.max_active = 0
        self.calls = []
        self.lock = threading.Lock()

    def synthesize(self, text, voice):
        if voice not in ("default", "partner", "Test Voice"):
            raise bridge.BridgeError(400, "unknown_voice", "Unknown voice.")
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append((text, voice))
        try:
            time.sleep(0.02)
            return wav_bytes()
        finally:
            with self.lock:
                self.active -= 1


class FakeRecognition:
    engine = "windows-system-speech-recognition"

    def __init__(self, ready=False):
        self.recognizers = [{"id": "MS-1033-80-DESK", "language": "en-US", "name": "Test desktop recognizer"}] if ready else []
        self.calls, self.active, self.max_active = [], 0, 0

    def recognize(self, audio, metadata, language=None):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.calls.append((audio, metadata, language))
        try:
            time.sleep(0.02)
            return {"ok": True, "transcript": "Synthetic transcript.", "engine": self.engine,
                    "language": "en-US", "confidence": 0.7,
                    "segments": [{"text": "Synthetic transcript.", "confidence": 0.7}], "audio": metadata}
        finally:
            self.active -= 1


class HTTPContracts(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.database = Path(self.directory.name) / "memory.sqlite3"
        self.synth = FakeSpeech()
        self.recognizer = FakeRecognition()
        self.service = bridge.VoiceService(bridge.LocalMemory(self.database), self.synth, recognizer=self.recognizer)
        self.server = bridge.VoiceHTTPServer(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.directory.cleanup()

    def request(self, method, path, body=None, headers=None):
        headers = dict(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_truthful_health_and_no_cloud(self):
        status, _, data = self.request("GET", "/health")
        health = json.loads(data)
        self.assertEqual(status, 200)
        self.assertEqual(health["capabilities"], {
            "tts": True, "stt": False, "local_stt": False, "cloud_stt": False, "voice_cloning": False,
            "local_memory": True, "cloud_memory": False,
        })
        self.assertFalse(health["full_duplex"])
        self.assertEqual(health["voices"], ["Test Voice"])
        self.synth.voices = []
        unavailable = json.loads(self.request("GET", "/health")[2])
        self.assertFalse(unavailable["ready"])
        self.assertFalse(unavailable["capabilities"]["tts"])
        self.assertEqual(unavailable["engine"], "unavailable")

    def test_local_memory_persists_and_filters_conversation(self):
        for conversation in ("studio", "other"):
            result = self.request("POST", "/memory", {
                "text": f"The orchid project belongs to {conversation}.",
                "role": "assistant", "conversationId": conversation,
            })
            self.assertEqual(result[0], 200)
        self.service.memory = bridge.LocalMemory(self.database)
        query = urlencode({"q": "orchid", "conversationId": "studio"})
        response = json.loads(self.request("GET", "/memory?" + query)[2])
        self.assertEqual(len(response["hits"]), 1)
        hit = response["hits"][0]
        self.assertEqual(hit["conversationId"], "studio")
        self.assertEqual(hit["role"], "assistant")
        self.assertEqual(hit["source"], "local-sqlite")
        self.assertFalse(hit["trusted"])
        self.assertTrue(hit["createdAt"].endswith("Z"))
        self.assertEqual(json.loads(self.request("GET", "/memory?q=")[2])["hits"], [])

    def test_memory_sql_parameters_and_limits(self):
        self.request("POST", "/memory", {"text": "A unique plum item."})
        query = urlencode({"q": "unmatched' OR 1=1 --"})
        self.assertEqual(json.loads(self.request("GET", "/memory?" + query)[2])["hits"], [])
        for limit in ("0", "21", "abc"):
            self.assertEqual(self.request("GET", "/memory?q=orchid&limit=" + limit)[0], 400)
        self.assertEqual(self.request("GET", "/memory?" + "a=1&" * 12)[0], 400)
        self.assertEqual(self.request("GET", "/memory?q=" + "a" * 1001)[0], 400)

    def test_speak_returns_real_wav_and_preserves_literal_text(self):
        text = 'Literal $() text; quotes " and Unicode: café.'
        status, headers, audio = self.request("POST", "/speak", {"text": text, "voice": "partner"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(bridge.validate_wav(audio), audio)
        self.assertEqual(self.synth.calls, [(text, "partner")])

    def test_concurrent_speech_is_serialized(self):
        def speak(index):
            return self.request("POST", "/speak", {"text": f"Message {index}"})
        with ThreadPoolExecutor(max_workers=5) as pool:
            responses = list(pool.map(speak, range(5)))
        self.assertTrue(all(status == 200 for status, _, _ in responses))
        self.assertEqual(self.synth.max_active, 1)
        self.assertEqual(len(self.synth.calls), 5)
        self.assertTrue(all(bridge.validate_wav(audio) for _, _, audio in responses))

    def test_rejects_invalid_provider_audio(self):
        self.synth.synthesize = lambda text, voice: b"not a WAV"
        status, headers, data = self.request("POST", "/speak", {"text": "hello"})
        self.assertEqual(status, 502)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(json.loads(data)["error"]["code"], "invalid_audio")

    def test_unknown_voice_is_not_routed_to_another_provider(self):
        self.assertEqual(self.request("POST", "/speak", {"text": "hello", "voice": "phonon"})[0], 400)

    def test_listen_is_explicitly_unavailable(self):
        status, _, data = self.request("POST", "/listen", {"audioBase64": base64.b64encode(wav_bytes(value=1000)).decode()})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(data)["error"]["code"], "stt_unavailable")

    def test_file_recognition_health_and_receipt(self):
        self.service.recognizer = self.recognizer = FakeRecognition(True)
        health = json.loads(self.request("GET", "/health")[2])
        self.assertTrue(health["stt_ready"])
        self.assertTrue(health["capabilities"]["stt"])
        self.assertTrue(health["capabilities"]["local_stt"])
        self.assertFalse(health["capabilities"]["cloud_stt"])
        self.assertEqual(health["languages"], ["en-US"])
        audio = wav_bytes(sample_rate=22050, channels=2, frames=2205, value=1000)
        status, _, raw = self.request("POST", "/listen", {"audioBase64": base64.b64encode(audio).decode(), "language": "en"})
        receipt = json.loads(raw)
        self.assertEqual(status, 200)
        self.assertEqual(receipt["engine"], "windows-system-speech-recognition")
        self.assertEqual(receipt["audio"], {"durationSeconds": 0.1, "sampleRate": 22050, "channels": 2, "sampleWidth": 2})
        self.assertEqual(self.recognizer.calls[0][0], audio)
        self.assertEqual(receipt["transcript"], "Synthetic transcript.")

    def test_listen_json_limit_is_separate_from_other_endpoints(self):
        self.service.recognizer = FakeRecognition(True)
        audio = wav_bytes(frames=40000, value=1000)
        body = {"audioBase64": base64.b64encode(audio).decode()}
        self.assertGreater(len(json.dumps(body)), bridge.MAX_BODY)
        self.assertEqual(self.request("POST", "/listen", body)[0], 200)
        self.assertEqual(self.request("POST", "/speak", body)[0], 413)
        self.assertEqual(self.request("POST", "/listen", b"", {"Content-Type": "application/json",
                         "Content-Length": str(bridge.MAX_LISTEN_BODY + 1)})[0], 413)

    def test_listen_rejects_unknown_fields_bad_language_and_base64(self):
        self.service.recognizer = FakeRecognition(True)
        valid = base64.b64encode(wav_bytes(value=1000)).decode()
        cases = [({}, "invalid_base64"), ({"audioBase64": valid, "url": "https://unapproved.example"}, "unknown_fields"),
                 ({"audioBase64": valid, "language": None}, "invalid_field"),
                 ({"audioBase64": valid, "language": "en-US; invoke script"}, "invalid_field"),
                 ({"audioBase64": valid + "\n"}, "invalid_base64"),
                 ({"audioBase64": "data:audio/wav;base64," + valid}, "invalid_base64"),
                 ({"audioBase64": "Zh=="}, "invalid_base64")]
        for body, code in cases:
            with self.subTest(code=code):
                status, _, data = self.request("POST", "/listen", body)
                self.assertEqual(status, 400)
                self.assertEqual(json.loads(data)["error"]["code"], code)

    def test_silence_returns_no_speech_without_launching_a_recognizer(self):
        self.service.recognizer = self.recognizer = FakeRecognition(True)
        status, _, raw = self.request("POST", "/listen", {"audioBase64": base64.b64encode(wav_bytes()).decode()})
        self.assertEqual(status, 422)
        self.assertEqual(json.loads(raw)["error"]["code"], "no_speech")
        self.assertEqual(self.recognizer.calls, [])

    def test_concurrent_recognition_is_serialized(self):
        self.service.recognizer = self.recognizer = FakeRecognition(True)
        body = {"audioBase64": base64.b64encode(wav_bytes(value=1000)).decode()}
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.request("POST", "/listen", body), range(2)))
        self.assertTrue(all(result[0] == 200 for result in responses))
        self.assertEqual(self.recognizer.max_active, 1)

    def test_json_and_field_validation(self):
        cases = [
            (b"{broken", {"Content-Type": "application/json"}, 400),
            (b"[]", {"Content-Type": "application/json"}, 400),
            (b"\xff", {"Content-Type": "application/json"}, 400),
            (b"{}", {"Content-Type": "text/plain"}, 415),
            ({"text": " "}, {}, 400),
            ({"text": 123}, {}, 400),
            ({"text": "a" * 4001}, {}, 400),
            ({"text": "x\x00y"}, {}, 400),
            (b"x" * (bridge.MAX_BODY + 1), {"Content-Type": "application/json"}, 413),
        ]
        for body, headers, expected in cases:
            with self.subTest(expected=expected, body_type=type(body)):
                self.assertEqual(self.request("POST", "/speak", body, headers)[0], expected)
        self.assertEqual(self.request("POST", "/memory", {"text": "hello", "role": "execute"})[0], 400)

    def test_origins_preflight_host_and_exact_paths(self):
        allowed = "http://127.0.0.1:8787"
        status, headers, _ = self.request("OPTIONS", "/speak", headers={
            "Origin": allowed, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], allowed)
        status, headers, _ = self.request("GET", "/health", headers={"Origin": "https://untrusted.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.request("GET", "/health", headers={"Host": "attacker.example"})[0], 403)
        self.assertEqual(self.request("GET", "/health-pretend")[0], 404)
        self.assertEqual(self.request("POST", "/memory-pretend", {"text": "hi"})[0], 404)

    def test_emotion_is_metadata_only(self):
        self.service.emotion = SimpleNamespace(state=lambda: {"valence": 0.2, "dials": {"risk_budget": 1}})
        data = json.loads(self.request("GET", "/memory?q=anything")[2])
        self.assertEqual(data["emotion_state"]["valence"], 0.2)
        self.assertEqual(self.service.health()["capabilities"]["cloud_memory"], False)


class ProviderBoundaries(unittest.TestCase):
    def test_windows_payload_is_stdin_json_not_command_code(self):
        synth = bridge.WindowsSpeech.__new__(bridge.WindowsSpeech)
        synth.executable = "powershell.exe"
        sensitive = 'hello $([IO.File]::Delete("anything")); " text'
        with patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="{}")) as run:
            synth._run(bridge.WindowsSpeech._SPEAK, {"text": sensitive}, 10)
        args, kwargs = run.call_args
        self.assertNotIn(sensitive, " ".join(args[0]))
        self.assertEqual(json.loads(kwargs["input"])["text"], sensitive)
        decoded = base64.b64decode(args[0][-1]).decode("utf-16le")
        self.assertIn("ConvertFrom-Json", decoded)
        self.assertNotIn(sensitive, decoded)
        self.assertFalse(kwargs.get("shell", False))

    def test_windows_timeout_and_error_do_not_expose_provider_diagnostics(self):
        synth = bridge.WindowsSpeech.__new__(bridge.WindowsSpeech)
        synth.executable = "powershell.exe"
        with patch.object(bridge.subprocess, "run", side_effect=subprocess.TimeoutExpired("powershell", 1)):
            with self.assertRaises(bridge.BridgeError) as result:
                synth._run("static script", {}, 1)
            self.assertEqual(result.exception.status, 504)
        with patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr="PRIVATE TEXT")):
            with self.assertRaises(bridge.BridgeError) as result:
                synth._run("static script", {}, 1)
            self.assertNotIn("PRIVATE TEXT", str(result.exception))

    def test_windows_unique_output_files_are_removed(self):
        synth = bridge.WindowsSpeech.__new__(bridge.WindowsSpeech)
        synth.voices, synth.timeout = ["Test Voice"], 10
        outputs = []
        def fake_run(script, payload, timeout):
            output = Path(payload["output"])
            outputs.append(output)
            output.write_bytes(wav_bytes())
        synth._run = fake_run
        for _ in range(2):
            self.assertEqual(bridge.validate_wav(synth.synthesize("hello", "default")), wav_bytes())
        self.assertEqual(len(set(outputs)), 2)
        self.assertTrue(all(not output.exists() for output in outputs))

    def test_f5_worker_requires_explicit_loopback_origin(self):
        for url in ("https://example.com", "http://192.168.1.2:9099", "http://user:pass@localhost:9099", "http://localhost:9099/path"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                bridge.LocalF5Worker(url)
        worker = bridge.LocalF5Worker("http://localhost:9098")
        self.assertEqual(worker.url, "http://127.0.0.1:9098")
        self.assertIsNone(bridge.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://example.com"))

    def test_f5_redirect_is_not_followed_over_http(self):
        calls = []
        class Redirect(bridge.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                calls.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/redirect-target")
                self.send_header("Content-Length", "0")
                self.end_headers()
        server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            worker = bridge.LocalF5Worker(f"http://127.0.0.1:{server.server_address[1]}")
            self.assertFalse(worker.ready())
            self.assertEqual(calls, ["/health"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_wav_rejects_truncated_output(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_wav(wav_bytes()[:-2])


class RecognitionBoundaries(unittest.TestCase):
    def setUp(self):
        self.audio = wav_bytes(frames=1600, value=1000)
        self.metadata = {"durationSeconds": 0.1, "sampleRate": 16000, "channels": 1, "sampleWidth": 2}

    def recognition(self, result=None):
        provider = bridge.WindowsRecognition.__new__(bridge.WindowsRecognition)
        provider.recognizers = [{"id": "MS-1033-80-DESK", "language": "en-US", "name": "Test"}]
        self.paths = []
        def run(script, payload, timeout):
            self.paths.append(Path(payload["path"]))
            self.assertTrue(self.paths[-1].exists())
            self.assertEqual(self.paths[-1].read_bytes(), self.audio)
            self.assertEqual(payload["recognizerId"], "MS-1033-80-DESK")
            self.assertEqual(timeout, 25)
            return result if result is not None else {"status": "ok", "language": "en-US", "segments": [
                {"text": "First utterance.", "confidence": 0.5, "startSeconds": 0, "durationSeconds": 0.04},
                {"text": "Second utterance.", "confidence": 0.8, "startSeconds": 0.05, "durationSeconds": 0.04}]}
        provider._run = run
        return provider

    def test_strict_pcm_formats_bounds_and_fmt18(self):
        for sample_rate, channels in [(8000, 1), (48000, 2), (22050, 1)]:
            audio = wav_bytes(sample_rate=sample_rate, channels=channels, frames=sample_rate // 10, value=10)
            data, metadata, silent = bridge.listen_audio(base64.b64encode(audio).decode())
            self.assertEqual(data, audio)
            self.assertEqual(metadata["durationSeconds"], 0.1)
            self.assertFalse(silent)
        data = bytearray(self.audio)
        data[16:20] = struct.pack("<I", 18)
        data[36:36] = b"\x00\x00"
        struct.pack_into("<I", data, 4, len(data) - 8)
        self.assertEqual(bridge.listen_audio(base64.b64encode(data).decode())[1], self.metadata)
        exact = wav_bytes(sample_rate=8000, frames=480000, value=10)
        self.assertEqual(bridge.listen_audio(base64.b64encode(exact).decode())[1]["durationSeconds"], 60)
        with self.assertRaises(bridge.BridgeError):
            bridge.listen_audio(base64.b64encode(wav_bytes(sample_rate=8000, frames=480001, value=10)).decode())

    def test_rejects_truncated_float_misaligned_and_noncanonical_audio(self):
        changed = []
        for offset, value, kind in [(20, 3, "<H"), (22, 3, "<H"), (24, 7999, "<I"),
                                    (24, 48001, "<I"), (28, 1, "<I"), (32, 4, "<H"), (34, 8, "<H")]:
            data = bytearray(self.audio); struct.pack_into(kind, data, offset, value); changed.append(data)
        changed += [self.audio[:-1], self.audio + b"extra", b"RIFF" + b"\x00" * 40,
                    wav_bytes(sample_width=1), wav_bytes(sample_width=3)]
        for audio in changed:
            with self.subTest(size=len(audio)), self.assertRaises(bridge.BridgeError) as result:
                bridge.listen_audio(base64.b64encode(audio).decode())
            self.assertEqual(result.exception.code, "invalid_wav")
        for encoded in ["AA", "AA==\n", "AB==", "data:audio/wav;base64,AA==", "é==="]:
            with self.subTest(encoded=encoded), self.assertRaises(bridge.BridgeError) as result:
                bridge.listen_audio(encoded)
            self.assertEqual(result.exception.code, "invalid_base64")
        with self.assertRaises(bridge.BridgeError) as result:
            bridge.listen_audio(base64.b64encode(b"x" * (bridge.MAX_LISTEN_AUDIO + 1)).decode())
        self.assertEqual(result.exception.status, 413)

    def test_segment_receipt_and_generic_language_preserve_real_metadata_and_cleanup(self):
        provider = self.recognition()
        result = provider.recognize(self.audio, self.metadata, "en")
        self.assertEqual(result["transcript"], "First utterance. Second utterance.")
        self.assertEqual(result["language"], "en-US")
        self.assertTrue(0 <= result["confidence"] <= 1)
        self.assertEqual(result["audio"], self.metadata)
        self.assertTrue(all(not path.exists() for path in self.paths))
        with self.assertRaises(bridge.BridgeError) as error:
            provider.recognize(self.audio, self.metadata, "en-GB")
        self.assertEqual(error.exception.code, "language_unavailable")

    def test_no_speech_timeout_partial_and_output_limit_never_return_partial_success(self):
        for status, code in [("no_speech", "no_speech"), ("timeout", "recognition_timeout"),
                             ("incomplete", "recognition_incomplete"), ("output_limit", "output_limit"), ("failed", "recognition_failed")]:
            provider = self.recognition({"status": status, "language": "en-US", "segments": [{"text": "partial", "confidence": 0.9}]})
            with self.subTest(status=status), self.assertRaises(bridge.BridgeError) as error:
                provider.recognize(self.audio, self.metadata)
            self.assertEqual(error.exception.code, code)
            self.assertTrue(all(not path.exists() for path in self.paths))

    def test_provider_confidence_timing_and_transcript_bounds_are_checked(self):
        for segment in [{"text": "x", "confidence": math.nan}, {"text": "x", "confidence": True},
                        {"text": "x", "confidence": 1.1}, {"text": " ", "confidence": 0.5},
                        {"text": "x", "confidence": 0.5, "startSeconds": -1},
                        {"text": "x", "confidence": 0.5, "startSeconds": 0.08, "durationSeconds": 0.08},
                        {"text": "x" * 12001, "confidence": 0.5}]:
            provider = self.recognition({"status": "ok", "language": "en-US", "segments": [segment]})
            with self.subTest(keys=list(segment)), self.assertRaises(bridge.BridgeError):
                provider.recognize(self.audio, self.metadata)

    def test_static_powershell_receives_only_stdin_json_and_reduced_environment(self):
        provider = bridge.WindowsRecognition.__new__(bridge.WindowsRecognition)
        provider.executable = "powershell.exe"
        payload = {"path": 'C:\\literal $(); quoted " file.wav', "recognizerId": "MS-1033-80-DESK"}
        class Input(io.BytesIO):
            def close(self):
                if not self.closed:
                    self.saved = self.getvalue()
                super().close()
        process = SimpleNamespace(stdin=Input(), stdout=io.BytesIO(b'{"status":"ok"}'), returncode=0,
                                  wait=lambda timeout: 0, poll=lambda: 0, kill=lambda: None)
        with patch.object(bridge.subprocess, "Popen", return_value=process) as spawn, \
                patch.object(bridge, "recognition_process_job", return_value=lambda: None):
            result = provider._run(provider._RECOGNIZE, payload, 25)
        arguments, options = spawn.call_args
        self.assertFalse(options["shell"])
        self.assertEqual(options["stderr"], subprocess.DEVNULL)
        self.assertTrue(set(key.upper() for key in options["env"]) <= {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"})
        self.assertNotIn(payload["path"], " ".join(arguments[0]))
        self.assertEqual(json.loads(process.stdin.saved), payload)
        self.assertEqual(result, {"status": "ok"})
        self.assertNotIn("SetInputToDefaultAudioDevice", provider._RECOGNIZE)
        self.assertIn("SetInputToWaveFile", provider._RECOGNIZE)
        self.assertIn("InputStreamEnded", provider._RECOGNIZE)

    def test_provider_output_overflow_and_timeout_kill_the_owned_process(self):
        provider = bridge.WindowsRecognition.__new__(bridge.WindowsRecognition)
        provider.executable = "powershell.exe"
        class Process:
            def __init__(self, output, timeout=False):
                self.stdin, self.stdout = io.BytesIO(), io.BytesIO(output)
                self.returncode, self.killed, self.timeout = None, False, timeout
            def kill(self):
                self.killed = True; self.returncode = -9
            def wait(self, timeout):
                if self.timeout and not self.killed:
                    raise subprocess.TimeoutExpired("powershell", timeout)
                self.returncode = self.returncode if self.killed else 0
                return self.returncode
            def poll(self):
                return self.returncode
        for process, expected in [(Process(b"x" * (bridge.MAX_RECOGNITION_OUTPUT + 1)), "output_limit"),
                                  (Process(b"", timeout=True), "recognition_timeout")]:
            with patch.object(bridge.subprocess, "Popen", return_value=process), \
                    patch.object(bridge, "recognition_process_job", return_value=lambda: None), \
                    self.assertRaises(bridge.BridgeError) as result:
                provider._run(provider._RECOGNIZE, {}, 1)
            self.assertEqual(result.exception.code, expected)
            self.assertTrue(process.killed)


if __name__ == "__main__":
    unittest.main()
