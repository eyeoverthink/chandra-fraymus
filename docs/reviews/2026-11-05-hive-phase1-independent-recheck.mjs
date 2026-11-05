// Independent review of 4ba2c43. Actual pinned function bodies; no live app/DB.
// Diagnostic assertions establish observations, including remaining defects.
// Gate verdicts are computed separately and may FAIL when diagnostics succeed.
// Usage: node this_file.mjs --upstream PINNED_UPSTREAM_DIRECTORY --output FILE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, statSync, mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = '4ba2c433681bc6fecac6acc9b0c1c18c232b1592';
const legacyRef = '8b52ac96d1ce65782d21bd4c770e2fb8bdd2873b';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const sourceCache = new Map(), sourceHashes = {};
const sha = text => createHash('sha256').update(text).digest('hex');
function source(path, pin = ref) {
  const key = `${pin}:${path}`;
  if (!sourceCache.has(key)) {
    const content = execFileSync('git', ['show', key], { cwd: root, encoding: 'utf8' });
    sourceCache.set(key, content); sourceHashes[key] = sha(content);
  }
  return sourceCache.get(key);
}
function moduleFrom(path, bindings, names, pin = ref) {
  const body = source(path, pin).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body));
  return new vm.Script(`(() => { ${body}\nreturn { ${names} }; })()`, { filename: path }).runInNewContext({ Date, Math, JSON, console, ...bindings });
}
function context({ database = ':memory:', pin = ref, afterPublish, initialize = true } = {}) {
  const db = new Database(database);
  if (database !== ':memory:') { db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); }
  const ddl = source('server/db-migrate.js', pin);
  for (const table of ['bus_messages', 'bus_subscriptions', 'bus_triggers', 'workflows', 'workflow_runs']) {
    db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  }
  const bus = moduleFrom('server/fleet/bus.js', { db }, 'initBus,publish,history,onTopic,offTopic,directMessage,subscribe,unsubscribe,listSubscriptions,inbox,topics,busStats', pin);
  const publish = (...args) => { const result = bus.publish(...args); afterPublish?.(args, result); return result; };
  const bridge = moduleFrom('server/intelligence/hive-bridge.js', { db, publish, createHash, readFileSync, statSync }, 'ensureHiveBridgeTable,ingestHiveFile,verifyHiveChain,getIngestionStats,detectFormat,computeReceiptSelf,pythonCanonical', pin);
  if (initialize) bridge.ensureHiveBridgeTable();
  return { db, bus, bridge };
}
const receipts = db => db.prepare("SELECT * FROM bus_messages WHERE topic != 'hive.chain.status' ORDER BY id").all();
const countIngestion = db => db.prepare('SELECT COUNT(*) AS n FROM hive_ingestion').get().n;
const trusted = rows => rows.filter(r => !r.topic.startsWith('hive.unverified.'));
function attachObserver(ctx, inputPath, log) {
  const records = readFileSync(inputPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const topic of new Set(records.map(r => `hive.${r.organ}:${r.type}`))) {
    ctx.bus.onTopic(topic, 'fixture-external-observer', message => {
      appendFileSync(log, JSON.stringify({ self: JSON.parse(message.payload).self, inTransaction: ctx.db.inTransaction }) + '\n');
    });
  }
}
if (arg('--crash-db')) {
  const ctx = context({ database: arg('--crash-db'), afterPublish: args => {
    if (args[1] !== 'hive.chain.status') { process.stdout.write('EXIT_AFTER_NOTIFICATION_BEFORE_COMMIT\n'); process.exit(47); }
  } });
  attachObserver(ctx, arg('--crash-input'), arg('--observer-log'));
  ctx.bridge.ingestHiveFile(arg('--crash-input'));
  throw new Error('Fixture exit point not reached');
}

