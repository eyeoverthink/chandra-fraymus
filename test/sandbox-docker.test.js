import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createDockerSandbox } from '../server/sandbox/docker.js';
import { EXECUTION_LABEL, DEFAULT_DOCKER_PATH } from '../server/sandbox/resource-identity.js';

const JS = 'sha256:' + '1'.repeat(64), PYTHON = 'sha256:' + '2'.repeat(64);
const images = { javascript: JS, python: PYTHON };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { if (predicate()) return; await delay(5); }
  assert.fail('Timed out waiting for fake Docker state');
}
const missing = name => Object.assign(new Error('No such object: ' + name), { code: 1, stderr: 'Error: No such object: ' + name });

function harness(options = {}) {
  const calls = [], children = [], containers = new Map(), removals = [];
  let live = 0, peak = 0;
  const engine = { OSType: 'linux', ServerVersion: '29.unit-test', ID: 'unit-test-daemon',
    MemoryLimit: true, SwapLimit: true, PidsLimit: true, CpuCfsQuota: true,
    Runtimes: { runc: {} },
    SecurityOptions: ['name=seccomp,profile=builtin'], ...options.engine };
  const valueOf = (args, option) => args[args.indexOf(option) + 1];
  const stateFor = child => ({ Name: '/' + child.name, Id: 'c'.repeat(64), Image: child.image,
    State: { Running: true }, Mounts: [],
    Config: { User: '65534:65534', WorkingDir: '/tmp', Volumes: null, Labels: Object.fromEntries(child.args.flatMap((arg,index)=>arg==='--label'?[child.args[index+1].split('=')]:[])),
      Entrypoint: ['/usr/bin/env'], Cmd: ['-i', 'HOME=/tmp', 'TMPDIR=/tmp',
        ...(child.image === JS ? ['/usr/local/bin/node', '--input-type=module', '-'] : ['/usr/local/bin/python', '-I', '-'])] },
    HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: 'none',
      PidMode: 'private', IpcMode: 'none', CgroupnsMode: 'private', Runtime: 'runc', UTSMode: '',
      VolumesFrom: null, PublishAllPorts: false, PortBindings: {},
      Binds: null, Mounts: null, Memory: 268435456, MemorySwap: 268435456,
      NanoCpus: 1000000000, PidsLimit: 64, CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'], LogConfig: { Type: 'none' },
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=16m,mode=1777' } },
  });
  function finish(child, code = 0) {
    if (child.closed) return;
    child.closed = true; live--;
    if (!options.keepAfterExit) containers.delete(child.name);
    child.emit('close', code);
  }
  const spawnImpl = (executable, args, spawnOptions) => {
    calls.push({ kind: 'spawn', executable, args: [...args], options: spawnOptions });
    const child = new EventEmitter();
    child.name = valueOf(args, '--name');
    child.image = args[args.indexOf('--entrypoint') + 2];
    child.args = args; child.input = Buffer.alloc(0); child.kills = [];
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { child.input = Buffer.concat([child.input, chunk]); callback(); },
      final(callback) {
        callback();
        setImmediate(() => {
          if (options.onCode) options.onCode(child, finish);
          else { child.stdout.write('verified output\n'); finish(child); }
        });
      },
    });
    child.kill = signal => {
      child.kills.push(signal);
      if (!options.ignoreCliKill) finish(child, 137);
      return true;
    };
    live++; peak = Math.max(peak, live); children.push(child);
    const created = () => {
      const state = stateFor(child);
      options.mutateContainer?.(state);
      containers.set(child.name, state);
    };
    if (options.creationDelay) setTimeout(created, options.creationDelay);
    else created();
    options.onSpawn?.(child);
    return child;
  };
  const execFileImpl = async (executable, args, execOptions) => {
    calls.push({ kind: 'exec', executable, args: [...args], options: execOptions });
    const local = args.slice(4);
    if (local[0] === 'info') {
      if (options.engineFailure) throw new Error('PRIVATE_HOST_SECRET should never escape diagnostics');
      return { stdout: JSON.stringify(engine) };
    }
    if (local[0] === 'image') {
      if (options.imageFailure) throw new Error('image missing');
      return { stdout: [...new Set([JS, PYTHON])].map(id => JSON.stringify({
        Id: id, Os: 'linux', Config: { Volumes: null }, ...options.image,
      })).join('\n') };
    }
    const name = local.at(-1);
    assert.match(name, /^fraymus-code-[a-f0-9-]{36}$/);
    if (local[0] === 'rm') {
      assert.deepEqual(local.slice(0, 3), ['rm', '-f', '--']);
      removals.push(name);
      if (options.cleanupFailure) throw new Error('daemon cleanup unavailable');
      if (!containers.has(name)) throw missing(name);
      containers.delete(name);
      const child = children.find(value => value.name === name);
      if (!options.ignoreCliKill) finish(child, 137);
      return { stdout: name + '\n' };
    }
    assert.deepEqual(local.slice(0, 3), ['container', 'inspect', '--format']);
    if (!containers.has(name)) throw missing(name);
    return { stdout: JSON.stringify(containers.get(name)) };
  };
  const sandbox = createDockerSandbox({ images, spawnImpl, execFileImpl,
    cleanupTimeoutMs: 300, ...options.constructor });
  return { sandbox, calls, children, containers, removals, finish, engine, get peak() { return peak; } };
}

