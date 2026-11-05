// Focused acceptance tests for HIVE-01 through HIVE-05 fixes.
// Usage: node docs/reviews/2026-11-05-hive-phase1-fix-acceptance.mjs --upstream PATH_TO_PINNED_UPSTREAM
// Requires: better-sqlite3, express (already in devDependencies)
// Tests run against HEAD source (the fix commit), not the pinned 8b52ac9 baseline.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = text => createHash('sha256').update(text).digest('hex');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

function readSource(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

function moduleFrom(path, bindings, exports) {
  const body = readSource(path)
    .replace(/^import [\s\S]*?;\r?$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body), `Unprocessed import in ${path}`);
  return new vm.Script(`(() => { ${body}\n return { ${exports} }; })()`, { filename: path })
    .runInNewContext({ Date, Math, JSON, Number, Object, Array, Error, console, ...bindings });
}

function makeContext({ database = ':memory:', afterPublish } = {}) {
  const db = new Database(database);
  if (database !== ':memory:') { db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); }
  const ddl = readSource('server/db-migrate.js');
  for (const table of ['bus_messages', 'bus_subscriptions', 'bus_triggers', 'workflows', 'workflow_runs']) {
    db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  }
  const bus = moduleFrom('server/fleet/bus.js', { db },
    'initBus,publish,directMessage,subscribe,unsubscribe,listSubscriptions,inbox,history,topics,busStats,onTopic,offTopic');
  const wrappedPublish = (...args) => { const result = bus.publish(...args); afterPublish?.(args, result); return result; };
  const bridge = moduleFrom('server/intelligence/hive-bridge.js',
    { db, publish: wrappedPublish, createHash, readFileSync, statSync },
    'ensureHiveBridgeTable,ingestHiveFile,verifyHiveChain,getIngestionStats,detectFormat,' +
    '_pythonCanonical:pythonCanonical,_computeReceiptSelf:computeReceiptSelf,_pythonJsonString:pythonJsonString');
  bridge.ensureHiveBridgeTable();
  return { db, bus, bridge };
}

// ─── Crash test child process entry ──────────────────────────
if (arg('--crash-db')) {
  const ctx = makeContext({ database: arg('--crash-db'), afterPublish: (args) => {
    if (args[1] !== 'hive.chain.status') {
      process.stdout.write('EXIT_AFTER_COMMITTED_BUS_PUBLICATION\n');
      process.exit(47);
    }
  }});
  ctx.bridge.ingestHiveFile(arg('--crash-input'));
  throw new Error('Crash point was not reached');
}

// ─── Test infrastructure ─────────────────────────────────────
const results = [];
const T = (name, fn) => {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    process.stdout.write(`  [PASS] ${name}\n`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.message });
    process.stdout.write(`  [FAIL] ${name}: ${e.message}\n`);
  }
};

assert.ok(arg('--upstream'), '--upstream requires the pinned source snapshot');
const upstream = resolve(arg('--upstream'));
const rawPath = join(upstream, 'hive/receipts.jsonl');
assert.ok(statSync(rawPath).isFile(), 'upstream receipts.jsonl not found');
const rawContent = readFileSync(rawPath, 'utf8');
const rawLines = rawContent.split('\n').filter(l => l.trim().length > 0);
const rawRecords = rawLines.map(l => JSON.parse(l));
console.log(`Loaded ${rawRecords.length} upstream receipts\n`);

// ═══════════════════════════════════════════════════════════════
console.log('── HIVE-04: DEL (U+007F) escaping ──');

T('pythonJsonString escapes DEL as \\u007f', () => {
  const { bridge } = makeContext();
  const result = bridge._pythonJsonString('abc\x7Fdef');
  assert.ok(result.includes('\\u007f'), `Expected \\u007f in ${result}`);
  assert.ok(!result.includes('\x7F'), 'Raw DEL byte should not appear');
});

T('DEL-bearing string round-trips through canonical', () => {
  const { bridge } = makeContext();
  const obj = { key: 'has\x7Fdel' };
  const canonical = bridge._pythonCanonical(obj);
  assert.ok(canonical.includes('\\u007f'), `Canonical should escape DEL: ${canonical}`);
});

// ═══════════════════════════════════════════════════════════════
console.log('\n── HIVE-03: malformed input handling ──');

