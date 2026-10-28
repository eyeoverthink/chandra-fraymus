import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createSemanticIndexStore } from '../server/retrieval/index-store.js';
import { encodeVectors } from '../server/retrieval/vector-codec.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const modelIdentity = () => ({ provider: 'ollama', model: 'nomic-embed-text:latest', digest: hash('immutable-model-v1'), documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' });
const specification = (count = 3) => ({ assetId: 'asset-1', sourceHash: hash('SOURCE_BODY_SENTINEL_NOT_STORED'), scopeKey: 'conversation:one', identity: modelIdentity(),
  chunkPolicy: { version: 1, maxChars: 1200, overlapChars: 100, offsetUnits: 'UTF-16' },
  chunks: Array.from({ length: count }, (_, ordinal) => ({ ordinal, start: ordinal * 10, end: ordinal * 10 + 8, textHash: hash(`CHUNK_BODY_SENTINEL_${ordinal}`) })) });
const f32 = (...values) => new Float32Array(values);
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  return { db, store: createSemanticIndexStore({ db, ...options }) };
}
const code = expected => caught => caught?.code === expected;

test('semantic indexes deterministically bind every source/scope/identity/policy/descriptor and store no source text', t => {
  const { db, store } = fixture(t), input = specification();
  const first = store.ensure(input);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.complete, false);
  assert.equal(first.dimensions, null);
  assert.equal(first.vectorBytes, 0);
  assert.equal(first.storedChunks, 0);
  assert.equal(first.totalChunks, 3);
  assert.deepEqual(store.ensure({ ...input, identity: Object.fromEntries(Object.entries(input.identity).reverse()), chunkPolicy: Object.fromEntries(Object.entries(input.chunkPolicy).reverse()) }), first);
  const variations = [value => { value.assetId = 'asset-2'; }, value => { value.sourceHash = hash('source-v2'); }, value => { value.scopeKey = 'conversation:two'; },
    value => { value.identity.model = 'another-local:latest'; }, value => { value.identity.digest = hash('model-v2'); },
    value => { value.identity.documentPrefix = 'passage: '; }, value => { value.identity.queryPrefix = 'query: '; },
    value => { value.chunkPolicy.overlapChars++; }, value => { value.chunks[0].textHash = hash('changed chunk'); }, value => { value.chunks[0].end++; }];
  for (const vary of variations) { const changed = clone(input); vary(changed); assert.notEqual(store.ensure(changed).id, first.id); }
  const rows = db.prepare('SELECT metadata_json FROM semantic_indexes').all();
  assert.ok(rows.every(row => !row.metadata_json.includes('SOURCE_BODY_SENTINEL') && !row.metadata_json.includes('CHUNK_BODY_SENTINEL')));
  const descriptorColumns = db.prepare('PRAGMA table_info(semantic_index_chunks)').all().map(row => row.name);
  assert.equal(descriptorColumns.includes('text'), false);
  input.identity.documentPrefix = 'MUTATED'; first.identity.queryPrefix = 'MUTATED'; first.chunkPolicy.version = 999;
  assert.equal(store.get(first.id).identity.queryPrefix, 'search_query: ');
  assert.equal(store.get(first.id).chunkPolicy.version, 1);
});

test('pending batches are bounded and incomplete indexes cannot leak partial vectors', t => {
  const { store } = fixture(t), input = specification(40), index = store.ensure(input);
  assert.equal(store.pending(index.id).length, 32);
  assert.deepEqual(store.pending(index.id, 2), input.chunks.slice(0, 2));
  assert.throws(() => store.pending(index.id, 33), code('semantic_index_arguments'));
  assert.throws(() => store.pending(index.id, 0), code('semantic_index_arguments'));
  store.put(index.id, [{ ordinal: 0, vector: f32(1, 2) }], input.identity);
  assert.equal(store.pending(index.id, 1)[0].ordinal, 1);
  assert.throws(() => store.vectors(index.id), code('semantic_index_incomplete'));
  assert.equal(store.get(index.id).storedChunks, 1);
});

