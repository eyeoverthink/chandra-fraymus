import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { execFile } from 'node:child_process';
import { db, logEvent } from './db.js';
import { syncAll, readNodeLog, TAILSCALE_BIN } from './sync.js';
import { HOST, PORT, OLLAMA_URL } from './config.js';
import { localBoundary, allowedRequest } from './local-http.js';
import { installRuntime, apiError } from './runtime.js';
import { installStatic } from './static.js';
import { listenThenInitialize } from './lifecycle.js';
import { modelForAgent, replyWithModel } from './brain.js';
import { ingestFleetSnapshot } from './fleet.js';
import {
  ensureV3Initialized,
  getV3State,
  generateCanary,
  verifyCanary,
  clearNonceRegistry,
  setSecurityBits,
  resetV3Chain,
  runAttack,
  runAllAttacks,
  exportV3WasmBinary,
  exportV3DbJson,
} from './v3.js';

const app = express();
let ready=false,runtime=null,stopping=false;
const backgroundCalls=new Set();
function background(work) {
  if(stopping)return Promise.resolve();
  const promise=Promise.resolve().then(()=>{if(!stopping)return work();}).catch(error=>console.error(`Owned background work failed: ${error.message}`));
  backgroundCalls.add(promise);promise.then(()=>backgroundCalls.delete(promise));return promise;
}
app.use((_req,res,next)=>ready?next():res.status(503).json({error:'Local runtime is starting or stopping'}));
app.use(localBoundary);
app.use('/api/agent/assets', express.json({ limit: '6mb' }));
app.use('/api/voice/listen', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '1mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => ready&&allowedRequest(req) });
const broadcast = (type, payload) => {
  const s = JSON.stringify({ type, payload });
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
const runtimeRoutes=express.Router();
app.use(runtimeRoutes);

// ---------- Agents ----------
app.get('/api/agents', (_req, res) => {
  res.json(db.prepare('SELECT * FROM agents ORDER BY name').all());
});

app.patch('/api/agents/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE agents SET status = ?, last_seen = ? WHERE id = ?')
    .run(status, Date.now(), req.params.id);
  broadcast('agents', { id: req.params.id });
  res.json({ ok: true });
});

