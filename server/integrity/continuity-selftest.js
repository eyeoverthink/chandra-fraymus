// Unified Continuity Selftest — comprehensive integrity probe
// Ported from FRAYNIX-DREAMER-120B's selftestJson() + recoverReport()
// Checks ALL continuity artifacts in one call: DNA, codon, plasmid,
// dreams, remembered vault, ledger, signatures, watchdog, governance.
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc

import { encodeDna, decodeDna } from '../fraymus/encoding/dna.js';
import { encodeCodon, decodeCodon } from '../fraymus/encoding/codon.js';
import { getStatus as watchdogStatus } from './watchdog.js';
import { selftest as strixSelftest } from './strix-laws.js';
import { selftest as guardSelftest } from './guard-tasks.js';
import { selftest as writSelftest } from './writ-system.js';
import { selftest as clockSelftest } from './clock-honesty.js';
import { db } from '../db.js';

function timedProbe(name, fn, accepts = result => result?.pass !== false) {
  const start = Date.now();
  try {
    const result = fn();
    return { name, pass: accepts(result) === true, ms: Date.now() - start, detail: result };
  } catch (e) {
    return { name, pass: false, ms: Date.now() - start, error: e.message };
  }
}

function dnaRoundTrip() {
  const testBytes = Buffer.from('FRAYMUS continuity probe — DNA round-trip test');
  const dnaStr = encodeDna(testBytes);
  if (!dnaStr || typeof dnaStr !== 'string') return { roundtrip: false, reason: 'encode returned falsy' };
  const decoded = decodeDna(dnaStr);
  if (!decoded) return { roundtrip: false, reason: 'decode returned falsy' };
  const match = Buffer.compare(testBytes, Buffer.from(decoded)) === 0;
  return { roundtrip: match, strand_length: dnaStr.length, original_length: testBytes.length };
}

function codonRoundTrip() {
  const testBytes = Buffer.from('FRAYMUS continuity probe — codon round-trip test');
  const strand = encodeCodon(testBytes);
  if (!strand || typeof strand !== 'string') return { roundtrip: false, reason: 'encode returned falsy' };
  const decoded = decodeCodon(strand);
  if (!decoded) return { roundtrip: false, reason: 'decode returned falsy' };
  const decodedBuf = Buffer.from(decoded);
  const match = Buffer.compare(testBytes, decodedBuf) === 0;
  return { roundtrip: match, strand_length: strand.length, original_length: testBytes.length };
}

function dbPresence() {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    return { present: true, table_count: tables.length, tables: tables.map(t => t.name) };
  } catch (e) {
    return { present: false, error: e.message };
  }
}

export function continuitySelftest({ dreamer, remembered, ledger, ouroboros } = {}) {
  const results = [];

  results.push(timedProbe('dna_roundtrip', dnaRoundTrip, result => result.roundtrip === true));
  results.push(timedProbe('codon_roundtrip', codonRoundTrip, result => result.roundtrip === true));
  results.push(timedProbe('database', dbPresence, result => result.present === true));

  results.push(timedProbe('watchdog', () => {
    const status = watchdogStatus();
    return { running: status.running, tracked: status.tracked_files, violations: status.recent_violations?.length || 0,
      checked: status.last_check !== null, failed: status.last_check?.results?.failed || 0 };
  }, result => result.failed === 0));

  results.push(timedProbe('strix_laws', strixSelftest));
  results.push(timedProbe('guard_tasks', guardSelftest));
  results.push(timedProbe('writ_system', writSelftest));
  results.push(timedProbe('clock_honesty', clockSelftest));

  if (dreamer) {
    results.push(timedProbe('dreamer', () => {
      const files = dreamer.list(999);
      const feel = dreamer.feel();
      return { dream_count: files.length, state: feel.state, score: feel.score };
    }));
  }

  if (remembered) {
    results.push(timedProbe('remembered_vault', () => {
      const stats = remembered.stats();
      if (stats.total > 0) {
        const verify = remembered.verify(1);
        return { ...stats, first_entry_verified: verify.verified };
      }
      return stats;
    }, result => result.total === 0 || result.first_entry_verified === true));
  }

  if (ledger) {
    results.push(timedProbe('ledger', () => {
      const counts = ledger.countByKind();
      const integrity = ledger.verify(20);
      return { counts, integrity_chain: integrity.verified, checked: integrity.checked };
    }, result => result.integrity_chain === true));
  }

  if (ouroboros) {
    results.push(timedProbe('ouroboros', () => {
      return { generation: ouroboros.generation, fitness: ouroboros.fitness };
    }));
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const totalMs = results.reduce((sum, r) => sum + r.ms, 0);

  return {
    selftest: {
      ts: new Date().toISOString(),
      passed,
      failed,
      total: results.length,
      duration_ms: totalMs,
      verdict: failed === 0 ? 'ALL_CLEAR' : `${failed} PROBE(S) FAILED`,
      probes: results,
    },
  };
}

export function installSelftestRoutes(app, opts = {}) {
  app.get('/api/integrity/selftest', (_req, res) => {
    try {
      const result = continuitySelftest(opts);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
