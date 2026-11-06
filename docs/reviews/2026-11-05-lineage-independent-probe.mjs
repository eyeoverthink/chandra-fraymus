// Independent diagnostic probe. Does not load the live app, DB, daemon or Ollama.
// Run: node docs/reviews/2026-11-05-lineage-independent-probe.mjs --output PATH
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import express from 'express';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = 'ed6f9992feef82a67c7a62b2e32297e3298b6c25';
const sourceHashes = {}, cache = new Map(), checks = [];
function source(path) {
  if (!cache.has(path)) {
    const value = execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, encoding: 'utf8' });
    cache.set(path, value);
    sourceHashes[path] = createHash('sha256').update(value).digest('hex');
  }
  return cache.get(path);
}
function moduleFrom(path, bindings, names) {
  const body = source(path).replace(/^import [\s\S]*?;\r?$/gm, '')
    .replace(/^export \{[^}]+\};\s*$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import /m.test(body));
  return new vm.Script(`(()=>{${body}\nreturn {${names}};})()`, { filename: path })
    .runInNewContext({ Date, Math, JSON, console, ...bindings });
}
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
const ddl = source('server/db-migrate.js');
function fixture() {
  const db = new Database(':memory:');
  for (const table of ['bus_messages', 'bus_subscriptions']) {
    db.exec(ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  }
  db.exec(`CREATE TABLE harness_evidence (run_id,step,tool,args_hash,result_hash,evidence_sha,duration_ms,refused,created_at);
    CREATE TABLE fleet_memories (id,agent_id,text,tags,created_at,user_id);`);
  const bus = moduleFrom('server/fleet/bus.js', { db }, 'publish,history');
  const engine = moduleFrom('server/intelligence/lineage.js', { db, createHash, publish: bus.publish },
    'PATIENT,AGE_TIERS,readChart,getCurrentAge,getTier,getAllTiers,evaluateFormula,verifyTier,buildLineageContext,getLineageStats,getRecentReadings');
  return { db, bus, engine };
}
const f = fixture();
let server;
try {
  const first = f.engine.readChart('independent-review');
  check('all 31 author examples pass across six tiers', first.testsPassed === 31 && first.testsTotal === 31 && first.tierResults.length === 6);
  check('normal chart read persists and publishes via actual bus', f.engine.getLineageStats().totalReadings === 1 && f.bus.history('system.lineage.chart-read').length === 1);
  const math = {
    quadratic: f.engine.evaluateFormula(2, 'quadratic', [1, -5, 6]).result,
    triangle: f.engine.evaluateFormula(5, 'pythagorean', [3, 4]).result,
    euler: f.engine.evaluateFormula(5, 'euler', [Math.PI]).result,
    orbit: f.engine.evaluateFormula(17, 'visViva', [6.771e6, 6.771e6]).result,
    hadamard: f.engine.evaluateFormula(17, 'hadamard', [0]).result,
  };
  check('claimed circular-orbit example computes 7672.6 m/s', Math.abs(math.orbit.v - 7672.6) < 0.1);
  check('Hadamard example has unit classical amplitude norm', Math.abs(math.hadamard.alpha ** 2 + math.hadamard.beta ** 2 - 1) < 1e-12);

  // Extract the exact newly registered object without evaluating unrelated tools.
  const toolSource = source('server/fleet/tools.js');
  const anchor = toolSource.indexOf("name: 'lineage_chart'");
  assert.ok(anchor > 0);
  const start = toolSource.lastIndexOf('\n    {', anchor) + 5;
  const end = toolSource.indexOf('\n    },', anchor) + '\n    }'.length;
  const ledgerEvents = [];
  const tool = new vm.Script(`(${toolSource.slice(start, end)})`).runInNewContext({
    ...f.engine, object: properties => ({ type: 'object', properties }),
    ledger: { record: (...args) => ledgerEvents.push(args) },
  });
  const runtime = moduleFrom('server/fleet/runtime.js', {
    db: f.db, randomUUID, ...f.engine,
    sealToolResult: (tool, args, result) => ({ result, evidence: { tool } }), isClockTrusted: () => true,
    loadManifests: () => new Map(), buildPromptContext: () => '', akashicPromptContext: () => '',
    getActiveFraming: () => '', getAutonomyModifiers: () => ({}), buildSpatialContext: () => '',
    heart: { recentMood: () => ({}) }, dreamer: { feel: () => ({}) }, cognition: { status: () => ({}) },
  }, 'setFleetTools,executeTool,systemPrompt');
  runtime.setFleetTools([tool]);
  const fleet = {};
  for (const mode of ['status', 'read', 'tiers', 'verify', 'evaluate']) {
    const args = { mode, age: 2, formula: 'quadratic', args: [1, -5, 6] };
    const result = await runtime.executeTool('lineage_chart', args, { runId: 'fixture', step: 1 });
    fleet[mode] = { returnedStats: !!result.result.lastReading, formula: result.result.formula ?? null, ledgerEvent: ledgerEvents.at(-1)?.[0] };
  }
  check('actual fleet executor silently maps all five modes to status', Object.values(fleet).every(r => r.returnedStats && r.ledgerEvent === 'lineage.status'));
  check('fleet read mode performs no chart read', f.engine.getLineageStats().totalReadings === 1);
  const directTool = await tool.execute({ mode: 'evaluate', age: 2, formula: 'quadratic', args: [1, -5, 6] });
  check('bare-parameter tool call is a working positive control', directTool.formula === 'quadratic' && directTool.result.x1 === 3);
  const beforePrompt = f.engine.getLineageStats().totalReadings;
  const prompt = await runtime.systemPrompt({ id: 'fixture', name: 'Fixture', role: 'review', systemPrompt: 'Fixture.' }, 'local');
  check('actual fleet prompt contains chart summary', prompt.includes('Lineage') && prompt.includes('Mastered:') && prompt.includes('Quantum'));
  check('prompt construction does not re-read or re-verify the chart', f.engine.getLineageStats().totalReadings === beforePrompt);

  const routes = moduleFrom('server/intelligence/lineage-routes.js', f.engine, 'installLineageRoutes');
  const app = express(); app.use(express.json()); routes.installLineageRoutes(app);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  server = await new Promise(resolveServer => { const s = app.listen(0, '127.0.0.1', () => resolveServer(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/intelligence/lineage`;
  const request = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const api = {
    stats: await request(''), tiers: await request('/tiers'), tier: await request('/tiers/2'), readings: await request('/readings'),
    verify: await request('/verify', { age: 2 }), read: await request('/read-chart', {}),
    valid: await request('/evaluate', { age: 2, formula: 'quadratic', args: [1, -5, 6] }),
    derivative: await request('/evaluate', { age: 9, formula: 'derivative', args: ['x*x', 2] }),
    integral: await request('/evaluate', { age: 9, formula: 'integrate', args: ['2*x', 0, 3] }),
    degenerate: await request('/evaluate', { age: 2, formula: 'quadratic', args: [0, 1, 1] }),
    inherited: await request('/evaluate', { age: 2, formula: 'constructor', args: [123] }),
    wrongType: await request('/evaluate', { age: 0, formula: 'add', args: ['1', 1] }),
    zeroRadius: await request('/evaluate', { age: 17, formula: 'visViva', args: [0, 0] }),
  };
  check('all seven route patterns respond on isolated Express server', ['stats', 'tiers', 'tier', 'readings', 'verify', 'read', 'valid'].every(k => api[k].status === 200));
  check('calculus callback formulas are unusable through JSON arguments', api.derivative.status === 400 && api.integral.status === 400 && api.derivative.body.error.includes('function'));
  check('degenerate quadratic reports successful real roots serialized as null', api.degenerate.status === 200 && api.degenerate.body.result.real === true && api.degenerate.body.result.x1 === null && api.degenerate.body.result.x2 === null);
  check('inherited Object constructor is accepted as a formula', api.inherited.status === 200 && api.inherited.body.result === 123);
  check('arithmetic accepts a string and returns concatenation', api.wrongType.status === 200 && api.wrongType.body.result === '11');
  check('zero orbit radii produce null results with HTTP success', api.zeroRadius.status === 200 && api.zeroRadius.body.result.v === null);
  const cancellation = f.engine.evaluateFormula(2, 'quadratic', [1, 1e16, 1]).result;
  check('finite nondegenerate quadratic loses the small root and violates Vieta', cancellation.real && cancellation.x1 === 0 && cancellation.x1 * cancellation.x2 !== 1);
  const width = f.engine.evaluateFormula(13, 'hamming', [0, 2 ** 40]).result;
  check('hamming silently truncates operands beyond its stated 32-bit width', width === 0);
  const directCalculus = f.engine.evaluateFormula(9, 'integrate', [x => 2 * x, 0, 3]).result;
  check('integration works with a direct JavaScript callback control', Math.abs(directCalculus - 9) < 1e-10);

  const noRead = fixture(), blocked = fixture(), failedTier = fixture();
  let persistence, prerequisite;
  try {
    check('fresh database has no lineage prompt until an explicit chart read', noRead.engine.buildLineageContext() === '');
    blocked.db.exec("CREATE TRIGGER fixture_reject BEFORE INSERT ON lineage_readings BEGIN SELECT RAISE(ABORT,'fixture insert rejected'); END;");
    const returned = blocked.engine.readChart('fixture-rejected');
    persistence = { returnedAge: returned.currentAge, returnedTests: returned.testsPassed, error: returned.error ?? null,
      savedReadings: blocked.engine.getLineageStats().totalReadings, busRows: blocked.bus.history('system.lineage.chart-read').length,
      prompt: blocked.engine.buildLineageContext() };
    check('failed persistence is hidden while success chart event is published', persistence.returnedAge === 17 && !persistence.error && persistence.savedReadings === 0 && persistence.busRows === 1 && persistence.prompt === '');
    failedTier.engine.AGE_TIERS[0].formulas.add = () => 999; // VM-only fault injection.
    const result = failedTier.engine.readChart('fixture-base-tier-failure');
    prerequisite = { firstTier: result.tierResults[0], currentAge: result.currentAge, prompt: failedTier.engine.buildLineageContext() };
    check('failed arithmetic tier is still labeled mastered in prompt', prerequisite.firstTier.passed < prerequisite.firstTier.total && prerequisite.currentAge === 0 && prerequisite.prompt.includes('Mastered: Peano'));
  } finally { noRead.db.close(); blocked.db.close(); failedTier.db.close(); }
  const modified = ['server/intelligence/lineage.js', 'server/intelligence/lineage-routes.js', 'server/fleet/tools.js', 'server/fleet/runtime.js', 'server/daemon/engine.js', 'server/runtime.js'];
  for (const path of modified) execFileSync(process.execPath, ['--check', '--input-type=module'], { input: source(path), encoding: 'utf8' });
  const inspectedWiring = {
    daemonReadHook: source('server/daemon/engine.js').includes("readChart('daemon-boot')"),
    daemonStatus: source('server/daemon/engine.js').includes('lineage: getLineageStats()'),
    routeInstallation: source('server/runtime.js').includes('installLineageRoutes(app)'),
    autostart: source('server/app.js').match(/if\(process\.env\.FRAYMUS_AUTONOMY_AUTOSTART[^\n]+\n[\s\S]*?\n  }/)?.[0] ?? null,
    validation: 'Source inspection only; no daemon or main application execution.',
  };
  const evidence = { reviewedRef: ref, generatedAt: new Date().toISOString(), methodology: 'Pinned git-show source evaluated in isolated VM contexts; actual SQLite in-memory, actual bus and fleet dispatch, isolated loopback Express. Unrelated harness permissions/sealing and other prompt providers stubbed. No live DB, daemon, compiler, hardware or model calls.',
    syntaxChecks: modified, sourceHashes, inspectedWiring, authorSelfTests: first, math, fleet, prompt, api, cancellation, hammingBeyondWidth: width,
    persistence, prerequisite, diagnosticAssertions: checks.length, checks,
    scope: 'Assertions reproduce both working controls and defects. A passing diagnostic assertion is NOT feature acceptance or agent/hardware/quantum competence.' };
  const index = process.argv.indexOf('--output');
  if (index >= 0) writeFileSync(resolve(process.argv[index + 1]), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ref, diagnosticAssertions: checks.length, authorExamples: `${first.testsPassed}/${first.testsTotal}`, syntaxChecks: modified.length, fleet, cancellation, persistence }, null, 2));
} finally {
  if (server) await new Promise((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections(); });
  f.db.close();
}
