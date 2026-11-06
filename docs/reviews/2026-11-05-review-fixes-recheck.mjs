// Independent recheck of 817ddfe. No live DB/app, model, compiler or deletion.
// node --experimental-vm-modules this-file.mjs --upstream DIR --output FILE
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = '817ddfe4872318b1971c4239be8cfcf758450cbc';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--upstream') && arg('--output'), '--upstream and --output required');
const cache = new Map(), sourceHashes = {}, checks = [], logs = [];
const sha = value => createHash('sha256').update(value).digest('hex');
function source(path) {
  if (!cache.has(path)) { const value = execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' }); cache.set(path, value); sourceHashes[path] = sha(value); }
  return cache.get(path);
}
function moduleFrom(path, bindings, names, dynamic = {}) {
  const body = source(path).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body));
  const context = vm.createContext({ Math, JSON, console: { log() {}, error: (...v) => logs.push(v.join(' ')) }, ...bindings });
  const modules = new Map();
  return new vm.Script(`(()=>{${body}\nreturn {${names}};})()`, { filename: path, importModuleDynamically: async specifier => {
    assert.ok(Object.hasOwn(dynamic, specifier), `Unexpected dynamic import: ${specifier}`);
    if (!modules.has(specifier)) {
      const values = dynamic[specifier];
      const m = new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); }, { context });
      await m.link(() => { throw new Error('Nested imports disabled'); }); await m.evaluate(); modules.set(specifier, m);
    }
    return modules.get(specifier);
  } }).runInContext(context);
}
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
const directory = mkdtempSync(join(tmpdir(), 'chandra-817ddfe-review-'));
const upstream = join(resolve(arg('--upstream')), 'dossier-ls');
const blobs = { 'decompiled.c': '7c61c5b00a778d62afa12bcc1c06325db8463128', 'annotations.md': '5d2de19c3a5a38aa25b1fb41b2b130d0763fde20', 'imports.txt': 'c67e01e367bb73d422327bc0708f9ef082823bea', 'binary.sha256': 'd7d4e85ed3e71aaf5a901926f95e4579e783b765', 'dossier.seal': '2a9cada682e45598688f9f91a7772dc08966dd6d' };
for (const [name, expected] of Object.entries(blobs)) {
  const bytes = readFileSync(join(upstream, name));
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), expected);
}
const ddl = source('server/db-migrate.js');
function fixture() {
  const db = new Database(':memory:'), clock = { current: 1700000000000 };
  class FixtureDate extends Date { static now() { return clock.current++; } }
  for (const table of ['agent_memories', 'bus_messages', 'bus_subscriptions']) db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  db.exec(`CREATE UNIQUE INDEX fixture_identity ON agent_memories(agent_id,key);
    CREATE TABLE harness_evidence (run_id,step,tool,args_hash,result_hash,evidence_sha,duration_ms,refused,created_at);
    CREATE TABLE fleet_memories (id,agent_id,text,tags,created_at,user_id);`);
  const bindings = { db, Date: FixtureDate };
  const memory = moduleFrom('server/fleet/agent-memory.js', bindings, 'storeMemory,recallMemories');
  const bus = moduleFrom('server/fleet/bus.js', bindings, 'publish,history');
  const engine = moduleFrom('server/intelligence/dossier-engine.js', { ...bindings, ...memory, publish: bus.publish, createHash, readFileSync, readdirSync, statSync, existsSync, join, resolve, basename },
    'ensureDossierTable,parseDecompiledC,parseAnnotations,parseImports,verifyDossierSeal,gradeEvidence,parseDossier,gradeDossier,storeDossier,processDossier,listDossiers,getDossier,getDossierFunctions,getDossierFunction');
  engine.ensureDossierTable();
  const lineage = moduleFrom('server/intelligence/lineage.js', { ...bindings, createHash, publish: bus.publish }, 'PATIENT,AGE_TIERS,readChart,getCurrentAge,getTier,getAllTiers,evaluateFormula,verifyTier,buildLineageContext,getLineageStats,getRecentReadings');
  const compiler = { available: false, mode: 'ok', commands: [], directories: new Set(), files: new Map(), writes: [], removals: [], mkdirs: [] };
  const model = { response: '{"predictedRate":87,"confidence":"high","reasoning":"fixture opinion"}', calls: [] };
  const reTools = moduleFrom('server/fleet/re-tools.js', { ...bindings, ...memory, ...engine, verifyHiveChain: () => ({ error: 'not exercised' }) }, 'createRETools', {
    'node:child_process': { execFileSync: (file, args, options) => {
      compiler.commands.push({ file, args, timeout: options.timeout });
      if (!compiler.available) throw Object.assign(new Error('fixture missing clang'), { code: 'ENOENT' });
      if (args[0] === '--version') return Buffer.from('clang fixture version');
      if (compiler.mode === 'timeout') throw Object.assign(new Error('fixture timeout'), { code: 'ETIMEDOUT' });
      if (compiler.mode === 'syntax') throw Object.assign(new Error('fixture syntax diagnostic'), { status: 1, stderr: Buffer.from('fixture: error: invalid C') });
      return Buffer.from('');
    } },
    'node:fs': {
      writeFileSync: (path, bytes) => { compiler.writes.push({ path, replaced: compiler.files.has(path), bytes }); if (compiler.mode === 'write_error') throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' }); compiler.files.set(path, bytes); },
      unlinkSync: path => { throw new Error(`Unexpected unlink: ${path}`); },
      mkdirSync: (path, options) => { compiler.mkdirs.push({ path, reused: compiler.directories.has(path), options }); compiler.directories.add(path); },
      rmSync: (path, options) => { const removed = [...compiler.files.keys()].filter(p => { const rel = relative(path, p); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); }); for (const p of removed) compiler.files.delete(p); compiler.removals.push({ path, options, removed }); },
    },
    'node:path': { join, resolve },
    '../commerce/shared.js': { chatOllama: async (messages, options) => { model.calls.push({ messages, options }); return model.response; } },
    '../config.js': {}, // Actual config.js has named exports, no default; matches that contract.
  }).createRETools();
  return { db, clock, FixtureDate, bindings, memory, bus, engine, lineage, compiler, model, reTools };
}
const contexts = [];
const make = () => { const f = fixture(); contexts.push(f); return f; };
function dossier(name, binary, functions) {
  const path = join(directory, name); mkdirSync(path);
  writeFileSync(join(path, 'binary.sha256'), `${binary} fixture.bin\n`);
  writeFileSync(join(path, 'decompiled.c'), functions.map(f => `// ==== ${f.name} @ ${f.address || '0x1000'} ====\n${f.body}\n`).join('\n'));
  return path;
}
const servers = [];
async function apiFor(f, kind) {
  const app = express(); app.use(express.json());
  if (kind === 'lineage') moduleFrom('server/intelligence/lineage-routes.js', { Date, ...f.lineage }, 'installLineageRoutes').installLineageRoutes(app);
  else moduleFrom('server/intelligence/dossier-engine-routes.js', { Date, ...f.engine }, 'installDossierRoutes').installDossierRoutes(app);
  app.use((e, _req, res, _next) => res.status(500).json({ error: e.message }));
  const s = await new Promise(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); }); servers.push(s);
  return async (path, body) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 80); } return { status: r.status, body: data }; };
}
try {
  const f = make();
  const selfTests = f.lineage.readChart('independent-recheck');
  check('33 author lineage examples pass', selfTests.testsPassed === 33 && selfTests.testsTotal === 33);
  const ts = source('server/fleet/tools.js'), anchor = ts.indexOf("name: 'lineage_chart'"), start = ts.lastIndexOf('\n    {', anchor) + 5, end = ts.indexOf('\n    },', anchor) + '\n    }'.length;
  const tool = new vm.Script(`(${ts.slice(start, end)})`).runInNewContext({ ...f.lineage, object: properties => ({ type: 'object', properties }), ledger: { record() {} } });
  const fleet = moduleFrom('server/fleet/runtime.js', { ...f.bindings, randomUUID, ...f.lineage, sealToolResult: (tool, args, result) => ({ result, evidence: { tool } }), isClockTrusted: () => true }, 'setFleetTools,executeTool');
  fleet.setFleetTools([tool]);
  const dispatch = async args => (await fleet.executeTool('lineage_chart', args, { runId: 'fixture', step: 1 })).result;
  const modes = {};
  for (const mode of ['status', 'read', 'tiers', 'verify', 'evaluate']) modes[mode] = await dispatch({ mode, age: 2, formula: 'quadratic', args: [1, -5, 6] });
  check('all five lineage modes have distinct correct fleet dispatch behavior', modes.status.totalReadings === 1 && modes.read.persisted && modes.tiers.tiers.length === 6 && modes.verify.total === 4 && modes.evaluate.result.x1 === 3 && f.lineage.getLineageStats().totalReadings === 2);
  const api = await apiFor(f, 'lineage'), prefix = '/api/intelligence/lineage';
  const evaluate = body => api(`${prefix}/evaluate`, body);
  const lineage = {
    authorExamples: `${selfTests.testsPassed}/${selfTests.testsTotal}`,
    modes: Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, { hasResult: !!v.result, persisted: v.persisted ?? null, tierCount: v.tiers?.length ?? null, tests: v.total ?? null }])),
    derivative: await evaluate({ age: 9, formula: 'polynomialDerivative', args: [[0, 0, 0, 1], 2] }),
    integral: await evaluate({ age: 9, formula: 'polynomialIntegrate', args: [[0, 2], 0, 3] }),
    inherited: await evaluate({ age: 2, formula: 'constructor', args: [123] }),
    degenerate: await evaluate({ age: 2, formula: 'quadratic', args: [0, 1, 1] }),
    wrongAdd: await evaluate({ age: 0, formula: 'add', args: ['1', 1] }),
    wideHamming: await evaluate({ age: 13, formula: 'hamming', args: [0, 2 ** 40] }),
    wrongPolynomial: await evaluate({ age: 9, formula: 'polynomialEval', args: [['2', 3], 2] }),
    fractionalHamming: await evaluate({ age: 13, formula: 'hamming', args: [1.5, 0] }),
    zeroRadius: await evaluate({ age: 17, formula: 'visViva', args: [0, 0] }),
    cancellation: await evaluate({ age: 2, formula: 'quadratic', args: [1, 1e16, 1] }),
    repeatedZero: await evaluate({ age: 2, formula: 'quadratic', args: [1, 0, 0] }),
    internal: await evaluate({ age: 9, formula: '_integrate', args: ['2*x', 0, 3] }),
  };
  const fleetDerivative = await dispatch({ mode: 'evaluate', age: 9, formula: 'polynomialDerivative', args: [[0, 0, 0, 1], 2] });
  const fleetIntegral = await dispatch({ mode: 'evaluate', age: 9, formula: 'polynomialIntegrate', args: [[0, 2], 0, 3] });
  check('polynomial calculus works through REST and fleet dispatch', lineage.derivative.body.result.derivative === 12 && lineage.integral.body.result.integral === 9 && fleetDerivative.result.derivative === 12 && fleetIntegral.result.integral === 9);
  check('inherited methods, degenerate quadratic, string addition and out-of-width Hamming are rejected', ['inherited', 'degenerate', 'wrongAdd', 'wideHamming', 'internal'].every(k => lineage[k].status === 400));
  check('remaining validation gaps reproduce as successful wrong-type/fractional/null results', lineage.wrongPolynomial.body.result === '62' && lineage.fractionalHamming.body.result === 1 && lineage.zeroRadius.body.result.v === null && lineage.zeroRadius.status === 200);
  check('original small quadratic root is recovered', lineage.cancellation.body.result.x1 !== 0 && Math.abs(lineage.cancellation.body.result.x1 * lineage.cancellation.body.result.x2 - 1) < 1e-12);
  check('new repeated-zero quadratic regression returns successful null roots', lineage.repeatedZero.status === 200 && lineage.repeatedZero.body.result.real && lineage.repeatedZero.body.result.x1 === null && lineage.repeatedZero.body.result.x2 === null);
  const failure = make();
  failure.db.exec("CREATE TRIGGER reject_lineage BEFORE INSERT ON lineage_readings BEGIN SELECT RAISE(ABORT,'fixture lineage rejection'); END;");
  const persistence = failure.lineage.readChart('rejected');
  check('failed lineage save is explicit and produces no success event', !persistence.persisted && !!persistence.persistError && !persistence.busPublished && failure.bus.history('system.lineage.chart-read').length === 0);
  failure.db.exec('DROP TRIGGER reject_lineage'); const retry = failure.lineage.readChart('retry');
  check('lineage retry persists and restores context', retry.persisted && retry.busPublished && failure.lineage.buildLineageContext().includes('Age 17'));
  const broken = make(); broken.lineage.AGE_TIERS[0].formulas.add = () => 999;
  const prereq = broken.lineage.readChart('arithmetic-failure');
  const prereqPrompt = broken.lineage.buildLineageContext();
  check('first-tier failure is distinct from successful Arithmetic', prereq.currentAge === null && broken.lineage.getCurrentAge() === null && prereqPrompt.includes('No verified tier') && !prereqPrompt.includes('Mastered:'));
  const later = make(); later.lineage.AGE_TIERS[1].formulas.quadratic = () => ({ x1: 999, x2: 999 });
  const laterRead = later.lineage.readChart('algebra-failure');
  check('later-tier failure retains only verified Arithmetic', laterRead.currentAge === 0 && later.lineage.buildLineageContext().includes('Peano') && !later.lineage.buildLineageContext().includes("Vieta"));
  Object.assign(lineage, { persistence, retry: { persisted: retry.persisted, busPublished: retry.busPublished }, firstTierFailure: { currentAge: prereq.currentAge, getterAge: broken.lineage.getCurrentAge(), statsAge: broken.lineage.getLineageStats().currentAge, prompt: prereqPrompt } });

  const re = make(), parsed = re.engine.parseDossier(upstream);
  const observedImports = [...readFileSync(join(upstream, 'imports.txt'), 'utf8').matchAll(/^\d+\s+/gm)].length;
  const upstreamResult = { functions: parsed.functions.length, observedImports, parsedImports: parsed.imports.length, annotations: Object.keys(parsed.annotations.functions).length, importVerification: parsed.annotations.importVerification, scores: parsed.annotations.redBlueScores, seal: parsed.seal, files: readdirSync(upstream) };
  check('upstream functions and annotation headings now parse', parsed.functions.length === 136 && upstreamResult.annotations === 2);
  check('actual upstream import rows still parse as zero', observedImports === 90 && parsed.imports.length === 0);
  const falseVerification = re.engine.gradeEvidence([{ name: 'literal', address: '0x1000', body: 'int literal(void){const char *s="printf";return 0;}', lines: 1 }], { functions: { 'literal@0x1000': { annotation: 'Model claims this uses printf.' } }, importVerification: { printf: { status: 'verified' } } }, [{ name: 'printf' }], 'a'.repeat(64));
  check('string-literal import mention is still promoted to verified', falseVerification[0].grade === 'verified');
  const ingested = re.engine.processDossier(upstream);
  check('actual dossier bus contract now persists the processed event', ingested.busPublished && re.bus.history('system.re.dossier.processed').length === 1);
  re.db.exec("CREATE TRIGGER reject_bus BEFORE INSERT ON bus_messages BEGIN SELECT RAISE(ABORT,'fixture bus rejection'); END;");
  const rejectedBus = re.engine.processDossier(upstream);
  check('failed dossier publication reports false and logs error', rejectedBus.busPublished === false && logs.some(s => s.includes('dossier-engine') && s.includes('fixture bus rejection')));
  const sealDir = join(directory, 'seals'); mkdirSync(sealDir); writeFileSync(join(sealDir, 'a.txt'), 'A'); writeFileSync(join(sealDir, 'b.txt'), 'B');
  const sealRows = [['a.txt', 'A'], ['b.txt', 'B']].map(([n, v]) => `${sha(v)}  ${n}\n`).join('');
  writeFileSync(join(sealDir, 'dossier.seal'), `${sha(sealRows)}  -\n`);
  const validSeal = re.engine.verifyDossierSeal(sealDir);
  writeFileSync(join(sealDir, 'a.txt'), 'TAMPERED'); const tamperedSeal = re.engine.verifyDossierSeal(sealDir);
  const legacySealDir = join(directory, 'legacy-seal'); mkdirSync(legacySealDir); writeFileSync(join(legacySealDir, 'a.txt'), 'A'); writeFileSync(join(legacySealDir, 'dossier.seal'), sha(`a.txt:${sha('A')}\n`));
  const legacySeal = re.engine.verifyDossierSeal(legacySealDir);
  check('both new shasum-shaped and legacy seal fixtures are accepted', validSeal.status === 'valid' && legacySeal.status === 'valid');
  check('seal completeness still guessed by file count', tamperedSeal.status === 'unverifiable' && parsed.seal.status === 'invalid' && upstreamResult.files.length > 5);

  const store = make(), a = 'a'.repeat(64), b = 'b'.repeat(64), manySha = 'c'.repeat(64);
  const body = 'int shared(void){return 1;}';
  const aPath = dossier('binary-a', a, [{ name: 'shared', body }, { name: 'shared_extra', address: '0x1001', body: 'int shared_extra(void){return 2;}' }]);
  const bPath = dossier('binary-b', b, [{ name: 'shared', body: 'int shared(void){return 9;}' }]);
  store.engine.processDossier(aPath); store.engine.processDossier(bPath);
  const aa = store.engine.getDossierFunction(a, 'shared'), bb = store.engine.getDossierFunction(b, 'shared');
  check('different SHA prefixes preserve overlapping function identities', aa.c.includes('return 1') && bb.c.includes('return 9') && store.engine.getDossier(a).memories.length === 2);
  const manyPath = dossier('many', manySha, Array.from({ length: 136 }, (_, i) => ({ name: `fixture_${i}`, address: `0x${(4096 + i).toString(16)}`, body: `int fixture_${i}(void){return ${i};}` })));
  store.engine.processDossier(manyPath);
  const pages = [store.engine.getDossierFunctions(manySha, { limit: 100 }), store.engine.getDossierFunctions(manySha, { limit: 100, offset: 100 })];
  check('SQL pagination recovers all 136 function records', pages[0].total === 136 && pages[0].functions.length === 100 && pages[1].functions.length === 36);
  const nameOnly = await store.reTools.find(t => t.name === 're.query_dossier').execute({ args: { functionName: 'shared' } });
  check('name-only tool lookup now returns both binary matches', nameOnly.results.filter(r => r.name === 'shared').length === 2);
  const wildcard = store.engine.getDossierFunction(a, 'sha%');
  check('function detail lookup still interprets LIKE wildcards', wildcard?.name === 'shared');
  const shaPrefix = '1234567890abcdef', collA = shaPrefix + 'a'.repeat(48), collB = shaPrefix + 'b'.repeat(48);
  const ca = dossier('prefix-a', collA, [{ name: 'collision', body: 'int collision(void){return 10;}' }]);
  const cb = dossier('prefix-b', collB, [{ name: 'collision', body: 'int collision(void){return 20;}' }]);
  store.engine.processDossier(ca); store.engine.processDossier(cb);
  const collision = store.engine.getDossierFunction(collA, 'collision');
  check('accepted declared SHA identities sharing 16 hex characters still alias', collision.c.includes('return 20') && collision.source.includes(collB));
  const legacy = make();
  legacy.memory.storeMemory('re-analyst', 'binary_dossier', 'fn:shared@0x1000', JSON.stringify({ name: 'shared', address: '0x1000', c: body }), { source: `dossier:${a}:measured` });
  const legacyHidden = legacy.engine.getDossierFunction(a, 'shared');
  check('legacy unprefixed function records remain invisible without migration', legacyHidden === null);

  const compile = make(), measure = compile.reTools.find(t => t.name === 're.compile_rate_measure');
  compile.engine.processDossier(aPath);
  const missing = await measure.execute({ args: { dossierPath: aPath } });
  check('missing compiler yields unknown rate and no writes', missing.compiler === 'not_available' && missing.compileRate === null && missing.compiled === null && compile.compiler.writes.length === 0);
  compile.compiler.available = true;
  const reusedPath = resolve(aPath, '..', `_compile_test_${compile.clock.current}`), record = join(reusedPath, 'preexisting-forensic-record.md');
  compile.compiler.directories.add(reusedPath); compile.compiler.files.set(record, 'PREEXISTING');
  const available = await measure.execute({ args: { dossierPath: aPath } });
  check('compiler uses argv and generated filenames without symbol paths', available.compiled === 2 && compile.compiler.commands.every(c => c.file === 'clang' && Array.isArray(c.args)) && compile.compiler.writes.every(w => /fn_\d+\.c$/.test(w.path)));
  check('predictable recursive temp cleanup removes intercepted preexisting record', compile.compiler.mkdirs[0].reused && !compile.compiler.files.has(record) && compile.compiler.removals[0].options.recursive);
  const traversalPath = dossier('compiler-traversal', 'd'.repeat(64), [{ name: '../../../outside_forensic_record', body: 'int harmless(void){return 0;}' }]);
  const traversalResult = await measure.execute({ args: { dossierPath: traversalPath } });
  check('path-traversal marker text no longer enters compiler file paths', traversalResult.compiled === 1 && compile.compiler.writes.at(-1).path.endsWith('fn_0.c') && !compile.compiler.writes.at(-1).path.includes('outside_forensic_record'));
  const storedFunction = compile.engine.getDossierFunction(a, 'shared'), storedSummary = JSON.parse(compile.db.prepare("SELECT value FROM agent_memories WHERE key = ?").get(`binary:${a.slice(0, 16)}`).value);
  check('successful compiler results remain absent from stored function and aggregate', storedFunction.compileStatus === null && compile.engine.getDossier(a).dossier.compile_rate === null && storedSummary.compileRate === null);
  compile.compiler.mode = 'timeout'; const timeout = await measure.execute({ args: { dossierPath: aPath } });
  compile.compiler.mode = 'write_error'; const writeError = await measure.execute({ args: { dossierPath: aPath } });
  check('compiler timeout and filesystem failures still become measured zero rates', timeout.compileRate === 0 && writeError.compileRate === 0 && timeout.failed === 2 && writeError.failed === 2);
  compile.compiler.mode = 'syntax'; const syntax = await measure.execute({ args: { dossierPath: aPath } });
  check('syntax diagnostic fixture is reported as failed compilation', syntax.failed === 2 && syntax.sampleErrors[0].error.includes('invalid C'));
  const predict = compile.reTools.find(t => t.name === 're.compile_rate_predict');
  compile.model.response = '{"predictedRate":900,"confidence":"high","reasoning":"fixture opinion"}';
  const prediction = await predict.execute({ args: { dossierPath: aPath } });
  check('prediction now has opinion labels and clamps numeric rate', prediction.evidence_type === 'llm_prediction' && prediction.evidence_confidence === 0.4 && prediction.prediction.predictedRate === 100);
  compile.model.response = '{"predictedRate":"900","confidence":"high","reasoning":"fixture opinion"}';
  const invalidPrediction = await predict.execute({ args: { dossierPath: aPath } });
  check('prediction still accepts string percentages and reports unknown model', invalidPrediction.prediction.predictedRate === '900' && invalidPrediction.model === 'unknown');
  const predictionRows = compile.db.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE source LIKE '%llm_prediction%'").get().n;
  const predictionEvents = compile.db.prepare("SELECT COUNT(*) AS n FROM bus_messages WHERE topic LIKE '%predict%'").get().n;
  check('prediction results still lack persisted opinion memories/events', predictionRows === 0 && predictionEvents === 0);
  const routes = await apiFor(store, 'dossier');
  const apiFunctions = await routes(`/api/intelligence/dossier/${manySha}/functions?limit=200`);
  const declaredRoute = await routes('/api/intelligence/dossier/process', { dossierPath: aPath });
  check('actual REST pagination returns all 136 but declared process route is still absent', apiFunctions.status === 200 && apiFunctions.body.functions.length === 136 && declaredRoute.status === 404);

  const findingStatus = [
    ['LCH-01', 'PASS_ISOLATED', 'Five actual fleet dispatch modes behave correctly.'],
    ['LCH-02', 'PASS_ISOLATED', 'Polynomial calculus works through REST and fleet; generic callbacks remain internal.'],
    ['LCH-03', 'PARTIAL', 'Some input/prototype checks work; invalid polynomial, fractional Hamming and null orbital outputs remain.'],
    ['LCH-04', 'PARTIAL', 'Original cancellation fixed; x^2=0 now yields null roots.'],
    ['LCH-05', 'PASS_ISOLATED', 'Persistence failure, suppressed publication and successful retry verified.'],
    ['LCH-06', 'PASS_ISOLATED', 'No verified tier is distinct from age zero; later prerequisite failure retains Arithmetic only.'],
    ['RE3-01', 'PARTIAL', '136 functions and two annotations parse; 0/90 imports; substring grading persists.'],
    ['RE3-02', 'PARTIAL', 'Synthetic seal formats work; producer manifest/completeness contract unresolved.'],
    ['RE3-03', 'PARTIAL', 'Normal binary separation, name lookup and 136-row pagination fixed; exact identity, legacy migration unresolved.'],
    ['RE3-04', 'PASS_ISOLATED', 'Actual bus publication success and rejected-publication reporting verified.'],
    ['RE3-05', 'PARTIAL', 'Index names and argv fixed; predictable reused directory is recursively removed.'],
    ['RE3-06', 'PARTIAL', 'Missing compiler unknown fixed; infrastructure failures, compilation context and persisted metrics incomplete.'],
    ['RE3-07', 'PARTIAL', 'Structured opinion labels/numeric clamp fixed; schema/model/persistence incomplete.'],
  ].map(([id, status, detail]) => ({ id, status, detail }));
  // Reviewer dispositions of the spec's exact checklist items, not automatic feature acceptance.
  const gateResults = [
    ['RE-P3-G1', 'PASS_ISOLATED', 'Pinned producer fixture yields 136 functions.'],
    ['RE-P3-G2', 'FAIL', '0/90 imports and string-literal promotion violate evidence grading.'],
    ['RE-P3-G3', 'PARTIAL', 'Normal identities/storage/pagination work; exact identity and legacy continuity remain incomplete.'],
    ['RE-P3-G4', 'PASS_ISOLATED', 'Actual SQLite bus success and rejected publication tested.'],
    ['RE-P3-G5', 'PARTIAL', 'REST lists 136 functions; LIKE detail matching and declared process route remain unresolved.'],
    ['RE-P3-G6', 'FAIL', 'File-count heuristic cannot establish original seal completeness.'],
    ['RE-P2B-G1', 'PARTIAL', 'Actual ingestion stores function facts; import/evidence/seal defects remain.'],
    ['RE-P2B-G2', 'PARTIAL', 'Normal name/SHA queries work; prefix aliases, wildcard exactness and old records unresolved.'],
    ['RE-P2B-G3', 'PARTIAL', 'Missing compiler is unknown; available compiler boundary still has unsafe cleanup and false infrastructure zero rates.'],
    ['RE-P2B-G4', 'PASS_ISOLATED', 'Mocked-model returned response carries the specified llm_prediction label; broader RE3-07 remains partial.'],
  ].map(([id, status, detail]) => ({ id, status, detail }));
  const modified = ['server/intelligence/lineage.js', 'server/fleet/tools.js', 'server/intelligence/dossier-engine.js', 'server/fleet/re-tools.js'];
  for (const path of modified) execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source(path), encoding: 'utf8' });
  source('server/config.js'); source('server/commerce/shared.js');
  const evidence = { reviewedRef: ref, generatedAt: new Date().toISOString(), sourceHashes, upstreamRef: '2f75cee7f54a4aa6bae219ec9241fc44f980c36b', upstreamBlobs: blobs, retainedFixtureDirectory: directory,
    methodology: 'Pinned git-show source; SQLite in memory; actual bus/fleet dispatch/Express; VM compiler/filesystem/model fixtures. Compiler filesystem writes and recursive removals are INTERCEPTED, not executed. No live app, database, daemon, model, compiler or deletion. Positive controls plus explicit defect assertions; diagnostic assertions are not acceptance gates.',
    syntaxChecks: modified, diagnosticAssertions: checks.length, checks, lineage,
    dossier: { upstream: upstreamResult, falseVerification: falseVerification[0], processed: ingested, rejectedBus, seals: { validSeal, tamperedSeal, legacySeal }, pagination: pages.map(p => ({ total: p.total, returned: p.functions.length })), nameOnlyMatches: nameOnly.matches, wildcardReturned: wildcard?.name, prefixAlias: { declaredA: collA, declaredB: collB, observedSource: collision.source }, legacyHidden: legacyHidden === null, declaredRouteStatus: declaredRoute.status },
    compiler: { missing, available, timeout, writeError, syntax, commands: compile.compiler.commands, writes: compile.compiler.writes, mkdirs: compile.compiler.mkdirs, removals: compile.compiler.removals, preexistingVirtualRecord: record, preexistingVirtualRecordRemoved: !compile.compiler.files.has(record), storedCompileStatus: storedFunction.compileStatus, storedCompileRate: storedSummary.compileRate },
    prediction: { result: prediction, invalidResult: invalidPrediction, storedMemories: predictionRows, storedEvents: predictionEvents, modelOptions: compile.model.calls.map(c => c.options) }, logs, findingStatus, gateResults,
    summary: { scopedClosures: findingStatus.filter(f => f.status === 'PASS_ISOLATED').length, partial: findingStatus.filter(f => f.status === 'PARTIAL').length, independentlyAcceptedPhases: 0 } };
  writeFileSync(resolve(arg('--output')), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ref, authorExamples: lineage.authorExamples, diagnosticAssertions: checks.length, ...evidence.summary, upstream: { functions: upstreamResult.functions, imports: upstreamResult.parsedImports, annotations: upstreamResult.annotations }, findingStatus }, null, 2));
} finally {
  for (const s of servers) await new Promise((done, reject) => { s.close(e => e ? reject(e) : done()); s.closeAllConnections(); });
  for (const f of contexts) f.db.close();
}
