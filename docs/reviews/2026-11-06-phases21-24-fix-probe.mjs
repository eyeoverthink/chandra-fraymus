// Independent fix recheck. Helpers retained from the original diagnostic baseline.
// node docs/reviews/2026-11-06-phases21-24-fix-probe.mjs --output PATH
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = '19a598103f012ea5b6837f0bf67dd9be9f584cb2';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
assert.ok(arg('--output'), '--output required');
const sourceHashes = {}, cache = new Map(), checks = [], logs = [];
function source(path) {
  if (!cache.has(path)) { const text = execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' }); cache.set(path, text); sourceHashes[path] = createHash('sha256').update(text).digest('hex'); }
  return cache.get(path);
}
function moduleFrom(path, bindings, names) {
  const body = source(path).replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(resolve(root, path)).href));
  assert.ok(!/^import /m.test(body));
  return new vm.Script(`(()=>{${body}\nreturn {${names}};})()`, { filename: path }).runInNewContext({ Math, JSON, console: { log() {}, error: (...v) => logs.push(v.join(' ')) }, ...bindings });
}
function check(name, value) { assert.ok(value, name); checks.push(name); }
const ddl = source('server/db-migrate.js');
const producerTables = {
  'sensory-bridge': 'sensory_bridge_events', 'emotional-feedback': 'emotional_feedback_events', 'motor-output': 'motor_output_events',
  'attention-gate': 'attention_gate_events', habituation: 'habituation_events', 'working-memory': 'working_memory_events',
  'metacognitive-monitor': 'metacognitive_events', 'adaptive-strategy': 'adaptive_strategy_events', 'self-model': 'self_model_snapshots',
  'resource-envelope': 'resource_envelope_events', 'predictive-processing': 'predictive_processing_events', 'active-inference': 'active_inference_events',
};
function insert(db, table, overrides = {}) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all(), values = {};
  for (const c of info) {
    if (c.name === 'id') values.id = randomUUID();
    else if (c.notnull && c.dflt_value === null) values[c.name] = /TEXT/i.test(c.type) ? '{}' : 0;
  }
  for (const [name, value] of Object.entries(overrides)) if (info.some(c => c.name === name)) values[name] = value;
  const names = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(values));
}
function deferred() { let resolvePromise; const promise = new Promise(done => { resolvePromise = done; }); return { promise, resolve: resolvePromise }; }
const fixtures = [], servers = [];
function fixture() {
  const db = new Database(':memory:'), clock = { now: 1800000000000 }, timers = new Map(); let nextTimer = 1;
  class FixtureDate extends Date { static now() { return clock.now; } }
  for (const table of ['bus_messages', 'bus_subscriptions', 'agent_memories', 'runs', 'daemon_cycles', 'reflections']) db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  for (const [file, table] of Object.entries(producerTables)) db.exec(source(`server/intelligence/${file}.js`).match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  db.exec('CREATE TABLE harness_evidence (run_id,step,tool,args_hash,result_hash,evidence_sha,duration_ms,refused,created_at)');
  const base = { db, Date: FixtureDate, randomUUID, setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; }, clearInterval: id => timers.delete(id) };
  const bus = moduleFrom('server/fleet/bus.js', base, 'publish,history');
  const model = { calls: [], response: '{"narrative":"Fixture grounded narrative.","coherence":0.8,"awareness":0.6,"solution":"Fixture solution.","associations":["memory → code"],"novelty":0.8,"feasibility":0.6}', failure: null, pending: null };
  const gate = { tier: 'AWAKENING', evolutionRate: 1, cycleMultiplier: 1 };
  const dependencies = { ...base, publish: bus.publish, chatOllama: async (messages, opts) => { model.calls.push({ messages, opts }); if (model.failure) throw new Error(model.failure); if (model.pending) return model.pending.promise; return model.response; },
    parseJSON: JSON.parse, getAutonomyModifiers: () => gate, getConsciousnessState: () => ({ proven: true, proofsPassed: 4, phi: 0.9, stale: false }) };
  const narrative = moduleFrom('server/intelligence/self-narrative.js', dependencies, 'collectSignals,narrateNow,setNarrativeHeart,setNarrativeCTRNN,startNarrative,stopNarrative,resetNarrative,getNarrativeStatus,installNarrativeRoutes');
  const dream = moduleFrom('server/intelligence/dream-solver.js', dependencies, 'solveDream,setDreamSolverCTRNN,setDreamSolverDreamer,getDreamSolverStatus,resetDreamSolver,installDreamSolverRoutes');
  const monitor = moduleFrom('server/intelligence/intelligence-monitor.js', dependencies, 'assessNow,setMonitorCTRNN,startIntelligenceMonitor,stopIntelligenceMonitor,resetIntelligenceMonitor,getIntelligenceMonitorStatus,installIntelligenceMonitorRoutes');
  const core = moduleFrom('server/intelligence/ctrnn.js', { ...base, publish: bus.publish, fileURLToPath, dirname, join, opegPipeline: () => { throw new Error('OPEG not exercised'); } }, 'createCTRNN').createCTRNN();
  const heart = moduleFrom('server/fraymus/intelligence/heart.js', { Date: FixtureDate }, 'Heart,detectCompounds,getMoodHistory,getMoodTrajectory');
  const f = { db, clock, timers, base, bus, model, gate, narrative, dream, monitor, core, heart }; fixtures.push(f); return f;
}
async function apiFor(f) {
  const app = express(); app.use(express.json());
  f.narrative.installNarrativeRoutes(app); f.dream.installDreamSolverRoutes(app); f.monitor.installIntelligenceMonitorRoutes(app);
  app.use((e, _req, res, _next) => res.status(500).json({ error: e.message }));
  const s = await new Promise(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); }); servers.push(s);
  return async (path, body) => { const r = await fetch(`http://127.0.0.1:${s.address().port}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
}
function extractTool(name, bindings) {
  const text = source('server/fleet/tools.js'), anchor = text.indexOf(`name: '${name}'`), start = text.lastIndexOf('\n    {', anchor) + 5, end = text.indexOf('\n    },', anchor) + '\n    }'.length;
  assert.ok(anchor > 0);
  return new vm.Script(`(${text.slice(start, end)})`).runInNewContext({ object: properties => ({ type: 'object', properties }), ledger: { record() {} }, ...bindings });
}

const modelReply = label => JSON.stringify({ narrative: label, coherence: 0.8, awareness: 0.6, solution: label, associations: ['memory → code'], novelty: 0.8, feasibility: 0.6 });
function wireFleet(f) {
  const tools = [extractTool('self_narrative_status', { getNarrativeStatus: f.narrative.getNarrativeStatus, narrateNow: f.narrative.narrateNow }), extractTool('dream_solver', { getDreamSolverStatus: f.dream.getDreamSolverStatus, solveDream: f.dream.solveDream }), extractTool('intelligence_monitor_status', { getIntelligenceMonitorStatus: f.monitor.getIntelligenceMonitorStatus, assessIntelligence: f.monitor.assessNow })];
  const runtime = moduleFrom('server/fleet/runtime.js', { ...f.base, sealToolResult: (tool, args, result) => ({ result, evidence: { tool } }), isClockTrusted: () => true }, 'setFleetTools,executeTool'); runtime.setFleetTools(tools);
  return async (name, args) => (await runtime.executeTool(name, args, { runId: 'fixture' })).result;
}
try {
  const f = fixture(), calls = [], originalInject = f.core.inject.bind(f.core);
  f.core.inject = (...args) => { calls.push(args); return originalInject(...args); };
  f.narrative.setNarrativeCTRNN(f.core); f.dream.setDreamSolverCTRNN(f.core); f.monitor.setMonitorCTRNN(f.core);
  await f.narrative.narrateNow('neural-recheck'); const narrativeField = f.core.snapshot().Iext;
  await f.dream.solveDream('Improve local memory retrieval'); f.monitor.assessNow('neural-recheck');
  check('all three modules now use the actual public CTRNN inject method', calls.length === 6 && f.core.snapshot().Iext.some(v => v !== 0));
  check('sigma/amplitude order and inhibitory sign are corrected', calls[0][2] === 2.5 && Math.abs(calls[0][3] - 0.6) < 1e-10 && calls.at(-1)[3] < 0);
  check('narrative field is still transposed relative to row 2 column 8 annotation', narrativeField[8 * 16 + 2] > narrativeField[2 * 16 + 8] && calls[0][0] === 2 && calls[0][1] === 8);
  const neural = { calls, atRow8Col2: narrativeField[8 * 16 + 2], atRow2Col8: narrativeField[2 * 16 + 8] };
  const dispatch = wireFleet(f), beforeCalls = f.model.calls.length, beforeAssessments = f.monitor.getIntelligenceMonitorStatus().snapshotsStored;
  const actions = { narrative: await dispatch('self_narrative_status', { mode: 'generate' }), dream: await dispatch('dream_solver', { problem: 'Improve local memory retrieval' }), monitor: await dispatch('intelligence_monitor_status', { mode: 'assess' }) };
  check('actual fleet dispatch executes all three requested actions', f.model.calls.length === beforeCalls + 2 && !!actions.narrative.narrative && !!actions.dream.id && actions.monitor.totalCount === 12 && f.monitor.getIntelligenceMonitorStatus().snapshotsStored === beforeAssessments + 1);

  const h = fixture(), rows = [], actualHeart = new h.heart.Heart({ HeartReadings: { create: row => rows.push(row), filter: () => ({ items: rows }) } });
  const neutral = actualHeart.feel('table pencil notebook'); actualHeart.feel('happy wonderful');
  const mood = actualHeart.recentMood(), signals = h.narrative.collectSignals(actualHeart);
  check('Heart averages and top-level proof count now reach narrative signals', signals.emotion.intensity === mood.intensityAvg && signals.emotion.sentiment === mood.sentimentAvg && signals.consciousness.proofsPassed === 4);
  check('neutral fallback still passes the new compound gate', Object.values(neutral.scores).every(v => v === 0) && neutral.compounds.length === 3 && Object.values(neutral.normalized).reduce((a, b) => a + b, 0) > 0.15);
  const trajectory = h.heart.getMoodTrajectory(1);
  check('single-element trajectory now returns finite stable statistics', trajectory.shift === 0 && trajectory.stability === 1);
  const blend = h.heart.detectCompounds({ joy: 0.5, sadness: 0.5, love: 0, fear: 0, surprise: 0, anxiety: 0, anger: 0 });
  check('explicit emotion blend remains supported', blend.some(c => c.name === 'bittersweet'));

  const ordinary = fixture(), firstPending = deferred(); ordinary.model.pending = firstPending;
  ordinary.narrative.startNarrative(); let interval = [...ordinary.timers.values()].find(t => t.ms === 120000).fn;
  const first = interval(); ordinary.clock.now += 120000; await interval();
  check('ordinary scheduled overlap is prevented while first request is pending', ordinary.model.calls.length === 1);
  ordinary.narrative.stopNarrative(); ordinary.narrative.resetNarrative(); firstPending.resolve(modelReply('Old completion')); await first;
  check('ordinary stop and reset now discard stale completions', ordinary.narrative.getNarrativeStatus().lastNarrative === null && ordinary.bus.history('system.narrative').length === 0);

  const race = fixture(), oldPending = deferred(), newPending = deferred(), thirdPending = deferred();
  race.model.pending = oldPending; race.narrative.startNarrative();
  const oldInterval = [...race.timers.values()][0].fn, oldRun = oldInterval();
  race.narrative.stopNarrative(); race.narrative.resetNarrative(); race.narrative.startNarrative(); race.model.pending = newPending;
  const newInterval = [...race.timers.values()][0].fn, newRun = newInterval();
  oldPending.resolve(modelReply('Discarded old generation')); await oldRun;
  check('old generation remains discarded after restart', race.narrative.getNarrativeStatus().lastNarrative === null);
  race.clock.now += 120000; race.model.pending = thirdPending; const thirdRun = newInterval();
  check('old finally unlocks the new lifecycle and permits another overlap', race.model.calls.length === 3);
  thirdPending.resolve(modelReply('Newer response')); await thirdRun;
  newPending.resolve(modelReply('Older new-lifecycle response')); await newRun;
  check('new-lifecycle responses can commit out of order after stale unlock', race.narrative.getNarrativeStatus().lastNarrative === 'Older new-lifecycle response' && race.bus.history('system.narrative').length === 2);

  const monitor = fixture();
  for (const table of Object.values(producerTables)) insert(monitor.db, table, { created_at: monitor.clock.now, tick: 1, sensitivity: 0.5, effectiveness: 0.9, confidence: 0.9, pressure: 0.1, active_count: 25, subsystem_count: 31 });
  monitor.clock.now += 180000; const threeMinutes = monitor.monitor.assessNow('cadence-recheck');
  check('previous 180-second staleness regressions are fixed', ['sensoryBridge', 'emotionalFeedback', 'resourceEnvelope'].every(k => threeMinutes.subsystemScores[k].status === 'active'));
  monitor.clock.now += 421000; const selfModelGap = monitor.monitor.assessNow('self-model-gap');
  check('self-model still becomes stale at 601 seconds despite 20 daemon calls per snapshot', selfModelGap.subsystemScores.selfModel.status === 'stale');
  monitor.db.prepare('UPDATE metacognitive_events SET effectiveness = 0, created_at = ?').run(monitor.clock.now);
  const zeroEffective = monitor.monitor.assessNow('zero-effective');
  check('zero effectiveness now causes degradation instead of healthy 0.5', zeroEffective.subsystemScores.metacognitive.score === 0.3 && zeroEffective.degraded.some(d => d.subsystem === 'metacognitive'));

  // Actual Dreamer + Ed25519 primitives, with all artifact files intercepted in RAM.
  const virtualFiles = new Map(), virtualDirs = new Set(), virtualRoot = resolve(root, '__review_virtual_dreams__');
  const primitives = moduleFrom('server/fraymus/core/crypto.js', { crypto: webcrypto, TextEncoder }, 'hex,unhex,sha256,sha256hex');
  const identityModule = moduleFrom('server/fraymus/core/identity.js', { crypto: webcrypto, TextEncoder, ...primitives }, 'generateIdentity,signText,verifyText');
  const identity = await identityModule.generateIdentity('Independent review fixture');
  const Dreamer = moduleFrom('server/fraymus/intelligence/dreamer.js', { Date, join, signText: identityModule.signText,
    existsSync: path => virtualDirs.has(path) || virtualFiles.has(path), mkdirSync: path => virtualDirs.add(path),
    readdirSync: path => [...virtualFiles.keys()].filter(p => dirname(p) === path).map(p => p.slice(dirname(p).length + 1)),
    readFileSync: path => virtualFiles.get(path), writeFileSync: (path, value) => virtualFiles.set(path, value),
  }, 'Dreamer').Dreamer;
  const signed = fixture(), signer = new Dreamer(null, identity, virtualRoot), api = await apiFor(signed), signedDispatch = wireFleet(signed);
  signed.dream.setDreamSolverDreamer(signer);
  const restSolve = await api('/api/intelligence/dream-solver/solve', { problem: 'Improve local memory retrieval' });
  const fleetSolve = await signedDispatch('dream_solver', { problem: 'Improve local memory retrieval' });
  const signedFiles = [...virtualFiles.keys()].filter(p => p.endsWith('.sig'));
  const signatures = await Promise.all(signedFiles.map(async path => ({ filename: path.slice(virtualRoot.length + 1), body: virtualFiles.get(path.slice(0, -4)), signature: virtualFiles.get(path), valid: await identityModule.verifyText(identity.pubkey, virtualFiles.get(path.slice(0, -4)), virtualFiles.get(path)) })));
  check('configured singleton produces real verifiable signatures through REST and fleet', restSolve.status === 200 && restSolve.body.dreamNumber === 1 && fleetSolve.dreamNumber === 2 && signatures.length === 2 && signatures.every(s => s.valid));
  signed.dream.setDreamSolverDreamer(new Dreamer(null, { priv: {} }, virtualRoot));
  const unsigned = await api('/api/intelligence/dream-solver/solve', { problem: 'Improve local memory retrieval' });
  check('signer failure still returns normal numbered solve without signature status', unsigned.status === 200 && unsigned.body.dreamNumber === 3 && unsigned.body.status === undefined && !Object.hasOwn(unsigned.body, 'signed') && [...virtualFiles.keys()].filter(p => p.endsWith('.sig')).length === 2);

  const outcomes = fixture(), outcomeApi = await apiFor(outcomes);
  outcomes.model.response = JSON.stringify({ narrative: 'Zero fixture', coherence: 0, awareness: 0, solution: 'Zero fixture', associations: [], novelty: 0, feasibility: 0 });
  const zeroNarrative = await outcomes.narrative.narrateNow('zero-scores'), zeroDream = await outcomes.dream.solveDream('Improve local memory retrieval');
  check('all four legitimate zero model ratings are now preserved', zeroNarrative.coherenceScore === 0 && zeroNarrative.awarenessScore === 0 && zeroDream.noveltyScore === 0 && zeroDream.feasibilityScore === 0);
  outcomes.model.response = JSON.stringify({ solution: 'Valid low-scoring result', associations: [], novelty: 0.2, feasibility: 0.1 });
  const falseFailure = await outcomes.dream.solveDream('Improve local memory retrieval');
  check('a valid score combination is falsely classified as model failure', falseFailure.status === 'llm_failed');
  outcomes.model.failure = 'fixture model unavailable'; const failureInjections = [];
  outcomes.dream.setDreamSolverCTRNN({ inject: (...v) => failureInjections.push(v) });
  const failure = await outcomes.dream.solveDream('Improve local memory retrieval');
  check('real model failure is labeled but still drives a positive creative-spark signal', failure.status === 'llm_failed' && failureInjections[0][3] > 0 && !failure.solution.includes('dream queue'));
  outcomes.model.failure = null; outcomes.model.response = modelReply('Valid stored retry');
  outcomes.clock.now += 1000; // Distinguish the failure event from earlier equal-time fixtures.
  outcomes.db.exec("CREATE TRIGGER reject_dream BEFORE INSERT ON dream_solver_sessions BEGIN SELECT RAISE(ABORT,'fixture persistence rejected'); END;");
  const failedSave = await outcomeApi('/api/intelligence/dream-solver/solve', { problem: 'Improve local memory retrieval' });
  const failedEvent = JSON.parse(outcomes.bus.history('system.dream-solve')[0].payload);
  check('failed dream save now reports storage_failed and a non-durable event', failedSave.body.status === 'storage_failed' && failedEvent.stored === false && logs.some(s => s.includes('fixture persistence rejected')));
  const statusAfterFailure = await outcomeApi('/api/intelligence/dream-solver');
  check('status projection still discards the failed outcome flag', !Object.hasOwn(statusAfterFailure.body.lastSolution, 'status'));
  outcomes.db.exec('DROP TRIGGER reject_dream'); const storedRetry = await outcomes.dream.solveDream('Improve local memory retrieval');
  check('retry successfully saves its session', outcomes.db.prepare('SELECT COUNT(*) AS n FROM dream_solver_sessions WHERE id = ?').get(storedRetry.id).n === 1);
  const counts = { narrativeReported: f.narrative.getNarrativeStatus().snapshotsStored, narrativeRows: f.db.prepare('SELECT COUNT(*) AS n FROM self_narrative_events').get().n, monitorReported: f.monitor.getIntelligenceMonitorStatus().snapshotsStored, monitorRows: f.db.prepare('SELECT COUNT(*) AS n FROM intelligence_monitor_events').get().n };
  check('snapshot counters still report invocations instead of stored snapshots', counts.narrativeReported > 0 && counts.narrativeRows === 0 && counts.monitorReported > 0 && counts.monitorRows === 0);
  const changedJs = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', ref], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(p => p.endsWith('.js'));
  for (const path of changedJs) execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source(path), encoding: 'utf8' });
  source('server/daemon/engine.js'); source('server/fraymus-tools.js');
  const findingStatus = [
    ['INT-21-01', 'PARTIAL', 'Public method, sigma/amplitude and inhibitory sign fixed; declared row/column placement remains transposed.'],
    ['INT-21-02', 'PASS_ISOLATED', 'All three real fleet action paths execute.'],
    ['INT-21-03', 'PARTIAL', 'Ordinary overlap and stale commits fixed; old finally can unlock a new lifecycle.'],
    ['INT-24-01', 'PARTIAL', 'Common cadences/zero effectiveness fixed; self-model cadence still mismatches.'],
    ['INT-21-04', 'PASS_ISOLATED', 'Actual Heart averages and gate proof field reach collector.'],
    ['INT-22-01', 'PARTIAL', 'Single-element trajectory fixed; neutral fallback still triggers three compounds.'],
    ['INT-23-01', 'PARTIAL', 'Configured REST/fleet signatures verify; unsigned signer failure is not exposed.'],
    ['INT-21-05', 'PARTIAL', 'Zeros preserved and model errors flagged; valid scores misclassified and failed solve injects creative signal.'],
    ['INT-23-02', 'PARTIAL', 'Write failure logged/returned and bus marked; status loses failure and snapshot counts remain wrong.'],
  ].map(([id, status, detail]) => ({ id, status, detail }));
  const evidence = { reviewedRef: ref, generatedAt: new Date().toISOString(), sourceHashes, syntaxChecks: changedJs, diagnosticAssertions: checks.length, checks, findingStatus,
    methodology: 'Pinned exact source; actual CTRNN public object without starting workers, actual fleet executor/bus/Express, actual producer schemas in SQLite memory. Fake model/timers and unrelated permission/result sealing. Actual Ed25519 identity/sign/verify and Dreamer bodies with ephemeral RAM key and intercepted artifact files; no private key recorded. No live app/DB, live requests, model/compiler/daemon starts or filesystem deletion.',
    neural, fleet: { narrativeGenerated: !!actions.narrative.narrative, dreamCreated: !!actions.dream.id, monitorAssessed: !!actions.monitor.subsystemScores },
    heart: { rawNeutralScores: neutral.scores, neutralNormalizedTotal: Object.values(neutral.normalized).reduce((a, b) => a + b, 0), neutralCompounds: neutral.compounds, trajectory, actualMood: mood, collected: signals },
    lifecycle: { ordinaryStop: ordinary.narrative.getNarrativeStatus(), restartModelCalls: race.model.calls.length, restartLastNarrative: race.narrative.getNarrativeStatus().lastNarrative, restartBusEvents: race.bus.history('system.narrative').length },
    monitor: { threeMinutes: threeMinutes.subsystemScores, selfModelAt601s: selfModelGap.subsystemScores.selfModel, selfModelSnapshotEvery: 20, daemonDefaultCycleMs: 1800000, defaultSelfModelSnapshotPeriodMs: 36000000, zeroEffectiveness: zeroEffective.subsystemScores.metacognitive },
    signatures: { publicKey: identity.pubkey, results: signatures, unsignedReturnedNumber: unsigned.body.dreamNumber, unsignedReturnedStatus: unsigned.body.status ?? null, unsignedArtifactHasSignature: false },
    outcomes: { zeros: { coherence: zeroNarrative.coherenceScore, awareness: zeroNarrative.awarenessScore, novelty: zeroDream.noveltyScore, feasibility: zeroDream.feasibilityScore }, falseFailure, modelFailure: { status: failure.status, injections: failureInjections }, failedSave, failedEvent, statusAfterFailure, snapshotCounts: counts }, logs,
    summary: { scopedClosures: findingStatus.filter(v => v.status === 'PASS_ISOLATED').length, partial: findingStatus.filter(v => v.status === 'PARTIAL').length, acceptedNewPhases: 0 } };
  writeFileSync(resolve(arg('--output')), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ref, checks: checks.length, syntaxChecks: changedJs.length, ...evidence.summary, signatures: signatures.map(s => ({ filename: s.filename, valid: s.valid })), neutralCompounds: neutral.compounds.map(v => v.name), findingStatus }, null, 2));
} finally {
  for (const s of servers) await new Promise((done, reject) => { s.close(e => e ? reject(e) : done()); s.closeAllConnections(); });
  for (const f of fixtures) f.db.close();
}
