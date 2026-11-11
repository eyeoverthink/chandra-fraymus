/**
 * Memory gold — measuring recall on the REAL store, where nobody has written down the right answers.
 *
 * The generated benchmark (memory-bench.js) proves the mechanism. This measures the thing it is for: when an
 * agent is given a real task, are the memories put in front of it about that task? The method is the pooling
 * method used for search evaluation:
 *   1. real tasks  — objectives that agents were actually given (goal_executions), each with the agent that ran it
 *   2. pool        — the top results of every system under test for that task, merged and shuffled, so the
 *                    judge cannot tell which system proposed which memory
 *   3. judge       — a local model grades each (task, memory) pair 0, 1 or 2; a share of pairs is judged twice
 *                    to report how far the judge agrees with itself, and planted pairs check it can tell
 *                    an obviously unrelated memory from the task's own text
 *   4. freeze      — the judged pairs are written to data/memory-gold/; from then on any change to the search
 *                    is re-scored against the same file in seconds, with no model in the loop
 * A memory nobody judged counts as not relevant; `judgedShare` says how much of what a system returned was judged.
 *
 * Pure: no database, no model, no clock. The runner that samples, judges and writes the file is an operator
 * script (F:/Claude-Work/chandra-superintelligence/memory/build-real-gold.mjs).
 */
import { precisionAt, reciprocalRank, ndcgAt } from './memory-rank.js';

export const GRADES = Object.freeze({ 0: 'not about the task', 1: 'same subject, would not change how the task is done', 2: 'directly useful for doing this task' });

function rng(seed) { let a = seed >>> 0 || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function shuffleSeeded(list, seed) { const r = rng(seed), a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Merge the top `depth` of every system's ranking into one de-duplicated, shuffled pool. */
export function poolCandidates(rankings, { depth = 5, seed = 1 } = {}) {
  const ids = new Set();
  for (const list of Object.values(rankings)) for (const id of (list || []).slice(0, depth)) ids.add(id);
  return shuffleSeeded([...ids].sort((a, b) => a - b), seed);
}

/** The judge's instructions. The memories are numbered; nothing says where they came from. */
export function judgeMessages(task, memories) {
  const system = [
    'You judge whether notes are relevant to a task. You are strict and literal.',
    'For each numbered note give one grade:',
    '2 = directly useful for doing THIS task: it states a fact, result or decision the task needs.',
    '1 = about the same subject, but it would not change how the task is done.',
    '0 = not about the task, or only shares general words with it.',
    'Most notes deserve 0 or 1. Sharing words like "system", "model", "pattern" or "integration" is not relevance.',
    `Reply with JSON only: {"grades": [g1, g2, ...]} with exactly ${memories.length} numbers, in order.`,
  ].join('\n');
  const user = `TASK:\n${String(task).slice(0, 600)}\n\nNOTES:\n${memories.map((m, i) => `${i + 1}. ${String(m).replace(/\s+/g, ' ').slice(0, 420)}`).join('\n')}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** Read the judge's reply. Returns null unless it holds exactly `n` grades of 0, 1 or 2. */
export function parseGrades(raw, n) {
  let obj = raw;
  if (typeof raw === 'string') { const a = raw.indexOf('{'), z = raw.lastIndexOf('}'); try { obj = a >= 0 && z > a ? JSON.parse(raw.slice(a, z + 1)) : null; } catch (_) { obj = null; } }
  const g = obj && Array.isArray(obj.grades) ? obj.grades.map(Number) : null;
  return g && g.length === n && g.every(x => x === 0 || x === 1 || x === 2) ? g : null;
}

/** How far two gradings of the same pairs agree: exactly, on relevant-or-not, and Cohen's kappa on relevant-or-not. */
export function agreement(a, b) {
  const n = Math.min(a.length, b.length); if (!n) return { pairs: 0, exact: null, binary: null, kappa: null };
  let exact = 0, bin = 0, a1 = 0, b1 = 0;
  for (let i = 0; i < n; i++) { if (a[i] === b[i]) exact++; const x = a[i] > 0, y = b[i] > 0; if (x === y) bin++; if (x) a1++; if (y) b1++; }
  const po = bin / n, pe = (a1 / n) * (b1 / n) + (1 - a1 / n) * (1 - b1 / n);
  return { pairs: n, exact: +(exact / n).toFixed(3), binary: +po.toFixed(3), kappa: pe >= 1 ? null : +((po - pe) / (1 - pe)).toFixed(3) };
}

/**
 * Score rankings against a frozen gold file.
 * @param gold      { queries: [{ id, grades: { memoryId: 0|1|2 } }] }
 * @param rankings  { system: { queryId: [memoryId, ...] } }
 */
export function scoreGold(gold, rankings, k = 5) {
  const out = {};
  for (const [system, byQuery] of Object.entries(rankings)) {
    let n = 0, p = 0, strict = 0, mrr = 0, ndcg = 0, mean = 0, judged = 0, returned = 0, empty = 0;
    for (const q of gold.queries) {
      const ranked = (byQuery[q.id] || []).slice(0, k), grades = new Map(Object.entries(q.grades).map(([id, g]) => [Number(id), g]));
      n++; if (!ranked.length) empty++;
      p += precisionAt(ranked, grades, k); strict += ranked.filter(id => grades.get(id) === 2).length / k;
      mrr += reciprocalRank(ranked, grades); ndcg += ndcgAt(ranked, grades, k);
      mean += ranked.reduce((s, id) => s + (grades.get(id) || 0), 0) / k;
      returned += ranked.length; judged += ranked.filter(id => grades.has(id)).length;
    }
    const r = x => +(x / (n || 1)).toFixed(4);
    out[system] = { queries: n, [`p${k}`]: r(p), [`useful${k}`]: r(strict), mrr: r(mrr), [`ndcg${k}`]: r(ndcg), meanGrade: r(mean), answeredNothing: empty, judgedShare: returned ? +(judged / returned).toFixed(3) : null };
  }
  return out;
}
