import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Three stand-in Ollama servers: two "remote" machines and one playing this PC. Each can be told to break.
function fakeOllama(name, models) {
  const st = { name, mode: 'ok', chats: 0, last: null, delay: 0 };
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/tags') { if (st.mode === 'down') return req.socket.destroy(); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ models: models.map(m => ({ name: m })) })); }
    let body = ''; req.on('data', d => { body += d; }); req.on('end', () => setTimeout(() => {
      st.chats++; st.last = JSON.parse(body);
      if (st.mode === 'down') return req.socket.destroy();
      if (st.mode === 'drive') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'read D:\\ollama\\models\\blobs\\x: A device which does not exist was specified.' })); }
      if (st.mode === 'midstream') { res.setHeader('Content-Type', 'application/x-ndjson'); res.write(JSON.stringify({ message: { content: 'half ' } }) + '\n'); return setTimeout(() => res.socket.destroy(), 20); }
      if (st.last.stream) { res.setHeader('Content-Type', 'application/x-ndjson'); res.write(JSON.stringify({ message: { content: `${name} ` } }) + '\n'); return res.end(JSON.stringify({ message: { content: 'streamed' }, done: true }) + '\n'); }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ message: { content: `from ${name} (${st.last.model})` }, ...(st.speed || {}) }));
    }, st.delay));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ st, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
const home = await fakeOllama('home', ['qwen3:14b', 'llama3.1:8b']), vps = await fakeOllama('vps', ['qwen3:4b', 'llama3.2']), pc = await fakeOllama('pc', ['fraynix-dna:8b', 'qwen2.5-coder:7b']);
process.env.OLLAMA_BASE_URL = pc.url;
process.env.FRAYMUS_DEFAULT_MODEL = 'fraynix-dna:8b';
process.env.MODEL_HOSTS = `home=qwen3:14b@${home.url}|slots=2, local, vps=qwen3:4b@${vps.url}|slots=1|slow=3`;
const { parseHosts, poolChat, poolStream, modelPoolStatus, checkAllHosts, resetPoolMeasurements, learnSpeed, estimateCall, tooSlow, deferrable } = await import('../server/intelligence/model-pool.js');
const readAll = async res => (await res.text()).split('\n').filter(Boolean).map(l => JSON.parse(l).message.content).join('');
const reset = () => { for (const f of [home, vps, pc]) f.st.mode = 'ok'; resetPoolMeasurements(); };

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
  // naming a model means that model, even when it is this PC's default: asking for fraynix-dna:8b was once answered by qwen3:14b
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }], { model: 'fraynix-dna:8b' }), 'from pc (fraynix-dna:8b)', 'a named model is answered by a machine that has it');
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
});

// From Grok's review (2026-11-12): fraymus-home paints and renders too; a language model must not be loaded onto its card mid-render.
test('a machine whose card is busy with something else is passed over, and used only when nothing else can answer', async () => {
  const { setHostGuard } = await import('../server/intelligence/model-pool.js');
  reset(); await checkAllHosts();
  let busy = 'home is rendering for the hub';
  setHostGuard(({ name }) => (name === 'home' ? busy : null));
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from pc (fraynix-dna:8b)');
  const s = modelPoolStatus().hosts.find(h => h.name === 'home');
  assert.equal(s.healthy, false); assert.equal(s.why, 'home is rendering for the hub'); assert.equal(s.keepAlive, '30m');
  pc.st.mode = 'down'; vps.st.mode = 'down'; await checkAllHosts();
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from home (qwen3:14b)', 'a busy machine still answers when it is the only one left');
  busy = null; reset(); await checkAllHosts();
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from home (qwen3:14b)');
  setHostGuard(() => { throw new Error('guard broke'); });
  assert.equal(await poolChat([{ role: 'user', content: 'hi' }]), 'from home (qwen3:14b)', 'a broken guard never blocks a call');
  setHostGuard(null);
  assert.equal(parseHosts('h=qwen3:14b@http://100.99.98.101:11434|keep=5m').hosts[0].keep, '5m');
  assert.equal(parseHosts('h=qwen3:14b@http://100.99.98.101:11434|keep=forever').hosts[0].keep, '30m');
});


