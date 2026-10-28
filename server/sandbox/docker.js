import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_DOCKER_PATH, EXECUTION_LABEL, dockerResourceIdentity, localDockerEndpoint } from './resource-identity.js';

const exec = promisify(execFile);
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const MEMORY = 256 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024;
const MAX_TIMEOUT = 15000;
const MAX_CODE = 64 * 1024;
const TMPFS = 'rw,nosuid,nodev,noexec,size=16m,mode=1777';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function localEndpoint(value) {
  return localDockerEndpoint(value);
}
function minimalEnvironment() {
  const result = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) {
    const value = process.env[name] ?? (name === 'PATH' ? process.env.Path : undefined);
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}
function utf8Prefix(bytes, limit) {
  // Replacement of invalid UTF-8 must not expand the returned strings beyond the cap.
  const normalized = Buffer.from(bytes.toString('utf8'), 'utf8');
  return new TextDecoder().decode(normalized.subarray(0, limit), { stream: true });
}

/** Linux Docker sandbox only; no host fallback, image pulls, shell, or workspace mounts.
 * spawnImpl/execFileImpl are process seams for tests and trusted server construction.
 * The CLI is pinned to a local engine and an empty, nonexistent config directory;
 * registry credentials and ambient DOCKER_HOST/DOCKER_CONTEXT never select a destination.
 */
