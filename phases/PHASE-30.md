# Phase 30 — TTS Speech Engine

| Field | Value |
|-------|-------|
| **Phase** | 30 |
| **Title** | Text-to-Speech Pipeline |
| **Status** | Complete |
| **Prev** | [Phase 29 — Video Pipeline](PHASE-29.md) |
| **Next** | [Phase 31 — Audio Transcription (STT) Pipeline](PHASE-31.md) |

## Summary

Adds a complete text-to-speech pipeline with a resilient multi-engine fallback chain. Three engines are supported in cascade order: **Piper** (high-quality offline neural TTS), **edge-tts** (Microsoft Edge neural voices via WebSocket), and **Windows SAPI** (always-available offline). If the primary engine fails at runtime (e.g., edge-tts gets a 403 from Microsoft), the system automatically cascades to the next available engine.

## Architecture

```
ttsSpeak(text, opts)
  ├─ detectEngine(preferred) → pick best available
  ├─ buildCascade(primary)   → [primary, ...others]
  └─ for engine in cascade:
       try engine() → return result
       catch → push error, try next
```

### Engine Priority
1. **Piper** — High-quality offline neural TTS (requires separate install)
2. **edge-tts** — Microsoft Edge neural voices, 400+ voices, MP3 output
3. **SAPI** — Windows System.Speech, 2 voices (David/Zira), WAV output, always available

## Files Created

| File | Purpose |
|------|---------|
| `server/media/tts-engine.js` | Core engine: detectEngine, ttsSpeak (with fallback chain), ttsVoices, ttsStatus, edgeTtsSpeak, piperSpeak, sapiSpeak |
| `server/media/tts-routes.js` | 5 Express endpoints: speak, voices, status, outputs, file serving |

## Files Modified

| File | Change |
|------|--------|
| `server/workflow/engine.js` | Added `tts_speak` node handler |
| `server/workflow/synthesizer.js` | Added `tts_speak` to NODE_CATALOG (now 45 entries) |
| `server/fleet/tools.js` | Added 4 TTS fleet tools: tts_speak, tts_voices, tts_status, tts_list (now 48 tools) |
| `server/runtime.js` | Wired TTS routes + `tts-speech-engine` feature flag |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tts/speak` | Generate speech from text |
| GET | `/api/tts/voices` | List available voices (optional `?engine=` filter) |
| GET | `/api/tts/status` | Engine availability and status |
| GET | `/api/tts/outputs` | List generated audio files |
| GET | `/tts/:file` | Serve generated audio files |

### POST /api/tts/speak

```json
{
  "text": "Hello world",
  "voice": "en-US-AriaNeural",
  "rate": "+0%",
  "pitch": "+0Hz",
  "engine": "edge-tts",
  "model": "en_US-amy-medium"
}
```

Response:
```json
{
  "url": "/tts/1793373980863-81894553.mp3",
  "path": "...",
  "size": 47808,
  "format": "mp3",
  "engine": "edge-tts",
  "voice": "en-US-AriaNeural",
  "durationEstimate": 6
}
```

## Workflow Node

| Node Type | Inputs | Output |
|-----------|--------|--------|
| `tts_speak` | `text` (from data or upstream), optional `voice`, `rate`, `engine` | Audio file URL + metadata |

## Fleet Tools

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `tts_speak` | tts | low | Generate speech audio from text |
| `tts_voices` | tts | none | List available TTS voices |
| `tts_status` | tts | none | Check TTS engine availability |
| `tts_list` | tts | none | List generated TTS files |

## Fallback Chain Pattern

The key design pattern in this phase is the **cascade-on-runtime-failure** approach:

```javascript
const cascade = buildCascade(detectedEngine);
for (const attempt of cascade) {
  try { return await runEngine(attempt); }
  catch (e) { errors.push(e); }
}
throw new Error(`All engines failed: ${errors}`);
```

This differs from Phase 28's image pipeline (which detects at startup) — TTS engines can be "installed" but fail at runtime (e.g., edge-tts token expiry), so the cascade runs on every call.

## Dependencies

- **edge-tts** — `pip install edge-tts` (Python package, v7.3.1+)
- **Piper** — optional, high-quality offline (`piper` binary in PATH)
- **SAPI** — built into Windows (System.Speech assembly), zero dependencies

## Test Results

| Test | Engine | Format | Size | Status |
|------|--------|--------|------|--------|
| Short text | edge-tts | MP3 | 47KB | Pass |
| Long text | edge-tts | MP3 | 85KB | Pass |
| SAPI direct | sapi | WAV | 198KB | Pass |
| Voice listing (SAPI) | sapi | — | 2 voices | Pass |
| Fallback chain | edge-tts→sapi | — | — | Pass |
| Status check | all | — | — | Pass |

## Counts After Phase 30

| Metric | Count |
|--------|-------|
| Features | 33 |
| Workflow node types | 45 |
| Fleet tools | 48 |
| REST endpoints | ~180+ |
| Agent manifests | 17 |