// ---------- Agent mail ----------
app.get('/api/mail', (req, res) => {
  const { to, limit = 100 } = req.query;
  const rows = to
    ? db.prepare('SELECT * FROM mail WHERE to_agent = ? OR from_agent = ? ORDER BY created_at DESC LIMIT ?').all(to, to, limit)
    : db.prepare('SELECT * FROM mail ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json(rows);
});

app.post('/api/mail', (req, res) => {
  const { from, to, subject = '', body } = req.body;
  if (!from || !to || !body) return res.status(400).json({ error: 'from, to, body required' });
  const info = db.prepare('INSERT INTO mail (from_agent, to_agent, subject, body, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(from, to, subject, body, Date.now());
  logEvent('mail', from, `→ ${to}: ${subject || body.slice(0, 60)}`);
  broadcast('mail', { id: info.lastInsertRowid });
  broadcast('event', {});
  res.status(201).json({ id: info.lastInsertRowid });

  const model = modelForAgent(to);
  if (model) background(() => replyWithModel({ model, to: from, subject, messageId: Number(info.lastInsertRowid), broadcast }));
});

app.patch('/api/mail/:id/read', (req, res) => {
  db.prepare("UPDATE mail SET status = 'read' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- Sessions ----------
app.get('/api/sessions', (_req, res) => {
  res.json(db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 100').all());
});

app.post('/api/sessions', (req, res) => {
  const { id, agent_id, title = '', model = '' } = req.body;
  if (!id || !agent_id) return res.status(400).json({ error: 'id, agent_id required' });
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, agent_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, agent_id, title, model, now, now);
  logEvent('session.new', agent_id, title || id);
  broadcast('event', {});
  res.status(201).json({ id });
});

// ---------- Activity feed ----------
app.get('/api/events', (req, res) => {
  const { limit = 100 } = req.query;
  res.json(db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit));
});

// ---------- Memory / KV ----------
app.get('/api/memory', (_req, res) => {
  res.json(db.prepare('SELECT * FROM memory ORDER BY updated_at DESC').all());
});

app.put('/api/memory/:key', (req, res) => {
  const { value } = req.body;
  db.prepare('INSERT INTO memory (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(req.params.key, JSON.stringify(value ?? null), Date.now());
  broadcast('memory', { key: req.params.key });
  res.json({ ok: true });
});

// ---------- Fraymus V3 Bulletproof Recursive ----------
app.get('/api/v3/state', (_req, res) => {
  res.json(getV3State());
});

app.post('/api/v3/canary', (req, res) => {
  const state = generateCanary({ rotateSecret: Boolean(req.body?.rotateSecret) });
  broadcast('v3', {});
  broadcast('event', {});
  res.json(state);
});

app.post('/api/v3/verify', (req, res) => {
  const verdict = verifyCanary(req.body?.canary, {
    wrongSecret: Boolean(req.body?.wrongSecret),
    truncatedCarrier: Boolean(req.body?.truncatedCarrier),
    recordNonce: req.body?.recordNonce !== false,
  });
  logEvent(`v3.verify.${verdict.status}`, 'fraymus-v3', verdict.message.slice(0, 140));
  broadcast('v3', {});
  broadcast('event', {});
  res.json({ verdict, state: getV3State() });
});

app.post('/api/v3/nonces/clear', (_req, res) => {
  const state = clearNonceRegistry();
  broadcast('v3', {});
  broadcast('event', {});
  res.json(state);
});

app.post('/api/v3/security-level', (req, res) => {
  const state = setSecurityBits(req.body?.bits);
  broadcast('v3', {});
  broadcast('event', {});
  res.json(state);
});

app.post('/api/v3/attack/run-all', (_req, res) => {
  const state = runAllAttacks();
  broadcast('v3', {});
  broadcast('event', {});
  res.json(state);
});

app.post('/api/v3/attack/:id', (req, res) => {
  try {
    const state = runAttack(req.params.id);
    broadcast('v3', {});
    broadcast('event', {});
    res.json(state);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

app.post('/api/v3/reset', (_req, res) => {
  const state = resetV3Chain();
  broadcast('v3', {});
  broadcast('event', {});
  res.json(state);
});

app.get('/api/v3/export/wasm', (_req, res) => {
  const wasm = exportV3WasmBinary();
  res.setHeader('Content-Type', 'application/wasm');
  res.setHeader('Content-Disposition', 'attachment; filename="fraymus-dna.wasm"');
  res.send(wasm);
});

app.get('/api/v3/export/db', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="fraynix-dna-db.json"');
  res.send(JSON.stringify(exportV3DbJson(), null, 2));
});

app.get('/api/v3/export/chain', (_req, res) => {
  const state = getV3State();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="fraynix-genesis-chain.json"');
  res.send(JSON.stringify({
    chain: state.genesisChain,
    verification: 'Each block previousHash timestamp attackPattern dnaMutation evolutionScore hash HMAC chain verification',
    length: state.genesisChain.length,
    chainValid: state.stats.chainValid,
    wasmMagic: '0x00 0x61 0x73 0x6d',
  }, null, 2));
});

// ---------- Tools (MCP-style registry; allowlisted commands only) ----------
const TOOLS = {
  'node.status':    { desc: 'OpenClaw node service status',    cmd: 'openclaw', args: ['node', 'status'] },
  'node.log':       { desc: 'Tail of the configured local node host log', internal: () => readNodeLog(20) },
  'gateway.probe':  { desc: 'Probe configured gateway',        cmd: 'openclaw', args: ['gateway', 'probe'] },
  'ollama.list':    { desc: 'Installed Ollama inventory (may include blocked remote entries)', internal: () => ollamaStatus('/api/tags') },
  'ollama.ps':      { desc: 'Loaded Ollama models', internal: () => ollamaStatus('/api/ps') },
  'tailscale.who':  { desc: 'Tailnet peers', cmd: TAILSCALE_BIN, args: ['status'] },
  'v3.audit':       { desc: 'Legacy V3 simulation (not a security certification)', internal: () => {
    const s = runAllAttacks();
    broadcast('v3', {});
    return `FRAYMUS V3 BULLETPROOF RECURSIVE AUDIT\nTrust: ${s.trust}% | Coverage: ${s.coverage}% | Security: ${s.securityLevel} (${s.secBits}-bit)\nGenesis Blocks: ${s.stats.genesisLength} (Chain valid: ${s.stats.chainValid})\nAttacks: ${s.stats.passCount} PASS / ${s.stats.vulnCount} VULN / ${s.stats.totalAttacks} total\nDNA: 256x64-bit (16384 dims) · avg sim=${s.dna.avgSimilarity} · next pred=${s.predictor.next} (${s.predictor.conf}%)`;
  }},
};

app.get('/api/tools', (_req, res) => {
  res.json(Object.entries(TOOLS).map(([id, t]) => ({ id, desc: t.desc })));
});

async function ollamaStatus(path) {
  const response = await fetch(OLLAMA_URL + path, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  return JSON.stringify(await response.json(), null, 2).slice(0, 24000);
}
app.post('/api/tools/:id/run', async (req, res) => {
  const tool = Object.hasOwn(TOOLS, req.params.id) ? TOOLS[req.params.id] : null;
  if (!tool) return res.status(404).json({ error: 'unknown tool' });
  if (tool.internal) {
    let output;
    try { output = await tool.internal(); }
    catch (error) { return res.status(503).json({ id: req.params.id, ok: false, output: error.message }); }
    logEvent('tool.run', 'ui', `${req.params.id} ok`);
    broadcast('event', {});
    return res.json({ id: req.params.id, ok: true, output });
  }
  execFile(tool.cmd, tool.args, { timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout, stderr) => {
    const output = (stdout + (stderr ? '\n' + stderr : '')).slice(0, 24000);
    logEvent('tool.run', 'ui', `${req.params.id} ${err ? 'FAILED' : 'ok'}`);
    broadcast('event', {});
    res.json({ id: req.params.id, ok: !err, output: output || (err ? String(err) : '(no output)') });
  });
});

// ---------- Static (production) ----------
installStatic(app);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route' }));
app.use(apiError);

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', payload: { ts: Date.now() } }));
});

// Real-state bridge: poll tailnet / node / ollama every 15s
const SYNC_MS = 15000;
let syncing=null;
const doSync = () => {
  if(syncing)return syncing;
  syncing=background(async()=>{
    try { ensureV3Initialized(); } catch {}
    try { ingestFleetSnapshot(); } catch {}
    await syncAll();
    broadcast('agents', {});broadcast('memory', {});broadcast('event', {});
  }).finally(()=>{syncing=null;});
  return syncing;
};
let syncTimer;
async function stop() {
  if(stopping)return;stopping=true;ready=false;clearInterval(syncTimer);
  if(runtime) {
    let closed=await runtime.close();
    while(!closed.safeToCloseDatabase) {
      console.error('Waiting for owned runtime callbacks before closing the database.');
      await new Promise(resolve=>setTimeout(resolve,1000));closed=await runtime.close();
    }
  }
  await Promise.allSettled([...backgroundCalls]);
  for (const client of wss.clients) client.terminate();
  server.close(() => { db.close(); process.exit(0); });
}
process.once('SIGTERM',()=>{stop().catch(error=>{console.error(error);process.exitCode=1;});});
process.once('SIGINT',()=>{stop().catch(error=>{console.error(error);process.exitCode=1;});});
listenThenInitialize(server,{host:HOST,port:PORT,initialize:async()=>{
  if(stopping)throw new Error('Startup was cancelled');
  runtime=installRuntime(runtimeRoutes,{db,broadcast});
  runtimeRoutes.use(apiError);
  await runtime.tasks.start();
  if(stopping)return;
  if(process.env.FRAYMUS_AUTONOMY_AUTOSTART !== '0') {
    try { await runtime.autonomy.start(); } catch(e) { console.error(`Autonomy engine deferred: ${e.message}`); }
  }
  ready=true;
  logEvent('server.start','chandra-fraymus',`listening :${PORT} · autonomy=${runtime.autonomy.running}`);
  console.log(`Chandra + FRAYMUS on http://${HOST}:${PORT} (ws: /ws) · Autonomy: ${runtime.autonomy.running ? 'ACTIVE' : 'standby'}`);
  doSync();syncTimer=setInterval(doSync,SYNC_MS);
}}).catch(async error=>{
  if(stopping)return;
  ready=false;console.error(`Local runtime did not start: ${error.message}`);
  for(const client of wss.clients)client.terminate();
  if(runtime){let closed=await runtime.close();while(!closed.safeToCloseDatabase){await new Promise(resolve=>setTimeout(resolve,1000));closed=await runtime.close();}}
  server.closeAllConnections();db.close();process.exitCode=1;
});
