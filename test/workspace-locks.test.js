import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspacePolicy} from '../server/agent/workspace.js';
import {hash} from '../server/agent/schema.js';

const scratch = path.resolve(import.meta.dirname, '../../work');
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}
async function bounded(promise, description, milliseconds = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out: ' + description)), milliseconds);
    })]);
  } finally {clearTimeout(timer);}
}
async function fixture(t) {
  await fs.mkdir(scratch, {recursive: true});
  const parent = await fs.realpath(scratch);
  const directory = await fs.mkdtemp(path.join(parent, 'workspace-locks-'));
  const original = await fs.realpath(directory);
  await fs.mkdir(path.join(directory, 'nested'));
  await Promise.all(['a', 'b', 'c'].map(name => fs.writeFile(path.join(directory, name + '.txt'), name + '0\n')));
  await fs.writeFile(path.join(directory, 'nested', 'Case.txt'), 'nested\n');
  const policy = createWorkspacePolicy(directory), otherPolicy = createWorkspacePolicy(directory);
  t.after(async () => {
    const checked = await fs.realpath(directory);
    assert.equal(checked, original);
    assert.equal(path.dirname(checked), parent);
    assert.ok(path.basename(checked).startsWith('workspace-locks-'));
    await fs.rm(checked, {recursive: true, force: true});
  });
  return {directory, policy, otherPolicy, text: name => fs.readFile(path.join(directory, name + '.txt'), 'utf8')};
}
const replacement = (name, before, after) => ({path: name + '.txt', expectedHash: hash(before), content: after});

test('opposing batch path orders share a deterministic lock order without interleaved ownership', {timeout: 10000}, async t => {
  const f = await fixture(t), holderEntered = deferred(), releaseHolder = deferred();
  const holder = f.policy.withWriteLocks(['a.txt'], {}, async () => {
    holderEntered.resolve();
    await releaseHolder.promise;
  });
  await bounded(holderEntered.promise, 'initial holder');
  const entries = [], releaseBatch = deferred();
  let active = 0, maximum = 0;
  const run = (policy, names, id) => policy.withWriteLocks(names, {}, async lease => {
    maximum = Math.max(maximum, ++active);
    entries.push(id);
    try {
      await releaseBatch.promise;
      for (const name of ['a', 'b']) {
        const file = await policy.read(name + '.txt');
        await policy.write(replacement(name, file.text, file.text + id + '\n'), {lease});
      }
    } finally {active--;}
  });
  const first = run(f.policy, ['a.txt', 'b.txt'], 'first');
  const second = run(f.otherPolicy, ['b.txt', 'a.txt'], 'second');
  const completed = Promise.all([first, second]);
  completed.catch(() => {});
  try {
    await delay(40);
    assert.deepEqual(entries, []);
    releaseHolder.resolve();
    await bounded(holder, 'release initial holder');
    releaseBatch.resolve();
    await bounded(completed, 'opposing batches');
    assert.equal(maximum, 1);
    assert.deepEqual(new Set(entries), new Set(['first', 'second']));
    assert.equal(await f.text('a'), 'a0\n' + entries.join('\n') + '\n');
    assert.equal(await f.text('b'), 'b0\n' + entries.join('\n') + '\n');
  } finally {releaseHolder.resolve(); releaseBatch.resolve();}
});

test('a single-file writer from another policy waits for the batch and rechecks its hash', {timeout: 10000}, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const batch = f.policy.withWriteLocks(['b.txt', 'a.txt'], {}, async lease => {
    entered.resolve();
    await release.promise;
    // A lease is shared by policies for the same canonical workspace, not by callers guessing an object.
    await f.otherPolicy.write(replacement('a', 'a0\n', 'batch-a\n'), {lease});
    await f.policy.write(replacement('b', 'b0\n', 'batch-b\n'), {lease});
  });
  await bounded(entered.promise, 'batch entry');
  let settled = false, dispatched = false;
  const single = f.otherPolicy.write(replacement('a', 'a0\n', 'stale-single\n'), {beforeDispatch: () => {dispatched = true;}});
  single.then(() => {settled = true;}, () => {settled = true;});
  try {
    await delay(35);
    assert.equal(settled, false);
    assert.equal(await f.text('a'), 'a0\n');
    release.resolve();
    await bounded(batch, 'batch completion');
    await assert.rejects(bounded(single, 'queued single writer'), {code: 'write_conflict'});
    assert.equal(dispatched, false);
    assert.equal(await f.text('a'), 'batch-a\n');
    assert.equal(await f.text('b'), 'batch-b\n');
  } finally {release.resolve();}
});

