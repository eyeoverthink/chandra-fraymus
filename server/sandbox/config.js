import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../config.js';
import { createDockerSandbox } from './docker.js';

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
function readConfiguration(file) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid sandbox image configuration size');
    const buffer = Buffer.alloc(65537); let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > 65536) throw new Error('Sandbox image configuration grew beyond its bound');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}
function unavailable(reason, reasonCode) {
  return Object.freeze({
    kind: 'docker',
    health: async () => ({ kind: 'docker', mode: 'docker-linux', engine: 'docker', isolation: 'docker-linux', available: false, network: false, hostMounts: false, reason, reasonCode }),
    run: async () => { throw Object.assign(new Error(reason), { code: 'sandbox_unavailable' }); },
  });
}

/** Server-only mode selection. Never pull images or select a remote engine here.
 * Test seams are trusted construction options, not run/HTTP/model parameters.
 */
export function configuredCodeExecutor({ env = process.env, dataDir = DATA_DIR,
  readFileImpl = readConfiguration, createSandbox = createDockerSandbox } = {}) {
  const mode = env.FRAYMUS_CODE_EXECUTION || 'docker';
  if (mode === 'host' && env.FRAYMUS_ALLOW_HOST_CODE === '1') return undefined;
  if (mode === 'host') return unavailable('Host execution is disabled without FRAYMUS_ALLOW_HOST_CODE=1. Docker fallback to the host is never automatic.', 'sandbox_host_not_authorized');
  if (mode !== 'docker') return unavailable('Unsupported code execution mode. Use docker, or explicitly authorize approved host execution.', 'sandbox_mode_invalid');
  let text;
  try { text = readFileImpl(join(dataDir, 'sandbox-images.json')); }
  catch (error) {
    return error.code === 'ENOENT'
      ? unavailable('Sandbox image configuration is missing. An operator must run node server/sandbox/setup.js after Docker Linux is available.', 'sandbox_config_missing')
      : unavailable('Sandbox image configuration could not be read safely. Code execution remains disabled.', 'sandbox_config_invalid');
  }
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) throw new Error('Invalid configuration');
    const record = JSON.parse(text);
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid configuration');
    const images = record.images || record;
    if (!images || typeof images !== 'object' || !['javascript', 'python'].every(language => typeof images[language] === 'string' && IMAGE_ID.test(images[language]))) throw new Error('Immutable image IDs are required');
    // Deliberately ignore stored command paths, endpoint overrides, credentials and flags.
    return createSandbox({ images: { javascript: images.javascript, python: images.python } });
  } catch {
    return unavailable('Sandbox image configuration is invalid. Both runtimes require immutable sha256 image IDs; rerun the operator setup.', 'sandbox_config_invalid');
  }
}
