# Phase 52 — Gap Analysis Bug Fixes + Graceful Degradation

**Previous:** [Phase 51](PHASE-51.md)

## Summary

Phase 52 fixes all cascading bugs discovered during the Phase 51 gap analysis, plus adds graceful degradation for the ComfyUI bridge. The gap analysis tested all 61 registered features and found that `/api/fraymus/intelligence/overview` crashed due to a chain of method-not-found errors masked by the first crash.

## Bugs Fixed

### 1. Identity Field Mismatch (fixed in Phase 51, commit 741cb77)
- `autonomy.js`: `identity.publicKey` → `identity.pubkey` (4 occurrences)
- `autonomy.js`: `signText(identity.privateKey, ...)` → `signText(identity, ...)` (1 occurrence)
- Root cause: `generateIdentity()` returns `{ name, pubkey, number, priv }`, not `{ publicKey, privateKey }`

### 2. Missing OuroborosEngine Methods (partially in 741cb77, field fix this phase)
- Added `fitness()` method returning `{ generation, score, genomeSize, memoryDepth }`
- Added `evolve()` method with population-based mutation + selection
- Fixed return field: `genomeFitness` → `score` (what autonomy.js expects)
- Changed `evolve()` from async to sync (no await needed)

### 3. HermesFleet API Mismatch
- `autonomy.js`: `hermes.selectOptimal(fitness)` → `hermes.listSkills()`
- `hermes.listSkills()` returns an array, so also fixed `skills?.total` → `skills?.length`
- Root cause: HermesFleet has `listSkills()`, `execute()`, `manifest()` — no `selectOptimal()`

### 4. OpenClawGateway API Mismatch
- `autonomy.js`: `openclaw.listActions()` → `openclaw.status()`
- Fixed `gateway.count` → `gateway.implemented` (status() returns `{ implemented, actions }`)
- Root cause: OpenClawGateway has `handle()` and `status()` — no `listActions()`

### 5. Missing ControlPlane.status()
- Added `status()` method to `control-plane.js` returning `{ totalAgents, online, enrolled, offline }`
- Root cause: ControlPlane had `enroll`, `unenroll`, `getAgent`, `listAgents`, `broadcast` — no `status()`
- The error was silently swallowed in `autonomyPulse()` try/catch but crashed `assessFull()`

### 6. ComfyUI Graceful Degradation
- Added pre-check to `POST /api/media/comfyui/generate`: calls `comfyuiStatus()` first
- Returns 503 with helpful message when ComfyUI is not running
- Previously would crash with a connection refused error

## Cascading Bug Pattern

The identity crash (Bug 1) masked the fitness crash (Bug 2), which masked the hermes crash (Bug 3), which masked the openclaw crash (Bug 4), which masked the controlPlane crash (Bug 5). Each fix peeled back the next layer. This is why end-to-end testing matters — unit tests on individual modules wouldn't have caught this integration chain.

## Files Changed

| File | Changes |
|------|---------|
| `server/autonomy.js` | 6 fixes: hermes.selectOptimal→listSkills, skills.total→length (×2), openclaw.listActions→status, gateway.count→implemented |
| `server/fraymus/intelligence/ouroboros.js` | fitness() field genomeFitness→score, evolve() async→sync |
| `server/fraymus/intelligence/control-plane.js` | Added status() method |
| `server/media/image-routes.js` | Added ComfyUI availability pre-check |

## Verification

All endpoints tested after fixes:
- `GET /api/fraymus/autonomy/status` — Full autonomy state with Ed25519 identity, Kuramoto sync, evolution log
- `GET /api/fraymus/intelligence/overview` — All 8 intelligence subsystems reporting (ouroboros, hermes, motor, openclaw, heart, dreamer, ledger, cognition)
- `POST /api/media/comfyui/generate` — Returns 503 with helpful message when ComfyUI offline

## Post-Fix Feature Status

| Category | Count |
|----------|-------|
| Verified working | 49 (+3 from Phase 51's 46) |
| External dependency | 7 (ComfyUI, vision model, voice proxy, Puppeteer, Chrome ext, MCP client, commerce APIs) |
| Internal-only | 3 (no standalone test route) |
| Bugs remaining | 0 |
