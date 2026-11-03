import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';

export function initAudienceTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audience_segments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      criteria TEXT DEFAULT '{}',
      size_estimate INTEGER DEFAULT 0,
      engagement_avg REAL DEFAULT 0,
      revenue_avg REAL DEFAULT 0,
      preferred_formats TEXT DEFAULT '[]',
      preferred_platforms TEXT DEFAULT '[]',
      peak_hours TEXT DEFAULT '[]',
      persona TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seg_status ON audience_segments(status);

    CREATE TABLE IF NOT EXISTS audience_signals (
      id TEXT PRIMARY KEY,
      segment_id TEXT,
      signal_type TEXT NOT NULL,
      platform TEXT,
      content_topic TEXT,
      engagement_rate REAL DEFAULT 0,
      conversion_rate REAL DEFAULT 0,
      revenue REAL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (segment_id) REFERENCES audience_segments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_signal_seg ON audience_signals(segment_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signal_type ON audience_signals(signal_type);

    CREATE TABLE IF NOT EXISTS audience_predictions (
      id TEXT PRIMARY KEY,
      segment_id TEXT,
      content_topic TEXT,
      predicted_engagement REAL,
      predicted_conversion REAL,
      confidence REAL DEFAULT 0.5,
      reasoning TEXT,
      actual_engagement REAL,
      actual_conversion REAL,
      accuracy_score REAL,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      FOREIGN KEY (segment_id) REFERENCES audience_segments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pred_seg ON audience_predictions(segment_id, created_at DESC);
  `);
}

export function getSegments({ status, limit } = {}) {
  let sql = 'SELECT * FROM audience_segments WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY engagement_avg DESC, updated_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(Math.min(100, parseInt(limit) || 20)); }
  return db.prepare(sql).all(...params);
}

export function getSegment(id) {
  return db.prepare('SELECT * FROM audience_segments WHERE id = ?').get(id);
}

export function getSegmentSignals(segmentId, limit = 50) {
  return db.prepare('SELECT * FROM audience_signals WHERE segment_id = ? ORDER BY recorded_at DESC LIMIT ?')
    .all(segmentId, Math.min(200, limit));
}

export function getSegmentPredictions(segmentId, limit = 20) {
  return db.prepare('SELECT * FROM audience_predictions WHERE segment_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(segmentId, Math.min(100, limit));
}

export function recordSignal({ segmentId, signalType, platform, contentTopic, engagementRate, conversionRate, revenue, metadata }) {
  const id = `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO audience_signals (id, segment_id, signal_type, platform, content_topic, engagement_rate, conversion_rate, revenue, metadata, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, segmentId || null, signalType, platform || null, contentTopic || null,
    engagementRate || 0, conversionRate || 0, revenue || 0, JSON.stringify(metadata || {}), now
  );

  if (segmentId) {
    const stats = db.prepare(`SELECT AVG(engagement_rate) as avg_eng, AVG(conversion_rate) as avg_conv, SUM(revenue) as total_rev, COUNT(*) as cnt
      FROM audience_signals WHERE segment_id = ?`).get(segmentId);
    if (stats) {
      db.prepare('UPDATE audience_segments SET engagement_avg = ?, revenue_avg = ?, size_estimate = ?, updated_at = ? WHERE id = ?')
        .run(stats.avg_eng || 0, stats.total_rev ? stats.total_rev / (stats.cnt || 1) : 0, stats.cnt || 0, now, segmentId);
    }
  }
  return { id, recorded: true };
}

export function createSegment({ name, description, criteria, preferredFormats, preferredPlatforms, peakHours }) {
  const id = `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO audience_segments (id, name, description, criteria, preferred_formats, preferred_platforms, peak_hours, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`).run(
    id, name, description || '', JSON.stringify(criteria || {}),
    JSON.stringify(preferredFormats || []), JSON.stringify(preferredPlatforms || []),
    JSON.stringify(peakHours || []), now, now
  );
  return { id, name, created: true };
}

export function getAudienceStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM audience_segments').get()?.c || 0;
  const active = db.prepare("SELECT COUNT(*) as c FROM audience_segments WHERE status = 'active'").get()?.c || 0;
  const signals = db.prepare('SELECT COUNT(*) as c FROM audience_signals').get()?.c || 0;
  const predictions = db.prepare('SELECT COUNT(*) as c FROM audience_predictions').get()?.c || 0;
  const avgAccuracy = db.prepare('SELECT AVG(accuracy_score) as avg FROM audience_predictions WHERE accuracy_score IS NOT NULL').get()?.avg;
  const topSegments = db.prepare("SELECT id, name, engagement_avg, revenue_avg, size_estimate FROM audience_segments WHERE status = 'active' ORDER BY engagement_avg DESC LIMIT 5").all();
  const recentSignals = db.prepare('SELECT signal_type, COUNT(*) as c, AVG(engagement_rate) as avg_eng FROM audience_signals GROUP BY signal_type ORDER BY c DESC LIMIT 10').all();
  return { total, active, signals, predictions, avgAccuracy, topSegments, recentSignals };
}

