import express from 'express';
import { join } from 'node:path';
import { createAgentService } from './agent/service.js';
import { createArtifactStore, MAX_ASSET_BYTES, ASSET_MIME_TYPES } from './artifacts.js';
import { createExtensionTools, transportBenchmark } from './extension-tools.js';
import { vectorBenchmark } from './transport/vectors.js';
import { DATA_DIR, WORKSPACE_ROOT, OLLAMA_URL, VOICE_URL } from './config.js';
import { configuredCodeExecutor } from './sandbox/config.js';
import { createWebResearch } from './web/research.js';
import { transcribeAudio, validateListenRequest } from './audio.js';
import { createDesktopBroker } from './desktop/broker.js';
import { configuredDesktopDriver } from './desktop/config.js';
import { createTaskScheduler } from './tasks/scheduler.js';
import { createTaskTools } from './tasks/tools.js';
import { createEmbeddingProvider } from './retrieval/embedding.js';
import { createSemanticIndexStore } from './retrieval/index-store.js';
import { createSemanticTools } from './retrieval/tools.js';
import {createLocalVisionProvider} from './vision/local.js';
import {createVisionTools} from './vision/tools.js';
import {createLocalOcrProvider} from './ocr/local.js';
import {createOcrTools} from './ocr/tools.js';
import { createFraymusTools, MemoryBridge, heart, ledger } from './fraymus-tools.js';
import { createAutonomyEngine } from './autonomy.js';
import { installFraymusRoutes } from './fraymus-routes.js';
import { createWorkflowStore, installWorkflowRoutes } from './workflow/routes.js';
import { createFleetTools } from './fleet/tools.js';
import { initFleet, setFleetTools } from './fleet/runtime.js';
import { installFleetRoutes } from './fleet/routes.js';
import { installMcpEndpoint } from './mcp/server.js';
import { installOAuthRoutes, installAccessRoutes } from './mcp/auth.js';
import { getImportedTools } from './mcp/client.js';
import { createBrowserTools } from './browser/tools.js';
import { installBrowserRoutes } from './browser/routes.js';
import { installExtensionRoutes } from './browser/extension-bridge.js';
import { VertisoMemory } from './vertiso/memory.js';
import { createVertisoTools } from './vertiso/tools.js';
import { RSIEngine } from './vertiso/rsi.js';
import { createRSITools } from './vertiso/rsi-tools.js';
import { installVertisoRoutes } from './vertiso/routes.js';
import { createYouTubeTools } from './youtube/tools.js';
import { installYouTubeRoutes } from './youtube/routes.js';
import { setYouTubeMemoryBridge } from './youtube/service.js';
import { createCommerceTools } from './commerce/tools.js';
import { installCommerceRoutes } from './commerce/routes.js';
import { installCommandRouter } from './command-router.js';

