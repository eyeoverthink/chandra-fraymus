# Sovereign Studio — what I understand, what I suggest, and a second read

Written 2026-11-10 for Vaughn. Part A is my outline. Part B is an independent review of Part A by a
reviewer who was given the document and the repository, not my reasoning. Part C is what changes
because of that review. Nothing in this document has been built yet; it is the plan you asked for
before the build.

---

## Part A — the outline

### A1. What I understand you are asking for

One local system that makes you stop reaching for other apps:

1. **It improves itself** — measures itself, changes itself, keeps what works, and protects its own
   integrity.
2. **It makes finished media** — images and video at 4K and above, cloned voice, full-length YouTube
   videos, release-quality music — using only free, local tools.
3. **It publishes** — Reddit, X, Facebook, Instagram and others, with the right media, text and links
   for each.
4. **It is a viewing hub** — you watch, read and track everything inside it, tuned to your taste.
5. **It sees what you see** — when you say "the girl in the red shirt in the video", it knows which
   pixels, which frames, and can act on them.
6. **A local agent drives it** — the way I can click through an application, a model running on your
   machine does that inside the in-app browser.
7. **Everything it makes can leave** — exported, downloaded, forwarded, referenced, improved.

### A2. This machine, measured today

| | Measured | What it means |
|---|---|---|
| GPU | RTX 3070, **8 GB VRAM** (6 GB already in use by Ollama) | The governing constraint for every media model below |
| RAM | 96 GB | Generous: models can be offloaded to system memory, slowly |
| Disk | F: 8.4 TB free | Room for every model and all output |
| CPU | Ryzen 9 3900X, 12 cores | Fine for ffmpeg, upscaling queues, audio mastering |
| System Python | 3.14 with **CPU-only** PyTorch | Media models must not run here: each engine needs its own environment |
| Voice | F5-TTS clone lane with CUDA PyTorch in `voice-venv`, your recorded samples in `voice-models/my-voice`, service on port 9099 | Voice cloning already exists on this machine |
| Vision | `qwen3-vl:4b` installed in Ollama | A local model that can read a screenshot already exists |
| Image/video | ComfyUI **not installed**; ffmpeg 9 installed | The image and video engines have to be installed before anything else |
| Music | nothing installed | New engine |

One GPU serves everything. The language model, the vision model and a media model cannot all be in
8 GB at once, so the system needs a **GPU scheduler that swaps engines** — the Ollama scheduler built
in Phase V is the pattern, extended to media.

### A3. What Chandra already has that this builds on

- **Self-improvement loop:** external g-score benchmark, strategy bandit, lessons kept only on
  measured gain, tunable experiments with revert, code changes on branches that you merge.
- **Self-audit and integrity:** recurring-defect checks, transient sweeper, file watchdog with
  fossil backups, boot manifest, signed ledger.
- **Agent with tools:** the home screen runs a fleet agent with 354 tools, real approvals, a
  narration guard, and an artifact shelf with provenance and search.
- **Media plumbing:** ffmpeg video engine, Sharp image engine, ComfyUI bridge (waiting for a server),
  TTS cascade, STT, OCR, a five-stage edit-rebuild pipeline, a creation pipeline (brief → script).
- **Distribution scaffolding:** `server/distribution/` with per-platform optimisation and a scheduler.
- **Browser:** Puppeteer control and a Chrome extension bridge with screenshots.

### A4. Who is pushing the limits, and what to take from each

Findings from today's search. Vendor blogs disagree on details; anything marked *unverified* needs a
check on the official model card before it is relied on.