T('corrupted final line (newline-terminated) is NOT silently dropped', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const lines = rawLines.slice(0, 3);
  const corrupted = '!' + lines[2].slice(1);
  writeFileSync(join(tmp, 'test.jsonl'), [...lines.slice(0, 2), corrupted, ''].join('\n'));
  const { bridge } = makeContext();
  const result = bridge.verifyHiveChain(join(tmp, 'test.jsonl'));
  assert.ok(!result.intact, 'File with corrupted complete line must not be INTACT');
  assert.ok(result.malformed?.length > 0, 'Malformed lines must be reported');
  rmSync(tmp, { recursive: true, force: true });
});

T('one-byte syntax corruption at end → NOT reported as INTACT', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const lines = rawLines.slice();
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = '!' + lastLine.slice(1);
  writeFileSync(join(tmp, 'test.jsonl'), lines.join('\n') + '\n');
  const { bridge } = makeContext();
  const result = bridge.verifyHiveChain(join(tmp, 'test.jsonl'));
  assert.ok(!result.intact, 'One-byte corruption at end must not be INTACT');
  assert.ok(result.malformedComplete === true, 'Must flag malformed complete lines');
  rmSync(tmp, { recursive: true, force: true });
});

T('partial trailing line (no newline) is skipped, rest processed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const lines = rawLines.slice(0, 3);
  writeFileSync(join(tmp, 'test.jsonl'), lines.join('\n') + '\n{partial');
  const { bridge } = makeContext();
  const result = bridge.verifyHiveChain(join(tmp, 'test.jsonl'));
  assert.equal(result.total, 3, 'Should have 3 valid records');
  assert.ok(result.malformed?.some(m => m.reason === 'partial_trailing_line'), 'Partial trailing must be flagged');
  rmSync(tmp, { recursive: true, force: true });
});

T('all-malformed file → error, not falsely intact', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'test.jsonl'), 'not json at all\n');
  const { bridge } = makeContext();
  const result = bridge.verifyHiveChain(join(tmp, 'test.jsonl'));
  assert.ok(result.error, 'All-malformed file must return an error');
  assert.ok(!result.intact, 'Must NOT report as intact');
  rmSync(tmp, { recursive: true, force: true });
});

T('file with valid first line + malformed second → reported as damaged', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'test.jsonl'), rawLines[0] + '\n!corrupted line\n');
  const { bridge } = makeContext();
  const result = bridge.verifyHiveChain(join(tmp, 'test.jsonl'));
  assert.ok(!result.intact, 'Must not be intact with malformed line');
  assert.equal(result.total, 1, 'One valid record');
  assert.ok(result.malformed?.length > 0, 'Malformed lines reported');
  rmSync(tmp, { recursive: true, force: true });
});

T('raw record missing type field is rejected during ingestion', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const record = { ...rawRecords[0] };
  delete record.type;
  writeFileSync(join(tmp, 'test.jsonl'), JSON.stringify(record) + '\n');
  const { bridge } = makeContext();
  const result = bridge.ingestHiveFile(join(tmp, 'test.jsonl'));
  assert.equal(result.ingested, 0, 'Missing-field record must not be ingested');
  assert.ok(result.errors.some(e => e.includes('missing required fields')), 'Error must name missing fields');
  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
console.log('\n── HIVE-01: trusted topic namespace ──');

T('projection events publish to hive.unverified.* namespace', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const projection = { ts: Date.now(), type: 'log', src: 'fra-pipeline:dossier', msg: 'test', seal: 'none' };
  writeFileSync(join(tmp, 'proj.jsonl'), JSON.stringify(projection) + '\n');
  const topics = [];
  const { bridge } = makeContext({ afterPublish: (args) => { topics.push(args[1]); } });
  bridge.ingestHiveFile(join(tmp, 'proj.jsonl'));
  const projTopics = topics.filter(t => t !== 'hive.chain.status');
  assert.ok(projTopics.every(t => t.startsWith('hive.unverified.')),
    `All projection topics must be unverified: ${projTopics.join(', ')}`);
  assert.ok(projTopics.length > 0, 'At least one projection event must publish');
  rmSync(tmp, { recursive: true, force: true });
});

