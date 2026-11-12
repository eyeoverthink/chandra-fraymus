import test from 'node:test';
import assert from 'node:assert/strict';
import { FraymusStrangeLoopSubstrate, MAX_PROOF_NODES, proofPhiMIP, negativeControlConsciousnessProofs } from '../server/fraymus/intelligence/ouroboros.js';

// 2026-11-12: an agent asked consciousness_prove for more nodes; the proofs are exponential and synchronous, and the
// whole server stopped answering for over 40 minutes. Every caller passes through the substrate, so the cap lives there.
test('a proof request of any size stays small enough not to freeze the server', () => {
  assert.equal(MAX_PROOF_NODES, 8);
  for (const asked of [16, 64, '1000', -3, null, 'x']) assert.ok(new FraymusStrangeLoopSubstrate(asked).n <= 8 && new FraymusStrangeLoopSubstrate(asked).n >= 2, String(asked));
  assert.equal(new FraymusStrangeLoopSubstrate(6).n, 6);
  const t0 = Date.now(); proofPhiMIP(new FraymusStrangeLoopSubstrate(16)); negativeControlConsciousnessProofs(16, 20);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
});
