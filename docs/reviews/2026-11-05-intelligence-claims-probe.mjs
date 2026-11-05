// Independent diagnostic probe. Reads source but never imports the application or SQLite.
// All DB, bus, clock, network, timer, neural state and action dependencies are injected.
// Assertions reproduce findings, rather than certifying the affected code as correct.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const headBefore = git('rev-parse', 'HEAD');
const dirtyBefore = git('status', '--short');
const sources = new Map();
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const keys = ['bus', 'memory', 'emotion', 'consciousness', 'agent', 'health', 'workflow', 'goals'];
const signals = value => Object.fromEntries(keys.map(k => [k, value]));
const gate = () => ({ evolutionRate: 1, neurogenesisBoost: 1, proofsPassed: 4, tier: 'INTEGRATED' });
class ProbeDate extends Date { static now() { return 1_000_000_000; } }

function environment(extra = {}) {
  const effects = { bus: [], injections: [], errors: [], sql: [], efference: [] };
  const ctrnn = {
    running: true,
    state: () => ({ B: new Float64Array(256).fill(1), gridSize: 16, tick: 100 }),
    inject: (...args) => effects.injections.push(args),
  };
  return {
    effects, ctrnn,
    bindings: {
      db: { prepare: sql => ({
        run: (...args) => { effects.sql.push({ sql, args }); return { changes: 1 }; },
        get: () => ({ c: 0 }), all: () => [],
      }) },
      getCTRNN: () => ctrnn, getAutonomyModifiers: gate,
      publish: (...args) => effects.bus.push(args), randomUUID,
      Date: ProbeDate, Math, AbortSignal,
      console: { error: (...args) => effects.errors.push(args.join(' ')), log() {}, warn() {} },
      setInterval: () => ({ injectedTimer: true }), clearInterval() {},
      isActionSuppressed: () => false, isActionPreferred: () => false,
      isResourceConstrained: () => false,
      recordEfferenceCopy: key => effects.efference.push(key),
      queryWorkingMemory: () => ({ derivatives: {} }),
      performance: { now: () => 0 }, fetch: async () => ({ ok: true }),
      process: { memoryUsage: () => ({ heapUsed: 0, heapTotal: 0, rss: 0 }) },
      DATA_DIR: 'injected-no-real-data', OLLAMA_URL: 'http://injected.invalid',
      statSync: () => ({ size: 0 }), join,
      ...extra,
    },
  };
}

function load(relative, bindings) {
  const source = readFileSync(join(root, relative), 'utf8');
  // Freeze the first bytes observed so concurrent edits cannot silently change a case.
  if (sources.has(relative)) assert.equal(source, sources.get(relative), `${relative} changed during probe`);
  sources.set(relative, source);
  const names = [...source.matchAll(/^export (?:async )?(?:function|class|const|let) (\w+)/gm)].map(m => m[1]);
  const body = source.replace(/^import [^\r\n]+;\r?$/gm, '').replace(/^export /gm, '');
  assert.ok(!/^import\s/m.test(body), `Unsupported import layout: ${relative}`);
  return new vm.Script(`(() => {\n${body}\nreturn { ${names.join(', ')} };\n})()`, { filename: relative })
    .runInNewContext(bindings, { timeout: 3000 });
}
const modulePath = name => `server/intelligence/${name}.js`;
const moduleIn = (name, env) => load(modulePath(name), env.bindings);
const motorIn = env => moduleIn('motor-output', env);
const installTargets = (motor, calls, override = {}) => motor.setMotorTargets({
  reflect: async () => { calls.push('reflect'); return { ok: true }; },
  neurogenesis: async () => { calls.push('neurogenesis'); return { ok: true }; },
  consciousness: async () => { calls.push('consciousness'); return { ok: true }; },
  goals: async () => { calls.push('goals'); return { ok: true }; }, ...override,
});

