/** F.R.A.Y.M.U.S. tables. These never replace Vertiso, agent memory, or workflows. */

export function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fraymus_os_notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      provenance TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fraymus_os_sessions (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fraymus_os_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      state TEXT,
      model TEXT,
      endpoint TEXT,
      route_class TEXT,
      sources TEXT,
      answer TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fraymus_os_turns_session
      ON fraymus_os_turns(session_id, created_at);

    CREATE TABLE IF NOT EXISTS fraymus_os_tool_steps (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      tool TEXT NOT NULL,
      args TEXT,
      status TEXT NOT NULL,
      result TEXT,
      risk TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fraymus_os_tools_turn
      ON fraymus_os_tool_steps(turn_id, created_at);

    CREATE TABLE IF NOT EXISTS fraymus_os_artifacts (
      id TEXT PRIMARY KEY,
      preset TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT,
      provenance TEXT NOT NULL,
      creation_run_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fraymus_os_artifacts_created
      ON fraymus_os_artifacts(created_at DESC);

    CREATE TABLE IF NOT EXISTS fraymus_os_skill_proposals (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      manifest TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'review',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fraymus_os_requests (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      endpoint TEXT,
      route_class TEXT NOT NULL,
      model TEXT,
      bytes_sent INTEGER NOT NULL,
      bytes_received INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      eval_duration_ns INTEGER,
      duration_ms INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fraymus_os_requests_created
      ON fraymus_os_requests(created_at DESC);
  `);
}
