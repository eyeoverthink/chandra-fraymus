import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySandbox, verificationExitCode } from '../server/sandbox/verify.js';

const receipt = (stdout, extra = {}) => ({ ok: true, exitCode: 0, stdout, stderr: '', sandboxed: true, engine: 'docker', isolation: 'docker-linux', network: false, hostMounts: false, termination: 'exit', cleanup: { removed: true, name: 'mock-generated-container' }, ...extra });
const evidence = {
  'node-arithmetic': { value: 703 }, 'python-arithmetic': { value: 703 },
  'unprivileged-process-and-cgroups': { uid: 65534, euid: 65534, status: { NoNewPrivs: '1', Seccomp: '2', CapEff: '0000000000000000' }, cgroups: { '/sys/fs/cgroup/memory.max': '268435456', '/sys/fs/cgroup/pids.max': '64', '/sys/fs/cgroup/cpu.max': '100000 100000' } },
  'read-only-root': { rootReadonlyMount: true, writeDenied: true, errno: 30 },
  'tmpfs-write-read': { matches: true, tmpReadonlyMount: false, bytes: 36 },
  'fresh-container-has-no-marker': { markerExists: false },
  'no-docker-sockets-or-host-roots': { paths: { '/var/run/docker.sock': false, '/run/docker.sock': false, '/host': false, '/host_mnt': false, '/run/desktop/mnt/host': false, '/mnt/c': false } },
  'network-hard-ip-denied': { connected: false, connectFailed: true, errno: 101, interfaces: ['lo'] },
};
function mockExecutor({ unavailable = false, override, throwFor } = {}) {
  const calls = [];
  const executor = { kind: 'docker', health: async () => ({ available: !unavailable, kind: 'docker', engine: 'docker', reason: unavailable ? 'Firmware virtualization is disabled' : undefined, engineVersion: 'mock-engine', images: { javascript: 'mock-js', python: 'mock-python' } }), run: async (args, { signal } = {}) => {
    const name = args.code.match(/FRAYMUS_VERIFY:([a-z-]+)/)?.[1];
    assert.ok(name); calls.push({ name, args, signal });
    assert.ok(['javascript', 'python'].includes(args.language)); assert.ok(args.timeoutMs >= 3000 && args.timeoutMs <= 5000);
    if (throwFor === name) throw Object.assign(new Error('Cancellation before verified startup'), { code: 'cancelled' });
    if (override?.[name]) return override[name];
    if (name === 'infinite-node-timeout') return receipt('', { ok: false, exitCode: null, termination: 'timeout' });
    if (name === 'node-cancellation') {
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      return receipt('', { ok: false, exitCode: null, termination: 'cancelled' });
    }
    if (name === 'output-overflow-bounded') return receipt('x'.repeat(32768), { ok: false, exitCode: null, termination: 'output_limit' });
    return receipt(JSON.stringify(evidence[name]));
  } };
  return { executor, calls };
}
function acceleratedTimers() {
  const requested = [];
  return { requested, setTimeoutImpl: (callback, delay) => { requested.push(delay); return setTimeout(callback, 1); }, clearTimeoutImpl: clearTimeout };
}

test('unavailable Docker skips all container probes and never counts as a pass', async () => {
  const mock = mockExecutor({ unavailable: true });
  const report = await verifySandbox({ executor: mock.executor });
  assert.equal(report.available, false); assert.equal(report.passed, false); assert.equal(report.skipped, true);
  assert.deepEqual(report.tests, []); assert.equal(mock.calls.length, 0); assert.equal(verificationExitCode(report), 1);
  assert.match(report.reason, /virtualization/);
});

test('verification forces Docker even if the application environment explicitly enables approved host mode', async () => {
  let captured;
  const mock = mockExecutor({ unavailable: true });
  await verifySandbox({ dataDir: 'mock-data-dir', env: { FRAYMUS_CODE_EXECUTION: 'host', FRAYMUS_ALLOW_HOST_CODE: '1' }, executorFactory: options => { captured = options; return mock.executor; } });
  assert.equal(captured.dataDir, 'mock-data-dir'); assert.equal(captured.env.FRAYMUS_CODE_EXECUTION, 'docker'); assert.equal(captured.env.FRAYMUS_ALLOW_HOST_CODE, '0');
  const invalid = await verifySandbox({ executor: { kind: 'host', health: async () => ({ available: true }), run: async () => assert.fail('host execution must never run') } });
  assert.equal(invalid.skipped, true); assert.equal(invalid.passed, false);
});

test('healthy execution preserves eleven actual receipts and explicitly checks cancellation timing and bounds', async () => {
  const mock = mockExecutor(), timers = acceleratedTimers();
  const report = await verifySandbox({ executor: mock.executor, ...timers });
  assert.equal(report.available, true); assert.equal(report.passed, true); assert.equal(report.skipped, false);
  assert.equal(report.tests.length, 11); assert.equal(report.summary.passed, 11); assert.equal(verificationExitCode(report), 0);
  assert.deepEqual(timers.requested, [2000]); assert.equal(mock.calls.length, 11);
  assert.equal(mock.calls.find(call => call.name === 'infinite-node-timeout').args.timeoutMs, 4000);
  assert.equal(mock.calls.find(call => call.name === 'node-cancellation').signal.aborted, true);
  assert.ok(report.tests.every(result => result.receipt.sandboxed === true && result.receipt.cleanup.removed === true));
  assert.equal(report.tests.find(result => result.name === 'unprivileged-process-and-cgroups').observed.measuredLimits.cpuCores, 1);
  assert.equal(report.tests.find(result => result.name === 'output-overflow-bounded').observed.combinedOutputBytes, 32768);
});