export async function discoverSegments({ memoryBridge } = {}) {
  const startTime = Date.now();

  let engagementData = [];
  try {
    engagementData = db.prepare(`SELECT content_topic, platform, AVG(engagement_rate) as avg_eng, AVG(conversion_rate) as avg_conv,
      COUNT(*) as interactions FROM audience_signals WHERE recorded_at > ?
      GROUP BY content_topic, platform ORDER BY avg_eng DESC LIMIT 30`)
      .all(Date.now() - 30 * 86400000);
  } catch {}

  let revenueData = [];
  try {
    revenueData = db.prepare(`SELECT source_content_topic as topic, source_platform as platform, SUM(order_total) as total_rev, COUNT(*) as orders
      FROM revenue_attributions WHERE attributed_at > ?
      GROUP BY source_content_topic, source_platform ORDER BY total_rev DESC LIMIT 20`)
      .all(Date.now() - 30 * 86400000);
  } catch {}

  let existingSegments = [];
  try {
    existingSegments = db.prepare("SELECT name, description FROM audience_segments WHERE status = 'active'").all();
  } catch {}

  let trendTopics = [];
  try {
    trendTopics = db.prepare("SELECT topic, category FROM trend_signals WHERE status IN ('emerging', 'trending') ORDER BY relevance_score DESC LIMIT 10").all();
  } catch {}

  const system = `You are an audience intelligence analyst for a content creator / entrepreneur. Analyze the data and discover distinct audience segments.

Existing segments (don't duplicate): ${existingSegments.map(s => s.name).join(', ') || 'none'}

Return JSON array of 3-5 NEW segments:
[{
  "name": "Segment Name (specific, behavioral)",
  "description": "Who they are and why they matter",
  "criteria": { "interests": ["..."], "behavior": "description", "demographics": "broad" },
  "preferred_formats": ["short_video", "article", "tutorial", "live_stream", etc],
  "preferred_platforms": ["youtube", "tiktok", "instagram", "x", etc],
  "peak_hours": [9, 12, 18, 21],
  "estimated_engagement": 0.0-1.0
}]`;

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Engagement data:\n${JSON.stringify(engagementData.slice(0, 15))}\n\nRevenue data:\n${JSON.stringify(revenueData.slice(0, 10))}\n\nTrending topics: ${trendTopics.map(t => t.topic).join(', ') || 'none'}\n\nDiscover audience segments based on this behavioral data.` },
  ]);

  const parsed = parseJSON(raw);
  if (!Array.isArray(parsed)) return { segments: [], raw };

  const created = [];
  const now = Date.now();
  for (const seg of parsed) {
    if (!seg.name) continue;
    const existing = db.prepare('SELECT id FROM audience_segments WHERE name = ?').get(seg.name);
    if (existing) continue;

    const id = `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`INSERT INTO audience_segments (id, name, description, criteria, preferred_formats, preferred_platforms, peak_hours, engagement_avg, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'llm-discovery', ?, ?)`).run(
      id, seg.name, seg.description || '', JSON.stringify(seg.criteria || {}),
      JSON.stringify(seg.preferred_formats || []), JSON.stringify(seg.preferred_platforms || []),
      JSON.stringify(seg.peak_hours || []), seg.estimated_engagement || 0, now, now
    );
    created.push({ id, name: seg.name });
  }

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'audience_discovery',
      feeling: { primary: 'curiosity', intensity: 0.7 },
      response: `Discovered ${created.length} audience segments from behavioral data`,
      durationMs: Date.now() - startTime,
    }).catch(() => {});
  }

  return { segments: created, total: parsed.length, duration: Date.now() - startTime };
}

