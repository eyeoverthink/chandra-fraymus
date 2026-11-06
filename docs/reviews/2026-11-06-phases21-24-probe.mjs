// Independent review: pinned source, in-memory SQLite, fake timers/model.
// node docs/reviews/2026-11-06-phases21-24-probe.mjs --output PATH [--live]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = '862e1ad551027dd12894048b8b5e2843bbba4a67';
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
  const dream = moduleFrom('server/intelligence/dream-solver.js', dependencies, 'solveDream,setDreamSolverCTRNN,getDreamSolverStatus,resetDreamSolver,installDreamSolverRoutes');
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
try {
  const f = fixture(), api = await apiFor(f), prefix = '/api/intelligence';
  const readiness = {};
  for (const name of ['narrative', 'dream-solver', 'monitor']) readiness[name] = await api(`${prefix}/${name}`);
  f.narrative.startNarrative(); f.monitor.startIntelligenceMonitor();
  check('three status routes work before any narrative, solve or assessment', Object.values(readiness).every(r => r.status === 200) && f.model.calls.length === 0 && f.narrative.getNarrativeStatus().lastNarrative === null && f.monitor.getIntelligenceMonitorStatus().lastAssessment === null);
  check('start registers intended 120s and 60s intervals', [...f.timers.values()].some(t => t.ms === 120000) && [...f.timers.values()].some(t => t.ms === 60000));
  f.narrative.setNarrativeCTRNN(f.core); f.dream.setDreamSolverCTRNN(f.core); f.monitor.setMonitorCTRNN(f.core);
  const generated = await f.narrative.narrateNow('probe'); const solved = await f.dream.solveDream('Improve local memory retrieval'); const assessed = f.monitor.assessNow('probe');
  const nonzeroBeforeControl = f.core.snapshot().Iext.filter(v => v !== 0).length;
  check('actual CTRNN exposes inject but no injectGaussian', typeof f.core.inject === 'function' && f.core.injectGaussian === undefined);
  check('all three modules return while actual neural input stays unchanged', !!generated.narrative && !!solved.solution && assessed.totalCount === 12 && nonzeroBeforeControl === 0);
  f.core.inject(8, 2, 2.5, 0.3);
  check('actual CTRNN public inject is a working positive control', f.core.snapshot().Iext.some(v => v > 0));
  const fakeCalls = [], fakeCore = { injectGaussian: (...args) => fakeCalls.push(args) };
  f.narrative.setNarrativeCTRNN(fakeCore); f.dream.setDreamSolverCTRNN(fakeCore); f.monitor.setMonitorCTRNN(fakeCore);
  await f.narrative.narrateNow('signature-probe'); await f.dream.solveDream('Improve local memory retrieval'); f.monitor.assessNow('signature-probe');
  check('new modules also reverse width/amplitude relative to public CTRNN inject signature', fakeCalls[0][3] === 2.5 && Math.abs(fakeCalls[0][2] - 0.6) < 1e-10);
  const neural = { publicMethods: Object.keys(f.core), inputNonzeroBeforeControl: nonzeroBeforeControl, attemptedCallsAgainstHypotheticalAlias: fakeCalls, selfNarrativeReportedScores: { coherence: generated.coherenceScore, awareness: generated.awarenessScore } };

  const tools = [extractTool('self_narrative_status', { getNarrativeStatus: f.narrative.getNarrativeStatus, narrateNow: f.narrative.narrateNow }), extractTool('dream_solver', { getDreamSolverStatus: f.dream.getDreamSolverStatus, solveDream: f.dream.solveDream }), extractTool('intelligence_monitor_status', { getIntelligenceMonitorStatus: f.monitor.getIntelligenceMonitorStatus, assessIntelligence: f.monitor.assessNow })];
  const fleet = moduleFrom('server/fleet/runtime.js', { ...f.base, sealToolResult: (tool, args, result) => ({ result, evidence: { tool } }), isClockTrusted: () => true }, 'setFleetTools,executeTool'); fleet.setFleetTools(tools);
  const priorCalls = f.model.calls.length, priorAssessments = f.monitor.getIntelligenceMonitorStatus().snapshotsStored;
  const toolResults = {};
  for (const [name, args] of [['self_narrative_status', { mode: 'generate' }], ['dream_solver', { problem: 'Improve local memory retrieval' }], ['intelligence_monitor_status', { mode: 'assess' }]]) toolResults[name] = (await fleet.executeTool(name, args, { runId: 'fixture' })).result;
  check('actual fleet dispatch silently returns status for all new action modes', f.model.calls.length === priorCalls && f.monitor.getIntelligenceMonitorStatus().snapshotsStored === priorAssessments && !toolResults.self_narrative_status.narrative && !toolResults.dream_solver.id && !toolResults.intelligence_monitor_status.subsystemScores);
  const bareControl = await tools[1].execute({ problem: 'Improve local memory retrieval' });
  check('bare parameter call explains why direct tool tests miss dispatch defect', !!bareControl.id && f.model.calls.length === priorCalls + 1);
  const snapshotCounts = { narrativeReported: f.narrative.getNarrativeStatus().snapshotsStored, narrativeRows: f.db.prepare('SELECT COUNT(*) AS n FROM self_narrative_events').get().n, monitorReported: f.monitor.getIntelligenceMonitorStatus().snapshotsStored, monitorRows: f.db.prepare('SELECT COUNT(*) AS n FROM intelligence_monitor_events').get().n };
  check('snapshotsStored counters count calls before any snapshot is stored', snapshotCounts.narrativeReported > 0 && snapshotCounts.narrativeRows === 0 && snapshotCounts.monitorReported > 0 && snapshotCounts.monitorRows === 0);

  const h = fixture(), records = [], store = { HeartReadings: { create: row => records.push(row), filter: (_filter, options) => ({ items: records.slice(-options.limit) }) } };
  const heart = new h.heart.Heart(store);
  const neutral = heart.feel('table pencil notebook');
  check('zero-lexicon neutral text generates named compound emotions', neutral.primary === 'neutral' && Object.values(neutral.scores).every(v => v === 0) && neutral.compounds.length > 0);
  const blend = h.heart.detectCompounds({ joy: 0.5, sadness: 0.5, love: 0, anxiety: 0, surprise: 0, anger: 0, fear: 0 });
  check('explicit joy/sadness blend detects bittersweet', blend.some(c => c.name === 'bittersweet'));
  for (let i = 0; i < 55; i++) heart.feel(i < 30 ? 'sad terrible' : 'happy wonderful');
  check('actual Heart tracks at most 50 frames', h.heart.getMoodHistory().length === 50);
  const mood = heart.recentMood(); h.narrative.setNarrativeHeart(heart); const signals = h.narrative.collectSignals(heart);
  check('narrative drops Heart averages and top-level proof count', mood.intensityAvg > 0 && mood.sentimentAvg !== 0 && signals.emotion.intensity === 0 && signals.emotion.sentiment === 0 && signals.consciousness.proofsPassed === 0);
  const oneFrameTrajectory = h.heart.getMoodTrajectory(1);
  check('one-frame trajectory window produces nonfinite statistics', Number.isNaN(oneFrameTrajectory.shift) && Number.isNaN(oneFrameTrajectory.stability));

  const m = fixture();
  for (const table of Object.values(producerTables)) insert(m.db, table, { created_at: m.clock.now, tick: 1, sensitivity: 0.5, effectiveness: 0.9, confidence: 0.9, pressure: 0.1, fatigue: 0.1, active_count: 25, subsystem_count: 31, strategy: 'focused', primary_emotion: 'joy', volatility: 0.1, coherence: 0.9 });
  const fresh = m.monitor.assessNow('fresh'); m.clock.now += 180000; const threeMinutes = m.monitor.assessNow('between-expected-snapshots');
  check('monitor reads actual-schema fresh records as active', fresh.activeCount === 12);
  check('180-second-old records are called stale despite 300s+ producer snapshot periods', threeMinutes.subsystemScores.sensoryBridge.status === 'stale' && threeMinutes.subsystemScores.emotionalFeedback.status === 'stale' && threeMinutes.subsystemScores.resourceEnvelope.status === 'stale');
  m.db.prepare('UPDATE metacognitive_events SET effectiveness = 0, created_at = ?').run(m.clock.now);
  const zeroEffectiveness = m.monitor.assessNow('zero-effectiveness').subsystemScores.metacognitive;
  check('known zero effectiveness becomes healthy 0.5 instead of degraded', zeroEffectiveness.score === 0.5 && zeroEffectiveness.status === 'active');
  const monitorResult = { fresh: { activeCount: fresh.activeCount, score: fresh.intelligenceScore }, threeMinutes: { activeCount: threeMinutes.activeCount, degraded: threeMinutes.degraded }, zeroEffectiveness };

  const pending = fixture(), wait = deferred(); pending.model.pending = wait;
  pending.narrative.startNarrative();
  const timerFn = [...pending.timers.values()].find(t => t.ms === 120000).fn;
  const firstRun = timerFn(); pending.clock.now += 120000; const secondRun = timerFn();
  check('interval allows overlapping model requests while first is unresolved', pending.model.calls.length === 2);
  pending.narrative.stopNarrative(); pending.narrative.resetNarrative();
  const stoppedBefore = pending.narrative.getNarrativeStatus();
  wait.resolve('{"narrative":"Completed after stop.","coherence":0.8,"awareness":0.6}'); await Promise.all([firstRun, secondRun]);
  const stoppedAfter = pending.narrative.getNarrativeStatus();
  const lateEvents = pending.bus.history('system.narrative');
  check('stopped and reset narrative is repopulated by pending completions', !stoppedBefore.running && stoppedBefore.lastNarrative === null && !stoppedAfter.running && stoppedAfter.lastNarrative === 'Completed after stop.' && lateEvents.length === 2);

  const d = fixture(), dreamApi = await apiFor(d); let dreamCalls = 0;
  const signer = { dream: async () => { dreamCalls++; return { number: 17, signed: true }; } };
  const apiSolve = await dreamApi(`${prefix}/dream-solver/solve`, { problem: 'Improve local memory retrieval' });
  check('normal REST solve creates no signed dream reference', apiSolve.status === 200 && apiSolve.body.dreamNumber === null && dreamCalls === 0);
  const signedControl = await d.dream.solveDream('Improve local memory retrieval', { dreamer: signer });
  check('explicit dependency injection enables dream recording as a positive control', signedControl.dreamNumber === 17 && dreamCalls === 1);
  d.model.response = '{"solution":"Zero-score fixture","associations":[],"novelty":0,"feasibility":0,"narrative":"Zero-score narrative","coherence":0,"awareness":0}';
  const zeroDream = await d.dream.solveDream('Improve local memory retrieval'), zeroNarrative = await d.narrative.narrateNow('zero-scores');
  check('legitimate zero model ratings are replaced with 0.5', zeroDream.noveltyScore === 0.5 && zeroDream.feasibilityScore === 0.5 && zeroNarrative.coherenceScore === 0.5 && zeroNarrative.awarenessScore === 0.5);
  d.model.failure = 'fixture Ollama unavailable';
  const fallback = await d.dream.solveDream('Improve local memory retrieval');
  check('model failure is recorded/published as a solved session without queue entry', fallback.solution.includes('remains in the dream queue') && fallback.noveltyScore === 0.2 && d.db.prepare('SELECT COUNT(*) AS n FROM dream_solver_sessions WHERE id = ?').get(fallback.id).n === 1 && !Object.hasOwn(fallback, 'error'));
  d.model.failure = null;
  d.db.exec("CREATE TRIGGER reject_dream BEFORE INSERT ON dream_solver_sessions BEGIN SELECT RAISE(ABORT,'fixture persistence rejected'); END;");
  const beforeMessages = d.bus.history('system.dream-solve').length;
  const unsaved = await d.dream.solveDream('Improve local memory retrieval');
  check('failed dream persistence is silent while ordinary success event is published', d.db.prepare('SELECT COUNT(*) AS n FROM dream_solver_sessions WHERE id = ?').get(unsaved.id).n === 0 && d.bus.history('system.dream-solve').length === beforeMessages + 1 && !Object.hasOwn(unsaved, 'persisted'));
  const apiBasics = { solve: { status: apiSolve.status, dreamNumber: apiSolve.body.dreamNumber }, narrativeGenerate: await dreamApi(`${prefix}/narrative/generate`, {}), assessment: await dreamApi(`${prefix}/monitor/assess`), history: await dreamApi(`${prefix}/dream-solver/history`) };
  check('actual action/history route positive controls respond', Object.values(apiBasics).every(v => v.status === 200));

  const changedJs = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', ref], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(p => p.endsWith('.js'));
  for (const path of changedJs) execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source(path), encoding: 'utf8' });
  const daemonWiring = source('server/daemon/engine.js'), runtimeWiring = source('server/runtime.js');
  const wiring = { narrativeStart: daemonWiring.includes('startNarrative();'), monitorStart: daemonWiring.includes('startIntelligenceMonitor();'), stopHooks: daemonWiring.includes('stopNarrative();') && daemonWiring.includes('stopIntelligenceMonitor();'), dreamerNotPassedByDefault: !source('server/intelligence/dream-solver.js').includes("trigger: 'api', dreamer") && !source('server/fleet/tools.js').includes("trigger: 'fleet', dreamer"), routeInstallers: ['installNarrativeRoutes(app)', 'installDreamSolverRoutes(app)', 'installIntelligenceMonitorRoutes(app)'].every(s => runtimeWiring.includes(s)), inspectionOnly: true };
  const live = [];
  if (process.argv.includes('--live')) for (const [label, url] of [['narrative', 'http://127.0.0.1:8787/api/intelligence/narrative'], ['dream-solver', 'http://127.0.0.1:8787/api/intelligence/dream-solver'], ['monitor', 'http://127.0.0.1:8787/api/intelligence/monitor'], ['vite', 'http://127.0.0.1:5173/']]) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (label === 'vite') { const text = await r.text(); live.push({ label, status: r.status, title: text.match(/<title>(.*?)<\/title>/)?.[1] ?? null }); } else { const body = await r.json(); live.push({ label, status: r.status, running: body.running ?? null, tier: body.gateTier ?? null, hasLastNarrative: !!body.lastNarrative, hasLastSolution: !!body.lastSolution, assessment: body.lastAssessment ? { score: body.lastAssessment.intelligenceScore, activeCount: body.lastAssessment.activeCount, totalCount: body.lastAssessment.totalCount, degradedCount: body.lastAssessment.degradedCount } : null }); } } catch (e) { live.push({ label, error: e.message }); }
  }
  const evidence = { reviewedRef: ref, generatedAt: new Date().toISOString(), sourceHashes, syntaxChecks: changedJs, diagnosticAssertions: checks.length, checks,
    methodology: 'Pinned source via git show, VM-isolated actual bodies, in-memory SQLite with actual producer schemas, actual CTRNN public object (no start/workers), actual fleet executeTool/bus/Express. Model responses and timers are controlled fixtures. No live state-changing calls, real model/compiler/daemon starts, live database writes or deletions. Optional live mode sends only three status GETs and the Vite root GET. Passing diagnostic assertions include reproductions of defects.',
    readiness, wiring, live, neural, toolResults, snapshotCounts, heart: { neutral: { primary: neutral.primary, normalized: neutral.normalized, compounds: neutral.compounds }, positiveBlend: blend, historySize: h.heart.getMoodHistory().length, oneFrameTrajectory: { shiftFinite: Number.isFinite(oneFrameTrajectory.shift), stabilityFinite: Number.isFinite(oneFrameTrajectory.stability) }, actualMood: mood, narrativeSignals: signals }, monitor: monitorResult,
    lifecycle: { requestsPendingBeforeStop: 2, stoppedBefore, stoppedAfter, lateBusEvents: lateEvents.length }, dreams: { defaultRoute: apiBasics.solve, explicitSignerControl: { dreamNumber: signedControl.dreamNumber }, zeroRatings: { novelty: zeroDream.noveltyScore, feasibility: zeroDream.feasibilityScore, coherence: zeroNarrative.coherenceScore, awareness: zeroNarrative.awarenessScore }, fallback: { id: fallback.id, solution: fallback.solution, novelty: fallback.noveltyScore, error: fallback.error ?? null }, unsaved: { returnedId: unsaved.id, stored: false, eventPublished: true } }, logs,
    summary: 'Implemented, changes requested. Status responses and direct controls do not establish fleet action, neural injection, lifecycle cancellation, durable success, calibrated emotions or model competence.' };
  writeFileSync(resolve(arg('--output')), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ref, diagnosticAssertions: checks.length, syntaxChecks: changedJs.length, live, neuralInputNonzero: nonzeroBeforeControl, neutralCompounds: neutral.compounds.map(c => c.name), pendingAfterStop: lateEvents.length }, null, 2));
} finally {
  for (const s of servers) await new Promise((done, reject) => { s.close(e => e ? reject(e) : done()); s.closeAllConnections(); });
  for (const f of fixtures) f.db.close();
}