test('atomic float32 writes resume across store instances, preserve signed zero and return exact descriptors only when complete', t => {
  const { db, store } = fixture(t), input = specification(), index = store.ensure(input);
  const first = store.put(index.id, [{ ordinal: 0, vector: f32(0.1, -0, 2) }, { ordinal: 2, vector: f32(0.3, 1, -2) }], input.identity);
  assert.equal(first.dimensions, 3);
  assert.equal(first.vectorBytes, 2 * (64 + 3 * 4));
  const restarted = createSemanticIndexStore({ db });
  assert.deepEqual(restarted.pending(index.id), [input.chunks[1]]);
  const complete = restarted.put(index.id, [{ ordinal: 1, vector: f32(-1, 2, 3) }], input.identity);
  assert.equal(complete.complete, true);
  assert.equal(complete.vectorBytes, 3 * (64 + 3 * 4));
  const rows = restarted.vectors(index.id);
  assert.deepEqual(rows.map(({ vector, ...descriptor }) => descriptor), input.chunks);
  assert.ok(rows.every(row => row.vector instanceof Float32Array && row.vector.length === 3));
  assert.equal(Object.is(rows[0].vector[1], -0), true);
  const idempotent = restarted.put(index.id, [{ ordinal: 0, vector: f32(0.1, -0, 2) }], Object.fromEntries(Object.entries(input.identity).reverse()));
  assert.deepEqual(idempotent, complete);
  rows[0].vector[0] = 999;
  assert.equal(restarted.vectors(index.id)[0].vector[0], Math.fround(0.1));
  assert.deepEqual(restarted.pending(index.id), []);
});

test('changed bytes, duplicate ordinals, dimension mismatches and identity drift roll back the entire batch', t => {
  const { store } = fixture(t), input = specification(2), index = store.ensure(input);
  const initial = store.put(index.id, [{ ordinal: 0, vector: f32(1, -0) }], input.identity);
  assert.throws(() => store.put(index.id, [{ ordinal: 1, vector: f32(2, 3) }, { ordinal: 0, vector: f32(1, 0) }], input.identity), code('semantic_index_conflict'));
  assert.deepEqual(store.get(index.id), initial);
  assert.deepEqual(store.pending(index.id), [input.chunks[1]]);
  assert.throws(() => store.put(index.id, [{ ordinal: 1, vector: f32(1, 2) }, { ordinal: 1, vector: f32(1, 2) }], input.identity), code('semantic_index_arguments'));
  assert.throws(() => store.put(index.id, [{ ordinal: 1, vector: f32(1, 2, 3) }], input.identity), code('semantic_index_conflict'));
  for (const key of ['model', 'digest', 'documentPrefix', 'queryPrefix']) {
    const changed = modelIdentity(); changed[key] = key === 'digest' ? hash('different') : changed[key] + '-changed';
    assert.throws(() => store.put(index.id, [{ ordinal: 1, vector: f32(1, 2) }], changed), code('semantic_index_identity'));
  }
  assert.deepEqual(store.get(index.id), initial);
});

test('all input vectors must be finite bounded Float32Array instances before any entry is committed', t => {
  const { store } = fixture(t), input = specification(2), index = store.ensure(input);
  for (const vector of [[], [1, 2], new Float64Array([1]), f32(), new Float32Array(4097), f32(NaN), f32(Infinity), f32(-Infinity)]) {
    assert.throws(() => store.put(index.id, [{ ordinal: 0, vector: f32(1, 2) }, { ordinal: 1, vector }], input.identity), caught => ['semantic_index_arguments', 'semantic_index_conflict'].includes(caught.code));
    assert.equal(store.get(index.id).storedChunks, 0);
    assert.equal(store.get(index.id).dimensions, null);
  }
  assert.throws(() => store.put(index.id, [{ ordinal: 2, vector: f32(1) }], input.identity), code('semantic_index_arguments'));
  assert.throws(() => store.put(index.id, Array.from({ length: 33 }, () => ({ ordinal: 0, vector: f32(1) })), input.identity), code('semantic_index_arguments'));
  assert.deepEqual(store.put(index.id, [], input.identity), index);
});