export function createDockerSandbox({ dockerPath = DEFAULT_DOCKER_PATH, images = {}, maxConcurrent = 2,
  dockerHost = process.platform === 'win32' ? 'npipe:////./pipe/dockerDesktopLinuxEngine' : 'unix:///var/run/docker.sock',
  spawnImpl = spawn, execFileImpl = exec, cleanupTimeoutMs = 5000 } = {}) {
  if (typeof dockerPath !== 'string' || !dockerPath || dockerPath.length > 4096 || dockerPath.includes('\0')) throw new TypeError('Invalid Docker executable');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 8) throw new TypeError('Docker concurrency must be 1 through 8');
  if (!Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 50 || cleanupTimeoutMs > 5000) throw new TypeError('Invalid bounded cleanup timeout');
  const host = localEndpoint(dockerHost);
  const imageMap = Object.freeze({ javascript: images?.javascript, python: images?.python });
  const configDir = path.join(os.tmpdir(), 'fraymus-empty-docker-config-' + randomUUID());
  const globalArgs = Object.freeze(['--host', host, '--config', configDir]);
  const cliEnv = Object.freeze(minimalEnvironment());
  const limits = Object.freeze({ timeoutMs: MAX_TIMEOUT, maxOutputBytes: MAX_OUTPUT,
    maxCodeBytes: MAX_CODE, memoryBytes: MEMORY, pids: 64, cpus: 1,
    tmpfsBytes: 16 * 1024 * 1024, maxConcurrent, cleanupTimeoutMs });
  const baseHealth = { kind: 'docker', mode: 'docker-linux', engine: 'docker',
    isolation: 'docker-linux', network: false, hostMounts: false,
    image: imageMap, images: imageMap, limits };
  let active = 0, healthPending;
  const queue = [], quarantined = new Set();

  async function command(args, timeout = 3000) {
    return execFileImpl(dockerPath, [...globalArgs, ...args], {
      encoding: 'utf8', timeout, maxBuffer: 128 * 1024,
      windowsHide: true, shell: false, killSignal: 'SIGKILL', env: { ...cliEnv },
    });
  }
  function unavailable(reason) { return { ...baseHealth, available: false, reason }; }
  async function health() {
    if (quarantined.size) return unavailable(`Container cleanup is unconfirmed (${[...quarantined].join(', ')}); operator cleanup and executor restart are required`);
    if (!Object.values(imageMap).every(id => typeof id === 'string' && IMAGE_ID.test(id))) {
      return unavailable('Both runtime images must be configured as immutable sha256 image IDs');
    }
    if (healthPending) return healthPending;
    healthPending = (async () => {
      try {
        const ids = [...new Set(Object.values(imageMap))];
        const [information, inspected] = await Promise.all([
          command(['info', '--format', '{{json .}}']),
          command(['image', 'inspect', '--format', '{{json .}}', ...ids]),
        ]);
        const engine = JSON.parse(information.stdout);
        if (engine.OSType !== 'linux') return unavailable('A Linux Docker engine is required');
        if (typeof engine.ID !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(engine.ID)) return unavailable('A stable local Docker daemon identity is required');
        if (engine.MemoryLimit !== true || engine.SwapLimit !== true || engine.PidsLimit !== true
            || (engine.CpuCfsQuota !== true && engine.CPUCfsQuota !== true)) {
          return unavailable('The Linux engine must support memory, swap, PID, and CPU quota limits');
        }
        if (!engine.Runtimes || !Object.hasOwn(engine.Runtimes, 'runc')) return unavailable('The Linux runc runtime is required');
        if (!Array.isArray(engine.SecurityOptions)
            || !engine.SecurityOptions.some(option => option === 'name=seccomp,profile=builtin')) {
          return unavailable('The Linux engine must report its built-in default seccomp profile');
        }
        const found = String(inspected.stdout).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        if (found.length !== ids.length || ids.some(id => !found.some(image => image.Id === id && image.Os === 'linux'))) {
          return unavailable('Configured immutable Linux images are not installed locally');
        }
        if (found.some(image => image.Config?.Volumes && Object.keys(image.Config.Volumes).length)) {
          return unavailable('Runtime images declaring implicit writable volumes are not allowed');
        }
        if (quarantined.size) return unavailable('Container cleanup is unconfirmed; executor restart is required');
        return { ...baseHealth, available: true, engineId: engine.ID, engineVersion: String(engine.ServerVersion || 'unknown').slice(0, 80),
          seccomp: 'builtin-default', languages: ['javascript', 'python'] };
      } catch { return unavailable('Local Docker engine or immutable runtime images are unavailable'); }
    })();
    try { return await healthPending; }
    finally { healthPending = undefined; }
  }

  async function acquire(signal) {
    if (signal?.aborted) throw failure('cancelled', 'Sandbox execution was cancelled before it started');
    if (active < maxConcurrent) { active++; return; }
    if (queue.length >= 32) throw failure('sandbox_busy', 'Sandbox queue is full');
    await new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal?.removeEventListener('abort', aborted); resolve(); } };
      const aborted = () => {
        const index = queue.indexOf(entry);
        if (index >= 0) queue.splice(index, 1);
        reject(failure('cancelled', 'Queued sandbox execution was cancelled'));
      };
      signal?.addEventListener('abort', aborted, { once: true });
      queue.push(entry);
    });
  }
  function release() {
    const next = queue.shift();
    if (next) next.resolve();
    else active--;
  }
  function absent(error, name) {
    const text = `${error?.stderr || ''}\n${error?.message || ''}`;
    return text.includes(name) && /No such (?:container|object)\b/i.test(text);
  }
  async function remove(name, timeout) {
    try {
      const result = await command(['rm', '-f', '--', name], timeout);
      return String(result.stdout || '').trim().split(/\r?\n/).includes(name);
    } catch (error) { if (!absent(error, name)) throw error; return false; }
  }
  async function confirmAbsent(name, timeout) {
    try { await command(['container', 'inspect', '--format', '{{json .}}', name], timeout); return false; }
    catch (error) { if (absent(error, name)) return true; throw error; }
  }
  async function cleanup(name, initial, cliClosed, creation) {
    const deadline = Date.now() + cleanupTimeoutMs;
    if (initial && await initial.catch(() => false)) creation.observed = true;
    let passes = 0;
    while (Date.now() < deadline) {
      const remaining = Math.max(1, Math.min(1000, deadline - Date.now()));
      try {
        if (await remove(name, remaining)) creation.observed = true;
        if (await confirmAbsent(name, Math.max(1, Math.min(1000, deadline - Date.now())))) {
          if (++passes >= 2 && cliClosed && creation.observed) return { removed: true, name, verifiedAbsent: true };
        } else passes = 0;
      } catch { passes = 0; }
      await delay(Math.min(100, Math.max(0, deadline - Date.now())));
    }
    quarantined.add(name);
    throw failure('sandbox_cleanup_failed', 'Container cleanup could not be confirmed; sandbox disabled until operator cleanup and executor restart');
  }

  function verifyContainer(container, name, image, runtime, executionId) {
    const h = container.HostConfig, c = container.Config, options = h?.SecurityOpt;
    const temp = h?.Tmpfs?.['/tmp'];
    const tempOptions = typeof temp === 'string' ? new Set(temp.split(',')) : new Set();
    const noMounts = (!h?.Binds || h.Binds.length === 0) && (!h?.Mounts || h.Mounts.length === 0)
      && (!h?.VolumesFrom || h.VolumesFrom.length === 0)
      && (!c?.Volumes || Object.keys(c.Volumes).length === 0)
      && Array.isArray(container.Mounts)
      && container.Mounts.every(mount => mount.Type === 'tmpfs' && mount.Destination === '/tmp');
    if (container.Name !== '/' + name || container.Image !== image || container.State?.Running !== true
        || executionId && (c?.Labels?.[EXECUTION_LABEL] !== executionId || typeof container.Id !== 'string' || !/^[a-f0-9]{64}$/.test(container.Id))
        || c?.User !== '65534:65534' || c?.WorkingDir !== '/tmp' || !h?.ReadonlyRootfs
        || JSON.stringify(c?.Entrypoint) !== JSON.stringify(['/usr/bin/env'])
        || JSON.stringify(c?.Cmd) !== JSON.stringify(['-i', 'HOME=/tmp', 'TMPDIR=/tmp', ...runtime])
        || h?.Privileged !== false || h?.NetworkMode !== 'none' || !noMounts
        || h.Memory !== MEMORY || h.MemorySwap !== MEMORY || h.NanoCpus !== 1_000_000_000
        || h.PidsLimit !== 64 || !Array.isArray(h.CapDrop) || !h.CapDrop.some(value => value.toUpperCase() === 'ALL')
        || (h.CapAdd && h.CapAdd.length) || (h.Devices && h.Devices.length) || (h.DeviceRequests && h.DeviceRequests.length)
        || (h.DeviceCgroupRules && h.DeviceCgroupRules.length)
        || h.PidMode !== 'private' || h.IpcMode !== 'none' || h.CgroupnsMode !== 'private' || h.Runtime !== 'runc'
        || !['', 'private', undefined].includes(h.UTSMode) || h.UsernsMode === 'host'
        || h.PublishAllPorts !== false || (h.PortBindings && Object.keys(h.PortBindings).length)
        || !Array.isArray(options) || !options.some(value => /^no-new-privileges(?:=true)?$/.test(value))
        || !options.every(value => /^no-new-privileges(?:=true)?$/.test(value)) || h.LogConfig?.Type !== 'none'
        || !['rw', 'nosuid', 'nodev', 'noexec', 'mode=1777'].every(value => tempOptions.has(value))
        || !(tempOptions.has('size=16m') || tempOptions.has('size=16777216'))
        || Object.keys(h.Tmpfs || {}).length !== 1) {
      throw failure('sandbox_policy_mismatch', 'Docker did not apply the required container isolation policy');
    }
  }

  async function runOwned({ language, code, timeoutMs = 5000 } = {}, { signal,lifecycle,executionId,onResource } = {}) {
    if (!['javascript', 'python'].includes(language) || typeof code !== 'string' || Buffer.byteLength(code) > MAX_CODE
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) {
      throw failure('sandbox_invalid_request', 'Provide supported code up to 64 KiB and a timeout from 1 through 15000 ms');
    }
    await acquire(signal);
    let child, closeTimer, timer, initialRemoval, stopReason, exitCode = null, cliClosed = false, verified = false;
    let captured = 0, rejected, removal;
    const stdout = [], stderr = [];
    const name = 'fraymus-code-' + (executionId ?? randomUUID());
    lifecycle.name=name;lifecycle.language=language;lifecycle.image=imageMap[language];lifecycle.limits={...limits,timeoutMs};
    const creation = { observed: false };
    const image = imageMap[language];
    const recordResource = value => {
      const result = onResource(value);
      if(result&&typeof result.then==='function'){
        Promise.resolve(result).catch(()=>{});
        throw failure('sandbox_resource_async','Resource journal acknowledgements must commit synchronously');
      }
    };
    let closeResolve;
    const closed = new Promise(resolve => { closeResolve = resolve; });
    const stop = reason => {
      if (!stopReason) stopReason = reason;
      if(!lifecycle.termination)lifecycle.termination=reason;
      // Remove the named container immediately, independently of caller cancellation.
      // Killing only the Docker CLI cannot stop a container already running in the daemon.
      if (!initialRemoval) initialRemoval = remove(name, Math.min(1000, cleanupTimeoutMs)).catch(() => false);
      try { child?.kill('SIGKILL'); } catch { /* Final cleanup remains mandatory. */ }
      if (!closeTimer && !cliClosed) closeTimer = setTimeout(() => closeResolve(), 1000);
    };
    const aborted = () => stop('cancelled');
    const collect = (target, chunk) => {
      const bytes = Buffer.from(chunk);
      const remaining = MAX_OUTPUT - captured;
      if (remaining > 0) { const part = Buffer.from(bytes.subarray(0, remaining)); target.push(part); captured += part.length; }
      if (bytes.length > remaining) stop('output_limit');
    };
    try {
      const available = await health();
      if (!available.available || quarantined.size) throw failure('sandbox_unavailable', available.reason || 'Sandbox cleanup is unconfirmed');
      if(executionId){
        lifecycle.resource=dockerResourceIdentity({version:1,engine:'docker',executionId,endpoint:host,daemonId:available.engineId,name,image},executionId);
        // This synchronous durable acknowledgement must precede any possible create.
        recordResource(lifecycle.resource);
      }
      if (signal?.aborted) throw failure('cancelled', 'Sandbox execution was cancelled before container launch');
      const runtime = language === 'javascript' ? ['/usr/local/bin/node', '--input-type=module', '-'] : ['/usr/local/bin/python', '-I', '-'];
      const args = [...globalArgs, 'run', '--rm', '--interactive', '--name', name,
        ...(executionId?['--label',EXECUTION_LABEL+'='+executionId]:[]),
        '--pull', 'never', '--network', 'none', '--read-only', '--tmpfs', '/tmp:' + TMPFS,
        '--pid', 'private', '--ipc', 'none', '--cgroupns', 'private', '--runtime', 'runc',
        '--memory', '256m', '--memory-swap', '256m', '--cpus', '1', '--pids-limit', '64',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534',
        '--workdir', '/tmp', '--log-driver', 'none', '--no-healthcheck',
        '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--entrypoint', '/usr/bin/env',
        image, '-i', 'HOME=/tmp', 'TMPDIR=/tmp', ...runtime];
      const deadline = Date.now() + timeoutMs;
      try {
        child = spawnImpl(dockerPath, args, { shell: false, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'], env: { ...cliEnv } });
        lifecycle.launched=true;lifecycle.cleanup={confirmed:false,name};
      } catch { throw failure('sandbox_start_failed', 'Docker sandbox could not start'); }
      child.stdout.on('data', bytes => collect(stdout, bytes));
      child.stderr.on('data', bytes => collect(stderr, bytes));
      child.stdin.on('error', () => { if (!cliClosed) stop('stdin_error'); });
      child.once('error', () => { rejected = failure('sandbox_start_failed', 'Docker sandbox process failed'); stop('process_error'); });
      child.once('close', codeValue => { exitCode = Number.isInteger(codeValue) ? codeValue : null;lifecycle.exitCode=exitCode; cliClosed = true; closeResolve(); });
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => stop('timeout'), Math.max(1, deadline - Date.now()));
      // The trusted runtime waits for stdin. Verify actual daemon-applied restrictions
      // before handing it any untrusted source code.
      while (!cliClosed && !stopReason && Date.now() < deadline) {
        let container;
        try {
          const value = await command(['container', 'inspect', '--format', '{{json .}}', name],
            Math.max(1, Math.min(1000, deadline - Date.now())));
          container = JSON.parse(value.stdout);
        } catch (error) {
          if (!absent(error, name)) throw failure('sandbox_start_failed', 'Running container inspection failed');
        }
        if (container?.Name === '/' + name) creation.observed = true;
        if (container?.State?.Running) {
          verifyContainer(container, name, image, runtime, executionId); verified = true;lifecycle.verified=true;
          if(executionId){
            // A local endpoint may have changed engines since preflight. Do not
            // attribute its running container to the old daemon in durable proof.
            let witnessedEngine;
            try { witnessedEngine=JSON.parse((await command(['info','--format','{{json .}}'],Math.max(1,Math.min(1000,deadline-Date.now())))).stdout); }
            catch { throw failure('sandbox_resource_daemon','Running resource daemon identity could not be verified'); }
            if(witnessedEngine?.OSType!=='linux'||witnessedEngine.ID!==lifecycle.resource.daemonId)throw failure('sandbox_resource_daemon','The local Docker engine changed before running resource acknowledgement');
            lifecycle.resource=dockerResourceIdentity({...lifecycle.resource,containerId:container.Id},executionId,{witnessed:true});
            recordResource(lifecycle.resource);
          }
          break;
        }
        await delay(20);
      }
      if (signal?.aborted) stop('cancelled');
      if (!verified && !stopReason) throw failure('sandbox_start_failed', 'Container did not start with verified isolation');
      if (verified && !stopReason && !cliClosed){lifecycle.codeSubmitted=true;child.stdin.end(Buffer.from(code, 'utf8'));}
      await closed;
      if (!verified) throw rejected || failure(stopReason === 'cancelled' ? 'cancelled' : 'sandbox_start_failed', 'Sandbox stopped before isolated code execution began');
      if(!lifecycle.codeSubmitted)throw failure('sandbox_not_submitted','The sandbox exited before source submission; code execution was not confirmed');
    } catch (error) {
      rejected = error;
      if (child && !cliClosed) { stop(error.code === 'cancelled' ? 'cancelled' : 'verification_failed'); await closed; }
    } finally {
      clearTimeout(timer); clearTimeout(closeTimer); signal?.removeEventListener('abort', aborted);
      try {
        if (child){removal = await cleanup(name, initialRemoval, cliClosed, creation);lifecycle.cleanup={...removal,confirmed:removal.removed===true&&removal.verifiedAbsent===true};}
      } finally { release(); }
    }
    if (rejected) throw rejected;
    const output = utf8Prefix(Buffer.concat(stdout), MAX_OUTPUT);
    const errors = utf8Prefix(Buffer.concat(stderr), MAX_OUTPUT - Buffer.byteLength(output));
    return { ok: !stopReason && exitCode === 0, exitCode, stdout: output, stderr: errors,
      sandboxed: true, engine: 'docker', isolation: 'docker-linux', network: false,
      hostMounts: false, language, image, termination: stopReason || 'exit', cleanup: removal,
      limits: { ...limits, timeoutMs },...(lifecycle.resource?{resource:lifecycle.resource}:{}) };
  }
  async function run(args, {signal,executionId,onResource}={}) {
    const lifecycle={launched:false,verified:false,codeSubmitted:false,cleanup:{confirmed:true,notCreated:true}};
    try{
      if((executionId!==undefined||onResource!==undefined)&&(!(typeof executionId==='string')||typeof onResource!=='function'))throw failure('sandbox_resource_invalid','Execution identity and synchronous resource journal callback are required together');
      return await runOwned(args,{signal,lifecycle,executionId,onResource});
    }
    catch(caught){
      const code=typeof caught?.code==='string'&&/^[a-zA-Z0-9_:-]{1,128}$/.test(caught.code)?caught.code:'sandbox_failed';
      const error=failure(code,/^(?:sandbox_|cancelled$)/.test(code)&&typeof caught?.message==='string'?caught.message.slice(0,400):'Sandbox execution failed');
      if(caught instanceof Error)Object.defineProperty(error,'cause',{value:caught,enumerable:false});
      error.executionAudit=Object.freeze({engine:'docker',dispatchAttempted:lifecycle.launched,codeMayHaveRun:lifecycle.codeSubmitted,isolationVerified:lifecycle.verified,
        termination:lifecycle.termination??(lifecycle.launched?'failed':'not_started'),cleanup:Object.freeze({...lifecycle.cleanup}),
        ...(lifecycle.exitCode!==undefined?{exitCode:lifecycle.exitCode}:{}),proof:Object.freeze({isolation:'docker-linux',...(lifecycle.resource?{resource:lifecycle.resource}:{}),...(lifecycle.name?{name:lifecycle.name}:{}),...(lifecycle.image?{image:lifecycle.image}:{}),...(lifecycle.limits?{limits:Object.freeze(lifecycle.limits)}:{})})});
      throw error;
    }
  }

  // Cancellation can race a daemon create/start request after the CLI exits. Cleanup
  // retries exact-name removal and requires observed creation/removal plus two post-CLI
  // absence checks. An unobserved late create is ambiguous even after quick 404s; if the
  // daemon cannot confirm cleanup within the independent deadline, future runs fail closed.
  // No bounded client can prove absence while an unresponsive daemon has pending work;
  // that condition is surfaced for operator cleanup rather than reporting success.
  return { kind: 'docker', health, run };
}
