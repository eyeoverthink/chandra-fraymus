/**
 * Facts — what is true NOW about a thing, with what used to be true kept behind it.
 *
 * `agent_memories` is a pile of notes: when a number changes, the old note and the new one sit side by side and a
 * search returns both. A fact is narrower: one claim about one entity. Asserting a claim does one of three things —
 *   duplicate   the same claim again (same fingerprint, or the same words with nothing that matters changed)
 *   supersede   the same statement with a different number, date, amount or a negation flipped: the old row is
 *               EXPIRED and points at the new one; it is never deleted, so the history can always be read
 *   new         anything else
 * The rules are mechanical. The design follows gbrain's facts store (read 2026-11-11), including its finding that
 * similarity alone cannot find an update (0 of 97 on their labelled set): what marks an update is that the
 * sentence is the same and a value token differs — `claimsDiverge`.
 *
 * `createFactStore({ db })` is a factory so the benchmark runs the same code in a throwaway in-memory database.
 */
import { createHash } from 'node:crypto';

export const KINDS = Object.freeze(['fact', 'event', 'preference', 'commitment', 'belief', 'idea']);
/** How long a claim stays believable without being seen again, by kind (days). */
export const HALF_LIFE_DAYS = Object.freeze({ event: 7, commitment: 90, preference: 90, belief: 365, fact: 365, idea: 365 });
const DAY = 86_400_000;
const NEGATIONS = new Set(['not', 'no', 'never', 'none', 'cannot', 'without', 'neither', 'nor', 'off', 'disabled', 'false', 'failed', 'fails', 'stopped', 'removed']);
const STOP = new Set('a an and are as at be but by for from has have in into is it its of on or that the their them then there these they this to was were which will with now currently about'.split(' '));

