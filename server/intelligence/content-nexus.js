import { chatOllama } from '../commerce/shared.js';

const SOURCES = ['youtube', 'web', 'trends', 'browsing', 'calendar'];
const ITEM_TYPES = ['video', 'article', 'trend', 'page', 'scheduled'];

export function createContentNexus({ db, ollamaUrl, broadcast }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nexus_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      item_type TEXT NOT NULL,
      external_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT,
      thumbnail TEXT,
      metadata_json TEXT,
      relevance_score REAL DEFAULT 0.5,
      actionability TEXT,
      tags TEXT,
      acted_on INTEGER DEFAULT 0,
      action_type TEXT,
      action_run_id TEXT,
      surfaced_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_nexus_surfaced ON nexus_items(surfaced_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nexus_source ON nexus_items(source);
  `);

  const insertItem = db.prepare(`
    INSERT OR IGNORE INTO nexus_items (source, item_type, external_id, title, description, url, thumbnail, metadata_json, relevance_score, actionability, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const markActed = db.prepare(`
    UPDATE nexus_items SET acted_on = 1, action_type = ?, action_run_id = ? WHERE id = ?
  `);

  function ingestFromYouTube(limit = 20) {
    const rows = db.prepare(`
      SELECT video_id, title, channel_title, thumbnail, published_at, view_count, outlier_ratio, outlier_tier, search_query
      FROM outlier_board ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    let count = 0;
    for (const r of rows) {
      const meta = { channel: r.channel_title, views: r.view_count, outlierRatio: r.outlier_ratio, tier: r.outlier_tier, query: r.search_query };
      const score = Math.min(1, (r.outlier_ratio || 1) / 10);
      const result = insertItem.run('youtube', 'video', r.video_id, r.title, `${r.channel_title} · ${(r.view_count || 0).toLocaleString()} views`, `https://youtube.com/watch?v=${r.video_id}`, r.thumbnail, JSON.stringify(meta), score, 'commerce,creation', r.search_query || '');
      if (result.changes) count++;
    }
    return count;
  }

  function ingestFromWeb(limit = 20) {
    const rows = db.prepare(`
      SELECT id, record_json, created_at FROM agent_web_sources ORDER BY created_at DESC LIMIT ?
    `).all(limit);
    let count = 0;
    for (const r of rows) {
      try {
        const rec = JSON.parse(r.record_json);
        const title = rec.title || rec.url || `Web source ${r.id}`;
        const desc = rec.summary || rec.snippet || '';
        const url = rec.url || '';
        const result = insertItem.run('web', 'article', `web-${r.id}`, title, desc, url, '', JSON.stringify({ raw_id: r.id }), 0.5, 'creation,repurpose', '');
        if (result.changes) count++;
      } catch {}
    }
    return count;
  }

  function ingestFromTrends(limit = 20) {
    const rows = db.prepare(`
      SELECT id, topic, source, category, relevance_score, velocity, volume, sentiment, keywords, first_seen_at, status
      FROM trend_signals WHERE status != 'expired' ORDER BY relevance_score DESC LIMIT ?
    `).all(limit);
    let count = 0;
    for (const r of rows) {
      const meta = { velocity: r.velocity, volume: r.volume, sentiment: r.sentiment, category: r.category, trendSource: r.source };
      const desc = `${r.category || 'trend'} · velocity ${r.velocity || '?'} · volume ${r.volume || '?'}`;
      const result = insertItem.run('trends', 'trend', `trend-${r.id}`, r.topic, desc, '', '', JSON.stringify(meta), r.relevance_score || 0.5, 'commerce,creation,apparel', r.keywords || '');
      if (result.changes) count++;
    }
    return count;
  }

  function ingestFromBrowsing(limit = 20) {
    let rows;
    try {
      rows = db.prepare(`
        SELECT id, url, domain, title, category, topics, summary, sentiment, actionability, relevance_signals
        FROM cross_tab_visits WHERE category IS NOT NULL ORDER BY visited_at DESC LIMIT ?
      `).all(limit);
    } catch { return 0; }
    let count = 0;
    for (const r of rows) {
      const meta = { domain: r.domain, category: r.category, sentiment: r.sentiment, signals: r.relevance_signals };
      const score = r.actionability === 'high' ? 0.9 : r.actionability === 'medium' ? 0.6 : 0.3;
      const result = insertItem.run('browsing', 'page', `browse-${r.id}`, r.title || r.url, r.summary || '', r.url, '', JSON.stringify(meta), score, r.category || '', r.topics || '');
      if (result.changes) count++;
    }
    return count;
  }

  function ingestFromCalendar(limit = 20) {
    const rows = db.prepare(`
      SELECT id, topic, format, style, platforms, scheduled_at, status, creation_run_id
      FROM content_calendar ORDER BY scheduled_at DESC LIMIT ?
    `).all(limit);
    let count = 0;
    for (const r of rows) {
      const meta = { format: r.format, style: r.style, platforms: r.platforms, status: r.status, runId: r.creation_run_id };
      const result = insertItem.run('calendar', 'scheduled', `cal-${r.id}`, r.topic, `${r.format || 'content'} · ${r.platforms || 'multi'} · ${r.status || 'pending'}`, '', '', JSON.stringify(meta), 0.6, 'creation,distribution', '');
      if (result.changes) count++;
    }
    return count;
  }

  function ingestAll() {
    const ingesters = { youtube: ingestFromYouTube, web: ingestFromWeb, trends: ingestFromTrends, browsing: ingestFromBrowsing, calendar: ingestFromCalendar };
    const counts = {};
    for (const [src, fn] of Object.entries(ingesters)) {
      try { counts[src] = fn(); } catch { counts[src] = 0; }
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0 && broadcast) broadcast('nexus', { type: 'ingested', counts, total });
    return { counts, total };
  }

  function getFeed({ source, limit = 50, offset = 0, acted, minScore } = {}) {
    let sql = 'SELECT * FROM nexus_items WHERE 1=1';
    const params = [];
    if (source && SOURCES.includes(source)) { sql += ' AND source = ?'; params.push(source); }
    if (acted === true) { sql += ' AND acted_on = 1'; }
    if (acted === false) { sql += ' AND acted_on = 0'; }
    if (typeof minScore === 'number') { sql += ' AND relevance_score >= ?'; params.push(minScore); }
    sql += ' ORDER BY relevance_score DESC, surfaced_at DESC LIMIT ? OFFSET ?';
    params.push(Math.min(200, Math.max(1, limit)), Math.max(0, offset));
    const items = db.prepare(sql).all(...params);
    return items.map(i => ({ ...i, metadata: safeParse(i.metadata_json) }));
  }

  function getStats() {
    const total = db.prepare('SELECT COUNT(*) as c FROM nexus_items').get().c;
    const acted = db.prepare('SELECT COUNT(*) as c FROM nexus_items WHERE acted_on = 1').get().c;
    const bySource = db.prepare('SELECT source, COUNT(*) as c FROM nexus_items GROUP BY source').all();
    const byType = db.prepare('SELECT item_type, COUNT(*) as c FROM nexus_items GROUP BY item_type').all();
    const topTags = db.prepare(`SELECT tags, COUNT(*) as c FROM nexus_items WHERE tags != '' GROUP BY tags ORDER BY c DESC LIMIT 10`).all();
    const avgScore = db.prepare('SELECT AVG(relevance_score) as avg FROM nexus_items').get().avg || 0;
    return { total, acted, pending: total - acted, bySource, byType, topTags, avgScore: Math.round(avgScore * 100) / 100 };
  }

  function actOnItem(id, actionType, runId) {
    markActed.run(actionType, runId || null, id);
    const item = db.prepare('SELECT * FROM nexus_items WHERE id = ?').get(id);
    if (item && broadcast) broadcast('nexus', { type: 'acted', item: { ...item, metadata: safeParse(item.metadata_json) }, actionType });
    return item;
  }

  async function generateRecommendations(limit = 5) {
    const pending = db.prepare('SELECT * FROM nexus_items WHERE acted_on = 0 ORDER BY relevance_score DESC LIMIT 20').all();
    if (pending.length === 0) return { recommendations: [], message: 'No pending items to recommend.' };
    const summary = pending.map(i => `[${i.source}] "${i.title}" (score: ${i.relevance_score})`).join('\n');
    try {
      const response = await chatOllama([
        { role: 'system', content: 'You are a content strategist. Given items from YouTube, web research, trends, browsing, and the content calendar, recommend which 5 to act on first and what action (commerce pipeline, creation pipeline, repurpose, distribute). Reply as JSON array: [{id, title, action, reason}]' },
        { role: 'user', content: `Pending items:\n${summary}\n\nPick the top ${limit} to act on and explain why.` }
      ]);
      const parsed = JSON.parse(response.match(/\[[\s\S]*\]/)?.[0] || '[]');
      return { recommendations: parsed.slice(0, limit), itemCount: pending.length };
    } catch (e) {
      return { recommendations: [], error: e.message, itemCount: pending.length };
    }
  }

  return { ingestAll, ingestFromYouTube, ingestFromWeb, ingestFromTrends, ingestFromBrowsing, ingestFromCalendar, getFeed, getStats, actOnItem, generateRecommendations, SOURCES, ITEM_TYPES };
}

function safeParse(json) {
  try { return JSON.parse(json); } catch { return {}; }
}
