/**
 * World Pollers — Phase X: senses that actually fetch.
 *
 * Phase Q gave the organism `web` and `youtube` senses, but they only read tables that
 * agent runs happen to fill (agent_web_sources is the agent runtime's run-scoped,
 * integrity-hashed store; outlier_board needs a YouTube API key). Nothing went out to
 * look. Measured 2026-11-09: web 0, youtube 0, for days.
 *
 * This module goes out — on its own 30 min loop, resource-aware, with no paid APIs:
 *   web      DuckDuckGo HTML endpoint (same keyless path the Hermes `duckduckgo_search`
 *            executor has used for weeks), 2 queries per cycle
 *   youtube  channel RSS feeds (youtube.com/feeds/videos.xml, keyless, stable XML) for
 *            YOUTUBE_WATCH_CHANNELS; falls back to a best-effort parse of the public
 *            results page for one interest query when no channels are configured
 *   trend    scanTrends() (LLM, 'background' priority) at most every 6 h
 *
 * What it looks for comes from the organism's own state ("interests"): WORLD_INTERESTS
 * from .env first, then key phrases of recently completed high-quality goals, then topics
 * the fleet is talking about on the fraymus-bridge. Queries rotate and are not repeated
 * within 24 h. Observations land in `world_observations` (deduped by kind+url); the top
 * few become 'world' memories for the system agent so cognition can recall them.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { isResourceConstrained } from './resource-envelope.js';

const now = () => Date.now();
const DAY = 86400_000;
const POLL_INTERVAL_MS = Math.max(5 * 60_000, parseInt(process.env.WORLD_POLL_INTERVAL_MS, 10) || 30 * 60_000);
const TREND_INTERVAL_MS = 6 * 3600_000;
const WEB_QUERIES_PER_CYCLE = 2;
const MEMORIES_PER_CYCLE = 3;
const UA = 'Chandra/1.0 (+local autonomous research; contact via fraymus-bridge)';

let timer = null;
let polling = false;
let scanTrendsFn = null; // late-bound to avoid importing the LLM-heavy radar at load
const state = { running: false, polls: 0, startedAt: 0, lastPollAt: 0, lastTrendScanAt: 0, lastTrendResult: null, lastResult: null, errors: [] };

function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS world_observations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    query TEXT,
    url TEXT NOT NULL,
    title TEXT,
    snippet TEXT,
    source TEXT NOT NULL,
    published_at TEXT,
    observed_at INTEGER NOT NULL
  )`).run();
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_world_obs_kind_url ON world_observations(kind, url)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_world_obs_ts ON world_observations(observed_at)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS world_queries (
    query TEXT NOT NULL,
    kind TEXT NOT NULL,
    results INTEGER NOT NULL DEFAULT 0,
    ran_at INTEGER NOT NULL,
    PRIMARY KEY (query, kind)
  )`).run();
}
try { ensureTables(); } catch (e) { console.error('[world-pollers] schema:', e.message); }

export function setTrendScanner(fn) { scanTrendsFn = typeof fn === 'function' ? fn : null; }

// ─── Interests ────────────────────────────────────────────────────

const STOP = new Set(['that', 'this', 'with', 'from', 'into', 'their', 'between', 'across', 'within', 'using', 'based', 'develop', 'analyze', 'analyse', 'create', 'system', 'model', 'novel', 'approach', 'areas', 'categories', 'category', 'relationship', 'relationships', 'high-confidence', 'low-confidence', 'mediator-aware', 'intersection', 'predict', 'likelihood', 'probabilistic', 'cognition', 'consciousness', 'dream', 'hypothesis', 'interaction']);
const phrase = s => String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));

// The organism's own goal text is full of internal jargon ("mediator-aware relationships"),
// which sends a web search to peace-mediation articles. WORLD_INTERESTS in .env is the real
// lever; until it is set, this baseline keeps the first cycles pointed at Chandra's actual
// domains (sovereign local AI, mesh, streaming artifacts, print-on-demand commerce).
const DOMAIN_BASELINE = [
  'local llm agents ollama autonomous', 'ed25519 mesh network raspberry pi', 'live stream donation overlay emotes',
  'print on demand shopify printify trends', 'continuous time recurrent neural network', 'integrated information theory phi measure',
];

export function collectInterests() {
  const out = [];
  const seen = new Set();
  const add = (q, origin) => { const k = q.toLowerCase().trim(); if (k && k.length >= 4 && !seen.has(k) && out.length < 14) { seen.add(k); out.push({ query: k.slice(0, 120), origin }); } };
  for (const q of String(process.env.WORLD_INTERESTS || '').split(',')) add(q, 'env');
  for (const q of DOMAIN_BASELINE) add(q, 'baseline');
  try {
    const goals = db.prepare(
      `SELECT g.objective FROM goal_executions e JOIN goal_proposals g ON g.id = e.goal_id
       WHERE e.status = 'completed' AND e.quality >= 0.4 AND e.finished_at > ? ORDER BY e.quality DESC LIMIT 6`
    ).all(now() - 7 * DAY);
    for (const g of goals) { const words = phrase(g.objective).slice(0, 4); if (words.length >= 2) add(words.join(' '), 'goal'); }
  } catch (_) {}
  try {
    const topics = db.prepare(`SELECT DISTINCT topic FROM hive_bridge_messages WHERE direction = 'in' AND ingested_at > ? ORDER BY ingested_at DESC LIMIT 6`).all(now() - 3 * DAY);
    for (const t of topics) { const words = phrase(String(t.topic).replace(/[-_]/g, ' ')).slice(0, 4); if (words.length >= 2) add(words.join(' '), 'hive'); }
  } catch (_) {}
  if (!out.length) add('fraymus sovereign mesh ed25519', 'fallback');
  return out;
}

function recentlyRan(query, kind) {
  try { return !!db.prepare(`SELECT 1 FROM world_queries WHERE query = ? AND kind = ? AND ran_at > ?`).get(query, kind, now() - DAY); } catch (_) { return false; }
}
function markRan(query, kind, results) {
  try { db.prepare(`INSERT INTO world_queries (query, kind, results, ran_at) VALUES (?, ?, ?, ?) ON CONFLICT(query, kind) DO UPDATE SET results = excluded.results, ran_at = excluded.ran_at`).run(query, kind, results, now()); } catch (_) {}
}

function record(kind, query, { url, title, snippet, source, publishedAt }) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  try {
    const info = db.prepare(`INSERT OR IGNORE INTO world_observations (id, kind, query, url, title, snippet, source, published_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID().slice(0, 12), kind, query, url.slice(0, 1000), (title || '').slice(0, 300), (snippet || '').slice(0, 600), source, publishedAt || null, now());
    return info.changes > 0;
  } catch (_) { return false; }
}

// ─── Web (DuckDuckGo HTML, keyless) ──────────────────────────────

function decodeDdgHref(href) {
  try {
    let h = href.startsWith('//') ? 'https:' + href : href;
    const u = new URL(h, 'https://duckduckgo.com');
    if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg')) return decodeURIComponent(u.searchParams.get('uddg'));
    return u.href;
  } catch (_) { return null; }
}
const unescapeHtml = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export async function searchWeb(query, { maxResults = 8 } = {}) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  const html = await res.text();
  const results = [];
  const blocks = html.split(/class="result\b/).slice(1);
  for (const b of blocks) {
    const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = decodeDdgHref(a[1]);
    const sn = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/);
    if (url) results.push({ url, title: unescapeHtml(a[2]), snippet: sn ? unescapeHtml(sn[1]) : '' });
    if (results.length >= maxResults) break;
  }
  return results;
}

// ─── YouTube (RSS, keyless; results-page parse as fallback) ──────

function parseYouTubeRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = e.match(/<yt:videoId>([^<]+)</)?.[1];
    const title = e.match(/<title>([^<]*)</)?.[1];
    const published = e.match(/<published>([^<]+)</)?.[1];
    const channel = e.match(/<name>([^<]*)</)?.[1];
    if (id) items.push({ url: `https://www.youtube.com/watch?v=${id}`, title: unescapeHtml(title), snippet: channel ? `channel: ${unescapeHtml(channel)}` : '', publishedAt: published });
  }
  return items;
}

export async function fetchChannelFeed(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`youtube rss ${res.status}`);
  return parseYouTubeRss(await res.text());
}

export async function searchYouTube(query, { maxResults = 6 } = {}) {
  const res = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`youtube results ${res.status}`);
  const html = await res.text();
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    let title = m[2]; try { title = JSON.parse(`"${m[2]}"`); } catch (_) {}
    out.push({ url: `https://www.youtube.com/watch?v=${m[1]}`, title, snippet: '' });
    if (out.length >= maxResults) break;
  }
  return out;
}

// ─── Cycle ───────────────────────────────────────────────────────

export async function pollWorld({ trigger = 'interval', force = false } = {}) {
  if (polling) return { skipped: true, reason: 'in_progress' };
  if (!force) { try { if (isResourceConstrained()) return { skipped: true, reason: 'resource_constrained' }; } catch (_) {} }
  polling = true;
  const t0 = now();
  const result = { trigger, at: t0, web: [], youtube: [], trend: null, newObservations: 0, memories: 0, errors: [] };
  try {
    const interests = collectInterests();
    // web: next WEB_QUERIES_PER_CYCLE interests not run in 24 h
    const webQueries = interests.filter(i => !recentlyRan(i.query, 'web')).slice(0, WEB_QUERIES_PER_CYCLE);
    for (const q of webQueries) {
      try {
        const hits = await searchWeb(q.query);
        let fresh = 0;
        for (const h of hits) if (record('web', q.query, { ...h, source: 'duckduckgo-html' })) fresh++;
        markRan(q.query, 'web', hits.length);
        result.web.push({ query: q.query, origin: q.origin, results: hits.length, fresh });
        result.newObservations += fresh;
      } catch (e) { result.errors.push(`web "${q.query}": ${e.message.slice(0, 100)}`); markRan(q.query, 'web', 0); }
    }
    // youtube: configured channels by RSS, else one results-page query
    const channels = String(process.env.YOUTUBE_WATCH_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (channels.length) {
      for (const ch of channels.slice(0, 6)) {
        try {
          const items = await fetchChannelFeed(ch);
          let fresh = 0;
          for (const it of items.slice(0, 10)) if (record('youtube', `channel:${ch}`, { ...it, source: 'youtube-rss' })) fresh++;
          result.youtube.push({ channel: ch, items: items.length, fresh });
          result.newObservations += fresh;
        } catch (e) { result.errors.push(`youtube rss ${ch}: ${e.message.slice(0, 100)}`); }
      }
    } else {
      const q = interests.find(i => !recentlyRan(i.query, 'youtube'));
      if (q) {
        try {
          const items = await searchYouTube(q.query);
          let fresh = 0;
          for (const it of items) if (record('youtube', q.query, { ...it, source: 'youtube-results-page' })) fresh++;
          markRan(q.query, 'youtube', items.length);
          result.youtube.push({ query: q.query, origin: q.origin, items: items.length, fresh, note: items.length ? undefined : 'results page yielded nothing — set YOUTUBE_WATCH_CHANNELS for the stable RSS path' });
          result.newObservations += fresh;
        } catch (e) { result.errors.push(`youtube search "${q.query}": ${e.message.slice(0, 100)}`); markRan(q.query, 'youtube', 0); }
      }
    }
    // trend radar (LLM, 'background' priority) at most every 6 h — fire-and-forget: it can
    // take minutes behind the scheduler and must not hold the poll cycle or the API route.
    if (scanTrendsFn && now() - state.lastTrendScanAt > TREND_INTERVAL_MS) {
      state.lastTrendScanAt = now();
      const niche = interests.slice(0, 4).map(i => i.query).join(', ');
      result.trend = { started: true, niche };
      scanTrendsFn({ niche })
        .then(r => { state.lastTrendResult = { at: now(), newTrends: r?.newTrends ?? 0, trends: Array.isArray(r?.trends) ? r.trends.length : 0, niche }; })
        .catch(e => { state.lastTrendResult = { at: now(), error: e.message.slice(0, 120), niche }; state.errors = [...state.errors, `trend scan: ${e.message.slice(0, 100)}`].slice(-20); });
    }
    // memories: the freshest observations become recallable
    try {
      const fresh = db.prepare(`SELECT kind, query, url, title, snippet FROM world_observations WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT ?`).all(t0, MEMORIES_PER_CYCLE);
      for (const o of fresh) {
        storeMemory('system', 'world', `world:${o.kind}:${o.url.slice(0, 180)}`, `[${o.kind} · "${o.query}"] ${o.title || o.url}${o.snippet ? ' — ' + o.snippet.slice(0, 300) : ''} (${o.url})`, { confidence: 0.4, source: 'world-poller' });
        result.memories++;
      }
    } catch (e) { result.errors.push(`memories: ${e.message.slice(0, 100)}`); }

    result.durationMs = now() - t0;
    state.polls++; state.lastPollAt = now(); state.lastResult = result;
    if (result.errors.length) state.errors = [...state.errors, ...result.errors].slice(-20);
    try { publish('world-pollers', 'system.world.observed', JSON.stringify({ trigger, web: result.web.length, youtube: result.youtube.length, newObservations: result.newObservations, trend: result.trend, errors: result.errors.length })); } catch (_) {}
    return result;
  } finally { polling = false; }
}

export function startWorldPollers({ intervalMs = POLL_INTERVAL_MS } = {}) {
  stopWorldPollers();
  state.running = true; state.startedAt = now();
  timer = setInterval(() => { pollWorld({ trigger: 'interval' }).catch(e => console.error('[world-pollers]', e.message)); }, intervalMs);
  setTimeout(() => { pollWorld({ trigger: 'boot' }).catch(e => console.error('[world-pollers] first poll:', e.message)); }, 90_000);
  return { started: true, intervalMs, interests: collectInterests().map(i => i.query) };
}

export function stopWorldPollers() {
  if (timer) { clearInterval(timer); timer = null; }
  state.running = false;
  return { stopped: true };
}

export function listObservations({ kind = null, limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, limit));
  return kind
    ? db.prepare(`SELECT * FROM world_observations WHERE kind = ? ORDER BY observed_at DESC LIMIT ?`).all(kind, lim)
    : db.prepare(`SELECT * FROM world_observations ORDER BY observed_at DESC LIMIT ?`).all(lim);
}

export function observationCounts(windowMs = DAY) {
  const rows = db.prepare(`SELECT kind, COUNT(*) c FROM world_observations WHERE observed_at > ? GROUP BY kind`).all(now() - windowMs);
  return Object.fromEntries(rows.map(r => [r.kind, r.c]));
}

export function getWorldPollersStatus() {
  return {
    ...state,
    intervalMs: POLL_INTERVAL_MS,
    trendIntervalMs: TREND_INTERVAL_MS,
    interests: collectInterests(),
    observations24h: observationCounts(),
    config: { interestsEnv: !!process.env.WORLD_INTERESTS, youtubeChannels: String(process.env.YOUTUBE_WATCH_CHANNELS || '').split(',').filter(Boolean).length, trendScanner: !!scanTrendsFn },
  };
}

export function installWorldPollerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/world', route((_req, res) => res.json(getWorldPollersStatus())));
  app.get('/api/intelligence/world/observations', route((req, res) => res.json({ observations: listObservations({ kind: req.query.kind ? String(req.query.kind).slice(0, 20) : null, limit: parseInt(req.query.limit) || 50 }) })));
  app.post('/api/intelligence/world/poll', route(async (req, res) => res.json(await pollWorld({ trigger: 'api', force: req.body?.force === true }))));
}