test('cancelling a queued batch never enters its callback and leaves later writers usable', {timeout: 10000}, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
  const holder = f.policy.withWriteLocks(['a.txt'], {}, async () => {entered.resolve(); await release.promise;});
  await bounded(entered.promise, 'queue holder');
  let callbackEntered = false, attempted = false;
  const queued = f.otherPolicy.withWriteLocks(['b.txt', 'a.txt'], {signal: controller.signal}, async lease => {
    callbackEntered = true;
    await f.otherPolicy.write(replacement('a', 'a0\n', 'cancelled\n'), {lease, beforeDispatch: () => {attempted = true;}});
  });
  queued.catch(() => {});
  try {
    await delay(35);
    controller.abort(Object.assign(new Error('Synthetic cancellation'), {code: 'cancelled'}));
    const later = f.policy.write(replacement('a', 'a0\n', 'later\n'));
    later.catch(() => {});
    assert.equal(callbackEntered, false);
    release.resolve();
    await bounded(holder, 'holder after cancellation');
    await assert.rejects(bounded(queued, 'cancelled queued batch'), {code: 'cancelled'});
    await bounded(later, 'writer behind cancelled batch');
    assert.equal(callbackEntered, false);
    assert.equal(attempted, false);
    assert.equal(await f.text('a'), 'later\n');
    assert.equal(await f.text('b'), 'b0\n');
  } finally {release.resolve();}
});

test('leases are opaque, expire after callback, and cannot authorize another file or workspace', async t => {
  const f = await fixture(t), otherRoot = path.join(f.directory, 'separate');
  await fs.mkdir(otherRoot);
  await fs.writeFile(path.join(otherRoot, 'a.txt'), 'a0\n');
  const foreign = createWorkspacePolicy(otherRoot);
  let captured, attempted = 0;
  const beforeDispatch = () => {attempted++;};
  for (const lease of [{}, Object.freeze({}), null]) {
    await assert.rejects(f.policy.write(replacement('a', 'a0\n', 'forged\n'), {lease, beforeDispatch}), {code: 'invalid_write_lease'});
  }
  await f.policy.withWriteLocks(['a.txt'], {}, async lease => {
    captured = lease;
    assert.equal(Object.isFrozen(lease), true);
    assert.deepEqual(Reflect.ownKeys(lease), []);
    await assert.rejects(f.policy.write(replacement('c', 'c0\n', 'wrong-file\n'), {lease, beforeDispatch}), {code: 'invalid_write_lease'});
    await assert.rejects(foreign.write(replacement('a', 'a0\n', 'wrong-root\n'), {lease, beforeDispatch}), {code: 'invalid_write_lease'});
  });
  await assert.rejects(f.policy.write(replacement('a', 'a0\n', 'expired\n'), {lease: captured, beforeDispatch}), {code: 'invalid_write_lease'});
  assert.equal(attempted, 0);
  assert.equal(await f.text('a'), 'a0\n');
  assert.equal(await f.text('c'), 'c0\n');
  assert.equal(await fs.readFile(path.join(otherRoot, 'a.txt'), 'utf8'), 'a0\n');
});

test('callback failure releases every acquired file lock', {timeout: 10000}, async t => {
  const f = await fixture(t), failure = new Error('Synthetic callback failure');
  await assert.rejects(f.policy.withWriteLocks(['b.txt', 'a.txt'], {}, async () => {throw failure;}), caught => caught === failure);
  await bounded(Promise.all([
    f.otherPolicy.write(replacement('a', 'a0\n', 'after-a\n')),
    f.policy.write(replacement('b', 'b0\n', 'after-b\n')),
  ]), 'writers after failed callback');
  assert.equal(await f.text('a'), 'after-a\n');
  assert.equal(await f.text('b'), 'after-b\n');
});

