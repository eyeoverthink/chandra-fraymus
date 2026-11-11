import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { KINDS, HALF_LIFE_DAYS, SAME_STATEMENT, normClaim, entitySlug, factFingerprint, claimParts, claimsDiverge, claimLikeness, decayed, createFactStore, runFactsBench } from '../server/intelligence/facts.js';

const DAY = 86_400_000;
function fresh() { let t = 1_800_000_000_000; const db = new Database(':memory:'), s = createFactStore({ db, clock: () => t }); s.ensure(); return { db, s, tick: (ms = 3_600_000) => { t += ms; }, now: () => t }; }

test('a claim is reduced to what it is about and the values it carries', () => {
  assert.equal(normClaim("The Worker isn't started — at sign-in!"), 'the worker is not started at sign-in');
  assert.equal(entitySlug('The Render Worker (home)'), 'the-render-worker-home');
  assert.equal(factFingerprint('Render worker', 'Runs 8 jobs at a time.'), factFingerprint('render  WORKER', 'runs 8 jobs at a time'));
  assert.notEqual(factFingerprint('render worker', 'runs 8 jobs'), factFingerprint('render worker', 'runs 4 jobs'));
  assert.deepEqual(claimParts('The worker listens on port 47210 and not on 22.'), { words: ['worker', 'listens', 'port'], values: ['22', '47210'], negations: ['not'] });
  assert.equal(claimsDiverge('runs 8 jobs at a time', 'runs 4 jobs at a time'), true);
  assert.equal(claimsDiverge('is started at sign-in', 'is not started at sign-in'), true);
  assert.equal(claimsDiverge('runs 8 jobs at a time', 'handles 8 jobs at a time, as it runs them'), false);
  assert.equal(claimsDiverge('costs 1.5 dollars', 'costs 1.50 dollars'), true);                       // a different token is treated as a different value: safe side
  assert.ok(claimLikeness('the worker runs 8 jobs at a time', 'the worker handles 8 jobs at a time, as it runs them') >= SAME_STATEMENT);
  assert.ok(claimLikeness('the worker runs 8 jobs at a time', 'the worker listens on port 47210') < SAME_STATEMENT);
  assert.equal(claimLikeness('8', '9'), 0);
});

