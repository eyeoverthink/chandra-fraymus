// Independent recheck of fix commit 4ba2c43 against the 10 Phase 1 gates.
// Pinned to fix commit — reads source via git show, not the working tree.
// Exercises the same scenarios as the original 8b52ac9 diagnostic probe but
// asserts CORRECT (fixed) behavior, not defect reproduction.
//
// Usage: node this_file.mjs --upstream PINNED_UPSTREAM_DIRECTORY [--output FILE]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixRef = '4ba2c43';
const originalRef = '8b52ac96d1ce65782d21bd4c770e2fb8bdd2873b';
const hashes = {}, sourceCache = new Map();
const sha = text => createHash('sha256').update(text).digest('hex');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

function source(path) {
  if (!sourceCache.has(path)) {
    const content = execFileSync('git', ['show', `${fixRef}:${path}`], { cwd: root, encoding: 'utf8' });
    sourceCache.set(path, content); hashes[path] = sha(content);
  }
  return sourceCache.get(path);
}

function moduleFrom(path, bindings, exports) {
  const body = source(path)
    .replace(/^import [\s\S]*?;\r?$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '')
    .replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body), `Unprocessed import: ${path}`);
  return new vm.Script(`(() => { ${body}\n return { ${exports} }; })()`, { filename: path })
    .runInNewContext({ Date, Math, JSON, Number, Object, Array, Error, console, Buffer, ...bindings });
}

function context({ database = ':memory:', initialize = true, afterPublish } = {}) {
  const db = new Database(database);
  if (database !== ':memory:') { db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); }
  const ddl = source('server/db-migrate.js');
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
  if (initialize) bridge.ensureHiveBridgeTable();
  return { db, bus, bridge };
}

// ─── Crash test child process entry ──────────────────────────
if (arg('--crash-db')) {
  const child = context({ database: arg('--crash-db'), afterPublish: (args) => {
    if (args[1] !== 'hive.chain.status') {
      process.stdout.write('EXIT_AFTER_COMMITTED_BUS_PUBLICATION\n');
      process.exit(47);
    }
  }});
  child.bridge.ingestHiveFile(arg('--crash-input'));
  throw new Error('Crash point was not reached');
}

