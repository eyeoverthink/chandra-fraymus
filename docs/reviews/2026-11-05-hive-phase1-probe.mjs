// Independent diagnostic review of 8b52ac9. No application import or live writer.
// Usage: node this_file.mjs --upstream PINNED_UPSTREAM_DIRECTORY [--output FILE]
// Assertions confirm both working controls and baseline defects, not acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = '8b52ac96d1ce65782d21bd4c770e2fb8bdd2873b';
const hashes = {}, sourceCache = new Map();
const sha = text => createHash('sha256').update(text).digest('hex');
const arg = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
function source(path) {
  if (!sourceCache.has(path)) {
    const content = execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
    sourceCache.set(path, content); hashes[path] = sha(content);
  }
  return sourceCache.get(path);
}
function moduleFrom(path, bindings, exports) {
  const body = source(path).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body), `Unprocessed import: ${path}`);
  return new vm.Script(`(() => { ${body}\n return { ${exports} }; })()`, { filename: path }).runInNewContext({ Date, Math, JSON, console, ...bindings });
}
function context({ database = ':memory:', initialize = true, afterPublish } = {}) {
  const db = new Database(database);
  if (database !== ':memory:') { db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); }
  const ddl = source('server/db-migrate.js');
  for (const table of ['bus_messages', 'bus_subscriptions', 'bus_triggers', 'workflows', 'workflow_runs']) {
    db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  }
  const bus = moduleFrom('server/fleet/bus.js', { db }, 'initBus,publish,directMessage,subscribe,unsubscribe,listSubscriptions,inbox,history,topics,busStats,onTopic,offTopic');
  const publish = (...args) => { const result = bus.publish(...args); afterPublish?.(args, result); return result; };
  const bridge = moduleFrom('server/intelligence/hive-bridge.js', { db, publish, createHash, readFileSync, statSync }, 'ensureHiveBridgeTable,ingestHiveFile,verifyHiveChain,getIngestionStats,detectFormat,_pythonCanonical:pythonCanonical,_computeReceiptSelf:computeReceiptSelf');
  if (initialize) bridge.ensureHiveBridgeTable();
  return { db, bus, bridge };
}

if (arg('--crash-db')) {
  const child = context({ database: arg('--crash-db'), afterPublish: args => {
    if (args[1] !== 'hive.chain.status') {
      // Deliberately exit our own fixture process after a committed publication,
      // before hive_ingestion insertion. No live process is signalled or killed.
      process.stdout.write('EXIT_AFTER_COMMITTED_BUS_PUBLICATION\n');
      process.exit(47);
    }
  } });
  child.bridge.ingestHiveFile(arg('--crash-input'));
  throw new Error('Crash point was not reached');
}

