# Nexus Engine (AI Studio): every creation method, abstracted for Chandra

Source: Vaughn's AI Studio app **Nexus Engine**, `ai.studio/apps/f53842d2-736e-4b21-a800-f5998d8f6f39`, read on 2026-11-13. I read all 66 source files from the app's code editor: `server.ts`, 23 studio components, the data catalogs, utilities and the engine. I skipped `firebase-applet-config.json`, because it holds Firebase keys, and the lock file and images. Nothing was downloaded or changed in the app.

## The short version

Nexus Engine has **25 creation methods**:
- **12 run on the server** (Express routes). They all call paid Gemini models: image, video, music, voice, transcription, chat, storyboard, map, episode, scene parts, plus two plumbing routes.
- **13 run in the browser** (canvas, three.js, ffmpeg). These are procedural: no model at all.

Every method has the same shape. Remove the provider, and each one is five interchangeable parts:

```
words / picture / clip
  → PLAN      a model writes a structured spec (JSON schema)        ← provider-specific
  → RENDER    something turns the spec into pixels / samples / mesh ← provider-specific OR procedural
  → CHECK     something measures the result                         ← Nexus Engine has almost none
  → EXPORT    file, page, package, or the next step's input
  → CHAIN     the output (summary + image) feeds the next method
```

Nexus Engine is strongest at **PLAN** and **CHAIN**:
- Every planner returns a JSON schema.
- The Skills Foundry passes a rolling summary and a rolling image from step to step.

Chandra is strongest at **RENDER-offline** and **CHECK**:
- Films are drawn by our own renderer or painted on fraymus-home.
- Every film passes an 11-point checker.
- Pages must run in a real browser.
- Motion clips under a motion score are refused.

The useful merge is to keep Chandra's renderers and checkers and add the methods Nexus Engine has that Chandra lacks. Those are listed under [What Chandra does not have yet](#what-chandra-does-not-have-yet).

Chandra uses no paid APIs, so none of the Gemini calls are copied. What carries over is each method's **contract**: inputs, the plan schema, and the output. A local renderer or the model pool fills each contract.

---

## A. Server methods (the Gemini routes)

| # | Route | Model in the source | Input → output | Method, without the provider | Chandra today |
|---|---|---|---|---|---|
| 1 | `POST /api/image/generate` | `gemini-nano-banana-2.1` | prompt, aspect, size, **reference image**, optional search grounding → PNG | Text or **text + image → image** (edit, restyle, keep the subject) | `looks.generate` (SDXL / Animagine on fraymus-home) is text-to-image only. **No reference-image editing.** |
| 2 | `POST /api/video/generate` | `gemini-omni-1.2-flash` (Interactions API) | motion prompt, 16:9 / 9:16, 5–8 s, 360–1080p, start image, **`previousInteractionId`** → MP4 | Image to video, with **continuation**: the next clip starts where the last one ended | `looks.motion` (Wan 2.2 5B, 1–5 s, one clip). **No continuation, no text-only video.** |
| 3 | `POST /api/music/generate` | `lyria-3-clip-preview` / `lyria-3-pro-preview` | prompt, clip/pro, **image as mood reference** → audio + lyrics | Text (+ image) → score | Flat films synthesise 10 sound effects. **No music generation.** (`music-engine.js` exists but is not a score model.) |
| 4 | `POST /api/voice/generate` | `gemini-3.8-flash-lite-tts` / `-flash-tts` | single voice + **style sentence**, or **two speakers, each with a style** → WAV | Script → speech, with a performance direction per speaker | VoiceStudio `vaughn-one` / `overlord`, two speakers in films. **No style direction per line.** |
| 5 | `POST /api/audio/transcribe` | `gemini-3.5-transcribe` | audio + instruction → text | Speech → text | `stt-engine.js` (faster-whisper → SAPI). Equivalent. |
| 6 | `POST /api/chat` | 4 models (`gemini-4-carbon/argon/hydrogen`, `3.1-flash-lite`), thinking level per model, optional Google Search | role prompt + history + attachment → text + sources | Role-played director agent with optional grounding | Fleet agents + Hermes tools + model pool. Equivalent or better. |
| 7 | `POST /api/storyboard` | `gemini-4-hydrogen`, JSON schema | topic, technique, 2–6 scenes, reference → `{title, logline, technique, scenes[{sceneNumber, title, narration, visualPrompt, cameraMove, durationSec, sfxCue}]}` | Topic → **shot list with camera and sound per shot** | Flat plan `{say, where, show, who, feel}`. The art director picks camera and sound mechanically. Equivalent, different split. |
| 8 | `POST /api/maps/synthesize` | `gemini-4-hydrogen` + Google Search | place name, style, pasted GeoJSON, map image → `{name, rawGeoSummary, waterLevel, elevationScale, fogDensity, biomePalette{ground,rock,water,accent,sky}, landmarks[{name, kind, x, z, elevation, color}]}` | **Place → world-parameter JSON → procedural 3-D terrain** | **None.** |
| 9 | `POST /api/cartoon/episode` | `gemini-4-hydrogen` (+ search for topical ideas) | premise or none, 5 style universes, 3–8 sections, reference → multi-act episode (dialogue, background prompt and character prompt per section) | Premise → **multi-act episode**, every section carrying its own picture prompts | `make` cartoon / comic (two people, one act). **No multi-act episodes, no "invent a topical premise" mode.** |
| 10 | `POST /api/scene/abstract-parts` | `nano-banana` ×4, `hydrogen` ×2 | scene image or video frame + action: `background_plate` (characters removed and the gap filled in) / `character_sheet` (characters on magenta) / `analyze` → images or JSON parts | **Scene → separate layers** (clean backdrop, sprite sheet, part list) | **None.** No inpainting or segmentation is wired. |
| 11 | `POST /api/export/transcode` | ffmpeg | recorded WebM → mp4 / mov / webm / gif / mkv / avi | Browser recording → delivery format | `video-engine.js` convert. Equivalent. |
| 12 | `/api/vault*`, `/api/db/*` | — | assets, maps, characters, exports → disk / Postgres / Firestore | Asset store | The shelf + `media_meta` provenance. Equivalent, and ours records the prompt that made each file. |

