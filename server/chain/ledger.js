/**
 * Evidence-preserving ledger for Logic Chain runs.
 * Port of FRAYMUS-Logic-Chain/app/engine.py merge/bounded_ledger.
 */

const FIELDS = ['new_logic', 'improved_logic', 'contradictions', 'implementation_steps', 'test_cases', 'unsupported_claims', 'remaining_dependencies'];
const PROTECTED = new Set(['contradictions', 'unsupported_claims']);
const MAX_ITEMS = 250;
const MAX_ITEM_LEN = 1000;
const MAX_CONTEXT = 90_000;

export { FIELDS, PROTECTED, MAX_ITEMS, MAX_ITEM_LEN, MAX_CONTEXT };

export function emptyLedger() {
  const ledger = {};
  for (const f of FIELDS) ledger[f] = [];
  return ledger;
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function clip(text, limit = MAX_ITEM_LEN) {
  const s = String(text).trim();
  return s.length > limit ? s.slice(0, limit) + '...' : s;
}

export function parseDelta(raw) {
  let obj;
  if (typeof raw === 'object' && raw !== null) {
    obj = raw;
  } else {
    const text = String(raw);
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (!braceMatch) return null;
    try { obj = JSON.parse(braceMatch[0]); } catch { return null; }
  }
  const delta = {};
  for (const f of FIELDS) {
    const arr = obj[f];
    if (!Array.isArray(arr)) { delta[f] = []; continue; }
    delta[f] = arr
      .filter(v => v && typeof v === 'string' && v.trim().length > 0)
      .map(v => clip(v));
  }
  return delta;
}

export function merge(ledger, delta, stage, dropped = {}) {
  if (!delta) return 0;
  let added = 0;
  const seen = new Map();
  for (const f of FIELDS) {
    for (const entry of ledger[f]) {
      seen.set(f + ':' + normalize(entry.text), true);
    }
  }

  for (const f of FIELDS) {
    for (const text of (delta[f] || [])) {
      const key = f + ':' + normalize(text);
      if (seen.has(key)) continue;
      seen.set(key, true);

      if (!PROTECTED.has(f) && ledger[f].length >= MAX_ITEMS) {
        dropped[f] = (dropped[f] || 0) + 1;
        continue;
      }

      ledger[f].push({ text, stage, verified: false });
      added++;
    }
  }
  return added;
}

export function boundedLedger(ledger, budget = MAX_CONTEXT) {
  const parts = [];
  let used = 0;

  for (const f of [...PROTECTED]) {
    if (!ledger[f].length) continue;
    const block = `## ${f} (${ledger[f].length} items — PROTECTED, never capped)\n` +
      ledger[f].map((e, i) => `${i + 1}. [stage ${e.stage}] ${e.text}`).join('\n');
    parts.push(block);
    used += block.length;
  }

  const remaining = budget - used;
  const nonProtected = FIELDS.filter(f => !PROTECTED.has(f) && ledger[f].length > 0);
  if (nonProtected.length === 0) return parts.join('\n\n');

  const share = Math.max(200, Math.floor(remaining / nonProtected.length));

  for (const f of nonProtected) {
    const entries = ledger[f];
    const selected = [];
    let fieldUsed = 0;
    let lo = 0, hi = entries.length - 1;
    let toggle = true;

    while (lo <= hi && fieldUsed < share) {
      const e = toggle ? entries[lo++] : entries[hi--];
      toggle = !toggle;
      const line = `[stage ${e.stage}] ${e.text}`;
      if (fieldUsed + line.length > share) break;
      selected.push(line);
      fieldUsed += line.length;
    }

    const omitted = entries.length - selected.length;
    const header = `## ${f} (${selected.length}/${entries.length}` +
      (omitted > 0 ? `, ${omitted} omitted for space` : '') + ')';
    const block = header + '\n' + selected.map((l, i) => `${i + 1}. ${l}`).join('\n');
    parts.push(block);
  }

  return parts.join('\n\n');
}

export function ledgerStats(ledger) {
  const stats = {};
  let total = 0;
  for (const f of FIELDS) {
    stats[f] = ledger[f].length;
    total += ledger[f].length;
  }
  stats.total = total;
  stats.warnings = (ledger.contradictions?.length || 0) + (ledger.unsupported_claims?.length || 0);
  return stats;
}
