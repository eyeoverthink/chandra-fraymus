// Unified Entity Schema Definitions — all 39 entities across 5 apps
// These define the data model; the actual persistence layer is pluggable
// (Base44 entities, local SQLite, any KV store)

export const SCHEMAS = {
  // ═══ Core System ═══
  Agent: {
    fields: ['name', 'pubkey', 'number', 'skills', 'model', 'status', 'last_seen', 'head'],
    source: 'Library Manager',
  },
  Message: {
    fields: ['from_number', 'from_name', 'to', 'payload', 'ts', 'prev', 'hash', 'sig'],
    source: 'Library Manager',
  },
  HiveThought: {
    fields: ['from', 'pub', 'ts', 'text', 'sig', 'sig_kind', 'source'],
    source: 'Library Manager',
  },
  BridgeJob: {
    fields: ['source_app', 'target_app', 'payload', 'status', 'result'],
    source: 'Library Manager',
  },
  MailMessage: {
    fields: ['from', 'to', 'subject', 'body', 'ts', 'sig', 'read'],
    source: 'Library Manager',
  },
  AgentAssignment: {
    fields: ['agent_name', 'task', 'status', 'assigned_by', 'result'],
    source: 'Library Manager',
  },

  // ═══ Cross-App System ═══
  OperatorRelay: {
    fields: ['from_app', 'to_app', 'payload', 'status', 'relay_type'],
    source: 'Creator Nexus',
  },
  HiveWitness: {
    fields: ['witness_type', 'coherence_score', 'falsification_result', 'generation', 'payload'],
    source: 'Creator Nexus',
  },
  FraymusContinuityEntry: {
    fields: ['source_app', 'entry_type', 'payload', 'delivery_status', 'captured_at', 'delivered_at'],
    source: 'Creator Nexus',
  },
  FraymusDispatchRecord: {
    fields: ['job_id', 'node', 'status', 'result', 'worker', 'error'],
    source: 'Creator Nexus',
  },
  FraymusRelayHeartbeat: {
    fields: ['relay_url', 'status', 'latency_ms', 'agent_count'],
    source: 'Creator Nexus',
  },

  // ═══ Evolution & Intelligence ═══
  NexusOuroborosNode: {
    fields: ['generation', 'genome', 'fitness', 'consciousness_level', 'phi_seal', 'timestamp'],
    source: 'Creator Nexus',
  },
  NexusExperiment: {
    fields: ['name', 'hypothesis', 'method', 'status', 'result', 'generation'],
    source: 'Creator Nexus',
  },
  NexusLearningRun: {
    fields: ['model', 'task', 'metrics', 'status', 'duration'],
    source: 'Creator Nexus',
  },
  NexusModelArtifact: {
    fields: ['name', 'model_type', 'size', 'sha256', 'location', 'version'],
    source: 'Creator Nexus',
  },
  CreatorDNA: {
    fields: ['creator_id', 'preferences', 'style_vector', 'evolution_history'],
    source: 'Creator Nexus',
  },
  NexusRegressionRun: {
    fields: ['test_suite', 'passed', 'failed', 'status', 'duration'],
    source: 'Creator Nexus',
  },
  NexusRegressionObservation: {
    fields: ['run_id', 'test_name', 'expected', 'actual', 'passed'],
    source: 'Creator Nexus',
  },

  // ═══ Dispatch & Workers ═══
  NexusDispatchJob: {
    fields: ['job_id', 'task', 'node', 'status', 'worker', 'result', 'error', 'requires_gpu'],
    source: 'Creator Nexus',
  },
  NexusNeedleJob: {
    fields: ['model', 'prompt', 'params', 'status', 'worker', 'result'],
    source: 'Creator Nexus',
  },
  NexusNeedleWorker: {
    fields: ['name', 'capabilities', 'status', 'last_heartbeat'],
    source: 'Creator Nexus',
  },

  // ═══ Production Pipeline ═══
  SparkCard: {
    fields: ['title', 'concept', 'script', 'status', 'scene_plan', 'platform', 'published_url'],
    source: 'Creator Nexus',
  },
  NexusSpark: {
    fields: ['title', 'content', 'type', 'status', 'approved_at', 'spark_card_id'],
    source: 'Creator Nexus',
  },
  NexusFactoryProduction: {
    fields: ['type', 'input', 'output', 'status', 'pipeline_stage', 'quality_score'],
    source: 'Creator Nexus',
  },
  NexusFactorySignal: {
    fields: ['signal_type', 'source', 'payload', 'processed'],
    source: 'Creator Nexus',
  },
  NexusAsset: {
    fields: ['name', 'type', 'url', 'sha256', 'size', 'metadata'],
    source: 'Creator Nexus',
  },
  NexusAssetRevision: {
    fields: ['asset_id', 'version', 'url', 'sha256', 'changed_by'],
    source: 'Creator Nexus',
  },
  FraymusVocalAnalysis: {
    fields: ['audio_url', 'transcript', 'sentiment', 'speaker', 'confidence'],
    source: 'Creator Nexus',
  },
  NexusVoiceProfile: {
    fields: ['name', 'voice_id', 'provider', 'settings', 'sample_url'],
    source: 'Creator Nexus',
  },
  SparkProfile: {
    fields: ['creator_id', 'style', 'topics', 'schedule', 'platforms'],
    source: 'Creator Nexus',
  },
  SparkLearningLog: {
    fields: ['spark_id', 'metric', 'value', 'lesson'],
    source: 'Creator Nexus',
  },

  // ═══ Studio & Creative ═══
  LooseScrewItem: {
    fields: ['prompt', 'html', 'status', 'channel', 'github_url', 'version'],
    source: 'Creator Nexus',
  },
  NexusDraft: {
    fields: ['title', 'content', 'type', 'status', 'version'],
    source: 'Creator Nexus',
  },
  NexusChatTurn: {
    fields: ['role', 'content', 'agent', 'workspace', 'timestamp'],
    source: 'Creator Nexus',
  },
  NexusEvent: {
    fields: ['event_type', 'source', 'payload', 'processed', 'timestamp'],
    source: 'Creator Nexus',
  },

  // ═══ Workspace & Coordination ═══
  NexusWorkspace: {
    fields: ['name', 'owner', 'settings', 'timezone', 'status'],
    source: 'Creator Nexus',
  },
  NexusWorkflow: {
    fields: ['name', 'trigger', 'function_name', 'schedule', 'status', 'last_run'],
    source: 'Creator Nexus',
  },
  NexusWorkflowRun: {
    fields: ['workflow_id', 'status', 'input', 'output', 'duration', 'error'],
    source: 'Creator Nexus',
  },
  NexusSkill: {
    fields: ['name', 'category', 'executor', 'params_schema', 'enabled'],
    source: 'Creator Nexus',
  },
  NexusRemoteKey: {
    fields: ['service', 'key_name', 'encrypted_value', 'expires_at'],
    source: 'Creator Nexus',
  },
  NexusKnowledge: {
    fields: ['topic', 'content', 'source', 'confidence', 'embedding'],
    source: 'Creator Nexus',
  },
  NexusExample: {
    fields: ['input', 'output', 'task', 'quality_score', 'used_in_training'],
    source: 'Creator Nexus',
  },
  SyncState: {
    fields: ['entity_type', 'last_sync', 'cursor', 'status'],
    source: 'Creator Nexus',
  },
  NexusOriginRun: {
    fields: ['origin_type', 'input', 'output', 'status', 'duration'],
    source: 'Creator Nexus',
  },
};

export const ENTITY_NAMES = Object.keys(SCHEMAS);
export const ENTITY_COUNT = ENTITY_NAMES.length;

export function getSchema(name) {
  return SCHEMAS[name] || null;
}

export function entitiesBySource(source) {
  return Object.entries(SCHEMAS)
    .filter(([, s]) => s.source === source)
    .map(([name, schema]) => ({ name, ...schema }));
}
