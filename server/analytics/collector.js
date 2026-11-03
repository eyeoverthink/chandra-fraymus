import { db } from '../db.js';
import { chatOllama, parseJSON } from '../distribution/shared.js';

export function initAnalyticsTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_analytics (
      id TEXT PRIMARY KEY,
      distribution_run_id TEXT,
      creation_run_id TEXT,
      platform TEXT NOT NULL,
      content_topic TEXT,
      views INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      shares INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      click_through_rate REAL DEFAULT 0,
      watch_time_avg REAL DEFAULT 0,
      engagement_rate REAL DEFAULT 0,
      revenue_attributed REAL DEFAULT 0,
      raw_metrics TEXT DEFAULT '{}',
      collected_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_analytics_platform ON content_analytics(platform, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_topic ON content_analytics(content_topic, collected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_analytics_creation ON content_analytics(creation_run_id, collected_at DESC);

    CREATE TABLE IF NOT EXISTS analytics_insights (
      id TEXT PRIMARY KEY,
      insight_type TEXT NOT NULL,
      topic TEXT,
      platform TEXT,
      insight TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      source_metrics TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insight_type ON analytics_insights(insight_type, created_at DESC);
  `);
}

export function recordMetrics({ distributionRunId, creationRunId, platform, topic, metrics }) {
  const id = `anl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const { views = 0, likes = 0, shares = 0, comments = 0, ctr = 0, watchTimeAvg = 0 } = metrics;
  const engagementRate = views > 0 ? ((likes + shares + comments) / views) * 100 : 0;

  db.prepare(`INSERT INTO content_analytics
    (id, distribution_run_id, creation_run_id, platform, content_topic, views, likes, shares, comments,
     click_through_rate, watch_time_avg, engagement_rate, revenue_attributed, raw_metrics, collected_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, distributionRunId || null, creationRunId || null, platform, topic || null,
      views, likes, shares, comments, ctr, watchTimeAvg, engagementRate, metrics.revenue || 0,
      JSON.stringify(metrics), now, now);
  return { id, engagementRate };
}

export function getTopPerformers(platform = null, limit = 10) {
  const sql = platform
    ? 'SELECT * FROM content_analytics WHERE platform = ? ORDER BY engagement_rate DESC LIMIT ?'
    : 'SELECT * FROM content_analytics ORDER BY engagement_rate DESC LIMIT ?';
  return platform ? db.prepare(sql).all(platform, limit) : db.prepare(sql).all(limit);
}

export function getAnalyticsByTopic(topic, limit = 20) {
  return db.prepare('SELECT * FROM content_analytics WHERE content_topic LIKE ? ORDER BY collected_at DESC LIMIT ?')
    .all(`%${topic}%`, limit);
}

export function getAnalyticsOverview() {
  const total = db.prepare('SELECT COUNT(*) as c FROM content_analytics').get()?.c || 0;
  const byPlatform = db.prepare(`SELECT platform, COUNT(*) as posts, SUM(views) as views, SUM(likes) as likes,
    AVG(engagement_rate) as avg_engagement, SUM(revenue_attributed) as revenue
    FROM content_analytics GROUP BY platform`).all();
  const topTopics = db.prepare(`SELECT content_topic, COUNT(*) as posts, AVG(engagement_rate) as avg_engagement,
    SUM(views) as total_views FROM content_analytics WHERE content_topic IS NOT NULL
    GROUP BY content_topic ORDER BY avg_engagement DESC LIMIT 10`).all();
  const recentTrend = db.prepare(`SELECT date(collected_at/1000, 'unixepoch') as day, COUNT(*) as posts,
    SUM(views) as views, AVG(engagement_rate) as engagement
    FROM content_analytics GROUP BY day ORDER BY day DESC LIMIT 14`).all();
  return { total, byPlatform, topTopics, recentTrend };
}

export async function generateInsights(memoryBridge) {
  const overview = getAnalyticsOverview();
  const topPerformers = getTopPerformers(null, 5);
  if (overview.total < 3) return { insights: [], note: 'not enough data yet — need at least 3 analytics entries' };

  const system = `You are an analytics intelligence engine. Analyze content performance data and generate actionable insights.
Return JSON array: [{ "type": "pattern|recommendation|warning", "topic": "...", "platform": "...", "insight": "...", "confidence": 0.0-1.0 }]
Max 5 insights. Be specific — reference actual numbers and topics from the data.`;

  const user = JSON.stringify({ overview, topPerformers });
  const raw = await chatOllama(system, user);
  const parsed = parseJSON(raw);
  if (!parsed || !Array.isArray(parsed)) return { insights: [], raw };

  const now = Date.now();
  const insights = [];
  for (const item of parsed.slice(0, 5)) {
    const id = `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare('INSERT INTO analytics_insights (id, insight_type, topic, platform, insight, confidence, source_metrics, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, item.type || 'pattern', item.topic || null, item.platform || null, item.insight, item.confidence || 0.5, JSON.stringify({ overview_total: overview.total }), now);
    insights.push({ id, ...item });

    if (memoryBridge?.store) {
      try {
        memoryBridge.store(`analytics_insight:${item.type}:${id}`, item.insight, { provenance: 'measured', type: 'analytics' });
      } catch {}
    }
  }

  return { insights };
}

export function getInsights(limit = 20) {
  return db.prepare('SELECT * FROM analytics_insights ORDER BY created_at DESC LIMIT ?').all(limit);
}