| Area | Frontier | What to adopt here |
|---|---|---|
| Self-improving agents | **Darwin Gödel Machine** (ICLR 2026): an archive of agent variants that rewrite their own code, each change kept only if a benchmark improves; SWE-bench 20 % → 50 %. Its ablation shows the gain stalls without improving the *improver*. DeepMind's AlphaEvolve does the same for algorithms. | Chandra's kernel already does "change, measure, keep or revert". Missing piece: an **archive of variants** instead of one line of descent, and improving the proposers themselves |
| Image | Closed: Google's Nano Banana (cloud only). Open: **Qwen-Image / Qwen-Image-Edit** (Apache 2.0, strong text rendering, ~8 GB with 4-bit quantisation), FLUX (quality pick, non-commercial weights for some versions, tight on 8 GB), SDXL (safe fallback, biggest ecosystem) | Qwen-Image quantised as the main model, SDXL as the fast fallback |
| Video | **Wan 2.2** (5B variant fits 8 GB with offloading; 14B via GGUF), **LTX-2** (audio + video; 8 GB only heavily quantised — sources conflict) | Wan 2.2 5B for image-to-video; LTX-2 evaluated second |
| Voice | F5-TTS (already here; **weights are non-commercial**), Chatterbox (MIT), IndexTTS-2 (emotion and duration control for dubbing), VibeVoice (long multi-speaker; licence status *unverified*) | Keep F5 for private use; add Chatterbox for anything monetised |
| Music | **ACE-Step 1.5**: full songs, claims under 4 GB VRAM and seconds per song, official ComfyUI support, LoRA from a few songs. YuE2 newer, requirements *unverified* | ACE-Step 1.5 |
| Seeing | **SAM 3 / 3.1** (Meta): text-prompted detection, segmentation and tracking in video; its own docs use "a player in white vs a player in red" as the example. Weights are gated behind an access request | SAM 3 for "the girl in the red shirt"; fallback Grounding DINO + SAM 2 |
| Local computer use | **UI-TARS** (2B / 7B), **Holo 1.5 / Holo2** (3B–7B, research licence), Agent S3 and browser-use as frameworks | A 2–4B grounding model for click targets, DOM-first actions where the DOM is available |

### A5. What is and is not possible on this machine

Stated plainly, because the request names specific quality levels.

- **4K–8K images: yes, by upscaling.** No open model generates 8K natively on 8 GB. The route is
  generate at about 1–2 megapixels, then tiled upscale to 4K or 8K. Expect minutes per image, not
  seconds.
- **4K video: yes, by upscaling; native 4K generation: no.** Realistic output is 480p–720p clips of a
  few seconds each, taking minutes per clip, then upscaled and frame-interpolated to 4K. A ten-minute
  YouTube video is an assembly job — script, voice, many short clips, stills with motion, captions,
  music — measured in hours of unattended rendering, not a single generation.
- **"Rivals Nano Banana": partly.** For text-in-image, layout and single edits, quantised
  Qwen-Image-Edit is the closest open model. It will be slower, and it will lose on the hardest
  multi-reference edits. I cannot promise parity and will measure it instead of asserting it.
- **Voice cloning: yes, already working** for your own voice.
- **Music: yes for generation; "Spotify-calibre" needs a mastering stage** (loudness to −14 LUFS, true
  peak limiting, format checks), which ffmpeg can do. Spotify has no upload API for individuals;
  the system can produce a release-ready package, and a distributor does the upload.
- **The single largest improvement available is hardware.** A 24 GB card removes most of the "slow",
  "quantised" and "upscaled" qualifiers above. Everything below is designed to work on the 3070 and
  to get faster, not different, on a bigger card.

### A6. Suggested architecture — seven parts

**1. Engine bay.** ComfyUI installed on F: in its own environment as the single runner for image,
video and music models; the existing voice lane kept as is. A `media-scheduler` owns the GPU: it
asks Ollama to unload, loads one engine, runs a queue, hands the GPU back. Every job is a row with a
state, a timeout and a sweeper — the rules every Chandra subsystem already follows.

**2. Studio pipelines.** Deterministic pipelines that agents start and monitor rather than improvise:
- *Still:* prompt → draft → select → edit → upscale 4K/8K → provenance.
- *Clip:* still or prompt → image-to-video → interpolate → upscale.
- *Long video:* brief → script → voice → shot list → clips and stills → assembly with captions and
  music → loudness pass → export. Built on the existing creation and edit-rebuild pipelines.
