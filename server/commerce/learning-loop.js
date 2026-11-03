import { db } from '../db.js';
import { chatOllama, parseJSON, shopifyHeaders, shopifyBase } from './shared.js';

export function initLearningLoopTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS revenue_attributions (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      order_total REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      source_content_topic TEXT,
      source_platform TEXT,
      source_distribution_run_id TEXT,
      source_creation_run_id TEXT,
      attribution_confidence REAL DEFAULT 0,
      attribution_method TEXT DEFAULT 'utm',
      customer_email TEXT,
      products TEXT DEFAULT '[]',
      raw_order TEXT DEFAULT '{}',
      attributed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rev_topic ON revenue_attributions(source_content_topic, attributed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rev_platform ON revenue_attributions(source_platform, attributed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rev_order ON revenue_attributions(order_id);

    CREATE TABLE IF NOT EXISTS learning_loop_decisions (
      id TEXT PRIMARY KEY,
      decision_type TEXT NOT NULL,
      input_data TEXT DEFAULT '{}',
      recommendation TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      applied INTEGER DEFAULT 0,
      outcome TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lld_type ON learning_loop_decisions(decision_type, created_at DESC);
  `);
}

export function attributeRevenue({ orderId, orderTotal, currency, topic, platform, distributionRunId, creationRunId, confidence, method, customerEmail, products, rawOrder }) {
  const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  db.prepare(`INSERT INTO revenue_attributions
    (id, order_id, order_total, currency, source_content_topic, source_platform, source_distribution_run_id,
     source_creation_run_id, attribution_confidence, attribution_method, customer_email, products, raw_order, attributed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orderId || null, orderTotal || 0, currency || 'USD', topic || null, platform || null,
      distributionRunId || null, creationRunId || null, confidence || 0.5, method || 'utm',
      customerEmail || null, JSON.stringify(products || []), JSON.stringify(rawOrder || {}), now, now);
  return { id, orderTotal, confidence };
}

export function getRevenueByTopic(limit = 20) {
  return db.prepare(`SELECT source_content_topic as topic, COUNT(*) as orders,
    SUM(order_total) as total_revenue, AVG(order_total) as avg_order,
    AVG(attribution_confidence) as avg_confidence,
    GROUP_CONCAT(DISTINCT source_platform) as platforms
    FROM revenue_attributions WHERE source_content_topic IS NOT NULL
    GROUP BY source_content_topic ORDER BY total_revenue DESC LIMIT ?`).all(limit);
}

export function getRevenueByPlatform() {
  return db.prepare(`SELECT source_platform as platform, COUNT(*) as orders,
    SUM(order_total) as total_revenue, AVG(order_total) as avg_order,
    AVG(attribution_confidence) as avg_confidence
    FROM revenue_attributions WHERE source_platform IS NOT NULL
    GROUP BY source_platform ORDER BY total_revenue DESC`).all();
}

export function getRevenueSummary() {
  const total = db.prepare('SELECT COUNT(*) as orders, SUM(order_total) as revenue FROM revenue_attributions').get();
  const byTopic = getRevenueByTopic(10);
  const byPlatform = getRevenueByPlatform();
  const recent = db.prepare(`SELECT date(attributed_at/1000, 'unixepoch') as day,
    COUNT(*) as orders, SUM(order_total) as revenue
    FROM revenue_attributions GROUP BY day ORDER BY day DESC LIMIT 14`).all();
  const decisions = db.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN applied = 1 THEN 1 ELSE 0 END) as applied FROM learning_loop_decisions').get();
  return { totalOrders: total?.orders || 0, totalRevenue: total?.revenue || 0, byTopic, byPlatform, recent, decisions };
}

export async function processShopifyWebhook(order, { broadcast, memoryBridge } = {}) {
  const products = (order.line_items || []).map(li => ({
    title: li.title, quantity: li.quantity, price: parseFloat(li.price),
  }));

  let topic = null;
  let platform = null;
  let distributionRunId = null;
  let confidence = 0.3;
  let method = 'heuristic';

  const refUrl = order.referring_site || '';
  const landingUrl = order.landing_site || '';
  const note = order.note || '';
  const tags = order.tags || '';
  const allText = `${refUrl} ${landingUrl} ${note} ${tags}`.toLowerCase();

  if (allText.includes('utm_source=') || allText.includes('utm_campaign=')) {
    const utmMatch = allText.match(/utm_campaign=([^&\s]+)/);
    const utmSource = allText.match(/utm_source=([^&\s]+)/);
    if (utmMatch) { topic = decodeURIComponent(utmMatch[1]); confidence = 0.85; method = 'utm'; }
    if (utmSource) platform = decodeURIComponent(utmSource[1]);
  }

  if (!topic && allText.includes('chandra_dist=')) {
    const distMatch = allText.match(/chandra_dist=([^&\s]+)/);
    if (distMatch) { distributionRunId = distMatch[1]; confidence = 0.9; method = 'chandra_tag'; }
  }

  if (!topic) {
    const refPlatforms = { 'youtube.com': 'youtube', 'tiktok.com': 'tiktok', 'instagram.com': 'instagram', 'x.com': 'x', 'twitter.com': 'x' };
    for (const [domain, plat] of Object.entries(refPlatforms)) {
      if (refUrl.includes(domain)) { platform = plat; confidence = 0.5; method = 'referrer'; break; }
    }
  }

  if (distributionRunId && !topic) {
    try {
      const run = db.prepare('SELECT * FROM distribution_runs WHERE id = ?').get(distributionRunId);
      if (run) {
        const content = JSON.parse(run.optimized_content || '{}');
        topic = content.topic || content.content_topic || null;
        platform = platform || run.platform;
      }
    } catch {}
  }

  const result = attributeRevenue({
    orderId: String(order.id),
    orderTotal: parseFloat(order.total_price || 0),
    currency: order.currency || 'USD',
    topic, platform, distributionRunId, confidence, method,
    customerEmail: order.email || null,
    products,
    rawOrder: { id: order.id, total_price: order.total_price, referring_site: order.referring_site, landing_site: order.landing_site, tags: order.tags },
  });

  if (memoryBridge) {
    memoryBridge.storeCognitionResult({
      phase: 'commerce_attribution',
      feeling: { primary: 'satisfaction', intensity: Math.min(1, (parseFloat(order.total_price) || 0) / 100) },
      response: `Revenue attribution: $${order.total_price} via ${method} (${(confidence * 100).toFixed(0)}% conf) — topic: ${topic || 'unknown'}`,
      durationMs: 0,
    }).catch(() => {});
  }

  if (broadcast) {
    broadcast('commerce', { type: 'revenue_attribution', orderId: order.id, total: order.total_price, topic, platform, confidence });
  }

  return result;
}

export async function generateDecisions({ memoryBridge, broadcast } = {}) {
  const summary = getRevenueSummary();
  if (summary.totalOrders < 2) return { decisions: [], note: 'need at least 2 attributed orders for recommendations' };

  let analyticsOverview = null;
  try {
    analyticsOverview = db.prepare(`SELECT content_topic, platform, AVG(engagement_rate) as avg_engagement,
      SUM(views) as total_views FROM content_analytics
      WHERE content_topic IS NOT NULL GROUP BY content_topic, platform ORDER BY avg_engagement DESC LIMIT 15`).all();
  } catch {}

  const system = `You are a Commerce Learning Loop engine. Analyze revenue attribution data combined with content analytics to generate strategic recommendations.
Return JSON array: [{ "type": "content_strategy|platform_focus|pricing|timing|topic_priority", "recommendation": "...", "confidence": 0.0-1.0, "expectedImpact": "...", "data": {} }]
Max 5 decisions. Base every recommendation on actual numbers from the data.`;

  const data = { revenueSummary: summary, contentAnalytics: analyticsOverview || [] };
  const raw = await chatOllama([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }]);
  const parsed = parseJSON(raw);
  if (!Array.isArray(parsed)) return { decisions: [], raw };

  const now = Date.now();
  const decisions = [];
  for (const d of parsed.slice(0, 5)) {
    const id = `lld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare('INSERT INTO learning_loop_decisions (id, decision_type, input_data, recommendation, confidence, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, d.type || 'content_strategy', JSON.stringify(d.data || {}), d.recommendation, d.confidence || 0.5, now);
    decisions.push({ id, ...d });
  }

  if (memoryBridge) {
    for (const d of decisions) {
      memoryBridge.storeCognitionResult({
        phase: 'learning_loop_decision',
        feeling: { primary: 'determination', intensity: d.confidence || 0.5 },
        response: `[${d.type}] ${d.recommendation}`,
        durationMs: 0,
      }).catch(() => {});
    }
  }

  if (broadcast) broadcast('commerce', { type: 'learning_loop', decisionCount: decisions.length });

  return { decisions };
}

export function getDecisions(limit = 20) {
  return db.prepare('SELECT * FROM learning_loop_decisions ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function markDecisionApplied(id, outcome) {
  db.prepare('UPDATE learning_loop_decisions SET applied = 1, outcome = ? WHERE id = ?').run(outcome || 'applied', id);
}

export async function pollShopifyOrders({ broadcast, memoryBridge } = {}) {
  const headers = shopifyHeaders();
  const base = shopifyBase();
  if (!headers || !base) return { error: 'Shopify credentials not configured', polled: 0 };

  try {
    const since = db.prepare('SELECT MAX(attributed_at) as latest FROM revenue_attributions').get()?.latest;
    const sinceParam = since ? `&created_at_min=${new Date(since).toISOString()}` : '';
    const res = await fetch(`${base}/orders.json?status=any&limit=50${sinceParam}`, {
      headers, signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `Shopify ${res.status}`, polled: 0 };
    const data = await res.json();
    const orders = data.orders || [];

    let attributed = 0;
    for (const order of orders) {
      const existing = db.prepare('SELECT id FROM revenue_attributions WHERE order_id = ?').get(String(order.id));
      if (existing) continue;
      await processShopifyWebhook(order, { broadcast, memoryBridge });
      attributed++;
    }

    return { polled: orders.length, attributed };
  } catch (e) {
    return { error: e.message, polled: 0 };
  }
}
