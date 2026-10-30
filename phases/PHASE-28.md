# Phase 28: Local Image Processing Engine

**Date:** 2026-10-30
**Prev:** [Phase 27 — NUDP/1 Sovereign Mesh Protocol](PHASE-27.md)
**Next:** TBD

---

## Overview

Phase 28 adds a complete local image processing engine powered by Sharp — real image manipulation that works immediately with zero external services. It also adds a proper ComfyUI bridge for FLUX.1 image generation when available, enhances existing workflow nodes with Sharp fallbacks, and introduces 6 new image processing workflow node types + 7 fleet tools.

### Key Design: Always-Available Fallback Chain

Every image operation now has a local fallback:
- **Image generation**: ComfyUI/FLUX.1 → Ollama visual description
- **Background removal**: rembg server → Ollama description
- **Upscaling**: Real-ESRGAN → Sharp Lanczos3 (new)
- **Resize/Crop/Convert/Effects/Watermark/Thumbnail**: Sharp (always available)

## Architecture

```
                    ┌──────────────────────────┐
                    │    Image Engine (Sharp)   │
                    │    server/media/          │
                    │    image-engine.js        │
                    └────────────┬─────────────┘
                                 │
        ┌────────────┬───────────┼───────────┬────────────┐
        │            │           │           │            │
   ┌────┴────┐  ┌────┴────┐ ┌───┴───┐  ┌───┴───┐  ┌────┴────┐
   │ REST    │  │ Fleet   │ │Workflow│  │ComfyUI│  │ Serve   │
   │ Routes  │  │ Tools   │ │ Nodes │  │Bridge │  │ /media/ │
   │ 15 APIs │  │ 7 tools │ │ 6 new │  │FLUX.1 │  │ static  │
   └─────────┘  └─────────┘ └───────┘  └───────┘  └─────────┘
```

---

## What Was Built

### 1. Sharp Image Engine (`image-engine.js`)

10 core operations, all producing saved files in `data/media/`:

| Function | Description |
|----------|-------------|
| `imageInfo(input)` | Get metadata: width, height, format, channels, size |
| `imageResize(input, opts)` | Resize with fit modes: cover/contain/fill/inside/outside |
| `imageCrop(input, rect)` | Extract rectangular region |
| `imageConvert(input, opts)` | Format conversion: PNG, JPEG, WebP, AVIF, TIFF |
| `imageEffects(input, opts)` | Effects chain: blur, sharpen, grayscale, rotate, flip, flop, negate, tint, gamma, normalize |
| `imageComposite(base, overlays)` | Composite multiple images with blend modes |
| `imageWatermark(input, text, opts)` | SVG text overlay with positioning |
| `imageThumbnail(input, size)` | Square cover-fit thumbnail |
| `imageUpscale(input, scale)` | Lanczos3 interpolation upscale (1-4x) |
| `imageCreate(opts)` | Create blank canvas with color fill |

Plus utility functions:
- `listMedia(limit)` — List processed images
- `comfyuiStatus()` — Health check for ComfyUI
- `comfyuiGenerate(prompt, opts)` — Queue FLUX.1 generation job
- `comfyuiResult(promptId)` — Poll job status
- `comfyuiFetchImage(filename)` — Download and save generated image

### 2. REST API (15 endpoints in `image-routes.js`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/media/info` | Get image metadata |
| POST | `/api/media/resize` | Resize image |
| POST | `/api/media/crop` | Crop region |
| POST | `/api/media/convert` | Format conversion |
| POST | `/api/media/effects` | Apply effects chain |
| POST | `/api/media/composite` | Composite images |
| POST | `/api/media/watermark` | Add text watermark |
| POST | `/api/media/thumbnail` | Generate thumbnail |
| POST | `/api/media/upscale` | Upscale image |
| POST | `/api/media/create` | Create blank canvas |
| GET | `/api/media/outputs` | List processed images |
| GET | `/media/:file` | Serve processed image files |
| GET | `/api/media/comfyui/status` | ComfyUI health check |
| POST | `/api/media/comfyui/generate` | Queue FLUX.1 generation |
| GET | `/api/media/comfyui/result/:promptId` | Poll generation result |
| POST | `/api/media/comfyui/fetch` | Download generated image |

