import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { DATA_DIR } from './config.js';

const dataDir = DATA_DIR;
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'chandra.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  host TEXT,
  status TEXT DEFAULT 'offline',
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'unread',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  title TEXT,
  model TEXT,
  state TEXT DEFAULT 'active',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memory (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  secret_hex TEXT NOT NULL,
  dna_hex TEXT NOT NULL,
  sec_bits INTEGER DEFAULT 256,
  counter INTEGER DEFAULT 1,
  trust INTEGER DEFAULT 12,
  coverage REAL DEFAULT 14,
  evolutions INTEGER DEFAULT 0,
  baseline_hash TEXT NOT NULL,
  wasm_hex TEXT NOT NULL,
  active_canary TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_genesis_chain (
  idx INTEGER PRIMARY KEY,
  previous_hash TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  attack_pattern TEXT NOT NULL,
  dna_mutation TEXT NOT NULL,
  evolution_score REAL NOT NULL,
  nonce TEXT NOT NULL,
  counter INTEGER NOT NULL,
  hash TEXT NOT NULL,
  hmac TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_nonces (
  nonce TEXT PRIMARY KEY,
  canary_id TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS v3_attacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attack_id INTEGER NOT NULL,
  vector TEXT NOT NULL,
  status TEXT NOT NULL,
  metric TEXT,
  detail TEXT,
  time_ms REAL DEFAULT 0,
  hmac_ok INTEGER DEFAULT 0,
  freshness_ok INTEGER DEFAULT 0,
  similarity REAL DEFAULT 0,
  predicted_next INTEGER DEFAULT 1,
  prob REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_to ON mail(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_v3_attacks_time ON v3_attacks(created_at DESC);
`);

export function logEvent(kind, actor, detail) {
  db.prepare('INSERT INTO events (kind, actor, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(kind, actor, detail, Date.now());
}

const hasData = db.prepare('SELECT COUNT(*) AS n FROM agents').get().n > 0;
if (!hasData) {
  const now = Date.now();
  const insA = db.prepare('INSERT INTO agents (id, name, role, host, status, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
  insA.run('main', 'main', 'local agent', hostname(), 'idle', now);
  insA.run('tango', 'Tango', 'OpenClaw node (this computer)', hostname(), 'offline', now);
  insA.run('eyekaughn', 'eyekaughn', 'historical gateway record', 'macbook-pro', 'historical', now);
  const insM = db.prepare('INSERT INTO mail (from_agent, to_agent, subject, body, created_at) VALUES (?, ?, ?, ?, ?)');
  insM.run('eyekaughn', 'tango', 'historical bootstrap example', 'Imported example from the original Mac installation; pairing and reachability have not been verified on this computer.', now - 3.6e6);
  insM.run('tango', 'eyekaughn', 'historical handoff example', 'Original bootstrap record retained as reference, not current service health.', now - 3.5e6);
  db.prepare('INSERT INTO sessions (id, agent_id, title, model, tokens_in, tokens_out, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('sess-bootstrap', 'tango', 'iMac node bootstrap', 'swe-2', 12000, 4000, now - 3.7e6, now - 3.5e6);
  logEvent('seed', 'system', 'database initialized with bootstrap records');
  logEvent('history.import', 'tango', 'Original node topology retained as historical reference only');
}
