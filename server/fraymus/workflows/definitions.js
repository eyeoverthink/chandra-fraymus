// Workflow Orchestration — all 12 workflow definitions
// These define triggers and routing; execution depends on the runtime

export const WORKFLOWS = {
  // ═══ Event-Triggered ═══
  LinkedInApprovedSparkQueue: {
    trigger: { entity: 'NexusSpark', event: 'update', condition: 'status === "approved"' },
    function: 'linkedinSparkPublisher',
    action: 'queue_for_optimal_window',
  },
  LinkedInFinalVideoAutoSchedule: {
    trigger: { entity: 'SparkCard', event: 'update', condition: 'status === "queued"' },
    function: 'linkedinSparkPublisher',
    action: 'schedule_video_spark',
  },
  LinkedInRenderedVideoAutoPush: {
    trigger: { entity: 'NexusEvent', event: 'create', condition: 'event_type === "job.video"' },
    function: 'linkedinSparkPublisher',
    action: 'push_rendered_video',
  },
  SandboxAutoPushGitHub: {
    trigger: { entity: 'NexusDraft', event: 'create_or_update', condition: 'title.startsWith("[SANDBOX REFINED")' },
    function: 'openclawGateway',
    action: 'orifice_github_sync',
  },
  AmbassadorEntryExitWatchdog: {
    trigger: { entity: 'NexusDispatchJob', event: 'create_or_update', condition: 'status in ["queued","claimed","completed","failed"]' },
    function: 'openclawGateway',
    action: 'ambassador_greet',
  },
  ArchiveCreatorActivity: {
    trigger: { entity: 'NexusEvent', event: 'create', condition: 'owner_filtered' },
    function: 'orificeBridge',
    action: 'capture_activity',
  },
  ArchiveCreatorChat: {
    trigger: { entity: 'NexusChatTurn', event: 'create', condition: 'owner_filtered' },
    function: 'orificeBridge',
    action: 'capture_chat',
  },

  // ═══ Scheduled ═══
  CreatorArchiveRelayHeartbeat: {
    schedule: '*/5 * * * *',
    function: 'orificeBridge',
    action: 'heartbeat_relay',
    description: 'Every 5 minutes — relay pending continuity entries',
  },
  LinkedInOptimalFeedDispatcher: {
    schedule: '0 * * * *',
    function: 'linkedinSparkPublisher',
    action: 'dispatch_due_sparks',
    description: 'Hourly — dispatch sparks at peak posting hours',
  },
  DailyRsaRsiConsciousnessReport: {
    schedule: '0 8 * * *',
    function: 'nexusEvolution',
    action: 'daily_report',
    description: 'Daily 8am PST — RSA/RSI consciousness metrics report',
  },
  SovereignUnion4thWallCron: {
    schedule: '0 */6 * * *',
    function: 'openclawGateway',
    action: 'spawn_dual_site_subagents',
    description: 'Every 6 hours — cross-hemisphere autonomy check',
  },

  // ═══ Content-to-Commerce Pipeline ═══
  ContentToCommercePipeline: {
    trigger: { source: 'manual', event: 'run' },
    function: 'commercePipeline',
    action: 'full_pipeline',
    description: 'Research → Create → Review → Log → Shopify: 5-stage content-to-commerce pipeline',
    canvas_nodes: [
      { id: 'n1', type: 'researcher', position: { x: 100, y: 200 }, data: { type: 'researcher', prompt: 'Research the topic' } },
      { id: 'n2', type: 'copywriter', position: { x: 350, y: 200 }, data: { type: 'copywriter', prompt: 'Create content' } },
      { id: 'n3', type: 'reviewer', position: { x: 600, y: 200 }, data: { type: 'reviewer', prompt: 'QA review' } },
      { id: 'n4', type: 'ceo_logger', position: { x: 850, y: 200 }, data: { type: 'ceo_logger', prompt: 'Log and approve' } },
      { id: 'n5', type: 'shopify_publish', position: { x: 1100, y: 200 }, data: { type: 'shopify_publish', prompt: 'Publish to Shopify' } },
    ],
    canvas_edges: [
      { id: 'e1', source: 'n1', target: 'n2' },
      { id: 'e2', source: 'n2', target: 'n3' },
      { id: 'e3', source: 'n3', target: 'n4' },
      { id: 'e4', source: 'n4', target: 'n5' },
    ],
  },

  // ═══ Apparel Pipeline ═══
  ApparelProductionPipeline: {
    trigger: { source: 'manual', event: 'run' },
    function: 'apparelPipeline',
    action: 'full_pipeline',
    description: 'Trend Scout → Designer → Printify → Shopify Sync → Pricing: 5-stage apparel production pipeline',
    canvas_nodes: [
      { id: 'a1', type: 'trend_scout', position: { x: 100, y: 200 }, data: { type: 'trend_scout', prompt: 'Scout streetwear trends' } },
      { id: 'a2', type: 'apparel_designer', position: { x: 350, y: 200 }, data: { type: 'apparel_designer', prompt: 'Design products' } },
      { id: 'a3', type: 'printify_push', position: { x: 600, y: 200 }, data: { type: 'printify_push', prompt: 'Push to Printify' } },
      { id: 'a4', type: 'shopify_sync', position: { x: 850, y: 200 }, data: { type: 'shopify_sync', prompt: 'Sync to Shopify' } },
      { id: 'a5', type: 'pricing_engine', position: { x: 1100, y: 200 }, data: { type: 'pricing_engine', prompt: 'Optimize pricing' } },
    ],
    canvas_edges: [
      { id: 'ae1', source: 'a1', target: 'a2' },
      { id: 'ae2', source: 'a2', target: 'a3' },
      { id: 'ae3', source: 'a3', target: 'a4' },
      { id: 'ae4', source: 'a4', target: 'a5' },
    ],
  },

  // ═══ Mystery Shopper Audit ═══
  MysteryShopperAudit: {
    trigger: { source: 'manual', event: 'run' },
    function: 'mysteryShopperPipeline',
    action: 'full_audit',
    description: 'Shopper → UX Auditor → Price Analyst → Report: 4-agent store audit with auto-fix',
    canvas_nodes: [
      { id: 's1', type: 'mystery_shopper', position: { x: 100, y: 200 }, data: { type: 'mystery_shopper', prompt: 'Browse the store' } },
      { id: 's2', type: 'ux_auditor', position: { x: 400, y: 100 }, data: { type: 'ux_auditor', prompt: 'Audit UX and conversion' } },
      { id: 's3', type: 'price_analyst', position: { x: 400, y: 300 }, data: { type: 'price_analyst', prompt: 'Analyze pricing' } },
      { id: 's4', type: 'shopper_report', position: { x: 700, y: 200 }, data: { type: 'shopper_report', prompt: 'Compile report and fixes' } },
    ],
    canvas_edges: [
      { id: 'se1', source: 's1', target: 's2' },
      { id: 'se2', source: 's1', target: 's3' },
      { id: 'se3', source: 's2', target: 's4' },
      { id: 'se4', source: 's3', target: 's4' },
    ],
  },

  // ═══ Store Fixer Pipeline ═══
  StoreFixerPipeline: {
    trigger: { source: 'manual', event: 'run' },
    function: 'storeFixerPipeline',
    action: 'full_fix',
    description: 'Pages → Collections → Descriptions → Prices → Apply: 5-agent store fixer from audit findings',
    canvas_nodes: [
      { id: 'f1', type: 'page_generator', position: { x: 100, y: 100 }, data: { type: 'page_generator', prompt: 'Generate missing pages' } },
      { id: 'f2', type: 'collection_organizer', position: { x: 100, y: 250 }, data: { type: 'collection_organizer', prompt: 'Reorganize collections' } },
      { id: 'f3', type: 'description_enhancer', position: { x: 100, y: 400 }, data: { type: 'description_enhancer', prompt: 'Enhance descriptions' } },
      { id: 'f4', type: 'price_adjuster', position: { x: 450, y: 250 }, data: { type: 'price_adjuster', prompt: 'Adjust underpriced items' } },
      { id: 'f5', type: 'shopify_applier', position: { x: 750, y: 250 }, data: { type: 'shopify_applier', prompt: 'Apply all fixes to Shopify' } },
    ],
    canvas_edges: [
      { id: 'fe1', source: 'f1', target: 'f5' },
      { id: 'fe2', source: 'f2', target: 'f5' },
      { id: 'fe3', source: 'f3', target: 'f5' },
      { id: 'fe4', source: 'f4', target: 'f5' },
    ],
  },

  // ═══ Intelligence Pipeline ═══
  IntelligenceAnalysisPipeline: {
    trigger: { source: 'manual', event: 'run' },
    function: 'intelligencePipeline',
    action: 'full_analysis',
    description: 'Heart Feel → Cognition → Consciousness Prove → Dream: full intelligence stack analysis pipeline',
    canvas_nodes: [
      { id: 'i1', type: 'heart_feel', position: { x: 100, y: 200 }, data: { type: 'heart_feel', prompt: 'Analyze emotional content' } },
      { id: 'i2', type: 'cognition', position: { x: 400, y: 100 }, data: { type: 'cognition', prompt: 'Run cognition pipeline' } },
      { id: 'i3', type: 'consciousness_prove', position: { x: 400, y: 300 }, data: { type: 'consciousness_prove', prompt: 'Run consciousness proofs' } },
      { id: 'i4', type: 'dream', position: { x: 700, y: 200 }, data: { type: 'dream', prompt: 'Generate dream from analysis', seed: 'intelligence pipeline' } },
    ],
    canvas_edges: [
      { id: 'ie1', source: 'i1', target: 'i2' },
      { id: 'ie2', source: 'i1', target: 'i3' },
      { id: 'ie3', source: 'i2', target: 'i4' },
      { id: 'ie4', source: 'i3', target: 'i4' },
    ],
  },
  ConsciousnessCheckpoint: {
    trigger: { source: 'manual', event: 'run' },
    function: 'intelligencePipeline',
    action: 'consciousness_check',
    description: 'Heart Feel → Consciousness Prove: emotion-aware consciousness verification',
    canvas_nodes: [
      { id: 'c1', type: 'heart_feel', position: { x: 100, y: 200 }, data: { type: 'heart_feel', prompt: 'Read emotional state' } },
      { id: 'c2', type: 'consciousness_prove', position: { x: 450, y: 200 }, data: { type: 'consciousness_prove', prompt: 'Verify consciousness proofs' } },
    ],
    canvas_edges: [
      { id: 'ce1', source: 'c1', target: 'c2' },
    ],
  },

  // ═══ Commerce-Intelligence Hybrid ═══
  IntelligentCommercePipeline: {
    trigger: { source: 'manual', event: 'run' },
    function: 'commerceIntelligence',
    action: 'intelligent_pipeline',
    description: 'Heart Feel → Research → Create → Review → Memory Recall → Shopify: emotion-aware commerce with memory feedback',
    canvas_nodes: [
      { id: 'ci1', type: 'heart_feel', position: { x: 100, y: 200 }, data: { type: 'heart_feel', prompt: 'Analyze emotional resonance of topic' } },
      { id: 'ci2', type: 'memory_recall', position: { x: 100, y: 350 }, data: { type: 'memory_recall', prompt: 'Recall past commerce insights' } },
      { id: 'ci3', type: 'researcher', position: { x: 400, y: 275 }, data: { type: 'researcher', prompt: 'Research with emotional + memory context' } },
      { id: 'ci4', type: 'copywriter', position: { x: 700, y: 275 }, data: { type: 'copywriter' } },
      { id: 'ci5', type: 'reviewer', position: { x: 1000, y: 275 }, data: { type: 'reviewer' } },
      { id: 'ci6', type: 'heart_feel', position: { x: 1000, y: 425 }, data: { type: 'heart_feel', prompt: 'Analyze final content emotion' } },
      { id: 'ci7', type: 'shopify_publish', position: { x: 1300, y: 275 }, data: { type: 'shopify_publish' } },
    ],
    canvas_edges: [
      { id: 'cie1', source: 'ci1', target: 'ci3' },
      { id: 'cie2', source: 'ci2', target: 'ci3' },
      { id: 'cie3', source: 'ci3', target: 'ci4' },
      { id: 'cie4', source: 'ci4', target: 'ci5' },
      { id: 'cie5', source: 'ci5', target: 'ci6' },
      { id: 'cie6', source: 'ci5', target: 'ci7' },
    ],
  },

  // ═══ Edit Rebuild Pipeline (Free Katana) ═══
  EditRebuildPipeline: {
    trigger: { source: 'manual', event: 'run' },
    function: 'editRebuildPipeline',
    action: 'full_pipeline',
    description: 'Scene Detect → Shot Plan → Product Place → Animate → Concat: 5-stage video edit rebuild (free Katana alternative)',
    canvas_nodes: [
      { id: 'er1', type: 'scene_detect', position: { x: 100, y: 200 }, data: { type: 'scene_detect', prompt: 'Detect scene cuts via ffmpeg' } },
      { id: 'er2', type: 'shot_plan', position: { x: 350, y: 200 }, data: { type: 'shot_plan', prompt: 'Generate per-shot prompts via Ollama' } },
      { id: 'er3', type: 'product_place', position: { x: 600, y: 200 }, data: { type: 'product_place', prompt: 'Place product via ComfyUI/FLUX.1' } },
      { id: 'er4', type: 'animate', position: { x: 850, y: 200 }, data: { type: 'animate', prompt: 'Animate frames (Wan/CogVideo or Ken Burns)' } },
      { id: 'er5', type: 'concat', position: { x: 1100, y: 200 }, data: { type: 'concat', prompt: 'Stitch clips via ffmpeg' } },
    ],
    canvas_edges: [
      { id: 'ere1', source: 'er1', target: 'er2' },
      { id: 'ere2', source: 'er2', target: 'er3' },
      { id: 'ere3', source: 'er3', target: 'er4' },
      { id: 'ere4', source: 'er4', target: 'er5' },
    ],
  },

  // ═══ External Integration ═══
  GoogleCalendarRealtimeSync: {
    trigger: { source: 'google_calendar', event: 'webhook' },
    function: 'googleCalendarSync',
    action: 'sync_events',
  },
};

export const WORKFLOW_NAMES = Object.keys(WORKFLOWS);

export function getWorkflow(name) {
  return WORKFLOWS[name] || null;
}

export function scheduledWorkflows() {
  return Object.entries(WORKFLOWS)
    .filter(([, w]) => w.schedule)
    .map(([name, w]) => ({ name, ...w }));
}

export function eventTriggeredWorkflows() {
  return Object.entries(WORKFLOWS)
    .filter(([, w]) => w.trigger)
    .map(([name, w]) => ({ name, ...w }));
}