// The real working-memory -> predictor -> active-inference contract, without Ollama.
const predictionEnv = environment();
const wm = moduleIn('working-memory', predictionEnv);
predictionEnv.bindings.queryWorkingMemory = wm.queryWorkingMemory;
const predictor = moduleIn('predictive-processing', predictionEnv);
const active = moduleIn('active-inference', predictionEnv);
function predict(frame) {
  wm.updateWorkingMemory({ signals: frame, amplitudes: frame, ts: ProbeDate.now() });
  return predictor.updatePredictions(frame);
}
predict(signals(0));
const perturbation = { ...signals(0), bus: 1 };
const prediction = predict(perturbation);
const naturalInference = active.updateActiveInference(prediction);
check('real predictor detects bus perturbation', prediction.errors.bus === 1);
check('active inference reads errors directly (ep3Surprise field removed)', !Object.hasOwn(prediction, 'ep3Surprise'));
check('natural module handoff produces motor bias from EP3-compressed errors', naturalInference.biasInjections > 0 && Object.keys(naturalInference.motorBiases).length > 0);

// Direct computed bias does not consume the effectiveness estimate. This does not
// rule out indirect future CTRNN effects from its separate telemetry injection.
function effectivenessTrial(previousError) {
  active.resetActiveInference();
  active.updateActiveInference({ errors: { bus: previousError } });
  return active.updateActiveInference({ errors: { bus: 0.5 } });
}
const improved = effectivenessTrial(1);
const worsened = effectivenessTrial(0.2);
check('effectiveness responds to error trend', improved.effectiveness > worsened.effectiveness);
check('direct motor bias is identical for different effectiveness', JSON.stringify(improved.motorBiases) === JSON.stringify(worsened.motorBiases));

async function resourceTrial({ heapMB = 0, activeRuns = 0, offline = false } = {}) {
  const env = environment({
    process: { memoryUsage: () => ({ heapUsed: heapMB * 1048576, heapTotal: heapMB * 1048576, rss: heapMB * 1048576 }) },
    fetch: async () => ({ ok: !offline }),
  });
  const prepare = env.bindings.db.prepare;
  env.bindings.db.prepare = sql => ({ ...prepare(sql), get: () => ({ c: sql.includes('FROM runs') ? activeRuns : 0 }) });
  const resources = moduleIn('resource-envelope', env);
  const measurement = await resources.triggerEnvelopeCycle();
  env.bindings.isResourceConstrained = resources.isResourceConstrained;
  const motor = motorIn(env), calls = [];
  installTargets(motor, calls);
  await motor.triggerMotorCycle();
  const cycle = await motor.triggerMotorCycle();
  return { measurement, constrained: resources.isResourceConstrained(), handlerCalls: calls, firings: cycle.firings };
}
const heapExhausted = await resourceTrial({ heapMB: 1024 });
const runsExhausted = await resourceTrial({ activeRuns: 16 });
const ollamaOffline = await resourceTrial({ offline: true });
check('twice heap ceiling remains LOW and unconstrained', heapExhausted.measurement.level === 'LOW' && !heapExhausted.constrained);
check('costly motor handlers execute above heap ceiling', heapExhausted.handlerCalls.includes('reflect') && heapExhausted.handlerCalls.includes('goals'));
check('twice concurrent-run ceiling remains unconstrained', !runsExhausted.constrained && runsExhausted.handlerCalls.length === 4);
check('Ollama unavailable alone does not suppress motor handlers', !ollamaOffline.measurement.resources.ollamaAvailable && !ollamaOffline.constrained && ollamaOffline.handlerCalls.length === 4);

// Strategy producer and motor consumer use different names for the same region.
const strategyEnv = environment();
const strategy = moduleIn('adaptive-strategy', strategyEnv);
strategy.updateAdaptiveStrategy({ strategy: { strategy: 'conserve', reason: 'probe' }, effectiveness: 0.1 });
strategyEnv.bindings.isActionSuppressed = strategy.isActionSuppressed;
strategyEnv.bindings.isActionPreferred = strategy.isActionPreferred;
const strategyMotor = motorIn(strategyEnv), strategyCalls = [];
installTargets(strategyMotor, strategyCalls);
await strategyMotor.triggerMotorCycle();
const conserveCycle = await strategyMotor.triggerMotorCycle();
check('conserve suppresses goal_seek but not motor key goalSeek', strategy.isActionSuppressed('goal_seek') && !strategy.isActionSuppressed('goalSeek'));
check('real motor still executes goal handler under conserve', strategyCalls.includes('goals'));
const suppressedNeuro = conserveCycle.firings.find(f => f.region === 'neurogenesis');
check('positive control: matching neurogenesis name is suppressed', suppressedNeuro.result === 'suppressed' && !strategyCalls.includes('neurogenesis'));