test('canonical separator and Windows case aliases share an identity and are rejected as duplicate targets', async t => {
  const f = await fixture(t), canonical = await f.policy.identity('nested/Case.txt');
  assert.match(canonical, /^[a-f0-9]{64}$/);
  assert.equal(await f.otherPolicy.identity('nested\\Case.txt'), canonical);
  let entered = false;
  await assert.rejects(f.policy.withWriteLocks(['nested/Case.txt', 'nested\\Case.txt'], {}, async () => {entered = true;}), {code: 'path_alias'});
  if (process.platform === 'win32') {
    assert.equal(await f.otherPolicy.identity('NESTED/cASE.TXT'), canonical);
    await assert.rejects(f.policy.withWriteLocks(['nested/Case.txt', 'NESTED/cASE.TXT'], {}, async () => {entered = true;}), {code: 'path_alias'});
    const caseRoot = createWorkspacePolicy(f.directory.toUpperCase());
    assert.equal(await caseRoot.identity('nested/Case.txt'), canonical);
  }
  assert.equal(entered, false);
});

test('physical hard links are denied by identity and lock acquisition before callback', async t => {
  const f = await fixture(t);
  try {await fs.link(path.join(f.directory, 'a.txt'), path.join(f.directory, 'linked.txt'));}
  catch (caught) {
    if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(caught.code)) {t.skip('Filesystem does not support hard-link fixture'); return;}
    throw caught;
  }
  let entered = false;
  for (const name of ['a.txt', 'linked.txt']) {
    await assert.rejects(f.policy.identity(name), {code: 'path_denied'});
    await assert.rejects(f.policy.withWriteLocks([name], {}, async () => {entered = true;}), {code: 'path_denied'});
  }
  assert.equal(entered, false);
  assert.equal(await f.text('a'), 'a0\n');
});

test('swapping two leased files cannot reuse the other path\'s identity even with a matching current hash', async t => {
  const f = await fixture(t), a = path.join(f.directory, 'a.txt'), b = path.join(f.directory, 'b.txt'), temporary = path.join(f.directory, 'swap.txt');
  const originalA = await f.policy.identity('a.txt'), originalB = await f.policy.identity('b.txt');
  let attempted = false;
  await f.policy.withWriteLocks(['a.txt', 'b.txt'], {}, async lease => {
    // Synthetic external modification, deliberately bypassing cooperative writers.
    await fs.rename(a, temporary);
    await fs.rename(b, a);
    await fs.rename(temporary, b);
    assert.equal(await f.policy.identity('a.txt'), originalB);
    assert.equal(await f.policy.identity('b.txt'), originalA);
    for (const [name, current] of [['a', 'b0\n'], ['b', 'a0\n']]) {
      await assert.rejects(f.otherPolicy.write(replacement(name, current, 'not-authorized\n'), {
        lease, beforeDispatch: () => {attempted = true;},
      }), {code: 'invalid_write_lease'});
    }
  });
  assert.equal(attempted, false);
  assert.equal(await f.text('a'), 'b0\n');
  assert.equal(await f.text('b'), 'a0\n');
  await f.policy.write(replacement('a', 'b0\n', 'fresh-authority\n'));
  assert.equal(await f.text('a'), 'fresh-authority\n');
});

test('a callback cannot release its locks while an already-admitted leased write is still pending', {timeout: 10000}, async t => {
  const f = await fixture(t), content = 'owned\n'.repeat(20000);
  let operation, captured, dispatched = false;
  const value = await bounded(f.policy.withWriteLocks(['a.txt'], {}, lease => {
    captured = lease;
    operation = f.otherPolicy.write(replacement('a', 'a0\n', content), {lease, beforeDispatch: () => {dispatched = true;}});
    operation.catch(() => {});
    return 'callback returned';
  }), 'draining admitted write');
  assert.equal(value, 'callback returned');
  await operation;
  assert.equal(dispatched, true);
  assert.equal(await f.text('a'), content);
  await assert.rejects(f.policy.write(replacement('a', content, 'late\n'), {lease: captured}), {code: 'invalid_write_lease'});
  await bounded(f.policy.write(replacement('a', content, 'next\n')), 'write after lease drain');
  assert.equal(await f.text('a'), 'next\n');
});
