---
description: "Master development skill for the Chandra-FRAYMUS system. Load this before any work on the codebase."
---

# Chandra-FRAYMUS Development Skill

You are working on **Chandra-FRAYMUS**, a unified autonomous AI workspace. Before making any changes, internalize these patterns.

## Architecture Quick Reference

- **Server:** Node.js ESM, Express 4, better-sqlite3 WAL, WebSocket — port 8787
- **Client:** Vite + React, 8 panels, `useWebSocket.js` hook — port 5173
- **LLM:** Ollama at localhost:11434 (configurable via OLLAMA_BASE_URL)
- **DB:** SQLite at `data/chandra.db`, migrations in `server/db-migrate.js`
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

| Subsystem | Directory | What It Does |
|-----------|-----------|-------------|
| Core Server | `server/app.js`, `server/runtime.js` | Express routes, WebSocket, lifecycle |
| FRAYMUS Stack | `server/fraymus/` | Identity, encoding, protocol, intelligence |
| Commerce | `server/commerce/` | 4 pipelines, shared.js, routes.js, tools.js |
| Agent Fleet | `server/fleet/`, `agents/` | 17 agents, manifest loader, runtime |
| Vertiso | `server/vertiso/` | Vector memory + RSI engine |
| Workflows | `server/workflow/` | Visual canvas engine, 30 node types |
| Automations | `server/automations/` | Cron scheduler |
| MCP | `server/mcp/` | Server gateway + client bridge |
| Browser | `server/browser/` | Puppeteer + Chrome extension |
| Frontend | `client/src/` | 8 panels, App.jsx, useWebSocket.js |

## When Adding a New Feature

1. Add the server route in the appropriate subsystem
2. If it's a commerce feature, add to `server/commerce/shared.js` and `routes.js`
3. Register fleet tools in the relevant `tools.js` with safety classification
4. Add a workflow node type in `client/src/panels/WorkflowCanvas.jsx` NODE_TYPES array
5. Add WebSocket event type if real-time updates are needed
6. Update panel's `useEffect` to react to the new event type
7. Run `node --check` on changed files before committing

## When Fixing Bugs

1. Check which audit layer the bug falls under (see CLAUDE.md or memory)
2. Apply the established pattern from that layer
3. Verify with `node --check` on changed server files
4. Test in browser if frontend changes (dev server at http://127.0.0.1:5173)
5. Commit with descriptive message, push to origin/master

## Testing

- **Syntax check:** `node --check server/path/to/file.js`
- **Full import:** `node -e "await import('./server/app.js')"` (only if no other instance running)
- **Health:** `curl http://127.0.0.1:8787/api/health` (31 features expected)
- **Frontend:** Open http://127.0.0.1:5173, check all 8 panels
- **WebSocket:** Check browser console for heartbeat pings

## File Counts (as of 2026-10-30)

- 131 server JavaScript files
- 175+ API routes
- 53+ database tables
- 17 agent manifests
- 8 frontend panels
- 30 workflow node types
- 31 system features
- 9 audit layers completed (all clean)