export function cloudConfig() {
  if (process.env.FRAYMUS_CLOUD_ENABLED !== '1') return { enabled: false };
  let models;
  try { models = JSON.parse(process.env.FRAYMUS_CLOUD_MODELS_JSON || '{}'); }
  catch { throw new Error('FRAYMUS_CLOUD_MODELS_JSON must contain a server-owned model and price allowlist'); }
  return { enabled: true, apiKey: process.env.OPENAI_API_KEY, models,
    maxRunCostUsd: Number(process.env.FRAYMUS_CLOUD_MAX_RUN_USD || 1) };
}
export function installRuntime(app, { db, broadcast, workspace = WORKSPACE_ROOT, dataDir = DATA_DIR,
  ollamaUrl = OLLAMA_URL, voiceUrl = VOICE_URL, cloud = cloudConfig(), fetchImpl = fetch,
  codeExecutor = configuredCodeExecutor({ dataDir }), webRequestImpl, desktopDriver = configuredDesktopDriver({dataDir}), taskClock=Date.now, embeddingProvider, localVisionProvider, localOcrProvider }) {
  const artifacts = createArtifactStore(join(dataDir, 'assets'), {
    recognizeAudio: (data, { signal } = {}) => transcribeAudio(data, { voiceUrl, fetchImpl, signal }),
  });
  const semanticStore=createSemanticIndexStore({db});
  const embeddings=embeddingProvider??createEmbeddingProvider({url:ollamaUrl,fetchImpl});
  const localVision=localVisionProvider??createLocalVisionProvider({url:ollamaUrl,fetchImpl});
  const localOcr=localOcrProvider??createLocalOcrProvider();
  let agent;
  const tasks=createTaskScheduler({db,autoStart:false,now:taskClock,onEvent:event=>broadcast('tasks',event),agent:{
    start:input=>agent.startScheduled(input),get:id=>agent.get(id),getByRequestId:id=>agent.getByRequestId(id),
    cancel:id=>agent.cancel(id),isBusy:()=>agent.isBusy()
  }});
  const desktop = createDesktopBroker({db,driver:desktopDriver,onRevoke:(id,state)=>agent?.endDesktopRun(id,state),onReceipt:(id,receipt)=>agent?.recordDesktopReceipt(id,receipt)});
  const workflowStore = createWorkflowStore();
  const fleetTools = createFleetTools({ workflowStore });
  let mcpImported = [];
  try { mcpImported = getImportedTools(); } catch (e) { console.error('runtime: MCP tool import failed:', e.message); }
  let browserTools = [];
  try { browserTools = createBrowserTools(); } catch (e) { console.error('runtime: browser tools failed:', e.message); }
  const vertiso = new VertisoMemory({ db, ollamaUrl });
  const memoryBridge = new MemoryBridge(vertiso);
  const web = createWebResearch({ db, ...(webRequestImpl ? { requestPage: webRequestImpl } : {}), memoryBridge });
  const rsi = new RSIEngine({ db, vertiso, ollamaUrl, broadcast });
  let vertisoTools = [];
  try { vertisoTools = [...createVertisoTools(vertiso), ...createRSITools(rsi)]; } catch (e) { console.error('runtime: vertiso/RSI tools failed:', e.message); }
  setYouTubeMemoryBridge(memoryBridge);
  let youtubeTools = [];
  try { youtubeTools = createYouTubeTools(); } catch (e) { console.error('runtime: youtube tools failed:', e.message); }
  let commerceTools = [];
  try { commerceTools = createCommerceTools({ memoryBridge }); } catch (e) { console.error('runtime: commerce tools failed:', e.message); }
  agent = createAgentService({ db, workspace, ollamaUrl, fetchImpl,
    cloud, codeExecutor, desktopBroker:desktop, extraTools: [...createExtensionTools(artifacts, web),...desktop.tools(),
      ...createTaskTools({scheduler:tasks,db,now:taskClock,onReceipt:(id,receipt)=>agent?.recordTaskReceipt(id,receipt)}),
      ...createSemanticTools({artifacts,store:semanticStore,embedder:embeddings}),...createVisionTools({artifacts,provider:localVision}),...createOcrTools({artifacts,provider:localOcr}),...createFraymusTools(),
      ...fleetTools, ...mcpImported, ...browserTools, ...vertisoTools, ...youtubeTools, ...commerceTools],
    resolveAttachments: (ids, options) => artifacts.resolve(ids, options),
    onEvent: event => {
      if(agent&&['usage','auxiliary_usage'].includes(event.type)) {
        try { tasks.reconcileUsage(agent.get(event.runId)); }
        catch(error) { broadcast('tasks',{type:'task_usage_sync_error',runId:event.runId,code:error.code??'task_usage_unknown'}); }
      }
      if (event.type === 'completed' && event.data?.output) {
        try {
          const feeling = heart.feel(event.data.output.slice(0, 500));
          ledger.record('agent.completed', { runId: event.runId, primary: feeling.primary, intensity: feeling.intensity }, 'agent');
          if (feeling.intensity > 0.3) memoryBridge.storeHeartReading(feeling).catch(() => {});
          memoryBridge.storeCognitionResult({ phase: 'agent_run', feeling, response: event.data.output.slice(0, 200), durationMs: 0 }).catch(() => {});
        } catch (_) {}
      }
      broadcast('agent',event);
    } });
  const autonomy = createAutonomyEngine({ db, broadcast, agent: { get: id => agent.get(id) }, tasks, memoryBridge, logEvent: (kind, actor, detail) => {
    try { db.prepare('INSERT INTO events (kind, actor, detail, created_at) VALUES (?, ?, ?, ?)').run(kind, actor, detail, Date.now()); } catch (e) { console.error('runtime: event insert failed:', e.message); }
  }});
  installFraymusRoutes(app, { autonomy, broadcast, memoryBridge });
  installWorkflowRoutes(app, { broadcast, memoryBridge });
  installFleetRoutes(app);
  installMcpEndpoint(app);
  installOAuthRoutes(app);
  installAccessRoutes(app);
  installBrowserRoutes(app);
  installExtensionRoutes(app);
  installVertisoRoutes(app, { vertiso, rsi });
  installYouTubeRoutes(app);
  installCommerceRoutes(app, { memoryBridge });
  installCommandRouter(app, { broadcast });

  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const known = id => {
    const run = agent.get(id);
    if (!run) throw Object.assign(new Error('Unknown run'), { code: 'run_not_found', status: 404 });
    return run;
  };
  const knownTask=id=>{const task=tasks.get(id);if(!task)throw Object.assign(new Error('Unknown scheduled task'),{code:'task_not_found',status:404});return task;};
  app.get('/api/tasks',(_req,res)=>res.json({tasks:tasks.list(),localOnly:true,requiresAppRunning:true}));
  app.post('/api/tasks/preview',route((req,res)=>res.json(tasks.preview(req.body))));
  app.post('/api/tasks',route(async(req,res)=>res.status(201).json(await tasks.create(req.body))));
  app.get('/api/tasks/:id',route((req,res)=>res.json(knownTask(req.params.id))));
  app.post('/api/tasks/:id/update',route(async(req,res)=>{knownTask(req.params.id);res.json(await tasks.update(req.params.id,req.body));}));
  for(const operation of ['pause','resume','archive']) app.post(`/api/tasks/:id/${operation}`,route(async(req,res)=>{knownTask(req.params.id);res.json(await tasks[operation](req.params.id,req.body));}));
  app.get('/api/task-requests/:id',route((req,res)=>{const value=tasks.request(req.params.id);if(!value)throw Object.assign(new Error('Unknown task request'),{code:'task_request_not_found',status:404});res.json(value);}));
  app.post('/api/task-requests/:id/cancel',route(async(req,res)=>{
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new Error('Task request cancellation accepts an empty object only');
    res.json(await tasks.cancelRequest(req.params.id));
  }));
  app.get('/api/desktop/health',route(async(_req,res)=>res.json(await desktop.health())));
  app.get('/api/desktop/windows',route(async(_req,res)=>res.json(await desktop.windows())));
  app.post('/api/desktop/sessions',route(async(req,res)=>res.status(201).json(await desktop.createSession(req.body))));
  app.get('/api/desktop/sessions/:id',route((req,res)=>res.json(desktop.session(req.params.id))));
  app.post('/api/desktop/sessions/:id/preview',route(async(req,res)=>{if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)throw new Error('Preview accepts an empty JSON object only');res.json(await desktop.preview(req.params.id));}));
  app.post('/api/desktop/sessions/:id/revoke',route(async(req,res)=>res.json(await desktop.revoke(req.params.id))));
  app.get('/api/desktop/session-requests/:id',route((req,res)=>res.json(desktop.request(req.params.id))));
  app.post('/api/desktop/session-requests/:id/revoke',route(async(req,res)=>res.json(await desktop.revokeRequest(req.params.id))));
  app.get('/api/desktop/snapshots/:id/image',route((req,res)=>{res.setHeader('Cache-Control','no-store');res.type('image/png').send(desktop.image(req.params.id));}));
  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'Chandra / Fraymus',
    workspace, localDefault: true, cloudConfigured: cloud?.enabled === true,sqliteSynchronous:db.prepare('PRAGMA synchronous').get()?.synchronous,
    features: ['durable-agent', 'approved-tools', 'attachments', 'document-reader', 'local-semantic-retrieval', 'local-vision-helper', 'local-ocr', 'web-research', 'local-wav-transcription', 'scheduled-tasks', 'voice-proxy', 'transport-lab',
      'fraymus-identity', 'fraymus-encoding', 'fraymus-protocol', 'fraymus-intelligence', 'fraymus-autonomy', 'fraymus-ouroboros', 'fraymus-hermes-30skill', 'fraymus-motor', 'fraymus-openclaw', 'fraymus-kuramoto-sync',
      'visual-workflow-engine', '17-agent-fleet', 'mcp-server-gateway', 'mcp-client-bridge', 'cron-automations',
      'puppeteer-headless-browser', 'chrome-extension-bridge', 'vertiso-vector-memory', 'recursive-self-improvement'] }));
  app.get('/api/agent/capabilities', route(async (_req, res) => {
    const caps = await agent.capabilities();
    let localOcrHealth;
    try { localOcrHealth=await localOcr.health(); }
    catch {localOcrHealth={available:false,engine:'windows-media-ocr',accuracyVerified:false,requiresReview:true,reason:'Local OCR could not be checked'};}
    const preferredName = process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';
    const preferredModel = caps.models.find(m => m.provider === 'ollama' && m.name === preferredName && m.allowed !== false && !m.cloud);
    res.json({ ...caps,localOcr:localOcrHealth,localVision:{configured:true,model:'gemma3:latest',mode:'local-tool',accuracyVerified:false,desktopInputEnabled:false}, ...(preferredModel ? { preferredModel: { name: preferredModel.name, provider: 'ollama' } } : {}), attachmentsEnabled: true, attachmentLimits: { maxFiles: 4, maxBytes: MAX_ASSET_BYTES,
      mimeTypes: ASSET_MIME_TYPES } });
  }));
  app.get('/api/agent/runs', (_req, res) => res.json(agent.list()));
  app.post('/api/agent/runs', route(async (req, res) => res.status(201).json(await agent.start(req.body))));
  app.get('/api/agent/runs/:id', route((req, res) => res.json(known(req.params.id))));
  app.get('/api/agent/runs/:id/events', route((req, res) => {
    const run = known(req.params.id), after = Number(req.query.afterSequence || 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event sequence');
    res.json({ events: agent.events(run.id, after), run });
  }));
  app.post('/api/agent/runs/:id/cancel', route((req, res) => { known(req.params.id); res.json(agent.cancel(req.params.id)); }));
  app.post('/api/agent/runs/:id/approve', route((req, res) => { known(req.params.id); res.json(agent.approve(req.params.id, req.body)); }));
  app.post('/api/agent/assets', route(async (req, res) => {
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new Error('Upload disconnected')); };
    req.once('aborted', abort); res.once('close', abort);
    try { res.status(201).json(await artifacts.put(req.body, { signal: controller.signal })); }
    finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  }));
  app.get('/api/agent/assets/:id', route((req, res) => {
    const { metadata, data } = artifacts.inspect(req.params.id);
    const filename = metadata.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.type(metadata.mimeType.startsWith('image/') || metadata.mimeType === 'audio/wav' ? metadata.mimeType : 'application/octet-stream');
    res.send(data);
  }));
  app.get('/api/lab/transport', route((_req, res) => res.json({ ...transportBenchmark(), vectors: vectorBenchmark() })));
  app.post('/api/lab/transport', route((req, res) => {
    if (typeof req.body?.text !== 'string' || Buffer.byteLength(req.body.text) > 16000) throw new Error('text must contain at most 16000 UTF-8 bytes');
    res.json({ ...transportBenchmark(req.body.text), vectors: vectorBenchmark() });
  }));
  app.post('/api/voice/listen', route(async (req, res) => {
    const request = validateListenRequest(req.body);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(new Error('Audio request disconnected')); };
    req.once('aborted', abort); res.once('close', abort);
    try {
      res.json(await transcribeAudio(Buffer.from(request.audioBase64, 'base64'), {
        voiceUrl, fetchImpl, signal: controller.signal, ...(request.language ? { language: request.language } : {}),
      }));
    } finally { req.removeListener('aborted', abort); res.removeListener('close', abort); }
  }));
  // The voice worker is fixed to a configured loopback origin. No arbitrary URL proxy.
  app.all('/api/voice/:operation', route(async (req, res) => {
    const op = req.params.operation;
    const methods = { health: ['GET'], speak: ['POST'], memory: ['GET','POST'], listen: ['POST'] };
    if (!methods[op]?.includes(req.method)) return res.status(405).json({ error: 'Unsupported voice operation or method' });
    const url = new URL(voiceUrl + '/' + op);
    if (op === 'memory' && req.method === 'GET') for (const key of ['q','conversationId','limit']) {
      if (typeof req.query[key] === 'string') url.searchParams.set(key, req.query[key]);
    }
    let response;
    try {
      response = await fetchImpl(url, { method: req.method, redirect: 'error', signal: AbortSignal.timeout(35000),
        headers: { 'Content-Type': 'application/json' },
        ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}) });
      const max = op === 'speak' ? 8 * 1024 * 1024 : 256 * 1024;
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('Voice response exceeds size limit'); }
        chunks.push(Buffer.from(chunk));
      }
      res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(Buffer.concat(chunks));
    } catch (error) { res.status(503).json({ ok: false, ready: false, error: `Local voice service unavailable: ${error.message}` }); }
  }));
  return { agent, artifacts, web, desktop, tasks, autonomy, workflowStore, fleetTools, vertiso, rsi, memoryBridge, async close() {
    autonomy.stop();
    const scheduling=await tasks.close();
    if(!scheduling.cleanupConfirmed)return {safeToCloseDatabase:false,scheduling};
    const results=await Promise.allSettled([agent.close(),desktop.close(),localOcr.close?.()]);
    const ocrSettled=results[2].status==='fulfilled'&&results[2].value?.callbacksSettled!==false;
    return {safeToCloseDatabase:results[0].status==='fulfilled'&&results[0].value.callbacksSettled&&results[1].status==='fulfilled'&&ocrSettled,
      scheduling,agent:results[0].status==='fulfilled'?results[0].value:{callbacksSettled:false},desktopCallbacksSettled:results[1].status==='fulfilled',ocrCallbacksSettled:ocrSettled};
  } };
}

export function apiError(error, _req, res, next) {
  if (res.headersSent) return next(error);
  const code = error.code || error.type || 'invalid_request';
  const status = error.status || (code === 'idempotency_conflict' ? 409 : code === 'run_not_found' ? 404 : 400);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: String(error.message || error).slice(0, 500), code });
}
