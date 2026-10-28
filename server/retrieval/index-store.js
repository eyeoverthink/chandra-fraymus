import { createHash } from 'node:crypto';
import { fail, stableJson } from '../agent/schema.js';
import { encodeVectors, decodeVectors } from './vector-codec.js';

const MAX_INDEXES = 32, MAX_VECTOR_BYTES = 64 * 1024 * 1024, MAX_CHUNKS = 1024;
const MAX_DIMENSIONS = 4096, MAX_BATCH = 32, MAX_METADATA_CHARS = 262144;
const IDENTITY_KEYS = ['provider', 'model', 'digest', 'documentPrefix', 'queryPrefix'];
const SPEC_KEYS = ['assetId', 'sourceHash', 'scopeKey', 'identity', 'chunkPolicy', 'chunks'];
const DESCRIPTOR_KEYS = ['ordinal', 'start', 'end', 'textHash'];
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hexHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value, max, empty = false) => typeof value === 'string' && value.isWellFormed() && !value.includes('\0') && (empty || value.length > 0) && value.length <= max;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const clone = value => JSON.parse(JSON.stringify(value));

function identity(value, code = 'semantic_index_arguments') {
  if (!exact(value, IDENTITY_KEYS) || value.provider !== 'ollama' || !text(value.model, 200)
    || !/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(value.model) || /:cloud$/i.test(value.model) || !hexHash(value.digest)
    || !['documentPrefix', 'queryPrefix'].every(key => text(value[key], 256, true) && Buffer.byteLength(value[key], 'utf8') <= 256)) {
    fail(code, 'An exact local embedding identity with SHA-256 digest and bounded prefixes is required');
  }
  return Object.fromEntries(IDENTITY_KEYS.map(key => [key, value[key]]));
}

function policy(value, code, depth = 0) {
  if (depth > 8) fail(code, 'Chunk policy metadata is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && text(value, 4096, true)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (Array.isArray(value) && value.length <= 256) {
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail(code, 'Chunk policy arrays must be dense');
    return value.map(item => policy(item, code, depth + 1));
  }
  if (plain(value) && Object.keys(value).length <= 64) return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (!text(key, 128) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail(code, 'Chunk policy keys are invalid');
    return [key, policy(value[key], code, depth + 1)];
  }));
  fail(code, 'Chunk policy must contain only bounded JSON metadata');
}

function specification(value, code = 'semantic_index_arguments') {
  if (!exact(value, SPEC_KEYS) || !text(value.assetId, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.assetId)
    || !hexHash(value.sourceHash) || !text(value.scopeKey, 512) || /[\x00-\x1f\x7f]/.test(value.scopeKey)) fail(code, 'Exact source, scope and index metadata are required');
  if (!Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > MAX_CHUNKS) fail(code, 'An index requires 1–1024 chunk descriptors');
  const chunks = [];
  for (let ordinal = 0; ordinal < value.chunks.length; ordinal++) {
    const chunk = value.chunks[ordinal];
    if (!exact(chunk, DESCRIPTOR_KEYS) || chunk.ordinal !== ordinal || !integer(chunk.start) || !integer(chunk.end, 1) || chunk.start >= chunk.end || !hexHash(chunk.textHash)) fail(code, 'Chunk descriptors must be dense zero-based ordinals with exact positive spans and text hashes');
    chunks.push({ ordinal, start: chunk.start, end: chunk.end, textHash: chunk.textHash });
  }
  if (value.chunkPolicy === undefined || value.chunkPolicy === null) fail(code, 'An explicit chunk policy is required');
  const chunkPolicy = policy(value.chunkPolicy, code);
  if (stableJson(chunkPolicy).length > 16384) fail(code, 'Chunk policy metadata exceeds its bound');
  const spec = { assetId: value.assetId, sourceHash: value.sourceHash, scopeKey: value.scopeKey, identity: identity(value.identity, code), chunkPolicy, chunks };
  const json = stableJson({ kind: 'semantic-index-v1', spec });
  if (json.length > MAX_METADATA_CHARS) fail(code, 'Index metadata exceeds its bound');
  return { spec, json, id: sha256(json) };
}