test('global vector capacity includes codec headers, never evicts and is freed only by explicit derived removal', t => {
  const bytes = encodeVectors([f32(1, 2)]).data.length;
  const { db, store } = fixture(t, { maxVectorBytes: 2 * bytes });
  db.exec('CREATE TABLE authored_source(id TEXT PRIMARY KEY,body TEXT)');
  db.prepare('INSERT INTO authored_source VALUES(?,?)').run('source-1', 'SOURCE_REMAINS_UNCHANGED');
  const inputs = [1, 2, 3].map(value => ({ ...specification(1), assetId: `asset-${value}` }));
  const indexes = inputs.map(input => store.ensure(input));
  store.put(indexes[0].id, [{ ordinal: 0, vector: f32(1, 2) }], inputs[0].identity);
  store.put(indexes[1].id, [{ ordinal: 0, vector: f32(3, 4) }], inputs[1].identity);
  assert.throws(() => store.put(indexes[2].id, [{ ordinal: 0, vector: f32(5) }], inputs[2].identity), code('semantic_index_capacity'));
  assert.equal(store.get(indexes[2].id).storedChunks, 0);
  assert.equal(store.get(indexes[2].id).dimensions, null);
  assert.equal(store.get(indexes[0].id).complete, true);
  assert.equal(store.put(indexes[0].id, [{ ordinal: 0, vector: f32(1, 2) }], inputs[0].identity).complete, true);
  assert.equal(store.remove(indexes[0].id), true);
  assert.equal(store.remove(indexes[0].id), false);
  assert.equal(store.get(indexes[0].id), null);
  assert.equal(store.put(indexes[2].id, [{ ordinal: 0, vector: f32(5) }], inputs[2].identity).complete, true);
  assert.equal(db.prepare('SELECT body FROM authored_source WHERE id=?').get('source-1').body, 'SOURCE_REMAINS_UNCHANGED');
});

