import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Three stand-in Ollama servers: two "remote" machines and one playing this PC. Each can be told to break.
function fakeOllama(name, models) {
  const st = { name, mode: 'ok', chats: 0, last: null };
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/tags') { if (st.mode === 'down') return req.socket.destroy(); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ models: models.map(m => ({ name: m })) })); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
      st.chats++; st.last = JSON.parse(body);
      if (st.mode === 'down') return req.socket.destroy();
      if (st.mode === 'drive') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'read D:\\ollama\\models\\blobs\\x: A device which does not exist was specified.' })); }
      if (st.mode === 'midstream') { res.setHeader('Content-Type', 'application/x-ndjson'); res.write(JSON.stringify({ message: { content: 'half ' } }) + '\n'); return setTimeout(() => res.socket.destroy(), 20); }
      if (st.last.stream) { res.setHeader('Content-Type', 'application/x-ndjson'); res.write(JSON.stringify({ message: { content: `${name} ` } }) + '\n'); return res.end(JSON.stringify({ message: { content: 'streamed' }, done: true }) + '\n'); }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: { content: `from ${name} (${st.last.model})` } }));
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ st, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const home = await fakeOllama('home', ['qwen3:14b', 'llama3.1:8b']), vps = await fakeOllama('vps', ['qwen3:4b', 'llama3.2']), pc = await fakeOllama('pc', ['fraynix-dna:8b', 'qwen2.5-coder:7b']);
process.env.OLLAMA_BASE_URL = pc.url;
process.env.FRAYMUS_DEFAULT_MODEL = 'fraynix-dna:8b';
process.env.MODEL_HOSTS = `home=qwen3:14b@${home.url}|slots=2, local, vps=qwen3:4b@${vps.url}|slots=1|slow=3`;
const { parseHosts, poolChat, poolStream, modelPoolStatus, checkAllHosts } = await import('../server/intelligence/model-pool.js');
const readAll = async res => (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l).message.content).join('');
const reset = () => { for (const f of [home, vps, pc]) f.st.mode = 'ok'; };

test('a hosts list is read in order; public machines and bad entries are refused; this PC is always there', () => {
  const p = parseHosts('home=qwen3:14b@http://100.99.98.101:11434|slots=2, local, cloud=llama3@https://api.example.com, oops, kvm2=qwen3:4b@http://100.72.161.48:11434|slow=3');
  assert.deepEqual(p.hosts.map(h => h.name), ['home', 'local', 'kvm2']);
  assert.deepEqual(p.hosts.map(h => h.slots), [2, Infinity, 1]); assert.equal(p.hosts[2].slow, 3);
  assert.equal(p.hosts[0].think, false, 'qwen3 runs with thinking off');
  assert.deepEqual(p.refused.map(r => r.entry), ['cloud=llama3@https://api.example.com', 'oops']); assert.match(p.refused[0].reason, /public host/);
  assert.deepEqual(parseHosts('').hosts.map(h => h.name), ['local']);                                    // nothing configured: this PC only, as before
  assert.deepEqual(parseHosts('', { fallbackRemote: 'qwen3:14b@http://100.99.98.101:11434' }).hosts.map(h => h.name), ['remote', 'local']);
});

test('a default call goes to the first machine that answers, with that machine\'s model and thinking off', async () => {
  reset();
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from home (qwen3:14b)');
  assert.equal(home.st.last.think, false); assert.equal(home.st.last.keep_alive, '30m');
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }], { model: 'fraynix-dna:8b' }), 'from home (qwen3:14b)', 'naming the default model is the same as asking for the default');
});

test('the drive fault: the machine is rested and the call is answered by the next one, with nothing lost', async () => {
  reset(); home.st.mode = 'drive';
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from pc (fraynix-dna:8b)');
  const s = modelPoolStatus(), h = s.hosts.find(x => x.name === 'home');
  assert.equal(h.healthy, false); assert.match(h.why, /resting after: Ollama 500.*device which does not exist/);
  assert.ok(s.fallbacks >= 1); assert.match(s.lastFallback.reason, /home: .* → answered by local/);
  const before = home.st.chats; await poolChat([{ role: 'user', content: 'again' }]);
  assert.equal(home.st.chats, before, 'a resting machine is not asked again during its rest');
});

test('when this PC fails too, a slow last-resort machine answers; when every machine fails, the error names each', async () => {
  reset(); home.st.mode = 'drive'; pc.st.mode = 'down';
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from vps (qwen3:4b)');
  vps.st.mode = 'down';
  await checkAllHosts();
  await assert.rejects(() => poolChat([{ role: 'user', content: 'hi' }]), e => e.code === 'model_pool_exhausted');
  reset();
});

test('a named model goes only to machines that have it', async () => {
  reset(); await checkAllHosts();
  assert.equal(await poolChat([{ role: 'user', content: 'x' }], { model: 'qwen2.5-coder:7b' }), 'from pc (qwen2.5-coder:7b)');
  assert.equal(await poolChat([{ role: 'user', content: 'x' }], { model: 'llama3.2' }), 'from pc (llama3.2)', 'this PC is asked first for a named model, as it always was');
  pc.st.mode = 'down';
  assert.equal(await poolChat([{ role: 'user', content: 'x' }], { model: 'llama3.2' }), 'from vps (llama3.2)');
  assert.equal(await poolChat([{ role: 'user', content: 'x' }], { model: 'llama3.1:8b' }), 'from home (llama3.1:8b)');
  await assert.rejects(() => poolChat([{ role: 'user', content: 'x' }], { model: 'qwen2.5-coder:7b' }), e => e.code === 'model_pool_exhausted', 'nobody else has it');
  reset();
});

test('a stream that fails half-way is not repeated elsewhere; one that cannot start is', async () => {
  reset(); await checkAllHosts();
  assert.equal(await poolStream({ messages: [], stream: true }, {}, readAll), 'home streamed');
  home.st.mode = 'midstream';
  const pcBefore = pc.st.chats;
  await assert.rejects(() => poolStream({ messages: [], stream: true }, {}, readAll), e => e.started === true);
  assert.equal(pc.st.chats, pcBefore, 'half a reply was already shown: no second machine was asked');
  reset(); await checkAllHosts(); home.st.mode = 'drive';
  assert.equal(await poolStream({ messages: [], stream: true }, {}, readAll), 'pc streamed');
  reset();
  for (const f of [home, vps, pc]) f.srv.close();
});
