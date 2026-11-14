import express from 'express';
import { join } from 'node:path';
import { migrateWorkspaces } from './db-migrate.js';
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
import { createFraymusTools, MemoryBridge, heart, ledger, dreamer, remembered, ouroboros } from './fraymus-tools.js';
import { createAutonomyEngine } from './autonomy.js';
import { installFraymusRoutes } from './fraymus-routes.js';
import { createWorkflowStore, installWorkflowRoutes } from './workflow/routes.js';
import { createFleetTools, seedBuildGates } from './fleet/tools.js';
import { initFleet, setFleetTools, runAgentAndWait, startRun as fleetStartRun, getThread as fleetGetThread, decideApproval as fleetDecideApproval, fleetToolNames, listAgents as fleetListAgents, modelCallsForRun, lastModelCall } from './fleet/runtime.js';
import { installHermesRoutes } from './hermes/free-tools.js';
import { installGpuLeaseRoutes } from './media/gpu-lease.js';
import { installStudioRoutes } from './media/studio.js';
import { installMakeRoutes } from './media/make.js';
import { installMakeChainRoutes } from './media/make-chains-service.js';
import { installWorldRoutes } from './media/world-builder.js';
import { installGameRoutes } from './media/game-builder.js';
import { installMusicRoutes } from './media/music.js';
import { installOfflineWikiRoutes } from './media/offline-wiki.js';
import { installEpisodeRoutes } from './media/episode-builder.js';
import { installCardLedgerRoutes, backfillCardLedger, pruneCardLedger, withOrigin } from './intelligence/card-ledger.js';
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
import { createStreamingTools } from './streaming/tools.js';
import { installStreamingRoutes } from './streaming/routes.js';
import { createCreationTools } from './creation/tools.js';
import { installCreationRoutes } from './creation/routes.js';
import { installFraymusOsRoutes } from './fraymus-os/index.js';
import { createDistributionTools } from './distribution/tools.js';
import { installDistributionRoutes } from './distribution/routes.js';
import { createAnalyticsTools } from './analytics/tools.js';
import { installAnalyticsRoutes } from './analytics/routes.js';
import musicRouter from './media/music-routes.js';
import { createLearningLoopTools } from './commerce/learning-loop-tools.js';
import { installLearningLoopRoutes } from './commerce/learning-loop-routes.js';
import { createCalendarTools } from './calendar/tools.js';
import { installCalendarRoutes } from './calendar/routes.js';
import { createAbTestingTools } from './ab-testing/tools.js';
import { installAbTestingRoutes } from './ab-testing/routes.js';
import { createTrendRadarTools } from './trend-radar/tools.js';
import { installTrendRadarRoutes } from './trend-radar/routes.js';
import { createAudienceTools } from './audience/tools.js';
import { installAudienceRoutes } from './audience/routes.js';
import { createRepurposeTools } from './repurpose/tools.js';
import { installRepurposeRoutes } from './repurpose/routes.js';
import { createChainTools } from './chain/tools.js';
import { installChainRoutes } from './chain/routes.js';
import { getObsBridge } from './streaming/overlay.js';
import { installCommandRouter } from './command-router.js';
import { installWorkspaceRoutes } from './workspace/routes.js';
import { installDeployRoutes } from './deploy-api/routes.js';
import { gatewayMiddleware, apiVersionRouter, installGatewayRoutes } from './deploy-api/gateway.js';
import { installLoggerRoutes, requestLogger } from './observability/logger.js';
import { installMetricsExportRoutes } from './observability/metrics-export.js';
import { installAlertWebhookRoutes } from './observability/alert-webhook.js';
import { installBackupRoutes, startScheduledBackups } from './resilience/backup.js';
import { installCircuitBreakerRoutes } from './resilience/circuit-breaker.js';
import { installRecoveryRoutes, startRecoveryMonitor } from './resilience/recovery.js';
import { requestProfiler, installRequestProfilerRoutes } from './profiling/request-profiler.js';
import { installQueryProfilerRoutes } from './profiling/query-profiler.js';
import { installMemoryTrackerRoutes, startMemoryTracking } from './profiling/memory-tracker.js';
import { installCacheRoutes, startCacheSnapshots } from './caching/lru-cache.js';
import { compression, installCompressionRoutes } from './caching/compression.js';
import { etag, installETagRoutes } from './caching/etag.js';
import { installIndexAnalyzerRoutes } from './db-optimize/index-analyzer.js';
import { installWalTunerRoutes, startScheduledMaintenance } from './db-optimize/wal-tuner.js';
import { installRetentionRoutes, startScheduledRetention } from './db-optimize/retention.js';
import { installProcessMonitorRoutes, startProcessMonitor } from './supervisor/process-monitor.js';
import { installAutoHealerRoutes, startAutoHealer } from './supervisor/auto-healer.js';
import { installHealthOrchestratorRoutes } from './supervisor/health-orchestrator.js';
import { globalRateLimiter, installRateLimiterRoutes } from './gateway/rate-limiter.js';
import { requestValidator, installRequestValidatorRoutes } from './gateway/request-validator.js';
import { installApiRegistryRoutes } from './gateway/api-registry.js';
import { installConfigStoreRoutes } from './config-mgr/config-store.js';
import { installFeatureFlagRoutes } from './config-mgr/feature-flags.js';
import { installConfigSchemaRoutes, seedDefaults as seedConfigDefaults } from './config-mgr/config-schema.js';
import { initBus } from './fleet/bus.js';
import { installBusRoutes } from './fleet/bus-routes.js';
import { initTriggers, installTriggerRoutes } from './fleet/bus-triggers.js';
import { installAgentMemoryRoutes } from './fleet/agent-memory.js';
import { installMemorySearchRoutes } from './intelligence/memory-search-service.js';
import { installMemoryExperimentRoutes } from './intelligence/memory-experiment.js';
import { installFactsRoutes } from './intelligence/facts-service.js';
import { installDistillRoutes } from './intelligence/distill-service.js';
import { installModelPoolRoutes, modelPoolStatus } from './intelligence/model-pool.js';
import { initHealthMonitor, installHealthRoutes } from './health/monitor.js';
import { installForgeRoutes } from './fleet/forge.js';
import { installHarnessRoutes } from './fleet/harness-routes.js';
import { installSynthesisRoutes } from './workflow/synthesizer.js';
import { installWorkflowTrialRoutes } from './workflow/trials.js';
import { installReflectionRoutes, startReflectionLoop } from './intelligence/reflection.js';
import { installVerifierRoutes } from './intelligence/verifier-loop.js';
import { installDaemonRoutes, startDaemon } from './daemon/engine.js';
import { installGoalRoutes } from './intelligence/goal-engine.js';
import { installGoalExecutorRoutes } from './intelligence/goal-executor.js';
import { installExternalSensesRoutes } from './intelligence/external-senses.js';
import { installSelfAuditRoutes } from './intelligence/self-audit.js';
import { installHiveMeshRoutes } from './intelligence/hive-mesh.js';
import { installOllamaSchedulerRoutes } from './intelligence/ollama-scheduler.js';
import { installWorldPollerRoutes } from './intelligence/world-pollers.js';
import { installReaRoutes } from './intelligence/rea-protocol.js';
import { installNarratorRoutes } from './intelligence/narrator.js';
import { installSweeperRoutes } from './intelligence/transient-sweeper.js';
import { installTunableRoutes } from './intelligence/tunables.js';
import { installSelfModificationRoutes } from './intelligence/self-modification.js';
import { installResearchRoutes } from './intelligence/research-scout.js';
import { installDreamBridgeRoutes } from './intelligence/dream-bridge.js';
import { installSkillForgeRoutes } from './intelligence/skill-forge.js';
import { installGeneralIntelligenceRoutes } from './intelligence/general-intelligence.js';
import { installHivePeersRoutes } from './intelligence/hive-peers.js';
import { installDebateRoutes } from './intelligence/debate.js';
import { installModelRouterRoutes } from './intelligence/model-router.js';
import { installPerspectiveRoutes, briefNextInstance, getInstanceId } from './intelligence/perspective.js';
import { installSwarmRoutes } from './intelligence/swarm.js';
import { installStrategyRoutes } from './intelligence/strategy.js';
import { installTrustRoutes } from './intelligence/trust.js';
import { installSubconsciousRoutes } from './intelligence/subconscious.js';
import { installOuroborosCycleRoutes } from './intelligence/ouroboros-cycle.js';
import { installConsciousnessRoutes } from './intelligence/consciousness-cycle.js';
import { installConsciousnessGateRoutes } from './intelligence/consciousness-gate.js';
import { installSensoryRoutes } from './intelligence/sensory-bridge.js';
import { installEmotionalFeedbackRoutes } from './intelligence/emotional-feedback.js';
import { installMotorOutputRoutes } from './intelligence/motor-output.js';
import { installAttentionGateRoutes } from './intelligence/attention-gate.js';
import { installHabituationRoutes } from './intelligence/habituation.js';
import { installWorkingMemoryRoutes } from './intelligence/working-memory.js';
import { installMetacognitiveRoutes } from './intelligence/metacognitive-monitor.js';
import { installAdaptiveStrategyRoutes } from './intelligence/adaptive-strategy.js';
import { installSelfModelRoutes } from './intelligence/self-model.js';
import { installResourceEnvelopeRoutes } from './intelligence/resource-envelope.js';
import { installPredictiveRoutes } from './intelligence/predictive-processing.js';
import { installActiveInferenceRoutes } from './intelligence/active-inference.js';
import { installNarrativeRoutes } from './intelligence/self-narrative.js';
import { installDreamSolverRoutes } from './intelligence/dream-solver.js';
import { installCipherRoutes } from './intelligence/cipher.js';
import { installIntelligenceMonitorRoutes } from './intelligence/intelligence-monitor.js';
import { installHiveBridgeRoutes } from './intelligence/hive-bridge-routes.js';
import { installHiveExportRoutes } from './intelligence/hive-export-routes.js';
import { installLineageRoutes } from './intelligence/lineage-routes.js';
import { installDossierRoutes } from './intelligence/dossier-engine-routes.js';
import { migrateKnowledgeGraph, installKnowledgeGraphRoutes } from './intelligence/knowledge-graph.js';
import { installUserSensoriumRoutes } from './awareness/user-sensorium.js';
import { installNudgeRoutes, setNudgeBroadcast } from './awareness/proactive-nudge.js';
import { installProtocolRoutes } from './awareness/protocol-engine.js';
import { installContextHarvesterRoutes } from './awareness/context-harvester.js';
import { installIntegrityRoutes, startWatchdog, verifyAll, autoTrackCriticalFiles } from './integrity/watchdog.js';
import { installPlasmidRoutes } from './integrity/plasmid-backup.js';
import { installGovernanceRoutes } from './integrity/routes.js';
import { stateSeekOnBoot, installStateSeekRoutes } from './integrity/state-seek.js';
import { migrateRecordChain } from './intelligence/record-chain.js';
import { installRecordChainRoutes } from './intelligence/record-chain-routes.js';
import { migrateReplay } from './intelligence/replay-engine.js';
import { installReplayRoutes } from './intelligence/replay-routes.js';
import { migrateAkashic } from './intelligence/akashic.js';
import { installAkashicRoutes } from './intelligence/akashic-routes.js';
import { installCrossTabRoutes } from './intelligence/cross-tab-routes.js';
import { createContentNexus } from './intelligence/content-nexus.js';
import { installContentNexusRoutes } from './intelligence/content-nexus-routes.js';
import { installNUDPRoutes } from './fraymus/protocol/nudp-routes.js';
import { installBridgeRoutes } from './fraymus/protocol/bridge-routes.js';
import { installImageRoutes } from './media/image-routes.js';
import { installVideoRoutes } from './media/video-routes.js';
import { installTTSRoutes } from './media/tts-routes.js';
import { installSTTRoutes } from './media/stt-routes.js';
import { installOCRRoutes } from './media/ocr-routes.js';
import editRebuildRouter from './media/edit-rebuild-routes.js';
import { installCarbonRoutes } from './fraymus/carbon-routes.js';
import { installSettingsRoutes } from './settings.js';
import { installSearchRoutes } from './search.js';
import timelineRouter from './timeline.js';
import metricsRouter from './metrics.js';
import agentProfilesRouter from './agent-profiles.js';
import runHistoryRouter from './run-history.js';
import evolutionLogRouter from './evolution-log.js';
import systemPulseRouter from './system-pulse.js';
import leaderboardRouter from './leaderboard.js';
import observatoryRouter from './observatory.js';
import { initCollab } from './fleet/collab.js';
import { installCollabRoutes } from './fleet/collab-routes.js';

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
  // The shared store (db.js) must have its base tables before any module writes to it. Only app.js ran this, so a
  // runtime built by anything else — every test — worked only because the real store already had them.
  try { migrateWorkspaces(); } catch (e) { console.error('runtime: base schema migration failed:', e.message); }
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
  try { const bg = seedBuildGates(); if (bg.seeded > 0) console.log(`runtime: seeded ${bg.seeded} RE build gates (${bg.skipped} already existed)`); }
  catch (e) { console.error('runtime: RE build gate seeding failed:', e.message); }
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
  let streamingTools = [];
  const obsBridge = getObsBridge();
  try { streamingTools = createStreamingTools({ memoryBridge, db, dataDir, broadcast, obsBridge }); } catch (e) { console.error('runtime: streaming tools failed:', e.message); }
  let creationTools = [];
  try { creationTools = createCreationTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: creation tools failed:', e.message); }
  let distributionTools = [];
  try { distributionTools = createDistributionTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: distribution tools failed:', e.message); }
  let analyticsTools = [];
  try { analyticsTools = createAnalyticsTools({ memoryBridge }); } catch (e) { console.error('runtime: analytics tools failed:', e.message); }
  let learningLoopTools = [];
  try { learningLoopTools = createLearningLoopTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: learning-loop tools failed:', e.message); }
  let calendarTools = [];
  try { calendarTools = createCalendarTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: calendar tools failed:', e.message); }
  let abTestingTools = [];
  try { abTestingTools = createAbTestingTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: ab-testing tools failed:', e.message); }
  let trendRadarTools = [];
  try { trendRadarTools = createTrendRadarTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: trend-radar tools failed:', e.message); }
  let audienceTools = [];
  try { audienceTools = createAudienceTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: audience tools failed:', e.message); }
  let repurposeTools = [];
  try { repurposeTools = createRepurposeTools({ memoryBridge, broadcast }); } catch (e) { console.error('runtime: repurpose tools failed:', e.message); }
  let chainTools = [];
  try { chainTools = createChainTools({ broadcast, memoryBridge }); } catch (e) { console.error('runtime: chain tools failed:', e.message); }
  // An extra tool with no group is sent to the durable agent on every step. 43 business tools (commerce., calendar.,
  // ab., trends., audience., repurpose., chain.) had none, and with the fraymus-* groups they filled 41 KB of a 32 KB
  // budget before a goal was read, so web research failed `budget_context` (found 2026-11-12). They keep every
  // capability; their prefix becomes their group, loaded by goal keywords or tools.enable.
  const grouped = t => (t.group || !/^[a-z][\w-]*\./i.test(t.name) ? t : { ...t, group: t.name.split('.')[0] === 'ab' ? 'ab-testing' : t.name.split('.')[0] });
  // The durable agent pauses only on `approvalRequired`; fleet-style tools label the same thing as risk 'approval' /
  // 'approval_required' or safety 'approval_required'. Until 2026-11-12 nothing translated it, so the durable agent ran
  // approval-labelled tools (store writes, publishing) without asking. `approvalWhen(args)` is checked per call.
  const labelledApproval = t => t.risk === 'approval' || t.risk === 'approval_required' || t.safety === 'approval_required';
  const withApproval = t => (t.approvalRequired || !labelledApproval(t) ? t : { ...t, approvalRequired: true });
  const normTool = t => grouped(withApproval(t.handler && !t.execute ? { ...t, execute: ({ args }, ctx) => t.handler(args || {}, ctx) } : t));
  const normTools = arr => arr.map(normTool);
  agent = createAgentService({ db, workspace, ollamaUrl, fetchImpl,
    cloud, codeExecutor, desktopBroker:desktop, extraTools: normTools([...createExtensionTools(artifacts, web),...desktop.tools(),
      ...createTaskTools({scheduler:tasks,db,now:taskClock,onReceipt:(id,receipt)=>agent?.recordTaskReceipt(id,receipt)}),
      ...createSemanticTools({artifacts,store:semanticStore,embedder:embeddings}),...createVisionTools({artifacts,provider:localVision}),...createOcrTools({artifacts,provider:localOcr}),...createFraymusTools(),
      ...fleetTools, ...mcpImported, ...browserTools, ...vertisoTools, ...youtubeTools, ...commerceTools, ...streamingTools, ...creationTools, ...distributionTools, ...analyticsTools, ...learningLoopTools, ...calendarTools, ...abTestingTools, ...trendRadarTools, ...audienceTools, ...repurposeTools, ...chainTools]),
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
  // card ledger: work a request starts is charged to the operator (`api`), carried through every await and queued job
  app.use((req, res, next) => withOrigin({ origin: 'api' }, next));
  app.use(gatewayMiddleware());
  app.use(apiVersionRouter());
  installGatewayRoutes(app);
  app.use(requestLogger());
  installLoggerRoutes(app);
  installMetricsExportRoutes(app);
  installAlertWebhookRoutes(app);
  installBackupRoutes(app);
  installCircuitBreakerRoutes(app);
  installRecoveryRoutes(app);
  startScheduledBackups();
  startRecoveryMonitor();
  app.use(requestProfiler());
  installRequestProfilerRoutes(app);
  installQueryProfilerRoutes(app);
  installMemoryTrackerRoutes(app);
  startMemoryTracking();
  app.use(compression());
  app.use(etag());
  installCacheRoutes(app);
  installCompressionRoutes(app);
  installETagRoutes(app);
  startCacheSnapshots();

  installIndexAnalyzerRoutes(app);
  installWalTunerRoutes(app);
  installRetentionRoutes(app);
  startScheduledMaintenance();
  startScheduledRetention();

  installProcessMonitorRoutes(app);
  installAutoHealerRoutes(app);
  installHealthOrchestratorRoutes(app);
  startProcessMonitor();
  startAutoHealer();

  app.use(globalRateLimiter());
  app.use(requestValidator());
  installRateLimiterRoutes(app);
  installRequestValidatorRoutes(app);
  installApiRegistryRoutes(app);

  installConfigStoreRoutes(app);
  installFeatureFlagRoutes(app);
  installConfigSchemaRoutes(app);
  seedConfigDefaults();

  installFraymusRoutes(app, { autonomy, broadcast, memoryBridge });
  installSynthesisRoutes(app);
  installWorkflowTrialRoutes(app);
  installWorkflowRoutes(app, { broadcast, memoryBridge });
  installFleetRoutes(app);
  installHarnessRoutes(app);
  initBus({ broadcast });
  initCollab({ runAgent: runAgentAndWait, broadcast });
  installBusRoutes(app);
  initTriggers({ broadcast });
  installTriggerRoutes(app);
  installAgentMemoryRoutes(app);
  installMemorySearchRoutes(app);
  installMemoryExperimentRoutes(app);
  installFactsRoutes(app);
  installDistillRoutes(app);
  installModelPoolRoutes(app);
  initHealthMonitor({ broadcast, ollamaBaseUrl: ollamaUrl });
  installHealthRoutes(app);
  installForgeRoutes(app);
  installReflectionRoutes(app);
  installVerifierRoutes(app);
  installDaemonRoutes(app);
  installGoalRoutes(app);
  installGoalExecutorRoutes(app);
  installExternalSensesRoutes(app);
  installSelfAuditRoutes(app);
  installHiveMeshRoutes(app);
  installOllamaSchedulerRoutes(app);
  installWorldPollerRoutes(app);
  installReaRoutes(app);
  installNarratorRoutes(app);
  installSweeperRoutes(app);
  installTunableRoutes(app);
  installSelfModificationRoutes(app);
  installResearchRoutes(app);
  installDreamBridgeRoutes(app);
  installSkillForgeRoutes(app);
  installGeneralIntelligenceRoutes(app);
  installHivePeersRoutes(app);
  installDebateRoutes(app);
  installModelRouterRoutes(app);
  installPerspectiveRoutes(app);
  try {
    const brief = briefNextInstance();
    console.log(`[perspective] Instance ${getInstanceId()} warmed — ${brief.playbookSize || brief.playbook?.length || 0} playbook entries, ${brief.continuityNotes?.length || 0} continuity notes`);
  } catch (e) { console.error('[perspective] boot warm-up failed (non-fatal):', e.message); }
  installSwarmRoutes(app);
  installStrategyRoutes(app);
  installTrustRoutes(app);
  installSubconsciousRoutes(app);
  installOuroborosCycleRoutes(app);
  installConsciousnessRoutes(app);
  installConsciousnessGateRoutes(app);
  installSensoryRoutes(app);
  installEmotionalFeedbackRoutes(app);
  installMotorOutputRoutes(app);
  installAttentionGateRoutes(app);
  installHabituationRoutes(app);
  installWorkingMemoryRoutes(app);
  installMetacognitiveRoutes(app);
  installAdaptiveStrategyRoutes(app);
  installSelfModelRoutes(app);
  installResourceEnvelopeRoutes(app);
  installPredictiveRoutes(app);
  installActiveInferenceRoutes(app);
  installNarrativeRoutes(app);
  installDreamSolverRoutes(app);
  installCipherRoutes(app);
  installIntelligenceMonitorRoutes(app);
  installUserSensoriumRoutes(app);
  setNudgeBroadcast(broadcast);
  installNudgeRoutes(app);
  installProtocolRoutes(app);
  installContextHarvesterRoutes(app);
  installHiveBridgeRoutes(app);
  installHiveExportRoutes(app);
  installLineageRoutes(app);
  installDossierRoutes(app);
  try { migrateKnowledgeGraph(); } catch (e) { console.error('[knowledge-graph] migration failed (non-fatal):', e.message); }
  installKnowledgeGraphRoutes(app);
  installIntegrityRoutes(app);
  installPlasmidRoutes(app);
  installGovernanceRoutes(app, { broadcast, dreamer, remembered, ledger, ouroboros });
  installStateSeekRoutes(app);
  try { migrateRecordChain(); } catch (e) { console.error('[record-chain] migration failed (non-fatal):', e.message); }
  installRecordChainRoutes(app);
  try { migrateReplay(); } catch (e) { console.error('[replay-engine] migration failed (non-fatal):', e.message); }
  installReplayRoutes(app);
  try { migrateAkashic(); } catch (e) { console.error('[akashic] migration failed (non-fatal):', e.message); }
  installAkashicRoutes(app);
  installCrossTabRoutes(app, { memoryBridge, broadcast });
  const nexus = createContentNexus({ db, ollamaUrl, broadcast });
  installContentNexusRoutes(app, { nexus, broadcast });
  installNUDPRoutes(app);
  installBridgeRoutes(app);
  installImageRoutes(app);
  installVideoRoutes(app);
  installTTSRoutes(app);
  installSTTRoutes(app);
  installOCRRoutes(app);
  app.use('/api/media/edit-rebuild', editRebuildRouter);
  installCarbonRoutes(app, { dataDir: DATA_DIR, broadcast, db, heart, ledger, memoryBridge });
  installSettingsRoutes(app, db);
  installSearchRoutes(app, { db });
  app.use(timelineRouter);
  app.use(metricsRouter);
  app.use(agentProfilesRouter);
  app.use(runHistoryRouter);
  app.use(evolutionLogRouter);
  app.use(systemPulseRouter);
  app.use(leaderboardRouter);
  installCollabRoutes(app);
  app.get('/api/observatory', observatoryRouter);
  // Autonomous loops belong to the server, not to a test that builds the app: modules such as reflection.js write through
  // the shared db handle (the real data/chandra.db) even when the test passed its own temporary database. The test runner
  // sets NODE_TEST_CONTEXT in its workers; CHANDRA_NO_LOOPS=1 does the same for scripts.
  if (!process.env.NODE_TEST_CONTEXT && process.env.CHANDRA_NO_LOOPS !== '1') startReflectionLoop();
  try {
    stateSeekOnBoot({ broadcast });
    startWatchdog({ broadcast });
  } catch (e) { console.error('[integrity] state-seek/watchdog init failed (non-fatal):', e.message); }
  installMcpEndpoint(app);
  installOAuthRoutes(app);
  installAccessRoutes(app);
  installBrowserRoutes(app);
  installExtensionRoutes(app);
  installVertisoRoutes(app, { vertiso, rsi });
  installYouTubeRoutes(app);
  installCommerceRoutes(app, { memoryBridge });
  installCreationRoutes(app, { memoryBridge, broadcast });
  // the home screen's brain: commands go to a fleet agent holding the real tool registry
  installFraymusOsRoutes(app, { db, broadcast, ollamaUrl, voiceUrl, fleet: { startRun: fleetStartRun, getThread: fleetGetThread, decideApproval: fleetDecideApproval, toolNames: fleetToolNames, listAgents: fleetListAgents, modelCallsForRun, lastModelCall, poolStatus: modelPoolStatus } });
  installHermesRoutes(app, { express });
  installGpuLeaseRoutes(app);
  installStudioRoutes(app);
  installMakeRoutes(app);
  installMakeChainRoutes(app);     // make chains: several makers in a row, each handed the last one's text and file
  installWorldRoutes(app);         // walkable worlds: a place or a picture as a page you can walk through (world-builder.js)
  installGameRoutes(app);          // platform games: words or a picture as a winnable, played-through game page (game-builder.js)
  installMusicRoutes(app);         // music: words become a song or an instrumental on our own card, measured and mastered (music.js)
  installOfflineWikiRoutes(app);   // offline Wikipedia (a Kiwix ZIM read through libzim) behind fact grounding (offline-wiki.js)
  installEpisodeRoutes(app);       // episodes: a premise as a multi-act film, each act made and checked by Make (episode-builder.js)
  installCardLedgerRoutes(app);    // card-seconds ledger: what the machines' time went on, and for whom (card-ledger.js)
  { const added = backfillCardLedger(); if (added) console.log(`[card-ledger] backfilled ${added} rows from worker receipts and leases`); pruneCardLedger(); }
  installDistributionRoutes(app, { memoryBridge, broadcast });
  installAnalyticsRoutes(app, { memoryBridge, broadcast });
  installLearningLoopRoutes(app, { memoryBridge, broadcast });
  installCalendarRoutes(app, { memoryBridge, broadcast });
  installAbTestingRoutes(app, { memoryBridge, broadcast });
  installTrendRadarRoutes(app, { memoryBridge, broadcast });
  installAudienceRoutes(app, { memoryBridge, broadcast });
  installRepurposeRoutes(app, { memoryBridge, broadcast });
  installChainRoutes(app, { broadcast, memoryBridge });
  app.use(musicRouter);
  installStreamingRoutes(app, { broadcast, memoryBridge, db, obsBridge });
  installDeployRoutes(app, { broadcast, memoryBridge });
  installWorkspaceRoutes(app, { broadcast });
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
      'puppeteer-headless-browser', 'chrome-extension-bridge', 'vertiso-vector-memory', 'recursive-self-improvement',
      'event-driven-orchestration', 'agent-persistent-memory', 'system-health-monitor',
      'agent-forge', 'workflow-synthesis', 'reflection-loop', 'nudp-mesh-protocol', 'sharp-image-engine', 'comfyui-bridge', 'ffmpeg-video-pipeline', 'tts-speech-engine', 'stt-transcription-engine', 'windows-media-ocr-pipeline', 'media-hub-panel', 'error-boundary-resilience', 'forge-synthesis-panel', 'system-settings-panel', 'notification-toasts', 'global-search', 'keyboard-shortcuts', 'agent-chat-panel', 'activity-timeline', 'system-metrics', 'agent-profiles', 'memory-browser', 'run-history', 'evolution-log', 'system-pulse', 'agent-leaderboard', 'agent-collaboration', 'edit-rebuild-pipeline', 'carbon-x-biological-encoding', 'social-distribution-engine', 'analytics-feedback-loop', 'ai-music-layer', 'commerce-learning-loop', 'smart-content-calendar', 'ab-testing-engine', 'trend-radar', 'audience-intelligence', 'content-repurposing', 'logic-chain', 'autonomous-goal-engine', 'intelligence-observatory', 'debate-protocol', 'adaptive-model-router', 'deep-integration-layer', 'self-healing-watchdog', 'plasmid-disaster-recovery', 'state-seek-on-boot', 'negative-control-verification', 'anti-invention-evidence-seals', 'hash-chained-record', 'strix-budget-laws', 'salvage-on-crash', 'consciousness-falsification-suite', 'writ-governed-tool-execution', 'clock-honesty-tagging', 'broadened-fossil-evolution', 'perspective-arena-mode', 'perspective-lens-toggle', 'perspective-continuity-plasmid', 'cross-tab-intelligence', 'content-nexus', 'fraymus-os'] }));
  const clientErrors = [];
  app.post('/api/client-error', express.json(), (req, res) => {
    const { message, stack, component, view, ts } = req.body || {};
    const entry = { message, component, view, ts: ts || Date.now() };
    clientErrors.push(entry);
    if (clientErrors.length > 100) clientErrors.shift();
    console.error(`[client-error] ${view}: ${message}`);
    res.json({ logged: true });
  });
  app.get('/api/client-errors', (_req, res) => res.json(clientErrors));

  // what a run's first step would carry for this goal: system prompt + offered tool schemas, in bytes (the budget's unit)
  app.get('/api/agent/tool-footprint', route((req, res) => res.json(agent.toolFootprint(String(req.query.goal || '').slice(0, 2000)))));
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
  // Fleet run-loop tools: every tool family that works outside the durable agent's own run context.
  // Left out on purpose: extension/desktop/task/semantic/vision/OCR tools — they are bound to that
  // agent's run ids, artifacts and desktop broker and would fail or mis-file receipts in a fleet run.
  const fleetLoopTools = (() => {
    const seen = new Set(), out = [];
    let fraymus = [];
    try { fraymus = createFraymusTools(); } catch (e) { console.error('runtime: fraymus tools for fleet failed:', e.message); }
    for (const t of normTools([...fleetTools, ...fraymus, ...mcpImported, ...browserTools, ...vertisoTools, ...youtubeTools, ...commerceTools, ...streamingTools, ...creationTools, ...distributionTools, ...analyticsTools, ...learningLoopTools, ...calendarTools, ...abTestingTools, ...trendRadarTools, ...audienceTools, ...repurposeTools, ...chainTools])) {
      if (!t || !t.name || seen.has(t.name)) continue;
      seen.add(t.name); out.push(t);
    }
    return out;
  })();
  return { agent, artifacts, web, desktop, tasks, autonomy, workflowStore, fleetTools, fleetLoopTools, vertiso, rsi, memoryBridge, async close() {
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
