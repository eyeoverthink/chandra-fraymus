import { createHash } from 'node:crypto';

// ── Evidence Seal / Anti-Invention Seal ────────────────────────
// Every tool result gets stamped with evidence_sha = SHA-256(result).
// When the model references a tool result, the harness can verify
// the reference matches a real, stamped result. Any claim without
// a matching evidence stamp is flagged as unmeasured/hallucinated.
// Ported from FRAYNIX tools/tryme_loop.py anti-invention discipline.

const evidenceStore = new Map();
const MAX_STORE_SIZE = 5000;

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Stamp a tool result with its evidence hash. Returns the stamped result.
export function stamp(toolName, args, result) {
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
  const evidenceSha = sha256(resultStr);
  const entry = {
    toolName,
    args: typeof args === 'string' ? args : JSON.stringify(args),
    evidenceSha,
    resultPreview: resultStr.slice(0, 500),
    stampedAt: Date.now(),
  };

  evidenceStore.set(evidenceSha, entry);

  // Evict oldest entries if store grows too large
  if (evidenceStore.size > MAX_STORE_SIZE) {
    const oldest = [...evidenceStore.entries()]
      .sort((a, b) => a[1].stampedAt - b[1].stampedAt)
      .slice(0, evidenceStore.size - MAX_STORE_SIZE + 100);
    for (const [key] of oldest) evidenceStore.delete(key);
  }

  return {
    ...result,
    __evidence: {
      sha: evidenceSha,
      tool: toolName,
      at: entry.stampedAt,
    },
  };
}

// Verify that a claimed result hash exists in the evidence store.
export function verifyEvidence(evidenceSha) {
  const entry = evidenceStore.get(evidenceSha);
  if (!entry) return { verified: false, reason: 'no_matching_evidence' };
  return { verified: true, toolName: entry.toolName, stampedAt: entry.stampedAt };
}

// Check if a text block references any evidence-stamped results.
// Returns { measured, unmeasured } counts and details.
export function auditClaims(text, runEvidenceHashes) {
  const measured = [];
  const unmeasured = [];

  for (const hash of runEvidenceHashes) {
    if (evidenceStore.has(hash)) {
      measured.push({ hash, tool: evidenceStore.get(hash).toolName });
    } else {
      unmeasured.push({ hash, reason: 'no_evidence_stamp' });
    }
  }

  return {
    total: runEvidenceHashes.length,
    measured: measured.length,
    unmeasured: unmeasured.length,
    details: { measured, unmeasured },
    integrity: unmeasured.length === 0 ? 'clean' : 'has_unmeasured_claims',
  };
}

// Wrap a tool executor to auto-stamp results.
// This is the integration point — wrap executeTool in fleet/runtime.js.
export function wrapExecutor(executeFn) {
  return async function stampedExecute(toolName, args, ctx) {
    const result = await executeFn(toolName, args, ctx);

    // Don't stamp approval-waiting results
    if (result?.awaiting_approval) return result;

    const stamped = stamp(toolName, args, result);
    return stamped;
  };
}

// Get stats about the evidence store.
export function stats() {
  const entries = [...evidenceStore.values()];
  const byTool = {};
  for (const e of entries) {
    byTool[e.toolName] = (byTool[e.toolName] || 0) + 1;
  }

  return {
    totalStamped: evidenceStore.size,
    byTool,
    oldestAt: entries.length > 0 ? Math.min(...entries.map(e => e.stampedAt)) : null,
    newestAt: entries.length > 0 ? Math.max(...entries.map(e => e.stampedAt)) : null,
  };
}

// Clear all evidence (for testing).
export function clear() {
  evidenceStore.clear();
}

// ── Evidence-Bounded Output ────────────────────────────────────
// Caps tool output at a configurable limit and returns a reference
// to the full result. Ported from FRAYNIX Strix Law 4.

const BOUNCE_MAX_CHARS = 4000;
const BOUNCE_MAX_LINES = 48;

export function boundResult(result, maxChars = BOUNCE_MAX_CHARS, maxLines = BOUNCE_MAX_LINES) {
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  const lines = str.split('\n');

  if (str.length <= maxChars && lines.length <= maxLines) {
    return { bounded: false, result: str, fullLength: str.length };
  }

  const truncatedLines = lines.slice(0, maxLines);
  let truncated = truncatedLines.join('\n');
  if (truncated.length > maxChars) {
    truncated = truncated.slice(0, maxChars);
  }

  const fullSha = sha256(str);
  return {
    bounded: true,
    result: truncated,
    fullLength: str.length,
    fullLines: lines.length,
    fullSha,
    truncatedTo: { chars: truncated.length, lines: truncatedLines.length },
  };
}

// ── Selftest ───────────────────────────────────────────────────
// Proves: (1) stamp produces valid hash, (2) verify finds stamped result,
// (3) verify rejects unknown hash, (4) boundResult truncates correctly.

export function selftest() {
  const results = [];
  clear();

  // Test 1: stamp produces deterministic hash
  const r1 = stamp('test_tool', { q: 'hello' }, { answer: 42 });
  results.push({
    test: 'stamp_produces_hash',
    pass: r1.__evidence?.sha?.length === 64 && r1.__evidence?.tool === 'test_tool',
  });

  // Test 2: verify finds the stamped result
  const v1 = verifyEvidence(r1.__evidence.sha);
  results.push({ test: 'verify_finds_stamp', pass: v1.verified === true });

  // Test 3: verify rejects unknown hash
  const v2 = verifyEvidence('0'.repeat(64));
  results.push({ test: 'verify_rejects_unknown', pass: v2.verified === false });

  // Test 4: same input produces same hash (deterministic)
  const r2 = stamp('test_tool', { q: 'hello' }, { answer: 42 });
  results.push({
    test: 'deterministic_hash',
    pass: r1.__evidence.sha === r2.__evidence.sha,
  });

  // Test 5: different input produces different hash
  const r3 = stamp('test_tool', { q: 'hello' }, { answer: 43 });
  results.push({
    test: 'different_input_different_hash',
    pass: r3.__evidence.sha !== r1.__evidence.sha,
  });

  // Test 6: boundResult truncates large output
  const bigResult = 'x'.repeat(10000);
  const b1 = boundResult(bigResult, 4000, 48);
  results.push({
    test: 'bound_truncates',
    pass: b1.bounded === true && b1.result.length <= 4000 && b1.fullLength === 10000,
  });

  // Test 7: boundResult passes small output through
  const smallResult = 'hello world';
  const b2 = boundResult(smallResult);
  results.push({
    test: 'bound_passes_small',
    pass: b2.bounded === false && b2.result === smallResult,
  });

  // Test 8: audit detects measured vs unmeasured
  const audit = auditClaims('test', [r1.__evidence.sha, 'fake_hash_that_does_not_exist']);
  results.push({
    test: 'audit_detects_unmeasured',
    pass: audit.measured === 1 && audit.unmeasured === 1 && audit.integrity === 'has_unmeasured_claims',
  });

  clear();
  const allPass = results.every(r => r.pass);
  return { ok: allPass, tests: results };
}
