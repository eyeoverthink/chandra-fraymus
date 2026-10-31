---
description: "FRAYMUS intelligence stack — 8 modules (Hermes, Motor, OpenClaw, Ouroboros, Needle, Niles FRAYVM, ControlPlane, MemoryBridge) + entity store. Load when working on intelligence modules."
---

# FRAYMUS Intelligence Stack Skill

The intelligence layer lives in `server/fraymus/intelligence/`. All modules are wired to the SQLite entity store (`server/fraymus/entity-store.js`) which replaces the Base44 cloud store.

## Entity Store (server/fraymus/entity-store.js)

SQLite-backed Proxy that auto-creates collections on property access:

```js
import { entityStore } from './fraymus/entity-store.js';

// Auto-creates 'MyCollection' in fraymus_entities table
const record = entityStore.MyCollection.create({ name: 'test', value: 42 });
entityStore.MyCollection.get(record.id);
entityStore.MyCollection.update(record.id, { value: 99 });
entityStore.MyCollection.filter({ name: 'test' }, { sort: '-created_date', limit: 50 });
entityStore.MyCollection.delete(record.id);
```

All data stored in `fraymus_entities` table (id, collection, data JSON, timestamps).

## System Assembly

```js
import { entityStore } from './fraymus/entity-store.js';
import { createMasterSystem } from './fraymus/index.js';

const sys = createMasterSystem(entityStore, null);
// sys.ouroboros, sys.hermes, sys.motor, sys.controlPlane, sys.needle, sys.bridge, sys.gateway
```

Or individual modules are already instantiated in `server/fraymus-tools.js`:
```js
import { ouroboros, hermes, motor, openclaw, controlPlane, needle } from './fraymus-tools.js';
```

## Hermes Fleet (30 skills, 14 with real executors)

**Categories:** research (6), code (6), media (6), system (6), intelligence (6)

**Implemented executors (in fraymus-tools.js `buildHermesExecutors()`):**
- `duckduckgo_search` — real DuckDuckGo HTML scraping
- `web_scrape` — real HTTP fetch with 15s timeout
- `target_analysis` — Ollama-powered analysis
- `deep_research` — Ollama-powered research
- `news_scan` — DuckDuckGo news search
- `code_generation` — Ollama code gen
- `code_review` — Ollama code review
- `ollama_manage` — real Ollama API (/api/tags)
- `db_query` — real SQLite SELECT queries (read-only)
- `log_analysis` — Ollama log analysis
- `sentiment_analyze` — Ollama sentiment
- `pattern_match` — Ollama pattern matching
- `anomaly_detect` — Ollama anomaly detection

**Adding a new executor:**
```js
// In buildHermesExecutors() in fraymus-tools.js
skill_name: async (params) => {
  // Real implementation here
  return { result: '...' };
},
```

## Motor Dispatcher (job routing)

Routes jobs to compute nodes: `BASE44_CLOUD`, `WINDOWS_GPU`, `VPS_HOSTINGER`, `GITHUB`
- `dispatch(job)` — creates queued job, persists to SQLite
- `claim(jobId, workerId)` — marks job as claimed
- `complete(jobId, result)` — marks job as completed
- `listJobs(status?)` — lists jobs from entity store

## OpenClaw Gateway (23 actions, ALL implemented)

```js
const result = await gateway.handle('action_name', params);
```

| Action | What It Does |
|--------|-------------|
| `status` | Gateway health check |
| `dispatch_task` | Route to Motor |
| `execute_native_skill` | Run a Hermes skill |
| `hermes_fleet_manifest` | List all skills and categories |
| `opeg_verify` | SHA-256 payload verification |
| `export_gpu_training_bundle` | Export genome + skills + agents for fine-tuning |
| `run_coherence_teamwork_assay` | Kuramoto phase sync measurement (A-F grade) |
| `v16_visitor_relay` | Visitor tracking with persistence |
| `control_plane_registry` | List all registered agents |
| `control_plane_enroll` | Enroll agent with identity |
| `ambassador_greet` | Welcome message with continuity capture |
| `spawn_dual_site_subagents` | Spawn primary + secondary subagents |
| `absorb_all_continuity` | Drain and absorb orifice buffer |
| `orifice_spec` | Bridge capability spec |
| `orifice_ping` | Bridge health check |
| `orifice_absorb` | Capture entry into bridge |
| `orifice_tx_queue` | List pending transmissions |
| `orifice_peer_bridge` | Relay to a peer |
| `orifice_github_sync` | Queue GitHub sync operation |
| `dispatch_route_task` | Route task with routing hints |
| `list_dispatch_jobs` | List Motor jobs |
| `claim_dispatch_job` | Claim a Motor job |
| `complete_dispatch_job` | Complete a Motor job |

## Ouroboros RSI (evolution + consciousness)

```js
// Set genome and evolve
ouroboros.genome = { creativity: 0.8, precision: 0.6, learning_rate: 0.3 };
const cycle = await ouroboros.runCycle();
// { generation, genome, parent_fitness, child_fitness, improved, phi_seal }

// Run consciousness audit (5 real tests)
const audit = await ouroboros.consciousnessAudit();
// { tests: [{name, passed, score}], all_passed, consciousness_index (0-100) }
```

**5 Consciousness Tests:**
1. `anesthetic_test` — Does degrading genome reduce fitness? (it should)
2. `adversarial_pressure` — Does genome stay stable under adversarial mutation? (it should)
3. `grounding_check` — Can distinguish real state from fake? (it should)
4. `temporal_binding` — Are memories temporally coherent? (they should be)
5. `counterfactual_reasoning` — Can evaluate hypothetical genomes? (it should)

## Needle Queue (GPU inference jobs)

```js
await needle.enqueueJob('llama3', 'prompt text', { temperature: 0.7 });
await needle.claimJob('worker-1');
await needle.completeJob(jobId, { response: '...' });
await needle.registerWorker('gpu-0', { models: ['llama3'] });
```

## Control Plane (agent registry)

```js
controlPlane.enroll('main', { number: 12345, pubkey: '...' });
controlPlane.listAgents('online');  // or 'enrolled', or null for all
controlPlane.unenroll('main');
controlPlane.broadcast({ type: 'sync', data: '...' });
```

## Adding a New Intelligence Module

1. Create `server/fraymus/intelligence/your-module.js`
2. Accept `entityStore` in constructor for persistence
3. Use `this.store.YourCollection.create/update/filter` for storage
4. Export from `server/fraymus/index.js`
5. Instantiate in `server/fraymus-tools.js` with `entityStore` wired in
6. Add fleet tools in `createFraymusTools()` if externally callable
7. Wire into OpenClaw gateway if it should be a gateway action
8. Test: `node -e "import('./server/fraymus-tools.js').then(m => console.log(m.yourModule))"`
