/**
 * Memory rank — the arithmetic of hybrid retrieval, and the measures that say whether it helped.
 *
 * Abstracted from gbrain's retrieval pipeline (github.com/garrytan/gbrain, read 2026-11-11) and rebuilt for
 * SQLite: a keyword arm and a vector arm are fused by reciprocal rank (k = 60), re-scored as
 * 0.7 · normalised RRF + 0.3 · cosine, and near-duplicates are dropped. Nothing here touches a database or a
 * model, so every number can be tested.
 */
export const RRF_K = 60;
export const POOL = 50;           // rows each arm contributes before fusion

const STOP = new Set('a an and are as at be but by for from has have how i if in into is it its of on or that the their them then there these they this to was were what when where which who why will with you your did do does not no so than too very can could should would about over under after before again more most some such only own same just also'.split(' '));

/** Words of a text that carry meaning: lower-case, letters and digits, no stop words. */
export function contentWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w));
}

/**
 * An FTS5 MATCH expression. Every word is quoted, so nothing a caller types is read as query syntax.
 * `all: true` requires every word (precise); otherwise any word (the fallback when the strict query finds nothing).
 */
export function ftsQuery(text, { all = true, max = 12 } = {}) {
  const ws = [...new Set(contentWords(text))].slice(0, max);
  if (!ws.length) return null;
  return ws.map(w => `"${w}"`).join(all ? ' AND ' : ' OR ');
}

/**
 * Reciprocal-rank fusion. `lists` are arrays of ids, best first; `weights` scale each list's vote.
 * @returns {Map<id, number>}
 */
export function rrfFuse(lists, weights = [], k = RRF_K) {
  const score = new Map();
  lists.forEach((list, li) => { const w = weights[li] ?? 1; (list || []).forEach((id, rank) => score.set(id, (score.get(id) || 0) + w / (k + rank))); });
  return score;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const jaccard = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; let inter = 0; for (const x of A) if (B.has(x)) inter++; return inter / (A.size + B.size - inter); };

/**
 * Fuse the two arms and order the result.
 * @param keyword  [{ id }] best first (may be empty)
 * @param vector   [{ id, cos }] best first (may be empty)
 * @param textOf   id → text, for dropping near-duplicates (word-set Jaccard above `dupAbove`)
 * @returns [{ id, score, rrf, cos, arms: 'both'|'keyword'|'vector' }]
 */
export function fuse(keyword, vector, { limit = 10, textOf = null, dupAbove = 0.85, keywordWeight = 1, vectorWeight = 1, cosFor = null } = {}) {
  const kIds = keyword.map(r => r.id), vIds = vector.map(r => r.id), cosOf = new Map(vector.map(r => [r.id, r.cos]));
  // `cosFor` supplies a cosine for candidates the vector arm did not return, so the meaning term is applied to every row alike
  if (cosFor) for (const id of kIds) if (!cosOf.has(id)) { const c = cosFor(id); if (c != null) cosOf.set(id, c); }
  const rrf = rrfFuse([kIds, vIds], [keywordWeight, vectorWeight]);
  const max = Math.max(1e-12, ...rrf.values());
  const inK = new Set(kIds), inV = new Set(vIds);
  let rows = [...rrf.entries()].map(([id, r]) => ({ id, rrf: r, cos: cosOf.get(id) ?? null, score: 0.7 * (r / max) + 0.3 * Math.max(0, cosOf.get(id) ?? 0), arms: inK.has(id) && inV.has(id) ? 'both' : inK.has(id) ? 'keyword' : 'vector' }));
  rows.sort((a, b) => b.score - a.score || (a.id > b.id ? 1 : -1));
  if (textOf) {
    const kept = [], sets = [];
    for (const r of rows) { const w = contentWords(textOf(r.id)); if (sets.some(s => jaccard(s, w) > dupAbove)) continue; kept.push(r); sets.push(w); if (kept.length >= limit) break; }
    rows = kept;
  }
  return rows.slice(0, limit);
}

