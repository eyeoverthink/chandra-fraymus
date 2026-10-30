# Phase 32 — OCR Pipeline (Windows Media OCR)

| Field | Value |
|-------|-------|
| **Phase** | 32 |
| **Title** | OCR Text Extraction Pipeline |
| **Status** | Complete |
| **Prev** | [Phase 31 — Audio Transcription (STT) Pipeline](PHASE-31.md) |
| **Next** | [Phase 33 — Media Hub Panel](PHASE-33.md) |

## Summary

Completes the media pipeline suite (Phases 28-32) by adding optical character recognition. The system can now process images (Phase 28), video (Phase 29), speech synthesis (Phase 30), speech recognition (Phase 31), and text extraction from images (this phase). Uses the existing production-quality `windows-ocr.ps1` helper which drives Windows.Media.Ocr via WinRT, supporting PNG and JPEG input up to 4 MiB / 10,000px per edge.

## Architecture

```
ocrRecognize(input, opts)
  ├─ toBuffer(input)           → normalize Buffer/base64/dataURI to Buffer
  ├─ detectMimeType(buf)       → identify PNG/JPEG by magic bytes
  ├─ runOcrHelper(request)     → spawn windows-ocr.ps1, pipe JSON via stdin
  │    ├─ WinRT BitmapDecoder  → decode image
  │    ├─ OcrEngine.Recognize  → extract text via Windows.Media.Ocr
  │    └─ JSON result          → text, lines, wordCount, dimensions
  └─ save result to data/ocr/  → persistent JSON files
```

### Engine: Windows.Media.Ocr
- Built into Windows 10/11 — zero dependencies, always available
- Supports en-US (additional language packs installable via Windows Settings)
- Max image dimension: 10,000px per edge
- Uses WinRT `IAsyncOperation<T>` with reflection-based `AsTask` awaiting
- Full security validation: base64 roundtrip check, magic byte verification, SHA256 hashing, dimension bounds

## Files Created

| File | Purpose |
|------|---------|
| `server/media/ocr-engine.js` | Core engine: ocrRecognize, ocrStatus, ocrFromFile, listOCRFiles, getOCRResult — reuses existing `server/ocr/windows-ocr.ps1` helper |
| `server/media/ocr-routes.js` | 4 Express endpoints: recognize, status, outputs, result detail |

## Files Modified

| File | Change |
|------|--------|
| `server/workflow/engine.js` | Added `ocr_recognize` import, nodeKind, and handler (reads image buffer from upstream, returns extracted text) |
| `server/workflow/synthesizer.js` | Added `ocr_recognize` to NODE_CATALOG (now 47 entries) |
| `server/fleet/tools.js` | Added 3 OCR fleet tools: ocr_recognize, ocr_status, ocr_list (now 54 tools) |
| `server/runtime.js` | Wired OCR routes + `windows-media-ocr-pipeline` feature flag |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ocr/recognize` | Extract text from image (file upload, imageBase64, or dataUri) |
| GET | `/api/ocr/status` | Engine availability, supported languages, max dimensions |
| GET | `/api/ocr/outputs` | List saved OCR results |
| GET | `/api/ocr/result/:file` | Get specific OCR result JSON |

### POST /api/ocr/recognize

Accepts multipart file upload (`image` field) or JSON body:
```json
{
  "imageBase64": "<base64-encoded PNG or JPEG>",
  "language": "en-US"
}
```

Response:
```json
{
  "text": "Hello OCR World",
  "lines": ["Hello OCR World"],
  "wordCount": 3,
  "engine": "windows-media-ocr",
  "language": "en-US",
  "imageSha256": "64f8ccd4...",
  "dimensions": { "width": 400, "height": 100 },
  "file": "1793375447913-64f8ccd4.json"
}
```

## Workflow Node

| Node Type | Inputs | Output |
|-----------|--------|--------|
| `ocr_recognize` | Image buffer from upstream node (or `imageBase64` in node data), optional `language` | Extracted text + word count + lines |

### Image → OCR Workflow Example
```
[image_resize] → [ocr_recognize]
```
Resize an image, then extract its text content — useful for document digitization pipelines.

## Fleet Tools

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `ocr_recognize` | ocr | low | Extract text from base64-encoded PNG/JPEG |
| `ocr_status` | ocr | safe | Check OCR engine availability and languages |
| `ocr_list` | ocr | safe | List saved OCR results |

## Dependencies

- **Windows.Media.Ocr** — built into Windows 10/11, zero dependencies
- **PowerShell 5.1** — built into Windows, drives the WinRT OCR via `windows-ocr.ps1`
- No Python, no external packages, no paid APIs

## Test Results

| Test | Input | Text | Words | Status |
|------|-------|------|-------|--------|
| Simple PNG | "Hello OCR World" | "Hello OCR World" | 3 | Pass |
| Multi-line base64 | 3-line SVG→PNG | "Chandra FRAYMUS\nPhase 32 OCR Test\nSovereign A1 System" | 9 | Pass |
| JPEG format | "JPEG Format Test" | "JPEG Format Test" | 3 | Pass |
| Status check | — | — | — | Pass |
| Result persistence | — | JSON files in data/ocr/ | — | Pass |

### Accuracy Notes
- Windows Media OCR works well on clear printed text
- Small/stylized text may have substitutions (e.g., "AI" → "A1")
- No confidence score available from Windows.Media.Ocr (unlike SAPI SR)
- Best results with >16px font size and good contrast

## Counts After Phase 32

| Metric | Count |
|--------|-------|
| Features | 35 |
| Workflow node types | 47 |
| Fleet tools | 54 |
| REST endpoints | ~190+ |
| Agent manifests | 17 |
| Media engines | 5 (Sharp images, ffmpeg video, TTS, STT, OCR) |
