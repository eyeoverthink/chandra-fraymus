# The flat animation method

How Chandra makes a narrated flat-vector film — a Kurzgesagt-style explainer or a cartoon story short — from one
typed sentence, with nothing paid and no graphics card. Written 2026-11-11.

## Where the method comes from

A widely watched tutorial shows a language model producing "cartoon story shorts" on a paid canvas of paid models
(an image model, a video model, a cloned voice, an editor). Stripped of the products, what it teaches is a
**method**, and the method is what was rebuilt here:

| Step in the tutorial | What it is really for | What Chandra does instead |
|---|---|---|
| Study ten successful shorts, write eighteen rules | Turn taste into something checkable | 17 numbered rules in `server/media/flat/plan.js`, each decided by code |
| Design an own cast, four views and four faces each | The same characters in every film | Six original characters drawn as vector shapes (`flat/kit.js`), ten feelings each, identical in every frame by construction |
| Planner splits the script into twelve shots: words, picture, motion, sound | One line, one picture | A writer model names words, place, things and people per shot; an **art director in code** stages the rest |
| Make each picture with an image model, check it, remake misses (three of twelve passed first time) | Catch pictures that break the rules | Pictures are assembled from a fixed vocabulary, so most rules are decided from the plan before anything is drawn |
| Turn each picture into a four-second clip with a video model, check faces frame by frame | Motion | Every element is a function of time; a frame costs about 50 ms on one CPU core |
| One voice take, word timings, cuts moved to the words (10 of 11 within a quarter second) | The picture lands on the words | One recorded line per shot; the soundtrack is laid out sample by sample, so every cut is placed 0.1 s before its line — all cuts within a quarter second, by construction and then measured |
| Sound effects mixed low under each clip | Texture | Ten effects synthesised from oscillators and noise (`flat/audio.js`), no samples |
| Final edit with captions; transcribe the result and compare with the script | Proof the film says what was written | Captions are generated from the same lines that were spoken; eleven measurements are taken from the finished file |
| "It checked every fact" | Truth | The opening of the matching Wikipedia article is put in front of the writer when it can be reached; the film's record names the source, or says there was none |

## The pipeline

```
sentence
  → plan            make-plan.js          look "flat", length, shape (16:9, 9:16 or 1:1)
  → facts           make.js groundFacts   Wikipedia opening, only if the title is about the subject
  → shot list       flat/plan.js          writer model → {say, where, show, who, feel} per shot
  → rules           flat/plan.js          17 rules; a hard miss goes back to the writer with the reason (≤ 3 attempts)
  → art director    flat/plan.js direct   variety, casting by role words, labels, movement, camera, sound
  → voice           make.js makeFlat      one line per shot (VoiceStudio or the offline cascade), 24 kHz
  → soundtrack      flat/audio.js         silence trimmed, lines laid end to end, effects underneath
  → frames          flat/render.js        SVG per frame → Skia → raw RGBA → ffmpeg, −14 LUFS
  → measurements    flat/render.js        eleven checks; a film that fails a hard one is not put in the library
  → shelf + record  data/video, lineage.json
```

## The vocabulary

A shot can only show what the kit can draw. That is the limit of the look and the reason it is reliable.

- **Settings (13):** space, night, field, sunset, city, lab, room, ocean, desert, forest, mountains, snow, micro.
  Each is painted in three depths that move at different speeds under the camera, and each has a light you can see.
- **Props (50):** sky things, ground things and floating ideas, each with the words a narrator might call it
  (`cannon` answers to "machine gun", `coin` to "sold" and "fortune"). A prop moves on its own.
- **Cast (6):** nilo (lead), prof, bru, zee, baron, dot. Ten feelings, ten ways of moving.
- **Camera (6), sound effects (10).**

To add to it: one entry in `PROPS` or `SETTINGS`. The tests draw every entry at several times and check the result
is well-formed; nothing else needs to change, and the writer is told about the new word automatically.

## The rules

Hard rules send a plan back: the hook is at most 14 words (1); the last line is a statement (2); lines are 3–18
words (3); the number of shots fits the length (4); every shot shows something (5); at most three characters (6);
the lead is in half the shots (7); two shots are picture jokes, where the picture shows exactly what the words say
(8); the narration fits the asked length (12); no line repeats another, and no slogan is repeated with new endings (17).
The others are reported with the film: painted settings (9), two places (10), labels repeat the narration (11),
one feeling each (13), varied camera (14), two cast members (15), no prop in more than half the shots (16).

## What is measured on the finished film

The file opens with picture and sound · its length matches the soundtrack · its shape is what was asked · no shot
is blank · every shot moves · each cut changes the picture · each picture lands within a quarter second of its
words · no silence longer than a second · the captions carry every word · faces sit above the captions · no shot is a flash.

## Measured (2026-11-11, this PC, CPU only; writer `qwen3:14b` on fraymus-home, voice VoiceStudio)

| Film | Asked | Made | End to end | Render |
|---|---|---|---|---|
| The Great Emu War, 9:16 | 40 s | 37.8 s | 3 min 07 s | 86 s for 1,133 frames |
| How your immune system fights a virus, 16:9 | 60 s | 62.5 s | 3 min 26 s | 107 s for 1,874 frames |
| What is a black hole?, 16:9 | 45 s | 43.0 s | 1 min 59 s | 71 s for 1,289 frames |

Narration length is estimated from letters, not words: fitted over the first seven films, 11.6 letters a second
with an error of 1.6 s, against 2.8 s for a words-per-second model.

## What it does not do

- **It is not Kurzgesagt.** It shares the grammar — flat shapes, saturated gradients, a glow, small round
  characters, a narrator — and none of the hand-made illustration. A subject outside the 50 props is shown by the
  cast alone (the first black-hole film had no black hole until the prop was added).
- **The words are a 14B model's.** With a source the emu film named Campion, Lewis guns and the fences correctly;
  the immune film still said B cells "destroy" viruses. Read every film before it is shown to anyone.
- **Staging is mechanical.** The art director fixes monotony; it does not compose. Two characters standing side by
  side for many shots is its commonest failure.
- **Not built:** stills in this look, a second voice, music, mouth movement, word timing from a speech recogniser
  (words inside a line are timed in proportion to their length).
