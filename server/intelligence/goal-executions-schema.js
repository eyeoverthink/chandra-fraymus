/**
 * The one definition of goal_executions. Three modules extend it at import — the executor (its rows), the outcome
 * scorer (quality, quality_detail) and outcome feedback (quality_machine, quality_human) — and whichever loads first
 * used to decide whether the others could: on a fresh database the scorer's ALTER ran before the executor's CREATE,
 * failed, and the table was later made without its quality columns. Each of them calls this first.
 */
import { db } from '../db.js';

export function ensureGoalExecutionsTable() {
  db.prepare(`CREATE TABLE IF NOT EXISTS goal_executions (
    id TEXT PRIMARY KEY,
    goal_id TEXT NOT NULL,
    agent_id TEXT,
    run_id TEXT,
    thread_id TEXT,
    status TEXT NOT NULL,
    trigger TEXT,
    gate_tier TEXT,
    pressure REAL,
    reply_excerpt TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER
  )`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_goal_exec_goal ON goal_executions(goal_id)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_goal_exec_started ON goal_executions(started_at)`).run();
}
