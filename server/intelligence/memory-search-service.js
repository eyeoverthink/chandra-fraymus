/**
 * Memory search service — the live instance over data/chandra.db, its background indexer, routes and benchmark record.
 * The search itself is in memory-search.js (a factory, so the benchmark runs the same code on a generated corpus).
 */
import Database from 'better-sqlite3';
import { db } from '../db.js';
import { OLLAMA_URL } from '../config.js';
import { withOllama } from './ollama-scheduler.js';
import { createMemorySearch, runMemoryBench, EMBED_MODEL } from './memory-search.js';

const now = () => Date.now();
const INDEX_EVERY_MS = Math.max(15_000, parseInt(process.env.MEMORY_INDEX_INTERVAL_MS, 10) || 60_000);
const INDEX_BATCH = Math.min(512, Math.max(16, parseInt(process.env.MEMORY_INDEX_BATCH, 10) || 128));
const ENABLED = process.env.MEMORY_VECTORS !== '0';

/** Embeddings from the local Ollama model, through the scheduler so a search never jumps the queue it should not. */
function embedder(priority) {
  return (texts) => withOllama(priority, async () => {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: EMBED_MODEL, input: texts }), signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`embedding model answered HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error('embedding reply had the wrong shape');
    return j.embeddings.map(e => Float32Array.from(e));
  }, { label: 'memory:embed' });
}
// a question an agent is waiting on is asked at the agent's own class; filling in the index waits behind everything
const embed = ENABLED ? (texts, { kind } = {}) => embedder(kind === 'query' ? 'agent_run' : 'background')(texts) : null;

export const memorySearch = createMemorySearch({ db, embed });
let ready = null, timer = null, indexing = false, lastIndex = null;

function ensure() {
  if (ready) return ready;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_bench_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, seed INTEGER NOT NULL, memories INTEGER, queries INTEGER, systems TEXT, overall TEXT, by_kind TEXT, p TEXT, firsts TEXT, lost TEXT, model TEXT, seconds REAL, created_at INTEGER NOT NULL)`);
  ready = memorySearch.ensure();
  return ready;
}

/** Search an agent's memories by meaning. Never throws: on any failure the answer is the keyword result, or nothing. */
export async function searchMemories(agentId, query, opts = {}) {
  try { ensure(); return await memorySearch.search(agentId, query, opts); }
  catch (e) { console.error('[memory-search]', e.message); return { results: [], arms: {}, mode: opts.mode || 'hybrid', error: e.message }; }
}
/** Synchronous keyword search for prompt building. Never throws. */
export function relevantMemories(agentId, text, opts = {}) {
  try { ensure(); return memorySearch.relevantNow(agentId, text, opts); } catch (e) { console.error('[memory-search]', e.message); return []; }
}

async function indexTick() {
  if (indexing || !embed) return lastIndex;
  indexing = true;
  try { ensure(); lastIndex = { ...(await memorySearch.indexPending({ max: INDEX_BATCH })), at: now() }; }
  catch (e) { lastIndex = { indexed: 0, error: String(e.message).slice(0, 160), at: now() }; }
  finally { indexing = false; }
  return lastIndex;
}
export function startMemoryIndexer() {
  if (timer || !embed) return { started: false, reason: embed ? 'already running' : 'vectors are switched off (MEMORY_VECTORS=0)' };
  try { ensure(); } catch (e) { console.error('[memory-search] setup:', e.message); return { started: false, reason: e.message }; }
  timer = setInterval(() => { indexTick().catch(e => console.error('[memory-search] index:', e.message)); }, INDEX_EVERY_MS);
  timer.unref?.();
  setTimeout(() => { indexTick().catch(() => {}); }, 20_000).unref?.();
  return { started: true, everyMs: INDEX_EVERY_MS, batch: INDEX_BATCH };
}
export function stopMemoryIndexer() { if (timer) clearInterval(timer); timer = null; return { stopped: true }; }

