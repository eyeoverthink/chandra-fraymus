import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkers } from '../server/media/workers.js';

test('a worker can be reached through SSH: the hub talks to a local port, the worker stays on its own loopback', () => {
  const r = parseWorkers('home=ssh://eyeov@100.99.98.101:47210, lan=http://10.0.0.5:47210, other=ssh://me@192.168.1.9:5000');
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.workers.map(w => [w.name, w.url, w.host]), [['home', 'http://127.0.0.1:47300', '100.99.98.101'], ['lan', 'http://10.0.0.5:47210', '10.0.0.5'], ['other', 'http://127.0.0.1:47302', '192.168.1.9']]);
  assert.deepEqual(r.workers[0].tunnel, { user: 'eyeov', host: '100.99.98.101', remotePort: 47210, localPort: 47300 });
  assert.equal(r.workers[1].tunnel, undefined);
});

test('SSH workers obey the same rules: private hosts only, well-formed, no duplicates', () => {
  const r = parseWorkers('web=ssh://root@example.com:22, bad=ssh://nouser:47210, a=ssh://u@100.64.0.9:47210, a=ssh://u@100.64.0.10:47210, odd=ssh://u@100.64.0.9:47210/path');
  assert.deepEqual(r.workers.map(w => w.name), ['a']);
  assert.deepEqual(r.refused.map(x => x.entry), ['web', 'bad=ssh://nouser:47210', 'a', 'odd=ssh://u@100.64.0.9:47210/path']);
  assert.match(r.refused[0].reason, /public host/);
});
