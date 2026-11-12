import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStreamText, detectSecretPrefixes } from '../server/fraymus/intelligence/transcoder4d.js';
import { StreamCanaryInterceptor } from '../server/fraymus/intelligence/stream-canary.js';
import { sanitizeDeep } from '../server/fraymus/intelligence/ollama-sanitize.js';

// Found 2026-11-12: "sk-" matched inside words, so a model's tool arguments were redacted mid-string —
// "task-policy-fixture:local" reached the task scheduler as "ta[REDACTED:4D(…)]:local" and every scheduled-task creation failed.
const KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0K1l2';

test('a key prefix inside a word is not a key', () => {
  for (const t of ['task-policy-fixture:local', 'risk-free and disk-usage', 'aghp_' + 'x'.repeat(36), 'maxai-model']) {
    const r = sanitizeStreamText(t);
    assert.equal(r.redactionCount, 0, t); assert.equal(r.sanitized, t);
    assert.equal(detectSecretPrefixes(t).length, 0, t);
  }
});

test('real keys are still redacted: bare, quoted, after a space, at the start', () => {
  for (const t of [KEY, `"${KEY}"`, `key ${KEY} end`, `token=${KEY}`, 'ghp_' + 'x'.repeat(36)]) {
    const r = sanitizeStreamText(t);
    assert.equal(r.redactionCount, 1, t); assert.ok(!r.sanitized.includes(KEY.slice(3)), t);
  }
});

test('streamed tokens: a prefix split from its word is kept, a real key split across tokens is still caught', () => {
  const a = new StreamCanaryInterceptor();
  assert.equal(['ta', 'sk-policy-fixture', ':local'].map(x => a.processToken(x)).join('') + a.processToken('', null, true), 'task-policy-fixture:local');
  const b = new StreamCanaryInterceptor();
  const out = ['use ', KEY.slice(0, 10), KEY.slice(10), ' now'].map(x => b.processToken(x)).join('') + b.processToken('', null, true);
  assert.ok(!out.includes(KEY.slice(3)), out); assert.match(out, /^use \[REDACTED:4D/);
});

test('tool-call arguments keep their values (the path that broke task creation)', () => {
  const calls = [{ function: { name: 'tasks.createOnce', arguments: { title: 'x', model: 'task-policy-fixture:local', note: `leaked ${KEY}` } } }];
  const clean = sanitizeDeep(calls);
  assert.equal(clean[0].function.arguments.model, 'task-policy-fixture:local');
  assert.ok(!clean[0].function.arguments.note.includes(KEY.slice(3)));
});