let benchRunning = false;
/** Run the benchmark with the live embedder and record it. `lost` lists questions an earlier run of the same seed got first and this one did not. */
export async function benchMemorySearch({ seed = 42 } = {}) {
  if (benchRunning) return { running: true };
  benchRunning = true; const t0 = now();
  try {
    ensure();
    const out = await runMemoryBench({ Database, embed: embed ? t => embedder('goal')(t) : null, seed });
    const best = out.systems[out.systems.length - 1];
    const prev = db.prepare(`SELECT firsts, systems FROM memory_bench_runs WHERE seed = ? ORDER BY id DESC LIMIT 1`).get(seed);
    let lost = [];
    if (prev) { try { const pf = JSON.parse(prev.firsts)[best] || []; const nowSet = new Set(out.firsts[best]); lost = pf.filter(id => !nowSet.has(id)); } catch (_) { lost = []; } }
    const seconds = +((now() - t0) / 1000).toFixed(1);
    db.prepare(`INSERT INTO memory_bench_runs (seed, memories, queries, systems, overall, by_kind, p, firsts, lost, model, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(seed, out.memories, out.queries, JSON.stringify(out.systems), JSON.stringify(out.overall), JSON.stringify(out.byKind), JSON.stringify(out.p), JSON.stringify(out.firsts), JSON.stringify(lost), embed ? EMBED_MODEL : null, seconds, now());
    return { ...out, firsts: undefined, best, lost, gate: lost.length ? `${lost.length} questions the previous run answered first are no longer first` : prev ? 'no question was lost since the previous run' : 'first run for this seed: nothing to compare with', seconds };
  } finally { benchRunning = false; }
}

export function memorySearchStatus() {
  try {
    ensure();
    const last = db.prepare(`SELECT seed, systems, overall, p, lost, model, seconds, created_at FROM memory_bench_runs ORDER BY id DESC LIMIT 1`).get();
    return { ...memorySearch.status(), vectorsEnabled: !!embed, indexer: { running: !!timer, busy: indexing, everyMs: INDEX_EVERY_MS, batch: INDEX_BATCH, last: lastIndex },
      lastBench: last ? { seed: last.seed, systems: JSON.parse(last.systems), overall: JSON.parse(last.overall), p: JSON.parse(last.p), lost: JSON.parse(last.lost || '[]'), model: last.model, seconds: last.seconds, at: last.created_at } : null };
  } catch (e) { return { error: e.message }; }
}

export function installMemorySearchRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/memory-search', route((_req, res) => res.json(memorySearchStatus())));
  app.get('/api/intelligence/memory-search/query', route(async (req, res) => {
    const q = String(req.query.q || '').slice(0, 500);
    if (!q.trim()) return res.status(400).json({ error: 'q is required' });
    const mode = ['hybrid', 'keyword', 'vector', 'like'].includes(req.query.mode) ? req.query.mode : 'hybrid';
    const out = await searchMemories(req.query.agent ? String(req.query.agent).slice(0, 80) : null, q, { mode, limit: Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10)), category: req.query.category ? String(req.query.category).slice(0, 50) : null });
    res.json({ query: q, ...out, results: out.results.map(r => ({ id: r.id, agent: r.agent_id, category: r.category, key: r.key, value: String(r.value).slice(0, 400), score: r.score, cos: r.cos, arms: r.arms })) });
  }));
  app.post('/api/intelligence/memory-search/index', route(async (_req, res) => res.json(await indexTick() || { indexed: 0, note: 'vectors are switched off' })));
  app.post('/api/intelligence/memory-search/bench', route(async (req, res) => {
    const seed = Math.min(1_000_000, Math.max(1, parseInt(req.body?.seed, 10) || 42));
    res.json(await benchMemorySearch({ seed }));
  }));
  app.get('/api/intelligence/memory-search/bench', route((req, res) => {
    ensure();
    const rows = db.prepare(`SELECT id, seed, memories, queries, systems, overall, p, lost, model, seconds, created_at FROM memory_bench_runs ORDER BY id DESC LIMIT ?`).all(Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10)));
    res.json({ runs: rows.map(r => ({ ...r, systems: JSON.parse(r.systems), overall: JSON.parse(r.overall), p: JSON.parse(r.p), lost: JSON.parse(r.lost || '[]') })) });
  }));
}
