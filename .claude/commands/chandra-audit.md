---
description: "Systematic audit skill for Chandra-FRAYMUS. Load when hardening, reviewing security, or adding new routes/subsystems."
---

# Chandra Audit & Hardening Skill

## Audit Methodology

Chandra has been through a **9-layer systematic audit**. Each layer goes deeper:

| Layer | Focus | Pattern |
|-------|-------|---------|
| 1 | Surface bugs | Fix what's visibly broken |
| 2 | Async safety | Wrap all async routes in try/catch → next() |
| 3 | WebSocket | Heartbeat, reconnection, frontend error handling |
| 4 | Architecture | Deduplicate shared code, single WebSocket hook |
| 5 | Input validation | Clamp query params, validate body types, ownership checks |
| 6 | Security/ops | Fetch timeouts, CORS, headers, shutdown, logging |
| 7 | Edge cases | safeParse for JSON.parse, logic bugs |
| 8 | Resilience | Silent catches, error truncation, guard clauses |
| 9 | Clean sweep | Verify remaining modules (confirmed all clean) |

## Audit Checklist for New Code

Run through this for every new route handler, fetch call, or DB query:

### Route Handler
- [ ] Wrapped in `try { ... } catch (e) { next(e) }` (async routes)
- [ ] Request body validated (type, length, required fields)
- [ ] Query params coerced and clamped: `Math.min(500, Math.max(1, parseInt(val) || 100))`
- [ ] Response is JSON `{ error: 'message' }` on failure, never plain text
- [ ] SELECT queries have LIMIT clause

### Database
- [ ] All queries use parameterized statements (no string interpolation)
- [ ] DELETE/UPDATE scoped with `AND user_id = ?`
- [ ] JSON.parse on DB data uses `safeParse(str, fallback)`

### External API Calls
- [ ] `AbortSignal.timeout(15_000)` on every fetch()
- [ ] Error from fetch is caught and logged with context
- [ ] Reflected input (method names, IDs) truncated before including in responses

### Error Handling
- [ ] No silent `catch {}` blocks
- [ ] All catches log: `console.error('context:', e.message)`
- [ ] Error middleware truncates messages (no stack traces leaked)

### WebSocket
- [ ] New event types added to server `broadcast()` calls
- [ ] Frontend panel's `useEffect` watches for new event type via `wsEvent`
- [ ] No duplicate WebSocket connections (single hook in App.jsx)

## Running an Audit

1. **Pick the target:** a subsystem directory or set of files
2. **Read each file fully** — don't skim
3. **Check against the checklist above**
4. **Apply fixes** using the established patterns
5. **Verify:** `node --check server/path/to/file.js` on each changed file
6. **Commit with layer reference:** `"Layer N: [description]"`

## Verified Clean Areas (as of 2026-10-30)

- SQL injection: all queries parameterized
- CORS/security headers: set in local-http.js
- Error handler: truncates messages, no stack leaks
- Env validation: config.js validates at startup
- Graceful shutdown: HTTP, WS, DB, intervals cleaned
- No sensitive data in logs
- Deep subsystems (sandbox, desktop, OCR, transport): integrity chains, quarantine, bounded I/O

## safeParse Pattern
```js
function safeParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}
```
Use everywhere DB data or external data is parsed.
