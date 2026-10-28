import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';

const exec = promisify(execFile);
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
export const OFFICIAL_SANDBOX_IMAGES = Object.freeze({
  javascript: 'docker.io/library/node:24-bookworm-slim',
  python: 'docker.io/library/python:3.12-slim-bookworm',
});
const error = (code, message) => Object.assign(new Error(message), { code });
function sourceDigests(image, language) {
  const repository = language === 'javascript' ? 'node' : 'python';
  const pattern = new RegExp(`^(?:(?:docker\\.io|index\\.docker\\.io)/)?(?:library/)?${repository}@sha256:[a-f0-9]{64}$`);
  return [...new Set((Array.isArray(image?.RepoDigests) ? image.RepoDigests : []).filter(value => typeof value === 'string' && pattern.test(value)))];
}
function atomicSave(directory, record) {
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'sandbox-images.json');
  const temporary = join(directory, `.sandbox-images-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, target);
    return target;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}

/** Explicit operator setup, never called by agent execution or health requests.
 * Injected process seams are for mocked tests; the public CLI accepts no image/host overrides.
 */
export async function setupSandbox({ execFileImpl = exec, platform = process.platform,
  env = process.env, dataDir = DATA_DIR,
  dockerPath = platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker' } = {}) {
  const endpoint = platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock';
  const temporaryBase = realpathSync(tmpdir());
  const configDir = mkdtempSync(join(temporaryBase, 'fraymus-operator-docker-'));
  // A nonempty anonymous auth map prevents Docker's empty-config path from
  // auto-selecting a default OS credential store for the public registry.
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({ auths: { 'https://index.docker.io/v1/': {} } }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const cliEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = env[name] ?? (name === 'PATH' ? env.Path : undefined);
    if (typeof value === 'string') cliEnv[name] = value;
  }
  const globalArgs = ['--host', endpoint, '--config', configDir];
  const command = async (args, timeout, code, message) => {
    try {
      const result = await execFileImpl(dockerPath, [...globalArgs, ...args], {
        timeout, maxBuffer: 256 * 1024, encoding: 'utf8', shell: false,
        windowsHide: true, killSignal: 'SIGKILL', env: { ...cliEnv },
      });
      return result.stdout;
    } catch { throw error(code, message); }
  };
  try {
    const information = await command(['info', '--format', '{{json .}}'], 10000,
      'sandbox_engine_unavailable', 'Cannot reach the pinned local Docker Linux engine. Start Docker Desktop and verify firmware virtualization/WSL2; no images were pulled.');
    let engine;
    try { engine = JSON.parse(information); if (!engine || typeof engine !== 'object' || Array.isArray(engine)) throw new Error('Invalid engine object'); } catch { throw error('sandbox_engine_invalid', 'Docker returned invalid engine information; no images were pulled.'); }
    if (engine.OSType !== 'linux') throw error('sandbox_linux_required', 'A local Linux Docker engine is required; no images were pulled.');
    if (!Array.isArray(engine.SecurityOptions) || !engine.SecurityOptions.includes('name=seccomp,profile=builtin')) throw error('sandbox_seccomp_required', 'The engine must report the built-in default seccomp profile; no images were pulled.');
    const images = {}, sourceRepoDigests = {};
    for (const [language, reference] of Object.entries(OFFICIAL_SANDBOX_IMAGES)) {
      await command(['pull', reference], 300000, 'sandbox_pull_failed', `Could not pull the official ${language} runtime. Existing sandbox configuration was not changed.`);
      const inspection = await command(['image', 'inspect', '--format', '{{json .}}', reference], 10000,
        'sandbox_image_inspection_failed', `Could not inspect the pulled ${language} runtime. Existing configuration was not changed.`);
      let image;
      try { image = JSON.parse(inspection); } catch { throw error('sandbox_image_invalid', 'Docker returned invalid image information; configuration was not changed.'); }
      const digests = sourceDigests(image, language);
      if (!image || !IMAGE_ID.test(image.Id) || image.Os !== 'linux' || !image.Config || typeof image.Config !== 'object'
        || (image.Config.Volumes && (typeof image.Config.Volumes !== 'object' || Array.isArray(image.Config.Volumes) || Object.keys(image.Config.Volumes).length)) || !digests.length) {
        throw error('sandbox_image_invalid', `The ${language} image must have an immutable Linux ID, an official repository digest, and no declared volumes; configuration was not changed.`);
      }
      images[language] = image.Id; sourceRepoDigests[language] = digests;
    }
    const record = { version: 1, createdAt: new Date().toISOString(), images,
      sourceImages: { ...OFFICIAL_SANDBOX_IMAGES }, sourceRepoDigests,
      engine: { os: 'linux', version: String(engine.ServerVersion || 'unknown').replace(/[\x00-\x1f]/g, '').slice(0, 80), seccomp: 'builtin-default' } };
    const configurationPath = atomicSave(dataDir, record);
    return { configurationPath, record, nextStep: 'Restart Chandra. Verify sandbox availability, then run the container isolation integration checks before relying on unattended execution.' };
  } finally {
    const target = realpathSync(configDir);
    if (dirname(target) !== temporaryBase || !basename(target).startsWith('fraymus-operator-docker-')) throw error('sandbox_cleanup_path', 'Refusing cleanup outside the operator temporary directory');
    rmSync(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log('Usage: node server/sandbox/setup.js\nOperator-only: pull the fixed official Node/Python runtimes into the pinned local Linux Docker engine and atomically save immutable image IDs.');
    else { console.error('Usage: node server/sandbox/setup.js (no image, endpoint, credential, or execution-mode arguments are accepted)'); process.exitCode = 1; }
  } else {
    try { console.log(JSON.stringify(await setupSandbox(), null, 2)); }
    catch (failure) { console.error(`${failure.code || 'sandbox_setup_failed'}: ${failure.message}`); process.exitCode = 1; }
  }
}