// A failed handler must not become an efference-copy success.
const failureEnv = environment();
const failureMotor = motorIn(failureEnv), failureCalls = [];
installTargets(failureMotor, failureCalls, { reflect: async () => { throw new Error('synthetic failure'); } });
await failureMotor.triggerMotorCycle();
const failureCycle = await failureMotor.triggerMotorCycle();
const failedReflection = failureCycle.firings.find(f => f.region === 'reflect');
check('synthetic handler error was caught', failureEnv.effects.errors.length === 1);
check('failed handler reported as ok', failedReflection.result === 'ok');
check('failed handler recorded as executed in efference copy', failureEnv.effects.efference.includes('reflect'));

// Use the actual start/stop path. Timers are inert; the first immediate cycle
// supplies the warm reading, then a deferred action models an in-flight request.
const stopEnv = environment();
const stopMotor = motorIn(stopEnv), stopCalls = [];
let release;
let stopped = false;
installTargets(stopMotor, stopCalls, {
  reflect: async () => { stopCalls.push({ action: 'reflect', afterStop: stopped }); await new Promise(r => { release = r; }); return { ok: true }; },
  neurogenesis: async () => { stopCalls.push({ action: 'neurogenesis', afterStop: stopped }); return { ok: true }; },
  consciousness: async () => { stopCalls.push({ action: 'consciousness', afterStop: stopped }); return { ok: true }; },
  goals: async () => { stopCalls.push({ action: 'goals', afterStop: stopped }); return { ok: true }; },
});
stopMotor.startMotorOutput();
const pending = stopMotor.triggerMotorCycle();
check('motor reached deferred handler before stop', typeof release === 'function');
const stopReceipt = stopMotor.stopMotorOutput();
stopped = true;
release();
await pending;
check('stopped status is visible', stopReceipt.stopped && !stopMotor.getMotorOutputStatus().running);
check('new handlers are dispatched after stop returned', stopCalls.filter(c => c.afterStop).length === 3);

const suppressionEnv = environment({ isResourceConstrained: () => true });
const suppressionMotor = motorIn(suppressionEnv), suppressionCalls = [];
installTargets(suppressionMotor, suppressionCalls);
await suppressionMotor.triggerMotorCycle();
const suppressionCycle = await suppressionMotor.triggerMotorCycle();
check('positive control: aggregate constraint skips all handlers', suppressionCalls.length === 0 && suppressionCycle.firings.every(f => f.result === 'resource_constrained'));
check('suppressed attempts still increment firings and publish fired', suppressionMotor.getMotorOutputStatus().firings === 6 && suppressionEnv.effects.bus.some(e => e[1] === 'system.motor.fired'));

const evidence = {
  generatedAt: new Date().toISOString(), headBefore, headAfter: git('rev-parse', 'HEAD'), dirtyBefore,
  safety: { applicationImports: false, sqliteOpened: false, realNetwork: false, realTimers: false, liveActions: false },
  method: 'Complete source modules evaluated in isolated VM contexts with injected dependencies. Only imports and export keywords removed. No production functions patched.',
  sources: Object.fromEntries([...sources].map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])),
  checks, assertionCount: checks.length,
  predictionContract: { producerKeys: Object.keys(prediction), errors: prediction.errors, naturalInference, positiveControl },
  effectiveness: { improved, worsened },
  resourceLimits: { heapExhausted, runsExhausted, ollamaOffline },
  strategyNames: { modifiers: strategy.getAdaptiveModifiers(), calls: strategyCalls, firings: conserveCycle.firings },
  failedMotor: { firings: failureCycle.firings, efference: failureEnv.effects.efference, errors: failureEnv.effects.errors },
  stopRace: { receipt: stopReceipt, calls: stopCalls },
  suppressedTelemetry: { handlerCalls: suppressionCalls.length, countedFirings: suppressionMotor.getMotorOutputStatus().firings, results: suppressionCycle.firings },
};
const outputFlag = process.argv.indexOf('--output');
if (outputFlag >= 0) {
  assert.ok(process.argv[outputFlag + 1], '--output requires a path');
  writeFileSync(resolve(process.argv[outputFlag + 1]), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ assertionCount: checks.length, headBefore, headAfter: evidence.headAfter, output: resolve(process.argv[outputFlag + 1]) }));
} else console.log(JSON.stringify(evidence, null, 2));
