import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenThenInitialize } from '../server/lifecycle.js';

const HOST = '127.0.0.1';
async function close(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve, reject) => server.close(caught => caught ? reject(caught) : resolve()));
}
function server(t, body = 'isolated lifecycle fixture') {
  const value = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }); response.end(body); });
  t.after(() => close(value)); return value;
}
async function listen(value, port = 0) {
  const ready = once(value, 'listening'); value.listen(port, HOST); await ready; return value.address().port;
}
async function read(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: HOST, port, path: '/', agent: false, headers: { connection: 'close' } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, text })); response.on('error', reject);
    }); request.setTimeout(2000, () => request.destroy(new Error('Isolated HTTP fixture timed out'))); request.on('error', reject);
  });
}

test('an occupied loopback port rejects before initialization and leaves durable run/job sentinels untouched', async t => {
  const root = fileURLToPath(new URL('../../work/', import.meta.url)); await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, 'lifecycle-')), stateFile = path.join(directory, 'durable-sentinels.json');
  const sentinels = Buffer.from(JSON.stringify({ runs: [{ id: 'sentinel-run', status: 'running' }], jobs: [{ id: 'sentinel-job', status: 'active', runsStarted: 3, usedTokens: 42 }] }));
  await fs.writeFile(stateFile, sentinels); const before = await fs.stat(stateFile);
  t.after(async () => { await fs.unlink(stateFile); await fs.rmdir(directory); }); // Exact owned file/directory only; no recursive cleanup.
  const owner = server(t, 'port owner'), port = await listen(owner), contender = server(t, 'must never listen'); let calls = 0;
  await assert.rejects(listenThenInitialize(contender, { host: HOST, port, initialize: async () => {
    calls++; await fs.writeFile(stateFile, JSON.stringify({ runs: [{ status: 'interrupted' }], jobs: [{ status: 'attention' }] })); return { initialized: true };
  } }), caught => caught.code === 'EADDRINUSE');
  assert.equal(calls, 0); assert.equal(contender.listening, false); assert.deepEqual(await fs.readFile(stateFile), sentinels);
  assert.equal((await fs.stat(stateFile)).mtimeMs, before.mtimeMs); assert.deepEqual(await read(port), { status: 200, text: 'port owner' });
});

test('successful socket ownership initializes exactly once after the listening event and awaits initialization', async t => {
  const value = server(t), events = []; let calls = 0, release, observedPort, resolved = false;
  let enteredResolve; const entered = new Promise(resolve => { enteredResolve = resolve; });
  value.once('listening', () => events.push('listening'));
  const result = { initialized: true, token: 'isolated fixture result' };
  const startup = listenThenInitialize(value, { host: HOST, port: 0, initialize: async () => {
    calls++; events.push('initialize'); assert.equal(value.listening, true); observedPort = value.address().port; assert.ok(observedPort > 0);
    enteredResolve();
    await new Promise(resolve => { release = resolve; }); return result;
  } }); startup.then(() => { resolved = true; });
  await entered;
  assert.equal(calls, 1); assert.equal(resolved, false); assert.deepEqual(events, ['listening','initialize']);
  assert.equal((await read(observedPort)).status, 200); release(); assert.equal(await startup, result);
  await read(observedPort); assert.equal(calls, 1); assert.equal(resolved, true);
});

for (const asynchronous of [false,true]) test(`${asynchronous ? 'asynchronous' : 'synchronous'} initializer failure closes its listener and never resolves startup success`, async t => {
  const value = server(t), failure = Object.assign(new Error('Synthetic isolated initialization failure'), { code: 'FIXTURE_INITIALIZATION_FAILED' });
  let calls = 0, ownedPort, closed = false, resolved = false; value.once('close', () => { closed = true; });
  const listenerClosed = once(value, 'close');
  const initialize = () => { calls++; assert.equal(value.listening, true); ownedPort = value.address().port; if (asynchronous) return Promise.resolve().then(() => { throw failure; }); throw failure; };
  const startup = listenThenInitialize(value, { host: HOST, port: 0, initialize });
  const observed = startup.then(() => { resolved = true; }, caught => { throw caught; });
  await assert.rejects(observed, caught => caught === failure);
  await listenerClosed; // Failure notification and socket drain are separate owner responsibilities.
  assert.equal(calls, 1); assert.equal(resolved, false); assert.equal(closed, true); assert.equal(value.listening, false); assert.equal(value.address(), null);
  const replacement = server(t); assert.equal(await listen(replacement, ownedPort), ownedPort); assert.equal((await read(ownedPort)).status, 200);
});

test('initialization failure rejects promptly while an owned HTTP response remains open, then drains after release', { timeout: 5000 }, async t => {
  let heldResponse, client, clientResponse, calls = 0, closed = false, resolved = false;
  const value = http.createServer((request, response) => {
    heldResponse = response; response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }); response.write('held response');
  });
  t.after(async () => { client?.destroy(); await close(value); });
  value.once('close', () => { closed = true; }); const listenerClosed = once(value, 'close');
  const failure = Object.assign(new Error('Synthetic failure with a held isolated client'), { code: 'FIXTURE_HELD_CLIENT_FAILURE' });
  const startup = listenThenInitialize(value, { host: HOST, port: 0, initialize: async () => {
    calls++; assert.equal(value.listening, true);
    clientResponse = await new Promise((resolve, reject) => {
      client = http.get({ host: HOST, port: value.address().port, path: '/', agent: false, headers: { connection: 'close' } }, response => {
        response.on('error', reject); response.resume(); resolve(response);
      }); client.on('error', reject);
    });
    throw failure;
  } });
  const rejected = assert.rejects(startup.then(() => { resolved = true; }), caught => caught === failure);
  let deadline;
  try {
    await Promise.race([rejected, new Promise((resolve, reject) => { deadline = setTimeout(() => reject(new Error('Startup failure waited for its held client instead of reaching the owner')), 1500); })]);
  } finally { clearTimeout(deadline); }
  assert.equal(calls, 1); assert.equal(resolved, false); assert.equal(closed, false); assert.equal(value.listening, false);
  assert.equal(heldResponse.writableEnded, false); assert.equal(clientResponse.complete, false); assert.equal(client.destroyed, false);
  const responseEnded = once(clientResponse, 'end'); heldResponse.end(' released'); await responseEnded; client.destroy(); await listenerClosed;
  assert.equal(closed, true); assert.equal(value.address(), null);
});
