/**
 * Memory search — agents find what they remembered by what it means, not by an exact substring.
 *
 * Before this, `recallMemories` was `key LIKE '%query%' OR value LIKE '%query%'`: a question in a sentence
 * matched nothing, and every agent prompt carried its ten newest memories whatever the task was.
 * Now there are two arms over the same table:
 *   keyword  SQLite FTS5 with Porter stemming, ranked by bm25 — all words first, any word if that finds little
 *   vector   embeddings from the local Ollama model (nomic-embed-text), cosine in memory
 * fused by reciprocal rank and re-scored (see memory-rank.js). The vector arm is optional at every step: no
 * model, no network or a memory not yet embedded all fall back to keyword search, and the result says which
 * arms answered. Nothing is deleted or rewritten in `agent_memories`; the two indexes can be dropped and rebuilt.
 *
 * `createMemorySearch({ db, embed })` is a factory so the benchmark can run the very same code on a generated
 * corpus in a throwaway in-memory database.
 */
import { createHash } from 'node:crypto';
import { POOL, ftsQuery, fuse, cosine, contentWords, summarise, signFlipP, reciprocalRank, hitAt } from './memory-rank.js';
import { generateBench } from './memory-bench.js';

export const EMBED_MODEL = process.env.MEMORY_EMBED_MODEL || 'nomic-embed-text:latest';
const DOC_PREFIX = 'search_document: ', QUERY_PREFIX = 'search_query: ';
const textOfRow = r => `${String(r.key || '').replace(/^[a-z_]+:\d+$/i, '')} ${String(r.value || '')}`.trim().slice(0, 2000);
const hashOf = s => createHash('sha256').update(s).digest('hex').slice(0, 32);
const toBlob = v => Buffer.from(new Float32Array(v).buffer);
const fromBlob = b => new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));

