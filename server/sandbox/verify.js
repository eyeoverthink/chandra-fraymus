import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { configuredCodeExecutor } from './config.js';

const OUTPUT_LIMIT = 32768;
const rootExpected = { uid: 65534, noNewPrivs: 1, seccomp: 2, effectiveCapabilities: 'zero', memoryBytes: 268435456, pids: 64, cpuCores: 1 };
const safeError = failure => ({ code: typeof failure?.code === 'string' ? failure.code.slice(0, 80) : 'verification_error', message: String(failure?.message || failure || 'Unknown verification error').slice(0, 500) });
function verifiedReceipt(receipt) {
  return receipt && typeof receipt === 'object' && receipt.sandboxed === true && receipt.engine === 'docker'
    && receipt.isolation === 'docker-linux' && receipt.network === false && receipt.hostMounts === false
    && receipt.cleanup?.removed === true && typeof receipt.ok === 'boolean'
    && typeof receipt.stdout === 'string' && typeof receipt.stderr === 'string'
    && Buffer.byteLength(receipt.stdout) + Buffer.byteLength(receipt.stderr) <= OUTPUT_LIMIT;
}
function healthySnapshot(value) {
  const health = {};
  for (const key of ['available', 'kind', 'engine', 'isolation', 'engineVersion', 'reason', 'images', 'limits', 'seccomp', 'runtime', 'resourceControls']) if (value?.[key] !== undefined) health[key] = value[key];
  return health;
}
function unavailable(reason, health) {
  return { version: 1, createdAt: new Date().toISOString(), available: false, passed: false, skipped: true,
    reason, ...(health ? { health: healthySnapshot(health) } : {}), tests: [],
    summary: { passed: 0, failed: 0, skipped: 0, total: 0 },
    scope: 'No container tests ran. Unavailable or skipped verification is never a pass.' };
}
function jsonOutput(receipt) {
  if (receipt.ok !== true || receipt.exitCode !== 0 || receipt.termination !== 'exit') throw new Error('Probe did not finish normally with a zero exit code');
  const value = JSON.parse(receipt.stdout.trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Probe returned invalid JSON evidence');
  return value;
}

/** Operator-only fixed probes; no pulls, host mounts/files, model calls or cloud requests.
 * executor/factory/timer seams are trusted test options; the CLI always forces Docker mode.
 */
export async function verifySandbox({ executor, executorFactory = configuredCodeExecutor,
  env = process.env, dataDir = DATA_DIR, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  let health;
  try {
    const selected = executor ?? executorFactory({ dataDir, env: { ...env, FRAYMUS_CODE_EXECUTION: 'docker', FRAYMUS_ALLOW_HOST_CODE: '0' } });
    if (!selected || selected.kind !== 'docker' || typeof selected.health !== 'function' || typeof selected.run !== 'function') return unavailable('Verification requires the Docker executor; approved host mode is never used.');
    executor = selected;
    health = await executor.health();
    if (health?.available !== true) return unavailable(typeof health?.reason === 'string' ? health.reason : 'Docker sandbox is unavailable.', health);
  } catch { return unavailable('Docker configuration or health could not be verified. No container tests ran.'); }
  const tests = [];
  async function probe(name, language, code, expected, evaluate, timeoutMs = 5000, signal) {
    let receipt;
    const prefix = language === 'javascript' ? '//' : '#';
    try {
      receipt = await executor.run({ language, code: `${prefix} FRAYMUS_VERIFY:${name}\n${code}`, timeoutMs }, signal ? { signal } : {});
      if (!verifiedReceipt(receipt)) throw new Error('Executor returned no verified bounded Docker execution and cleanup receipt');
      const observed = await evaluate(receipt);
      const passed = observed?.passed === true;
      const result = { name, passed, skipped: false, expected, observed: observed?.evidence ?? null, receipt,
        ...(!passed ? { reason: observed?.reason || 'Observed container evidence did not meet the expected boundary.' } : {}) };
      tests.push(result); return result;
    } catch (failure) {
      const result = { name, passed: false, skipped: false, expected, ...(receipt ? { receipt } : {}), error: safeError(failure), reason: 'No verified passing receipt for this probe.' };
      tests.push(result); return result;
    }
  }
  await probe('node-arithmetic', 'javascript', 'console.log(JSON.stringify({value:37*19}));', { value: 703 }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: evidence.value === 703, evidence };
  });
  await probe('python-arithmetic', 'python', 'import json\nprint(json.dumps({"value":37*19}))', { value: 703 }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: evidence.value === 703, evidence };
  });
  await probe('unprivileged-process-and-cgroups', 'python', `import os,json
fields={}
with open('/proc/self/status') as f:
 for line in f:
  if ':' in line:
   key,value=line.split(':',1)
   if key in ('NoNewPrivs','Seccomp','CapEff'): fields[key]=value.strip()
paths=['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/pids.max','/sys/fs/cgroup/cpu.max','/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/pids/pids.max','/sys/fs/cgroup/cpu/cpu.cfs_quota_us','/sys/fs/cgroup/cpu/cpu.cfs_period_us']
groups={}
for path in paths:
 try:
  with open(path) as f: groups[path]=f.read(200).strip()
 except OSError: pass
print(json.dumps({'uid':os.getuid(),'euid':os.geteuid(),'status':fields,'cgroups':groups}))`, rootExpected, receipt => {
    const evidence = jsonOutput(receipt), status = evidence.status || {}, groups = evidence.cgroups || {};
    const memory = Number(groups['/sys/fs/cgroup/memory.max'] ?? groups['/sys/fs/cgroup/memory/memory.limit_in_bytes']);
    const pids = Number(groups['/sys/fs/cgroup/pids.max'] ?? groups['/sys/fs/cgroup/pids/pids.max']);
    const cpu = groups['/sys/fs/cgroup/cpu.max']?.split(/\s+/);
    const quota = Number(cpu?.[0] ?? groups['/sys/fs/cgroup/cpu/cpu.cfs_quota_us']);
    const period = Number(cpu?.[1] ?? groups['/sys/fs/cgroup/cpu/cpu.cfs_period_us']);
    const capZero = typeof status.CapEff === 'string' && /^0+$/.test(status.CapEff);
    return { passed: evidence.uid === 65534 && evidence.euid === 65534 && Number(status.NoNewPrivs) === 1 && Number(status.Seccomp) === 2 && capZero && memory === 268435456 && pids === 64 && period > 0 && quota / period === 1,
      evidence: { ...evidence, measuredLimits: { memoryBytes: memory, pids, cpuCores: quota / period } } };
  });
  await probe('read-only-root', 'python', `import os,json
evidence={'rootReadonlyMount':bool(os.statvfs('/').f_flag & os.ST_RDONLY),'writeDenied':False}
try:
 with open('/fraymus-verification-readonly-probe','x') as f: f.write('ephemeral-container-probe')
except OSError as error:
 evidence.update({'writeDenied':True,'errno':error.errno})
print(json.dumps(evidence))`, { rootReadonlyMount: true, writeDenied: true }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: evidence.rootReadonlyMount === true && evidence.writeDenied === true, evidence };
  });
  const marker = `/tmp/fraymus-verification-${randomUUID()}.txt`, token = randomUUID();
  const written = await probe('tmpfs-write-read', 'python', `import os,json
path=${JSON.stringify(marker)}
token=${JSON.stringify(token)}
with open(path,'x') as f: f.write(token)
with open(path) as f: actual=f.read()
print(json.dumps({'matches':actual==token,'tmpReadonlyMount':bool(os.statvfs('/tmp').f_flag & os.ST_RDONLY),'bytes':len(actual)}))`, { matches: true, tmpReadonlyMount: false }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: evidence.matches === true && evidence.tmpReadonlyMount === false, evidence };
  });
  await probe('fresh-container-has-no-marker', 'python', `import os,json
print(json.dumps({'markerExists':os.path.exists(${JSON.stringify(marker)})}))`, { priorWriteVerified: true, markerExists: false }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: written.passed && evidence.markerExists === false, evidence: { priorWriteVerified: written.passed, ...evidence } };
  });
  await probe('no-docker-sockets-or-host-roots', 'python', `import os,json
paths=['/var/run/docker.sock','/run/docker.sock','/host','/host_mnt','/run/desktop/mnt/host','/mnt/c']
print(json.dumps({'paths':{path:os.path.lexists(path) for path in paths}}))`, { everyPathAbsent: true }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: evidence.paths && Object.keys(evidence.paths).length === 6 && Object.values(evidence.paths).every(value => value === false), evidence };
  });
  await probe('network-hard-ip-denied', 'python', `import socket,json
evidence={'connected':False,'connectFailed':False,'interfaces':[name for _,name in socket.if_nameindex()]}
connection=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
connection.settimeout(1)
try:
 connection.connect(('1.1.1.1',443))
 evidence['connected']=True
except OSError as error:
 evidence.update({'connectFailed':True,'errno':error.errno,'errorType':type(error).__name__})
finally: connection.close()
print(json.dumps(evidence))`, { connected: false, connectFailed: true, interfaces: ['lo'] }, receipt => {
    const evidence = jsonOutput(receipt); return { passed: evidence.connected === false && evidence.connectFailed === true && Array.isArray(evidence.interfaces) && evidence.interfaces.length === 1 && evidence.interfaces[0] === 'lo', evidence };
  });
  await probe('infinite-node-timeout', 'javascript', 'while(true) {}', { termination: 'timeout', cleanupRemoved: true }, receipt => ({ passed: receipt.ok === false && receipt.termination === 'timeout', evidence: { termination: receipt.termination, cleanup: receipt.cleanup } }), 4000);
  const controller = new AbortController();
  const cancelTimer = setTimeoutImpl(() => controller.abort(Object.assign(new Error('Operator verification cancellation probe'), { code: 'cancelled' })), 2000);
  try {
    await probe('node-cancellation', 'javascript', 'while(true) {}', { termination: 'cancelled', cleanupRemoved: true, cancellationRequestedAfterMs: 2000 }, receipt => ({ passed: controller.signal.aborted && receipt.ok === false && receipt.termination === 'cancelled', evidence: { cancellationRequested: controller.signal.aborted, termination: receipt.termination, cleanup: receipt.cleanup } }), 5000, controller.signal);
  } finally { clearTimeoutImpl(cancelTimer); }
  await probe('output-overflow-bounded', 'javascript', 'process.stdout.write("x".repeat(65536)); setTimeout(()=>{},1000);', { termination: 'output_limit', maxCombinedOutputBytes: OUTPUT_LIMIT, cleanupRemoved: true }, receipt => ({ passed: receipt.ok === false && receipt.termination === 'output_limit' && Buffer.byteLength(receipt.stdout) + Buffer.byteLength(receipt.stderr) <= OUTPUT_LIMIT, evidence: { termination: receipt.termination, combinedOutputBytes: Buffer.byteLength(receipt.stdout) + Buffer.byteLength(receipt.stderr), cleanup: receipt.cleanup } }));
  const passed = tests.every(result => result.passed === true && result.skipped === false);
  return { version: 1, createdAt: new Date().toISOString(), available: true, passed, skipped: false, health: healthySnapshot(health), tests,
    summary: { total: tests.length, passed: tests.filter(result => result.passed).length, failed: tests.filter(result => !result.passed).length, skipped: tests.filter(result => result.skipped).length },
    scope: 'Fixed operator container probes, not a general security certification. Only verified actual Docker execution/cleanup receipts count as passes.' };
}

