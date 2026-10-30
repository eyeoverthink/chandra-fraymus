---
description: "Master development skill for Chandra-FRAYMUS. Load before any codebase work — architecture, conventions, subsystem map, testing."
---

# Chandra-FRAYMUS Development Skill

You are working on **Chandra-FRAYMUS**, a unified autonomous AI workspace. Before making any changes, internalize these patterns.

## Architecture Quick Reference

- **Server:** Node.js ESM, Express 4, better-sqlite3 WAL, WebSocket — port 8787
- **Client:** Vite + React, 8 panels, `useWebSocket.js` hook — port 5173
- **LLM:** Ollama at localhost:11434 (configurable via OLLAMA_BASE_URL)
- **DB:** SQLite at `data/chandra.db`, migrations in `server/db-migrate.js`
- **Entity Store:** `server/fraymus/entity-store.js` — SQLite-backed Proxy adapter for FRAYMUS modules
- **Identity:** Ed25519 sovereign identity in `server/fraymus/core/`

## Code Conventions (Non-Negotiable)

1. **ESM everywhere** — `"type": "module"`, use `import`/`export`
2. **Async routes** — always wrap in `try { ... } catch (e) { next(e) }`
3. **Fetch timeouts** — always `AbortSignal.timeout(15_000)` on external calls
4. **Query param clamping** — `Math.min(500, Math.max(1, parseInt(val) || 100))`
5. **DB ownership** — scope DELETE/UPDATE with `AND user_id = ?`
6. **DB reads** — never `SELECT *` without LIMIT on user-facing endpoints
7. **JSON.parse safety** — use `safeParse(str, fallback)` for DB/external data
8. **Error responses** — always `{ error: 'message' }` JSON, never plain text
9. **No silent catches** — always `catch (e) { console.error('context:', e.message) }`
10. **Commerce shared** — import from `server/commerce/shared.js` (`chatOllama`, `shopifyHeaders`, `shopifyBase`)
11. **Shopify API** — version `2024-10`, centralized in shared.js
12. **WebSocket** — single connection via `useWebSocket.js`, panels react via `wsEvent` prop

## Key Subsystem Map

| Subsystem | Directory | Status |
|-----------|-----------|--------|
| Core Server | `server/app.js`, `server/runtime.js` | COMPLETE — Express routes, WebSocket, lifecycle |
| FRAYMUS Stack | `server/fraymus/` | COMPLETE — Identity, encoding, protocol, intelligence |
| Entity Store | `server/fraymus/entity-store.js` | COMPLETE — SQLite Proxy adapter for FRAYMUS modules |
| Commerce | `server/commerce/` | COMPLETE — 4 pipelines, shared.js, routes.js, tools.js |
| Agent Fleet | `server/fleet/`, `agents/` | COMPLETE — 17 agents, manifest loader, runtime |
| Vertiso | `server/vertiso/` | COMPLETE — Vector memory + RSI engine |
| Workflows | `server/workflow/` | COMPLETE — 30 node types, all with real handlers |
| Automations | `server/automations/` | COMPLETE — Cron scheduler |
| MCP | `server/mcp/` | COMPLETE — Server gateway + client bridge |
| Browser | `server/browser/` | COMPLETE — Puppeteer + Chrome extension |
| Frontend | `client/src/` | COMPLETE — 8 panels, all render real data |

## FRAYMUS Intelligence Stack (all wired to SQLite entity store)

| Module | File | What It Does |
|--------|------|-------------|
| Hermes | `intelligence/hermes.js` | 30-skill fleet with 14 real executors |
| Motor | `intelligence/motor.js` | Job dispatch with SQLite persistence |
| OpenClaw | `intelligence/openclaw.js` | 23 gateway actions, all implemented |
| Ouroboros | `intelligence/ouroboros.js` | Real evolution cycles + 5 consciousness tests |
| Needle | `intelligence/needle.js` | GPU job queue with SQLite persistence |
| Niles | `intelligence/niles.js` | FRAYVM stack machine interpreter |
| Control Plane | `intelligence/control-plane.js` | Agent registry, enrollment, coordination |

## When Adding a New Feature

1. Add the server route in the appropriate subsystem
2. If it uses FRAYMUS persistence: `import { entityStore } from './fraymus/entity-store.js'`
3. If it's a commerce feature: add to `server/commerce/routes.js`, use shared.js
4. Register fleet tools in the relevant `tools.js` with safety: `"safe"` or `"approval_required"`
5. Add a workflow node type in `WorkflowCanvas.jsx` NODE_TYPES + handler in `engine.js`
6. Add WebSocket event type if real-time updates needed
7. Update panel's `useEffect` to react to new event type
8. Run `node --check` on changed files before committing

## When Fixing Bugs

1. Check which audit layer the bug falls under (see /chandra-audit)
2. Apply the established pattern from that layer
3. Verify with `node --check` on changed server files
4. Test in browser if frontend changes: `npm run dev` → http://127.0.0.1:5173
5. Commit with descriptive message, push to origin/master

## Testing

```bash
# Syntax check
node --check server/path/to/file.js

# Full import test (only if no other instance running)
node -e "await import('./server/app.js')"

# Health endpoint (31 features expected)
curl http://127.0.0.1:8787/api/health

# Entity store test
node -e "import('./server/fraymus/entity-store.js').then(m => { const c = m.entityStore.Test; console.log(c.create({x:1})); })"

# FRAYMUS system test
node -e "import('./server/fraymus/entity-store.js').then(async es => { const {createMasterSystem} = await import('./server/fraymus/index.js'); const sys = createMasterSystem(es.entityStore); console.log(await sys.gateway.handle('status')); })"

# Frontend
npm run dev  # then open http://127.0.0.1:5173, check all 8 panels
```

## File Counts (verified 2026-10-30)

- 132 server JavaScript files (including entity-store.js)
- 175+ API routes
- 22+ database tables (16 core + 3 Vertiso + 3 RSI + fraymus_entities)
- 17 agent manifests
- 8 frontend panels
- 30 workflow node types (all with real handlers)
- 31 system features
- 29 FRAYMUS fleet tools
- 23 OpenClaw gateway actions
- 14 Hermes skill executors
- 9 audit layers completed (all clean)
