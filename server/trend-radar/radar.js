import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';

export function initTrendRadarTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trend_signals (
      id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'llm',
      category TEXT DEFAULT 'general',
      relevance_score REAL DEFAULT 0.5,
      velocity REAL DEFAULT 0,
      volume INTEGER DEFAULT 0,
      sentiment REAL DEFAULT 0,
      keywords TEXT DEFAULT '[]',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'emerging'
    );
    CREATE INDEX IF NOT EXISTS idx_trend_status ON trend_signals(status, relevance_score DESC);
    CREATE INDEX IF NOT EXISTS idx_trend_topic ON trend_signals(topic);

    CREATE TABLE IF NOT EXISTS trend_scans (
      id TEXT PRIMARY KEY,
      scan_type TEXT NOT NULL,
      sources_queried INTEGER DEFAULT 0,
      trends_found INTEGER DEFAULT 0,
      new_trends INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_time ON trend_scans(created_at DESC);
  `);
}

export function getTrends({ status, category, minRelevance, limit } = {}) {
  let sql = 'SELECT * FROM trend_signals WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (minRelevance) { sql += ' AND relevance_score >= ?'; params.push(parseFloat(minRelevance)); }
  sql += ' ORDER BY relevance_score DESC, last_seen_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Math.min(100, parseInt(limit) || 20)); }
  return db.prepare(sql).all(...params);
}

export function getTrend(id) {
  return db.prepare('SELECT * FROM trend_signals WHERE id = ?').get(id);
}

export function getTrendStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM trend_signals').get()?.c || 0;
  const emerging = db.prepare("SELECT COUNT(*) as c FROM trend_signals WHERE status = 'emerging'").get()?.c || 0;
  const trending = db.prepare("SELECT COUNT(*) as c FROM trend_signals WHERE status = 'trending'").get()?.c || 0;
  const peaked = db.prepare("SELECT COUNT(*) as c FROM trend_signals WHERE status = 'peaked'").get()?.c || 0;
  const byCategory = db.prepare('SELECT category, COUNT(*) as c, AVG(relevance_score) as avg_rel FROM trend_signals GROUP BY category').all();
  const recentScans = db.prepare('SELECT * FROM trend_scans ORDER BY created_at DESC LIMIT 5').all();
  const topTrends = db.prepare("SELECT * FROM trend_signals WHERE status IN ('emerging', 'trending') ORDER BY relevance_score DESC LIMIT 10").all();
  return { total, emerging, trending, peaked, byCategory, recentScans, topTrends };
}

export function dismissTrend(id) {
  const info = db.prepare("UPDATE trend_signals SET status = 'dismissed' WHERE id = ?").run(id);
  return info.changes > 0;
}

export async function scanTrends({ niche, sources, memoryBridge } = {}) {
  const startTime = Date.now();
  const nicheContext = niche || 'digital content creation, streaming, AI technology, entrepreneurship';

  let existingTopics = [];
  try {
    existingTopics = db.prepare("SELECT topic FROM trend_signals WHERE status IN ('emerging', 'trending') ORDER BY relevance_score DESC LIMIT 20")
      .all().map(r => r.topic);
  } catch {}

  let recentContent = [];
  try {
    recentContent = db.prepare("SELECT DISTINCT content_topic FROM content_analytics WHERE content_topic IS NOT NULL ORDER BY collected_at DESC LIMIT 10")
      .all().map(r => r.content_topic);
  } catch {}

  let dreamInsights = [];
  try {
    dreamInsights = db.prepare("SELECT value FROM agent_memories WHERE category = 'dream' AND agent_id = 'system' ORDER BY updated_at DESC LIMIT 3")
      .all().map(r => r.value);
  } catch {}

  const system = `You are a Trend Radar for content creators in the niche: ${nicheContext}.
Identify 5-10 EMERGING trends that are gaining momentum RIGHT NOW. Consider:
- Platform algorithm shifts (TikTok, YouTube Shorts, Instagram Reels)
- Audience behavior changes
- New tools, techniques, or formats gaining traction
- Cultural moments that create content opportunities
- Technology trends (AI, AR, live commerce, etc.)

Already tracked topics (don't repeat): ${existingTopics.join(', ') || 'none'}
Recent content topics: ${recentContent.join(', ') || 'none'}
System dream insights: ${dreamInsights.join(' | ') || 'none'}

Return JSON array: [{ "topic": "specific trend name", "category": "tech|culture|platform|format|audience|commerce", "relevance_score": 0.0-1.0, "velocity": 0.0-1.0 (how fast growing), "keywords": ["kw1", "kw2"], "reasoning": "why this matters now" }]`;

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Scan for trends as of ${new Date().toISOString().split('T')[0]}. Focus on actionable trends that could become content in the next 7-14 days.` },
  ]);

  const parsed = parseJSON(raw);
  if (!Array.isArray(parsed)) {
    const scanId = `tscan_${Date.now().toString(36)}`;
    db.prepare('INSERT INTO trend_scans (id, scan_type, sources_queried, trends_found, new_trends, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(scanId, 'llm', 1, 0, 0, Date.now() - startTime, Date.now());
    return { trends: [], newTrends: 0, scanId, raw };
  }

  const now = Date.now();
  let newCount = 0;

  for (const t of parsed) {
    if (!t.topic) continue;

    const existing = db.prepare('SELECT id, relevance_score, volume FROM trend_signals WHERE topic = ?').get(t.topic);
    if (existing) {
      const newRelevance = Math.min(1, (existing.relevance_score + (t.relevance_score || 0.5)) / 2 + 0.05);
      const newStatus = newRelevance > 0.8 ? 'trending' : 'emerging';
      db.prepare('UPDATE trend_signals SET relevance_score = ?, velocity = ?, volume = volume + 1, last_seen_at = ?, status = ?, keywords = ? WHERE id = ?')
        .run(newRelevance, t.velocity || 0, now, newStatus, JSON.stringify(t.keywords || []), existing.id);
    } else {
      const id = `trend_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      db.prepare(`INSERT INTO trend_signals (id, topic, source, category, relevance_score, velocity, volume, keywords, first_seen_at, last_seen_at, status)
        VALUES (?, ?, 'llm', ?, ?, ?, 1, ?, ?, ?, 'emerging')`)
        .run(id, t.topic, t.category || 'general', t.relevance_score || 0.5, t.velocity || 0,
          JSON.stringify(t.keywords || []), now, now);
      newCount++;
    }
  }

  const scanId = `tscan_${Date.now().toString(36)}`;
  db.prepare('INSERT INTO trend_scans (id, scan_type, sources_queried, trends_found, new_trends, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(scanId, 'llm', 1, parsed.length, newCount, Date.now() - startTime, now);

  ageTrends();

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'trend_scan',
      feeling: { primary: 'anticipation', intensity: 0.6 },
      response: `Scanned trends: ${parsed.length} found, ${newCount} new`,
      durationMs: Date.now() - startTime,
    }).catch(() => {});
  }

  return { trends: parsed, newTrends: newCount, totalTracked: getTrends().length, scanId };
}

function ageTrends() {
  const staleThreshold = Date.now() - 7 * 86400000;
  db.prepare("UPDATE trend_signals SET status = 'peaked' WHERE status = 'trending' AND last_seen_at < ?").run(staleThreshold);
  db.prepare("UPDATE trend_signals SET status = 'faded' WHERE status IN ('emerging', 'peaked') AND last_seen_at < ?")
    .run(staleThreshold - 7 * 86400000);
}

export async function assessTrendForContent(trendId, { memoryBridge } = {}) {
  const trend = getTrend(trendId);
  if (!trend) return { error: 'Trend not found' };

  let recentPerformance = [];
  try {
    recentPerformance = db.prepare(`SELECT content_topic, AVG(engagement_rate) as avg_eng, COUNT(*) as posts
      FROM content_analytics WHERE content_topic IS NOT NULL
      GROUP BY content_topic ORDER BY avg_eng DESC LIMIT 10`).all();
  } catch {}

  const system = `You are a content strategist. Assess whether this trend is worth creating content about.
Return JSON: { "verdict": "create|monitor|skip", "confidence": 0.0-1.0, "suggestedFormats": ["short_video", "article", etc], "suggestedAngle": "specific content angle", "timing": "now|this_week|next_week", "reasoning": "why" }`;

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Trend: ${trend.topic} (category: ${trend.category}, relevance: ${trend.relevance_score}, velocity: ${trend.velocity})
Keywords: ${trend.keywords}
Our recent top-performing topics: ${recentPerformance.map(r => `${r.content_topic} (${(r.avg_eng * 100).toFixed(1)}% eng)`).join(', ') || 'none'}` },
  ]);

  const parsed = parseJSON(raw);
  if (!parsed) return { trend, assessment: null, raw };

  if (memoryBridge && parsed.verdict === 'create') {
    memoryBridge.storeCognitionResult({
      phase: 'trend_assessment',
      feeling: { primary: 'excitement', intensity: 0.7 },
      response: `Trend "${trend.topic}" assessed as CREATE-worthy: ${parsed.suggestedAngle}`,
      durationMs: 0,
    }).catch(() => {});
  }

  return { trend, assessment: parsed };
}
