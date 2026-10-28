import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_DOCKER_PATH, dockerResourceIdentity, localDockerEndpoint } from './resource-identity.js';
const exec = promisify(execFile);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Trusted operator seam: observe only. Never create/start/stop/remove containers.
 * Historical verified-running identity is mandatory; 404s cannot establish that
 * a never-observed delayed create request has finished. */
export function createDockerCleanupObserver({ dockerPath = DEFAULT_DOCKER_PATH,
  dockerHost = process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock',
  execFileImpl = exec } = {}) {
  const endpoint = localDockerEndpoint(dockerHost);
  if(typeof dockerPath!=='string'||!dockerPath||dockerPath.length>4096||dockerPath.includes('\0'))throw new TypeError('Invalid trusted Docker executable');
  const config = path.join(os.tmpdir(), 'fraymus-observe-docker-' + randomUUID());
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[key] ?? (key === 'PATH' ? process.env.Path : undefined);
    if (typeof value === 'string') env[key] = value;
  }
  const command = (args, signal) => execFileImpl(dockerPath, ['--host', endpoint, '--config', config, ...args], {
    timeout: 2000, maxBuffer: 128 * 1024, encoding: 'utf8', shell: false, windowsHide: true,
    env: { ...env }, killSignal: 'SIGKILL', signal
  });
  function conclusivelyMissing(error, reference) {
    if (error?.code !== 1 || error.killed || error.signal || typeof error.stderr !== 'string'
      || typeof error.stdout !== 'string' || error.stdout.trim() !== '') return false;
    const text = error.stderr.trim();
    return text === 'Error: No such object: ' + reference
      || text === 'Error response from daemon: No such container: ' + reference
      || text === 'Error: No such container: ' + reference;
  }
  return async function observe(input, { signal } = {}) {
    const resource = dockerResourceIdentity(input, input?.executionId, { witnessed: true });
    if (resource.endpoint !== endpoint) fail('code_resource_endpoint', 'Recorded resource belongs to a different local endpoint');
    async function sameDaemon() {
      signal?.throwIfAborted();
      let response;
      try { response = JSON.parse((await command(['info', '--format', '{{json .}}'], signal)).stdout); }
      catch { fail('code_reconcile_unavailable', 'The local engine identity could not be verified'); }
      if (response?.OSType !== 'linux' || response.ID !== resource.daemonId) fail('code_resource_daemon', 'The local engine differs from the recorded resource owner');
    }
    await sameDaemon();
    for (let check = 0; check < 2; check++) {
      for (const reference of [resource.containerId, resource.name]) {
        signal?.throwIfAborted();
        try { await command(['container', 'inspect', '--format', '{{json .}}', reference], signal); }
        catch (error) {
          if (conclusivelyMissing(error, reference)) continue;
          fail('code_reconcile_unavailable', 'Exact container absence could not be verified');
        }
        fail('code_resource_present', 'The recorded container ID or name still exists; no resource was changed');
      }
    }
    await sameDaemon();
    signal?.throwIfAborted();
    return Object.freeze({ confirmed: true, endpoint, daemonId: resource.daemonId, name: resource.name,
      containerId: resource.containerId, checks: 2, observedAt: Date.now() });
  };
}