// ─── Upstream fixture setup ──────────────────────────────────
assert.ok(arg('--upstream'), '--upstream requires the pinned source snapshot');
const upstream = resolve(arg('--upstream'));
const rawBytes = readFileSync(join(upstream, 'hive/receipts.jsonl'));
const rawBlob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${rawBytes.length}\0`), rawBytes])).digest('hex');
assert.equal(rawBlob, '9fcb7465a12abc80117c45c02c9d064a15ed81cf', 'Exact reviewed upstream receipt bytes');
const rawLines = rawBytes.toString('utf8').trim().split('\n');
const rawRecords = rawLines.map(line => JSON.parse(line));
const directory = mkdtempSync(join(tmpdir(), 'chandra-hive-fix-recheck-'));
const write = (name, content) => { const path = join(directory, name); writeFileSync(path, content); return path; };
const checks = [];
const check = (name, condition, detail) => { assert.ok(condition, name); checks.push({ name, detail }); };
const ledgerRows = db => db.prepare('SELECT COUNT(*) AS n FROM hive_ingestion').get().n;
const busReceipts = db => db.prepare("SELECT * FROM bus_messages WHERE topic != 'hive.chain.status' ORDER BY id").all();
const rawPath = write('raw.jsonl', rawBytes);
const projectionRecord = { ts: '2026-11-05T00:00:00Z', type: 'LEDGER_IMPORT', src: 'fra-pipeline:dossier', msg: 'projection fixture', seal: 'unverifiable' };
const projectionPath = write('projection.jsonl', JSON.stringify(projectionRecord) + '\n');

const gateObservations = {};

// ═══════════════════════════════════════════════════════════════
// G1 — Startup table + runtime wiring
// ═══════════════════════════════════════════════════════════════
console.log('\n── RE-P1-G1: startup table ──');
check('runtime registers the actual hive bridge route installer',
  source('server/runtime.js').includes("import { installHiveBridgeRoutes } from './intelligence/hive-bridge-routes.js'") &&
  source('server/runtime.js').includes('installHiveBridgeRoutes(app)'));
gateObservations.G1 = { runtimeWiring: true };

// ═══════════════════════════════════════════════════════════════
// G2 — Format detection
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G2: format detection ──');
const fmtCtx = context();
try {
  check('raw format detected', fmtCtx.bridge.detectFormat(rawLines[0]) === 'raw');
  check('projection format detected', fmtCtx.bridge.detectFormat(JSON.stringify(projectionRecord)) === 'projection');
  gateObservations.G2 = { rawDetected: true, projectionDetected: true };
} finally { fmtCtx.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G3 — Raw publication (13 receipts, verified metadata)
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G3: raw publication ──');
const good = context();
let positive;
try {
  const perReceipt = rawRecords.map(r => good.bridge._computeReceiptSelf(r) === r.self);
  check('all thirteen upstream self hashes independently match', perReceipt.length === 13 && perReceipt.every(Boolean));
  const verified = good.bridge.verifyHiveChain(rawPath);
  check('full real upstream chain verifies intact', verified.total === 13 && verified.intact);
  const subscriberEvents = [];
  for (const topic of new Set(rawRecords.map(r => `hive.${r.organ}:${r.type}`)))
    good.bus.onTopic(topic, 'review', message => subscriberEvents.push(message));
  const first = good.bridge.ingestHiveFile(rawPath);
  check('first raw ingestion persists thirteen verified receipts',
    first.ingested === 13 && first.chainStatus === 'INTACT' && ledgerRows(good.db) === 13);
  check('actual subscribers receive the thirteen receipts', subscriberEvents.length === 13);
  check('all published events on trusted hive.* topic',
    busReceipts(good.db).every(r => r.topic.startsWith('hive.') && !r.topic.startsWith('hive.unverified.')));
  positive = { perReceiptHashes: perReceipt, verification: verified, first, subscriberEvents: subscriberEvents.length };
  gateObservations.G3 = { ingested: first.ingested, chainStatus: first.chainStatus, allTrusted: true };
} finally { good.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G4 — Projection metadata (chainVerified: false)
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G4: projection metadata ──');
const projCtx = context();
try {
  const result = projCtx.bridge.ingestHiveFile(projectionPath);
  const event = JSON.parse(busReceipts(projCtx.db)[0].payload);
  check('projection is detected and marked chainVerified false',
    result.format === 'projection' && event._hive.chainVerified === false);
  check('projection verification returns an explicit error',
    !!projCtx.bridge.verifyHiveChain(projectionPath).error);
  gateObservations.G4 = { format: result.format, chainVerified: event._hive.chainVerified };
} finally { projCtx.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G5 — Tampering detection + malformed input (HIVE-03 fix)
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G5: tampering / malformed input ──');
const truncated = context();
let malformedObs;
try {
  // A one-byte syntax corruption in a COMPLETE newline-terminated record
  const lastLineWithOneByteChanged = '!' + rawLines[12].slice(1);
  const completeBadPath = write('malformed-terminated.jsonl', rawLines.slice(0, 12).join('\n') + '\n' + lastLineWithOneByteChanged + '\n');
  const complete = truncated.bridge.verifyHiveChain(completeBadPath);
  check('HIVE-03 fix: corrupted final terminated line is NOT silently dropped',
    !complete.intact, `intact=${complete.intact}, total=${complete.total}`);
  check('HIVE-03 fix: malformed array is populated',
    Array.isArray(complete.malformed) && complete.malformed.length > 0);

  // Partial trailing line (file not newline-terminated)
  const partialPath = write('partial-last-line.jsonl', rawLines.slice(0, 12).join('\n') + '\n{"organ":');
  const partial = truncated.bridge.verifyHiveChain(partialPath);
  check('partial trailing line: 12 valid records still verified intact',
    partial.intact && partial.total === 12);
  check('partial trailing line: reported as malformed partial',
    Array.isArray(partial.malformed) && partial.malformed.some(m => m.reason === 'partial_trailing_line'));

  // Entirely malformed file
  const oneBad = write('only-invalid.jsonl', '{"broken":\n');
  const empty = truncated.bridge.verifyHiveChain(oneBad);
  check('HIVE-03 fix: entirely malformed file is NOT reported as intact',
    !empty.intact || empty.error);

  // Ingestion of corrupted complete input
  const ingested = truncated.bridge.ingestHiveFile(completeBadPath);
  check('ingestion reports DAMAGED, not INTACT, for corrupted file',
    ingested.chainStatus !== 'INTACT' || ingested.malformed?.length > 0);

  // Missing-field rejection (HIVE-03 field validation)
  const missingType = { ...rawRecords[0] };
  delete missingType.type;
  missingType.self = truncated.bridge._computeReceiptSelf(missingType);
  const missingPath = write('missing-type.jsonl', JSON.stringify(missingType) + '\n');
  const missingResult = truncated.bridge.ingestHiveFile(missingPath);
  check('HIVE-03 fix: record missing required type field is rejected',
    missingResult.errors.length > 0 && missingResult.errors[0].includes('missing required fields'));

  malformedObs = {
    corruptedTerminated: { intact: complete.intact, total: complete.total, malformed: complete.malformed },
    partialTrailing: { intact: partial.intact, total: partial.total, malformed: partial.malformed },
    entirelyMalformed: { intact: empty.intact, total: empty.total, error: empty.error },
    corruptedIngestion: ingested,
    missingField: missingResult
  };
  gateObservations.G5 = malformedObs;
} finally { truncated.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G6 — Dedup + rotation (HIVE-05 fix)
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G6: dedup / rotation ──');
const dedupCtx = context();
let dedupObs;
try {
  // First ingestion
  const first = dedupCtx.bridge.ingestHiveFile(rawPath);
  check('first ingestion: 13 receipts', first.ingested === 13);

  // Byte-identical repeat
  const second = dedupCtx.bridge.ingestHiveFile(rawPath);
  check('byte-identical repeat: all 13 skipped', second.ingested === 0 && second.skipped === 13);

  // HIVE-05 fix: whitespace-reserialized version should ALSO be deduped
  const reformattedPath = write('reformatted.jsonl', rawRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
  const reformatted = dedupCtx.bridge.ingestHiveFile(reformattedPath);
  check('HIVE-05 fix: reserialized receipts are deduped via stable identity',
    reformatted.skipped === 13 && reformatted.ingested === 0,
    `ingested=${reformatted.ingested}, skipped=${reformatted.skipped}`);

  // New content rotation still works
  const rotation = context();
  try {
    rotation.bridge.ingestHiveFile(rawPath);
    const replacement = { ...rawRecords[0], claim: 'Different genesis content for rotation control' };
    replacement.self = rotation.bridge._computeReceiptSelf(replacement);
    const rotPath = write('rotated.jsonl', JSON.stringify(replacement) + '\n');
    const rotFirst = rotation.bridge.ingestHiveFile(rotPath);
    const rotRepeat = rotation.bridge.ingestHiveFile(rotPath);
    check('new content rotation: ingests once, skips on repeat',
      rotFirst.ingested === 1 && rotRepeat.skipped === 1);
  } finally { rotation.db.close(); }

  dedupObs = {
    firstIngestion: first.ingested,
    byteIdenticalSkipped: second.skipped,
    reformattedSkipped: reformatted.skipped,
    reformattedIngested: reformatted.ingested,
    storedRows: ledgerRows(dedupCtx.db)
  };
  gateObservations.G6 = dedupObs;
} finally { dedupCtx.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G7 — Crash / restart (HIVE-02 fix)
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G7: crash / restart ──');
const crashDatabase = join(directory, 'restart.db');
let crashExit;
try {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-db', crashDatabase, '--crash-input', rawPath],
    { encoding: 'utf8', stdio: 'pipe' });
  throw new Error('Fixture child did not stop at crash point');
} catch (error) {
  assert.equal(error.status, 47);
  check('controlled fixture process exits after committed publication',
    String(error.stdout).includes('EXIT_AFTER_COMMITTED_BUS_PUBLICATION'));
  crashExit = error.status;
}
const resumed = context({ database: crashDatabase });
let crashObs;
try {
  const before = { receiptRows: ledgerRows(resumed.db), publishedRows: busReceipts(resumed.db).length };
  check('HIVE-02 fix: crash before commit leaves ZERO bus rows and ZERO ingestion rows',
    before.publishedRows === 0 && before.receiptRows === 0,
    `publishedRows=${before.publishedRows}, receiptRows=${before.receiptRows}`);
  const retry = resumed.bridge.ingestHiveFile(rawPath);
  const totalPublished = busReceipts(resumed.db).length;
  const bySelf = new Map();
  for (const row of busReceipts(resumed.db)) {
    const record = JSON.parse(row.payload);
    bySelf.set(record.self, (bySelf.get(record.self) || 0) + 1);
  }
  check('HIVE-02 fix: restart produces exactly 13 events for 13 identities (no duplicates)',
    totalPublished === 13 && bySelf.size === 13,
    `published=${totalPublished}, distinct=${bySelf.size}`);
  const maxDeliveries = Math.max(...bySelf.values());
  check('HIVE-02 fix: no receipt is delivered more than once',
    maxDeliveries === 1, `maxDeliveries=${maxDeliveries}`);
  crashObs = {
    fixtureExitCode: crashExit,
    beforeRetry: before,
    retry,
    publishedRowsAfterRetry: totalPublished,
    distinctReceiptIdentities: bySelf.size,
    maxDeliveriesPerReceipt: maxDeliveries
  };
  gateObservations.G7 = crashObs;
} finally { resumed.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G8 — Invalid/untrusted input + trigger isolation (HIVE-01 fix)
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G8: invalid input / trust boundary ──');
const bad = context();
let damagedObs, triggerObs;
try {
  // Damaged chain test
  const changed = rawRecords.map(r => ({ ...r }));
  changed[7].claim += ' TAMPERED';
  const damagedPath = write('damaged.jsonl', changed.map(r => JSON.stringify(r)).join('\n') + '\n');
  const verify = bad.bridge.verifyHiveChain(damagedPath);
  const ingested = bad.bridge.ingestHiveFile(damagedPath);
  const events = busReceipts(bad.db).map(row => ({ topic: bad.db.prepare('SELECT topic FROM bus_messages WHERE id = ?').get(row.id).topic, payload: JSON.parse(row.payload) }));
  check('structured tampering detected at receipt 7', !verify.intact && verify.breakIndex === 7);
  check('damaged chain still publishes all 13 records', ingested.ingested === 13);

  // HIVE-01: records BEFORE break go to trusted hive.*, records AT and AFTER go to hive.unverified.*
  const trustedEvents = events.filter(e => e.topic.startsWith('hive.') && !e.topic.startsWith('hive.unverified.'));
  const untrustedEvents = events.filter(e => e.topic.startsWith('hive.unverified.'));
  check('HIVE-01 fix: first 7 records (pre-break) publish to trusted hive.*',
    trustedEvents.length === 7);
  check('HIVE-01 fix: records 7-12 (post-break) publish to hive.unverified.*',
    untrustedEvents.length === 6);
  check('HIVE-01 fix: trusted events all have chainVerified true',
    trustedEvents.every(e => e.payload._hive.chainVerified === true));
  check('HIVE-01 fix: untrusted events all have chainVerified false',
    untrustedEvents.every(e => e.payload._hive.chainVerified === false));

  damagedObs = {
    verify, ingestion: ingested,
    trustedCount: trustedEvents.length, untrustedCount: untrustedEvents.length,
    totalPublished: events.length
  };
} finally { bad.db.close(); }

// Projection trigger isolation test
const trigCtx = context();
try {
  let trustedFired = 0;
  let untrustedFired = 0;
  trigCtx.bus.onTopic('hive.fra-pipeline:dossier', 'trusted-sub', () => { trustedFired++; });
  trigCtx.bus.onTopic('hive.unverified.fra-pipeline:dossier', 'untrusted-sub', () => { untrustedFired++; });

  trigCtx.bridge.ingestHiveFile(projectionPath);
  const projTopic = busReceipts(trigCtx.db)[0]?.topic;
  check('HIVE-01 fix: projection publishes to hive.unverified.* topic',
    projTopic && projTopic.startsWith('hive.unverified.'),
    `topic=${projTopic}`);
  check('HIVE-01 fix: trusted topic subscriber does NOT fire for projection',
    trustedFired === 0, `trustedFired=${trustedFired}`);
  check('HIVE-01 fix: untrusted topic subscriber DOES fire for projection',
    untrustedFired > 0, `untrustedFired=${untrustedFired}`);

  triggerObs = { projectionTopic: projTopic, trustedFired, untrustedFired };
  gateObservations.G8 = { damaged: damagedObs, trigger: triggerObs };
} finally { trigCtx.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G9 — Stats API
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G9: stats API ──');
const api = context({ initialize: false });
let apiResults;
const app = express(); app.use(express.json());
moduleFrom('server/intelligence/hive-bridge-routes.js', { ...api.bridge, db: api.db },
  'installHiveBridgeRoutes').installHiveBridgeRoutes(app);
moduleFrom('server/fleet/bus-routes.js', { ...api.bus, guardBusMessage: () => ({ pass: true }) },
  'installBusRoutes').installBusRoutes(app);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = path => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  const initialStats = await (await fetch(`${base}/api/intelligence/hive-bridge`)).json();
  check('stats API returns zero counts before ingestion', initialStats.totalIngested === 0);
  const ingestion = await (await fetch(`${base}/api/intelligence/hive-bridge/ingest`, post(rawPath))).json();
  const stats = await (await fetch(`${base}/api/intelligence/hive-bridge`)).json();
  const list = await (await fetch(`${base}/api/intelligence/hive-bridge/receipts?format=raw&limit=2`)).json();
  check('ingestion, stats, and receipt list work via HTTP',
    ingestion.ingested === 13 && stats.rawCount === 13 && list.total === 13);
  apiResults = { initialStats, ingestion, stats, receiptPage: { count: list.receipts.length, total: list.total } };
  gateObservations.G9 = apiResults;
} finally { await new Promise(r => server.close(r)); api.db.close(); }

// ═══════════════════════════════════════════════════════════════
// G10 — Bus delivery + history
// ═══════════════════════════════════════════════════════════════
console.log('── RE-P1-G10: bus delivery / history ──');
const busCtx = context();
try {
  const subs = [];
  for (const topic of new Set(rawRecords.map(r => `hive.${r.organ}:${r.type}`)))
    busCtx.bus.onTopic(topic, 'g10-test', msg => subs.push(msg));
  busCtx.bridge.ingestHiveFile(rawPath);
  const historyTopics = new Set(busReceipts(busCtx.db).map(r => r.topic));
  check('subscribers receive events and bus history is populated',
    subs.length === 13 && historyTopics.size > 0);
  gateObservations.G10 = { subscriberEvents: subs.length, historyTopics: [...historyTopics] };
} finally { busCtx.db.close(); }

// ═══════════════════════════════════════════════════════════════
// HIVE-04 bonus: DEL escaping
// ═══════════════════════════════════════════════════════════════
console.log('── HIVE-04: DEL escaping ──');
const delCtx = context();
try {
  const delResult = delCtx.bridge._pythonJsonString('hello\x7Fworld');
  check('HIVE-04 fix: DEL U+007F escaped as \\u007f',
    delResult.includes('\\u007f') && !delResult.includes('\x7F'));

  // Python cross-check for DEL
  const pyDel = JSON.parse(execFileSync('python', ['-X', 'utf8', '-c',
    `import json; print(json.dumps({'text': chr(127)}, sort_keys=True))`
  ], { encoding: 'utf8' }));
  const jsDel = JSON.parse(delCtx.bridge._pythonCanonical({ text: '\x7F' }));
  check('HIVE-04 fix: DEL round-trips through pythonCanonical matching Python',
    pyDel.text === jsDel.text);

  gateObservations.HIVE04 = { delEscaped: true, pythonMatch: true };
} finally { delCtx.db.close(); }

// ═══════════════════════════════════════════════════════════════
// Gate verdicts (computed from observations)
// ═══════════════════════════════════════════════════════════════
const gateResults = [];
function gate(id, status, evidence) { gateResults.push({ id, status, evidence }); }

gate('RE-P1-G1', 'PASS_ISOLATED', 'Runtime wiring inspected at fix commit. Full app boot not run.');
gate('RE-P1-G2', 'PASS_ISOLATED', 'Raw and projection formats recognized.');
gate('RE-P1-G3', 'PASS_ISOLATED', '13 valid raw receipts publish with verified metadata to trusted hive.* topics.');
gate('RE-P1-G4', 'PASS_ISOLATED', 'Projection carries chainVerified:false; verification rejects it.');

const g5Pass = malformedObs.corruptedTerminated.intact === false &&
  malformedObs.partialTrailing.intact === true &&
  (malformedObs.entirelyMalformed.intact === false || !!malformedObs.entirelyMalformed.error) &&
  malformedObs.missingField.errors.length > 0;
gate('RE-P1-G5', g5Pass ? 'PASS' : 'FAIL',
  g5Pass ? 'HIVE-03 fix verified: corrupted complete lines not silently dropped, partial lines handled, missing fields rejected, entirely malformed not falsely intact.'
    : `HIVE-03 fix incomplete: corrupted.intact=${malformedObs.corruptedTerminated.intact}, missingFieldErrors=${malformedObs.missingField.errors.length}`);

const g6Pass = dedupObs.reformattedSkipped === 13 && dedupObs.reformattedIngested === 0;
gate('RE-P1-G6', g6Pass ? 'PASS' : 'FAIL',
  g6Pass ? 'HIVE-05 fix verified: byte-identical, reformatted, and new-content dedup all correct. Stable identity via receipt self.'
    : `HIVE-05 fix incomplete: reformattedSkipped=${dedupObs.reformattedSkipped}, reformattedIngested=${dedupObs.reformattedIngested}`);

const g7Pass = crashObs.beforeRetry.publishedRows === 0 && crashObs.beforeRetry.receiptRows === 0 &&
  crashObs.publishedRowsAfterRetry === 13 && crashObs.maxDeliveriesPerReceipt === 1;
gate('RE-P1-G7', g7Pass ? 'PASS' : 'FAIL',
  g7Pass ? 'HIVE-02 fix verified: crash leaves zero orphaned rows, restart produces exactly 13 events with no duplicates.'
    : `HIVE-02 fix incomplete: orphanedBus=${crashObs.beforeRetry.publishedRows}, afterRetry=${crashObs.publishedRowsAfterRetry}, maxDeliveries=${crashObs.maxDeliveriesPerReceipt}`);

const g8Pass = damagedObs.trustedCount === 7 && damagedObs.untrustedCount === 6 &&
  triggerObs.trustedFired === 0 && triggerObs.untrustedFired > 0 &&
  triggerObs.projectionTopic.startsWith('hive.unverified.');
gate('RE-P1-G8', g8Pass ? 'PASS' : 'FAIL',
  g8Pass ? 'HIVE-01 fix verified: post-break records and projections publish to hive.unverified.*; trusted topic subscribers do not fire.'
    : `HIVE-01 fix incomplete: trusted=${damagedObs.trustedCount}, untrusted=${damagedObs.untrustedCount}, projTrustedFired=${triggerObs.trustedFired}`);

gate('RE-P1-G9', 'PASS_ISOLATED', 'Stats, ingestion, and receipt list routes work via HTTP.');
gate('RE-P1-G10', 'PASS_ISOLATED', 'Subscribers and bus history receive hive events.');

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════
const passes = gateResults.filter(r => r.status.startsWith('PASS')).length;
const fails = gateResults.filter(r => r.status === 'FAIL').length;
const partial = gateResults.filter(r => r.status === 'PARTIAL').length;

console.log('\n── Gate Ledger ──');
for (const g of gateResults) console.log(`  ${g.id}: ${g.status}`);
console.log(`\n${passes} passed, ${fails} failed, ${partial} partial out of ${gateResults.length} gates`);

const evidence = {
  generatedAt: new Date().toISOString(),
  fixRef,
  originalRef,
  upstreamRef: '2f75cee7f54a4aa6bae219ec9241fc44f980c36b',
  upstreamReceiptBlob: rawBlob,
  safety: 'No app import or live DB. Source modules evaluated with temporary/in-memory SQLite and actual bus code. Workflow execution is not used. Only our fixture child exits at a controlled point; no live process is killed.',
  sourceHashes: hashes,
  checks: checks.map(c => c.name),
  diagnosticAssertionCount: checks.length,
  gateResults,
  gateObservations,
  passes,
  fails,
  partial,
};

const output = arg('--output');
if (output) {
  writeFileSync(resolve(output), JSON.stringify(evidence, null, 2) + '\n');
  console.log(`Evidence written to ${resolve(output)}`);
}

rmSync(directory, { recursive: true, force: true });
process.exit(fails > 0 ? 1 : 0);
