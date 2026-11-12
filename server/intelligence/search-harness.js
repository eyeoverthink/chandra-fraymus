/**
 * Search harness for the reasoner's `search` strategy. Pure: no DB, no model.
 *
 * The model writes a domain model from a problem's stated rules — `start`, `moves(state)`, `isGoal(state)`,
 * `maxDepth` — and this fixed breadth-first search finds the shortest sequence of moves that reaches the goal within
 * the problem's own limit. Fewest moves first, so a plan never wanders past a stated move limit the way a
 * hand-written search did.
 *
 *   hasDomainModel(code)   does the reply define start, moves and isGoal?
 *   searchSource(code)     the program to run in the sandbox: the model plus the search; prints {answer, explored, states}
 */
export const MAX_STATES = 200_000;

export const SEARCH_HARNESS = `
const __key = s => JSON.stringify(s);
let __found = null, __explored = 0;
if (isGoal(start)) __found = [];
const __seen = new Set([__key(start)]);
let __layer = [{ s: start, path: [] }];
for (let d = 0; d < maxDepth && !__found && __layer.length; d++) {
  const __next = [];
  for (const { s, path } of __layer) {
    __explored++;
    for (const m of moves(s)) {
      if (!m || typeof m.move !== 'string') throw new Error('moves() must return objects like { move: "...", next: state }');
      const k = __key(m.next);
      if (__seen.has(k)) continue;
      __seen.add(k);
      const p = [...path, m.move];
      if (isGoal(m.next)) { __found = p; break; }
      __next.push({ s: m.next, path: p });
    }
    if (__found || __seen.size > ${MAX_STATES}) break;
  }
  __layer = __next;
}
process.stdout.write('\\n' + JSON.stringify({ answer: __found, explored: __explored, states: __seen.size }) + '\\n');
`;

export const hasDomainModel = code => !!code && /\bstart\b/.test(code) && /function\s+moves\s*\(/.test(code) && /function\s+isGoal\s*\(/.test(code);

export function searchSource(code) {
  const body = String(code).replace(/^\s*export\s+(default\s+)?/gm, '');
  return `${/\bmaxDepth\b/.test(body) ? body : `${body}\nconst maxDepth = 30;`}\n${SEARCH_HARNESS}`;
}
