import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseWorkers, jobDigest, runOnWorker } from '../server/media/workers.js';
import { db } from '../server/db.js';
import { DATA_DIR } from '../server/config.js';

const WORKER = resolve('scripts/worker/chandra_worker.py');
const SCRATCH = join(DATA_DIR, 'test-scratch', 'workers');
const TOKEN_FILE = process.env.CHANDRA_WORKER_TOKEN_FILE || join(DATA_DIR, 'worker-token.txt');
const PORT = 47291;

test('worker list: private hosts only, names cleaned, duplicates and public hosts refused', () => {
  const r = parseWorkers('Home=http://100.99.98.101:47210, lan=http://10.0.0.5:47210/x, bad, web=https://example.com:47210, home=http://127.0.0.1:1');
  assert.deepEqual(r.workers.map(w => [w.name, w.url]), [['home', 'http://100.99.98.101:47210'], ['lan', 'http://10.0.0.5:47210']]);
  assert.deepEqual(r.refused.map(x => x.entry), ['bad', 'web', 'home']);
  assert.match(r.refused[1].reason, /public host/);
  assert.deepEqual(parseWorkers('').workers, []);
});

test('the content digest does not depend on key order and changes with any input', () => {
  const files = { 'a.txt': Buffer.from('one'), 'b.txt': Buffer.from('two') };
  const d = jobDigest('stills', { items: [{ prompt: 'x', seed: 1 }], n: 2 }, files);
  assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(jobDigest('stills', { n: 2, items: [{ seed: 1, prompt: 'x' }] }, { 'b.txt': Buffer.from('two'), 'a.txt': Buffer.from('one') }), d);
  assert.notEqual(jobDigest('stills', { items: [{ prompt: 'x', seed: 2 }], n: 2 }, files), d);
  assert.notEqual(jobDigest('video', { items: [{ prompt: 'x', seed: 1 }], n: 2 }, files), d);
  assert.notEqual(jobDigest('stills', { items: [{ prompt: 'x', seed: 1 }], n: 2 }, { ...files, 'a.txt': Buffer.from('ONE') }), d);
});

test('hub and worker compute the same digest (JavaScript and Python agree byte for byte)', () => {
  const spec = { style: '8bit', format: '16:9', cfg: 6.5, steps: 22, flag: true, none: null, lines: [{ text: 'Café "quoted" \\ back\nline — dash 🚀', file: 'line-01.wav' }], nested: { z: 1, a: [1, 2, { k: 'v' }] } };
  const files = { 'script.md': Buffer.from('## title\n# X\n', 'utf8'), 'line-01.wav': Buffer.from([0, 1, 2, 250, 255]) };
  const py = `
import sys, json, base64
sys.path.insert(0, ${JSON.stringify(resolve('scripts/worker'))})
sys.dont_write_bytecode = True
import chandra_worker as w
req = json.loads(sys.stdin.read())
print(w.job_digest(req['kind'], req['spec'], {k: base64.b64decode(v) for k, v in req['files'].items()}))
`;
  const out = execFileSync('python', ['-c', py], { input: JSON.stringify({ kind: 'video', spec, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])) }), encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1' } }).trim();   // stdin must be read as UTF-8, as the HTTP path does
  assert.equal(out, jobDigest('video', spec, files));
});

test('a live worker: token required, capabilities reported honestly, work it cannot do is refused and recorded', async t => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  // the hub creates the token on first use; make sure it exists before the worker reads it
  await runOnWorker({ name: 'nobody', url: 'http://127.0.0.1:9' }, { id: 'wtest-token', kind: 'stills', spec: {}, files: {} }, { outDir: SCRATCH, timeoutMs: 2000 }).catch(() => {});
  assert.ok(existsSync(TOKEN_FILE));
  const child = spawn('python', ['-B', WORKER, '--bind', '127.0.0.1', '--port', String(PORT), '--token-file', TOKEN_FILE, '--work-dir', join(SCRATCH, 'work'), '--name', 'unit-test'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); db.prepare(`DELETE FROM worker_jobs WHERE id LIKE 'wtest-%'`).run(); rmSync(SCRATCH, { recursive: true, force: true }); });
  await new Promise((ok, fail) => { const timer = setTimeout(() => fail(new Error('worker did not start')), 20_000); child.stdout.on('data', d => { if (String(d).includes('listening')) { clearTimeout(timer); ok(); } }); child.on('exit', c => fail(new Error(`worker exited ${c}`))); });
  const base = `http://127.0.0.1:${PORT}`, token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const auth = { Authorization: `Bearer ${token}` };

  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const health = await (await fetch(`${base}/health`, { headers: auth })).json();
  assert.equal(health.name, 'unit-test'); assert.equal(health.busy, null);
  assert.equal(health.capabilities.stills.ready, false);                    // no ComfyUI was configured for this worker
  assert.match(health.capabilities.stills.problems.join(' '), /ComfyUI/);
  assert.equal(health.capabilities.video.ready, false);
  assert.match(health.capabilities.video.problems.join(' '), /fraymus-video-studio is not here/);

  const post = body => fetch(`${base}/jobs`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ id: 'x', nonce: 'n'.repeat(16), kind: 'stills' })).status, 400);                       // id too short
  assert.equal((await post({ id: 'wtest-1', nonce: 'short', kind: 'stills' })).status, 400);
  assert.equal((await post({ id: 'wtest-1', nonce: 'n'.repeat(16), kind: 'mine-coins' })).status, 400);
  assert.equal((await post({ id: 'wtest-1', nonce: 'n'.repeat(16), kind: 'stills', files: { '../evil.py': 'eA==' } })).status, 400);
  const refused = await post({ id: 'wtest-1', nonce: 'n'.repeat(16), kind: 'stills', spec: { items: [{ prompt: 'a lighthouse' }] } });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /cannot do stills/);
  assert.equal((await fetch(`${base}/jobs/wtest-1`, { headers: auth })).status, 404);                               // a refused job leaves nothing behind
  assert.equal((await fetch(`${base}/jobs/wtest-1/files/..%2F..%2Fchandra_worker.py`, { headers: auth })).status, 404);

  await assert.rejects(() => runOnWorker({ name: 'unit-test', url: base }, { id: 'wtest-2', kind: 'video', spec: { style: '8bit' }, files: { 'script.md': Buffer.from('x') }, purpose: 'unit test' }, { outDir: SCRATCH }), /worker unit-test: this machine cannot do video/);
  const row = db.prepare(`SELECT state, error, worker, kind FROM worker_jobs WHERE id = 'wtest-2'`).get();
  assert.equal(row.state, 'error'); assert.equal(row.worker, 'unit-test'); assert.match(row.error, /cannot do video/);
});
