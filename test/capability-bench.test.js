import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { FAMILIES, generateTask, generateBattery, publicView, scoreItems, simulateJugs, toNumber, toList, extractFunction } from '../server/intelligence/capability-bench.js';

// grader-side runner for code tasks: run the harness source in a child node, parse the last stdout line
const run = source => new Promise(resolve => {
  execFile(process.execPath, ['--input-type=module', '-e', source], { timeout: 10_000 }, (err, stdout) => {
    const last = String(stdout).trim().split('\n').pop();
    try { resolve({ output: JSON.parse(last) }); } catch (_) { resolve({ output: null, error: err?.message }); }
  });
});

test('generators are deterministic per (family, seed, level)', () => {
  for (const family of FAMILIES) for (const level of [1, 2]) {
    const a = generateTask(family, 4242, level), b = generateTask(family, 4242, level);
    assert.equal(a.prompt, b.prompt, family);
    assert.deepEqual(a.expected, b.expected, family);
    assert.notEqual(generateTask(family, 4243, level).prompt, a.prompt, `${family} varies with seed`);
  }
});

test("every task's own expected answer passes its checker", async () => {
  for (const family of FAMILIES) for (const level of [1, 2]) for (let seed = 1; seed <= 25; seed++) {
    const t = generateTask(family, seed * 31, level);
    assert.equal(await t.check(t.expected, { run }), true, `${family} L${level} seed ${seed * 31}`);
  }
});

test('wrong answers fail', async () => {
  for (const family of FAMILIES) {
    const t = generateTask(family, 99, 1);
    const wrong = t.answerType === 'number' ? t.expected + 1 : t.answerType === 'list' ? ['fill A'] : t.answerType === 'code' ? 'function solve(input) { return null; }' : 'zzzz';
    assert.equal(await t.check(wrong, { run }), false, family);
    assert.equal(await t.check(null, { run }), false, `${family} null`);
  }
});

test('publicView never leaks the grader side', () => {
  for (const t of generateBattery({ perFamily: 2, baseSeed: 7 })) {
    const v = publicView(t);
    assert.deepEqual(Object.keys(v).sort(), ['answerType', 'examples', 'family', 'prompt', 'query']);
    assert.ok(!('expected' in v) && !('hiddenTests' in v) && !('rule' in v));
  }
});

test('planning accepts any valid plan and rejects invalid ones', () => {
  const t = generateTask('planning', 5, 1);
  const { capA, capB, target } = t.params;
  const s = simulateJugs(capA, capB, t.expected);
  assert.ok(s.a === target || s.b === target);
  assert.equal(t.check(JSON.stringify(t.expected)), true, 'JSON string form');
  assert.equal(t.check(t.expected.map(m => m.replace('pour A B', 'Pour A into B'))), true, 'wording variants');
  assert.equal(t.check(['teleport']), false);
  assert.equal(t.check(Array(21).fill('fill A')), false, 'over the move limit');
});

test('normalisers', () => {
  assert.equal(toNumber('The answer is 1,234.'), 1234);
  assert.equal(toNumber('x = -7'), -7);
  assert.equal(toNumber('none'), null);
  assert.deepEqual(toList('moves: ["fill A", "pour A B"]'), ['fill A', 'pour A B']);
  assert.ok(extractFunction('```js\nfunction solve(input) { return 1; }\n```'));
  assert.equal(extractFunction('```json\n{"a":1}\n```'), null);
});

test('g is the unweighted family mean; skipped items are excluded', () => {
  const s = scoreItems([
    { family: 'a', correct: true, confidence: 1 }, { family: 'a', correct: true, confidence: 1 }, { family: 'a', correct: true, confidence: 1 }, { family: 'a', correct: true, confidence: 1 },
    { family: 'b', correct: false, confidence: 1 },
    { family: 'c', skipped: true },
  ]);
  assert.equal(s.g, 0.5);
  assert.equal(s.families, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.brier, 0.2);
});