**Shared guard, `translateThirdPartyStyleTerms()`** (every prompt passes through it): it rewrites franchise and studio names into descriptions of what they look like. For example:
- Simpsons → "classic 1990s yellow-skinned primetime 2D cel sitcom animation"
- Pixar → "theatrical 3D CGI … warm subsurface lighting"
- LEGO → "glossy interlocking ABS plastic toy brick … minifigure"
- Spider-Verse → "hybrid 2D/3D … Ben-Day halftone dots and chromatic fringes"
- DBZ / Goku → "1990s shonen martial-arts cel anime with golden energy aura"

This is the same rule as Chandra's `recipes.js` (`recipeFor` aliases only route, `cleanSubject`). Theirs covers four universes ours lacks: **primetime yellow sitcom, theatrical 3-D CGI, midcentury super-family, toy-brick feature.**

---

## B. Browser methods (procedural, no model)

| # | Component | Method | Algorithm (as written) | Chandra today |
|---|---|---|---|---|
| 13 | `KurzgesagtStudio` | **Shape-morph explainer animator** | 8 shapes (planet, star, hex, diamond, rocket, bird, pillar, gear), each resampled to the same number of points with `resampleClosedPolygon` (even arc length). Keyframes interpolate position, scale, rotation, colour **and the outline point by point**, with easing. 5 scientific palettes. `enforceHighContrast` lightens or darkens until WCAG ≥ 4.5:1. Palette taken from an uploaded image. SVG + WebM export | The flat kit draws 50 props, but **a prop cannot morph into another**. No contrast enforcement. |
| 14 | `RotoscopeStudio` | **Picture/clip → vector ink** | 160×90 luma; gradient magnitude > 0.16 marks edges; 8-direction chain-following turns edge pixels into paths; `simplifyPath` (minimum spacing 4.5 px). 4 styles (cutout, comic ink, charcoal watercolour, neon wireframe). Hand tracing on top. SVG per frame + WebM | `rotoscope` look is **raster** (flat palette + ink mask). **No vector output.** |
| 15 | `StickFigureAnimator` | **Pose-keyframe choreography** | Bones between named joints; preset poses `idle, present, run, kick, charge`; `lerpPose` between keyframes; joints dragged by hand | Chandra stick figures take 10 *acts* from the plan. **No user-posed keyframes.** |
| 16 | `CharacterRigStudio` | **Cutout → game-ready character** | `runCornerFloodFill`: flood-fills from 4 corners + top centre with colour tolerance and feathering, makes the background transparent. AI "isolate subject" fallback. Saved as a playable/NPC unit. CSS sprite export | Avatars find the figure's box (`pictureSampler`), but **there is no background removal for sprites.** |
| 17 | `SceneGameAbstractor` | **Picture → platformer level** | `quantizeImageToTileGrid`: shrink to 20×11; the bottom row is ground; dark cells in rows 3–8 become brick platforms (checkerboard); red-dominant cells become hazards. Magenta-corner chroma key for parts. Drag to slice parts. Push to the game suite | **None.** |
| 18 | `GameDevSuite` | **Playable game from assets** | Tile platformer (solid tiles, keyboard physics), sprite painting, retro tones (WebAudio), three.js 3-D map mode, **standalone HTML game export**, 2-D movie export | Page builder makes single-file pages that must run in a real browser. **No platformer component in the page kit.** |
| 19 | `Avatar3DStudio` | **Photo → toy-brick minifig + retro avatars** | three.js figure built from parts (`buildLeg`, `buildArm`); **face and torso textures painted from the photo** (`buildMinifigFaceTexture`, `buildMinifigTorsoTexture`); `LEGO_PALETTE` nearest colour; GameBoy 2-bit, ASCII ramp, Bayer 4×4 dither; turntable recording; send to game as hero | `looks.avatar` (Hunyuan3D mesh, 663k triangles) + brick / 8-bit / 2-bit / ASCII looks. Ours is a real mesh; theirs is a **cheap, instant, rigged template with a face texture**. Both are worth keeping. |
| 20 | `OpenWorldMapStudio` | **Map/photo → walkable 3-D world** | `extractHeightGridFromImage` (luminance → heights), `deterministicHeight` (seeded fallback), styled terrain texture, a mesh per landmark kind, WASD flight, `generate2DTilesFromWorld`, 14 style/layer presets (cyberpunk … topographic blueprint, plus backdrop / underlay / overlay / Z-level roles), movie export | **None.** The page kit has a globe, not terrain. |
| 21 | `CartoonDirector` / `…Studio` | **Episode → rendered sections → film** | Episode from #9; each section rendered as a keyframe (#1) or a procedural character (`buildProceduralCharacterDataUrl`); flat-vector dojo renderer (`dojoVectorRenderer`: `drawStickFighter`, `drawVectorColossus`); batch keyframes; send a section to motion (#2); sync to the game suite; episode movie export. Demo: *David and Goliath* short | `make` (pixel / cartoon / comic / explainer / flat / stick). Ours is checked end to end; theirs **routes one episode to film, game and motion**. |
| 22 | `MotionVideoPanel` | **Photo → technique → motion** | 18 cinema techniques; `handleConvertPhotoToTechnique` (#1 with a reference); `buildComposedMotionPrompt` = technique + camera rig + user motion; storyboard (#7); vector WebM export | `looks.convert` + `looks.motion` + `animateStill`. Equivalent pieces; **they compose technique × rig × motion as one prompt.** |
| 23 | `sceneExporters` | **One scene, five deliverables** | Canvas → `MediaRecorder` → #11; **WASM package** (a hand-written binary module exporting `step_pos` / `tick_score`); CSS/JS animation package; self-contained "movie window" HTML; scene-graph JSON | Film MP4 + shelf. **No interactive or package exports.** |
| 24 | `SkillsFoundryPanel` + `foundryCatalog` | **Skills and workflow chains** | 18 `SKILL_BLUEPRINTS` (a prompt template bound to one endpoint); `DEFAULT_WORKFLOW_CHAINS` (Story → Keyframe → Game level; Topic → Storyboard → Art + Score + Voice; Location → World + Backdrop + Score). `handleRunFullWorkflow` runs steps in order, passing **`rollingSummary` and `rollingImage`** forward (`{{previous_summary}}` in prompts). "Clone as abstracted tool"; saved locally + Firestore; skills downloadable as Markdown | Workflow engine (53 node types), synthesizer, Skill Forge (verified code → tools), workflow trials. **No user-authored prompt-template skills, and no rolling summary + image between steps.** |
| 25 | `CreditTrackerPanel` + `creditTracker` | **Cost ledger** | Estimated cost per endpoint, allowance, session spend, CSV export | No paid APIs, so no money. The analogue that matters here is **card-seconds per job** (GPU leases, worker receipts), which nothing totals today. |

**Catalogs worth carrying over:**
- `STYLE_PRESETS` (30). Beyond Chandra's 18 recipes, these are new:
  - Pop silkscreen, urban stencil graffiti, mid-century newspaper strip
  - 16-bit platformer sprite sheet, 3-D/4-D hypercube artifact
  - YouTube nighttime story, LinkedIn editorial diagram, Reddit 4-panel story
  - The four universes in section A
- `CINEMA_TECHNIQUES` (18): the same set as Chandra's looks.
- `HIGGSFIELD_CAMERA_RIGS` (7):
  - Ours already: locked, crash dolly, handheld, parallax pan (2-D).
  - New: **360° bullet-time orbit, FPV cinema dive, crane-up reveal.**
- `AGENT_ROLES` (4): creative director, animation director, game architect, tool reverse-engineer.

The engine folder (`physicsEngine`, `shaderPlugins` with live GLSL, `sdkGenerator` writing Unreal USD and other targets, `streamingWorkerPool`, `NodeGraphEditor`) is the app's original purpose, a "data-physics" simulator. It is a scene-export target, not a creation method. One part could be reused: `sdkGenerator` turns one scene description into several engine formats.

---

## What Chandra does not have yet

Ranked by value for the least new machinery. Each line names the offline equivalent and what would check it.

1. **Built 2026-11-14 as Make chains** (`server/media/make-chains.js`, tools `make_chain.*`, routes `/api/make-chains`; see CLAUDE.md "Make chains"). **Workflow chains with a rolling summary + image** (#24). Every step gets the previous step's text summary and newest image. This is a small change to the workflow engine and makes Story → Keyframe → Game and Topic → Storyboard → Art + Score + Voice runnable by agents. *Check:* each step's output must name or show what the previous step produced.
2. **Built 2026-11-14** (`server/media/looks/layers.js`, `looks.layers`, worker kinds `matte` (U²-Net) and `inpaint`; see CLAUDE.md "Scene → layers"). **Scene → layers** (#10, #16, #17). This is the base for game parts, sprites and parallax:
   - Background removal: corner flood fill first (their algorithm, pure, no model), with a segmentation model only if needed.
   - Clean backdrop: SDXL inpainting on fraymus-home, masked by the cutout.
   - *Check:* the cutout's alpha covers the subject, and the backdrop shows no part of the subject.
3. **Built 2026-11-14** (`server/media/looks/vector.js`, `looks.vector`; see CLAUDE.md "Vector rotoscope"). **Vector rotoscope** (#14). Edge trace → paths → SVG per frame, in pure code. Chandra's raster rotoscope stays as a look; this adds an editable vector output.
4. **Built 2026-11-14** (`server/media/flat/morph.js` + `silhouette.js`; see CLAUDE.md "Shape morphs" under the flat look). **Shape-morph explainers** (#13). Resample every flat prop to N points and morph between keyframes. This adds Kurzgesagt's signature transitions (a cell becomes a planet) to the flat look. Add the WCAG contrast rule to the flat renderer's colour choices.
5. **Map → walkable world** (#8, #20). The pool model + Wikipedia grounding write the world JSON (the same schema). A page-kit component `ChandraTerrain` (height grid, palette, landmark meshes, fly controls) renders it. *Check:* the page must run and move in the page builder's browser test.
6. **Platformer page kit** (#17, #18). A `ChandraPlatformer` component that takes a tile grid + sprites, so "make a game from this picture" becomes method 2 → 17 → page builder.
7. **Multi-act episodes and video continuation** (#9, #2). Episodes: a section loop over Make. Continuation: Wan 2.2 from the last frame of the previous clip, under the same GPU lock.
8. **Missing catalog entries**: the 8 new style recipes, the 4 universes as descriptions, the 3 camera rigs. Bullet-time and FPV need depth; with a single still they can only be approximated.
9. **Music** (#3). There is no free score model on this machine. Vaughn's ACE-Step checkout (`heartmula-rig/ACE-Step-1.5`) is a candidate. Installing or running it is a download and Vaughn's call.
10. **Card-seconds ledger** (#25): total GPU-lease and worker time per job and per agent. This is the real cost here.

## What not to carry over

- **The paid routes themselves** (Gemini image, video, music, TTS). Vaughn's rule is no paid APIs. The contracts above are what carry over.
- **"Never include copyrighted names" as a prompt request alone.** Their guard is a regex plus an instruction to the model. Chandra's `cleanSubject` already removes names before the model sees them, which is stronger. Keep that and add their four universes.
- **The hand-written WASM "engine kernel"** (`i32.add` twice). It is a demonstration, not a runtime.

`✶` Method count by the source:
- 12 server routes: 10 creation + 2 plumbing.
- 13 procedural browser studios.
- 18 skill blueprints and 3 default chains.
- 30 style presets, 18 techniques and 7 camera rigs.
