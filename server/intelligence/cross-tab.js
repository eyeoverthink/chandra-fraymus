/**
 * Cross-Tab Intelligence — learns from browsing patterns.
 *
 * Receives page visits (from Chrome extension bridge, manual ingestion, or
 * bus events), extracts content, classifies topics, clusters interests,
 * and feeds insights into Perspective + Memory Bridge.
 *
 * The system learns what the user is consuming without changing their
 * browsing habits. When they open Chandra it already knows what they've
 * been reading, watching, and shopping for — and connects the dots.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { chatOllama } from '../commerce/shared.js';
import { publish } from '../fleet/bus.js';

const now = () => Date.now();

const CATEGORIES = [
  'tech', 'news', 'entertainment', 'shopping', 'social',
  'research', 'finance', 'creative', 'education', 'other',
];

const CLASSIFY_PROMPT = `You are a content classifier for an AI intelligence system. Given the page title, URL, and content excerpt below, respond with JSON only (no markdown fences):

{
  "category": "one of: tech, news, entertainment, shopping, social, research, finance, creative, education, other",
  "topics": ["topic1", "topic2", "topic3"],
  "entities": ["entity1", "entity2"],
  "summary": "1-2 sentence summary of the page content",
  "sentiment": "positive | negative | neutral | mixed",
  "actionability": 0.0-1.0,
  "relevance_signals": ["why this might matter for content creation, commerce, or trend awareness"]
}

Page title: {title}
URL: {url}
Content excerpt (first 2000 chars):
{content}`;

const INSIGHT_PROMPT = `You are the Cross-Tab Intelligence engine of FRAYMUS. Analyze the user's recent browsing pattern below and identify actionable insights. Respond with JSON only (no markdown fences):

{
  "clusters": [
    {
      "theme": "short theme label",
      "pages": ["url1", "url2"],
      "insight": "what this cluster of pages reveals about user interest",
      "opportunity": "how this connects to content creation, commerce, or distribution"
    }
  ],
  "emerging_interests": ["interest that appeared across multiple visits"],
  "cross_domain_connections": [
    {
      "domains": ["domain1.com", "domain2.com"],
      "connection": "how these relate despite being different sites"
    }
  ],
  "suggestions": [
    "concrete actionable suggestion based on browsing patterns"
  ],
  "confidence": 0.0-1.0
}

Recent browsing data (last {count} visits):
{visits}`;

function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS cross_tab_visits (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    domain TEXT NOT NULL,
    title TEXT,
    category TEXT DEFAULT 'other',
    topics TEXT DEFAULT '[]',
    entities TEXT DEFAULT '[]',
    summary TEXT,
    sentiment TEXT,
    actionability REAL DEFAULT 0,
    relevance_signals TEXT DEFAULT '[]',
    content_hash TEXT,
    source TEXT DEFAULT 'extension',
    visited_at INTEGER NOT NULL,
    classified_at INTEGER,
    created_at INTEGER NOT NULL
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS cross_tab_insights (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    visit_count INTEGER DEFAULT 0,
    confidence REAL DEFAULT 0,
    acted_on INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER
  )`).run();

  db.prepare(`CREATE TABLE IF NOT EXISTS cross_tab_topic_clusters (
    id TEXT PRIMARY KEY,
    theme TEXT NOT NULL,
    visit_ids TEXT DEFAULT '[]',
    insight TEXT,
    opportunity TEXT,
    strength REAL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  )`).run();

  db.prepare('CREATE INDEX IF NOT EXISTS idx_ctv_domain ON cross_tab_visits(domain)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_ctv_category ON cross_tab_visits(category)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_ctv_visited ON cross_tab_visits(visited_at)').run();
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

function simpleHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h.toString(36);
}

export function recordVisit({ url, title, content, source = 'extension' } = {}) {
  ensureTables();
  if (!url) throw new Error('URL is required');

  const domain = domainOf(url);
  const contentHash = content ? simpleHash(content.slice(0, 5000)) : null;

  // Deduplicate: skip if same URL visited within last 5 minutes
  const recent = db.prepare(
    'SELECT id FROM cross_tab_visits WHERE url = ? AND visited_at > ? LIMIT 1'
  ).get(url, now() - 5 * 60_000);
  if (recent) return { id: recent.id, deduplicated: true };

  const id = randomUUID().slice(0, 12);
  db.prepare(`INSERT INTO cross_tab_visits (id, url, domain, title, content_hash, source, visited_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, url, domain, title || '', contentHash, source, now(), now());

  try {
    publish('system', 'system.cross-tab', JSON.stringify({
      action: 'visit', id, url, domain, title, source,
    }));
  } catch (_) {}

  return { id, domain, deduplicated: false };
}

export async function classifyVisit(id, { content } = {}) {
  ensureTables();
  const visit = db.prepare('SELECT * FROM cross_tab_visits WHERE id = ?').get(id);
  if (!visit) throw new Error(`Visit ${id} not found`);

  const excerpt = (content || '').slice(0, 2000) || visit.title || visit.url;
  const prompt = CLASSIFY_PROMPT
    .replace('{title}', visit.title || '(no title)')
    .replace('{url}', visit.url)
    .replace('{content}', excerpt);

  const raw = await chatOllama([{ role: 'user', content: prompt }], { temperature: 0.3 });
  let parsed;
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { category: 'other', topics: [], entities: [], summary: raw.slice(0, 200), sentiment: 'neutral', actionability: 0, relevance_signals: [] };
  }

  parsed.topics = Array.isArray(parsed.topics) ? parsed.topics : [];
  parsed.entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  parsed.relevance_signals = Array.isArray(parsed.relevance_signals) ? parsed.relevance_signals : [];
  parsed.actionability = Number.isFinite(parsed.actionability) ? parsed.actionability : 0;

  const category = CATEGORIES.includes(parsed.category) ? parsed.category : 'other';

  db.prepare(`UPDATE cross_tab_visits SET
    category = ?, topics = ?, entities = ?, summary = ?,
    sentiment = ?, actionability = ?, relevance_signals = ?, classified_at = ?
    WHERE id = ?`).run(
    category,
    JSON.stringify(parsed.topics || []),
    JSON.stringify(parsed.entities || []),
    parsed.summary || '',
    parsed.sentiment || 'neutral',
    parsed.actionability || 0,
    JSON.stringify(parsed.relevance_signals || []),
    now(), id,
  );

  try {
    publish('system', 'system.cross-tab', JSON.stringify({
      action: 'classified', id, category, topics: parsed.topics,
    }));
  } catch (_) {}

  return { id, ...parsed, category };
}

export async function recordAndClassify({ url, title, content, source = 'extension' } = {}) {
  const visit = recordVisit({ url, title, content, source });
  if (visit.deduplicated) {
    const existing = db.prepare('SELECT classified_at FROM cross_tab_visits WHERE id = ?').get(visit.id);
    if (existing?.classified_at) return { ...visit, classified: true, skipped: 'already_classified' };
  }

  try {
    const classification = await classifyVisit(visit.id, { content });
    return { ...visit, ...classification, classified: true };
  } catch (e) {
    return { ...visit, classified: false, classifyError: e.message };
  }
}

export function getVisits({ limit = 50, offset = 0, category, domain, since } = {}) {
  ensureTables();
  let sql = 'SELECT * FROM cross_tab_visits WHERE 1=1';
  const params = [];

  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (domain) { sql += ' AND domain = ?'; params.push(domain); }
  if (since) { sql += ' AND visited_at > ?'; params.push(since); }

  sql += ' ORDER BY visited_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(200, Math.max(1, parseInt(limit) || 50)), Math.max(0, parseInt(offset) || 0));

  return db.prepare(sql).all(...params);
}

export function getVisitStats() {
  ensureTables();
  const total = db.prepare('SELECT COUNT(*) as c FROM cross_tab_visits').get().c;
  const classified = db.prepare('SELECT COUNT(*) as c FROM cross_tab_visits WHERE classified_at IS NOT NULL').get().c;
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM cross_tab_visits GROUP BY category ORDER BY count DESC').all();
  const byDomain = db.prepare('SELECT domain, COUNT(*) as count FROM cross_tab_visits GROUP BY domain ORDER BY count DESC LIMIT 20').all();
  const recentCount = db.prepare('SELECT COUNT(*) as c FROM cross_tab_visits WHERE visited_at > ?').get(now() - 24 * 60 * 60_000).c;
  const insightCount = db.prepare('SELECT COUNT(*) as c FROM cross_tab_insights').get().c;
  const clusterCount = db.prepare('SELECT COUNT(*) as c FROM cross_tab_topic_clusters').get().c;

  return { total, classified, unclassified: total - classified, recentCount, insightCount, clusterCount, byCategory, byDomain };
}

export async function generateInsights({ hours = 24, memoryBridge } = {}) {
  ensureTables();
  const since = now() - hours * 60 * 60_000;
  const visits = db.prepare(
    'SELECT url, domain, title, category, topics, summary, sentiment, actionability FROM cross_tab_visits WHERE visited_at > ? AND classified_at IS NOT NULL ORDER BY visited_at DESC LIMIT 100'
  ).all(since);

  if (visits.length < 3) return { insights: null, reason: 'Not enough classified visits to generate insights (need 3+)' };

  const visitsText = visits.map((v, i) =>
    `${i + 1}. [${v.category}] ${v.title || v.url}\n   ${v.domain} — ${v.summary || '(no summary)'}\n   Topics: ${v.topics}`
  ).join('\n\n');

  const prompt = INSIGHT_PROMPT
    .replace('{count}', String(visits.length))
    .replace('{visits}', visitsText);

  const raw = await chatOllama([{ role: 'user', content: prompt }], { temperature: 0.4 });
  let parsed;
  try {
    const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { clusters: [], emerging_interests: [], cross_domain_connections: [], suggestions: [raw.slice(0, 300)], confidence: 0.3 };
  }

  // Store insights
  const insightId = randomUUID().slice(0, 12);
  db.prepare('INSERT INTO cross_tab_insights (id, type, data, visit_count, confidence, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    insightId, 'browsing_analysis', JSON.stringify(parsed), visits.length, parsed.confidence || 0.5, now(), now() + 48 * 60 * 60_000,
  );

  // Update/create topic clusters
  for (const cluster of (parsed.clusters || [])) {
    const existing = db.prepare('SELECT id FROM cross_tab_topic_clusters WHERE theme = ?').get(cluster.theme);
    if (existing) {
      db.prepare('UPDATE cross_tab_topic_clusters SET visit_ids = ?, insight = ?, opportunity = ?, strength = strength + 0.1, last_seen = ? WHERE id = ?').run(
        JSON.stringify(cluster.pages || []), cluster.insight, cluster.opportunity, now(), existing.id,
      );
    } else {
      db.prepare('INSERT INTO cross_tab_topic_clusters (id, theme, visit_ids, insight, opportunity, strength, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        randomUUID().slice(0, 12), cluster.theme, JSON.stringify(cluster.pages || []), cluster.insight, cluster.opportunity, 0.5, now(), now(),
      );
    }
  }

  // Store to Memory Bridge if available
  if (memoryBridge) {
    try {
      const content = `Cross-Tab Intelligence insight: ${(parsed.emerging_interests || []).join(', ')}. ` +
        `${(parsed.suggestions || []).slice(0, 2).join('. ')}. ` +
        `Based on ${visits.length} page visits over last ${hours}h.`;
      await memoryBridge.vertiso.store({
        agentId: 'cross-tab-intelligence',
        content,
        namespace: 'browsing',
        importance: Math.min(1, (parsed.confidence || 0.5) * 1.2),
        provenance: 'measured',
        confidence: parsed.confidence || 0.5,
        metadata: { type: 'cross_tab_insight', visitCount: visits.length, hours },
      });
    } catch (_) {}
  }

  try {
    publish('system', 'system.cross-tab', JSON.stringify({
      action: 'insights_generated', insightId, visitCount: visits.length,
      clusterCount: (parsed.clusters || []).length,
      interests: parsed.emerging_interests || [],
    }));
  } catch (_) {}

  return { id: insightId, ...parsed, visitCount: visits.length };
}

export function getInsights({ limit = 20 } = {}) {
  ensureTables();
  return db.prepare('SELECT * FROM cross_tab_insights ORDER BY created_at DESC LIMIT ?').all(Math.min(100, Math.max(1, limit)));
}

export function getClusters({ limit = 20 } = {}) {
  ensureTables();
  return db.prepare('SELECT * FROM cross_tab_topic_clusters ORDER BY last_seen DESC LIMIT ?').all(Math.min(100, Math.max(1, limit)));
}

export function getPerspectiveContext() {
  ensureTables();
  const recentVisits = db.prepare(
    'SELECT category, topics, summary FROM cross_tab_visits WHERE visited_at > ? AND classified_at IS NOT NULL ORDER BY visited_at DESC LIMIT 10'
  ).all(now() - 6 * 60 * 60_000);

  if (recentVisits.length === 0) return null;

  const categories = {};
  const allTopics = new Set();
  for (const v of recentVisits) {
    categories[v.category] = (categories[v.category] || 0) + 1;
    try { for (const t of JSON.parse(v.topics || '[]')) allTopics.add(t); } catch (_) {}
  }

  const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];
  const topicList = [...allTopics].slice(0, 8).join(', ');

  return `[Cross-Tab Context] User recently browsed ${recentVisits.length} pages, primarily ${topCategory[0]} (${topCategory[1]} visits). Active topics: ${topicList}. Consider these interests when framing responses.`;
}

export function pruneOldVisits(daysToKeep = 30) {
  ensureTables();
  const cutoff = now() - daysToKeep * 24 * 60 * 60_000;
  const result = db.prepare('DELETE FROM cross_tab_visits WHERE visited_at < ?').run(cutoff);
  db.prepare('DELETE FROM cross_tab_insights WHERE expires_at < ?').run(now());
  return { pruned: result.changes };
}