assert.ok(arg('--upstream'), '--upstream requires the pinned source snapshot');
const upstream = resolve(arg('--upstream'));
const rawBytes = readFileSync(join(upstream, 'hive/receipts.jsonl'));
const rawBlob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${rawBytes.length}\0`), rawBytes])).digest('hex');
assert.equal(rawBlob, '9fcb7465a12abc80117c45c02c9d064a15ed81cf', 'Exact reviewed upstream receipt bytes');
const rawLines = rawBytes.toString('utf8').trim().split('\n');
const rawRecords = rawLines.map(line => JSON.parse(line));
const directory = mkdtempSync(join(tmpdir(), 'chandra-hive-phase1-review-'));
const write = (name, content) => { const path = join(directory, name); writeFileSync(path, content); return path; };
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const ledgerRows = db => db.prepare('SELECT COUNT(*) AS n FROM hive_ingestion').get().n;
const busReceipts = db => db.prepare("SELECT * FROM bus_messages WHERE topic != 'hive.chain.status' ORDER BY id").all();
const rawPath = write('raw.jsonl', rawBytes);
check('runtime registers the actual hive bridge route installer', source('server/runtime.js').includes("import { installHiveBridgeRoutes } from './intelligence/hive-bridge-routes.js'") && source('server/runtime.js').includes('installHiveBridgeRoutes(app)'));
const projectionRecord = { ts: '2026-11-05T00:00:00Z', type: 'LEDGER_IMPORT', src: 'fra-pipeline:dossier', msg: 'projection fixture', seal: 'unverifiable' };
const projectionPath = write('projection.jsonl', JSON.stringify(projectionRecord) + '\n');

const good = context();
let positive;
try {
  const perReceipt = rawRecords.map(record => good.bridge._computeReceiptSelf(record) === record.self);
  check('all thirteen upstream self hashes independently match', perReceipt.length === 13 && perReceipt.every(Boolean));
  const verified = good.bridge.verifyHiveChain(rawPath);
  check('full real upstream chain verifies intact', verified.total === 13 && verified.intact);
  const subscriberEvents = [];
  for (const topic of new Set(rawRecords.map(record => `hive.${record.organ}:${record.type}`))) good.bus.onTopic(topic, 'review', message => subscriberEvents.push(message));
  const first = good.bridge.ingestHiveFile(rawPath);
  const second = good.bridge.ingestHiveFile(rawPath);
  check('first raw ingestion persists thirteen verified receipts', first.ingested === 13 && first.chainStatus === 'INTACT' && ledgerRows(good.db) === 13);
  check('actual subscribers receive the thirteen receipts', subscriberEvents.length === 13);
  check('byte-identical repeated ingestion skips all receipts', second.ingested === 0 && second.skipped === 13 && busReceipts(good.db).length === 13);
  const reformattedPath = write('raw.jsonl', rawRecords.map(record => JSON.stringify(record)).join('\n') + '\n');
  const reformattedVerification = good.bridge.verifyHiveChain(reformattedPath);
  const reformatted = good.bridge.ingestHiveFile(reformattedPath);
  check('reformatted receipts still pass their original receipt hashes', reformattedVerification.intact);
  check('same receipt identities are published again after whitespace-only reserialization', reformatted.ingested === 13 && busReceipts(good.db).length === 26);
  positive = { perReceiptHashes: perReceipt, verification: verified, first, byteIdenticalRepeat: second, subscriberEventsBeforeReformat: 13, reformattedVerification, reformatted, storedReceiptRowsAfterReformat: ledgerRows(good.db) };
} finally { good.db.close(); }

const rotation = context();
try {
  rotation.bridge.ingestHiveFile(rawPath);
  const replacement = { ...rawRecords[0], claim: 'Different genesis content for same-path rotation control' };
  replacement.self = rotation.bridge._computeReceiptSelf(replacement);
  writeFileSync(rawPath, JSON.stringify(replacement) + '\n');
  const first = rotation.bridge.ingestHiveFile(rawPath);
  const repeated = rotation.bridge.ingestHiveFile(rawPath);
  check('same-path replacement with genuinely new receipt content ingests once', first.ingested === 1 && first.chainStatus === 'INTACT' && repeated.ingested === 0 && repeated.skipped === 1);
  positive.newContentRotation = { first, repeated };
} finally { writeFileSync(rawPath, rawBytes); rotation.db.close(); }

const bad = context();
let damaged;
try {
  const changed = rawRecords.map(record => ({ ...record }));
  changed[7].claim += ' TAMPERED';
  const path = write('damaged.jsonl', changed.map(record => JSON.stringify(record)).join('\n') + '\n');
  const verify = bad.bridge.verifyHiveChain(path);
  const ingested = bad.bridge.ingestHiveFile(path);
  const events = busReceipts(bad.db).map(row => JSON.parse(row.payload));
  check('structured tampering is correctly detected at receipt seven', !verify.intact && verify.breakIndex === 7);
  check('damaged chain nonetheless publishes every receipt', ingested.chainStatus === 'DAMAGED' && events.length === 13);
  check('damaged file still grants trusted flags to its seven-record prefix', events.filter(event => event._hive.chainVerified).length === 7);
  damaged = { verify, ingestion: ingested, publishedReceipts: events.length, publishedWithVerifiedFlag: events.filter(event => event._hive.chainVerified).length };
} finally { bad.db.close(); }

const projection = context();
let untrusted;
try {
  const executions = [];
  const trigger = moduleFrom('server/fleet/bus-triggers.js', { db: projection.db, onTopic: projection.bus.onTopic, offTopic: projection.bus.offTopic, runPipeline: async (...args) => { executions.push(args); return { status: 'success', results: {}, durationMs: 0 }; } }, 'createTrigger');
  const now = Date.now();
  projection.db.prepare('INSERT INTO workflows(id,name,nodes,edges,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('fixture-trusted', 'Trusted dossier fixture', '[]', '[]', now, now);
  trigger.createTrigger('hive.fra-pipeline:dossier', 'fixture-trusted', 'Trusted RE workflow');
  const result = projection.bridge.ingestHiveFile(projectionPath);
  await new Promise(resolve => setImmediate(resolve));
  const event = JSON.parse(busReceipts(projection.db)[0].payload);
  check('projection is detected and marked chainVerified false', result.format === 'projection' && event._hive.chainVerified === false);
  check('projection verification returns an explicit error', !!projection.bridge.verifyHiveChain(projectionPath).error);
  check('projection nevertheless launches the actual topic-trigger dispatch', executions.length === 1);
  untrusted = { ingestion: result, eventMetadata: event._hive, topic: busReceipts(projection.db)[0].topic, workflowInvocations: executions.length };
} finally { projection.db.close(); }

const truncated = context();
let malformed;
try {
  const lastLineWithOneByteChanged = '!' + rawLines[12].slice(1);
  const completeBadPath = write('malformed-terminated.jsonl', rawLines.slice(0, 12).join('\n') + '\n' + lastLineWithOneByteChanged + '\n');
  const partialPath = write('partial-last-line.jsonl', rawLines.slice(0, 12).join('\n') + '\n{"organ":');
  const oneBad = write('only-invalid.jsonl', '{"broken":\n');
  const complete = truncated.bridge.verifyHiveChain(completeBadPath);
  const partial = truncated.bridge.verifyHiveChain(partialPath);
  const empty = truncated.bridge.verifyHiveChain(oneBad);
  check('a one-byte syntax corruption in the final terminated record is silently removed and reported intact', complete.intact && complete.total === 12);
  check('partial last record also reports its prefix intact without a partial-input warning', partial.intact && partial.total === 12);
  check('an entirely malformed file is reported as an intact empty input', empty.intact && empty.total === 0);
  const ingested = truncated.bridge.ingestHiveFile(completeBadPath);
  check('ingestion of malformed complete input publishes twelve verified-prefix receipts', ingested.chainStatus === 'INTACT' && ingested.ingested === 12);
  malformed = { malformedTerminated: complete, partialLastLine: partial, entirelyMalformed: empty, ingestion: ingested };
} finally { truncated.db.close(); }

const pythonFixtures = JSON.parse(execFileSync('python', ['-X', 'utf8', '-c', String.raw`
import json,hashlib
examples=[('nested_ascii',{'b':[True,None,1],'a':'quoted text'}),('unicode_text',{'text':'caf'+chr(233)+' '+chr(0x1f9ea)+' '+chr(0x2014)}),('delete_character',{'text':chr(127)}),('unicode_keys',{chr(0x10000):'astral',chr(0xe000):'bmp'}),('float_integral',{'n':1.0}),('small_float',{'n':1e-7}),('large_float',{'n':1e20}),('large_integer',{'n':9007199254740993})]
out=[]
for name,evidence in examples:
 r={'organ':'review','type':'metric','claim':'fixture','evidence':evidence,'seal':'','i':0,'ts':'2026-11-05T00:00:00Z','prev':'0'*64}
 canonical=json.dumps(r,sort_keys=True); r['self']=hashlib.sha256(canonical.encode()).hexdigest()
 out.append({'name':name,'line':json.dumps(r,sort_keys=True),'canonical':canonical,'self':r['self']})
