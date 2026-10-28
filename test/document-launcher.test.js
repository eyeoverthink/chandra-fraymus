import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import {unlink,rmdir,readdir} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('../server/documents/bounded-process.py', import.meta.url));
const native = { skip: process.platform !== 'win32' && 'Native Windows Job Object validation requires Windows' };
const cap = 96 * 1024 * 1024;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, 'fraymus-launcher-'));
  const original = realpathSync(root), script = join(root, 'synthetic-parser.cjs'), marker = join(root, 'started.pid');
  const owned = [];
  writeFileSync(script, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (request.mode === 'memory') {
    const held = [];
    for (let index = 0; index < 6; index++) held.push(Buffer.alloc(16 * 1024 * 1024, 0x61));
    process.stdout.write(JSON.stringify({ok:true,allocated:held.length * 16 * 1024 * 1024}));
  } else if (request.mode === 'idle') {
    await new Promise(resolve => setTimeout(resolve, 10000));
  } else if (request.mode === 'overflow') {
    process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));
  } else {
    process.stdout.write(JSON.stringify({ok:true,value:request.value,
      environmentKeys:Object.keys(process.env).sort(),execArgv:process.execArgv}) + '\\n');
  }
})().catch(() => process.exit(2));
`);
  t.after(async () => {
    for (const process of owned) {
      if (process.exitCode === null && process.signalCode === null) process.kill();
    }
    await Promise.all(owned.map(process => process.closed.catch(() => {})));
    const target = realpathSync(root);
    assert.equal(target, original); assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith('fraymus-launcher-'));
    // Only these two exact owned files can exist. Avoid recursive removal and
    // let the event loop drain Windows handle-close notifications between tries.
    assert.ok((await readdir(target)).every(name=>['synthetic-parser.cjs','started.pid'].includes(name)));
    async function cleanup(operation) {
      for(let attempt=0;;attempt++)try{return await operation();}catch(error){
        if(error.code==='ENOENT')return;
        if(attempt>=5||!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;
        await delay(100*(attempt+1));
      }
    }
    await cleanup(()=>unlink(script));await cleanup(()=>unlink(marker));await cleanup(()=>rmdir(target));
  });
  function start(input, extraEnvironment = {}) {
    const child = spawn(process.env.FRAYMUS_DOCUMENT_PYTHON || 'python',
      ['-B', launcher, process.execPath, script, String(cap)], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...extraEnvironment },
      });
    const stdout = [], stderr = [];
    let bytes = 0;
    child.closed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Native launcher regression exceeded its test deadline')); }, 22000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        // All synthetic cases return a small JSON receipt, including output overflow.
        if (bytes > 1024 * 1024) { child.kill(); reject(new Error('Native launcher leaked excessive child output')); }
        else stdout.push(chunk);
      });
      child.stderr.on('data', chunk => { if (stderr.reduce((sum, item) => sum + item.length, 0) < 65536) stderr.push(chunk); });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
      });
    });
    // Rejected/closed child input is an expected failure mode of a bounded launcher.
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.isBuffer(input) ? input : JSON.stringify(input));
    owned.push(child);
    return child;
  }
  return { start, marker };
}

test('native document launcher preserves JSON bytes and strips ambient Node options/credentials', native, async t => {
  const f = fixture(t);
  const result = await f.start({ value: 'Synthetic φ\nJSON only.' }, {
    NODE_OPTIONS: '--invalid-synthetic-launcher-option',
    PRIVATE_LAUNCHER_SENTINEL: 'synthetic-not-a-real-credential',
    PYTHONPATH: '',
  }).closed;
  assert.equal(result.code, 0, result.stdout.toString());
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.value, 'Synthetic φ\nJSON only.');
  assert.equal(result.stdout.toString(), JSON.stringify(value) + '\n');
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG']);
  assert.ok(value.environmentKeys.every(name => allowed.has(name.toUpperCase())));
  assert.ok(value.execArgv.includes('--max-old-space-size=64'));
});

test('native document Job rejects bounded Buffer allocation beyond its process committed-memory cap', native, async t => {
  const f = fixture(t);
  // Maximum synthetic request is 96 MiB plus a small Node runtime, never an unbounded OOM probe.
  const result = await f.start({ mode: 'memory' }).closed;
  assert.notEqual(result.code, 0);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, false); assert.match(value.error, /bounded Windows process/);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.length < 1024);
});

test('terminating the wrapper closes its noninherited Job and kills its exact synthetic child', native, async t => {
  const f = fixture(t), child = f.start({ mode: 'idle' });
  const deadline = Date.now() + 5000;
  while (!existsSync(f.marker) && Date.now() < deadline) await delay(5);
  assert.ok(existsSync(f.marker), 'Trusted synthetic child must have started under the Job');
  const pid = Number(readFileSync(f.marker, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  child.kill(); await child.closed;
  let running = true;
  const killedDeadline = Date.now() + 1000;
  while (running && Date.now() < killedDeadline) {
    try { process.kill(pid, 0); await delay(10); }
    catch (error) { assert.equal(error.code, 'ESRCH'); running = false; }
  }
  assert.equal(running, false, 'Synthetic child must disappear after wrapper TerminateProcess');
});

test('native document launcher rejects oversized input before starting Node and bounds output', native, async t => {
  const f = fixture(t);
  const oversized = await f.start(Buffer.alloc(6 * 1024 * 1024 + 1, 0x78)).closed;
  assert.notEqual(oversized.code, 0);
  assert.match(JSON.parse(oversized.stdout).error, /6 MiB/);
  assert.equal(existsSync(f.marker), false);
  const overflow = await f.start({ mode: 'overflow' }).closed;
  assert.notEqual(overflow.code, 0);
  assert.match(JSON.parse(overflow.stdout).error, /16 MiB/);
  assert.ok(overflow.stdout.length < 1024);
});
