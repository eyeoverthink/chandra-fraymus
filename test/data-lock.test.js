import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { acquireDataLock } from '../server/data-lock.js';

const moduleUrl = new URL('../server/data-lock.js', import.meta.url).href;
async function folder(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'chandra-lock-'));
  t.after(() => fs.rmdir(value)); return value;
}
function child(code, args = []) {
  return spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
}

test('same resolved data directory has one OS owner independently of HTTP port', async t => {
  const dir = await folder(t), first = await acquireDataLock(dir); t.after(() => first.release());
  await assert.rejects(acquireDataLock(path.join(dir, '.')), {code: 'data_directory_in_use'});
  if (process.platform === 'win32') await assert.rejects(acquireDataLock(dir.toUpperCase()), {code: 'data_directory_in_use'});
  const contender = child(`import {acquireDataLock} from ${JSON.stringify(moduleUrl)};try{await acquireDataLock(process.argv[1]);process.send('wrong-owner');}catch(e){process.send(e.code);}`, [dir]);
  const message = await once(contender, 'message'); assert.equal(message[0], 'data_directory_in_use'); await once(contender, 'exit');
  await first.release(); const replacement = await acquireDataLock(dir); await replacement.release();
});

test('different data directories remain independently owned', async t => {
  const one = await folder(t), two = await folder(t), first = await acquireDataLock(one), second = await acquireDataLock(two);
  assert.notEqual(first.identity, second.identity); assert.notEqual(first.address, second.address);
  await first.release(); await second.release();
});

test('a crashed owner releases its Windows/Linux OS lock without lease stealing', {skip: !['win32','linux'].includes(process.platform)}, async t => {
  const dir = await folder(t), owner = child(`import {acquireDataLock} from ${JSON.stringify(moduleUrl)};await acquireDataLock(process.argv[1]);process.send('owned');setInterval(()=>{},10000);`, [dir]);
  t.after(() => {if(owner.exitCode === null) owner.kill();});
  assert.equal((await once(owner, 'message'))[0], 'owned');
  await assert.rejects(acquireDataLock(dir), {code: 'data_directory_in_use'});
  const exited = once(owner, 'exit'); owner.kill(); await exited;
  const replacement = await acquireDataLock(dir); await replacement.release();
});

test('the entrypoint obtains ownership before loading database recovery dependencies', async () => {
  const source = await fs.readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await acquireDataLock(DATA_DIR)') < source.indexOf("await import('./app.js')"));
  assert.ok(!/from ['"]\.\/(?:db|app|runtime|sync|brain|v3)\.js['"]/.test(source));
});

test('a second real entrypoint cannot open or recover an owned database using another HTTP port', {timeout: 10000}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chandra-lock-')), sentinel = path.join(dir, 'chandra.db'), original = Buffer.from('Do not open, migrate or recover this owned fixture database.');
  await fs.writeFile(sentinel, original);
  const owner = await acquireDataLock(dir);
  const contender = spawn(process.execPath, [fileURLToPath(new URL('../server/index.js', import.meta.url))], {
    env: {...process.env, CHANDRA_DATA_DIR: dir, PORT: '54321'}, windowsHide: true, stdio: ['ignore','pipe','pipe'],
  });
  t.after(async () => {if(contender.exitCode === null) contender.kill(); await owner.release(); await fs.unlink(sentinel); await fs.rmdir(dir);});
  let error = ''; contender.stderr.setEncoding('utf8'); contender.stderr.on('data', chunk => {error += chunk;});
  assert.equal((await once(contender, 'exit'))[0], 1); assert.match(error, /data_directory_in_use/);
  assert.deepEqual(await fs.readFile(sentinel), original); assert.deepEqual((await fs.readdir(dir)).sort(), ['chandra.db']);
});
