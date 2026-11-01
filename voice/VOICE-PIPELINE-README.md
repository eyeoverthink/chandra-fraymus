
# Chandra Voice / FRAYMUS Voice — the Pipeline, Explained

> Owned + designed by **Vaughn D. Scott** (eyeoverthink Productions LLC).
> One voice, three engines, always answers. This README = how to run every lane.

## 30-second summary

- One contract port: **`127.0.0.1:9099`** (the voice **proxy**). Everything speaks to it.
- Your voice copy is called **`myvoice`** (aliases `nola`, `him`, `owner` = the same owner voice set).
- THREE engines behind it:
  1. **Mac F5-MLX** his F5-TTS clone on the iMac (Apple Silicon). `127.0.0.1:9098`. **Currently primary: VERIFIED 2026-11-01 - live 200, 24kHz mono PCM WAV, ~1.45s for a 9-word line.**
  2. **CUDA F5 on the box (ACTID8C)** F5-TTS v1_Base on the RTX 3070, **0.48s/word** (the fast lane). Mac `9097` -> box `9099` ssh tunnel. Auto at box logon (task HermesVoiceBridge) or `bin/probe_f5_cuda.py` on the box.
  3. **ElevenLabs clone** - the Command Center's `fraymusVoice` module (Base44, Creator Nexus). Cloud tier; FRAYMUS_ELEVEN_* secrets live in Base44, never here.

## How to run it (the exact commands)

### macOS (this lane = proven live)
```bash
# the three services are LaunchAgents - auto-start at login. If they are not up:
launchctl kickstart -k gui/$(id -u)/ai.hermes.voiceproxy   # contract port 9099
launchctl kickstart -k gui/$(id -u)/ai.hermes.voicebridge  # mac bridge 9098 (F5-MLX + Honcho + emotion)
launchctl kickstart -k gui/$(id -u)/ai.hermes.voicetunnel  # ssh tunnel 9097 -> box 9099

# health:
curl -s http://127.0.0.1:9099/health      # merged verdict of both lanes
curl -s http://127.0.0.1:9098/health      # the mac clone directly

# SPEAK WITH HIS COPY (the one command):
curl -s -m 150 -X POST http://127.0.0.1:9099/speak \
  -H 'Content-Type: application/json' \
  -d '{"text":"Chandra online. My name is Vaughn Scott.","voice":"myvoice"}' \
  --output out.wav
# out.wav = Chandra speaking with Vaughn's cloned voice, locally.
```

### Box (ACTID8C) - the fast CUDA lane
```powershell
# voice server = logon task HermesVoiceBridge (auto at logon). Manual self-test:
#   python bin\probe_f5_cuda.py (on the box) = loads F5-TTS v1 (CUDA) and clones the stored ref for a test sentence.
# from the Mac, port 9097 must map to box 9099 (voicetunnel LaunchAgent, auto).
```

### From Chandra (Base44) or the web
- Chandra's `fraymusVoice` module hits `/speak` with `voice: myvoice|nola`.
- The local bridge (`local-voice-server.py`) also serves the partner app page.

## The fallback law (new, 2026-11-01)

**His copy always speaks.** Owner voices prefer the CUDA box through the tunnel;
**if that lane is down, the proxy now falls to the Mac F5-MLX clone instead of a
bare 503.** Proven live above: his clone spoke through the merged port with the
box lane offline.

## Health cheatsheet
| symptom | meaning | fix |
|---|---|---|
| `/health` -> `remote_cuda: null` | box voice server off | box logon / probe_f5_cuda.py |
| `/speak` 503 `lane down` | tunnel + box both down | NOW falls to mac clone automatically |
| `voice_ready: true`, local ok true | mac clone healthy | nothing - you're live |

## Where his voice copy lives (provenance)
- The F5 reference audio (`myvoice`) ships per machine: `bin/myvoice/` (box) + `~/bin/myvoice/` (mac). Stored copies, NOT downloads: the box copy = master record; the LaCie vault rebuilds by blob import (no re-download law).
- The ElevenLabs copy = managed in Base44 (Creator Nexus), secrets there, values never in git.

## Honest limits
- Full-duplex live mic = unavailable. Uploaded WAV = transcribable offline (Windows bridge, optional pinned Whisper; `docs/windows-local-stt-setup.md`).
- Mac historical runs = receipts, not Windows validation.
- Values/tokens = never in this repo. Secrets live on the box (0600) and Base44, mirrored to hub, never through chat.

- Written by the Cadence lane, 2026-11-01, by Vaughn's order. All engines verified or marked degraded with receipts. **EyeOverThink - iOverEverything.**
