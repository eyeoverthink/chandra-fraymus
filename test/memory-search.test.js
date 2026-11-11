import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { RRF_K, contentWords, ftsQuery, rrfFuse, cosine, jaccard, fuse, precisionAt, recallAt, reciprocalRank, ndcgAt, hitAt, summarise, signFlipP } from '../server/intelligence/memory-rank.js';
import { generateBench, conceptEmbedder } from '../server/intelligence/memory-bench.js';
import { createMemorySearch, runMemoryBench } from '../server/intelligence/memory-search.js';

const SCHEMA = `CREATE TABLE agent_memories (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', key TEXT NOT NULL, value TEXT NOT NULL, confidence REAL DEFAULT 1.0, source TEXT DEFAULT 'agent', access_count INTEGER DEFAULT 0, verified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`;
function store(rows, embed = null) {
  const db = new Database(':memory:'); db.exec(SCHEMA);
  const ins = db.prepare(`INSERT INTO agent_memories (agent_id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  rows.forEach((r, i) => ins.run(r.agent || 'a', r.category || 'general', r.key || `k${i}`, r.value, i + 1, i + 1));
  const ms = createMemorySearch({ db, embed, model: 'test' }); ms.ensure();
  return { db, ms };
}

test('words, queries and fusion arithmetic', () => {
  assert.deepEqual(contentWords('What did the Worker on fraymus-home do?'), ['worker', 'fraymus', 'home']);
  assert.equal(ftsQuery('the worker, restarted!'), '"worker" AND "restarted"');
  assert.equal(ftsQuery('the worker restarted', { all: false }), '"worker" OR "restarted"');
  assert.equal(ftsQuery('the of and'), null);
  assert.equal(ftsQuery('worker" OR key:secret*'), '"worker" AND "key" AND "secret"');                 // quoting: nothing typed is read as syntax
  const f = rrfFuse([['a', 'b', 'c'], ['b', 'd']]);
  assert.ok(Math.abs(f.get('b') - (1 / (RRF_K + 1) + 1 / RRF_K)) < 1e-12); assert.ok(f.get('b') > f.get('a') && f.get('a') > f.get('c'));
  assert.equal(cosine([1, 0], [1, 0]), 1); assert.equal(cosine([1, 0], [0, 1]), 0); assert.equal(cosine([1], [1, 2]), 0);
  assert.equal(jaccard(['a', 'b'], ['b', 'c']), 1 / 3);
  const out = fuse([{ id: 1 }, { id: 2 }], [{ id: 2, cos: 0.9 }, { id: 3, cos: 0.8 }], { limit: 3 });
  assert.equal(out[0].id, 2); assert.equal(out[0].arms, 'both'); assert.deepEqual(out.map(r => r.arms).sort(), ['both', 'keyword', 'vector']);
  // near-duplicates are shown once
  const texts = { 1: 'the worker restarted after the reboot', 2: 'The worker RESTARTED, after the reboot.', 3: 'films now land on the asked length' };
  assert.deepEqual(fuse([{ id: 1 }, { id: 2 }, { id: 3 }], [], { textOf: id => texts[id] }).map(r => r.id), [1, 3]);
});

test('measures: precision, recall, reciprocal rank, nDCG, best-first, and the significance test', () => {
  const g = new Map([[1, 3], [2, 1], [3, 1]]);
  assert.equal(precisionAt([9, 1, 2], g, 3), 2 / 3); assert.equal(recallAt([9, 1, 2], g, 3), 2 / 3);
  assert.equal(reciprocalRank([9, 2, 1], g), 0.5); assert.equal(reciprocalRank([9, 8], g), 0);
  assert.equal(ndcgAt([1, 2, 3], g, 3), 1); assert.ok(ndcgAt([2, 3, 1], g, 3) < 1); assert.equal(ndcgAt([9], g, 3), 0);
  assert.equal(hitAt([2, 1], g, 1), 0); assert.equal(hitAt([2, 1], g, 2), 1); assert.equal(hitAt([1], g, 1), 1);
  const s = summarise([{ ranked: [1], grades: g }, { ranked: [9], grades: g }]);
  assert.equal(s.queries, 2); assert.equal(s.hit1, 0.5); assert.equal(s.mrr, 0.5);
  assert.equal(signFlipP([1, 1, 1, 1], [1, 1, 1, 1]), 1);
  assert.ok(signFlipP(Array(40).fill(1), Array(40).fill(0)) < 0.01);
  assert.ok(signFlipP([1, 0, 1, 0, 1, 0], [0, 1, 0, 1, 0, 1]) > 0.5);
  assert.equal(signFlipP(Array(40).fill(1), Array(40).fill(0)), signFlipP(Array(40).fill(1), Array(40).fill(0)));   // seeded
});

test('the gold set is generated with its answers, the same every time for a seed', () => {
  const a = generateBench({ seed: 42 }), b = generateBench({ seed: 42 }), c = generateBench({ seed: 7 });
  assert.deepEqual(a, b); assert.notDeepEqual(a.memories.map(m => m.value), c.memories.map(m => m.value));
  assert.equal(a.memories.length, 300); assert.equal(a.queries.length, 120); assert.deepEqual(a.kinds, ['exact', 'natural', 'inflected', 'paraphrase']);
  assert.equal(new Set(a.memories.map(m => m.value)).size, 300);
  for (const q of a.queries) {
    assert.equal(q.grades[q.target], 3); assert.equal(Object.values(q.grades).filter(g => g === 3).length, 1, 'one best answer');
    const target = a.memories.find(m => m.id === q.target).value.toLowerCase();
    if (q.kind === 'exact') assert.ok(target.includes(q.text), 'an exact question is a phrase of its memory');
    else assert.ok(!target.includes(q.text), `${q.kind}: a substring search must not find it by luck`);
    if (q.kind === 'paraphrase') assert.ok(!contentWords(q.text).some(w => contentWords(target).includes(w)), 'a paraphrase shares no content word with its memory');
  }
});

test('keyword search finds what substring search cannot: sentences, other word forms, quoting', async () => {
  const { ms, db } = store([
    { value: 'The worker on fraymus-home restarted by itself after the reboot.' },
    { value: 'Films now land on the asked length with the VoiceStudio voices.' },
    { value: 'A black dog was drawn grey because black fur was lightened.' },
    { value: 'The worker listens on 127.0.0.1 only.', agent: 'b' },
    { value: 'Budget note for the quarter.', category: 'finance' },
  ]);
  const ids = async (q, o = {}) => (await ms.search('a', q, { mode: 'keyword', ...o })).results.map(r => r.id);
  assert.deepEqual(await ms.search('a', 'did the worker restart after rebooting', { mode: 'like' }).then(r => r.results), []);
  assert.equal((await ids('did the worker restart after rebooting'))[0], 1);                 // stemming: restart/restarted, rebooting/reboot
  assert.equal((await ids('why was the dog grey'))[0], 3);
  assert.ok(!(await ids('worker')).includes(4), 'another agent\'s memory is not returned');
  assert.deepEqual((await ms.search(null, 'worker', { mode: 'keyword' })).results.map(r => r.id).sort(), [1, 4]);
  assert.deepEqual(await ids('budget', { category: 'finance' }), [5]); assert.deepEqual(await ids('budget', { category: 'general' }), []);
  assert.deepEqual(await ids('"; DROP TABLE agent_memories; --'), []);                         // typed syntax is only words
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_memories').get().n, 5);
  assert.deepEqual((await ms.search('a', '   ')).results, []);
  // the keyword index follows the table: insert, update, delete
  db.prepare(`INSERT INTO agent_memories (agent_id, key, value, created_at, updated_at) VALUES ('a', 'k9', 'A lighthouse keeper spotted a ship.', 9, 9)`).run();
  assert.equal((await ids('lighthouse')).length, 1);
  db.prepare(`UPDATE agent_memories SET value = 'A harbour pilot spotted a ship.' WHERE key = 'k9'`).run();
  assert.deepEqual(await ids('lighthouse'), []); assert.equal((await ids('harbour pilot')).length, 1);
  db.prepare(`DELETE FROM agent_memories WHERE key = 'k9'`).run();
  assert.deepEqual(await ids('harbour'), []);
  // prompt building is synchronous and keyword-only
  assert.equal(ms.relevantNow('a', 'Please check whether the worker restarted')[0].id, 1);
  assert.deepEqual(ms.relevantNow('a', 'the of and'), []);
  db.close();
});

test('the vector arm: indexed in the background, optional at every step, and it says which arms answered', async () => {
  const embed = conceptEmbedder();
  const { ms, db } = store([{ value: 'The rapid car purchased the boat near the harbor.' }, { value: 'The silent doctor repaired the engine near the museum.' }, { value: 'The ancient teacher painted the picture near the valley.' }], embed);
  let r = await ms.search('a', 'fast automobile that chose to buy something');
  assert.equal(r.arms.vector.found, 0); assert.match(r.arms.vector.note, /not been embedded yet|no memory in scope/);   // nothing embedded yet: keyword only, and it says so
  assert.deepEqual(await ms.indexPending(), { indexed: 3, pending: 0 });
  assert.deepEqual(await ms.indexPending(), { indexed: 0, pending: 0 });                       // nothing to do twice
  r = await ms.search('a', 'fast automobile that chose to buy something');
  assert.equal(r.results[0].id, 1); assert.equal(r.results[0].arms, 'vector'); assert.ok(r.results[0].cos > 0.8);
  assert.equal((await ms.search('a', 'fast automobile that chose to buy something', { mode: 'keyword' })).results.length, 0);
  // a changed memory is embedded again; an unchanged one keeps its vector; a deleted one loses it
  db.prepare(`UPDATE agent_memories SET value = 'The joyful singer praised the film near the castle.', updated_at = 99999999999999 WHERE id = 3`).run();
  assert.equal((await ms.indexPending()).indexed, 1);
  assert.equal((await ms.search('a', 'happy vocalist commend movie')).results[0].id, 3);
  db.prepare(`DELETE FROM agent_memories WHERE id = 2`).run(); await ms.indexPending();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_memory_vectors').get().n, 2);
  // the model failing does not fail the search
  const broken = store([{ value: 'The rapid car purchased the boat.' }], async () => { throw new Error('model is down'); });
  assert.equal((await broken.ms.indexPending()).indexed, 0);
  const k = await broken.ms.search('a', 'rapid car'); assert.equal(k.results[0].id, 1); assert.equal(k.results[0].arms, 'keyword');
  assert.ok(broken.ms.status().embedErrors >= 1);
  const st = ms.status(); assert.equal(st.memories, 2); assert.equal(st.vectors, 2); assert.equal(st.vectorCoverage, 1);
  db.close(); broken.db.close();
});

// The regression gate. These floors are below what was measured on 2026-11-11 (seed 42, the generator's own embedder):
// LIKE MRR 0.25 · keyword 0.75 · hybrid 0.986. A change that drops a system under its floor has made recall worse.
test('the benchmark: keyword beats substring search, hybrid beats keyword, each by a margin that is not chance', async () => {
  const out = await runMemoryBench({ Database, embed: conceptEmbedder(), seed: 42 });
  assert.deepEqual(out.systems, ['like', 'keyword', 'hybrid']); assert.equal(out.queries, 120); assert.equal(out.embedded, 300);
  assert.ok(out.overall.like.mrr <= 0.3, `substring search answers only the exact questions (${out.overall.like.mrr})`);
  assert.ok(out.overall.keyword.mrr >= 0.72, `keyword MRR ${out.overall.keyword.mrr}`);
  assert.ok(out.overall.hybrid.mrr >= 0.95, `hybrid MRR ${out.overall.hybrid.mrr}`);
  assert.ok(out.overall.hybrid.ndcg5 >= 0.82 && out.overall.hybrid.hit1 >= 0.88);
  assert.equal(out.byKind.natural.like.mrr, 0); assert.ok(out.byKind.natural.keyword.mrr >= 0.95);
  assert.ok(out.byKind.inflected.keyword.mrr >= 0.95, 'stemming');
  assert.equal(out.byKind.paraphrase.keyword.mrr, 0); assert.ok(out.byKind.paraphrase.hybrid.mrr >= 0.85, 'meaning');
  assert.ok(out.byKind.exact.hybrid.mrr >= out.byKind.exact.like.mrr, 'nothing substring search could do was lost');
  assert.ok(out.p.keyword_vs_like < 0.01 && out.p.hybrid_vs_keyword < 0.01);
  assert.ok(out.firsts.hybrid.length >= 105);
  // without an embedder the benchmark still runs and reports two systems
  const two = await runMemoryBench({ Database, embed: null, seed: 42, perKind: 5 });
  assert.deepEqual(two.systems, ['like', 'keyword']); assert.equal(two.p.hybrid_vs_keyword, undefined);
});

// Seen on the live store with a tenth of it embedded: vector-only results out-scored better keyword matches.
test('a keyword match is scored on meaning too, so a half-embedded store does not favour whatever has a vector', () => {
  const kw = [{ id: 'k1' }, { id: 'k2' }], vec = [{ id: 'v1', cos: 0.55 }, { id: 'v2', cos: 0.5 }];
  assert.equal(fuse(kw, vec, { limit: 4 })[0].id, 'v1');                                         // without it, the vector row wins a tie on rank
  const fair = fuse(kw, vec, { limit: 4, cosFor: id => (id === 'k1' ? 0.9 : null) });
  assert.equal(fair[0].id, 'k1'); assert.equal(fair[0].cos, 0.9); assert.equal(fair.find(r => r.id === 'k2').cos, null);
});