assert.ok(arg('--upstream'));
const rawBytes = readFileSync(join(resolve(arg('--upstream')), 'hive/receipts.jsonl'));
const blob = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${rawBytes.length}\0`), rawBytes])).digest('hex');
assert.equal(blob, '9fcb7465a12abc80117c45c02c9d064a15ed81cf');
const rawLines = rawBytes.toString('utf8').trim().split('\n'), rawRecords = rawLines.map(line => JSON.parse(line));
const directory = mkdtempSync(join(tmpdir(), 'chandra-hive-independent-'));
const write = (name, data) => { const path = join(directory, name); writeFileSync(path, data); return path; };
const rawPath = write('raw.jsonl', rawBytes), firstPath = write('first.jsonl', rawLines[0] + '\n');
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const workflowExecutions = [];
function addTrigger(ctx, topic) {
  const triggers = moduleFrom('server/fleet/bus-triggers.js', { db: ctx.db, onTopic: ctx.bus.onTopic, offTopic: ctx.bus.offTopic, runPipeline: async (...args) => { workflowExecutions.push(args); return { status: 'success', results: {}, durationMs: 0 }; } }, 'createTrigger');
  const id = `fixture-${workflowExecutions.length}-${Date.now()}`;
  ctx.db.prepare('INSERT INTO workflows(id,name,nodes,edges,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, 'Fixture workflow', '[]', '[]', Date.now(), Date.now());
  triggers.createTrigger(topic, id, 'Fixture trusted workflow');
}

const good = context();
let positive;
try {
  const hashesMatch = rawRecords.map(r => good.bridge.computeReceiptSelf(r) === r.self);
  const verification = good.bridge.verifyHiveChain(rawPath), first = good.bridge.ingestHiveFile(rawPath);
  const repeat = good.bridge.ingestHiveFile(rawPath);
  const formattedPath = write('formatted.jsonl', rawRecords.map(r => JSON.stringify(r)).join('\n') + '\n');
  const formatted = good.bridge.ingestHiveFile(formattedPath);
  const del = good.bridge.pythonCanonical({ text: String.fromCharCode(127) });
  check('all thirteen real upstream hashes and valid ingestion still work', hashesMatch.length === 13 && hashesMatch.every(Boolean) && verification.intact && first.ingested === 13);
  check('ordinary identical and reformatted receipt dedup is fixed', repeat.skipped === 13 && formatted.skipped === 13 && receipts(good.db).length === 13);
  check('DEL is now escaped like Python', del.includes('\\u007f'));
  positive = { hashesMatched: hashesMatch.filter(Boolean).length, verification, first, repeat, formatted, del };
} finally { good.db.close(); }

const proj = context();
let projection;
try {
  addTrigger(proj, 'hive.fra-pipeline:dossier');
  const before = workflowExecutions.length;
  const path = write('projection.jsonl', JSON.stringify({ src: 'fra-pipeline:dossier', msg: 'fixture', type: 'LEDGER_IMPORT', seal: 'unverifiable' }) + '\n');
  const result = proj.bridge.ingestHiveFile(path);
  await new Promise(resolve => setImmediate(resolve));
  const rows = receipts(proj.db);
  check('projection namespace isolation prevents actual trusted trigger dispatch', rows[0].topic === 'hive.unverified.fra-pipeline:dossier' && workflowExecutions.length === before);
  projection = { result, topic: rows[0].topic, trustedWorkflowInvocations: workflowExecutions.length - before };
} finally { proj.db.close(); }

const malformedCtx = context();
let malformed;
try {
  const path = write('bad-last.jsonl', rawLines.slice(0, 12).join('\n') + '\n!' + rawLines[12].slice(1) + '\n');
  const partialPath = write('partial.jsonl', rawLines.slice(0, 12).join('\n') + '\n{"organ":');
  addTrigger(malformedCtx, `hive.${rawRecords[0].organ}:${rawRecords[0].type}`);
  const before = workflowExecutions.length;
  const verify = malformedCtx.bridge.verifyHiveChain(path), partialVerify = malformedCtx.bridge.verifyHiveChain(partialPath);
  const ingest = malformedCtx.bridge.ingestHiveFile(path);
  await new Promise(resolve => setImmediate(resolve));
  const rows = receipts(malformedCtx.db);
  check('complete malformed suffix is now reported by verification', !verify.intact && verify.malformed.length === 1);
  check('ingestion still reports INTACT and publishes twelve trusted receipts from malformed input', ingest.chainStatus === 'INTACT' && trusted(rows).length === 12 && ingest.malformed.length === 1);
  check('malformed input still invokes a real trusted-topic trigger', workflowExecutions.length > before);
  check('partial trailing input still verifies its prefix intact', partialVerify.intact === true && partialVerify.malformed.length === 1);
  malformed = { verify, partialVerify, ingest, trustedPublications: trusted(rows).length, trustedWorkflowInvocations: workflowExecutions.length - before };
} finally { malformedCtx.db.close(); }

const rollbackCtx = context();
let rollback;
try {
  const deliveries = [];
  const topic = `hive.${rawRecords[0].organ}:${rawRecords[0].type}`;
  rollbackCtx.bus.onTopic(topic, 'observer', message => deliveries.push({ self: JSON.parse(message.payload).self, inTransaction: rollbackCtx.db.inTransaction }));
  addTrigger(rollbackCtx, topic);
  rollbackCtx.db.exec("CREATE TRIGGER fixture_reject_checkpoint BEFORE INSERT ON hive_ingestion BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END;");
  const start = workflowExecutions.length;
  const failed = rollbackCtx.bridge.ingestHiveFile(firstPath);
  await new Promise(resolve => setImmediate(resolve));
  const before = { busRows: receipts(rollbackCtx.db).length, ingestionRows: countIngestion(rollbackCtx.db), subscriberDeliveries: deliveries.length, workflowExecutions: workflowExecutions.length - start, workflowRows: rollbackCtx.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get().n };
  rollbackCtx.db.exec('DROP TRIGGER fixture_reject_checkpoint');
  const retry = rollbackCtx.bridge.ingestHiveFile(firstPath);
  await new Promise(resolve => setImmediate(resolve));
  check('database transaction rolls back bus and checkpoint rows together', before.busRows === 0 && before.ingestionRows === 0);
  check('subscriber and real trigger escape rollback before commit', before.subscriberDeliveries === 1 && before.workflowExecutions === 1 && deliveries[0].inTransaction);
  check('retry repeats notification and workflow execution for one durable receipt', deliveries.length === 2 && workflowExecutions.length - start === 2 && receipts(rollbackCtx.db).length === 1);
  rollback = { failed, beforeRetry: before, retry, deliveries, workflowExecutionsAfterRetry: workflowExecutions.length - start, durableReceiptRowsAfterRetry: receipts(rollbackCtx.db).length };
} finally { rollbackCtx.db.close(); }

const crashDatabase = join(directory, 'crash.db'), observerLog = write('observer.jsonl', '');
try {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--crash-db', crashDatabase, '--crash-input', rawPath, '--observer-log', observerLog], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
  throw new Error('Fixture child did not exit');
} catch (e) { assert.equal(e.status, 47); assert.ok(String(e.stdout).includes('EXIT_AFTER_NOTIFICATION_BEFORE_COMMIT')); }
const resumed = context({ database: crashDatabase });
let crash;
try {
  const before = { busRows: receipts(resumed.db).length, ingestionRows: countIngestion(resumed.db) };
  attachObserver(resumed, rawPath, observerLog);
  const retry = resumed.bridge.ingestHiveFile(rawPath);
  const delivered = readFileSync(observerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const firstDeliveries = delivered.filter(row => row.self === rawRecords[0].self).length;
  check('crash leaves zero committed rows before retry', before.busRows === 0 && before.ingestionRows === 0);
  check('restart stores thirteen rows but external observer receives fourteen notifications', receipts(resumed.db).length === 13 && delivered.length === 14 && firstDeliveries === 2);
  crash = { beforeRetry: before, retry, durableReceiptRows: receipts(resumed.db).length, observerNotifications: delivered.length, distinctIdentities: new Set(delivered.map(row => row.self)).size, firstReceiptDeliveries: firstDeliveries };
} finally { resumed.db.close(); }

const poisonCtx = context();
let poisonedDedup;
try {
  const changed = rawRecords.map(r => ({ ...r })); changed[7].claim += ' TAMPERED';
  const path = write('damaged.jsonl', changed.map(r => JSON.stringify(r)).join('\n') + '\n');
  const bad = poisonCtx.bridge.ingestHiveFile(path), repaired = poisonCtx.bridge.ingestHiveFile(rawPath);
  const rows = receipts(poisonCtx.db);
  check('damaged chain still publishes seven trusted-prefix events', trusted(rows).length === 7);
  check('unverified identities block later corrected-chain ingestion', repaired.ingested === 0 && repaired.skipped === 13 && trusted(rows).length === 7);
  poisonedDedup = { damagedIngestion: bad, correctedIngestion: repaired, trustedReceiptRows: trusted(rows).length, unverifiedReceiptRows: rows.length - trusted(rows).length };
} finally { poisonCtx.db.close(); }

const migrationDb = join(directory, 'upgrade.db');
const old = context({ database: migrationDb, pin: legacyRef });
old.bridge.ingestHiveFile(rawPath); old.db.close();
const upgraded = context({ database: migrationDb });
let upgrade;
try {
  const before = receipts(upgraded.db).length, result = upgraded.bridge.ingestHiveFile(rawPath);
  check('dedup-key upgrade republishes thirteen already-stored receipts', before === 13 && result.ingested === 13 && receipts(upgraded.db).length === 26);
  upgrade = { priorDurableReceipts: before, result, afterDurableReceipts: receipts(upgraded.db).length };
} finally { upgraded.db.close(); }

const python = JSON.parse(execFileSync('python', ['-X', 'utf8', '-c', String.raw`
import json,hashlib
cases=[('nested_ascii',{'b':[True,None,1],'a':'text'}),('unicode_text',{'text':'caf'+chr(233)+' '+chr(0x1f9ea)}),('DEL',{'text':chr(127)}),('unicode_keys',{chr(0x10000):'astral',chr(0xe000):'bmp'}),('float_integral',{'n':1.0}),('small_float',{'n':1e-7}),('large_float',{'n':1e20}),('large_integer',{'n':9007199254740993})]
out=[]
def receipt(evidence):
 r={'organ':'review','type':'metric','claim':'fixture','evidence':evidence,'seal':'','i':0,'ts':'2026-11-05T00:00:00Z','prev':'0'*64}
 r['self']=hashlib.sha256(json.dumps(r,sort_keys=True).encode()).hexdigest()
 return r
