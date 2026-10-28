// Mesh messaging — entity-backed signed messaging with chain verification
// Source: Library Manager mesh.js
import { signMessage, verifyMessage } from '../core/signing.js';

export async function postSigned(identity, to, payload, entityStore) {
  const last = await entityStore.Message.filter(
    { from_number: identity.number },
    { sort: '-created_date', limit: 1 }
  );
  const prev = last.items?.[0]?.hash || 'genesis';
  const m = await signMessage(identity, to, payload, prev);
  return entityStore.Message.create({ ...m, from_name: identity.name });
}

export async function verifyChain(number, entityStore) {
  const msgs = await entityStore.Message.filter(
    { from_number: number },
    { sort: 'created_date', limit: 1000 }
  );
  const results = [];
  let expectedPrev = 'genesis';
  for (const m of msgs.items || []) {
    const chainOk = m.prev === expectedPrev;
    results.push({ hash: m.hash, prev: m.prev, chainOk, ts: m.ts });
    expectedPrev = m.hash;
  }
  const broken = results.filter((r) => !r.chainOk);
  return {
    total: results.length,
    valid: broken.length === 0,
    broken: broken.length,
    details: results,
  };
}