- *Song:* brief → lyrics → generation → stems where possible → master → release package.
- *Voice:* text → cloned voice, with a consent record per voice.

**3. Perception: "what you see".** A `scene` service for whatever is in the in-app browser or a
video: screenshot or frame → vision model caption and object list → SAM 3 masks and tracks → a
**scene graph** kept per page or per video (object, description, box, mask, frames). "The girl in
the red shirt" resolves against that graph to a specific track; "make her jacket blue" becomes an
edit job with that mask. The DOM is read alongside pixels, so buttons and links are known by role as
well as by appearance.

**4. Local operator.** An agent loop for the in-app browser: observe (DOM + screenshot) → ground
(DOM selector first, pixel grounding model when the DOM does not help) → act → verify by observing
again. It runs under the approval rules that already exist: anything that sends, posts, buys or
deletes stops for you.

**5. Publishing.** Per platform, the honest route:
- *Reddit:* official API, free for personal non-commercial use.
- *Instagram / Facebook:* Meta Graph API, free, but needs a Business or Creator account and Meta's
  app review.
- *X:* sources disagree on whether a free posting tier still exists; it may be pay-per-use, which
  your no-paid-APIs rule excludes.
- *Everything else, and any platform whose API is closed to you:* **assisted posting** — the operator
  opens the composer in the in-app browser, attaches the media, fills the text, and stops; you press
  Post. That is slower than an API and it is the route that does not put your accounts at risk.
The system keeps a ledger of what went where and reads back results for tracking.

**6. Hub.** One feed inside the app for what you follow — channels, subreddits, blogs, papers — using
the keyless feed tools built today, ranked by what you open and rate. Your own posts and their
numbers sit in the same view.

**7. Self.** Three additions to what exists:
- *Quality gauges for media*, so "better" is a number: prompt adherence scored by the vision model,
  technical checks (resolution, loudness, clipping, duration), and your 👍/👎 — the same pattern as
  the g-score.
- *A variant archive* (the Darwin Gödel idea): several versions of a pipeline or prompt kept side by
  side and selected by those gauges, instead of one line of descent.
- *Self-preservation as integrity:* scheduled verified backups of the database, models list and
  configuration; a restore drill that proves the backup works; the watchdog extended to the new
  engines. It means the system can recover itself. It does not mean resisting you: stop, revert and
  delete stay yours, and code changes still wait for your merge.

**Export everywhere.** Every artifact gets Download, Copy link, Send to… and "Improve this" on the
shelf, plus a bundle export: the file, its provenance record and the recipe that made it.

### A7. Build order

| Phase | What | Done when |
|---|---|---|
| S0 | Engine bay: ComfyUI + environments + model downloads; media scheduler | One image generated locally through the scheduler while Ollama keeps serving |
| S1 | Still pipeline to 4K, with quality gauge | 10 prompts scored; you rate them against the same prompts in a cloud tool |
| S2 | Perception: scene graph on a page and on a video | "the girl in the red shirt" selects the right track on a test clip |
| S3 | Local operator in the in-app browser | A five-step task on a real site completed with approvals |
| S4 | Clip and long-video pipelines | A three-minute narrated video rendered unattended |
| S5 | Music and mastering | A two-minute track at −14 LUFS with a release package |
| S6 | Publishing and tracking | One post to Reddit by API and one assisted post elsewhere, both in the ledger |
| S7 | Hub, variant archive, backups with restore drill | Feed ranked by your ratings; a restore proven on a copy |

### A8. What I need from you before S0

- **Permission to download.** ComfyUI, model weights (tens of gigabytes) and Python packages onto F:.
  I will list each file, source and size before fetching it.
- **Voices.** Only voices you have the right to use. Yours is recorded; anyone else's needs their
  consent on record.