test('Docker health requires installed immutable Linux images and built-in seccomp', async () => {
  const good = harness();
  const health = await good.sandbox.health();
  assert.equal(health.available, true);
  assert.equal(health.kind, 'docker'); assert.equal(health.engineVersion, '29.unit-test');
  assert.deepEqual(health.images, images);
  assert.equal(health.seccomp, 'builtin-default');
  for (const options of [{ engine: { OSType: 'windows' } },
    { engine: { SecurityOptions: [] } }, { engine: { SecurityOptions: ['name=seccomp,profile=unconfined'] } },
    { engine: { MemoryLimit: false } }, { engine: { SwapLimit: false } }, { engine: { PidsLimit: false } },
    { engine: { CpuCfsQuota: false } }, { engine: { Runtimes: {} } },
    { imageFailure: true }, { image: { Os: 'windows' } }, { image: { Id: 'sha256:' + 'a'.repeat(64) } },
    { image: { Config: { Volumes: { '/implicit-host-volume': {} } } } }, { engineFailure: true }]) {
    const bad = harness(options);
    const unavailable = await bad.sandbox.health();
    assert.equal(unavailable.available, false);
    assert.equal(JSON.stringify(unavailable).includes('PRIVATE_HOST_SECRET'), false);
    await assert.rejects(bad.sandbox.run({ language: 'javascript', code: '1' }), { code: 'sandbox_unavailable' });
    assert.equal(bad.children.length, 0);
  }
});

test('missing or mutable image configuration fails closed before any Docker process', async () => {
  for (const configuration of [{}, { javascript: 'node:24', python: PYTHON }, { javascript: JS }]) {
    const h = harness({ constructor: { images: configuration } });
    assert.equal((await h.sandbox.health()).available, false);
    await assert.rejects(h.sandbox.run({ language: 'javascript', code: '1' }), { code: 'sandbox_unavailable' });
    assert.equal(h.calls.length, 0);
  }
});

