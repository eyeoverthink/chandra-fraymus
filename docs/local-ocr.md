# Local file OCR

`artifact.ocrText` extracts fallible English text from attached PNG/JPEG images or
one explicit PDF page using Windows.Media.Ocr. It runs without Docker, a paid API
or a vision helper model. Availability does not establish transcription accuracy.

For images, select **Image handling → Local OCR · English text** and send an Agent
task with a local tool-capable model. The primary receives file references and
tool text instead of pixels. Uploading or selecting this mode does not start OCR.
Direct images and the Gemma3 helper keep their existing explicit modes; failure
never automatically switches engines.

For PDFs, upload normally and ask the local agent to OCR a specific page. Native
text remains available through `artifact.read`; image-only pages can also be
selected. Uploading does not OCR every page or interpret figures.

## Authority, evidence and budgets

Arguments are `assetId`, PDF-only `page`, optional `language: "en-US"`, `offset`
and `maxChars`. Attachment authority is checked before reading and on cached reads.
Host paths, URLs, unsupported languages and unknown fields are rejected. PDF page
selection is required; image page selectors are forbidden. Scheduled and cloud
runs cannot use this tool.

Receipts bind source/image/text SHA-256, dimensions, engine, helper/launcher
hashes and result identity. PDF evidence includes page, page count, render hash,
actual DPI/downscaling, renderer policy and resource facts. OCR text grants no
action authority. No recognition-confidence score is available or fabricated.

`nextOffset` reads the same complete result with safe UTF-16 offsets. Per-run weak
caches retain at most eight attempted keys and 256 KiB of completed immutable
JSON, bound to source/page/language/policy. Failed or uncertain attempts are not
silently retried. Excerpts fit the run output budget without dropping receipts;
metadata that cannot fit fails explicitly.

OCR makes no language-model calls or auxiliary language-model-token usage. This
does not mean that recognition engines cannot use learned models. Text sent in
later primary requests counts toward actual input tokens; normal tool, time,
context and run budgets apply. Local CPU/memory/electricity still have costs.

Selecting local OCR, or admitting default-mode PDF OCR, marks the conversation
local-only before OCR data enters inference context. Future cloud inference and
Direct-history transfer remain blocked for that conversation.

## Limits and lifecycle

- Input: existing 4 MiB attachment limit. Image OCR: at most 4096 pixels per edge
  and 4 million pixels. JPEG EXIF orientation is ignored and reported as raw pixels.
- PDF: one page of at most 300 pages, target 150 DPI uniformly capped at 2600
  pixels per edge and 4 million pixels. PNG output is at most 4 MiB; actual scale
  and downscaling are recorded.
- Text: at most 64 KiB UTF-8, 1000 lines and 4000 words. Excerpts: at most 8000
  characters, reduced for the configured tool-output budget. Blank is valid.
- Native OCR: fixed hidden PowerShell helper, bytes-only JSON, verified 512 MiB
  Windows Job, one child, three standard handles and kill-on-close. Cancellation
  requests exact Job termination and checks child exit, active-process zero and
  stream drain. Unconfirmed cleanup quarantines the provider; close drains work.
- PDF: fixed Node child in the existing 384 MiB Windows Job, bounded canvas
  allocations, external factories/fetch denied, XFA/forms/viewer scripting not
  enabled, discovered document/form/selected-page JS actions rejected. The supplied
  `isEvalSupported:false` flag is not itself treated as proof on this PDF.js version.
- Forced PDF-wrapper termination cannot prove direct child exit from wrapper close
  alone. It quarantines rendering with unconfirmed cleanup. PDF readiness is
  separate from native image-OCR readiness.

These are fixed file processors with resource controls, not an AppContainer or
general model-code sandbox. No desktop capture, clipboard, UI automation, language
pack installation or arbitrary command tool is added.

## Accuracy evidence

The installed engine advertises `en-US`. One owned plain-text fixture matched after
whitespace normalization and a blank image returned empty text. Both earlier
stylized digit images failed exact OCR; those failures remain recorded. A supplied
PDF page rendered with unchanged source bytes and produced bounded OCR text;
processing success does not prove every word correct.

Check names, numbers and quotations against the source. Small text, stylized
fonts, handwriting, rotation and layout can cause errors. No general accuracy,
reliable-digit or desktop-perception claim is made.

## Preregistered quality study

A later workspace experiment froze 14 calibration and 28 held-out synthetic PNGs
before recognition. The only cross-split duplicate was a shared white blank
control; all 24 held-out digit/word cases were unique. Eight fixed processing
profiles were compared on calibration only. Raw and grayscale tied at 14/14;
cropping and downscaling regressed, so the fixed tie-break selected raw before
any held-out call. No profile recovered either original pixel-font code.

Raw Windows OCR and an isolated, pinned offline Tesseract.js candidate each read
27/28 held-out cases exactly. Windows made three character edits in a digit
case; Tesseract made one punctuation edit elsewhere, out of 246 reference
characters. Explicit digit-alphabet hints gave no gain over generic Tesseract on
the same 17 digit-hinted cases. Their 26/28 agreements are not an accuracy
certificate. All raw errors remain in the workspace evidence.

The application keeps its existing Windows OCR default. No alternative engine,
preprocessing, voting or fallback was deployed. The candidate dependency remains
in the isolated research directory. These generated fixtures do not establish
general OCR accuracy; timings were not a controlled performance study. The pass
used 233 recorded local OCR executions, zero language-model calls and zero paid
API calls, with process/resource cleanup evidence retained.

Primary references: [Microsoft OcrEngine](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine),
[installed recognizer languages](https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.availablerecognizerlanguages).