export function createMemorySearch({ db, embed = null, model = EMBED_MODEL } = {}) {
  const stats = { searches: 0, keywordOnly: 0, hybrid: 0, embedErrors: 0, indexed: 0, lastIndexAt: null, lastError: null };
  let cache = { agent: undefined, stamp: null, rows: [] };

  function ensure() {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(key, value, content='agent_memories', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS agent_memories_fts_ai AFTER INSERT ON agent_memories BEGIN INSERT INTO agent_memories_fts(rowid, key, value) VALUES (new.id, new.key, new.value); END;
      CREATE TRIGGER IF NOT EXISTS agent_memories_fts_ad AFTER DELETE ON agent_memories BEGIN INSERT INTO agent_memories_fts(agent_memories_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value); END;
      CREATE TRIGGER IF NOT EXISTS agent_memories_fts_au AFTER UPDATE OF key, value ON agent_memories BEGIN INSERT INTO agent_memories_fts(agent_memories_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value); INSERT INTO agent_memories_fts(rowid, key, value) VALUES (new.id, new.key, new.value); END;
      CREATE TABLE IF NOT EXISTS agent_memory_vectors (memory_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `);
    // first run on a store that already has memories: build the keyword index from the table (the triggers keep it current afterwards)
    const have = db.prepare(`SELECT COUNT(*) n FROM agent_memories`).get().n;
    const indexed = db.prepare(`SELECT COUNT(*) n FROM agent_memories_fts_docsize`).get().n;
    if (have && indexed < have) db.exec(`INSERT INTO agent_memories_fts(agent_memories_fts) VALUES ('rebuild')`);
    return { memories: have, keywordIndexed: Math.max(indexed, have) };
  }

  const scope = (agentId, category) => { const w = [], p = []; if (agentId) { w.push('m.agent_id = ?'); p.push(agentId); } if (category) { w.push('m.category = ?'); p.push(category); } return { where: w.length ? ' AND ' + w.join(' AND ') : '', params: p }; };

  /** The old behaviour, kept as the baseline every measurement is against. */
  function likeArm(agentId, query, { category = null, pool = POOL } = {}) {
    const s = scope(agentId, category), q = `%${query}%`;
    return db.prepare(`SELECT m.id FROM agent_memories m WHERE (m.key LIKE ? OR m.value LIKE ?)${s.where} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`).all(q, q, ...s.params, pool);
  }

  function keywordArm(agentId, query, { category = null, pool = POOL } = {}) {
    const s = scope(agentId, category);
    const run = match => match ? db.prepare(`SELECT m.id, bm25(agent_memories_fts) AS bm FROM agent_memories_fts JOIN agent_memories m ON m.id = agent_memories_fts.rowid WHERE agent_memories_fts MATCH ?${s.where} ORDER BY bm LIMIT ?`).all(match, ...s.params, pool) : [];
    let rows = run(ftsQuery(query, { all: true })), mode = 'all words';
    if (rows.length < 3) { const any = run(ftsQuery(query, { all: false })); const seen = new Set(rows.map(r => r.id)); rows = [...rows, ...any.filter(r => !seen.has(r.id))].slice(0, pool); mode = rows.length ? 'any word' : 'none'; }
    return { rows, mode };
  }

  function vectorsFor(agentId) {
    const stamp = db.prepare(`SELECT COUNT(*) n, COALESCE(MAX(v.updated_at), 0) t FROM agent_memory_vectors v JOIN agent_memories m ON m.id = v.memory_id WHERE v.model = ?${agentId ? ' AND m.agent_id = ?' : ''}`).get(model, ...(agentId ? [agentId] : []));
    const key = `${stamp.n}|${stamp.t}`;
    if (cache.agent === (agentId || null) && cache.stamp === key) return cache.rows;
    const rows = db.prepare(`SELECT v.memory_id AS id, v.vec, m.category FROM agent_memory_vectors v JOIN agent_memories m ON m.id = v.memory_id WHERE v.model = ?${agentId ? ' AND m.agent_id = ?' : ''}`).all(model, ...(agentId ? [agentId] : [])).map(r => ({ id: r.id, category: r.category, vec: fromBlob(r.vec) }));
    cache = { agent: agentId || null, stamp: key, rows };
    return rows;
  }

  async function vectorArm(agentId, query, { category = null, pool = POOL } = {}) {
    if (!embed) return { rows: [], why: 'no embedding model configured' };
    const rows = vectorsFor(agentId).filter(r => !category || r.category === category);
    if (!rows.length) return { rows: [], why: 'no memory in scope has been embedded yet' };
    let q;
    try { [q] = await embed([QUERY_PREFIX + query], { kind: 'query' }); } catch (e) { stats.embedErrors++; stats.lastError = String(e.message).slice(0, 160); return { rows: [], why: `the embedding model did not answer (${String(e.message).slice(0, 60)})` }; }
    if (!q || q.length !== rows[0].vec.length) return { rows: [], why: 'the query vector does not match the stored ones' };
    const all = rows.map(r => ({ id: r.id, cos: cosine(q, r.vec) })).sort((a, b) => b.cos - a.cos);
    return { rows: all.slice(0, pool), why: null, cosOf: new Map(all.map(r => [r.id, r.cos])) };
  }

  /**
   * Search one agent's memories (or everyone's when `agentId` is null).
   * @param mode 'hybrid' (default) | 'keyword' | 'vector' | 'like'
   * @returns {{ results: [{...memory, score, arms}], arms: {keyword, vector}, mode }}
   */
  async function search(agentId, query, { limit = 10, category = null, mode = 'hybrid', touch = false } = {}) {
    const text = String(query || '').trim().slice(0, 500), lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
    stats.searches++;
    if (!text) return { results: [], arms: {}, mode };
    let ranked, arms = {};
    if (mode === 'like') { ranked = likeArm(agentId, text, { category }).slice(0, lim).map(r => ({ id: r.id, score: null, arms: 'like' })); arms.like = ranked.length; }
    else {
      const kw = mode === 'vector' ? { rows: [], mode: 'not asked' } : keywordArm(agentId, text, { category });
      const vec = mode === 'keyword' ? { rows: [], why: 'not asked' } : await vectorArm(agentId, text, { category });
      arms = { keyword: { found: kw.rows.length, matched: kw.mode }, vector: { found: vec.rows.length, note: vec.why } };
      const ids = [...new Set([...kw.rows.map(r => r.id), ...vec.rows.map(r => r.id)])];
      const texts = new Map(ids.length ? db.prepare(`SELECT id, key, value FROM agent_memories WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(r => [r.id, textOfRow(r)]) : []);
      // a keyword match is scored on meaning too: its own cosine when it has a vector, the candidates' median when it has not been embedded yet
      let known = null;
      if (vec.cosOf) { const have = ids.map(id => vec.cosOf.get(id)).filter(c => c != null).sort((a, b) => a - b); const median = have.length ? have[Math.floor(have.length / 2)] : 0; known = id => vec.cosOf.get(id) ?? median; }
      ranked = fuse(kw.rows, vec.rows, { limit: lim, textOf: id => texts.get(id) || '', cosFor: known });
      if (vec.rows.length) stats.hybrid++; else stats.keywordOnly++;
    }
    if (!ranked.length) return { results: [], arms, mode };
    const byId = new Map(db.prepare(`SELECT * FROM agent_memories WHERE id IN (${ranked.map(() => '?').join(',')})`).all(...ranked.map(r => r.id)).map(r => [r.id, r]));
    const results = ranked.filter(r => byId.has(r.id)).map(r => ({ ...byId.get(r.id), score: r.score == null ? null : +r.score.toFixed(4), cos: r.cos == null ? null : +r.cos.toFixed(4), arms: r.arms }));
    if (touch) { const up = db.prepare(`UPDATE agent_memories SET access_count = access_count + 1 WHERE id = ?`); for (const r of results) up.run(r.id); }
    return { results, arms, mode };
  }

  /** Synchronous, keyword only: for building a prompt, where nothing may wait on a model. */
  function relevantNow(agentId, text, { limit = 6, category = null } = {}) {
    const words = [...new Set(contentWords(text))].slice(0, 16).join(' ');
    if (!words) return [];
    const { rows } = keywordArm(agentId, words, { category, pool: limit * 3 });
    if (!rows.length) return [];
    const byId = new Map(db.prepare(`SELECT * FROM agent_memories WHERE id IN (${rows.map(() => '?').join(',')})`).all(...rows.map(r => r.id)).map(r => [r.id, r]));
    const kept = [], sets = [];
    for (const r of rows) { const m = byId.get(r.id); if (!m) continue; const w = new Set(contentWords(textOfRow(m))); if (sets.some(s => { let i = 0; for (const x of s) if (w.has(x)) i++; return i / (s.size + w.size - i) > 0.85; })) continue; kept.push(m); sets.push(w); if (kept.length >= limit) break; }
    return kept;
  }

  /** Embed memories that have no vector yet, or whose text changed. Small batches; safe to call often. */
  async function indexPending({ max = 96, batch = 32 } = {}) {
    if (!embed) return { indexed: 0, pending: null, note: 'no embedding model configured' };
    const rows = db.prepare(`SELECT m.id, m.key, m.value, v.content_hash FROM agent_memories m LEFT JOIN agent_memory_vectors v ON v.memory_id = m.id AND v.model = ? WHERE v.memory_id IS NULL OR v.updated_at < m.updated_at ORDER BY m.updated_at DESC LIMIT ?`).all(model, max * 3);
    const todo = rows.map(r => ({ id: r.id, text: textOfRow(r), old: r.content_hash })).map(r => ({ ...r, hash: hashOf(r.text) }));
    const up = db.prepare(`INSERT INTO agent_memory_vectors (memory_id, model, dim, vec, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec, content_hash = excluded.content_hash, updated_at = excluded.updated_at`);
    const touchOnly = db.prepare(`UPDATE agent_memory_vectors SET updated_at = ? WHERE memory_id = ?`);
    let done = 0;
    // a memory whose text did not change (only its access count or confidence did) keeps its vector
    for (const r of todo.filter(r => r.old === r.hash)) touchOnly.run(Date.now(), r.id);
    const fresh = todo.filter(r => r.old !== r.hash && r.text.length > 0).slice(0, max);
    for (let i = 0; i < fresh.length; i += batch) {
      const part = fresh.slice(i, i + batch);
      let vecs;
      try { vecs = await embed(part.map(r => DOC_PREFIX + r.text), { kind: 'document' }); } catch (e) { stats.embedErrors++; stats.lastError = String(e.message).slice(0, 160); break; }
      const now = Date.now();
      db.transaction(() => part.forEach((r, k) => { if (vecs[k]?.length) { up.run(r.id, model, vecs[k].length, toBlob(vecs[k]), r.hash, now); done++; } }))();
    }
    db.prepare(`DELETE FROM agent_memory_vectors WHERE memory_id NOT IN (SELECT id FROM agent_memories)`).run();
    stats.indexed += done; if (done) stats.lastIndexAt = Date.now();
    const pending = db.prepare(`SELECT COUNT(*) n FROM agent_memories m LEFT JOIN agent_memory_vectors v ON v.memory_id = m.id AND v.model = ? WHERE v.memory_id IS NULL`).get(model).n;
    return { indexed: done, pending };
  }

  function status() {
    const memories = db.prepare(`SELECT COUNT(*) n FROM agent_memories`).get().n;
    const vectors = db.prepare(`SELECT COUNT(*) n FROM agent_memory_vectors WHERE model = ?`).get(model).n;
    return { memories, keywordIndexed: db.prepare(`SELECT COUNT(*) n FROM agent_memories_fts_docsize`).get().n, vectors, vectorCoverage: memories ? +(vectors / memories).toFixed(3) : 0, model: embed ? model : null, ...stats };
  }

  return { ensure, search, relevantNow, likeArm, keywordArm, vectorArm, indexPending, status };
}