print(json.dumps(out))
`], { encoding: 'utf8' }));
const canonical = context();
let matrix, schema;
try {
  matrix = pythonFixtures.map(fixture => ({ name: fixture.name, pythonSelf: fixture.self, bridgeSelf: canonical.bridge._computeReceiptSelf(JSON.parse(fixture.line)), matches: canonical.bridge._computeReceiptSelf(JSON.parse(fixture.line)) === fixture.self }));
  check('additional nested ASCII control hashes match', matrix.find(row => row.name === 'nested_ascii').matches);
  check('DEL, Unicode key order, float and large integer cases expose further hash mismatches', ['delete_character', 'unicode_keys', 'float_integral', 'small_float', 'large_float', 'large_integer'].every(name => !matrix.find(row => row.name === name).matches));
  const invalidSchema = JSON.parse(pythonFixtures[0].line);
  delete invalidSchema.type;
  invalidSchema.self = canonical.bridge._computeReceiptSelf(invalidSchema);
  const path = write('missing-type.jsonl', JSON.stringify(invalidSchema) + '\n');
  const verify = canonical.bridge.verifyHiveChain(path);
  const ingestion = canonical.bridge.ingestHiveFile(path);
  check('missing required receipt type is still accepted as intact', verify.intact && ingestion.ingested === 1);
  schema = { missingTypeVerification: verify, missingTypeIngestion: ingestion, publishedTopic: busReceipts(canonical.db)[0].topic };
} finally { canonical.db.close(); }

const crashDatabase = join(directory, 'restart.db');
let crashExit;
try {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-db', crashDatabase, '--crash-input', rawPath], { encoding: 'utf8', stdio: 'pipe' });
  throw new Error('Fixture child did not stop at crash point');
} catch (error) {
  assert.equal(error.status, 47);
  check('controlled fixture process exits after committed publication', String(error.stdout).includes('EXIT_AFTER_COMMITTED_BUS_PUBLICATION'));
  crashExit = error.status;
}
const resumed = context({ database: crashDatabase });
let crash;
try {
  const before = { receiptRows: ledgerRows(resumed.db), publishedRows: busReceipts(resumed.db).length };
  const retry = resumed.bridge.ingestHiveFile(rawPath);
  const bySelf = new Map();
  for (const row of busReceipts(resumed.db)) { const record = JSON.parse(row.payload); bySelf.set(record.self, (bySelf.get(record.self) || 0) + 1); }
  check('restart sees a published event with no ingestion checkpoint', before.publishedRows === 1 && before.receiptRows === 0);
  check('restart replays the first receipt and produces fourteen events for thirteen identities', busReceipts(resumed.db).length === 14 && bySelf.size === 13 && bySelf.get(rawRecords[0].self) === 2);
  crash = { fixtureExitCode: crashExit, beforeRetry: before, retry, publishedRowsAfterRetry: busReceipts(resumed.db).length, distinctReceiptIdentities: bySelf.size, firstReceiptDeliveries: bySelf.get(rawRecords[0].self) };
} finally { resumed.db.close(); }

const api = context({ initialize: false });
let apiResults;
const app = express(); app.use(express.json());
moduleFrom('server/intelligence/hive-bridge-routes.js', { ...api.bridge, db: api.db }, 'installHiveBridgeRoutes').installHiveBridgeRoutes(app);
moduleFrom('server/fleet/bus-routes.js', { ...api.bus, guardBusMessage: () => ({ pass: true }) }, 'installBusRoutes').installBusRoutes(app);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
const server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = path => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
  const initialStats = await (await fetch(`${base}/api/intelligence/hive-bridge`)).json();
  check('actual route installation creates the table and stats API returns zero counts', initialStats.totalIngested === 0 && ledgerRows(api.db) === 0);
  const ingestion = await (await fetch(`${base}/api/intelligence/hive-bridge/ingest`, post(rawPath))).json();
  const stats = await (await fetch(`${base}/api/intelligence/hive-bridge`)).json();
  const list = await (await fetch(`${base}/api/intelligence/hive-bridge/receipts?format=raw&limit=2`)).json();
  const history = await (await fetch(`${base}/api/fleet/bus/history/${encodeURIComponent('hive.fra-pipeline:dossier')}`)).json();
  const projectionResponse = await fetch(`${base}/api/intelligence/hive-bridge/verify`, post(projectionPath));
  check('actual ingestion, format stats and paginated receipt routes work', ingestion.ingested === 13 && stats.rawCount === 13 && list.total === 13 && list.receipts.length === 2);
  check('actual bus history route returns imported dossier events', history.messages.length > 0);
  check('projection verify API returns HTTP 400', projectionResponse.status === 400);
  apiResults = { startupInstallerCreatesTable: true, initialStats, ingestion, stats, receiptPage: { count: list.receipts.length, total: list.total }, dossierHistoryCount: history.messages.length, projectionVerifyStatus: projectionResponse.status };
} finally { await new Promise(resolve => server.close(resolve)); api.db.close(); }

const gateResults = [
  ['RE-P1-G1', 'PASS_ISOLATED', 'Actual installer creates the table; runtime import/call wiring inspected. Full app boot/live deployment not run.'],
  ['RE-P1-G2', 'PASS_ISOLATED', 'Raw and projection formats recognized on valid samples.'],
  ['RE-P1-G3', 'PASS_ISOLATED', 'Thirteen valid raw receipts publish with _hive.chainVerified true.'],
  ['RE-P1-G4', 'PASS_ISOLATED', 'Projection event carries _hive.chainVerified false; trust enforcement separately fails G8.'],
  ['RE-P1-G5', 'FAIL', 'Structured tampering detected, but malformed final records are discarded and reported intact.'],
  ['RE-P1-G6', 'PARTIAL', 'Byte-identical repeat and genuinely new same-path replacement work; same-path reserialization republishes thirteen existing receipt identities. Stable identity expectations need clarification.'],
  ['RE-P1-G7', 'FAIL', 'Controlled exit/restart duplicates a committed receipt publication.'],
  ['RE-P1-G8', 'FAIL', 'Damaged raw prefix is marked verified; all raw entries publish; projection triggers the workflow mock.'],
  ['RE-P1-G9', 'PASS_ISOLATED', 'Actual GET stats route returns format breakdown.'],
  ['RE-P1-G10', 'PASS_ISOLATED', 'Actual subscribers and bus-history route receive hive events.'],
].map(([id, status, evidence]) => ({ id, status, evidence }));
const evidence = {
  generatedAt: new Date().toISOString(), implementationRef: ref, upstreamRef: '2f75cee7f54a4aa6bae219ec9241fc44f980c36b', upstreamReceiptBlob: rawBlob,
  safety: 'No app import or live DB. Source modules evaluated with temporary/in-memory SQLite and actual bus code. Workflow execution is a counter-only mock. Only our fixture child exits at a controlled point; no live process is killed. Python emits canonical fixtures only.',
  sourceHashes: hashes, retainedTemporaryDirectory: directory, checks, diagnosticAssertionCount: checks.length,
  positive, damaged, projection: untrusted, malformed, additionalCanonicalization: matrix, missingSchema: schema, crash, api: apiResults,
  gateResults, scopedPasses: gateResults.filter(result => result.status === 'PASS_ISOLATED').length, failures: gateResults.filter(result => result.status === 'FAIL').length, partial: gateResults.filter(result => result.status === 'PARTIAL').length,
};
const output = arg('--output');
if (output) { writeFileSync(resolve(output), JSON.stringify(evidence, null, 2) + '\n'); console.log(JSON.stringify({ diagnosticAssertions: checks.length, upstreamHashesMatched: positive.perReceiptHashes.filter(Boolean).length, scopedPasses: evidence.scopedPasses, gateFailures: evidence.failures, partialGates: evidence.partial, output: resolve(output) })); }
else console.log(JSON.stringify(evidence, null, 2));
