import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configuredCodeExecutor } from '../server/sandbox/config.js';
import { setupSandbox, OFFICIAL_SANDBOX_IMAGES } from '../server/sandbox/setup.js';

const images = { javascript: 'sha256:' + 'a'.repeat(64), python: 'sha256:' + 'b'.repeat(64) };
const engine = { OSType: 'linux', SecurityOptions: ['name=seccomp,profile=builtin'], ServerVersion: 'test-version' };
function inspection(language, extra = {}) {
  return { Id: images[language], Os: 'linux', Config: { Volumes: null }, RepoDigests: [`${language === 'javascript' ? 'node' : 'docker.io/library/python'}@sha256:${'c'.repeat(64)}`], ...extra };
}
async function directory(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fraymus-sandbox-config-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return folder;
}
function dockerMock({ information = engine, nodeImage = inspection('javascript'), pythonImage = inspection('python'), failPull } = {}) {
  const calls = [];
  return { calls, execute: async (file, args, options) => {
    calls.push({ file, args, options });
    assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.encoding, 'utf8');
    assert.ok(options.timeout > 0 && options.timeout <= 300000); assert.equal(options.maxBuffer, 256 * 1024);
    assert.deepEqual(args.slice(0, 3), ['--host', 'npipe:////./pipe/dockerDesktopLinuxEngine', '--config']);
    assert.ok(!Object.keys(options.env).some(key => key.startsWith('DOCKER_')));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(args[3], 'config.json'), 'utf8')), { auths: { 'https://index.docker.io/v1/': {} } });
    const command = args.slice(4);
    if (command[0] === 'info') return { stdout: typeof information === 'string' ? information : JSON.stringify(information), stderr: '' };
    if (command[0] === 'pull') {
      assert.ok(Object.values(OFFICIAL_SANDBOX_IMAGES).includes(command[1]));
      if (failPull === command[1]) throw new Error('DOCKER_AUTH_CONFIG=SECRET_MUST_NOT_LEAK');
      return { stdout: 'Pulled official fixture image', stderr: '' };
    }
    assert.deepEqual(command.slice(0, 4), ['image', 'inspect', '--format', '{{json .}}']);
    const image = command[4] === OFFICIAL_SANDBOX_IMAGES.javascript ? nodeImage : pythonImage;
    return { stdout: JSON.stringify(image), stderr: '' };
  } };
}

test('default missing/invalid records fail closed to trusted unavailable Docker without host execution', async () => {
  let constructed = 0;
  const construct = () => { constructed++; throw new Error('must not construct invalid images'); };
  const missing = configuredCodeExecutor({ env: {}, readFileImpl: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }, createSandbox: construct });
  assert.equal(missing.kind, 'docker'); assert.equal((await missing.health()).available, false); assert.match((await missing.health()).reason, /missing/i);
  await assert.rejects(missing.run({}), { code: 'sandbox_unavailable' });
  for (const text of ['{broken', 'null', '[]', '{}', JSON.stringify({ images: { javascript: 'node:latest', python: images.python } }), 'x'.repeat(65537)]) {
    const executor = configuredCodeExecutor({ env: {}, readFileImpl: () => text, createSandbox: construct });
    assert.equal(executor.kind, 'docker'); assert.equal((await executor.health()).available, false);
  }
  assert.equal(constructed, 0);
});

test('loader supports dataDir and image maps but ignores stored endpoints, commands and credentials', async t => {
  const folder = await directory(t); let captured;
  const expected = { kind: 'docker', health: async () => ({ available: true }), run: async () => ({}) };
  for (const record of [images, { images, dockerHost: 'tcp://evil.example', dockerPath: 'evil-command', credentials: 'DO_NOT_USE', maxConcurrent: 99 }]) {
    await fs.writeFile(path.join(folder, 'sandbox-images.json'), JSON.stringify(record));
    const executor = configuredCodeExecutor({ dataDir: folder, env: {}, createSandbox: options => { captured = options; return expected; } });
    assert.equal(executor, expected); assert.deepEqual(captured, { images });
  }
  await fs.writeFile(path.join(folder, 'sandbox-images.json'), 'x'.repeat(65537));
  assert.equal((await configuredCodeExecutor({ env: {}, dataDir: folder }).health()).available, false);
});

test('only both explicit host flags select legacy host mode; other modes keep code disabled', async () => {
  const failRead = () => { throw new Error('must not read a config for rejected/host modes'); };
  assert.equal(configuredCodeExecutor({ env: { FRAYMUS_CODE_EXECUTION: 'host', FRAYMUS_ALLOW_HOST_CODE: '1' }, readFileImpl: failRead }), undefined);
  for (const env of [{ FRAYMUS_CODE_EXECUTION: 'host' }, { FRAYMUS_CODE_EXECUTION: 'host', FRAYMUS_ALLOW_HOST_CODE: 'true' }, { FRAYMUS_CODE_EXECUTION: 'remote' }, { FRAYMUS_CODE_EXECUTION: 'DOCKER' }]) {
    const executor = configuredCodeExecutor({ env, readFileImpl: failRead });
    assert.equal(executor.kind, 'docker'); assert.equal((await executor.health()).available, false);
  }
  const stillDocker = configuredCodeExecutor({ env: { FRAYMUS_ALLOW_HOST_CODE: '1' }, readFileImpl: () => JSON.stringify(images), createSandbox: options => ({ kind: 'docker', images: options.images }) });
  assert.equal(stillDocker.kind, 'docker');
});

