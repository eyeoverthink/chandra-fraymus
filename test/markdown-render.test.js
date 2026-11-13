// 2026-11-13: agent answers showed raw "###" and "**", with their line breaks collapsed into one paragraph.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, parseInline } from '../client/src/fraymus/markdown.js';

test('an answer shaped like the real AGI reply becomes a heading, lists and bold text', () => {
  const answer = [
    'Based on the provided information, the system has met 8 out of 12 blueprint requirements.',
    '',
    '### **Summary of Blueprint Requirements:**',
    '1. **Perception** - ✓ Met: 3 of 6 outward channels varied.',
    '2. **Memory** - ✓ Met: hybrid search MRR 0.97.',
    '',
    '- Learning has not happened yet',
    '- `agi_progress` was called',
  ].join('\n');
  const b = parseMarkdown(answer);
  assert.deepEqual(b.map(x => x.t), ['p', 'h', 'list', 'list']);
  assert.equal(b[1].level, 3);
  assert.equal(b[1].inline[0].t, 'bold', 'the bold inside the heading is bold, not literal asterisks');
  assert.equal(b[2].ordered, true);
  assert.equal(b[2].items.length, 2);
  assert.equal(b[2].items[0][0].t, 'bold');
  assert.equal(b[2].items[0][0].v[0].v, 'Perception');
  assert.equal(b[3].ordered, false);
  assert.equal(b[3].items[1][0].t, 'code');
  assert.ok(!JSON.stringify(b).includes('**'), 'no literal ** is left anywhere');
});

test('markup and unsafe links stay text — nothing can be injected', () => {
  const spans = parseInline('<img src=x onerror=alert(1)> and [click](javascript:alert(1)) and [ok](https://example.com)');
  assert.equal(spans[0].t, 'text');
  assert.match(spans[0].v, /<img src=x onerror=alert\(1\)>/, 'HTML is kept as literal text (React escapes it)');
  assert.ok(!spans.some(s => s.t === 'link' && /javascript/i.test(s.href)), 'a javascript: link is never a link');
  assert.deepEqual(spans.find(s => s.t === 'link'), { t: 'link', v: 'ok', href: 'https://example.com' });
});

test('arithmetic and snake_case are not mistaken for italics; code fences keep their lines', () => {
  assert.deepEqual(parseInline('2 * 3 * 4'), [{ t: 'text', v: '2 * 3 * 4' }]);
  assert.deepEqual(parseInline('motor_reflect_min_ms'), [{ t: 'text', v: 'motor_reflect_min_ms' }]);
  assert.equal(parseInline('a *real* word')[1].t, 'em');
  const b = parseMarkdown('Run:\n```\nnpm test\nnpm run dev\n```\nDone.');
  assert.deepEqual(b.map(x => x.t), ['p', 'code', 'p']);
  assert.equal(b[1].v, 'npm test\nnpm run dev');
});
