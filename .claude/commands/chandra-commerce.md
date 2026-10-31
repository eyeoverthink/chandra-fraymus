---
description: "Commerce pipeline development for Chandra-FRAYMUS. Load when working on any of the 5 pipelines (4 commerce + Edit Rebuild), Shopify/Printify integration, or adding new commerce features."
---

# Chandra Commerce Pipeline Skill

## Architecture

All commerce code lives in `server/commerce/`. Media pipelines in `server/media/`. Every pipeline stage exists simultaneously as:
1. A **REST API endpoint** (in `routes.js`)
2. A **fleet agent tool** (in `tools.js`, with safety classification)
3. A **visual workflow node** (in `client/src/panels/WorkflowCanvas.jsx`)

**Shared utilities** (`server/commerce/shared.js`):
- `chatOllama(prompt, options)` — call Ollama for LLM inference
- `parseJSON(str)` — safe JSON parse with fallback
- `shopifyHeaders()` — returns auth headers for Shopify Admin API
- `shopifyBase()` — returns `https://{store}.myshopify.com/admin/api/2024-10`
- Always import from shared.js, never duplicate these

## The 4 Pipelines

### 1. Content-to-Commerce (`pipeline.js`)
```
Researcher → Copywriter → QA Reviewer → CEO Logger → Shopify Publish
```
- POST /api/commerce/pipeline `{ topic, contentType }`
- Sequential 5-agent chain
- QA scores 0-10, rejects below threshold

### 2. Apparel Production (`apparel-pipeline.js`)
```
Trend Scout → Apparel Designer → Printify Push → Shopify Sync → Pricing Engine
```
- POST /api/apparel/pipeline `{ niche, productTypes }`
- 24 product types (tops, outerwear, bottoms, footwear, headwear, accessories, lifestyle)
- Printify POD integration, then Shopify storefront sync
- Pricing engine targets 50-65% margins

### 3. Mystery Shopper (`mystery-shopper.js`)
```
Mystery Shopper → (UX Auditor || Price Analyst) → Shopper Report
```
- POST /api/shopper/audit `{ storeDomain }`
- **Fan-out:** UX Auditor and Price Analyst run in parallel (Promise.all)
- **Fan-in:** Results merge into graded report (A through F)
- Generates automated fix recommendations

### 4. Store Fixer (`store-fixer.js`)
```
(Page Generator || Collection Organizer || Description Enhancer) → Price Adjuster → Shopify Applier
```
- POST /api/fixer/pipeline `{ auditReport }`
- **Fan-out:** 3 agents run in parallel
- **Fan-in:** Price Adjuster waits for all, then Shopify Applier pushes everything
- Individual endpoints: /api/fixer/pages, /collections, /descriptions, /prices

## Adding a New Pipeline

1. Create `server/commerce/new-pipeline.js` with the agent chain
2. Add routes in `server/commerce/routes.js`
3. Register fleet tools in `server/commerce/tools.js` with safety: "safe" or "approval_required"
4. Add workflow node types in `WorkflowCanvas.jsx` NODE_TYPES array (with type, label, color, icon)
5. Add a pre-built workflow definition in `server/fraymus/workflows/definitions.js`
6. Use `chatOllama` from shared.js for all LLM calls
7. Use `shopifyHeaders()` and `shopifyBase()` for all Shopify API calls

## Adding a New Workflow Node

In `client/src/panels/WorkflowCanvas.jsx`, add to the NODE_TYPES array:
```js
{ type: 'your_type', label: 'Display Name', color: '#hex', icon: 'emoji' }
```

The engine (`server/workflow/engine.js`) dispatches by node type — add a handler there too.

## Tool Safety Classification

- **safe** — read-only or local-only operations (research, content generation, auditing)
- **approval_required** — writes to external services (Shopify publish, Printify push, price changes)

Fleet tools with "approval_required" need explicit user confirmation before execution in autonomous mode.

## Pipeline 5: Edit Rebuild (`server/media/edit-rebuild.js`)
```
Scene Detect → Shot Plan → Product Place → Animate → Concat
```
- POST /api/media/edit-rebuild `{ video, productDescription, instruction, threshold, width, height, fps, model }`
- 5-stage DAG: ffmpeg scene detect → Ollama shot planning → ComfyUI/FLUX.1 img2img → Wan/CogVideo or Ken Burns → ffmpeg concat
- **Graceful degradation:** Minimum needs only ffmpeg + Ollama (3/5 stages). ComfyUI offline → reference frame passthrough. No I2V model → Ken Burns pan/zoom via ffmpeg zoompan filter.
- Additional endpoints: GET /status, GET /list, POST /detect, POST /plan

## Graceful Degradation

If Shopify/Printify tokens aren't configured:
- Pipelines still run and generate all content
- External writes return `status: 'queued'` with the complete payload
- Adding tokens later lets the queue drain instantly

If ComfyUI/FLUX.1 not installed (Edit Rebuild):
- Scene detection and shot planning still work (ffmpeg + Ollama only)
- Product placement falls back to reference frame passthrough
- Animation falls back to Ken Burns pan/zoom via ffmpeg
