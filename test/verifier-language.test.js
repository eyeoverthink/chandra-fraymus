// 2026-11-13: a Python verification loop for a factorial function failed all 5 tries. Tries 1, 3, 5: the generator
// wrote JavaScript and the sandbox ran it as Python (SyntaxError on line 1). Tries 2, 4: correct Python unittest
// programs that passed were rejected for not printing ALL PASS. Python loops had passed 1 time in 12.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCodeLanguage, proofOf, languageInstruction, executeCode } from '../server/intelligence/verifier-loop.js';

const JS_TRY = `import { strict as assert } from 'node:assert';
function factorial(n) { if (n < 0) { throw new Error('neg'); } let r = 1; for (let i = 1; i <= n; i++) r *= i; return r; }
assert.strictEqual(factorial(5), 120);
console.log('PASS 5! = 120');
console.log('ALL PASS');`;
const PY_UNITTEST_TRY = `import math
import unittest
def factorial(n):
    if n == 0:
        return 1
    return n * factorial(n - 1)
class TestFactorial(unittest.TestCase):
    def test_values(self):
        self.assertEqual(factorial(5), 120)
if __name__ == '__main__':
    unittest.main()`;

test('the language is read from the code itself — the JavaScript try is JavaScript, the unittest try is Python', () => {
  assert.equal(detectCodeLanguage(JS_TRY), 'javascript');
  assert.equal(detectCodeLanguage(PY_UNITTEST_TRY), 'python', '"import math" is a Python sign, not a JavaScript one');
  assert.equal(detectCodeLanguage('def f(x):\n    return x\nprint(f(2))'), 'python');
  assert.equal(detectCodeLanguage('const f = x => x; console.log(f(2));'), 'javascript');
});

test('proof: ALL PASS, or a stdlib unittest run that ran tests and ended OK', () => {
  assert.deepEqual(proofOf({ exitCode: 0, stdout: 'PASS a\nALL PASS\n', stderr: '' }), { proved: true, how: 'all_pass' });
  // the exact stderr of try 2
  const unittestOk = '.\n----------------------------------------------------------------------\nRan 1 test in 0.000s\n\nOK\n';
  assert.deepEqual(proofOf({ exitCode: 0, stdout: '', stderr: unittestOk }), { proved: true, how: 'unittest' });
  assert.equal(proofOf({ exitCode: 1, stdout: '', stderr: 'Ran 1 test in 0.0s\n\nFAILED (failures=1)\n' }).proved, false);
  assert.equal(proofOf({ exitCode: 0, stdout: '', stderr: 'Ran 0 tests in 0.000s\n\nOK\n' }).proved, false, 'no test ran: nothing was proved');
  assert.equal(proofOf({ exitCode: 0, stdout: 'PASS a\nFAIL b\nALL PASS\n', stderr: '' }).proved, false);
  assert.equal(proofOf({ exitCode: 0, stdout: 'hello', stderr: '' }).proved, false);
});

test('the generator is told the language with a working example of the proof format', () => {
  assert.match(languageInstruction('python'), /Write it in Python 3 — not JavaScript/);
  assert.match(languageInstruction('python'), /print\("ALL PASS"\)/);
  assert.match(languageInstruction('javascript'), /not Python/);
});

test('both real tries now prove themselves when run as what they are', async () => {
  const js = await executeCode(JS_TRY, 'javascript');
  assert.equal(proofOf(js).proved, true, js.stderr);
  const py = await executeCode(PY_UNITTEST_TRY, 'python');
  if (py.exitCode !== 0 && /not found|not recognized|ENOENT/i.test(py.stderr)) return;   // no Python on this machine
  assert.deepEqual(proofOf(py), { proved: true, how: 'unittest' }, py.stderr);
});

test('a program that kept the format example is caught — it proves the example, not the goal', async () => {
  const { copiedExample } = await import('../server/intelligence/verifier-loop.js');
  assert.equal(copiedExample('def solve(x):\n    return x + 2\nchecks = [(solve(2), 4, "solve(2) == 4")]'), true);
  assert.equal(copiedExample("for (const [got, want, what] of [[solve(2), 4, 'solve(2) === 4']]) {}"), true);
  assert.equal(copiedExample('checks = [(solve([1, 3], [2]), [1, 2, 3], "merge")]'), false);
});

test('being stuck is recognised by failing the same way, not by identical code', async () => {
  const { failureSignature } = await import('../server/intelligence/verifier-loop.js');
  const a = { exitCode: 1, stdout: "PASS x\nFAIL solve('user@domain..com') == False: got True\n", stderr: '' };
  const b = { exitCode: 1, stdout: "PASS y\nFAIL solve('user@domain..com') == False: got True\n", stderr: '' };
  assert.equal(failureSignature(a), failureSignature(b), 'same failing check = stuck, whatever else changed');
  const s1 = { exitCode: 1, stdout: '', stderr: '  File "C:\T\chandra-verify-6b96e0a9\verify.py", line 88\nSyntaxError: unterminated string literal (detected at line 88)' };
  const s2 = { exitCode: 1, stdout: '', stderr: '  File "C:\T\chandra-verify-00903ac8\verify.py", line 88\nSyntaxError: unterminated string literal (detected at line 88)' };
  assert.equal(failureSignature(s1), failureSignature(s2), 'the temp folder name does not make two errors different');
});

test('a reply cut off at the length limit is recognised, and its failures compare equal', async () => {
  const { cutOffReply, failureSignature, CUT_OFF_ERROR } = await import('../server/intelligence/verifier-loop.js');
  const runaway = '```python\ndef solve(s):\n    ...\nchecks = [\n' + '    (solve("user@domain.com\x4c"), False, "x"),\n'.repeat(50) + '    (solve("user@do';
  assert.equal(cutOffReply(runaway), true);
  assert.equal(cutOffReply('```python\nprint("ALL PASS")\n```\nSUMMARY'), false);
  const a = failureSignature({ exitCode: 1, stdout: '', stderr: 'SyntaxError: unterminated string literal (detected at line 116)' });
  const b = failureSignature({ exitCode: 1, stdout: '', stderr: 'SyntaxError: unterminated string literal (detected at line 142)' });
  assert.equal(a, b, 'only the line number differs, so it is the same failure');
  assert.equal(failureSignature({ exitCode: 1, stdout: '', stderr: CUT_OFF_ERROR }), failureSignature({ exitCode: 1, stdout: '', stderr: CUT_OFF_ERROR }));
});
