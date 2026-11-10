/**
 * Capability Benchmark — Phase AD.
 *
 * Procedurally generated, machine-graded problems across eight unrelated families. Pure module:
 * no DB, no LLM, no clock — generateTask(family, seed, level) is a function of its arguments, so
 * every seed is a fresh held-out problem and any item can be regenerated from (family, seed, level).
 *
 * A task is { family, seed, level, prompt, answerType, examples?, query?, expected, check }.
 * `expected` and `check` are the grader's side; hand the solver only publicView(task).
 * check(answer, { run }) → boolean | Promise<boolean>. Only the `code` family needs `run`
 * (source → { output }) because its answers are programs graded by hidden tests.
 */

export const FAMILIES = ['arithmetic', 'algebra', 'logic', 'sequence', 'transform', 'planning', 'code', 'memory'];

// ── seeded PRNG ──────────────────────────────────────────────────────────────
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function familySalt(family) { let h = 2166136261; for (const ch of family) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(family, seed, level) {
  const r = mulberry32((familySalt(family) ^ Math.imul(seed | 0, 2654435761) ^ (level * 97)) >>> 0);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const nonzero = (lo, hi) => { let v = 0; while (v === 0) v = int(lo, hi); return v; };
  return { r, int, pick, shuffle, nonzero };
}

// ── answer normalisation ─────────────────────────────────────────────────────
export function toNumber(answer) {
  if (typeof answer === 'number') return Number.isFinite(answer) ? answer : null;
  if (answer == null) return null;
  const m = String(answer).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g);
  return m ? Number(m[m.length - 1]) : null;
}
export function toPlain(answer) {
  if (answer == null) return '';
  return String(answer).trim().replace(/^[`"'“”‘’\s]+|[`"'“”‘’\s.]+$/g, '').trim();
}
export function toList(answer) {
  if (Array.isArray(answer)) return answer;
  if (answer == null) return null;
  const s = String(answer);
  const m = s.match(/\[[\s\S]*\]/);
  if (m) { try { const v = JSON.parse(m[0]); if (Array.isArray(v)) return v; } catch (_) { /* fall through to line parsing */ } }
  const lines = s.split(/\r?\n|;|,/).map(x => x.replace(/^\s*(?:\d+[.)]|[-*])\s*/, '').trim()).filter(Boolean);
  return lines.length ? lines : null;
}
const numEq = expected => answer => { const n = toNumber(answer); return n !== null && Math.abs(n - expected) < 1e-9; };
const nameEq = expected => answer => toPlain(answer).toLowerCase() === String(expected).toLowerCase();

// ── families ─────────────────────────────────────────────────────────────────
function arithmetic(seed, level) {
  const g = rng('arithmetic', seed, level);
  const a = g.int(12, 49), b = g.int(12, 49), c = g.int(100, 999), d = g.int(3, 19), e = g.int(11, 39);
  if (level >= 2) {
    const m = g.pick([7, 11, 13, 17, 19, 23]);
    const expected = (((a * b + c) * d - e) % m + m) % m;
    return { prompt: `Compute the remainder when (${a} × ${b} + ${c}) × ${d} − ${e} is divided by ${m}.`, answerType: 'number', expected, check: numEq(expected) };
  }
  const form = g.int(0, 2);
  if (form === 0) { const expected = a * b + c - d * e; return { prompt: `Compute: ${a} × ${b} + ${c} − ${d} × ${e}`, answerType: 'number', expected, check: numEq(expected) }; }
  if (form === 1) { const expected = (a + b) * d - c; return { prompt: `Compute: (${a} + ${b}) × ${d} − ${c}`, answerType: 'number', expected, check: numEq(expected) }; }
  const expected = c * d - a * b + e;
  return { prompt: `Compute: ${c} × ${d} − ${a} × ${b} + ${e}`, answerType: 'number', expected, check: numEq(expected) };
}

const term = (coef, v) => `${coef === 1 ? '' : coef === -1 ? '−' : coef < 0 ? `−${-coef}` : coef}${v}`;
const signed = n => (n < 0 ? `− ${-n}` : `+ ${n}`);
function algebra(seed, level) {
  const g = rng('algebra', seed, level);
  if (level >= 2) {
    const x = g.int(-9, 9), y = g.int(-9, 9);
    let a1, b1, a2, b2;
    do { a1 = g.nonzero(-6, 6); b1 = g.nonzero(-6, 6); a2 = g.nonzero(-6, 6); b2 = g.nonzero(-6, 6); } while (a1 * b2 - a2 * b1 === 0);
    const expected = [x, y];
    return {
      prompt: `Solve the system for integers x and y:\n${term(a1, 'x')} ${signed(b1)}y = ${a1 * x + b1 * y}\n${term(a2, 'x')} ${signed(b2)}y = ${a2 * x + b2 * y}\nAnswer as a JSON array [x, y].`.replace(/([+−] )1y/g, '$1y'),
      answerType: 'list', expected,
      check: ans => { const l = toList(ans); return !!l && l.length === 2 && Number(l[0]) === x && Number(l[1]) === y; },
    };
  }
  const x = g.int(-12, 12);
  let a, c; do { a = g.int(2, 9); c = g.int(2, 9); } while (a === c);
  const b = g.int(-30, 30), d = (a - c) * x + b;
  return { prompt: `Solve for x: ${a}x ${signed(b)} = ${c}x ${signed(d)}`, answerType: 'number', expected: x, check: numEq(x) };
}

const NAMES = ['Ava', 'Ben', 'Cleo', 'Dev', 'Elif', 'Finn', 'Gus', 'Hana', 'Ivo', 'Juno', 'Kai', 'Lena', 'Milo', 'Nora', 'Omar', 'Pia'];
function logic(seed, level) {
  const g = rng('logic', seed, level);
  const n = level >= 2 ? 7 : 5;
  const order = g.shuffle(NAMES).slice(0, n); // tallest → shortest
  const facts = g.shuffle(order.slice(0, -1).map((p, i) => (g.r() < 0.5 ? `${p} is taller than ${order[i + 1]}.` : `${order[i + 1]} is shorter than ${p}.`)));
  const k = g.int(2, n - 1);
  const ord = ['', 'tallest', 'second tallest', 'third tallest', 'fourth tallest', 'fifth tallest', 'sixth tallest'][k];
  const expected = order[k - 1];
  return { prompt: `${n} people have different heights.\n${facts.join('\n')}\nWho is the ${ord}? Answer with the name only.`, answerType: 'string', expected, check: nameEq(expected) };
}

function sequence(seed, level) {
  const g = rng('sequence', seed, level);
  const kind = g.pick(level >= 2 ? ['quadratic', 'fib', 'alt', 'recur'] : ['arith', 'geo', 'quadratic', 'fib', 'alt']);
  let f; // 1-based index → value
  if (kind === 'arith') { const a = g.int(-20, 40), d = g.nonzero(-9, 12); f = n => a + d * (n - 1); }
  else if (kind === 'geo') { const a = g.int(1, 6), r = g.pick([2, 3, -2]); f = n => a * r ** (n - 1); }
  else if (kind === 'quadratic') { const a = g.int(1, 4), b = g.int(-5, 5), c = g.int(-9, 9); f = n => a * n * n + b * n + c; }
  else if (kind === 'alt') { const a = g.int(1, 20), p = g.int(2, 9), q = g.nonzero(-6, -1); f = n => a + Math.ceil((n - 1) / 2) * p + Math.floor((n - 1) / 2) * q; }
  else {
    const x1 = g.int(1, 6), x2 = g.int(1, 6), k = kind === 'recur' ? g.int(1, 4) : 0, m = kind === 'recur' ? 2 : 1;
    const memo = [0, x1, x2];
    f = n => { for (let i = memo.length; i <= n; i++) memo[i] = memo[i - 1] + m * memo[i - 2] + k; return memo[n]; };
  }
  const shown = 6, terms = Array.from({ length: shown }, (_, i) => f(i + 1));
  const expected = f(shown + 1);
  return {
    prompt: `Find the next number in the sequence: ${terms.join(', ')}, ?`,
    answerType: 'number', expected, check: numEq(expected),
    examples: terms.map((v, i) => ({ input: i + 1, output: v })), query: shown + 1,
  };
}

const VOWELS = new Set('aeiou');
const PRIMS = {
  reverse: () => s => [...s].reverse().join(''),
  upper: () => s => s.toUpperCase(),
  rotate: g => { const k = g.int(1, 3); return s => s.slice(k % s.length) + s.slice(0, k % s.length); },
  swapHalves: () => s => { const h = Math.floor(s.length / 2); return s.slice(h) + s.slice(0, h); },
  double: () => s => [...s].map(c => c + c).join(''),
  dropVowels: () => s => [...s].filter(c => !VOWELS.has(c.toLowerCase())).join(''),
  sort: () => s => [...s].sort().join(''),
  caesar: g => { const k = g.int(1, 3); return s => [...s].map(c => (/[a-z]/.test(c) ? String.fromCharCode((c.charCodeAt(0) - 97 + k) % 26 + 97) : /[A-Z]/.test(c) ? String.fromCharCode((c.charCodeAt(0) - 65 + k) % 26 + 65) : c)).join(''); },
};
function transform(seed, level) {
  const g = rng('transform', seed, level);
  const word = () => { const len = g.int(5, 8); let w = ''; for (let i = 0; i < len; i++) w += (i % 2 ? g.pick([...'aeiou']) : g.pick([...'bcdfghklmnprstvz'])); return w; };
  const keys = g.shuffle(Object.keys(PRIMS)).slice(0, level >= 2 ? 2 : 1);
  const fns = keys.map(k => PRIMS[k](g));
  const apply = s => fns.reduce((acc, fn) => fn(acc), s);
  const inputs = []; while (inputs.length < 5) { const w = word(); if (!inputs.includes(w) && apply(w) !== w) inputs.push(w); }
  const examples = inputs.slice(0, 4).map(w => ({ input: w, output: apply(w) }));
  const query = inputs[4], expected = apply(query);
  return {
    prompt: `A hidden rule transforms strings. Examples:\n${examples.map(e => `${e.input} -> ${e.output}`).join('\n')}\nApply the same rule to: ${query}\nAnswer with the resulting string only.`,
    answerType: 'string', expected, examples, query, rule: keys,
    check: ans => toPlain(ans) === expected,
  };
}

const MOVE_PATTERNS = [
  [/^fill\s*(?:jug\s*)?a$/, 'fill A'], [/^fill\s*(?:jug\s*)?b$/, 'fill B'],
  [/^empty\s*(?:jug\s*)?a$/, 'empty A'], [/^empty\s*(?:jug\s*)?b$/, 'empty B'],
  [/^pour\s*(?:jug\s*)?a\s*(?:->|→|to|into)?\s*(?:jug\s*)?b$/, 'pour A B'], [/^pour\s*(?:jug\s*)?b\s*(?:->|→|to|into)?\s*(?:jug\s*)?a$/, 'pour B A'],
];
export function normaliseMove(m) {
  const s = String(m ?? '').toLowerCase().replace(/["'.]/g, '').replace(/\s+/g, ' ').trim();
  for (const [re, canon] of MOVE_PATTERNS) if (re.test(s)) return canon;
  return null;
}
export function simulateJugs(capA, capB, moves) {
  let a = 0, b = 0;
  for (const raw of moves) {
    const m = normaliseMove(raw);
    if (!m) return { ok: false, a, b, error: `unknown move: ${String(raw).slice(0, 40)}` };
    if (m === 'fill A') a = capA; else if (m === 'fill B') b = capB;
    else if (m === 'empty A') a = 0; else if (m === 'empty B') b = 0;
    else if (m === 'pour A B') { const t = Math.min(a, capB - b); a -= t; b += t; }
    else { const t = Math.min(b, capA - a); b -= t; a += t; }
  }
  return { ok: true, a, b };
}
function solveJugs(capA, capB, target) {
  const start = '0,0', seen = new Map([[start, null]]), queue = [[0, 0]];
  const all = ['fill A', 'fill B', 'empty A', 'empty B', 'pour A B', 'pour B A'];
  while (queue.length) {
    const [a, b] = queue.shift();
    if (a === target || b === target) { const path = []; let k = `${a},${b}`; while (seen.get(k)) { const [prev, mv] = seen.get(k); path.unshift(mv); k = prev; } return path; }
    for (const mv of all) {
      let na = a, nb = b;
      if (mv === 'fill A') na = capA; else if (mv === 'fill B') nb = capB; else if (mv === 'empty A') na = 0; else if (mv === 'empty B') nb = 0;
      else if (mv === 'pour A B') { const t = Math.min(a, capB - b); na = a - t; nb = b + t; } else { const t = Math.min(b, capA - a); nb = b - t; na = a + t; }
      const key = `${na},${nb}`;
      if (!seen.has(key)) { seen.set(key, [`${a},${b}`, mv]); queue.push([na, nb]); }
    }
  }
  return null;
}
const MAX_PLAN_MOVES = 20;
function planning(seed, level) {
  const g = rng('planning', seed, level);
  const [capA, capB] = g.pick(level >= 2 ? [[5, 11], [7, 9], [4, 13], [7, 12]] : [[3, 5], [4, 7], [5, 8], [3, 7], [4, 9], [5, 7], [3, 8]]);
  let target, plan;
  do { target = g.int(1, capB - 1); plan = solveJugs(capA, capB, target); } while (target === capA || !plan || plan.length < 3);
  return {
    prompt: `You have two empty jugs: jug A holds ${capA} litres, jug B holds ${capB} litres, and an unlimited tap.\nAllowed moves (exact wording): "fill A", "fill B", "empty A", "empty B", "pour A B" (pour A into B until A is empty or B is full), "pour B A".\nGive a sequence of at most ${MAX_PLAN_MOVES} moves after which one of the jugs holds exactly ${target} litres.\nAnswer as a JSON array of move strings.`,
    answerType: 'list', expected: plan, params: { capA, capB, target },
    check: ans => { const l = toList(ans); if (!l || !l.length || l.length > MAX_PLAN_MOVES) return false; const s = simulateJugs(capA, capB, l); return s.ok && (s.a === target || s.b === target); },
  };
}

// code: each template → { spec, ref (source of `function solve(input)`), gen (g → input) }
const CODE_TEMPLATES = [
  g => { const a = g.pick([3, 4, 6]), b = g.pick([5, 7, 11]); return { spec: `Given a positive integer n, return the sum of all integers from 1 to n (inclusive) that are divisible by ${a} or by ${b}.`, ref: `function solve(input) { let s = 0; for (let i = 1; i <= input; i++) if (i % ${a} === 0 || i % ${b} === 0) s += i; return s; }`, gen: () => g.int(1, 200) }; },
  g => { const k = g.int(3, 5); return { spec: `Given a string of lowercase words separated by single spaces, return how many words have more than ${k} letters.`, ref: `function solve(input) { return input.split(' ').filter(w => w.length > ${k}).length; }`, gen: () => Array.from({ length: g.int(1, 7) }, () => 'abcdefghij'.slice(0, g.int(1, 9))).join(' ') }; },
  g => ({ spec: 'Given a non-empty string of lowercase letters, return its run-length encoding: each maximal run of the same letter becomes the letter followed by the run length (e.g. "aaabcc" -> "a3b1c2").', ref: `function solve(input) { let out = '', i = 0; while (i < input.length) { let j = i; while (j < input.length && input[j] === input[i]) j++; out += input[i] + (j - i); i = j; } return out; }`, gen: () => { let s = ''; const runs = g.int(1, 5); for (let i = 0; i < runs; i++) s += 'abcxyz'[g.int(0, 5)].repeat(g.int(1, 4)); return s; } }),
  g => { const base = g.pick([2, 3, 5, 7]); return { spec: `Given a non-negative integer n, return the sum of the digits of n written in base ${base}.`, ref: `function solve(input) { let n = input, s = 0; while (n > 0) { s += n % ${base}; n = Math.floor(n / ${base}); } return s; }`, gen: () => g.int(0, 5000) }; },
  g => { const k = g.int(2, 9); return { spec: `Given an array of integers, return the sum of the elements at even indices (0, 2, 4, …) that are greater than ${k}.`, ref: `function solve(input) { let s = 0; for (let i = 0; i < input.length; i += 2) if (input[i] > ${k}) s += input[i]; return s; }`, gen: () => Array.from({ length: g.int(0, 9) }, () => g.int(-5, 20)) }; },
  g => ({ spec: 'Given an array of integers (possibly empty), return the length of the longest run of consecutive equal elements (0 for an empty array).', ref: `function solve(input) { let best = 0, cur = 0; for (let i = 0; i < input.length; i++) { cur = i > 0 && input[i] === input[i - 1] ? cur + 1 : 1; if (cur > best) best = cur; } return best; }`, gen: () => { const out = []; const runs = g.int(0, 5); for (let i = 0; i < runs; i++) { const v = g.int(0, 3), len = g.int(1, 4); for (let j = 0; j < len; j++) out.push(v); } return out; } }),
  g => { const k = g.int(2, 4); return { spec: `Given an array of distinct integers with at least ${k} elements, return the ${['', '', 'second', 'third', 'fourth'][k]} largest value.`, ref: `function solve(input) { return [...input].sort((a, b) => b - a)[${k - 1}]; }`, gen: () => g.shuffle(Array.from({ length: 30 }, (_, i) => i - 10)).slice(0, g.int(k, 9)) }; },
  g => ({ spec: 'Given a string, return true if it reads the same forwards and backwards when only letters are considered and case is ignored, otherwise false.', ref: `function solve(input) { const s = input.toLowerCase().replace(/[^a-z]/g, ''); return s === [...s].reverse().join(''); }`, gen: () => { const base = ['ab', 'Abc', 'x', 'No on', 'r a,c'][g.int(0, 4)]; return g.int(0, 1) ? base + [...base].reverse().join('') : base + 'q' + base; } }),
];
export function codeHarness(code, tests) {
  const body = String(code).replace(/^\s*export\s+(default\s+)?/gm, '');
  return `${body}\nconst __tests = ${JSON.stringify(tests)};\nconst __fails = [];\nlet __pass = 0;\nfor (const t of __tests) { try { const got = solve(JSON.parse(JSON.stringify(t.input))); if (JSON.stringify(got) === JSON.stringify(t.expect)) __pass++; else __fails.push({ input: t.input, expect: t.expect, got: got === undefined ? 'undefined' : got }); } catch (e) { __fails.push({ input: t.input, expect: t.expect, error: String(e && e.message).slice(0, 120) }); } }\nprocess.stdout.write('\\n' + JSON.stringify({ pass: __pass, total: __tests.length, fails: __fails.slice(0, 3) }) + '\\n');\n`;
}
export function extractFunction(answer) {
  const s = String(answer ?? '');
  const fence = s.match(/```(?:javascript|js|mjs)?\b[^\n]*\n([\s\S]*?)```/);
  const code = (fence ? fence[1] : s).trim();
  return /\bfunction\s+solve\s*\(|\b(?:const|let|var)\s+solve\s*=/.test(code) ? code : null;
}
function code(seed, level) {
  const g = rng('code', seed, level);
  const t = g.pick(CODE_TEMPLATES)(g);
  const ref = new Function(`${t.ref}; return solve;`)(); // grader-side only: our own reference source
  const seen = new Set(), tests = [];
  for (let guard = 0; tests.length < 9 && guard < 200; guard++) { const input = t.gen(); const k = JSON.stringify(input); if (seen.has(k)) continue; seen.add(k); tests.push({ input, expect: ref(JSON.parse(k)) }); }
  const pub = tests.slice(0, 3), hidden = tests.slice(3);
  return {
    prompt: `Write a JavaScript function \`function solve(input)\` for this specification.\n${t.spec}\nExamples:\n${pub.map(e => `solve(${JSON.stringify(e.input)}) -> ${JSON.stringify(e.expect)}`).join('\n')}\nAnswer with the function only, in a \`\`\`js code block. No imports, no console output.`,
    answerType: 'code', expected: t.ref, examples: pub.map(e => ({ input: e.input, output: e.expect })), hiddenTests: hidden,
    check: async (ans, { run } = {}) => {
      const fn = extractFunction(ans);
      if (!fn || typeof run !== 'function') return false;
      const r = await run(codeHarness(fn, hidden));
      return !!r?.output && r.output.total === hidden.length && r.output.pass === hidden.length;
    },
  };
}

const CITIES = ['Oslo', 'Lima', 'Kyoto', 'Quito', 'Perth', 'Turin', 'Dakar', 'Hanoi', 'Split', 'Leeds'];
const PETS = ['parrot', 'ferret', 'gecko', 'beagle', 'rabbit', 'tortoise', 'hamster', 'heron', 'koi', 'lynx'];
const COLORS = ['teal', 'amber', 'violet', 'crimson', 'olive', 'ivory', 'indigo', 'coral', 'slate', 'ochre'];
function memory(seed, level) {
  const g = rng('memory', seed, level);
  const n = level >= 2 ? 9 : 6;
  const people = g.shuffle(NAMES).slice(0, n);
  const city = g.shuffle(CITIES), pet = g.shuffle(PETS), color = g.shuffle(COLORS);
  const manager = people.map((_, i) => people[(i + g.int(1, n - 1)) % n]);
  const facts = [];
  people.forEach((p, i) => {
    facts.push(`${p} lives in ${city[i]}.`, `${p} owns a ${pet[i]}.`, `${p}'s favourite colour is ${color[i]}.`, `${p}'s manager is ${manager[i]}.`);
  });
  const i = g.int(0, n - 1), attr = g.pick(['city', 'pet', 'colour']);
  const hop2 = level >= 2 || g.r() < 0.5;
  const j = hop2 ? people.indexOf(manager[i]) : i;
  const expected = attr === 'city' ? city[j] : attr === 'pet' ? pet[j] : color[j];
  const who = hop2 ? `the manager of ${people[i]}` : people[i];
  const question = attr === 'city' ? `In which city does ${who} live?` : attr === 'pet' ? `What animal does ${who} own?` : `What is the favourite colour of ${who}?`;
  return { prompt: `Read the facts, then answer the question.\n${g.shuffle(facts).join(' ')}\nQuestion: ${question} Answer with one word.`, answerType: 'string', expected, hops: hop2 ? 2 : 1, check: nameEq(expected) };
}

const GENERATORS = { arithmetic, algebra, logic, sequence, transform, planning, code, memory };

export function generateTask(family, seed, level = 1) {
  const gen = GENERATORS[family];
  if (!gen) throw new Error(`unknown family: ${family}`);
  const lv = Math.max(1, Math.min(2, Math.floor(level) || 1));
  return { family, seed: seed | 0, level: lv, ...gen(seed | 0, lv) };
}

/** The solver-visible part of a task — never includes expected, hidden tests or the rule. */
export function publicView(task) {
  return { family: task.family, prompt: task.prompt, answerType: task.answerType, examples: task.examples, query: task.query };
}

export function generateBattery({ perFamily = 2, baseSeed = 1, level = 1, families = FAMILIES } = {}) {
  const out = [];
  for (const family of families) for (let i = 0; i < perFamily; i++) out.push(generateTask(family, baseSeed + i * 7919, level));
  return out;
}

/**
 * items: [{ family, correct (bool), skipped (bool), confidence (0–1 | null) }]
 * g = unweighted mean of per-family accuracy; skipped items are excluded, never counted wrong.
 */
export function scoreItems(items) {
  const byFamily = {};
  let brierSum = 0, brierN = 0, correct = 0, scored = 0, skipped = 0;
  for (const it of items) {
    const f = (byFamily[it.family] ||= { n: 0, correct: 0, skipped: 0, accuracy: null });
    if (it.skipped) { f.skipped++; skipped++; continue; }
    f.n++; scored++;
    if (it.correct) { f.correct++; correct++; }
    if (typeof it.confidence === 'number' && Number.isFinite(it.confidence)) { brierSum += (it.confidence - (it.correct ? 1 : 0)) ** 2; brierN++; }
  }
  const accs = [];
  for (const f of Object.values(byFamily)) if (f.n > 0) { f.accuracy = f.correct / f.n; accs.push(f.accuracy); }
  return {
    g: accs.length ? accs.reduce((a, b) => a + b, 0) / accs.length : null,
    brier: brierN ? brierSum / brierN : null,
    n: scored, correct, skipped, families: accs.length, byFamily,
  };
}