T('damaged chain: post-break records publish to hive.unverified.*', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const lines = rawLines.slice();
  const tampered = JSON.parse(lines[6]);
  tampered.claim = (tampered.claim || '') + ' TAMPERED';
  lines[6] = JSON.stringify(tampered);
  writeFileSync(join(tmp, 'damaged.jsonl'), lines.join('\n') + '\n');

  const topics = [];
  const { bridge } = makeContext({ afterPublish: (args) => { topics.push(args[1]); } });
  bridge.ingestHiveFile(join(tmp, 'damaged.jsonl'));

  const nonAdvisory = topics.filter(t => t !== 'hive.chain.status');
  const trusted = nonAdvisory.filter(t => !t.includes('.unverified.'));
  const untrusted = nonAdvisory.filter(t => t.includes('.unverified.'));

  assert.ok(trusted.length > 0, 'Verified prefix should use trusted topics');
  assert.ok(trusted.length <= 6, `Trusted topics must stop before break index: got ${trusted.length}`);
  assert.ok(untrusted.length > 0, 'Post-break records must use unverified namespace');
  rmSync(tmp, { recursive: true, force: true });
});

T('projection to hive.unverified.* does NOT fire trigger on hive.*', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const projection = { ts: Date.now(), type: 'log', src: 'fra-pipeline:dossier', msg: 'test-trigger', seal: 'none' };
  writeFileSync(join(tmp, 'proj.jsonl'), JSON.stringify(projection) + '\n');

  let trustedFired = 0;
  let untrustedFired = 0;
  const { db, bus, bridge } = makeContext();

  bus.onTopic('hive.fra-pipeline:dossier', 'test-trusted', () => { trustedFired++; });
  bus.onTopic('hive.unverified.fra-pipeline:dossier', 'test-untrusted', () => { untrustedFired++; });

  bridge.ingestHiveFile(join(tmp, 'proj.jsonl'));
  assert.equal(trustedFired, 0, `Trusted topic subscriber must NOT fire for projection: fired ${trustedFired} times`);
  assert.ok(untrustedFired > 0, `Untrusted topic subscriber must fire for projection: fired ${untrustedFired} times`);
  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
console.log('\n── HIVE-02: atomic publish + checkpoint ──');

T('crash between publish and checkpoint → 0 orphaned bus rows, clean restart', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  const dbPath = join(tmp, 'crash-test.db');
  const inputPath = join(tmp, 'receipts.jsonl');
  writeFileSync(inputPath, rawContent);

  let stdout;
  try {
    stdout = execFileSync(process.execPath, [
      fileURLToPath(import.meta.url),
      '--crash-db', dbPath,
      '--crash-input', inputPath,
      '--upstream', upstream
    ], { encoding: 'utf8', timeout: 15_000 });
  } catch (e) {
    if (e.status !== 47) throw new Error(`Unexpected crash exit code: ${e.status}`);
    stdout = e.stdout || '';
  }

  assert.ok(stdout.includes('EXIT_AFTER_COMMITTED_BUS_PUBLICATION'), 'Child must reach the crash point');

  const db2 = new Database(dbPath);
  const busRows = db2.prepare('SELECT COUNT(*) as c FROM bus_messages').get().c;
  const ingestionRows = db2.prepare("SELECT COUNT(*) as c FROM hive_ingestion").get().c;
  db2.close();

  assert.equal(busRows, 0, `Transaction rollback: bus_messages should be 0, got ${busRows}`);
  assert.equal(ingestionRows, 0, `Transaction rollback: hive_ingestion should be 0, got ${ingestionRows}`);

  const { bridge, db: db3 } = makeContext({ database: dbPath });
  bridge.ingestHiveFile(inputPath);
  const finalBus = db3.prepare("SELECT COUNT(*) as c FROM bus_messages WHERE topic LIKE 'hive.%' AND topic != 'hive.chain.status'").get().c;
  assert.equal(finalBus, rawRecords.length, `Clean restart: exactly ${rawRecords.length} publications, got ${finalBus}`);
  db3.close();

  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
console.log('\n── HIVE-05: stable dedup identity ──');

T('identical second ingestion → all skipped (baseline positive control)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'receipts.jsonl'), rawContent);
  const { bridge } = makeContext();
  const first = bridge.ingestHiveFile(join(tmp, 'receipts.jsonl'));
  assert.equal(first.ingested, rawRecords.length);
  const second = bridge.ingestHiveFile(join(tmp, 'receipts.jsonl'));
  assert.equal(second.skipped, rawRecords.length, 'All receipts must be skipped on re-ingestion');
  assert.equal(second.ingested, 0);
  rmSync(tmp, { recursive: true, force: true });
});

T('whitespace-reserialized receipts → dedup catches them (HIVE-05 fix)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'receipts.jsonl'), rawContent);
  const { bridge, db: testDb } = makeContext();
  const first = bridge.ingestHiveFile(join(tmp, 'receipts.jsonl'));
  assert.equal(first.ingested, rawRecords.length);

  const reserialized = rawRecords.map(r => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(tmp, 'reserialized.jsonl'), reserialized);
  const second = bridge.ingestHiveFile(join(tmp, 'reserialized.jsonl'));

  assert.equal(second.skipped, rawRecords.length,
    `Reserialized receipts must be deduped: ingested ${second.ingested}, skipped ${second.skipped}`);
  assert.equal(second.ingested, 0, 'No new ingestion for reformatted data');

  const totalRows = testDb.prepare('SELECT COUNT(*) as c FROM hive_ingestion').get().c;
  assert.equal(totalRows, rawRecords.length,
    `Total ingestion rows must be ${rawRecords.length}, got ${totalRows}`);
  rmSync(tmp, { recursive: true, force: true });
});

