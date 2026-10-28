// Vertiso Memory System — Vector-similarity episodic/semantic memory for all agents
// Uses Ollama embeddings for semantic search, SQLite for persistence, orbital decay for relevance
import { randomUUID } from 'node:crypto';
import { OLLAMA_URL } from '../config.js';

const MAX_MEMORIES = 10_000;
const EMBEDDING_DIM = 768;
const CONSOLIDATION_THRESHOLD = 0.92;
const DECAY_HALF_LIFE = 7 * 86_400_000; // 7 days in ms

export class VertisoMemory {
  constructor({ db, ollamaUrl, model = 'nomic-embed-text:latest' }) {
    this.db = db;
    this.ollamaUrl = ollamaUrl || OLLAMA_URL;
    this.model = model;
    this.cache = new Map(); // id -> Float32Array
    this._ensureTable();
  }

  _ensureTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vertiso_memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        namespace TEXT NOT NULL DEFAULT 'global',
        content TEXT NOT NULL,
        summary TEXT,
        embedding BLOB,
        importance REAL DEFAULT 0.5,
        access_count INTEGER DEFAULT 0,
        last_accessed INTEGER,
        associations TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vertiso_agent ON vertiso_memories(agent_id, namespace);
      CREATE INDEX IF NOT EXISTS idx_vertiso_importance ON vertiso_memories(importance DESC);

      CREATE TABLE IF NOT EXISTS vertiso_consolidations (
        id TEXT PRIMARY KEY,
        source_ids TEXT NOT NULL,
        merged_content TEXT NOT NULL,
        embedding BLOB,
        agent_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vertiso_consol ON vertiso_consolidations(agent_id);

      CREATE TABLE IF NOT EXISTS vertiso_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async embed(text) {
    const prefixed = 'search_document: ' + text;
    try {
      const res = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: [prefixed], truncate: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.embeddings?.[0]) return null;
      const vec = new Float32Array(data.embeddings[0]);
      // L2 normalize
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    } catch {
      return null;
    }
  }

