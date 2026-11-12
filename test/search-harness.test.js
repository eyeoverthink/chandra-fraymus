import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { searchSource, hasDomainModel } from '../server/intelligence/search-harness.js';
import { generateTask } from '../server/intelligence/capability-bench.js';

const run = code => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', searchSource(code)], { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, out: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : null, err: r.stderr };
};
// what a coder model should write for the two-jug problem: the rules only, no search
const jugs = (capA, capB, target, limit = 20) => `
const start = { a: 0, b: 0 };
function moves(s) {
  const toB = Math.min(s.a, ${capB} - s.b), toA = Math.min(s.b, ${capA} - s.a);
  return [
    { move: 'fill A', next: { a: ${capA}, b: s.b } }, { move: 'fill B', next: { a: s.a, b: ${capB} } },
    { move: 'empty A', next: { a: 0, b: s.b } }, { move: 'empty B', next: { a: s.a, b: 0 } },
    { move: 'pour A B', next: { a: s.a - toB, b: s.b + toB } }, { move: 'pour B A', next: { a: s.a + toA, b: s.b - toA } },
  ];
}
function isGoal(s) { return s.a === ${target} || s.b === ${target}; }
const maxDepth = ${limit};`;

test('a correct domain model + the fixed search solves every planning task the benchmark can generate (level 1 and 2)', () => {
  for (let seed = 1; seed <= 40; seed++) for (const level of [1, 2]) {
    const t = generateTask('planning', seed, level), { capA, capB, target } = t.params;
    const r = run(jugs(capA, capB, target));
    assert.equal(r.status, 0, r.err);
    assert.ok(t.check(JSON.stringify(r.out.answer)), `seed ${seed} level ${level}: ${JSON.stringify(r.out.answer)}`);
    assert.ok(r.out.answer.length <= t.expected.length, 'breadth-first: never longer than the reference plan');
  }
});

test('an unreachable goal gives no plan, not a wrong one; a malformed model fails loudly', () => {
  const none = run(jugs(4, 6, 3));       // gcd 2: 3 litres can never be measured
  assert.equal(none.status, 0); assert.equal(none.out.answer, null); assert.ok(none.out.states > 1);
  const bad = run('const start = 0; function moves(s) { return [s + 1]; } function isGoal(s) { return s === 3; } const maxDepth = 5;');
  assert.notEqual(bad.status, 0); assert.match(bad.err, /moves\(\) must return objects/);
  assert.equal(run('const start = 0; function moves(s) { return [{ move: "inc", next: s + 1 }]; } function isGoal(s) { return s === 3; }').out.answer.length, 3, 'maxDepth defaults to 30 when not given');
  assert.equal(hasDomainModel('const start = 0; function moves(s) {} function isGoal(s) {}'), true);
  assert.equal(hasDomainModel('function solve() {}'), false);
});