export const normClaim = s => String(s || '').toLowerCase().replace(/n't\b/g, ' not').replace(/[^a-z0-9.%$-]+/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
export const entitySlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
export const factFingerprint = (entity, claim) => createHash('sha256').update(`${entitySlug(entity)}|${normClaim(claim)}`).digest('hex').slice(0, 32);

const isValue = w => /\d/.test(w);
/** The words of a claim that say what it is about, and the tokens that carry its value. */
export function claimParts(claim) {
  const ws = normClaim(claim).split(' ').filter(Boolean);
  return { words: ws.filter(w => !isValue(w) && !NEGATIONS.has(w) && !STOP.has(w) && w.length > 1), values: ws.filter(isValue).sort(), negations: ws.filter(w => NEGATIONS.has(w)).sort() };
}
/** Do two claims differ in something that changes their truth: a number, a date, an amount, or a negation? */
export function claimsDiverge(a, b) {
  const x = claimParts(a), y = claimParts(b);
  return x.values.join('|') !== y.values.join('|') || (x.negations.length > 0) !== (y.negations.length > 0);
}
/** How alike two claims are in what they are about (word-set Jaccard, values and negations left out). */
export function claimLikeness(a, b) {
  const A = new Set(claimParts(a).words), B = new Set(claimParts(b).words); if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Confidence now: what was stated, worn down by how long ago it was last seen. */
export function decayed(confidence, lastSeenAt, kind, at = Date.now()) {
  const half = (HALF_LIFE_DAYS[kind] || 365) * DAY;
  return +(Math.max(0, Math.min(1, confidence)) * Math.pow(0.5, Math.max(0, at - lastSeenAt) / half)).toFixed(4);
}

export const SAME_STATEMENT = 0.6;   // likeness at or above which two claims are the same statement

export function createFactStore({ db, clock = () => Date.now() } = {}) {
  function ensure() {
    db.exec(`
      CREATE TABLE IF NOT EXISTS facts (id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, claim TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'fact', confidence REAL NOT NULL DEFAULT 0.8,
        fingerprint TEXT NOT NULL, source TEXT, source_memory_id INTEGER, asserted_by TEXT, quote TEXT, seen_count INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        expired_at INTEGER, superseded_by INTEGER);
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity, expired_at);
      CREATE INDEX IF NOT EXISTS idx_facts_fp ON facts(fingerprint);
    `);
  }

  /**
   * Assert a claim about an entity.
   * @returns {{ status: 'new'|'duplicate'|'superseded'|'refused', id?, replaced?, reason? }}
   */
  function assertFact({ entity, claim, kind = 'fact', confidence = 0.8, source = null, sourceMemoryId = null, assertedBy = null, quote = null } = {}) {
    const ent = entitySlug(entity), text = String(claim || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!ent || ent.length < 2) return { status: 'refused', reason: 'an entity is required' };
    if (claimParts(text).words.length < 2) return { status: 'refused', reason: 'the claim says too little to be a fact' };
    const k = KINDS.includes(kind) ? kind : 'fact', conf = Math.max(0.05, Math.min(1, Number(confidence) || 0.8)), now = clock(), fp = factFingerprint(ent, text);
    const same = db.prepare(`SELECT id FROM facts WHERE fingerprint = ? AND expired_at IS NULL`).get(fp);
    if (same) { db.prepare(`UPDATE facts SET seen_count = seen_count + 1, last_seen_at = ?, confidence = MAX(confidence, ?) WHERE id = ?`).run(now, conf, same.id); return { status: 'duplicate', id: same.id, how: 'the same claim' }; }
    const live = db.prepare(`SELECT id, claim, kind FROM facts WHERE entity = ? AND expired_at IS NULL`).all(ent);
    const alike = live.map(f => ({ ...f, likeness: claimLikeness(f.claim, text) })).filter(f => f.likeness >= SAME_STATEMENT).sort((a, b) => b.likeness - a.likeness);
    const twin = alike.find(f => !claimsDiverge(f.claim, text));
    if (twin) { db.prepare(`UPDATE facts SET seen_count = seen_count + 1, last_seen_at = ?, confidence = MAX(confidence, ?) WHERE id = ?`).run(now, conf, twin.id); return { status: 'duplicate', id: twin.id, how: 'the same statement in other words' }; }
    const insert = () => db.prepare(`INSERT INTO facts (entity, claim, kind, confidence, fingerprint, source, source_memory_id, asserted_by, quote, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(ent, text, k, conf, fp, source, sourceMemoryId, assertedBy, quote ? String(quote).slice(0, 300) : null, now, now).lastInsertRowid;
    if (alike.length) {
      // the same statement with a different value: the new claim takes its place, the old one is kept and marked
      return db.transaction(() => { const id = insert(); const up = db.prepare(`UPDATE facts SET expired_at = ?, superseded_by = ? WHERE id = ?`); for (const f of alike) up.run(now, id, f.id); return { status: 'superseded', id, replaced: alike.map(f => f.id) }; })();
    }
    return { status: 'new', id: insert() };
  }

  const shape = (f, at) => ({ id: f.id, entity: f.entity, claim: f.claim, kind: f.kind, confidence: decayed(f.confidence, f.last_seen_at, f.kind, at), stated: f.confidence, seen: f.seen_count, since: f.created_at, lastSeen: f.last_seen_at, source: f.source, assertedBy: f.asserted_by, expiredAt: f.expired_at, supersededBy: f.superseded_by });

  /** What is believed now about an entity (or about everything), most believable first. */
  function currentFacts({ entity = null, limit = 20, minConfidence = 0 } = {}) {
    const at = clock(), rows = entity ? db.prepare(`SELECT * FROM facts WHERE entity = ? AND expired_at IS NULL`).all(entitySlug(entity)) : db.prepare(`SELECT * FROM facts WHERE expired_at IS NULL ORDER BY last_seen_at DESC LIMIT 2000`).all();
    return rows.map(f => shape(f, at)).filter(f => f.confidence >= minConfidence).sort((a, b) => b.confidence - a.confidence || b.lastSeen - a.lastSeen).slice(0, Math.min(200, Math.max(1, limit)));
  }
  /** Every version of what was said about an entity, oldest first: nothing is lost when a fact is replaced. */
  function history(entity) { const at = clock(); return db.prepare(`SELECT * FROM facts WHERE entity = ? ORDER BY created_at, id`).all(entitySlug(entity)).map(f => shape(f, at)); }
  /** Entities a text names (whole-word match on the entity's words), for putting the right facts in front of a task. */
  function entitiesIn(text, { limit = 4 } = {}) {
    const t = ` ${String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    return db.prepare(`SELECT entity, COUNT(*) n, MAX(last_seen_at) t FROM facts WHERE expired_at IS NULL GROUP BY entity`).all()
      .filter(e => e.entity.length >= 3 && t.includes(` ${e.entity.replace(/-/g, ' ')} `)).sort((a, b) => b.entity.length - a.entity.length || b.t - a.t).slice(0, limit).map(e => e.entity);
  }
  function expire(id, reason = 'expired by an operator') { const r = db.prepare(`UPDATE facts SET expired_at = ? WHERE id = ? AND expired_at IS NULL`).run(clock(), id); return { expired: r.changes > 0, reason }; }
  function stats() {
    const g = db.prepare(`SELECT COUNT(*) total, SUM(expired_at IS NULL) current, SUM(superseded_by IS NOT NULL) superseded, COUNT(DISTINCT entity) entities, SUM(seen_count) - COUNT(*) repeats FROM facts`).get();
    return { total: g.total, current: g.current || 0, superseded: g.superseded || 0, entities: g.entities, repeatsAbsorbed: g.repeats || 0 };
  }
  return { ensure, assertFact, currentFacts, history, entitiesIn, expire, stats };
}

// ── reading facts out of notes: a model proposes, this decides ───────────────────────────────────────

/**
 * Decide whether a proposed fact is supported by the text it claims to come from. Pure.
 * @returns {{ ok: true } | { ok: false, why: 'no_quote'|'quote_not_in_source'|'entity_not_in_quote'|'number_not_in_quote'|'claim_does_not_name_entity' }}
 */
export function grounded(proposal, sourceText) {
  const src = normClaim(sourceText), quote = normClaim(proposal?.quote);
  if (quote.length < 12) return { ok: false, why: 'no_quote' };
  if (!src.includes(quote)) return { ok: false, why: 'quote_not_in_source' };
  const ent = entitySlug(proposal.entity).split('-').filter(w => w.length > 2);
  if (!ent.length || !ent.some(w => quote.includes(w))) return { ok: false, why: 'entity_not_in_quote' };
  if (claimParts(proposal.claim).values.some(v => !quote.includes(v))) return { ok: false, why: 'number_not_in_quote' };
  // a fact is read later with nothing around it: "Its value is AWAKENING" says nothing unless the claim itself names the thing
  const claim = normClaim(proposal.claim);
  if (/^(it|its|this|that|these|those|they|their|he|she|his|her)\b/.test(claim) || !ent.some(w => claim.includes(w))) return { ok: false, why: 'claim_does_not_name_entity' };
  return { ok: true };
}

export function extractMessages(text) {
  const system = [
    'You read one note and list the facts it states. A fact is one checkable claim about one named thing.',
    'Reply with JSON only: {"facts": [{"entity": "...", "claim": "...", "kind": "fact|event|preference|commitment|belief|idea", "quote": "..."}]}',
    'Rules:',
    '- "entity" is the name of the thing, in one to four words, as the note writes it.',
    '- "claim" is one short sentence that stands on its own and names the entity.',
    '- "quote" is copied EXACTLY from the note: the words that state this fact. Do not paraphrase the quote.',
    '- Use only numbers, dates and names that are in the note. Never add one.',
    '- Skip opinions about the note itself, plans, questions, and anything vague. If the note states no fact, reply {"facts": []}.',
    '- At most 4 facts.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `NOTE:\n${String(text).slice(0, 1800)}` }];
}

// ── benchmark: a generated history of changing facts, with the truth known at every step ─────────────

function rng(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const THINGS = ['the render worker', 'the narrator voice', 'the memory indexer', 'the goal queue', 'the hub tunnel', 'the scheduler', 'the overlay', 'the verifier', 'the skill forge', 'the research scout', 'the flat renderer', 'the studio lease'];
const ATTRS = [
  { say: v => `runs ${v} jobs at a time`, re: v => `handles ${v} jobs at a time, as it runs them`, vals: [1, 2, 4, 8] },
  { say: v => `waits ${v} seconds between tries`, re: v => `waits for ${v} seconds between its tries`, vals: [15, 30, 45, 60, 90] },
  { say: v => `keeps ${v} days of history`, re: v => `keeps a history of ${v} days`, vals: [7, 14, 30, 48] },
  { say: v => `is ${v ? '' : 'not '}started at sign-in`, re: v => `is ${v ? '' : 'not '}started when you sign-in`, vals: [true, false] },
  { say: v => `listens on port ${v}`, re: v => `listens only on the port ${v}`, vals: [47100, 47210, 47300, 8787] },
];

/**
 * Feed a generated timeline to a fact store and to a plain append-only log (what a memory pile does), and compare.
 * @returns per system: currentAccuracy (the value returned as current is the latest), staleSurfaced (share of
 * "current" answers that are out of date), historyPreserved (every past value can still be read), rowsPerTruth.
 */
export function runFactsBench({ Database, seed = 42, entities = 12, updates = 6 } = {}) {
  const r = rng(seed), pick = l => l[Math.floor(r() * l.length)];
  let tick = 1_800_000_000_000;
  const mem = new Database(':memory:'), store = createFactStore({ db: mem, clock: () => tick }); store.ensure();
  const log = [];                       // the baseline: every statement kept, nothing reconciled
  const truth = new Map(), past = new Map();
  const events = [];
  for (let e = 0; e < Math.min(entities, THINGS.length); e++) for (const [ai, attr] of ATTRS.entries()) {
    let last = null;
    // each attribute changes at its own random moments, so the newest notes about a thing are a mix, as in a real pile
    const when = Array.from({ length: updates }, () => r()).sort((x, y) => x - y);
    for (let u = 0; u < updates; u++) {
      let v = pick(attr.vals); if (u > 0 && r() < 0.35) v = last;               // sometimes nothing changed and it is simply said again
      events.push({ entity: THINGS[e], key: `${e}|${ai}`, value: v, claim: `${THINGS[e]} ${(r() < 0.3 ? attr.re : attr.say)(v)}`, order: when[u] });
      last = v;
    }
  }
  events.sort((a, b) => a.order - b.order);
  for (const ev of events) {
    tick += 3_600_000;
    store.assertFact({ entity: ev.entity, claim: ev.claim, source: 'bench' }); log.push({ entity: entitySlug(ev.entity), claim: ev.claim, at: tick });
    if (truth.has(ev.key) && truth.get(ev.key).value !== ev.value) (past.get(ev.key) || past.set(ev.key, []).get(ev.key)).push(truth.get(ev.key).claim);
    truth.set(ev.key, { value: ev.value, claim: ev.claim, entity: ev.entity });
  }
  const valueOf = c => claimParts(c).values.join('|') + '/' + (claimParts(c).negations.length > 0);
  const aboutSame = (a, b) => claimLikeness(a, b) >= SAME_STATEMENT;
  const score = currentOf => {
    let right = 0, staleShown = 0, shown = 0, kept = 0, pastTotal = 0;
    for (const [key, t] of truth) {
      const cur = currentOf(t.entity).filter(c => aboutSame(c, t.claim)); shown += cur.length;
      if (cur.some(c => valueOf(c) === valueOf(t.claim))) right++;
      staleShown += cur.filter(c => valueOf(c) !== valueOf(t.claim)).length;
      for (const old of past.get(key) || []) { pastTotal++; if (currentOf.all(t.entity).some(c => valueOf(c) === valueOf(old) && aboutSame(c, old))) kept++; }
    }
    return { currentAccuracy: +(right / truth.size).toFixed(4), staleSurfaced: shown ? +(staleShown / shown).toFixed(4) : 0, historyPreserved: pastTotal ? +(kept / pastTotal).toFixed(4) : 1, rowsPerTruth: +(shown / truth.size).toFixed(2) };
  };
  const factsNow = e => store.currentFacts({ entity: e, limit: 200 }).map(f => f.claim); factsNow.all = e => store.history(e).map(f => f.claim);
  // the pile's "current" is its newest five notes about the entity — what a prompt would be given
  const pileNow = e => log.filter(x => x.entity === entitySlug(e)).slice(-5).map(x => x.claim); pileNow.all = e => log.filter(x => x.entity === entitySlug(e)).map(x => x.claim);
  const out = { seed, statements: events.length, truths: truth.size, changes: [...past.values()].reduce((n, l) => n + l.length, 0), facts: score(factsNow), pile: score(pileNow), store: store.stats() };
  mem.close();
  return out;
}