test('operator setup pins a local endpoint, pulls only fixed official refs and atomically saves immutable IDs', async t => {
  const folder = await directory(t), mock = dockerMock();
  const result = await setupSandbox({ dataDir: folder, platform: 'win32', env: { PATH: 'fixture-path', DOCKER_HOST: 'tcp://evil.example', DOCKER_CONTEXT: 'remote', DOCKER_AUTH_CONFIG: 'SECRET_MUST_NOT_LEAK' }, execFileImpl: mock.execute });
  assert.equal(mock.calls.length, 5); assert.equal(mock.calls[0].file, 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe');
  assert.deepEqual(mock.calls.filter(call => call.args[4] === 'pull').map(call => call.args[5]), Object.values(OFFICIAL_SANDBOX_IMAGES));
  const record = JSON.parse(await fs.readFile(result.configurationPath, 'utf8'));
  assert.deepEqual(record.images, images); assert.deepEqual(record.sourceImages, OFFICIAL_SANDBOX_IMAGES); assert.equal(record.engine.os, 'linux');
  assert.ok(record.sourceRepoDigests.javascript[0].startsWith('node@sha256:')); assert.ok(record.sourceRepoDigests.python[0].startsWith('docker.io/library/python@sha256:'));
  assert.ok(!JSON.stringify(record).includes('SECRET')); assert.ok(!JSON.stringify(record).includes('DOCKER_HOST'));
  assert.deepEqual(await fs.readdir(folder), ['sandbox-images.json']);
  await assert.rejects(fs.access(mock.calls[0].args[3]), { code: 'ENOENT' });
});

test('failed Linux/seccomp/engine preflight pulls nothing and preserves existing configuration', async t => {
  for (const [information, code] of [[{ ...engine, OSType: 'windows' }, 'sandbox_linux_required'], [{ ...engine, SecurityOptions: [] }, 'sandbox_seccomp_required'], ['{bad', 'sandbox_engine_invalid'], ['null', 'sandbox_engine_invalid']]) {
    const folder = await directory(t), mock = dockerMock({ information });
    await fs.writeFile(path.join(folder, 'sandbox-images.json'), 'previous-configuration');
    await assert.rejects(setupSandbox({ dataDir: folder, platform: 'win32', env: {}, execFileImpl: mock.execute }), { code });
    assert.equal(mock.calls.length, 1); assert.equal(await fs.readFile(path.join(folder, 'sandbox-images.json'), 'utf8'), 'previous-configuration');
  }
  const folder = await directory(t);
  await assert.rejects(setupSandbox({ dataDir: folder, platform: 'win32', env: {}, execFileImpl: async () => { throw new Error('Credential SECRET_MUST_NOT_LEAK'); } }), error => error.code === 'sandbox_engine_unavailable' && !error.message.includes('SECRET'));
  assert.deepEqual(await fs.readdir(folder), []);
});

test('image inspection rejects mutable/non-Linux/volume/foreign-repository images without saving config', async t => {
  for (const nodeImage of [null, inspection('javascript', { Id: 'node:latest' }), inspection('javascript', { Os: 'windows' }), inspection('javascript', { Config: { Volumes: { '/data': {} } } }), inspection('javascript', { RepoDigests: [`evil.example/node@sha256:${'c'.repeat(64)}`] })]) {
    const folder = await directory(t), mock = dockerMock({ nodeImage });
    await assert.rejects(setupSandbox({ dataDir: folder, platform: 'win32', env: {}, execFileImpl: mock.execute }), { code: 'sandbox_image_invalid' });
    assert.equal(mock.calls.filter(call => call.args[4] === 'pull').length, 1); assert.deepEqual(await fs.readdir(folder), []);
  }
});

test('second pull failure preserves the previous record and never reports credential-bearing process errors', async t => {
  const folder = await directory(t), mock = dockerMock({ failPull: OFFICIAL_SANDBOX_IMAGES.python });
  const target = path.join(folder, 'sandbox-images.json'); await fs.writeFile(target, JSON.stringify({ previous: true }));
  await assert.rejects(setupSandbox({ dataDir: folder, platform: 'win32', env: {}, execFileImpl: mock.execute }), error => error.code === 'sandbox_pull_failed' && !error.message.includes('SECRET'));
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { previous: true }); assert.deepEqual(await fs.readdir(folder), ['sandbox-images.json']);
});

test('non-Windows setup pins the Unix socket even when ambient Docker variables select a remote host', async t => {
  const folder = await directory(t); const base = dockerMock();
  await setupSandbox({ dataDir: folder, platform: 'linux', env: { DOCKER_HOST: 'tcp://evil.example', DOCKER_CONTEXT: 'remote' }, execFileImpl: async (file, args, options) => {
    assert.equal(file, 'docker'); assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
    const converted = [...args]; converted[1] = 'npipe:////./pipe/dockerDesktopLinuxEngine';
    return base.execute(file, converted, options);
  } });
  assert.equal(base.calls.length, 5);
});
