/**
 * Memory bench — a generated set of memories and questions with the right answers known in advance.
 *
 * The corpus and its gold answers come out of the same seeded generator in one step, so they cannot drift
 * apart (the idea is gbrain's BrainBench; the generator is ours). Four kinds of question, because a memory
 * search fails in four different ways:
 *   exact       the question is a phrase that appears in the memory           — substring search can do it
 *   natural     the same words, in a sentence, not next to each other         — needs word matching
 *   inflected   other forms of the words ("purchased" for "purchase")         — needs stemming
 *   paraphrase  other words for the same things ("automobile" for "car")      — needs meaning
 * Each question has one best memory (grade 3) and partial ones that share two of its three ideas (grade 1).
 *
 * Pure: no database, no model, no clock.
 */
const NOUNS = [
  ['car', 'automobile', 'cars'], ['doctor', 'physician', 'doctors'], ['house', 'dwelling', 'houses'], ['boat', 'vessel', 'boats'], ['teacher', 'instructor', 'teachers'],
  ['dog', 'canine', 'dogs'], ['forest', 'woodland', 'forests'], ['picture', 'image', 'pictures'], ['street', 'road', 'streets'], ['shop', 'store', 'shops'],
  ['soldier', 'trooper', 'soldiers'], ['garden', 'yard', 'gardens'], ['lawyer', 'attorney', 'lawyers'], ['film', 'movie', 'films'], ['child', 'kid', 'children'],
  ['mountain', 'peak', 'mountains'], ['letter', 'message', 'letters'], ['engine', 'motor', 'engines'], ['singer', 'vocalist', 'singers'], ['river', 'stream', 'rivers'],
];
const VERBS = [
  ['purchase', 'buy', 'purchased'], ['repair', 'fix', 'repaired'], ['discover', 'find', 'discovered'], ['destroy', 'wreck', 'destroyed'], ['paint', 'color', 'painted'],
  ['observe', 'watch', 'observed'], ['transport', 'carry', 'transported'], ['construct', 'build', 'constructed'], ['conceal', 'hide', 'concealed'], ['examine', 'inspect', 'examined'],
  ['praise', 'commend', 'praised'], ['abandon', 'desert', 'abandoned'],
];
const QUALITIES = [
  ['large', 'big'], ['rapid', 'fast'], ['ancient', 'old'], ['silent', 'quiet'], ['wealthy', 'rich'], ['fragile', 'delicate'], ['joyful', 'happy'], ['frigid', 'cold'],
  ['tiny', 'small'], ['brave', 'courageous'], ['filthy', 'dirty'], ['clever', 'smart'],
];
const PLACES = ['harbor', 'valley', 'museum', 'station', 'market', 'desert', 'village', 'island', 'factory', 'library', 'airport', 'castle'];
const MONTHS = ['January', 'March', 'May', 'July', 'September', 'November'];

function rng(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * @returns {{ seed, memories: [{ id, key, value, ideas }], queries: [{ id, kind, text, grades: {memoryId: grade} }] }}
 */
export function generateBench({ seed = 42, memories = 300, perKind = 30 } = {}) {
  const r = rng(seed), pick = list => list[Math.floor(r() * list.length)], seen = new Set(), mem = [];
  while (mem.length < memories) {
    const q = Math.floor(r() * QUALITIES.length), n = Math.floor(r() * NOUNS.length), v = Math.floor(r() * VERBS.length), o = Math.floor(r() * NOUNS.length);
    if (o === n) continue;
    const sig = `${q}|${n}|${v}|${o}`; if (seen.has(sig)) continue; seen.add(sig);
    const place = pick(PLACES), month = pick(MONTHS), year = 1990 + Math.floor(r() * 30);
    mem.push({ id: mem.length + 1, key: `note:${mem.length + 1}`, ideas: { q, n, v, o },
      value: `The ${QUALITIES[q][0]} ${NOUNS[n][0]} ${VERBS[v][2]} the ${NOUNS[o][0]} near the ${place} in ${month} ${year}.` });
  }
  // a target is usable when no other memory shares its (quality, subject, verb) triple: then it is the one best answer
  const triple = m => `${m.ideas.q}|${m.ideas.n}|${m.ideas.v}`, count = {};
  for (const m of mem) count[triple(m)] = (count[triple(m)] || 0) + 1;
  const targets = mem.filter(m => count[triple(m)] === 1);
  const grade = t => { const g = {}; for (const m of mem) { if (m.id === t.id) { g[m.id] = 3; continue; } const shared = (m.ideas.q === t.ideas.q) + (m.ideas.n === t.ideas.n) + (m.ideas.v === t.ideas.v); if (shared >= 2) g[m.id] = 1; } return g; };
  const make = {
    exact: t => `${QUALITIES[t.ideas.q][0]} ${NOUNS[t.ideas.n][0]} ${VERBS[t.ideas.v][2]}`,
    natural: t => `which ${NOUNS[t.ideas.n][0]} that was ${QUALITIES[t.ideas.q][0]} ${VERBS[t.ideas.v][2]} something`,
    inflected: t => `${QUALITIES[t.ideas.q][0]} ${NOUNS[t.ideas.n][2]} that ${VERBS[t.ideas.v][0]} things`,
    paraphrase: t => `the ${QUALITIES[t.ideas.q][1]} ${NOUNS[t.ideas.n][1]} that chose to ${VERBS[t.ideas.v][1]} something`,
  };
  const queries = [];
  for (const kind of Object.keys(make)) for (let i = 0; i < perKind; i++) { const t = targets[Math.floor(r() * targets.length)]; queries.push({ id: `${kind}-${i + 1}`, kind, target: t.id, text: make[kind](t), grades: grade(t) }); }
  return { seed, memories: mem, queries, kinds: Object.keys(make) };
}

/** For tests: a tiny embedder that knows the generator's synonyms, so the vector arm can be exercised without a model. */
export function conceptEmbedder() {
  const dims = QUALITIES.length + NOUNS.length + VERBS.length, index = new Map();
  QUALITIES.forEach((g, i) => g.forEach(w => index.set(w, i)));
  NOUNS.forEach((g, i) => g.forEach(w => index.set(w, QUALITIES.length + i)));
  VERBS.forEach((g, i) => g.forEach(w => index.set(w, QUALITIES.length + NOUNS.length + i)));
  return async texts => texts.map(t => { const v = new Float32Array(dims); for (const w of String(t).toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/)) if (index.has(w)) v[index.get(w)] += 1; return v; });
}
