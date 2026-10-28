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