export async function predictEngagement(segmentId, contentTopic, { memoryBridge } = {}) {
  const segment = getSegment(segmentId);
  if (!segment) return { error: 'Segment not found' };

  let pastPerformance = [];
  try {
    pastPerformance = db.prepare(`SELECT content_topic, AVG(engagement_rate) as avg_eng, AVG(conversion_rate) as avg_conv, COUNT(*) as cnt
      FROM audience_signals WHERE segment_id = ? AND content_topic IS NOT NULL
      GROUP BY content_topic ORDER BY avg_eng DESC LIMIT 15`).all(segmentId);
  } catch {}

  let pastPredictions = [];
  try {
    pastPredictions = db.prepare(`SELECT content_topic, predicted_engagement, actual_engagement, accuracy_score
      FROM audience_predictions WHERE segment_id = ? AND accuracy_score IS NOT NULL
      ORDER BY created_at DESC LIMIT 10`).all(segmentId);
  } catch {}

  const system = `You are a predictive analytics engine. Given an audience segment and content topic, predict engagement.

Return JSON: {
  "predicted_engagement": 0.0-1.0,
  "predicted_conversion": 0.0-1.0,
  "confidence": 0.0-1.0,
  "reasoning": "why this prediction",
  "optimization_tips": ["tip1", "tip2"]
}`;

  let prefs = [];
  try { prefs = JSON.parse(segment.preferred_formats || '[]'); } catch {}
  let platforms = [];
  try { platforms = JSON.parse(segment.preferred_platforms || '[]'); } catch {}

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Segment: ${segment.name}\nDescription: ${segment.description}\nPreferred formats: ${prefs.join(', ')}\nPreferred platforms: ${platforms.join(', ')}\nHistorical avg engagement: ${segment.engagement_avg?.toFixed(3)}\n\nContent topic: "${contentTopic}"\n\nPast performance on similar topics:\n${JSON.stringify(pastPerformance.slice(0, 8))}\n\nPast prediction accuracy:\n${JSON.stringify(pastPredictions.slice(0, 5))}` },
  ]);

  const parsed = parseJSON(raw);
  if (!parsed) return { segment, prediction: null, raw };

  const id = `pred_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO audience_predictions (id, segment_id, content_topic, predicted_engagement, predicted_conversion, confidence, reasoning, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, segmentId, contentTopic, parsed.predicted_engagement || 0, parsed.predicted_conversion || 0,
    parsed.confidence || 0.5, parsed.reasoning || '', Date.now()
  );

  return { segment: { id: segment.id, name: segment.name }, prediction: { id, ...parsed } };
}

export async function generatePersona(segmentId, { memoryBridge } = {}) {
  const segment = getSegment(segmentId);
  if (!segment) return { error: 'Segment not found' };

  const signals = getSegmentSignals(segmentId, 30);
  let criteria = {};
  try { criteria = JSON.parse(segment.criteria || '{}'); } catch {}

  const system = `You are a marketing persona architect. Create a vivid, actionable persona for this audience segment.

Return JSON: {
  "persona_name": "First Last (fictional)",
  "age_range": "25-34",
  "occupation": "specific role",
  "goals": ["goal1", "goal2"],
  "pain_points": ["pain1", "pain2"],
  "content_preferences": { "formats": [...], "tone": "...", "length": "..." },
  "buying_triggers": ["trigger1", "trigger2"],
  "objections": ["objection1"],
  "platforms_used": ["platform1", "platform2"],
  "quote": "Something this persona would say",
  "day_in_the_life": "Brief narrative"
}`;

  const raw = await chatOllama([
    { role: 'system', content: system },
    { role: 'user', content: `Segment: ${segment.name}\nDescription: ${segment.description}\nCriteria: ${JSON.stringify(criteria)}\nAvg engagement: ${segment.engagement_avg?.toFixed(3)}\nAvg revenue: ${segment.revenue_avg?.toFixed(2)}\nRecent signals: ${signals.length} data points across ${[...new Set(signals.map(s => s.platform).filter(Boolean))].join(', ') || 'various'} platforms` },
  ]);

  const parsed = parseJSON(raw);
  if (!parsed) return { segment, persona: null, raw };

  db.prepare('UPDATE audience_segments SET persona = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(parsed), Date.now(), segmentId);

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'persona_generation',
      feeling: { primary: 'empathy', intensity: 0.6 },
      response: `Generated persona "${parsed.persona_name}" for segment "${segment.name}"`,
      durationMs: 0,
    }).catch(() => {});
  }

  return { segment: { id: segment.id, name: segment.name }, persona: parsed };
}