T('genuinely new content → ingested normally', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'receipts.jsonl'), rawContent);
  const { bridge } = makeContext();
  bridge.ingestHiveFile(join(tmp, 'receipts.jsonl'));

  const newRecord = { ...rawRecords[0], claim: 'entirely new claim', self: 'placeholder' };
  delete newRecord.self;
  const { _pythonCanonical, _computeReceiptSelf } = makeContext().bridge;
  writeFileSync(join(tmp, 'new.jsonl'), JSON.stringify(newRecord) + '\n');
  const result = bridge.ingestHiveFile(join(tmp, 'new.jsonl'));
  assert.ok(result.ingested > 0 || result.errors.length > 0,
    'New content must be processed (ingested or reported as error)');
  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
console.log('\n── Positive controls ──');

T('13 known upstream receipts → all chain-verified, INTACT', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'receipts.jsonl'), rawContent);
  const { bridge } = makeContext();
  const result = bridge.ingestHiveFile(join(tmp, 'receipts.jsonl'));
  assert.equal(result.format, 'raw');
  assert.equal(result.chainStatus, 'INTACT');
  assert.equal(result.ingested, rawRecords.length);
  assert.equal(result.errors.length, 0, `Errors: ${result.errors.join('; ')}`);
  rmSync(tmp, { recursive: true, force: true });
});

T('13 receipts all publish to trusted hive.* namespace', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'receipts.jsonl'), rawContent);
  const topics = [];
  const { bridge } = makeContext({ afterPublish: (args) => { topics.push(args[1]); } });
  bridge.ingestHiveFile(join(tmp, 'receipts.jsonl'));
  const receiptTopics = topics.filter(t => t !== 'hive.chain.status');
  assert.equal(receiptTopics.length, rawRecords.length);
  assert.ok(receiptTopics.every(t => t.startsWith('hive.') && !t.includes('.unverified.')),
    `All intact receipts must use trusted namespace: ${receiptTopics.filter(t => t.includes('.unverified.')).join(', ')}`);
  rmSync(tmp, { recursive: true, force: true });
});

T('chain verification passes for intact file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hive-fix-'));
  writeFileSync(join(tmp, 'receipts.jsonl'), rawContent);
  const { bridge } = makeContext();
  const result = bridge.verifyHiveChain(join(tmp, 'receipts.jsonl'));
  assert.ok(result.intact, 'Intact chain must verify as INTACT');
  assert.equal(result.total, rawRecords.length);
  assert.equal(result.malformed?.length || 0, 0, 'No malformed lines in intact file');
  rmSync(tmp, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
console.log('\n── Summary ──');
const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;
console.log(`${passed} passed, ${failed} failed out of ${results.length} tests`);

if (arg('--output')) {
  writeFileSync(arg('--output'), JSON.stringify({
    timestamp: new Date().toISOString(),
    sourceHashes: { 'server/intelligence/hive-bridge.js': sha(readSource('server/intelligence/hive-bridge.js')) },
    upstreamReceipts: rawRecords.length,
    results,
    summary: { passed, failed, total: results.length }
  }, null, 2));
  console.log(`Evidence written to ${arg('--output')}`);
}

process.exit(failed > 0 ? 1 : 0);
