# Phase 33 — Media Hub Panel

| Field | Value |
|-------|-------|
| **Phase** | 33 |
| **Title** | Media Hub Panel |
| **Status** | Complete |
| **Prev** | [Phase 32 — OCR Pipeline](PHASE-32.md) |
| **Next** | [Phase 34 — Error Boundary + System Resilience](PHASE-34.md) |

## Summary

Unifies all 5 media engines (Images, Video, TTS, STT, OCR — Phases 28-32) into a single tabbed UI panel accessible from the Command Center. Also fixes a pre-existing crash where the Health Monitor was calling `broadcast()` with the wrong argument signature, causing `{type, event, metrics}` objects to be rendered as React children.

## Architecture

```
MediaPanel.jsx (5-tab interface)
  ├─ ImagesTab     → /api/media/* (Sharp)
  ├─ VideoTab      → /api/video/* (ffmpeg)
  ├─ TTSTab        → /api/tts/* (Piper/edge-tts/SAPI)
  ├─ STTTab        → /api/stt/* (faster-whisper/SAPI)
  └─ OCRTab        → /api/ocr/* (Windows Media OCR)

DetailDrawer.jsx  → panel registry: 'media' → MediaPanel (13 panels total)
CommandCenter.jsx → widget grid: 'Media Hub' with '5 engines' metric (14 widgets total)
runtime.js        → feature flag: 'media-hub-panel' (36 features total)
```

## Files Changed

| File | Change |
|------|--------|
| `client/src/panels/MediaPanel.jsx` | **NEW** — 370-line tabbed panel with all 5 media tabs |
| `client/src/nexus/DetailDrawer.jsx` | Import + register MediaPanel as 'media' panel (13th panel) |
| `client/src/nexus/CommandCenter.jsx` | Add Media Hub widget (14th widget) + '5 engines' metric + defensive type check in formatEvent |
| `server/runtime.js` | Add 'media-hub-panel' feature flag (36th feature) |
| `server/health/monitor.js` | **BUG FIX** — Change `broadcastFn({type, event, metrics})` to `broadcastFn('health', {event, metrics})` |

## Tab Details

### Images Tab
- **Operations**: resize, crop, convert, effects, watermark, thumbnail, upscale, info
- **Input**: File upload + JSON options
- **Output**: Image preview + download link
- **Recent**: Last 20 outputs with image/link display

### Video Tab
- **Operations**: info, thumbnail, trim, resize, convert, extract-audio, gif, frames, overlay-text
- **Input**: File upload + JSON options
- **Output**: Video/image/audio preview
- **Recent**: Last 20 outputs with type-aware display

### TTS Tab
- **Input**: Text area + engine selector (piper/edgeTts/sapi) + voice picker
- **Output**: Audio player with autoPlay
- **Status**: Engine availability dots (green/red)
- **Recent**: Last 20 outputs as audio links

### STT Tab
- **Input**: Audio file upload (wav/mp3/ogg/flac/m4a/webm)
- **Output**: Transcript text + confidence % + engine info
- **Recent**: Last 20 transcription results

### OCR Tab
- **Input**: Image upload (PNG/JPEG)
- **Output**: Extracted text + word/line counts + dimensions
- **Recent**: Last 20 OCR results

## Bug Fix: Health Monitor WebSocket Crash

The Health Monitor (`server/health/monitor.js`) was calling `broadcastFn({ type: 'health', event: 'metrics', metrics })` — passing a single object. The `broadcast(type, payload)` function expects two arguments. This caused the entire object to become `wsEvent.type` on the client, and when `formatEvent()` returned it as a fallback, React crashed with "Objects are not valid as React child (found: object with keys {type, event, metrics})".

**Fix**: Changed to `broadcastFn('health', { event: 'metrics', metrics })` and `broadcastFn('health', { event: 'alert', rule, severity, message })`. Added defensive `typeof` checks in `formatEvent()` fallback.

## Output Format Normalization

The media output APIs return inconsistent formats:
- Images/Video/TTS/STT: `{name, url, size, created}` objects
- OCR: plain filename strings

All 5 tabs normalize both formats:
```jsx
const name = typeof f === 'string' ? f : f.name;
const url = typeof f === 'string' ? `/media/${f}` : f.url;
```

## Counts After Phase 33

| Metric | Count |
|--------|-------|
| Features | 36 |
| Detail Drawer panels | 13 |
| Command Center widgets | 14 |
| REST endpoints | ~190+ |
| Agent manifests | 17 |
| Media engines | 5 |
| Workflow node types | 47 |
| Fleet tools | 54 |