for name,evidence in cases:
 r=receipt(evidence); out.append({'name':name,'line':json.dumps(r,sort_keys=True),'self':r['self']})
r=receipt({'n':9007199254740992}); original=json.dumps(r,sort_keys=True)
tampered=original.replace('9007199254740992','9007199254740993')
t=json.loads(tampered); del t['self']
expected=hashlib.sha256(json.dumps(t,sort_keys=True).encode()).hexdigest()
print(json.dumps({'cases':out,'collision':{'originalLine':original,'tamperedLine':tampered,'originalSelf':r['self'],'pythonTamperedSelf':expected}}))
`], { encoding: 'utf8' }));
const numeric = context();
let canonicalization, numericTamper;
try {
  canonicalization = python.cases.map(c => ({ name: c.name, pythonSelf: c.self, bridgeSelf: numeric.bridge.computeReceiptSelf(JSON.parse(c.line)), matches: numeric.bridge.computeReceiptSelf(JSON.parse(c.line)) === c.self }));
  check('DEL fix leaves five of the eight Python cases mismatched', canonicalization.filter(c => !c.matches).length === 5 && canonicalization.find(c => c.name === 'DEL').matches);
  const fixture = python.collision;
  const path = write('numeric-tamper.jsonl', fixture.tamperedLine + '\n');
  const verify = numeric.bridge.verifyHiveChain(path), ingest = numeric.bridge.ingestHiveFile(path);
  check('Python confirms changed numeric content no longer matches original self', fixture.originalSelf !== fixture.pythonTamperedSelf);
  check('unsafe integer rounding accepts tampered content as intact and trusted', verify.intact && ingest.chainStatus === 'INTACT' && trusted(receipts(numeric.db)).length === 1);
  numericTamper = { ...fixture, verify, ingest, trustedPublications: trusted(receipts(numeric.db)).length, parsedNumber: JSON.parse(receipts(numeric.db)[0].payload).evidence.n };
} finally { numeric.db.close(); }

const apiCtx = context({ initialize: false });
const app = express(); app.use(express.json());
moduleFrom('server/intelligence/hive-bridge-routes.js', { ...apiCtx.bridge, db: apiCtx.db }, 'installHiveBridgeRoutes').installHiveBridgeRoutes(app);
moduleFrom('server/fleet/bus-routes.js', { ...apiCtx.bus, guardBusMessage: () => ({ pass: true }) }, 'installBusRoutes').installBusRoutes(app);
app.use((e, _req, res, _next) => res.status(500).json({ error: e.message }));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let api;
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await (await fetch(`${base}/api/intelligence/hive-bridge`)).json();
  const delivered = [];
  for (const topic of new Set(rawRecords.map(r => `hive.${r.organ}:${r.type}`))) apiCtx.bus.onTopic(topic, 'api-observer', m => delivered.push(m));
  const ingest = await (await fetch(`${base}/api/intelligence/hive-bridge/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: rawPath }) })).json();
  const stats = await (await fetch(`${base}/api/intelligence/hive-bridge`)).json();
  const history = await (await fetch(`${base}/api/fleet/bus/history/${encodeURIComponent('hive.fra-pipeline:dossier')}`)).json();
  const runtimeWiring = source('server/runtime.js').includes("import { installHiveBridgeRoutes } from './intelligence/hive-bridge-routes.js'") && source('server/runtime.js').includes('installHiveBridgeRoutes(app)');
  check('actual installer, runtime wiring, HTTP stats and bus history remain functional', initial.totalIngested === 0 && runtimeWiring && ingest.ingested === 13 && stats.rawCount === 13 && delivered.length === 13 && history.messages.length > 0);
  api = { initial, ingest, stats, runtimeWiring, subscriberDeliveries: delivered.length, dossierHistoryRows: history.messages.length };
} finally { await new Promise(resolve => server.close(resolve)); apiCtx.db.close(); }

