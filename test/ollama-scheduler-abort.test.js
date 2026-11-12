import test from 'node:test';
import assert from 'node:assert/strict';
import { withOllama, getSchedulerStatus } from '../server/intelligence/ollama-scheduler.js';

// Found 2026-11-12: a call that ignored its abort kept a GPU slot until it settled — forever, for a stuck one — and every
// later model call waited out its class limit ("0 queued, 1 running"; 35 agent tests timed out on it).
const never = () => new Promise(() => {});   // a provider that ignores cancellation

test('cancelling calls that ignore their abort frees their slots at once', async () => {
  const slots = getSchedulerStatus().maxConcurrent, controllers = [], stuck = [];
  for (let i = 0; i < slots; i++) { const c = new AbortController(); controllers.push(c); stuck.push(withOllama('agent_run', never, { label: `stuck-${i}`, signal: c.signal }).catch(e => e)); }
  await new Promise(r => setTimeout(r, 20));
  assert.equal(getSchedulerStatus().running, slots, 'every slot is held by a stuck call');
  for (const c of controllers) c.abort();
  for (const e of await Promise.all(stuck)) assert.match(String(e?.name || e), /Abort/);
  const t0 = Date.now();
  assert.equal(await withOllama('agent_run', async () => 'next', { label: 'next' }), 'next');
  assert.ok(Date.now() - t0 < 1000, 'the next call was not kept waiting');
  assert.equal(getSchedulerStatus().running, 0);
});

test('a call cancelled while still queued leaves the queue', async () => {
  const slots = getSchedulerStatus().maxConcurrent, hold = [];
  for (let i = 0; i < slots; i++) { const c = new AbortController(); hold.push(c); withOllama('agent_run', never, { signal: c.signal }).catch(() => {}); }
  const queued = new AbortController();
  const p = withOllama('agent_run', async () => 'should not run', { signal: queued.signal });
  await new Promise(r => setTimeout(r, 20));
  queued.abort();
  await assert.rejects(p, e => e.code === 'scheduler_dropped' && e.reason === 'aborted');
  for (const c of hold) c.abort();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(getSchedulerStatus().running, 0); assert.equal(getSchedulerStatus().queued, 0);
});

test('two jobs finishing in either order each free their own slot (no guessed ids)', async () => {
  let releaseA, releaseB;
  const a = withOllama('agent_run', () => new Promise(r => { releaseA = r; }), { label: 'a' });
  const b = withOllama('agent_run', () => new Promise(r => { releaseB = r; }), { label: 'b' });
  const until = async ok => { for (let i = 0; i < 200 && !ok(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(ok()); };
  await until(() => releaseA);
  releaseA('A');
  await until(() => releaseB);          // with one slot, b starts only after a frees it
  releaseB('B');
  assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
  assert.equal(getSchedulerStatus().running, 0);
});
