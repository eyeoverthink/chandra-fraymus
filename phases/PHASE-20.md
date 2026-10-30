# Phase 20: Needle Worker Loop + Motor Live Dispatch

**Previous:** [Phase 19 — Hermes Full Fleet](./PHASE-19.md)
**Next:** Phase 21 (TBD)

---

## Summary

Phase 20 closes the two biggest gaps in the intelligence stack: the Needle GPU queue now has a worker loop that actually processes jobs through Ollama, and Motor dispatch now has live connections to all four compute nodes instead of just labels.

## What Shipped

### Needle Worker Loop (`server/fraymus/intelligence/needle.js`)

The NeedleQueue already had `enqueueJob`, `claimJob`, and `completeJob`. Phase 20 adds:

- **`NeedleWorker` class** — polling loop that claims queued jobs and runs them through `chatOllama()`
  - `start()` — registers as a worker, begins polling
  - `stop()` — graceful shutdown, no orphaned jobs
  - `status()` — running state, job counts, current job info
- **`failJob(jobId, error)`** — marks failed jobs with error message and timestamp
- **`getJob(jobId)`** — fetch a single job by ID
- **`listJobs(status)`** — filter jobs by status (queued/claimed/completed/failed)
- **`listWorkers()`** — list all registered workers

**Polling strategy:**
- 3s idle interval (no jobs in queue)
- 200ms busy interval (job just completed, check for more)
- 100ms initial delay on start

**Job execution flow:**
1. Poll → claim next queued job
2. Parse job params (model, system prompt, temperature, maxTokens)
3. Call `chatOllama()` with the job's model and prompt
4. On success → `completeJob()` with response, model, duration, worker ID
5. On failure → `failJob()` with error message

### Motor Live Dispatch (`server/fraymus/intelligence/motor.js`)

The MotorDispatcher had `dispatch`, `claim`, `complete`, `fail`, `listJobs`. Phase 20 adds:

- **`NODE_EXECUTORS`** — live execution functions for each compute node:
  - `WINDOWS_GPU` → Local Ollama at `127.0.0.1:11434` (inference + raw API calls)
  - `VPS_HOSTINGER` → SSH execution via `child_process.execSync` (10s connect timeout, 60s command timeout)
  - `GITHUB` → Local shell with allowlisted commands (`git`, `gh`, `npm`, `node` only)
  - `BASE44_CLOUD` → Ollama fallback for inference, entity store pointer for CRUD
- **`execute(job)`** — one-call dispatch+run: routes to node, claims, executes, completes/fails
- **`nodeHealth()`** — checks live status of all 4 nodes (Ollama API, SSH echo, git check)
- **`status()`** — dispatch count and node list

### API Routes (`server/fraymus-routes.js`)

**Needle endpoints (7):**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/fraymus/needle/enqueue` | Queue an inference job |
| GET | `/api/fraymus/needle/jobs` | List jobs (optional `?status=` filter) |
| GET | `/api/fraymus/needle/jobs/:id` | Get single job details |
| POST | `/api/fraymus/needle/worker/start` | Start the worker loop |
| POST | `/api/fraymus/needle/worker/stop` | Stop the worker loop |
| GET | `/api/fraymus/needle/worker/status` | Worker running state + stats |
| GET | `/api/fraymus/needle/workers` | List registered workers |

**Motor endpoints (5):**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/fraymus/motor/dispatch` | Queue a job (no execution) |
| POST | `/api/fraymus/motor/execute` | Dispatch + execute in one call |
| GET | `/api/fraymus/motor/jobs` | List dispatch jobs |
| GET | `/api/fraymus/motor/health` | Live node health check |
| GET | `/api/fraymus/motor/status` | Dispatch count + node list |

### Integration (`server/fraymus-tools.js`)

- `NeedleWorker` imported and instantiated with console logging callbacks
- `needleWorker` exported alongside existing `needle` and `motor`
- Master health endpoint now includes `needleWorker` and `motorDispatch` status

## Verified

- NeedleQueue: enqueue, claim, complete, fail — all pass
- NeedleWorker: start/stop lifecycle, status reporting — all pass
- NeedleWorker end-to-end: job enqueued → claimed → processed through Ollama → completed (125s cold / 358ms warm)
- Motor selectNode routing: GPU/GitHub/VPS/Cloud — all correct
- Motor WINDOWS_GPU execution: Ollama inference in 358ms
- Motor GITHUB execution: `git log` command successful
- Motor nodeHealth: WINDOWS_GPU online (39 models), GITHUB online, VPS offline (expected — no SSH keys), BASE44_CLOUD available
- Full import chain: `fraymus-tools.js` imports clean with all new exports

## Files Changed

| File | Change |
|------|--------|
| `server/fraymus/intelligence/needle.js` | Added NeedleWorker class, failJob, getJob, listJobs, listWorkers |
| `server/fraymus/intelligence/motor.js` | Added NODE_EXECUTORS, execute(), nodeHealth(), status() |
| `server/fraymus-tools.js` | Import NeedleWorker, create instance, export needleWorker |
| `server/fraymus-routes.js` | 12 new API routes (7 Needle + 5 Motor), health endpoint updated |
| `phases/PHASE-20.md` | This file |
| `README.md` | Phase 20 row added |

## Architecture After Phase 20

```
Enqueue Job ──→ NeedleQueue (SQLite) ──→ NeedleWorker polls ──→ chatOllama() ──→ Complete
                                              │
Motor Dispatch ──→ selectNode() ──→ NODE_EXECUTORS[node]
                                        ├── WINDOWS_GPU  → Ollama HTTP API
                                        ├── VPS_HOSTINGER → SSH execSync
                                        ├── GITHUB        → Allowlisted CLI
                                        └── BASE44_CLOUD  → Ollama fallback
```

## Known Limitations

1. NeedleWorker is single-threaded (one job at a time) — sufficient for RTX 3070 single-GPU
2. VPS_HOSTINGER requires SSH key setup (`ssh-copy-id root@srv1944678.hstgr.cloud`)
3. Model cold-start takes ~2 minutes; subsequent inferences are sub-second
4. Worker doesn't auto-start on server boot (call POST `/api/fraymus/needle/worker/start`)