const pass = condition => condition ? 'PASS_ISOLATED' : 'FAIL';
const gateResults = [
  { id: 'RE-P1-G1', status: pass(api.initial.totalIngested === 0 && api.runtimeWiring), scope: 'Installer and static runtime wiring only; no full app boot.' },
  { id: 'RE-P1-G2', status: pass(positive.first.format === 'raw' && projection.result.format === 'projection') },
  { id: 'RE-P1-G3', status: pass(positive.first.ingested === 13 && positive.first.chainStatus === 'INTACT') },
  { id: 'RE-P1-G4', status: pass(projection.topic.startsWith('hive.unverified.')) },
  { id: 'RE-P1-G5', status: !numericTamper.verify.intact && !malformed.partialVerify.intact ? 'PASS' : 'FAIL', scope: 'Numeric content integrity and partial input remain unsafe despite complete-suffix verify fix.' },
  { id: 'RE-P1-G6', status: positive.formatted.skipped !== 13 ? 'FAIL' : (poisonedDedup.correctedIngestion.ingested > 0 && upgrade.afterDurableReceipts === 13 ? 'PASS' : 'PARTIAL'), scope: 'Ordinary formatting dedup passes; recovery and prior-version identity migration fail.' },
  { id: 'RE-P1-G7', status: crash.observerNotifications === 13 && rollback.deliveries.length === 1 ? 'PASS' : 'FAIL', scope: 'Durable row atomicity passes; precommit subscriber delivery repeats.' },
  { id: 'RE-P1-G8', status: malformed.trustedPublications === 0 && malformed.trustedWorkflowInvocations === 0 ? 'PASS' : 'FAIL', scope: 'Projection isolation passes; malformed input still reaches trusted topics.' },
  { id: 'RE-P1-G9', status: pass(api.stats.rawCount === 13) },
  { id: 'RE-P1-G10', status: pass(api.subscriberDeliveries === 13 && api.dossierHistoryRows > 0) },
];
const evidence = { generatedAt: new Date().toISOString(), implementationRef: ref, authorRecheckCommit: '3b901f731f1147e878a6b91b89cf015c347325ef', upstreamRef: '2f75cee7f54a4aa6bae219ec9241fc44f980c36b', upstreamReceiptBlob: blob, sourceHashes,
  safety: 'No application/live DB import. Exact pinned function bodies use disposable SQLite and actual bus/trigger code. Workflow executor is a counter-only mock. Only our fixture child exits. External observer is a local temporary append-only file. No recursive cleanup or live process signalling.',
  retainedTemporaryDirectory: directory, checks, diagnosticAssertionCount: checks.length, positive, projection, malformed, rollback, crash, poisonedDedup, upgrade, canonicalization, numericTamper, api, gateResults,
  summary: { scopedPasses: gateResults.filter(g => g.status === 'PASS_ISOLATED').length, failures: gateResults.filter(g => g.status === 'FAIL').length, partial: gateResults.filter(g => g.status === 'PARTIAL').length, independentlyAcceptedPhases: 0 } };
assert.ok(arg('--output'));
writeFileSync(resolve(arg('--output')), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ diagnosticAssertions: checks.length, ...evidence.summary, output: resolve(arg('--output')) }));
