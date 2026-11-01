# Chandra-FRAYMUS App Status

As-of date: **2026-11-01**

This file is the quick operational snapshot for future agents/operators.

## Current State

- Core API is up on `http://127.0.0.1:8787`.
- `/partner/` serves the real partner UI (vendored build in `partner-dist/` by default).
- Voice proxy reports ready via `/api/voice/health`.
- Agent fleet endpoint is healthy and returns loaded agents.
- Collaboration create flow is healthy (`/api/collab/create`).

## Workspace Model

Expected local workspace:

- `chandra-fraymus` (this repo)
- `fraymus-voice` (sibling repo)
- `MyAIPartner` (optional sibling repo)

Static partner lookup order in `server/static.js`:

1. `CHANDRA_PARTNER_DIST` env override
2. sibling `../MyAIPartner/dist`
3. vendored `partner-dist/` (in this repo)
4. `client/dist` fallback

## Run Commands

Use launcher scripts from repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\stop-local.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-local.ps1 -Build
```

Run smoke verification:

```powershell
npm run smoke:e2e
```

Run static route tests:

```powershell
node --test test/static.test.js
```

## Verified Results (2026-11-01)

### Dual-Surface Verification

Both app surfaces were verified independently and passed:

- `http://127.0.0.1:8787` (server-hosted partner surface) -> **PASS**
- `http://127.0.0.1:5173` (standalone Chandra Vite client) -> **PASS**

Captured artifact sets:

- `docs/evidence/dual-surface/2026-11-01/partner-8787-report.json`
- `docs/evidence/dual-surface/2026-11-01/partner-8787-report.md`
- `docs/evidence/dual-surface/2026-11-01/client-5173-report.json`
- `docs/evidence/dual-surface/2026-11-01/client-5173-report.md`
- `docs/screenshots/dual-surface/2026-11-01/partner-8787/root.png`
- `docs/screenshots/dual-surface/2026-11-01/partner-8787/partner.png`
- `docs/screenshots/dual-surface/2026-11-01/client-5173/root.png`
- `docs/screenshots/dual-surface/2026-11-01/client-5173/partner.png`

### E2E Smoke

- Command: `npm run smoke:e2e`
- Result: **PASS**
- Verified checks:
  - `health`
  - `fraymus_health`
  - `voice_health`
  - `partner_route`
  - `fleet_agents`
  - `collab_create`

Evidence artifacts:

- `docs/evidence/latest/e2e-smoke-report.json`
- `docs/evidence/latest/e2e-smoke-report.md`
- `docs/screenshots/e2e-latest/root.png`
- `docs/screenshots/e2e-latest/partner.png`

### Static Serving Tests

- Command: `node --test test/static.test.js`
- Result: **5 passed, 0 failed**
- Scope includes:
  - production root/partner serving
  - `/partner` redirect behavior
  - old routes/assets remain unreachable
  - missing-build 503 behavior
  - development mode handoff behavior

## Voice Provenance

Referenced sibling voice update:

- `fraymus-voice` commit `e6623db`

## Canonical Ops Doc

For detailed startup/triage flow, use:

- `docs/E2E-RUNBOOK.md`