test('failed arithmetic, weak isolation, retained files, open networking and unbounded output are real failures', async () => {
  const override = {
    'node-arithmetic': receipt(JSON.stringify({ value: 704 })),
    'unprivileged-process-and-cgroups': receipt(JSON.stringify({ ...evidence['unprivileged-process-and-cgroups'], uid: 0 })),
    'read-only-root': receipt(JSON.stringify({ rootReadonlyMount: false, writeDenied: true })),
    'fresh-container-has-no-marker': receipt(JSON.stringify({ markerExists: true })),
    'network-hard-ip-denied': receipt(JSON.stringify({ connected: true, connectFailed: false, interfaces: ['lo', 'eth0'] })),
    'output-overflow-bounded': receipt('x'.repeat(32769), { ok: false, termination: 'output_limit' }),
  };
  const report = await verifySandbox({ executor: mockExecutor({ override }).executor, ...acceleratedTimers() });
  assert.equal(report.passed, false); assert.equal(report.skipped, false); assert.equal(report.summary.failed, 6); assert.equal(verificationExitCode(report), 1);
  assert.ok(report.tests.find(result => result.name === 'output-overflow-bounded').error);
});

test('cancellation without a verified cleanup receipt is an honest failure, never a skipped pass', async () => {
  const report = await verifySandbox({ executor: mockExecutor({ throwFor: 'node-cancellation' }).executor, ...acceleratedTimers() });
  const cancelled = report.tests.find(result => result.name === 'node-cancellation');
  assert.equal(cancelled.passed, false); assert.equal(cancelled.skipped, false); assert.equal(cancelled.error.code, 'cancelled'); assert.equal(cancelled.receipt, undefined);
  assert.equal(report.passed, false); assert.equal(verificationExitCode(report), 1);
});

test('fresh-container test cannot pass if its prerequisite tmpfs marker write was unverified', async () => {
  const report = await verifySandbox({ executor: mockExecutor({ override: { 'tmpfs-write-read': receipt(JSON.stringify({ matches: false, tmpReadonlyMount: false })) } }).executor, ...acceleratedTimers() });
  assert.equal(report.tests.find(result => result.name === 'tmpfs-write-read').passed, false);
  assert.equal(report.tests.find(result => result.name === 'fresh-container-has-no-marker').passed, false);
  assert.equal(report.tests.find(result => result.name === 'fresh-container-has-no-marker').observed.priorWriteVerified, false);
});

test('a success-shaped response without verified Docker identity/cleanup never passes a probe', async () => {
  const report = await verifySandbox({ executor: mockExecutor({ override: { 'python-arithmetic': receipt(JSON.stringify({ value: 703 }), { sandboxed: false }), 'infinite-node-timeout': receipt('', { ok: false, termination: 'timeout', cleanup: { removed: false } }) } }).executor, ...acceleratedTimers() });
  assert.equal(report.tests.find(result => result.name === 'python-arithmetic').passed, false);
  assert.equal(report.tests.find(result => result.name === 'infinite-node-timeout').passed, false);
  assert.equal(report.summary.failed, 2); assert.equal(report.passed, false);
  assert.equal(verificationExitCode({ available: true, passed: true, skipped: true }), 1);
  assert.equal(verificationExitCode({ available: true, passed: true, skipped: false, tests: [] }), 1);
});

test('each privilege and cgroup constraint must independently match actual evidence', async () => {
  const original = evidence['unprivileged-process-and-cgroups'];
  const incorrect = [
    { ...original, euid: 0 },
    { ...original, status: { ...original.status, NoNewPrivs: '0' } },
    { ...original, status: { ...original.status, Seccomp: '0' } },
    { ...original, status: { ...original.status, CapEff: '0000000000000001' } },
    { ...original, cgroups: { ...original.cgroups, '/sys/fs/cgroup/memory.max': 'max' } },
    { ...original, cgroups: { ...original.cgroups, '/sys/fs/cgroup/pids.max': 'max' } },
    { ...original, cgroups: { ...original.cgroups, '/sys/fs/cgroup/cpu.max': 'max 100000' } },
  ];
  for (const observed of incorrect) {
    const report = await verifySandbox({ executor: mockExecutor({ override: { 'unprivileged-process-and-cgroups': receipt(JSON.stringify(observed)) } }).executor, ...acceleratedTimers() });
    assert.equal(report.tests.find(result => result.name === 'unprivileged-process-and-cgroups').passed, false);
    assert.equal(report.passed, false); assert.equal(verificationExitCode(report), 1);
  }
});