  async embedQuery(text) {
    const prefixed = 'search_query: ' + text;
    try {
      const res = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: [prefixed], truncate: false }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.embeddings?.[0]) return null;
      const vec = new Float32Array(data.embeddings[0]);
      let norm = 0;
      for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
      return vec;
    } catch {
      return null;
    }
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot; // already normalized
  }

  decayScore(createdAt, accessCount, importance) {
    const age = Date.now() - createdAt;
    const decay = Math.exp(-0.693 * age / DECAY_HALF_LIFE);
    const accessBoost = Math.log2(1 + accessCount) * 0.1;
    return (importance + accessBoost) * decay;
  }

  async store({ agentId, content, namespace = 'global', importance = 0.5, metadata = {}, associations = [] }) {
    const id = randomUUID();
    const now = Date.now();
    const embedding = await this.embed(content);
    const summary = content.length > 200 ? content.slice(0, 200) + '...' : content;

    this.db.prepare(`INSERT INTO vertiso_memories
      (id, agent_id, namespace, content, summary, embedding, importance, access_count, last_accessed, associations, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`).run(
      id, agentId, namespace, content, summary,
      embedding ? Buffer.from(embedding.buffer) : null,
      Math.max(0, Math.min(1, importance)),
      now, JSON.stringify(associations), JSON.stringify(metadata), now, now
    );

    if (embedding) this.cache.set(id, embedding);
    this._enforceLimit(agentId, namespace);
    return { id, stored: true, hasEmbedding: !!embedding };
  }

  async recall({ agentId, query, namespace = 'global', limit = 5, minSimilarity = 0.3 }) {
    const queryVec = await this.embedQuery(query);
    const rows = this.db.prepare(
      'SELECT id, agent_id, content, summary, embedding, importance, access_count, created_at FROM vertiso_memories WHERE agent_id = ? AND namespace = ?'
    ).all(agentId, namespace);

    const scored = [];
    for (const row of rows) {
      let similarity = 0;
      if (queryVec && row.embedding) {
        let memVec = this.cache.get(row.id);
        if (!memVec) {
          memVec = new Float32Array(new Uint8Array(row.embedding).buffer);
          this.cache.set(row.id, memVec);
        }
        similarity = this.cosineSimilarity(queryVec, memVec);
      }
      const decay = this.decayScore(row.created_at, row.access_count, row.importance);
      const finalScore = similarity * 0.7 + decay * 0.3;
      if (similarity >= minSimilarity || !queryVec) {
        scored.push({ ...row, similarity, decay, score: finalScore, embedding: undefined });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit);

    // Update access counts
    const now = Date.now();
    const update = this.db.prepare('UPDATE vertiso_memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?');
    for (const r of results) update.run(now, r.id);

    return results.map(r => ({
      id: r.id, content: r.content, summary: r.summary,
      similarity: +r.similarity.toFixed(4), decay: +r.decay.toFixed(4),
      score: +r.score.toFixed(4), importance: r.importance,
      accessCount: r.access_count + 1,
    }));
  }

  async recallGlobal({ query, limit = 5, minSimilarity = 0.3 }) {
    const queryVec = await this.embedQuery(query);
    const rows = this.db.prepare(
      'SELECT id, agent_id, namespace, content, summary, embedding, importance, access_count, created_at FROM vertiso_memories'
    ).all();

    const scored = [];
    for (const row of rows) {
      let similarity = 0;
      if (queryVec && row.embedding) {
        let memVec = this.cache.get(row.id);
        if (!memVec) {
          memVec = new Float32Array(new Uint8Array(row.embedding).buffer);
          this.cache.set(row.id, memVec);
        }
        similarity = this.cosineSimilarity(queryVec, memVec);
      }
      const decay = this.decayScore(row.created_at, row.access_count, row.importance);
      if (similarity >= minSimilarity || !queryVec) {
        scored.push({ ...row, similarity, score: similarity * 0.7 + decay * 0.3, embedding: undefined });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(r => ({
      id: r.id, agentId: r.agent_id, namespace: r.namespace,
      content: r.content, similarity: +r.similarity.toFixed(4),
      score: +r.score.toFixed(4),
    }));
  }

  async consolidate(agentId, namespace = 'global') {
    const rows = this.db.prepare(
      'SELECT id, content, embedding, importance FROM vertiso_memories WHERE agent_id = ? AND namespace = ? ORDER BY created_at DESC LIMIT 200'
    ).all(agentId, namespace);

    const pairs = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        if (!rows[i].embedding || !rows[j].embedding) continue;
        let vecA = this.cache.get(rows[i].id);
        if (!vecA) { vecA = new Float32Array(new Uint8Array(rows[i].embedding).buffer); this.cache.set(rows[i].id, vecA); }
        let vecB = this.cache.get(rows[j].id);
        if (!vecB) { vecB = new Float32Array(new Uint8Array(rows[j].embedding).buffer); this.cache.set(rows[j].id, vecB); }
        const sim = this.cosineSimilarity(vecA, vecB);
        if (sim >= CONSOLIDATION_THRESHOLD) {
          pairs.push({ a: rows[i], b: rows[j], similarity: sim });
        }
      }
    }

    let merged = 0;
    for (const pair of pairs.slice(0, 10)) {
      const mergedContent = `[Consolidated] ${pair.a.content}\n---\n${pair.b.content}`;
      const mergedEmb = await this.embed(mergedContent);
      const id = randomUUID();
      const now = Date.now();
      this.db.prepare(`INSERT INTO vertiso_consolidations (id, source_ids, merged_content, embedding, agent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        id, JSON.stringify([pair.a.id, pair.b.id]), mergedContent,
        mergedEmb ? Buffer.from(mergedEmb.buffer) : null, agentId, now
      );
      // Reduce importance of source memories
      this.db.prepare('UPDATE vertiso_memories SET importance = importance * 0.5 WHERE id IN (?, ?)').run(pair.a.id, pair.b.id);
      merged++;
    }
    return { consolidated: merged, candidatePairs: pairs.length };
  }

  forget(id) {
    const r = this.db.prepare('DELETE FROM vertiso_memories WHERE id = ?').run(id);
    this.cache.delete(id);
    return { deleted: r.changes > 0 };
  }

  stats(agentId) {
    const total = this.db.prepare('SELECT COUNT(*) as n FROM vertiso_memories WHERE agent_id = ?').get(agentId);
    const byNs = this.db.prepare('SELECT namespace, COUNT(*) as n FROM vertiso_memories WHERE agent_id = ? GROUP BY namespace').all(agentId);
    const avgImportance = this.db.prepare('SELECT AVG(importance) as avg FROM vertiso_memories WHERE agent_id = ?').get(agentId);
    const consolidations = this.db.prepare('SELECT COUNT(*) as n FROM vertiso_consolidations WHERE agent_id = ?').get(agentId);
    return {
      totalMemories: total.n,
      byNamespace: Object.fromEntries(byNs.map(r => [r.namespace, r.n])),
      avgImportance: +(avgImportance.avg || 0).toFixed(4),
      consolidations: consolidations.n,
      cacheSize: this.cache.size,
    };
  }

  allStats() {
    const total = this.db.prepare('SELECT COUNT(*) as n FROM vertiso_memories').get();
    const byAgent = this.db.prepare('SELECT agent_id, COUNT(*) as n FROM vertiso_memories GROUP BY agent_id').all();
    const consolidations = this.db.prepare('SELECT COUNT(*) as n FROM vertiso_consolidations').get();
    return {
      totalMemories: total.n,
      byAgent: Object.fromEntries(byAgent.map(r => [r.agent_id, r.n])),
      totalConsolidations: consolidations.n,
      cacheSize: this.cache.size,
    };
  }

  _enforceLimit(agentId, namespace) {
    const count = this.db.prepare('SELECT COUNT(*) as n FROM vertiso_memories WHERE agent_id = ? AND namespace = ?').get(agentId, namespace);
    if (count.n > MAX_MEMORIES) {
      const excess = count.n - MAX_MEMORIES;
      const ids = this.db.prepare(
        'SELECT id FROM vertiso_memories WHERE agent_id = ? AND namespace = ? ORDER BY importance ASC, access_count ASC, created_at ASC LIMIT ?'
      ).all(agentId, namespace, excess);
      const del = this.db.prepare('DELETE FROM vertiso_memories WHERE id = ?');
      for (const { id } of ids) { del.run(id); this.cache.delete(id); }
    }
  }
}
