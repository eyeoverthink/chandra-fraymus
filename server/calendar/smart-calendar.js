import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';

export function initSmartCalendarTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_calendar (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'short_video',
      platforms TEXT DEFAULT '[]',
      scheduled_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      priority REAL DEFAULT 0.5,
      source TEXT DEFAULT 'manual',
      source_id TEXT,
      reasoning TEXT,
      tags TEXT DEFAULT '[]',
      creation_run_id TEXT,
      distribution_run_id TEXT,
      outcome TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_smart_sched ON smart_calendar(scheduled_at, status);
    CREATE INDEX IF NOT EXISTS idx_smart_source ON smart_calendar(source, created_at DESC);

    CREATE TABLE IF NOT EXISTS calendar_patterns (
      id TEXT PRIMARY KEY,
      pattern_type TEXT NOT NULL,
      day_of_week INTEGER,
      hour INTEGER,
      platform TEXT,
      avg_engagement REAL DEFAULT 0,
      sample_count INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_calpattern ON calendar_patterns(pattern_type, confidence DESC);
  `);
}

export function getCalendar({ status, from, to, limit } = {}) {
  let sql = 'SELECT * FROM smart_calendar WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (from) { sql += ' AND scheduled_at >= ?'; params.push(from); }
  if (to) { sql += ' AND scheduled_at <= ?'; params.push(to); }
  sql += ' ORDER BY scheduled_at ASC';
  if (limit) { sql += ' LIMIT ?'; params.push(Math.min(200, Math.max(1, parseInt(limit) || 50))); }
  return db.prepare(sql).all(...params);
}

export function scheduleItem({ topic, format, platforms, scheduledAt, priority, source, sourceId, reasoning, tags }) {
  const id = `scal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO smart_calendar
    (id, topic, format, platforms, scheduled_at, priority, source, source_id, reasoning, tags, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, topic, format || 'short_video', JSON.stringify(platforms || ['youtube', 'tiktok', 'instagram']),
      scheduledAt || now + 86400000, priority || 0.5, source || 'manual', sourceId || null,
      reasoning || null, JSON.stringify(tags || []), now);
  return { id, scheduledAt: scheduledAt || now + 86400000 };
}

export function updateItemStatus(id, status, { creationRunId, distributionRunId, outcome } = {}) {
  const sets = ['status = ?'];
  const params = [status];
  if (creationRunId) { sets.push('creation_run_id = ?'); params.push(creationRunId); }
  if (distributionRunId) { sets.push('distribution_run_id = ?'); params.push(distributionRunId); }
  if (outcome) { sets.push('outcome = ?'); params.push(outcome); }
  params.push(id);
  const info = db.prepare(`UPDATE smart_calendar SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return info.changes > 0;
}

export function cancelItem(id) {
  return updateItemStatus(id, 'cancelled');
}

export function getCalendarStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM smart_calendar').get()?.c || 0;
  const scheduled = db.prepare("SELECT COUNT(*) as c FROM smart_calendar WHERE status = 'scheduled'").get()?.c || 0;
  const completed = db.prepare("SELECT COUNT(*) as c FROM smart_calendar WHERE status = 'completed'").get()?.c || 0;
  const bySource = db.prepare('SELECT source, COUNT(*) as c FROM smart_calendar GROUP BY source').all();
  const upcoming = db.prepare("SELECT * FROM smart_calendar WHERE status = 'scheduled' AND scheduled_at > ? ORDER BY scheduled_at ASC LIMIT 5").all(Date.now());
  const patterns = db.prepare('SELECT * FROM calendar_patterns ORDER BY confidence DESC LIMIT 10').all();
  return { total, scheduled, completed, bySource, upcoming, patterns };
}

export async function learnTimingPatterns() {
  let analytics;
  try {
    analytics = db.prepare(`SELECT platform,
      CAST(strftime('%w', collected_at/1000, 'unixepoch') AS INTEGER) as dow,
      CAST(strftime('%H', collected_at/1000, 'unixepoch') AS INTEGER) as hour,
      AVG(engagement_rate) as avg_eng, COUNT(*) as samples
      FROM content_analytics GROUP BY platform, dow, hour
      HAVING samples >= 2 ORDER BY avg_eng DESC`).all();
  } catch { return { patterns: 0, note: 'no analytics data yet' }; }

  if (!analytics || analytics.length === 0) return { patterns: 0, note: 'no analytics data yet' };

  const now = Date.now();
  let updated = 0;
  for (const row of analytics) {
    const id = `pat_${row.platform}_${row.dow}_${row.hour}`;
    const confidence = Math.min(1, row.samples / 10);
    db.prepare(`INSERT OR REPLACE INTO calendar_patterns
      (id, pattern_type, day_of_week, hour, platform, avg_engagement, sample_count, confidence, updated_at)
      VALUES (?, 'timing', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, row.dow, row.hour, row.platform, row.avg_eng, row.samples, confidence, now);
    updated++;
  }

  return { patterns: updated };
}

export async function suggestSchedule({ count, daysAhead, memoryBridge } = {}) {
  const numSuggestions = count || 5;
  const days = daysAhead || 7;

  const patterns = db.prepare('SELECT * FROM calendar_patterns WHERE confidence > 0.3 ORDER BY avg_engagement DESC LIMIT 20').all();

  let topTopics = [];
  try {
    topTopics = db.prepare(`SELECT content_topic, AVG(engagement_rate) as engagement, COUNT(*) as posts
      FROM content_analytics WHERE content_topic IS NOT NULL
      GROUP BY content_topic ORDER BY engagement DESC LIMIT 10`).all();
  } catch {}

  let revenueTopics = [];
  try {
    revenueTopics = db.prepare(`SELECT source_content_topic as topic, SUM(order_total) as revenue, COUNT(*) as orders
      FROM revenue_attributions WHERE source_content_topic IS NOT NULL
      GROUP BY source_content_topic ORDER BY revenue DESC LIMIT 10`).all();
  } catch {}

  let dreamInsights = [];
  try {
    dreamInsights = db.prepare(`SELECT value FROM agent_memories
      WHERE category = 'dream' AND agent_id = 'system'
      ORDER BY updated_at DESC LIMIT 3`).all().map(r => r.value);
  } catch {}

  let analyticsInsights = [];
  try {
    analyticsInsights = db.prepare('SELECT insight, insight_type, confidence FROM analytics_insights ORDER BY created_at DESC LIMIT 5').all();
  } catch {}

  const system = `You are an Intelligent Content Calendar AI. Suggest ${numSuggestions} content items to schedule over the next ${days} days.
Consider: timing patterns (day/hour with best engagement), top-performing topics, revenue-generating topics, daemon dream insights, and analytics recommendations.
Return JSON array: [{ "topic": "...", "format": "short_video|long_video|article|podcast|social_post", "platforms": ["youtube","tiktok","instagram","x"], "scheduledAt": "ISO date string", "priority": 0.0-1.0, "reasoning": "why this topic + time", "tags": ["tag1"] }]`;

  const data = {
    timingPatterns: patterns.slice(0, 10),
    topTopics: topTopics.slice(0, 8),
    revenueTopics: revenueTopics.slice(0, 5),
    dreamInsights,
    analyticsInsights,
    currentDate: new Date().toISOString(),
  };

  const raw = await chatOllama([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }]);
  const parsed = parseJSON(raw);
  if (!Array.isArray(parsed)) return { suggestions: [], raw };

  const suggestions = [];
  for (const s of parsed.slice(0, numSuggestions)) {
    const scheduledAt = s.scheduledAt ? new Date(s.scheduledAt).getTime() : Date.now() + 86400000 * (suggestions.length + 1);
    if (isNaN(scheduledAt)) continue;
    const item = scheduleItem({
      topic: s.topic || 'suggested topic',
      format: s.format || 'short_video',
      platforms: s.platforms || ['youtube'],
      scheduledAt,
      priority: s.priority || 0.5,
      source: 'ai_suggestion',
      reasoning: s.reasoning || null,
      tags: s.tags || [],
    });
    suggestions.push({ ...item, topic: s.topic, reasoning: s.reasoning });
  }

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'calendar_suggestion',
      feeling: { primary: 'anticipation', intensity: 0.6 },
      response: `Suggested ${suggestions.length} calendar items for next ${days} days`,
      durationMs: 0,
    }).catch(() => {});
  }

  return { suggestions };
}