test('asserting: new, the same again, the same in other words, and a changed value that replaces without deleting', () => {
  const { s, tick, db } = fresh();
  const a = s.assertFact({ entity: 'the render worker', claim: 'The render worker runs 4 jobs at a time.' });
  assert.equal(a.status, 'new'); tick();
  assert.equal(s.assertFact({ entity: 'The Render Worker', claim: 'the render worker runs 4 jobs at a time' }).status, 'duplicate'); tick();
  const para = s.assertFact({ entity: 'the render worker', claim: 'The render worker handles 4 jobs at a time, as it runs them.' });
  assert.equal(para.status, 'duplicate'); assert.equal(para.how, 'the same statement in other words'); assert.equal(para.id, a.id); tick();
  const b = s.assertFact({ entity: 'the render worker', claim: 'The render worker runs 8 jobs at a time.' });
  assert.equal(b.status, 'superseded'); assert.deepEqual(b.replaced, [a.id]); tick();
  assert.equal(s.assertFact({ entity: 'the render worker', claim: 'The render worker listens on port 47210.' }).status, 'new');     // another statement about the same thing
  const cur = s.currentFacts({ entity: 'the render worker' });
  assert.deepEqual(cur.map(f => f.claim).sort(), ['The render worker listens on port 47210.', 'The render worker runs 8 jobs at a time.']);
  const h = s.history('the render worker');
  assert.equal(h.length, 3); assert.equal(h[0].claim, 'The render worker runs 4 jobs at a time.'); assert.equal(h[0].supersededBy, b.id); assert.ok(h[0].expiredAt); assert.equal(h[0].seen, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM facts').get().n, 3, 'nothing was deleted');
  assert.deepEqual(s.stats(), { total: 3, current: 2, superseded: 1, entities: 1, repeatsAbsorbed: 2 });
  // a negation flips it back, and the chain keeps growing
  tick(); const off = s.assertFact({ entity: 'the render worker', claim: 'The render worker is started at sign-in.' }); assert.equal(off.status, 'new');
  tick(); const on = s.assertFact({ entity: 'the render worker', claim: 'The render worker is not started at sign-in.' }); assert.equal(on.status, 'superseded'); assert.deepEqual(on.replaced, [off.id]);
  // another entity is untouched
  assert.equal(s.assertFact({ entity: 'the narrator', claim: 'The narrator runs 4 jobs at a time.' }).status, 'new');
  assert.equal(s.currentFacts({ entity: 'the render worker' }).length, 3);
  for (const bad of [{ entity: '', claim: 'The worker runs 4 jobs.' }, { entity: 'worker', claim: '4' }, { entity: 'worker', claim: 'is it' }]) assert.equal(s.assertFact(bad).status, 'refused');
  db.close();
});

test('belief wears off with time, by kind, and seeing a claim again renews it', () => {
  assert.deepEqual([...KINDS].sort(), Object.keys(HALF_LIFE_DAYS).sort());
  const t0 = 1_800_000_000_000;
  assert.equal(decayed(0.8, t0, 'event', t0), 0.8);
  assert.equal(decayed(0.8, t0, 'event', t0 + 7 * DAY), 0.4);
  assert.ok(decayed(0.8, t0, 'fact', t0 + 7 * DAY) > 0.78);
  assert.equal(decayed(0.8, t0, 'nonsense', t0 + 365 * DAY), 0.4);
  const { s, tick, db } = fresh();
  s.assertFact({ entity: 'the launch', claim: 'The launch happened on the main pad.', kind: 'event', confidence: 0.8 });
  tick(14 * DAY); assert.equal(s.currentFacts({ entity: 'the launch' })[0].confidence, 0.2);
  assert.equal(s.currentFacts({ entity: 'the launch', minConfidence: 0.3 }).length, 0);
  s.assertFact({ entity: 'the launch', claim: 'The launch happened on the main pad.', kind: 'event' });
  assert.equal(s.currentFacts({ entity: 'the launch' })[0].confidence, 0.8); assert.equal(s.currentFacts({ entity: 'the launch' })[0].seen, 2);
  db.close();
});

test('the entities a task names are found by whole words, longest first', () => {
  const { s, db } = fresh();
  s.assertFact({ entity: 'render worker', claim: 'The render worker runs 8 jobs at a time.' });
  s.assertFact({ entity: 'worker', claim: 'A worker is a machine on the private network.' });
  s.assertFact({ entity: 'hub', claim: 'The hub listens on loopback only.' });
  assert.deepEqual(s.entitiesIn('Check whether the render worker is still reachable from the hub.'), ['render-worker', 'worker', 'hub']);
  assert.deepEqual(s.entitiesIn('The hubcap fell off the workers bench.'), []);
  assert.equal(s.expire(1).expired, true); assert.equal(s.expire(1).expired, false);
  assert.deepEqual(s.entitiesIn('the render worker'), ['worker']);                                 // an entity with no current fact is not offered
  db.close();
});

// The gate. Measured 2026-11-11 on two seeds: the fact store 1.00 / 0.00 / 1.00; a pile of the same notes 0.65–0.67 / 0.15 / 1.00.
test('benchmark: the fact store always knows the current value and never shows a stale one; a pile of notes does not', () => {
  for (const seed of [42, 7, 99]) {
    const o = runFactsBench({ Database, seed });
    assert.equal(o.statements, 360); assert.equal(o.truths, 60); assert.ok(o.changes > 100);
    assert.equal(o.facts.currentAccuracy, 1, `seed ${seed}`); assert.equal(o.facts.staleSurfaced, 0); assert.equal(o.facts.historyPreserved, 1); assert.equal(o.facts.rowsPerTruth, 1);
    assert.ok(o.pile.currentAccuracy < 0.8, `a pile answers ${o.pile.currentAccuracy}`); assert.ok(o.pile.staleSurfaced > 0.05);
    assert.equal(o.store.current, 60); assert.equal(o.store.total, 60 + o.store.superseded); assert.equal(o.store.total + o.store.repeatsAbsorbed, 360);
  }
  assert.deepEqual(runFactsBench({ Database, seed: 5 }), runFactsBench({ Database, seed: 5 }));
});

test('a fact read out of a note is believed only if the note really says it', async () => {
  const { grounded, extractMessages } = await import('../server/intelligence/facts.js');
  const note = 'Measured through fraymus-home: the render worker ran 8 processes and the film took 90 seconds end to end.';
  assert.deepEqual(grounded({ entity: 'render worker', claim: 'The render worker ran 8 processes.', quote: 'the render worker ran 8 processes' }, note), { ok: true });
  assert.equal(grounded({ entity: 'render worker', claim: 'The render worker ran 8 processes.', quote: 'The Render Worker ran 8   processes' }, note).ok, true);   // case and spacing do not matter
  assert.equal(grounded({ entity: 'render worker', claim: 'The render worker ran 8 processes.' }, note).why, 'no_quote');
  assert.equal(grounded({ entity: 'render worker', claim: 'The render worker ran 16 processes.', quote: 'the render worker ran 16 processes' }, note).why, 'quote_not_in_source');   // an invented quote
  assert.equal(grounded({ entity: 'render worker', claim: 'The render worker ran 12 processes.', quote: 'the render worker ran 8 processes' }, note).why, 'number_not_in_quote');  // a real quote, an invented number
  assert.equal(grounded({ entity: 'narrator voice', claim: 'The narrator voice ran 8 processes.', quote: 'the render worker ran 8 processes' }, note).why, 'entity_not_in_quote');
  // seen on the first live read: "Its value is AWAKENING." was accepted
  assert.equal(grounded({ entity: 'render worker', claim: 'It ran 8 processes.', quote: 'the render worker ran 8 processes' }, note).why, 'claim_does_not_name_entity');
  assert.equal(grounded({ entity: 'render worker', claim: 'Eight processes were used.', quote: 'the render worker ran 8 processes' }, note).why, 'claim_does_not_name_entity');
  const m = extractMessages(note); assert.match(m[0].content, /copied EXACTLY/); assert.match(m[1].content, /fraymus-home/);
});
