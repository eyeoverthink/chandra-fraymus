import { db } from '../db.js';
import { distributeToAll } from './social.js';
import { createDistributionIntel } from './shared.js';

export function initContentCalendar() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_calendar (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'short_video',
      style TEXT,
      platforms TEXT DEFAULT '[]',
      scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      creation_run_id TEXT,
      distribution_results TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_sched ON content_calendar(scheduled_at, status);

    CREATE TABLE IF NOT EXISTS distribution_runs (
      id TEXT PRIMARY KEY,
      creation_run_id TEXT,
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      optimized_content TEXT,
      publish_result TEXT,
      engagement TEXT,
      created_at INTEGER NOT NULL,
      published_at INTEGER,
      last_checked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_distrun_created ON distribution_runs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_distrun_platform ON distribution_runs(platform, created_at DESC);
  `);
}

export function scheduleContent({ topic, format, style, platforms, scheduledAt }) {
  const id = `cal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO content_calendar (id, topic, format, style, platforms, scheduled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, topic, format || 'short_video', style || null, JSON.stringify(platforms || []), scheduledAt || now + 3600000, now);
  return { id, scheduledAt: scheduledAt || now + 3600000 };
}

export function listScheduled(limit = 50) {
  return db.prepare('SELECT * FROM content_calendar ORDER BY scheduled_at DESC LIMIT ?').all(limit);
}

export function cancelScheduled(id) {
  const info = db.prepare("UPDATE content_calendar SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'").run(id);
  return info.changes > 0;
}

export function recordDistribution({ creationRunId, platform, status, optimizedContent, publishResult }) {
  const id = `dist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO distribution_runs (id, creation_run_id, platform, status, optimized_content, publish_result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, creationRunId || null, platform, status, JSON.stringify(optimizedContent || {}), JSON.stringify(publishResult || {}), now);
  return id;
}

export function listDistributionRuns(limit = 100) {
  return db.prepare('SELECT * FROM distribution_runs ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function getDistributionStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM distribution_runs').get()?.c || 0;
  const byPlatform = db.prepare('SELECT platform, COUNT(*) as c, SUM(CASE WHEN status = "published" THEN 1 ELSE 0 END) as published FROM distribution_runs GROUP BY platform').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM distribution_runs GROUP BY status').all();
  const scheduled = db.prepare("SELECT COUNT(*) as c FROM content_calendar WHERE status = 'scheduled'").get()?.c || 0;
  return { total, byPlatform, byStatus, scheduled };
}

export async function runDistributionPipeline(content, { intel, broadcast, creationRunId } = {}) {
  const platforms = content.platforms || null;

  if (intel?.recallPerformance) {
    const past = await intel.recallPerformance(content.topic);
    if (past.length > 0) {
      content._pastPerformance = past.map(p => p.value || p).slice(0, 3);
    }
  }

  if (intel?.analyzeContent) {
    content._emotion = await intel.analyzeContent(content.topic);
  }

  const results = await distributeToAll(content, platforms);

  for (const r of results) {
    recordDistribution({
      creationRunId,
      platform: r.platform,
      status: r.status,
      optimizedContent: r,
      publishResult: r,
    });
  }

  if (intel?.storeResult) {
    await intel.storeResult(`distribution:${content.topic}:${Date.now()}`, {
      topic: content.topic,
      platforms: results.map(r => r.platform),
      statuses: results.map(r => r.status),
      timestamp: Date.now(),
    });
  }

  if (broadcast) {
    broadcast('creation', { type: 'distribution', topic: content.topic, results: results.length });
  }

  return { results, creationRunId };
}