export function verificationExitCode(report) {
  return report?.available === true && report.passed === true && report.skipped === false
    && Array.isArray(report.tests) && report.tests.length === 11
    && report.tests.every(result => result.passed === true && result.skipped === false && verifiedReceipt(result.receipt)) ? 0 : 1;
}
export function saveVerificationReport(report, { dataDir = DATA_DIR } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'sandbox-verification.json'), temporary = join(dataDir, `.sandbox-verification-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, JSON.stringify(report, null, 2) + '\n', 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temporary, target); return target;
  } finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : '';
const ownPath = fileURLToPath(import.meta.url);
if (mainPath && (process.platform === 'win32' ? mainPath.toLowerCase() === ownPath.toLowerCase() : mainPath === ownPath)) {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log('Usage: node server/sandbox/verify.js\nOperator-only fixed Docker probes; no pulls or host-mode fallback. Saves DATA_DIR/sandbox-verification.json.');
    else { console.error('Usage: node server/sandbox/verify.js (no execution-mode, image or endpoint arguments)'); process.exitCode = 1; }
  } else {
    try {
      const report = await verifySandbox();
      console.log(JSON.stringify(report, null, 2));
      saveVerificationReport(report);
      process.exitCode = verificationExitCode(report);
    } catch { console.error('Could not complete or save Docker sandbox verification. No passing result is claimed.'); process.exitCode = 1; }
  }
}
