# Phase 29: Local Video Pipeline (ffmpeg)

**Date:** 2026-10-30
**Prev:** [Phase 28 — Local Image Processing Engine](PHASE-28.md)
**Next:** TBD

---

## Overview

Phase 29 adds a complete local video processing pipeline powered by ffmpeg — real video manipulation with zero npm dependencies (ffmpeg is a system binary). This complements Phase 28's Sharp image engine, giving Chandra-FRAYMUS a full media processing stack: images via Sharp, video via ffmpeg, both 100% free and offline.

### Key Design: ffmpeg as Child Process

Rather than binding to ffmpeg via a Node.js wrapper library, the engine spawns `ffmpeg` and `ffprobe` as child processes. This means:
- **Zero npm dependencies** for video — uses whatever ffmpeg is in PATH
- **Full codec access** — every codec ffmpeg supports (h264, VP9, AV1, etc.)
- **Battle-tested** — ffmpeg is the same tool Netflix/YouTube use for transcoding
- **Upgradeable** — updating ffmpeg updates video capabilities with no code changes

## Architecture

```
                    ┌───────────────────────────┐
                    │   Video Engine (ffmpeg)    │
                    │   server/media/            │
                    │   video-engine.js          │
                    └────────────┬──────────────┘
                                 │
        ┌────────────┬───────────┼───────────┬────────────┐
        │            │           │           │            │
   ┌────┴────┐  ┌────┴────┐ ┌───┴───┐  ┌───┴───┐  ┌────┴────┐
   │ REST    │  │ Fleet   │ │Workflow│  │ffprobe│  │ Serve   │
   │ Routes  │  │ Tools   │ │ Nodes │  │ Info  │  │ /video/ │
   │ 13 APIs │  │ 8 tools │ │ 5 new │  │ probe │  │ static  │
   └─────────┘  └─────────┘ └───────┘  └───────┘  └─────────┘
```

---

## What Was Built

### 1. ffmpeg Video Engine (`video-engine.js`)

10 core operations, all producing saved files in `data/video/`:

| Function | Description |
|----------|-------------|
| `videoInfo(input)` | Get metadata via ffprobe: duration, resolution, codec, fps, bitrate |
| `videoThumbnail(input, opts)` | Extract single frame at timestamp as PNG |
| `videoTrim(input, opts)` | Trim video to start/end/duration (fast copy-mode) |
| `videoResize(input, opts)` | Scale video with libx264 re-encode |
| `videoConvert(input, opts)` | Format conversion: MP4 (h264), WebM (VP9), MKV |
| `videoExtractAudio(input, opts)` | Extract audio track to MP3/WAV/AAC |
| `videoToGif(input, opts)` | Convert clip to optimized GIF with palette generation |
| `videoConcat(inputs, opts)` | Concatenate multiple videos via concat demuxer |
| `videoOverlayText(input, text, opts)` | Burn text overlay with drawtext filter |
| `videoFrames(input, opts)` | Extract N evenly-spaced frames as PNG images |

Plus utility functions:
- `listVideos(limit)` — List processed video files
- `ffmpegStatus()` — Check ffmpeg availability and version
- `videoUrl(name)` — Get URL for serving

### 2. REST API (13 endpoints in `video-routes.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/video/info` | Get video metadata via ffprobe |
| POST | `/api/video/thumbnail` | Extract frame at timestamp |
| POST | `/api/video/trim` | Trim to time range |
| POST | `/api/video/resize` | Resize/scale video |
| POST | `/api/video/convert` | Convert format |
| POST | `/api/video/extract-audio` | Extract audio track |
| POST | `/api/video/gif` | Convert to animated GIF |
| POST | `/api/video/concat` | Concatenate multiple videos |
| POST | `/api/video/overlay-text` | Burn text overlay |
| POST | `/api/video/frames` | Extract N frames as images |
| GET | `/api/video/outputs` | List processed videos |
| GET | `/api/video/status` | ffmpeg version/availability |
| GET | `/video/:file` | Serve processed video files |

All upload routes accept: multipart file upload (up to 100MB), base64 body, data URI, or `/video/` path reference.

### 3. Workflow Nodes (5 new, 47 total in engine / 44 in synthesizer catalog)

| Node Type | Description |
|-----------|-------------|
| `video_trim` | Trim video to time range |
| `video_resize` | Resize/scale video dimensions |
| `video_convert` | Convert format (mp4/webm/mkv) |
| `video_thumbnail` | Extract frame as image |
| `video_gif` | Convert video segment to animated GIF |

### 4. Fleet Tools (8 new, 44 total)

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `video_info` | video | safe | Get video metadata via ffprobe |
| `video_trim` | video | safe | Trim video to time range |
| `video_resize` | video | safe | Resize/scale video |
| `video_convert` | video | safe | Convert video format |
| `video_thumbnail` | video | safe | Extract frame as image |
| `video_to_gif` | video | safe | Convert to animated GIF |
| `ffmpeg_status` | video | safe | Check ffmpeg availability |
| `video_list` | video | safe | List processed videos |

---

## Files Changed

### New (2)
- `server/media/video-engine.js` — ffmpeg video processing engine (~280 lines)
- `server/media/video-routes.js` — 13 REST API endpoints with multer uploads (~160 lines)

### Modified (4)
- `server/workflow/engine.js` — Added ffmpeg import, 5 video node kinds, 5 video node handlers
- `server/workflow/synthesizer.js` — Added 5 video nodes to NODE_CATALOG (44 total)
- `server/fleet/tools.js` — Added 8 video fleet tools (44 total)
- `server/runtime.js` — Import + install video routes, added `ffmpeg-video-pipeline` to features

---

## Running Counts

| Category | Count |
|----------|-------|
| Features | 43 |
| Fleet Tools | 44 |
| Agents (default) | 17 |
| Workflow Node Types (engine) | 47 |
| Workflow Node Types (synthesizer) | 44 |
| DB Tables | ~61 |
| API Routes | 118+ |
| Phases | 29 |

---

## Integration Points

- **Workflow Engine** — 5 new video nodes process video through DAG pipelines
- **Fleet Tools** — Agents can process video via 8 video tools
- **Image Engine** — Video thumbnails/frames produce images that flow into Sharp image pipeline
- **Commerce Pipelines** — Product videos can be processed (trim, resize, gif) via workflow nodes
- **Bus** — Workflow nodes publish pipeline results as usual
- **Static Serving** — Processed videos served at `/video/:file` with cache headers

---

## Known Limitations

1. ffmpeg must be installed system-wide (not bundled) — `winget install Gyan.FFmpeg` or equivalent
2. Video operations use temp files — large videos (>100MB) may be slow due to disk I/O
3. No GPU acceleration configured — uses CPU encoding (libx264/libvpx). For GPU: add `-c:v h264_nvenc` manually
4. Concat requires all inputs in same format/codec — mismatched inputs may fail
5. drawtext filter requires system fonts — custom font paths not yet supported
6. Max upload 100MB via multer — larger videos should be placed directly in data/video/
