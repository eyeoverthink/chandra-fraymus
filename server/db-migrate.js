import { db } from './db.js';

export function migrateWorkspaces() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      nodes TEXT NOT NULL DEFAULT '[]',
      edges TEXT NOT NULL DEFAULT '[]',
      is_deployed INTEGER DEFAULT 0,
      deploy_slug TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      user_id TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'running',
      input_prompt TEXT,
      results TEXT,
      final_image_url TEXT,
      final_html TEXT,
      duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wfrun_wf ON workflow_runs(workflow_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      agent_id TEXT NOT NULL,
      title TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      run_id TEXT,
      role TEXT NOT NULL,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      name TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id, id);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_id TEXT DEFAULT 'local',
      status TEXT,
      error TEXT,
      provider TEXT,
      model TEXT,
      steps INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      thread_id TEXT,
      user_id TEXT,
      call_id TEXT,
      tool TEXT,
      args TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER,
      decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS fleet_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT DEFAULT 'local',
      agent_id TEXT,
      text TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_fmem_user ON fleet_memories(user_id, id);

    CREATE TABLE IF NOT EXISTS custom_agents (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'local',
      json TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'agent',
      agent_id TEXT,
      tool TEXT,
      payload TEXT DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      last_minute INTEGER,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      user_id TEXT DEFAULT 'local',
      trigger_type TEXT DEFAULT 'cron',
      status TEXT,
      thread_id TEXT,
      output TEXT,
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_arun ON automation_runs(automation_id, started_at);

    CREATE TABLE IF NOT EXISTS access_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      name TEXT,
      kind TEXT DEFAULT 'pat',
      client_id TEXT,
      hash TEXT UNIQUE NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'read run',
      expires_at INTEGER,
      created_at INTEGER,
      last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'local',
      name TEXT,
      secret_hash TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'read run',
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS commerce_pipeline_runs (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'both',
      status TEXT NOT NULL DEFAULT 'running',
      score INTEGER DEFAULT 0,
      issues TEXT DEFAULT '[]',
      final_content TEXT,
      shopify_result TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cpr_created ON commerce_pipeline_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS apparel_pipeline_runs (
      id TEXT PRIMARY KEY,
      niche TEXT NOT NULL DEFAULT 'streetwear',
      product_types TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      stages TEXT,
      products_created INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apr_created ON apparel_pipeline_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS mystery_shopper_runs (
      id TEXT PRIMARY KEY,
      store_domain TEXT NOT NULL,
      overall_grade TEXT,
      scores TEXT,
      automated_fixes TEXT,
      manual_fixes TEXT,
      strategic TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msr_created ON mystery_shopper_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS store_fixer_runs (
      id TEXT PRIMARY KEY,
      audit_run_id TEXT,
      pages_generated INTEGER DEFAULT 0,
      collections_created INTEGER DEFAULT 0,
      templates_created INTEGER DEFAULT 0,
      prices_adjusted INTEGER DEFAULT 0,
      apply_status TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sfr_created ON store_fixer_runs(created_at DESC);

    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id TEXT NOT NULL,
      key_name TEXT,
      slug TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      error TEXT,
      ip TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apiusage_slug ON api_usage(slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_apiusage_key ON api_usage(key_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS bus_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      topic TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bus_topic ON bus_messages(topic, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bus_to ON bus_messages(to_agent, created_at DESC);

    CREATE TABLE IF NOT EXISTS bus_subscriptions (
      agent_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      subscribed_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, topic)
    );

    CREATE TABLE IF NOT EXISTS bus_triggers (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      label TEXT,
      enabled INTEGER DEFAULT 1,
      fire_count INTEGER DEFAULT 0,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bustrig_topic ON bus_triggers(topic);

    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      source TEXT DEFAULT 'agent',
      access_count INTEGER DEFAULT 0,
      verified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agentmem_agent ON agent_memories(agent_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agentmem_key ON agent_memories(agent_id, key);

    CREATE TABLE IF NOT EXISTS health_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      collected_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hmetric ON health_metrics(metric, collected_at DESC);

    CREATE TABLE IF NOT EXISTS health_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      message TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_halert ON health_alerts(resolved, created_at DESC);

    CREATE TABLE IF NOT EXISTS forged_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      forged_by TEXT NOT NULL DEFAULT 'system',
      goal TEXT NOT NULL,
      context TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_forged ON forged_agents(agent_id);

    CREATE TABLE IF NOT EXISTS synthesized_workflows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      synthesized_by TEXT NOT NULL DEFAULT 'system',
      goal TEXT NOT NULL,
      node_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_synth ON synthesized_workflows(workflow_id);

    CREATE TABLE IF NOT EXISTS reflections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger TEXT NOT NULL DEFAULT 'scheduled',
      input_summary TEXT NOT NULL,
      actions_taken TEXT NOT NULL,
      insights TEXT,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reflect ON reflections(created_at DESC);

    CREATE TABLE IF NOT EXISTS verification_loops (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'auto',
      max_iterations INTEGER NOT NULL DEFAULT 3,
      iterations_used INTEGER DEFAULT 0,
      triggered_by TEXT NOT NULL DEFAULT 'api',
      status TEXT NOT NULL DEFAULT 'running',
      final_code TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vloop ON verification_loops(created_at DESC);

    CREATE TABLE IF NOT EXISTS verification_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loop_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      role TEXT NOT NULL,
      input TEXT,
      output TEXT,
      verdict TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vstep ON verification_steps(loop_id, iteration);

    CREATE TABLE IF NOT EXISTS daemon_cycles (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      input_summary TEXT,
      output TEXT,
      duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_daemon ON daemon_cycles(created_at DESC);
  `);
}
