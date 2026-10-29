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
  `);
}