// Measured 2026-11-12: fraymus-home idle at 5 s a call while calls queued on this PC (56 s) and the VPSs (262 s),
// because they arrived while home's slots were momentarily full. A full fast machine should be waited for.
test('a call waits for a busy fast machine rather than going to a free slow one', async () => {
  reset(); await checkAllHosts();
  // home is measured fast here, in this test — it used to pass only on timings leaked from earlier tests
  for (let i = 0; i < 3; i++) await poolChat([{ role: 'user', content: 'warm' }]);
  pc.st.delay = 600; for (let i = 0; i < 4; i++) await poolChat([{ role: 'user', content: 'x' }], { model: 'qwen2.5-coder:7b' });   // this PC is measured slow
  home.st.delay = 150;
  const before = pc.st.chats;
  const results = await Promise.all([0, 1, 2, 3].map(i => poolChat([{ role: 'user', content: `c${i}` }])));
  assert.deepEqual(results, Array(4).fill('from home (qwen3:14b)'), 'all four waited for the two slots on home');
  assert.equal(pc.st.chats, before, 'none went to the slow machine');
  pc.st.delay = 0; home.st.delay = 0;
});


test('a call is estimated from the machine\'s own reading and writing speed, and judged against its limit', () => {
  // Ollama's reply statistics: 2,000 prompt tokens read in 2 s, 400 written in 100 s → 1,000 read/s, 4 written/s
  const stat = { prompt_eval_count: 2000, prompt_eval_duration: 2e9, eval_count: 400, eval_duration: 100e9 };
  learnSpeed('slowpc', 'm', 'label-a', stat);
  const speed = modelPoolStatus().speeds.find(s => s.machine === 'slowpc');
  assert.deepEqual([speed.readTokensPerSecond, speed.writeTokensPerSecond], [1000, 4]);
  // 7,200 characters ≈ 2,000 tokens to read (2 s) + the label's typical 400-token reply (100 s) = 102 s
  assert.equal(estimateCall({ pps: 1000, gps: 4 }, { promptChars: 7200, maxTokens: 1200, typicalReply: 400 }), 102);
  assert.equal(estimateCall({ pps: 1000, gps: 4 }, { promptChars: 7200, maxTokens: 1200 }), 152, 'unknown caller: half its cap');
  assert.equal(estimateCall(null, { promptChars: 99 }), null, 'an unmeasured machine is not judged');
  assert.equal(tooSlow(160, 180_000), true); assert.equal(tooSlow(100, 180_000), false); assert.equal(tooSlow(null, 1000), false);
  assert.equal(deferrable('goal'), true); assert.equal(deferrable('dream'), true);
  assert.equal(deferrable('agent_run'), false); assert.equal(deferrable('interactive'), false);
  resetPoolMeasurements();
  assert.equal(modelPoolStatus().speeds.length, 0, 'measurements are forgotten between tests');
});

test('background work is not sent to a machine that cannot finish it in time: it fails at once, and nothing is spent', async () => {
  reset(); home.st.mode = 'drive'; vps.st.mode = 'down'; await checkAllHosts();
  // this PC reports itself slow: 4 tokens a second written (the 8 GB card running half of fraynix-dna on its CPU)
  pc.st.speed = { prompt_eval_count: 1000, prompt_eval_duration: 5e9, eval_count: 200, eval_duration: 50e9 };
  assert.equal(await poolChat([{ role: 'user', content: 'learn' }], { label: 'warm-up' }), 'from pc (fraynix-dna:8b)');
  // the goal engine's call: a long prompt and up to 1,200 tokens of reply, 180 s allowed → ~150 s+ estimated: left out
  const before = pc.st.chats, long = 'x'.repeat(9000);
  await assert.rejects(() => poolChat([{ role: 'user', content: long }], { label: 'goal-engine:motor', priority: 'goal', maxTokens: 1200, timeoutMs: 180_000 }),
    e => e.code === 'model_pool_too_slow' && /local: would need about \d+ s of 180 s/.test(e.message));
  assert.equal(pc.st.chats, before, 'the call was never sent: no card time spent on a call that would time out');
  assert.ok(modelPoolStatus().tooSlow >= 1);
  // a short background call still fits, and goes
  assert.equal(await poolChat([{ role: 'user', content: 'yes or no?' }], { label: 'scorer', priority: 'goal', maxTokens: 20 }), 'from pc (fraynix-dna:8b)');
  // an agent (or a person) waiting on an answer is not turned away: the slow machine is still tried
  assert.equal(await poolChat([{ role: 'user', content: long }], { label: 'agent', priority: 'agent_run', maxTokens: 1200, timeoutMs: 180_000 }), 'from pc (fraynix-dna:8b)');
  pc.st.speed = null; reset();
});

test.after(() => { for (const f of [home, vps, pc]) f.srv.close(); });
