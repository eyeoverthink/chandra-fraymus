# Chandra E2E Runbook

Use this runbook to prove local Chandra is working end-to-end and to leave durable evidence for the next agent.

## 1) Required workspace layout

- `chandra-fraymus` (this repo)
- `fraymus-voice` (sibling repo)
- Optional canonical partner repo: `MyAIPartner` (sibling)

If a sibling path differs, set overrides in `.env`:

- `CHANDRA_PARTNER_DIR`
- `CHANDRA_PARTNER_DIST`
- `FRAYMUS_VOICE_ENTRY`

## 2) Start from clean state

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-local.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Build
```

## 3) Run automated smoke + capture evidence

```powershell
npm run smoke:e2e
```

This command verifies:

- `/api/health`
- `/api/fraymus/health`
- `/api/voice/health`
- `/partner/`
- `/api/fleet/agents`
- `/api/collab/create`

It also captures screenshots of `/` and `/partner/`.

## 4) Artifacts to keep in repo

- `docs/evidence/latest/e2e-smoke-report.json`
- `docs/evidence/latest/e2e-smoke-report.md`
- `docs/screenshots/e2e-latest/root.png`
- `docs/screenshots/e2e-latest/partner.png`

## 5) Voice fix provenance

Current known voice README fix reference:

- `fraymus-voice` commit `e6623db`

## 6) Failure triage

- If `voice_health` fails, verify `FRAYMUS_VOICE_ENTRY` path and rerun launcher.
- If `/partner/` fails, ensure `MyAIPartner/dist` exists or rely on `client/dist` fallback.
- If smoke fails after startup, inspect logs in `data/`.