test('Docker endpoint selection ignores hostile host environment and rejects remote transports', async () => {
  for (const dockerHost of ['tcp://attacker.example:2375', 'ssh://user@host', 'npipe:////remote/pipe/docker_engine',
    'unix://attacker/run/docker.sock', 'unix:///tmp/../docker.sock', 'unix:////remote/docker.sock']) {
    assert.throws(() => createDockerSandbox({ images, dockerHost }), /local|socket|pipe/);
  }
  const oldHost = process.env.DOCKER_HOST, oldContext = process.env.DOCKER_CONTEXT, oldSecret = process.env.FRAYMUS_SANDBOX_TEST_SECRET;
  try {
    process.env.DOCKER_HOST = 'tcp://attacker.example:2375';
    process.env.DOCKER_CONTEXT = 'remote-secret-context';
    process.env.FRAYMUS_SANDBOX_TEST_SECRET = 'HOST_SECRET_MUST_NOT_LEAK';
    const h = harness({ constructor: { dockerHost: 'npipe:////./pipe/dockerDesktopLinuxEngine' } });
    await h.sandbox.run({ language: 'javascript', code: 'console.log(1)' });
    for (const call of h.calls) {
      assert.deepEqual(call.args.slice(0, 2), ['--host', 'npipe:////./pipe/dockerDesktopLinuxEngine']);
      assert.equal(call.args[2], '--config');
      assert.match(call.args[3], /fraymus-empty-docker-config-/);
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.env.DOCKER_HOST, undefined);
      assert.equal(call.options.env.DOCKER_CONTEXT, undefined);
      assert.equal(call.options.env.FRAYMUS_SANDBOX_TEST_SECRET, undefined);
      assert.equal(JSON.stringify(call).includes('HOST_SECRET_MUST_NOT_LEAK'), false);
    }
  } finally {
    for (const [key, value] of [['DOCKER_HOST', oldHost], ['DOCKER_CONTEXT', oldContext], ['FRAYMUS_SANDBOX_TEST_SECRET', oldSecret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('JavaScript runs by stdin with verified flags, an empty environment, no shell or mounts', async () => {
  const h = harness();
  const code = 'console.log("$() ; literal code, not shell syntax");';
  const result = await h.sandbox.run({ language: 'javascript', code, timeoutMs: 1000 });
  assert.equal(result.ok, true); assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'verified output\n'); assert.equal(result.stderr, '');
  assert.equal(result.sandboxed, true); assert.equal(result.engine, 'docker');
  assert.equal(result.isolation, 'docker-linux'); assert.equal(result.network, false); assert.equal(result.hostMounts, false);
  assert.equal(result.cleanup.removed, true); assert.equal(result.cleanup.verifiedAbsent, true);
  assert.equal(h.containers.size, 0);
  assert.equal(h.children[0].input.toString(), code);
  const call = h.calls.find(value => value.kind === 'spawn'), args = call.args;
  assert.equal(args.includes(code), false);
  const expected = [['--pull', 'never'], ['--network', 'none'], ['--memory', '256m'], ['--memory-swap', '256m'],
    ['--cpus', '1'], ['--pids-limit', '64'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'],
    ['--pid', 'private'], ['--ipc', 'none'], ['--cgroupns', 'private'], ['--runtime', 'runc'],
    ['--user', '65534:65534'], ['--workdir', '/tmp'], ['--log-driver', 'none']];
  for (const [key, value] of expected) assert.equal(args[args.indexOf(key) + 1], value);
  for (const flag of ['--rm', '--interactive', '--read-only', '--no-healthcheck']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tmpfs') + 1], '/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777');
  assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', '/usr/bin/env', JS,
    '-i', 'HOME=/tmp', 'TMPDIR=/tmp', '/usr/local/bin/node', '--input-type=module', '-']);
  for (const forbidden of ['--mount', '--volume', '-v', '--privileged', '--network=host']) assert.equal(args.includes(forbidden), false);
  assert.ok(h.removals.length >= 2);
  assert.ok(h.removals.every(name => name === result.cleanup.name));
});

test('Python uses the isolated interpreter and preserves nonzero exit status', async () => {
  const h = harness({ onCode(child, finish) { child.stderr.write('synthetic failure'); finish(child, 7); } });
  const result = await h.sandbox.run({ language: 'python', code: 'raise RuntimeError("test")' });
  assert.equal(result.ok, false); assert.equal(result.exitCode, 7); assert.equal(result.termination, 'exit');
  assert.equal(result.stderr, 'synthetic failure'); assert.equal(result.cleanup.removed, true);
  assert.deepEqual(h.children[0].args.slice(h.children[0].args.indexOf('--entrypoint')), [
    '--entrypoint', '/usr/bin/env', PYTHON, '-i', 'HOME=/tmp', 'TMPDIR=/tmp', '/usr/local/bin/python', '-I', '-']);
});

test('actual container policy mismatch is rejected before untrusted stdin is supplied', async () => {
  for (const mutateContainer of [value => { value.HostConfig.NetworkMode = 'host'; },
    value => { value.HostConfig.ReadonlyRootfs = false; }, value => { value.HostConfig.SecurityOpt = ['seccomp=unconfined']; },
    value => { value.Mounts = [{ Type: 'bind', Source: 'C:\\secret', Destination: '/host' }]; },
    value => { value.HostConfig.Memory = 0; }, value => { value.Config.User = '0'; },
    value => { value.Config.Cmd = ['-c', 'unsafe shell']; }, value => { value.HostConfig.CapAdd = ['SYS_ADMIN']; },
    value => { value.HostConfig.PidMode = 'host'; }, value => { value.HostConfig.SecurityOpt.push('apparmor=unconfined'); },
    value => { value.HostConfig.IpcMode = 'host'; }, value => { value.HostConfig.CgroupnsMode = 'host'; },
    value => { value.HostConfig.Runtime = 'nvidia'; }, value => { value.HostConfig.UTSMode = 'host'; },
    value => { value.HostConfig.VolumesFrom = ['host-data']; }, value => { value.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; },
    value => { value.HostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: -1 }]; },
    value => { value.HostConfig.PublishAllPorts = true; }, value => { value.HostConfig.PortBindings = { '80/tcp': [{}] }; }]) {
    const h = harness({ mutateContainer });
    await assert.rejects(h.sandbox.run({ language: 'javascript', code: 'untrusted()' }), { code: 'sandbox_policy_mismatch' });
    assert.equal(h.children[0].input.length, 0);
    assert.equal(h.containers.size, 0);
    assert.ok(h.removals.length >= 2);
  }
});

test('timeout removes the named container and waits for independent cleanup', async () => {
  const h = harness({ onCode() {} });
  const result = await h.sandbox.run({ language: 'javascript', code: 'while(true){}', timeoutMs: 30 });
  assert.equal(result.ok, false); assert.equal(result.termination, 'timeout');
  assert.equal(result.cleanup.removed, true);
  assert.equal(h.containers.size, 0);
  assert.ok(h.children[0].kills.includes('SIGKILL'));
});

test('cancellation stops the container rather than merely its CLI and awaits removal', async () => {
  const controller = new AbortController();
  const h = harness({ onCode() {} });
  const running = h.sandbox.run({ language: 'python', code: 'while True: pass' }, { signal: controller.signal });
  await until(() => h.children[0]?.input.length);
  controller.abort(new Error('caller cancelled'));
  const result = await running;
  assert.equal(result.ok, false); assert.equal(result.termination, 'cancelled');
  assert.equal(result.cleanup.removed, true); assert.equal(h.containers.size, 0);
  assert.ok(h.removals.every(name => name === h.children[0].name));
});

test('combined output is capped at 32 KiB and overflow kills/removes the exact container', async () => {
  const h = harness({ onCode(child) { child.stdout.write(Buffer.alloc(10000, 97)); child.stderr.write(Buffer.alloc(40000, 98)); } });
  const result = await h.sandbox.run({ language: 'javascript', code: 'produceOutput()' });
  assert.equal(result.ok, false); assert.equal(result.termination, 'output_limit');
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 32768);
  assert.equal(result.cleanup.removed, true); assert.equal(h.containers.size, 0);
  const invalidUtf8 = harness({ onCode(child) { child.stdout.write(Buffer.alloc(40000, 255)); } });
  const encoded = await invalidUtf8.sandbox.run({ language: 'javascript', code: 'writeBytes()' });
  assert.ok(Buffer.byteLength(encoded.stdout) + Buffer.byteLength(encoded.stderr) <= 32768);
});

test('concurrency is bounded and a queued cancellation never launches a container', async () => {
  const h = harness({ onCode() {}, constructor: { maxConcurrent: 2 } });
  const one = h.sandbox.run({ language: 'javascript', code: 'one()' });
  const two = h.sandbox.run({ language: 'python', code: 'two()' });
  await until(() => h.children.length === 2 && h.children.every(child => child.input.length));
  const controller = new AbortController();
  const queued = h.sandbox.run({ language: 'javascript', code: 'never()' }, { signal: controller.signal });
  const cancelled = assert.rejects(queued, { code: 'cancelled' });
  controller.abort(); await cancelled;
  assert.equal(h.children.length, 2); assert.equal(h.peak, 2);
  h.finish(h.children[0]); h.finish(h.children[1]);
  assert.ok((await one).cleanup.removed); assert.ok((await two).cleanup.removed);
  assert.equal(h.children.length, 2);
});

test('late daemon creation after CLI cancellation is removed in the final cleanup pass', async () => {
  const controller = new AbortController();
  const h = harness({ creationDelay: 30, onSpawn() { setTimeout(() => controller.abort(), 5); } });
  await assert.rejects(h.sandbox.run({ language: 'javascript', code: 'neverSent()' }, { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(h.children[0].input.length, 0);
  assert.equal(h.containers.size, 0);
  assert.ok(h.removals.length >= 3);
});

test('unobserved creation cannot be called removed merely because early inspect checks say absent', async () => {
  const controller = new AbortController();
  const h = harness({ creationDelay: 500, onSpawn() { setTimeout(() => controller.abort(), 5); } });
  await assert.rejects(h.sandbox.run({ language: 'javascript', code: 'neverSent()' }, { signal: controller.signal }),
    { code: 'sandbox_cleanup_failed' });
  assert.equal((await h.sandbox.health()).available, false);
  assert.equal(h.children[0].input.length, 0);
  // A deliberately slow fake daemon completes after the cleanup deadline. It must
  // never have received a successful receipt; operator cleanup remains necessary.
  await delay(250);
  assert.equal(h.containers.size, 1);
  h.containers.clear();
});

test('unconfirmed cleanup quarantines the executor and never reports successful isolation', async () => {
  const h = harness({ cleanupFailure: true });
  await assert.rejects(h.sandbox.run({ language: 'javascript', code: '1' }), { code: 'sandbox_cleanup_failed' });
  const health = await h.sandbox.health();
  assert.equal(health.available, false); assert.match(health.reason, /cleanup|operator/);
  const launches = h.children.length;
  await assert.rejects(h.sandbox.run({ language: 'python', code: '1' }), { code: 'sandbox_unavailable' });
  assert.equal(h.children.length, launches);
});

test('invalid requests and pre-aborted calls never launch Docker code or invoke a host fallback', async () => {
  const h = harness();
  for (const request of [{ language: 'shell', code: 'echo host' }, { language: 'javascript', code: 'x', timeoutMs: 15001 },
    { language: 'python', code: 'x', timeoutMs: 0 }, { language: 'javascript', code: 'x'.repeat(65537) }]) {
    await assert.rejects(h.sandbox.run(request), { code: 'sandbox_invalid_request' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.sandbox.run({ language: 'javascript', code: '1' }, { signal: controller.signal }), { code: 'cancelled' });
  assert.equal(h.calls.length, 0); assert.equal(h.children.length, 0);
});

test('execution audit proves pre-cancelled and invalid requests acquired no resources', async () => {
  const h = harness(), controller = new AbortController();
  controller.abort(new Error('Owned pre-cancellation'));
  for (const [args, signal, expected] of [
    [{language: 'javascript', code: 'neverSubmitted()'}, controller.signal, 'cancelled'],
    [{language: 'shell', code: 'not-a-runtime'}, undefined, 'sandbox_invalid_request'],
  ]) {
    let observed;
    await assert.rejects(h.sandbox.run(args, {signal}), error => {observed = error; return error.code === expected;});
    assert.equal(observed.executionAudit.engine, 'docker');
    assert.equal(observed.executionAudit.dispatchAttempted, false);
    assert.equal(observed.executionAudit.codeMayHaveRun, false);
    assert.equal(observed.executionAudit.isolationVerified, false);
    assert.equal(observed.executionAudit.termination, 'not_started');
    assert.deepEqual(observed.executionAudit.cleanup, {confirmed: true, notCreated: true});
    assert.deepEqual(observed.executionAudit.proof, {isolation: 'docker-linux'});
    assert.equal(Object.isFrozen(observed.executionAudit), true);
    assert.equal(Object.isFrozen(observed.executionAudit.cleanup), true);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.children.length, 0); assert.equal(h.removals.length, 0);
});

test('execution audit for cancellation while acquiring capacity does not borrow the active run resource', async () => {
  const h = harness({onCode() {}, constructor: {maxConcurrent: 1}}), controller = new AbortController();
  const active = h.sandbox.run({language: 'javascript', code: 'ownedActive()'});
  active.catch(() => {});
  try {
    await until(() => h.children[0]?.input.length);
    const queued = h.sandbox.run({language: 'python', code: 'neverQueuedSource()'}, {signal: controller.signal});
    let observed;
    const rejected = assert.rejects(queued, error => {observed = error; return error.code === 'cancelled';});
    controller.abort(); await rejected;
    assert.equal(observed.executionAudit.dispatchAttempted, false);
    assert.equal(observed.executionAudit.codeMayHaveRun, false);
    assert.deepEqual(observed.executionAudit.cleanup, {confirmed: true, notCreated: true});
    assert.equal(observed.executionAudit.proof.name, undefined);
    assert.equal(h.children.length, 1); assert.equal(h.removals.length, 0);
    assert.equal(h.containers.has(h.children[0].name), true);
  } finally {
    if (h.children[0]) h.finish(h.children[0]);
    await active;
  }
});

test('execution audit distinguishes launched policy rejection from submitted source and confirms exact cleanup', async () => {
  const h = harness({mutateContainer(state) {state.HostConfig.NetworkMode = 'host';}});
  let observed;
  await assert.rejects(h.sandbox.run({language: 'javascript', code: 'neverSendThisSource()'}), error => {
    observed = error; return error.code === 'sandbox_policy_mismatch';
  });
  const audit = observed.executionAudit;
  assert.equal(audit.dispatchAttempted, true); assert.equal(audit.codeMayHaveRun, false);
  assert.equal(audit.isolationVerified, false); assert.equal(audit.termination, 'verification_failed');
  assert.equal(audit.cleanup.confirmed, true); assert.equal(audit.cleanup.removed, true); assert.equal(audit.cleanup.verifiedAbsent, true);
  assert.equal(audit.cleanup.name, h.children[0].name); assert.equal(audit.proof.name, h.children[0].name);
  assert.equal(audit.proof.image, JS); assert.equal(audit.proof.isolation, 'docker-linux');
  assert.equal(audit.proof.limits.memoryBytes, 268435456); assert.equal(Object.isFrozen(audit.proof.limits), true);
  assert.equal(h.children[0].input.length, 0); assert.equal(h.containers.size, 0);
  assert.ok(h.removals.every(name => name === audit.proof.name));
  assert.equal(JSON.stringify(audit).includes('neverSendThisSource'), false);
});

test('execution audit retains possible source execution and verified isolation when cleanup fails', async () => {
  const h = harness({cleanupFailure: true});
  let observed;
  await assert.rejects(h.sandbox.run({language: 'python', code: 'print("owned source")'}), error => {
    observed = error; return error.code === 'sandbox_cleanup_failed';
  });
  const audit = observed.executionAudit;
  assert.equal(audit.dispatchAttempted, true); assert.equal(audit.codeMayHaveRun, true);
  assert.equal(audit.isolationVerified, true); assert.equal(audit.exitCode, 0);
  assert.equal(audit.cleanup.confirmed, false); assert.notEqual(audit.cleanup.removed, true);
  assert.equal(audit.cleanup.name, h.children[0].name); assert.equal(audit.proof.image, PYTHON);
  assert.ok(h.children[0].input.length > 0);
  assert.equal((await h.sandbox.health()).available, false);
  assert.equal(Object.isFrozen(audit.cleanup), true);
  assert.equal(JSON.stringify(audit).includes('owned source'), false);
});

test('execution audit owns separate frozen facts when process seams reuse the same frozen Error', async () => {
  const foreignFacts = Object.freeze({owner: 'foreign'});
  const shared = Object.freeze(Object.assign(new Error('PRIVATE_REUSED_STREAM_ERROR'), {code: 'EPIPE', executionAudit: foreignFacts}));
  const before = harness();
  const after = harness({onSpawn(child) {child.stdin.end = () => {throw shared;};}});
  const beforeArgs = Object.defineProperty({language: 'javascript'}, 'code', {get() {throw shared;}});
  let first, second;
  await assert.rejects(before.sandbox.run(beforeArgs), error => {first = error; return error.code === 'EPIPE';});
  const firstSerialized = JSON.stringify(first.executionAudit);
  await assert.rejects(after.sandbox.run({language: 'python', code: 'after()'}), error => {second = error; return error.code === 'EPIPE';});
  assert.notEqual(first, shared); assert.notEqual(second, shared); assert.notEqual(first, second);
  assert.equal(first.cause, shared); assert.equal(second.cause, shared);
  assert.equal(Object.getOwnPropertyDescriptor(first, 'cause').enumerable, false);
  assert.equal(shared.executionAudit, foreignFacts);
  assert.equal(first.executionAudit.dispatchAttempted, false); assert.equal(first.executionAudit.codeMayHaveRun, false);
  assert.equal(second.executionAudit.dispatchAttempted, true); assert.equal(second.executionAudit.codeMayHaveRun, true);
  assert.equal(first.executionAudit.isolationVerified, false); assert.equal(second.executionAudit.isolationVerified, true);
  assert.equal(first.executionAudit.cleanup.confirmed, true); assert.equal(second.executionAudit.cleanup.confirmed, true);
  assert.deepEqual(first.executionAudit.cleanup, {confirmed: true, notCreated: true});
  assert.equal(before.calls.length, 0);
  assert.notEqual(first.executionAudit.proof.name, second.executionAudit.proof.name);
  assert.equal(JSON.stringify(first.executionAudit), firstSerialized);
  assert.equal(JSON.stringify(first).includes('PRIVATE_REUSED_STREAM_ERROR'), false);
  assert.equal(Object.isFrozen(first.executionAudit), true); assert.equal(Object.isFrozen(second.executionAudit), true);
});

test('a running inspect snapshot racing CLI exit cannot verify execution of source never submitted', async () => {
  let h;
  h = harness({mutateContainer(state) {
    Object.defineProperty(state, 'Name', {enumerable: true, get() {
      // A daemon snapshot can be running while the already-attached CLI observes
      // exit before that response reaches the caller. No code was sent yet.
      const child = h.children.at(-1); h.finish(child, 0); return '/' + child.name;
    }});
  }});
  let observed;
  await assert.rejects(h.sandbox.run({language: 'javascript', code: 'neverSubmittedSource()'}), error => {
    observed = error; return Boolean(error.executionAudit);
  });
  assert.equal(observed.code, 'sandbox_not_submitted');
  assert.equal(observed.executionAudit.dispatchAttempted, true);
  assert.equal(observed.executionAudit.codeMayHaveRun, false);
  assert.equal(observed.executionAudit.isolationVerified, true);
  assert.equal(observed.executionAudit.exitCode, 0);
  assert.equal(observed.executionAudit.cleanup.confirmed, true);
  assert.equal(h.children[0].input.length, 0); assert.equal(h.containers.size, 0);
});

const executionId = '679df78d-cf7c-456b-867e-532211c52bde';
test('resource binding commits before launch and verified running witness commits before source handoff',async()=>{
  const h=harness(),resources=[];
  const result=await h.sandbox.run({language:'javascript',code:'fixed payload'}, {executionId,onResource:resource=>{
    assert.equal(Object.isFrozen(resource),true);
    if(resource.containerId===undefined)assert.equal(h.children.length,0);
    else {assert.equal(h.children[0].input.length,0);assert.equal(resource.containerId,'c'.repeat(64));}
    resources.push(resource);
  }});
  assert.equal(resources.length,2);assert.equal(resources[0].name,'fraymus-code-'+executionId);
  assert.equal(resources[0].daemonId,'unit-test-daemon');assert.deepEqual(result.resource,resources[1]);
  const spawn=h.calls.find(call=>call.kind==='spawn');assert.equal(spawn.executable,DEFAULT_DOCKER_PATH);
  assert.equal(spawn.args[spawn.args.indexOf('--label')+1],EXECUTION_LABEL+'='+executionId);
  assert.equal(h.children[0].input.toString(),'fixed payload');
});

test('binding persistence failure launches nothing; witness persistence failure withholds source and still cleans the owned container',async()=>{
  for(const failWitness of [false,true]){
    const h=harness();let writes=0;
    await assert.rejects(h.sandbox.run({language:'javascript',code:'must not run'}, {executionId,onResource:()=>{
      writes++;if(!failWitness||writes===2)throw Object.assign(new Error('journal write failed'),{code:'journal_test_failed'});
    }}),error=>{
      assert.equal(error.code,'journal_test_failed');assert.equal(error.executionAudit.codeMayHaveRun,false);
      assert.equal(error.executionAudit.cleanup.confirmed,true);return true;
    });
    assert.equal(h.children.length,failWitness?1:0);if(failWitness)assert.equal(h.children[0].input.length,0);
    assert.equal(h.containers.size,0);
  }
});

test('async journal acknowledgements cannot authorize launch or source handoff',async()=>{
  for(const asyncWitness of [false,true]){
    const h=harness();let writes=0;
    await assert.rejects(h.sandbox.run({language:'javascript',code:'must not run'}, {executionId,onResource:()=>{
      if(!asyncWitness||++writes===2)return Promise.reject(new Error('late persistence failure'));
    }}),{code:'sandbox_resource_async'});
    assert.equal(h.children.length,asyncWitness?1:0);if(asyncWitness)assert.equal(h.children[0].input.length,0);
    assert.equal(h.containers.size,0);
  }
});

test('wrong execution label or absent exact container ID never yields a witness or source handoff',async()=>{
  for(const mutateContainer of [state=>{state.Config.Labels[EXECUTION_LABEL]='different';},state=>{delete state.Id;}]){
    const h=harness({mutateContainer}),resources=[];
    await assert.rejects(h.sandbox.run({language:'javascript',code:'must not run'}, {executionId,onResource:resource=>resources.push(resource)}),{code:'sandbox_policy_mismatch'});
    assert.equal(resources.length,1);assert.equal(resources[0].containerId,undefined);assert.equal(h.children[0].input.length,0);
    assert.equal(h.containers.size,0);
  }
});

test('invalid execution identity and unavailable daemon identity fail before container creation',async()=>{
  const h=harness();await assert.rejects(h.sandbox.run({language:'python',code:'fixed'}, {executionId:'bad',onResource:()=>{}}),{code:'code_resource_invalid'});assert.equal(h.children.length,0);
  const noDaemon=harness({engine:{ID:null}});assert.equal((await noDaemon.sandbox.health()).available,false);
  await assert.rejects(noDaemon.sandbox.run({language:'python',code:'fixed'}),{code:'sandbox_unavailable'});assert.equal(noDaemon.children.length,0);
});

test('an engine switch after binding cannot attribute a running witness to the old daemon or submit source',async()=>{
  const h=harness(),resources=[];
  await assert.rejects(h.sandbox.run({language:'javascript',code:'must not run'},{executionId,onResource:value=>{
    resources.push(value);if(resources.length===1)h.engine.ID='changed-daemon';
  }}),{code:'sandbox_resource_daemon'});
  assert.equal(resources.length,1);assert.equal(resources[0].containerId,undefined);
  assert.equal(h.children[0].input.length,0);assert.equal(h.containers.size,0);
});
