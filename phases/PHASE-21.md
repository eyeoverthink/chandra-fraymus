# Phase 21: Deploy-as-API

**Previous:** [Phase 20 — Needle Worker Loop + Motor Live Dispatch](./PHASE-20.md)
**Next:** [Phase 22 — Agent Live Bus](./PHASE-22.md)

---

## Summary

Phase 21 completes the Deploy-as-API system that was partially scaffolded in the original codebase. Workflows can now be deployed as authenticated REST endpoints, called via `curl` or any HTTP client, with per-key rate limiting and full usage analytics. This is the external-facing surface of Chandra-FRAYMUS — the gateway that lets other apps consume your AI pipelines.

## What Shipped

### Deploy-as-API Module (`server/deploy-api/`)

**New files:**

| File | Purpose |
|------|---------|
| `middleware.js` | Auth middleware — validates Bearer token, checks scopes, applies rate limit |
| `rate-limiter.js` | Token bucket rate limiter — in-memory, per-key, auto-refill |
| `usage.js` | SQLite usage tracker — logs every invocation, analytics queries |
| `routes.js` | 7 API routes — catalog, deploy, undeploy, execute, usage stats |

### Auth Middleware (`middleware.js`)

Chains three checks on every `/api/run/:slug` call:

1. **Bearer validation** — reuses `verifyBearer()` from `mcp/auth.js` (SHA-256 hashed, timing-safe)
2. **Scope check** — requires `run` scope (admin keys bypass)
3. **Rate limit** — consumes one token from the caller's bucket

Returns `X-RateLimit-Remaining` and `X-RateLimit-Limit` headers on every response. Returns `429` with `Retry-After` when exhausted.

### Rate Limiter (`rate-limiter.js`)

Token bucket algorithm — no Redis, no external deps:

| Config | Default | Admin |
|--------|---------|-------|
| Max tokens | 60 | 600 |
| Refill rate | 1/sec | 10/sec |
| Window | Rolling | Rolling |

- Buckets are per-key (identified by token name)
- Auto-refill on each check (elapsed time * refill rate)
- Stale buckets (10+ minutes idle) cleaned up every 5 minutes

### Usage Tracker (`usage.js`)

Every invocation logs to `api_usage` table:

| Column | Content |
|--------|---------|
| `key_id` | Which API key was used |
| `key_name` | Human-readable key name |
| `slug` | Which deployed workflow |
| `workflow_id` | Workflow UUID |
| `status` | `ok` or `error` |
| `duration_ms` | Execution time |
| `error` | Error message (if failed) |
| `ip` | Caller IP |

Analytics queries:
- `usageStats(slug)` — total, today, this week, avg latency, error count
- `globalStats()` — all slugs ranked by usage, all keys ranked by usage
- `usageBySlug(slug, opts)` — recent invocations for a slug
- `usageByKey(keyId, opts)` — recent invocations for a key

### API Routes

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/deploy/catalog` | No | List all deployed workflow endpoints |
| POST | `/api/workflows/:id/deploy` | No | Deploy a workflow with custom slug |
| POST | `/api/workflows/:id/undeploy` | No | Remove a workflow deployment |
| POST | `/api/run/:slug` | Bearer | Execute deployed workflow (rate-limited + logged) |
| GET | `/api/deploy/usage` | No | Global usage statistics |
| GET | `/api/deploy/usage/:slug` | No | Per-slug stats + recent invocations |
| GET | `/api/deploy/rate-status` | Bearer | Caller's rate limit bucket status |

### Deploy Dashboard (`client/src/panels/DeployPanel.jsx`)

10th panel in the Detail Drawer (also accessible from new "Deploy API" widget in Command Center):

- **Usage overview** — deployed count, total calls, today's calls, key count
- **Endpoint cards** — each deployed workflow shows slug, curl example, live/offline badge
- **Per-endpoint stats** — expand to see total, today, avg latency, error count
- **API key management** — generate new keys, copy token, revoke existing
- **One-click copy** — click any curl example or token to copy to clipboard

### Database Migration

New `api_usage` table added to `db-migrate.js` with indexes on `(slug, created_at)` and `(key_id, created_at)`.

### Slug Protection

The deploy route now enforces unique slugs — attempting to deploy with a slug already used by another workflow returns `409 Conflict`. Slugs are normalized (lowercase, alphanumeric + hyphens, max 40 chars).

## Architecture After Phase 21

```
External App ──► POST /api/run/:slug
                      │
                 ┌────▼─────┐
                 │ Auth MW   │  Bearer token → verifyBearer() → scope check
                 └────┬─────┘
                 ┌────▼─────┐
                 │ Rate Lim  │  Token bucket → tryConsume(keyId) → 429 if empty
                 └────┬─────┘
                 ┌────▼─────┐
                 │ Execute   │  Lookup slug → parse workflow → runPipeline()
                 └────┬─────┘
                 ┌────▼─────┐
                 │ Log Usage │  logInvocation() → api_usage table
                 └────┬─────┘
                 ┌────▼─────┐
                 │ Broadcast │  WebSocket 'deploy' event → Dashboard live update
                 └──────────┘
```

## Files Changed

| File | Change |
|------|--------|
| `server/deploy-api/middleware.js` | NEW — Auth middleware (Bearer + scope + rate limit) |
| `server/deploy-api/rate-limiter.js` | NEW — Token bucket rate limiter (in-memory) |
| `server/deploy-api/usage.js` | NEW — SQLite usage tracker + analytics queries |
| `server/deploy-api/routes.js` | NEW — 7 deploy routes (catalog, deploy, undeploy, execute, usage) |
| `server/workflow/routes.js` | Removed old deploy/run routes (moved to deploy-api) |
| `server/runtime.js` | Wired installDeployRoutes |
| `server/db-migrate.js` | Added api_usage table + indexes |
| `client/src/panels/DeployPanel.jsx` | NEW — Deploy Dashboard panel |
| `client/src/nexus/DetailDrawer.jsx` | Added DeployPanel as 10th panel |
| `client/src/nexus/CommandCenter.jsx` | Added Deploy API widget + event style |
| `phases/PHASE-21.md` | This file |
| `README.md` | Phase 21 row, Deploy-as-API section, updated numbers |
| `CLAUDE.md` | Added deploy-api subsystem docs |

## How to Use

```bash
# Generate an API key
curl -X POST http://localhost:8787/api/access/tokens \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "scopes": "read run"}'

# Deploy a workflow
curl -X POST http://localhost:8787/api/workflows/WORKFLOW_ID/deploy \
  -H "Content-Type: application/json" \
  -d '{"slug": "my-pipeline"}'

# Call it
curl -X POST http://localhost:8787/api/run/my-pipeline \
  -H "Authorization: Bearer cf_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Generate a product description for a hoodie"}'

# Check usage
curl http://localhost:8787/api/deploy/usage/my-pipeline
```

## Known Limitations

1. Rate limiter is in-memory — resets on server restart (by design: fast, no Redis needed)
2. Usage stats are local SQLite — no external analytics export yet
3. No streaming response mode — returns full result (streaming would need SSE or WebSocket)
4. Deploy/undeploy are unauthenticated (local-only server, loopback binding)
5. No per-slug rate limit overrides yet (all keys share the same bucket config per tier)