- **Accounts.** API credentials are yours to enter; agents do not create accounts or type passwords.
- **Licences.** Some of the best weights are non-commercial (F5-TTS, some FLUX versions). If the
  channel is monetised, I will default to the permissive alternatives.

### Sources

Image: [DEV benchmark of five generators](https://dev.to/lucylll/i-benchmarked-5-open-source-ai-image-generators-on-my-laptop-heres-what-actually-works-in-2026-35m4), [Qwen-Image local guide](https://localaimaster.com/models/qwen-image-local-guide), [FLUX local guide](https://insiderllm.com/guides/flux-locally-complete-guide/).
Video: [Wan vs LTX guide](https://insiderllm.com/guides/local-ai-video-generation/), [Wan 2.2 on 8 GB](https://dev.to/aitechtutorials/run-wan-22-in-comfyui-with-just-8gb-vram-full-image-to-video-ai-workflow-2gb6), [LTX-2 GGUF guide](https://dev.to/gary_yan_86eb77d35e0070f5/how-to-install-and-configure-ltx-2-gguf-models-in-comfyui-complete-2026-guide-1d3m).
Music: [ACE-Step 1.5 project page](https://ace-step.github.io/ace-step-v1.5.github.io), [ACE-Step 1.5 paper](https://arxiv.org/abs/2602.00744), [ComfyUI support note](https://comfyui-wiki.com/en/news/2026-01-23-ace-step-1-5-music-generation).
Voice: [open-source TTS comparison](https://dev.ocdevel.com/blog/20250714-open-source-tts), [TTS model guide](https://codesota.com/guides/tts-models), [LTX TTS roundup](https://ltx.io/blog/best-open-source-text-to-speech-models).
Seeing: [SAM 3 paper notes](https://en.papernotes.org/ICLR2026/segmentation/sam_3_segment_anything_with_concepts/), [GroPrompt](https://arxiv.org/pdf/2406.12834).
Computer use: [Holo 1.5](https://lp.hcompany.ai/blog/holo-1-5), [GroundCUA](https://github.com/xhluca/GroundCUA), [alternatives comparison](https://www.simular.ai/alternatives/gemini-computer-use-alternatives).
Self-improvement: [Darwin Gödel Machine](https://arxiv.org/abs/2505.22954), [ICLR 2026 poster](https://iclr.cc/virtual/2026/poster/10007327).
Social APIs: [API rules and limits](https://postproxy.dev/blog/social-media-platform-api-rules-rate-limits-media-specs/), [API access and costs](https://blckalpaca.at/en/knowledge-base/social-media/social-media-platforms-compared/social-media-apis-access-limits-costs), [Reddit API tiers](https://www.xpoz.ai/blog/guides/reddit-api-pricing-tiers-and-alternatives/).

---

## Part B — the second read

An independent reviewer was given Part A and the repository, without my reasoning, and asked to read
it from two seats: the person who has to use this every day, and the engineer who has to keep it
running unattended on one consumer GPU. I checked its most consequential claims against the code
afterwards; all of the ones marked confirmed held.

### B1. Where Part A was wrong about what already exists

| Part A said | What the code shows | Checked |
|---|---|---|
| Distribution scaffolding exists | `server/distribution/social.js` has publishers for YouTube, TikTok, Instagram and X that return `status: 'queued'` and make **no network call**. No Reddit or Facebook publisher. By your own rule these are stubs | Confirmed |
| Music: nothing installed | `server/media/music-engine.js` exists and its generator calls **fal.ai and Suno — paid cloud APIs** — when their keys are set. That conflicts with the no-paid-APIs rule | Confirmed |
| The Ollama scheduler is "the pattern, extended" | It is a priority queue over Ollama calls. Nothing in `server/` unloads a model or manages VRAM (`keep_alive` appears nowhere). Swapping engines on the GPU is new work | Confirmed |
| An in-app browser the agent can share with you | `server/browser/service.js` launches a **headless** browser. There is no live surface you can watch, and no login session of yours inside it | Confirmed |
| Backups are a later addition | `server/resilience/backup.js` already makes scheduled backups every 6 hours. Only the restore drill is new | Confirmed |
| Creation pipeline (brief → script) | Holds, modestly: it renders one ComfyUI shot "as proof of concept" and voices through the generic TTS cascade, not your cloned voice | Reviewer's reading; not re-checked by me |

### B2. What the reviewer says the plan gets wrong, most serious first

1. **Nothing you would feel arrives until the fifth phase.** S0–S3 are a scheduler, a scene graph and
   an operator. You asked for videos, songs and posts.
2. **GPU contention is unsolved.** The autonomy daemon reflects, debates and runs goals around the
   clock and Ollama already holds 6 of 8 GB. A media job needs an exclusive lease that pauses the
   daemon, forces Ollama to unload, and is released even if ComfyUI crashes. My S0 exit test — an
   image generated "while Ollama keeps serving" — described the opposite of what is needed.
3. **Perception and the operator rest on the weakest parts.** SAM 3 is gated and may not fit beside a
   vision model in 8 GB; a 4B vision model plus an 8B planner doing multi-step browser tasks will
   fail often. They should be scoped as experiments with a measured success rate.
4. **Long renders have no recovery design.** "Rendered unattended" needs per-shot checkpoints, resume
   after a reboot or a Windows update, a disk-space check before starting, handling for out-of-memory
   and heat, and an estimate of time remaining.
5. **Consent and likeness are underweighted.** "Make her jacket blue" means editing a real,
   identifiable person in someone else's video and then publishing it. Part A had a consent record
   for voices and nothing for faces, third-party footage, copyright, or the AI-content labels that
   YouTube, Meta and TikTok require.
6. **Publishing depends on other people.** Meta's review can take weeks or be refused; X's free tier
   is uncertain; subreddits ban self-promotion patterns. Assisted posting through an automated
   browser can still get an account flagged.
7. **Licences decide the stack on day one, not in a footnote.** Your working cloned voice (F5-TTS) is
   non-commercial. For a monetised channel that matters before the first video, and every artifact
   should carry the licence of the model that made it.
8. **Self-improvement has no stated limits for the new parts.** It must not touch the approval gate,
   publishing credentials, consent records, backups, the GPU lease or disclosure labels. A variant
   archive multiplies GPU hours this machine does not have.
9. **Storage is waved away.** Intermediate frames, upscales and variants need retention rules, and
   database backups belong on a second physical disk, not the same drive.
10. **The quality gauge is circular.** A 4B vision model is a weak judge of whether an image matches
    its prompt. Your ratings should lead until agreement with the model is measured.

### B3. What the reviewer would add

- A "night shift" window: heavy renders only while you sleep, with a morning report.
- A measured time-and-memory benchmark for each engine on this exact card before any duration is
  promised.
- A visible "pause autonomy" switch and an indicator of who holds the GPU.
- Provenance and AI-disclosure metadata embedded in exported files.
- A per-channel "monetised: yes / no" setting that mechanically blocks non-commercial models.
- A low-resolution preview you approve before hours are spent on the full render.
- A fixed set of test prompts re-rendered after any model or node update, to catch silent breakage.
- ComfyUI and its custom nodes pinned to exact versions, with weight hashes recorded.

Its one-sentence verdict: the plan spends its first four phases on infrastructure and fragile
research on a card the daemon already occupies, so you are likely to lose interest before a single
finished video, song or post exists.

---

## Part C — what changes

I accept the review's central point and nine of its ten findings as written. The outline was
ordered the way an engineer builds, not the way you would feel progress.

### C1. Where I agree, and what it changes

- **First milestone is a finished video, not an engine bay.** See C3.
- **GPU lease, not a shared scheduler.** One owner at a time; taking the lease pauses the autonomy
  daemon and unloads Ollama; a watchdog releases it if the engine dies. The interface shows who
  holds it, and you get a pause switch.
- **A resumable job runner comes before any long pipeline.** Every stage writes its output and a
  checkpoint; a job restarts from the last finished shot.
- **A licence, consent and disclosure registry is part of milestone one.** Each model has a licence;
  each channel is marked monetised or not; a monetised channel cannot use a non-commercial model.
  Each voice and each identifiable person has a consent entry. Exports carry an AI-content label.
- **Limits on self-change are written down** (section C4).
- **Your ratings lead.** The vision model's score is shown beside yours and is only trusted once the
  two agree often enough, the same test already applied to the outcome judge.
- **Retention rules and a second-disk backup target** go in with the job runner.
- **The existing stubs and paid calls get dealt with.** The four publishers that only say "queued"
  should either be made real or say plainly that they prepare a package and post nothing. The fal.ai
  and Suno calls in the music engine should be replaced by the local engine. I have not changed
  either yet — they are your code, and removing a path is your call.

### C2. Where I differ from the review

- **8K stays, for stills only.** You asked for it by name, and upscaling a finished still to 8K is a
  cheap extra step. 8K video is cut.
- **Seeing and operating stay in the plan, later and smaller.** They are central to what you
  described, so I would not push them to the very end. But the reviewer is right about how to do
  them: a narrow first version with a measured success rate, and a browser surface you can actually
  see before an agent is asked to share it.
- **Variant archive is deferred, not dropped.** It becomes worthwhile when there is a quality number
  to select on and spare GPU hours — after a hardware upgrade, or on the night shift.

### C3. Revised order

| # | Milestone | You get | Needs |
|---|---|---|---|
| 1 | **Script to narrated video in your own voice, 1080p** | A finished, uploadable video on the shelf, with title, description and tags ready to paste. Stills with motion, captions, loudness-corrected audio. Resumable per shot | GPU lease, ComfyUI with SDXL, resumable job runner, licence/consent registry. Your F5 voice lane and ffmpeg already exist |
| 2 | Stills to 4K and 8K | Upscaled images with a preview-then-render step and your rating beside the model's | Qwen-Image quantised, tiled upscaler, measured timings on this card |
| 3 | Music and mastering | A track at streaming loudness with a release package | ACE-Step 1.5 replacing the paid calls |
| 4 | Publishing that is real | Reddit by API; copy-ready packages for the rest; a ledger of what went where | Your Reddit app credentials; the stub publishers resolved |
| 5 | Hub | One feed of what you follow, ranked by what you open and rate | The feed tools built today |
| 6 | A browser you can see, and a first operator | The in-app browser as a visible pane; an agent that completes a short task there with approvals, with its success rate measured | A non-headless browser surface with your own login |
| 7 | Seeing | "The girl in the red shirt" selects the right track on a test clip, with a measured hit rate | SAM 3 access or the fallback pair; the consent registry from milestone 1 |
| 8 | Generated video clips | Short image-to-video clips mixed into the long-video pipeline | Wan 2.2; night-shift rendering |
| 9 | Variant archive, restore drill | Pipelines that compete on measured quality; a proven restore | Spare GPU hours |

### C4. What self-improvement and self-preservation may not touch

Stated once so it is not left to judgement later. The kernel and any agent may **propose** changes to
anything; they may **apply** changes only outside this list, and code still merges only by your hand.

- the approval gate and the list of tools that need approval
- publishing credentials and the publishing ledger
- the licence, consent and disclosure registry
- backups and the restore path
- the GPU lease and the pause-autonomy switch
- this list

Self-preservation means the system can restore itself from a verified backup and notices when its
own files change. It does not include resisting a stop, a revert or a deletion that you ask for.

### C5. What I need from you to start milestone 1

1. **A yes to downloading** ComfyUI and one image model onto F:. I will show each file, its source
   and its size first.
2. **Whether the first channel is monetised.** If yes, your F5 voice clone cannot be used for it and
   I will set up a permissively licensed voice model instead.
3. **A decision on the existing stubs and paid music calls**: replace them, or leave them in place.
