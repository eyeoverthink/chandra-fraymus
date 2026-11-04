// Immune Layer Round 4 — Probe for IMM-10 fleet, IMM-11 sanitizeDeep, IMM-08 metadata completion
// Tests the three fixes from review round 3.
// Run: node docs/reviews/2026-11-04-immune-round4-probe.mjs

import { sanitizeDeep, sanitizeOllamaContent } from '../../server/fraymus/intelligence/ollama-sanitize.js';
import { StreamCanaryInterceptor } from '../../server/fraymus/intelligence/stream-canary.js';
import { TriangulatedHoneypotArray } from '../../server/fraymus/intelligence/canary.js';

const results = {};
let pass = 0;
let fail = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    pass++;
    results[label] = { pass: true, detail };
  } else {
    fail++;
    results[label] = { pass: false, detail };
    console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`);
  }
}

// ─── IMM-10: Fleet tool arguments ────────────────────────────────────────────
// Reproduce the fleet chat function with sanitizeDeep now wired in
{
  const fakeToolCalls = [
    {
      function: {
        name: 'test_tool',
        arguments: { token: 'sk-UNIT_TEST_ONLY_0123456789', nested: { key: 'ghp_FAKE_TOKEN_1234' } },
      },
    },
  ];

  const sanitized = sanitizeDeep(fakeToolCalls);
  const arg0 = sanitized[0].function.arguments;

  assert('IMM-10:fleet_tool_token',
    !String(arg0.token).includes('sk-UNIT_TEST_ONLY'),
    `token: ${arg0.token}`);
  assert('IMM-10:fleet_tool_nested',
    !String(arg0.nested.key).includes('ghp_FAKE_TOKEN'),
    `nested.key: ${arg0.nested.key}`);

  // Confirm the function name (non-secret) survives
  assert('IMM-10:fleet_tool_name_preserved',
    sanitized[0].function.name === 'test_tool',
    `name: ${sanitized[0].function.name}`);
}

// ─── IMM-11: __proto__ prototype pollution ───────────────────────────────────
{
  const malicious = JSON.parse('{"__proto__":{"syntheticInherited":true},"ok":true}');
  const cleaned = sanitizeDeep(malicious);

  // The __proto__ key must remain as an OWN data property, not alter the prototype
  assert('IMM-11:proto_not_inherited',
    cleaned.syntheticInherited !== true,
    `syntheticInherited: ${cleaned.syntheticInherited}`);

  assert('IMM-11:ok_preserved',
    cleaned.ok === true,
    `ok: ${cleaned.ok}`);

  // The own __proto__ key should still exist as a data property
  const hasOwn = Object.prototype.hasOwnProperty.call(cleaned, '__proto__');
  assert('IMM-11:proto_is_own_property',
    hasOwn,
    `has own __proto__: ${hasOwn}`);

  // Global prototype must be unaffected
  assert('IMM-11:global_prototype_safe',
    ({}).syntheticInherited !== true,
    `global check: ${({}).syntheticInherited}`);

  // JSON round-trip preserves both keys
  const json = JSON.stringify(cleaned);
  const reparsed = JSON.parse(json);
  assert('IMM-11:json_roundtrip',
    reparsed.ok === true,
    `json: ${json}`);

  // The __proto__ value should appear in serialized output
  assert('IMM-11:proto_in_json',
    json.includes('__proto__'),
    `json includes __proto__: ${json.includes('__proto__')}`);
}

// ─── IMM-11: Depth bound ─────────────────────────────────────────────────────
{
  // Build a 5000-deep nested object — should not throw
  let deep = { value: 'sk-DEEP_TEST_SECRET_123' };
  for (let i = 0; i < 5000; i++) deep = { child: deep };

  let threw = false;
  let result;
  try {
    result = deep;
    result = sanitizeDeep(deep);
  } catch (e) {
    threw = true;
  }

  assert('IMM-11:depth_no_throw',
    !threw,
    'deep nesting should not throw');

  // Walk down to depth 32 — should be redacted
  let node = result;
  for (let i = 0; i < 32 && node?.child; i++) node = node.child;
  assert('IMM-11:depth_capped',
    node?.child === '[REDACTED:depth_exceeded]',
    `at depth 33: ${typeof node?.child === 'string' ? node.child.slice(0, 50) : typeof node?.child}`);

  // The secret at the bottom must NOT survive
  let leaf = result;
  let depth = 0;
  while (leaf?.child && typeof leaf.child === 'object') { leaf = leaf.child; depth++; }
  assert('IMM-11:deep_secret_redacted',
    typeof leaf?.child === 'string' && !leaf.child.includes('sk-DEEP_TEST'),
    `leaf at depth ${depth}: ${typeof leaf?.child === 'string' ? leaf.child.slice(0, 50) : typeof leaf?.child}`);
}

// ─── IMM-08: Metadata-only completion (chat shape) ──────────────────────────
{
  const canary = new TriangulatedHoneypotArray(48, 1.0, { minSamples: 10 });
  const interceptor = new StreamCanaryInterceptor(canary);

  // Simulate chat stream: content "books" then metadata-only done
  const line1 = JSON.stringify({ message: { role: 'assistant', content: 'books' }, done: false });
  const line2 = JSON.stringify({ done: true });

  const r1 = interceptor.processNdjsonLine(line1);
  const r2 = interceptor.processNdjsonLine(line2);

  // "books" = "book" + "s" buffered (because "s" matches start of "sk-")
  // The "s" must appear in the done record's message content
  const finalContent = r2.message?.content || '';
  assert('IMM-08:chat_metadata_done',
    finalContent.includes('s'),
    `done record content: "${finalContent}"`);

  // Total text across both records should reconstruct "books"
  const total = (r1.message?.content || '') + finalContent;
  assert('IMM-08:chat_full_text',
    total === 'books',
    `reconstructed: "${total}"`);
}

// ─── IMM-08: Metadata-only completion (generate shape) ──────────────────────
{
  const canary = new TriangulatedHoneypotArray(48, 1.0, { minSamples: 10 });
  const interceptor = new StreamCanaryInterceptor(canary);

  const line1 = JSON.stringify({ response: 'books', done: false });
  const line2 = JSON.stringify({ done: true });

  const r1 = interceptor.processNdjsonLine(line1);
  const r2 = interceptor.processNdjsonLine(line2);

  const finalResponse = r2.response || '';
  assert('IMM-08:gen_metadata_done',
    finalResponse.includes('s'),
    `done record response: "${finalResponse}"`);

  const total = (r1.response || '') + finalResponse;
  assert('IMM-08:gen_full_text',
    total === 'books',
    `reconstructed: "${total}"`);
}

// ─── Regression: existing round-2 fixtures still pass ────────────────────────
{
  // Credential continuation
  const canary = new TriangulatedHoneypotArray(48, 1.0, { minSamples: 10 });
  const interceptor = new StreamCanaryInterceptor(canary);
  const t1 = interceptor.processToken('sk-');
  const t2 = interceptor.processToken('UNIT_TEST_ONLY_0123456789 after');

  assert('REGR:continuation',
    !((t1 + t2).includes('UNIT_TEST_ONLY')),
    `tokens: "${t1}|${t2}"`);
  assert('REGR:continuation_after',
    (t1 + t2).includes('after'),
    `"after" preserved: ${(t1 + t2).includes('after')}`);

  // JSON preservation
  const json = '{"token":"sk-SECRET123","ok":true}';
  const cleaned = sanitizeOllamaContent(json);
  let parsed = null;
  try { parsed = JSON.parse(cleaned); } catch {}
  assert('REGR:json_parse',
    parsed !== null,
    `parsed: ${cleaned}`);
  assert('REGR:json_ok',
    parsed?.ok === true,
    `ok: ${parsed?.ok}`);

  // Standard completion with message field
  const canary2 = new TriangulatedHoneypotArray(48, 1.0, { minSamples: 10 });
  const interceptor2 = new StreamCanaryInterceptor(canary2);
  const r1 = interceptor2.processNdjsonLine(JSON.stringify({ message: { role: 'assistant', content: 'books' }, done: false }));
  const r2 = interceptor2.processNdjsonLine(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }));
  const stdTotal = (r1.message?.content || '') + (r2.message?.content || '');
  assert('REGR:standard_completion',
    stdTotal === 'books',
    `standard: "${stdTotal}"`);
}

// ─── IMM-10: main provider fixture (control) ────────────────────────────────
{
  const toolCalls = [{ function: { name: 'get_key', arguments: { key: 'sk-MAIN_PROVIDER_TEST_567' } } }];
  const cleaned = sanitizeDeep(toolCalls);
  assert('IMM-10:main_provider_control',
    !String(cleaned[0].function.arguments.key).includes('sk-MAIN_PROVIDER'),
    `key: ${cleaned[0].function.arguments.key}`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log('\n=== Round 4 Probe Results ===');
console.log(`Pass: ${pass}  Fail: ${fail}`);
console.log(JSON.stringify(results, null, 2));
process.exit(fail > 0 ? 1 : 0);