All upload routes accept: multipart file upload, base64 body, data URI, or `/media/` path reference.

### 3. Workflow Nodes (6 new, 42 total in engine / 39 in synthesizer catalog)

| Node Type | Description |
|-----------|-------------|
| `image_resize` | Resize with configurable width/height/fit |
| `image_crop` | Crop with left/top/width/height |
| `image_convert` | Format conversion with quality |
| `image_effects` | Effects chain from node data |
| `image_watermark` | Text watermark overlay |
| `image_thumbnail` | Thumbnail generation |

### 4. Enhanced Existing Nodes

- **`image_gen`**: Now tries ComfyUI/FLUX.1 first with polling (90s timeout), falls back to Ollama visual description
- **`upscale`**: Now falls back to Sharp Lanczos3 when Real-ESRGAN is unavailable

### 5. Fleet Tools (7 new, 36 total)

| Tool | Group | Risk | Description |
|------|-------|------|-------------|
| `image_info` | media | safe | Get image metadata |
| `image_resize` | media | safe | Resize image |
| `image_convert` | media | safe | Format conversion |
| `image_effects` | media | safe | Apply effects chain |
| `image_upscale` | media | safe | Sharp Lanczos3 upscale |
| `comfyui_status` | media | safe | ComfyUI health check |
| `media_list` | media | safe | List processed images |

---

## Files Changed

### New (2)
- `server/media/image-engine.js` — Sharp image processing engine + ComfyUI bridge (~250 lines)
- `server/media/image-routes.js` — 15+ REST API endpoints with multer uploads (~170 lines)

### Modified (4)
- `server/workflow/engine.js` — Added Sharp import, 6 new node handlers, enhanced image_gen (ComfyUI) and upscale (Sharp fallback)
- `server/workflow/synthesizer.js` — Added 6 image processing nodes to NODE_CATALOG (39 total)
- `server/fleet/tools.js` — Added 7 image/media fleet tools (36 total)
- `server/runtime.js` — Import + install image routes, added `sharp-image-engine` and `comfyui-bridge` to features

### Dependencies Added
- `sharp` — High-performance image processing (libvips-based, pre-built binaries)
- `multer` — Multipart file upload middleware

---

## Running Counts

| Category | Count |
|----------|-------|
| Features | 42 |
| Fleet Tools | 36 |
| Agents (default) | 17 |
| Workflow Node Types (engine) | 42 |
| Workflow Node Types (synthesizer) | 39 |
| DB Tables | ~61 |
| API Routes | 105+ |
| Phases | 28 |

---

## Integration Points

- **Workflow Engine** — All 6 new nodes + enhanced image_gen and upscale use Sharp
- **Fleet Tools** — Agents can process images via 7 media tools
- **ComfyUI** — When running locally (port 8188), FLUX.1 generation is automatic
- **Commerce Pipelines** — Product images can be processed (resize, watermark, thumbnail) via workflow nodes
- **Bus** — Workflow nodes publish pipeline results as usual
- **Static Serving** — Processed images served at `/media/:file` with cache headers

---

## Known Limitations

1. ComfyUI/FLUX.1 requires separate installation (not bundled) — system works fully without it via Sharp
2. Sharp Lanczos upscaling is interpolation, not AI super-resolution — for AI upscale, install Real-ESRGAN
3. Background removal still requires rembg server — no Sharp-only alternative for true background removal
4. Max image size capped at 8192px per dimension to prevent memory issues
5. Multer in-memory storage — large uploads (>25MB) are rejected
6. No GPU acceleration for Sharp — uses CPU libvips (fast enough for most operations)