/**
 * Measure the three ways of searching on a generated corpus with known answers.
 * Runs in a throwaway in-memory database with the same code as production; the real store is not touched.
 * @param Database  the better-sqlite3 constructor
 * @param embed     the embedder to test with (null → keyword and LIKE only)
 */
export async function runMemoryBench({ Database, embed = null, seed = 42, memories = 300, perKind = 30, k = 5 } = {}) {
  const bench = generateBench({ seed, memories, perKind });
  const mem = new Database(':memory:');
  mem.exec(`CREATE TABLE agent_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', key TEXT NOT NULL, value TEXT NOT NULL, confidence REAL DEFAULT 1.0, source TEXT DEFAULT 'agent', access_count INTEGER DEFAULT 0, verified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  const ms = createMemorySearch({ db: mem, embed, model: 'bench' });
  ms.ensure();
  const ins = mem.prepare(`INSERT INTO agent_memories (id, agent_id, category, key, value, created_at, updated_at) VALUES (?, 'bench', 'general', ?, ?, ?, ?)`);
  mem.transaction(() => bench.memories.forEach(m => ins.run(m.id, m.key, m.value, m.id, m.id)))();
  let embedded = 0, embedSeconds = null;
  if (embed) { const t0 = Date.now(); for (;;) { const r = await ms.indexPending({ max: 128 }); embedded += r.indexed; if (!r.indexed || !r.pending) break; } embedSeconds = +((Date.now() - t0) / 1000).toFixed(1); }
  const systems = embed && embedded ? ['like', 'keyword', 'hybrid'] : ['like', 'keyword'];
  const runs = Object.fromEntries(systems.map(s => [s, []]));
  for (const q of bench.queries) for (const s of systems) { const r = await ms.search('bench', q.text, { limit: 10, mode: s }); runs[s].push({ kind: q.kind, ranked: r.results.map(x => x.id), grades: new Map(Object.entries(q.grades).map(([id, g]) => [Number(id), g])) }); }
  const overall = Object.fromEntries(systems.map(s => [s, summarise(runs[s], k)]));
  const byKind = Object.fromEntries(bench.kinds.map(kind => [kind, Object.fromEntries(systems.map(s => [s, summarise(runs[s].filter(r => r.kind === kind), k)]))]));
  const rr = s => runs[s].map(r => reciprocalRank(r.ranked, r.grades));
  const p = { keyword_vs_like: signFlipP(rr('keyword'), rr('like')) };
  if (runs.hybrid) { p.hybrid_vs_keyword = signFlipP(rr('hybrid'), rr('keyword')); p.hybrid_vs_like = signFlipP(rr('hybrid'), rr('like')); }
  // the gate: every question whose best answer a system puts first, so a later change can be checked for newly lost ones
  const firsts = Object.fromEntries(systems.map(s => [s, bench.queries.filter((q, i) => hitAt(runs[s][i].ranked, runs[s][i].grades, 1)).map(q => q.id)]));
  mem.close();
  return { seed, memories: bench.memories.length, queries: bench.queries.length, perKind, k, systems, embedded, embedSeconds, overall, byKind, p, firsts };
}