/**
 * Is this memory only the task said back? The runtime stores a line when a run begins ("task:…", or
 * "Autonomous objective (…): <task>"); finding it later is not remembering anything. A memory that goes on to say
 * what happened — an outcome that quotes its goal — is not an echo.
 */
export function isTaskEcho(memory, task) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const t = norm(task).slice(0, 120), v = norm(memory?.value);
  if (t.length < 20 || !v) return false;
  const at = v.indexOf(t);
  if (at < 0) return false;
  const rest = v.length - (at + Math.min(norm(task).length, v.length - at));   // what the memory says after the task text
  return rest < 40 && at < 90;
}

// ── measures ─────────────────────────────────────────────────────────────────────────────────────────

/** `ranked` is a list of ids; `grades` maps id → relevance grade (> 0 means relevant). */
export function precisionAt(ranked, grades, k = 5) { const top = ranked.slice(0, k); return top.length ? top.filter(id => (grades.get(id) || 0) > 0).length / k : 0; }
export function recallAt(ranked, grades, k = 5) { const rel = [...grades.values()].filter(g => g > 0).length; return rel ? ranked.slice(0, k).filter(id => (grades.get(id) || 0) > 0).length / rel : 0; }
export function reciprocalRank(ranked, grades) { const i = ranked.findIndex(id => (grades.get(id) || 0) > 0); return i < 0 ? 0 : 1 / (i + 1); }
export function ndcgAt(ranked, grades, k = 5) {
  const dcg = ranked.slice(0, k).reduce((s, id, i) => s + (grades.get(id) || 0) / Math.log2(i + 2), 0);
  const ideal = [...grades.values()].filter(g => g > 0).sort((a, b) => b - a).slice(0, k).reduce((s, g, i) => s + g / Math.log2(i + 2), 0);
  return ideal ? dcg / ideal : 0;
}
/** Did the one best answer (the highest grade) come first, or in the top k? */
export function hitAt(ranked, grades, k = 1) { const best = Math.max(0, ...grades.values()); return best > 0 && ranked.slice(0, k).some(id => grades.get(id) === best) ? 1 : 0; }

/** Mean of each measure over a set of queries. `runs` = [{ ranked, grades }]. */
export function summarise(runs, k = 5) {
  const n = runs.length || 1, mean = f => +(runs.reduce((s, r) => s + f(r.ranked, r.grades), 0) / n).toFixed(4);
  return { queries: runs.length, hit1: mean((r, g) => hitAt(r, g, 1)), [`hit${k}`]: mean((r, g) => hitAt(r, g, k)), mrr: mean(reciprocalRank), [`p${k}`]: mean((r, g) => precisionAt(r, g, k)), [`r${k}`]: mean((r, g) => recallAt(r, g, k)), [`ndcg${k}`]: mean((r, g) => ndcgAt(r, g, k)) };
}

/**
 * Paired sign-flip randomisation test on per-query differences (seeded, so a report is reproducible).
 * @returns the probability of a mean difference at least this large if the two systems were the same.
 */
export function signFlipP(a, b, { rounds = 4000, seed = 42 } = {}) {
  const d = a.map((x, i) => x - b[i]), obs = Math.abs(d.reduce((s, x) => s + x, 0) / (d.length || 1));
  if (!d.some(x => x !== 0)) return 1;
  let st = seed >>> 0 || 1; const rnd = () => { st ^= st << 13; st >>>= 0; st ^= st >> 17; st ^= st << 5; st >>>= 0; return st / 4294967296; };
  let ge = 0;
  for (let r = 0; r < rounds; r++) { let s = 0; for (const x of d) s += rnd() < 0.5 ? x : -x; if (Math.abs(s / d.length) >= obs - 1e-12) ge++; }
  return +((ge + 1) / (rounds + 1)).toFixed(4);
}