function transaction(db, work, readOnly = false) {
  if (typeof db.transaction === 'function') return readOnly ? db.transaction(work).deferred() : db.transaction(work).immediate();
  db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (caught) { db.exec('ROLLBACK'); throw caught; }
}

/** Derived vectors only. Source authorization and current text/hash checks belong
 * to the caller before every ensure/get/query; this is not an authorization API. */
export function createSemanticIndexStore({ db, maxIndexes = MAX_INDEXES, maxVectorBytes = MAX_VECTOR_BYTES } = {}) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function'
    || !integer(maxIndexes, 1, MAX_INDEXES) || !integer(maxVectorBytes, 1, MAX_VECTOR_BYTES)) fail('semantic_index_configuration', 'A SQLite database and bounded index/blob limits are required');
  db.exec(`CREATE TABLE IF NOT EXISTS semantic_indexes (
    id TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, total_chunks INTEGER NOT NULL,
    stored_chunks INTEGER NOT NULL DEFAULT 0, dimensions INTEGER, vector_bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS semantic_index_chunks (
    index_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    text_hash TEXT NOT NULL, vector_blob BLOB, vector_hash TEXT, dimensions INTEGER, vector_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(index_id,ordinal), FOREIGN KEY(index_id) REFERENCES semantic_indexes(id) ON DELETE CASCADE
  );`);

  function validId(id) { if (!hexHash(id)) fail('semantic_index_arguments', 'A full semantic index ID is required'); }
  function read(id) {
    validId(id);
    const row = db.prepare(`SELECT id, CASE WHEN length(metadata_json)<=${MAX_METADATA_CHARS} THEN metadata_json ELSE NULL END AS metadata_json,
      total_chunks,stored_chunks,dimensions,vector_bytes,created_at,updated_at FROM semantic_indexes WHERE id=?`).get(id);
    if (!row) return null;
    const corrupt = message => fail('semantic_index_corrupt', message);
    let parsed;
    try { parsed = JSON.parse(row.metadata_json); } catch { corrupt('Stored semantic index metadata is invalid JSON'); }
    if (!exact(parsed, ['kind', 'spec']) || parsed.kind !== 'semantic-index-v1') corrupt('Stored semantic index metadata has an invalid version');
    const canonical = specification(parsed.spec, 'semantic_index_corrupt');
    if (canonical.id !== row.id || canonical.json !== row.metadata_json || row.total_chunks !== canonical.spec.chunks.length) corrupt('Stored source, scope, identity, chunk policy or descriptors do not match the index ID');
    if (!integer(row.stored_chunks, 0, row.total_chunks) || !integer(row.vector_bytes, 0, MAX_VECTOR_BYTES)
      || !(row.dimensions === null || integer(row.dimensions, 1, MAX_DIMENSIONS))) corrupt('Stored semantic index counters or dimensions are invalid');
    const rows = db.prepare(`SELECT ordinal,start_offset,end_offset,text_hash,vector_hash,dimensions,vector_bytes,
      typeof(vector_blob) AS blob_type,length(vector_blob) AS actual_bytes FROM semantic_index_chunks WHERE index_id=? ORDER BY ordinal`).all(id);
    if (rows.length !== row.total_chunks) corrupt('Stored chunk count does not match the index descriptors');
    const vectors = [], blobs = new Map(), missing = [];
    let storedChunks = 0, vectorBytes = 0;
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      const chunk = rows[ordinal], descriptor = canonical.spec.chunks[ordinal];
      if (chunk.ordinal !== ordinal || chunk.start_offset !== descriptor.start || chunk.end_offset !== descriptor.end || chunk.text_hash !== descriptor.textHash) corrupt('Stored chunk offsets, hash or ordinal do not match the source descriptor');
      if (chunk.blob_type === 'null') {
        if (chunk.vector_hash !== null || chunk.dimensions !== null || chunk.vector_bytes !== 0 || chunk.actual_bytes !== null) corrupt('A missing vector has inconsistent stored metadata');
        missing.push(descriptor); continue;
      }
      if (chunk.blob_type !== 'blob' || !integer(chunk.dimensions, 1, MAX_DIMENSIONS) || chunk.dimensions !== row.dimensions
        || chunk.actual_bytes !== 64 + chunk.dimensions * 4 || chunk.vector_bytes !== chunk.actual_bytes || !hexHash(chunk.vector_hash)) corrupt('Stored vector dimensions, byte count or hash metadata is invalid');
      const blob = Buffer.from(db.prepare('SELECT vector_blob FROM semantic_index_chunks WHERE index_id=? AND ordinal=?').get(id, ordinal).vector_blob);
      if (blob.byteLength !== chunk.actual_bytes || sha256(blob) !== chunk.vector_hash) corrupt('Stored vector blob hash or extent does not match');
      let decoded;
      try { decoded = decodeVectors(blob); } catch { corrupt('Stored vector framing or payload is corrupt'); }
      if (decoded.format !== 'float32' || decoded.count !== 1 || decoded.dimensions !== row.dimensions || decoded.totalBytes !== blob.byteLength
        || !Array.isArray(decoded.vectors) || decoded.vectors.length !== 1 || !(decoded.vectors[0] instanceof Float32Array)
        || decoded.vectors[0].length !== row.dimensions || !decoded.vectors[0].every(Number.isFinite)) corrupt('Stored vector decoded format/count/dimensions are inconsistent');
      storedChunks++; vectorBytes += blob.byteLength; blobs.set(ordinal, blob);
      vectors.push({ ...descriptor, vector: decoded.vectors[0] });
    }
    if (storedChunks !== row.stored_chunks || vectorBytes !== row.vector_bytes || (storedChunks === 0) !== (row.dimensions === null)) corrupt('Stored index counters do not match its vector rows');
    return { spec: canonical.spec, row, vectors, blobs, missing };
  }
  function required(id) { const value = read(id); if (!value) fail('semantic_index_not_found', 'Semantic index does not exist'); return value; }
  function publicIndex(value) {
    const { spec, row } = value;
    return { id: row.id, assetId: spec.assetId, sourceHash: spec.sourceHash, scopeKey: spec.scopeKey, identity: clone(spec.identity), chunkPolicy: clone(spec.chunkPolicy),
      complete: row.stored_chunks === row.total_chunks, storedChunks: row.stored_chunks, totalChunks: row.total_chunks,
      dimensions: row.dimensions, vectorBytes: row.vector_bytes, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function ensure(input) {
    const canonical = specification(input);
    return transaction(db, () => {
      const existing = read(canonical.id);
      if (existing) {
        if (stableJson(existing.spec) !== stableJson(canonical.spec)) fail('semantic_index_conflict', 'Index metadata differs from the existing derived cache');
        return publicIndex(existing);
      }
      const count = db.prepare('SELECT count(*) AS n FROM semantic_indexes').get().n;
      if (!integer(count) || count >= maxIndexes) fail('semantic_index_capacity', 'Derived semantic index count is at capacity; explicitly remove an authorized cache first');
      const stamp = Date.now();
      db.prepare('INSERT INTO semantic_indexes(id,metadata_json,total_chunks,created_at,updated_at) VALUES(?,?,?,?,?)').run(canonical.id, canonical.json, canonical.spec.chunks.length, stamp, stamp);
      const insert = db.prepare('INSERT INTO semantic_index_chunks(index_id,ordinal,start_offset,end_offset,text_hash) VALUES(?,?,?,?,?)');
      for (const descriptor of canonical.spec.chunks) insert.run(canonical.id, descriptor.ordinal, descriptor.start, descriptor.end, descriptor.textHash);
      return publicIndex(required(canonical.id));
    });
  }
  function get(id) { return transaction(db, () => { const value = read(id); return value ? publicIndex(value) : null; }, true); }
  function pending(id, limit = MAX_BATCH) {
    if (!integer(limit, 1, MAX_BATCH)) fail('semantic_index_arguments', 'Pending descriptor limit must be 1–32');
    return transaction(db, () => required(id).missing.slice(0, limit).map(descriptor => ({ ...descriptor })), true);
  }
  function put(id, entries, expectedIdentity) {
    const suppliedIdentity = identity(expectedIdentity);
    if (!Array.isArray(entries) || entries.length > MAX_BATCH) fail('semantic_index_arguments', 'A vector write batch must contain at most 32 entries');
    return transaction(db, () => {
      const value = required(id);
      if (stableJson(value.spec.identity) !== stableJson(suppliedIdentity)) fail('semantic_index_identity', 'Embedding identity does not exactly match this index');
      const seen = new Set(), additions = [];
      let dimensions = value.row.dimensions, addedBytes = 0;
      for (const entry of entries) {
        if (!exact(entry, ['ordinal', 'vector']) || !integer(entry.ordinal, 0, value.row.total_chunks - 1) || seen.has(entry.ordinal)
          || !(entry.vector instanceof Float32Array) || !integer(entry.vector.length, 1, MAX_DIMENSIONS)) fail('semantic_index_arguments', 'Each entry requires a unique known ordinal and a bounded Float32Array');
        seen.add(entry.ordinal);
        const vector = new Float32Array(entry.vector);
        if (!vector.every(Number.isFinite)) fail('semantic_index_arguments', 'Vector components must all be finite float32 values');
        if (dimensions !== null && vector.length !== dimensions) fail('semantic_index_conflict', 'All vectors in an index must have the same dimensions');
        dimensions = vector.length;
        const encoded = encodeVectors([vector], { format: 'float32' });
        if (!Buffer.isBuffer(encoded.data) || encoded.format !== 'float32' || encoded.count !== 1 || encoded.dimensions !== dimensions || encoded.totalBytes !== encoded.data.byteLength) fail('semantic_index_corrupt', 'The vector encoder returned inconsistent float32 metadata');
        const previous = value.blobs.get(entry.ordinal);
        if (previous) {
          if (!previous.equals(encoded.data)) fail('semantic_index_conflict', 'An existing chunk vector has different bytes; it cannot be silently replaced');
        } else { additions.push({ ordinal: entry.ordinal, blob: encoded.data, hash: sha256(encoded.data) }); addedBytes += encoded.data.byteLength; }
      }
      if (!additions.length) return publicIndex(value);
      const used = db.prepare('SELECT COALESCE(sum(length(vector_blob)),0) AS n FROM semantic_index_chunks').get().n;
      if (!integer(used) || used + addedBytes > maxVectorBytes) fail('semantic_index_capacity', 'Derived semantic vector blob bytes are at capacity; no vectors were written');
      const update = db.prepare('UPDATE semantic_index_chunks SET vector_blob=?,vector_hash=?,dimensions=?,vector_bytes=? WHERE index_id=? AND ordinal=? AND vector_blob IS NULL');
      for (const addition of additions) {
        const changed = update.run(addition.blob, addition.hash, dimensions, addition.blob.byteLength, id, addition.ordinal).changes;
        if (Number(changed) !== 1) fail('semantic_index_conflict', 'A pending vector changed during its atomic write');
      }
      db.prepare('UPDATE semantic_indexes SET stored_chunks=?,dimensions=?,vector_bytes=?,updated_at=? WHERE id=?')
        .run(value.row.stored_chunks + additions.length, dimensions, value.row.vector_bytes + addedBytes, Date.now(), id);
      return publicIndex(required(id));
    });
  }
  function vectors(id) {
    return transaction(db, () => {
      const value = required(id);
      if (value.row.stored_chunks !== value.row.total_chunks) fail('semantic_index_incomplete', 'Semantic index is incomplete; querying partial vectors is forbidden');
      return value.vectors;
    }, true);
  }
  function remove(id) {
    validId(id);
    return transaction(db, () => {
      db.prepare('DELETE FROM semantic_index_chunks WHERE index_id=?').run(id);
      return Number(db.prepare('DELETE FROM semantic_indexes WHERE id=?').run(id).changes) === 1;
    });
  }
  return { ensure, get, pending, put, vectors, remove };
}