test('index count and configuration ceilings are bounded without removing existing caches', t => {
  const { db, store } = fixture(t, { maxIndexes: 2 });
  const first = store.ensure(specification(1));
  store.ensure({ ...specification(1), assetId: 'asset-2' });
  assert.throws(() => store.ensure({ ...specification(1), assetId: 'asset-3' }), code('semantic_index_capacity'));
  assert.equal(store.ensure(specification(1)).id, first.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_indexes').get().n, 2);
  store.remove(first.id);
  assert.ok(store.ensure({ ...specification(1), assetId: 'asset-3' }).id);
  for (const options of [{ maxIndexes: 33 }, { maxIndexes: 0 }, { maxVectorBytes: 64 * 1024 * 1024 + 1 }, { maxVectorBytes: Infinity }]) {
    assert.throws(() => createSemanticIndexStore({ db, ...options }), code('semantic_index_configuration'));
  }
});

test('descriptor/policy validation rejects source text, sparse/gapped ordinals and ambiguous metadata', t => {
  const { db, store } = fixture(t);
  const changes = [value => { value.sourceText = 'DO_NOT_STORE_SOURCE'; }, value => { value.chunks[0].text = 'DO_NOT_STORE_CHUNK'; },
    value => { value.chunks[0].ordinal = 1; }, value => { value.chunks[1].ordinal = 0; }, value => { value.chunks[0].start = -1; },
    value => { value.chunks[0].end = 0; }, value => { value.chunks[0].end = value.chunks[0].start; }, value => { value.chunks[0].textHash = 'bad'; },
    value => { value.sourceHash = 'bad'; }, value => { value.identity.provider = 'openai'; }, value => { value.identity.digest = 'sha256:' + value.identity.digest; },
    value => { value.identity.queryPrefix = 'é'.repeat(129); }, value => { value.identity.extra = true; },
    value => { value.chunkPolicy = { value: Infinity }; }, value => { value.chunkPolicy = { value: undefined }; }, value => { value.chunkPolicy = { value: -0 }; }];
  for (const change of changes) { const input = specification(2); change(input); assert.throws(() => store.ensure(input), code('semantic_index_arguments')); }
  assert.throws(() => store.ensure(specification(0)), code('semantic_index_arguments'));
  assert.throws(() => store.ensure(specification(1025)), code('semantic_index_arguments'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_indexes').get().n, 0);
  assert.equal(store.ensure(specification(1024)).totalChunks, 1024);
});

test('missing IDs are explicit and corrupt derived metadata can still be removed without source access', t => {
  const { db, store } = fixture(t), missing = hash('missing');
  assert.equal(store.get(missing), null);
  assert.throws(() => store.pending(missing), code('semantic_index_not_found'));
  assert.throws(() => store.vectors(missing), code('semantic_index_not_found'));
  assert.throws(() => store.put(missing, [], modelIdentity()), code('semantic_index_not_found'));
  assert.throws(() => store.get('bad'), code('semantic_index_arguments'));
  const index = store.ensure(specification(1));
  db.prepare('UPDATE semantic_indexes SET metadata_json=? WHERE id=?').run('{broken', index.id);
  assert.throws(() => store.get(index.id), code('semantic_index_corrupt'));
  assert.equal(store.remove(index.id), true);
  assert.equal(db.prepare('SELECT count(*) AS n FROM semantic_index_chunks').get().n, 0);
});

test('every vector/hash/count/dimension/descriptor is validated with no silent corruption skips', async t => {
  const cases = {
    blobHash(db, id) { const blob = Buffer.from(db.prepare('SELECT vector_blob FROM semantic_index_chunks WHERE index_id=? AND ordinal=1').get(id).vector_blob); blob[blob.length - 1] ^= 1; db.prepare('UPDATE semantic_index_chunks SET vector_blob=? WHERE index_id=? AND ordinal=1').run(blob, id); },
    codecChecksum(db, id) { const blob = Buffer.from(db.prepare('SELECT vector_blob FROM semantic_index_chunks WHERE index_id=? AND ordinal=1').get(id).vector_blob); blob[0] ^= 1; db.prepare('UPDATE semantic_index_chunks SET vector_blob=?,vector_hash=? WHERE index_id=? AND ordinal=1').run(blob, hash(blob), id); },
    vectorDimension(db, id) { db.prepare('UPDATE semantic_index_chunks SET dimensions=3 WHERE index_id=? AND ordinal=1').run(id); },
    indexDimension(db, id) { db.prepare('UPDATE semantic_indexes SET dimensions=3 WHERE id=?').run(id); },
    chunkHash(db, id) { db.prepare('UPDATE semantic_index_chunks SET text_hash=? WHERE index_id=? AND ordinal=1').run(hash('changed'), id); },
    storedCount(db, id) { db.prepare('UPDATE semantic_indexes SET stored_chunks=1 WHERE id=?').run(id); },
    totalCount(db, id) { db.prepare('UPDATE semantic_indexes SET total_chunks=3 WHERE id=?').run(id); },
    bytes(db, id) { db.prepare('UPDATE semantic_indexes SET vector_bytes=vector_bytes+1 WHERE id=?').run(id); },
    rowBytes(db, id) { db.prepare('UPDATE semantic_index_chunks SET vector_bytes=1 WHERE index_id=? AND ordinal=1').run(id); },
    deletedChunk(db, id) { db.prepare('DELETE FROM semantic_index_chunks WHERE index_id=? AND ordinal=1').run(id); },
    badOrdinal(db, id) { db.prepare('UPDATE semantic_index_chunks SET ordinal=8 WHERE index_id=? AND ordinal=1').run(id); },
    metadata(db, id) { const document = JSON.parse(db.prepare('SELECT metadata_json FROM semantic_indexes WHERE id=?').get(id).metadata_json); document.spec.scopeKey = 'other-scope'; db.prepare('UPDATE semantic_indexes SET metadata_json=? WHERE id=?').run(JSON.stringify(document), id); },
    missingVectorMetadata(db, id) { db.prepare('UPDATE semantic_index_chunks SET vector_blob=NULL WHERE index_id=? AND ordinal=1').run(id); },
    nonproductionFormat(db, id) { const blob = encodeVectors([f32(3, 4)], { format: 'signed8-rgba' }).data; assert.equal(blob.length, 72); db.prepare('UPDATE semantic_index_chunks SET vector_blob=?,vector_hash=? WHERE index_id=? AND ordinal=1').run(blob, hash(blob), id); },
    wrongCodecCount(db, id) { const blob = encodeVectors([f32(3), f32(4)]).data; assert.equal(blob.length, 72); db.prepare('UPDATE semantic_index_chunks SET vector_blob=?,vector_hash=? WHERE index_id=? AND ordinal=1').run(blob, hash(blob), id); }
  };
  for (const [name, corrupt] of Object.entries(cases)) await t.test(name, inner => {
    const { db, store } = fixture(inner), input = specification(2), index = store.ensure(input);
    store.put(index.id, [{ ordinal: 0, vector: f32(1, 2) }, { ordinal: 1, vector: f32(3, 4) }], input.identity);
    corrupt(db, index.id);
    assert.throws(() => store.vectors(index.id), code('semantic_index_corrupt'));
    assert.throws(() => store.get(index.id), code('semantic_index_corrupt'));
    assert.throws(() => store.ensure(input), code('semantic_index_corrupt'));
  });
});
