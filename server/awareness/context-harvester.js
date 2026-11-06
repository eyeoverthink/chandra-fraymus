/**
 * Awareness Layer — Context Harvester
 *
 * Extracts structured facts from user messages and stores them as
 * agent memories with category 'user_context'. Inspired by Brahma's
 * MemoryCortex episodic memory with decay.
 *
 * Pattern categories:
 *   names       — people, companies, brands mentioned
 *   preferences — likes, dislikes, choices expressed
 *   projects    — project names, repos, codebases mentioned
 *   technical   — technologies, tools, languages, frameworks
 *   temporal    — dates, deadlines, schedules
 *
 * Stores with confidence 0.8 (harvested, not user-confirmed).
 * Access count tracks how often a fact is recalled.
 * Runs synchronously — called from command router on each user message.
 */

import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();

const PATTERNS = {
  names: [
    /(?:my name is|I'm|I am|call me)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    /(?:team|colleague|partner|friend|boss)\s+(?:named?\s+)?([A-Z][a-z]+)/g,
    /(?:@)([A-Za-z][A-Za-z0-9_]+)/g,
  ],
  preferences: [
    /I (?:prefer|like|love|want|need|use|hate|dislike|avoid)\s+(.{3,60}?)(?:\.|,|$)/gi,
    /(?:always|never|usually)\s+(.{3,50}?)(?:\.|,|$)/gi,
  ],
  projects: [
    /(?:project|repo|repository|codebase|app|application)\s+(?:called\s+|named\s+)?["']?([A-Za-z][\w-]{1,40})["']?/gi,
    /(?:working on|building|developing)\s+(.{3,50}?)(?:\.|,|$)/gi,
  ],
  technical: [
    /(?:using|with|in|via|through)\s+(React|Vue|Angular|Svelte|Next\.?js|Nuxt|Express|FastAPI|Django|Flask|Rails|Spring|Node\.?js|Deno|Bun|Python|TypeScript|JavaScript|Rust|Go|Java|C\+\+|C#|Swift|Kotlin|Ruby|PHP|Elixir|Haskell)/gi,
    /(?:database|db|store)\s+(?:is\s+)?(PostgreSQL|MySQL|SQLite|MongoDB|Redis|DynamoDB|Supabase|Firebase|CockroachDB|Cassandra)/gi,
    /(?:deploy|host|run)\s+(?:on\s+|with\s+)?(AWS|GCP|Azure|Vercel|Netlify|Railway|Fly\.io|Render|Heroku|Docker|Kubernetes)/gi,
  ],
  temporal: [
    /(?:due|deadline|by|before|until|on)\s+(\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/gi,
    /(?:next|this|last)\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|week|month|quarter|year)/gi,
    /(?:in\s+)(\d+)\s+(days?|weeks?|months?|hours?|minutes?)/gi,
  ],
};

let harvesterState = {
  running: false,
  factsHarvested: 0,
  lastHarvestAt: 0,
  messagesProcessed: 0,
};

function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS harvested_contexts (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 0.8,
      source TEXT DEFAULT 'user_message',
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    )`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_harvest_cat ON harvested_contexts(category)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_harvest_ts ON harvested_contexts(created_at)`).run();
  } catch (_) {}
}

ensureTable();

function storeFact(category, key, value) {
  try {
    const existing = db.prepare(
      `SELECT id FROM harvested_contexts WHERE category = ? AND key = ? AND value = ?`
    ).get(category, key, value);
    if (existing) {
      db.prepare(`UPDATE harvested_contexts SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`).run(now(), existing.id);
      return false;
    }

    db.prepare(
      `INSERT INTO harvested_contexts (id, category, key, value, confidence, source, access_count, created_at) VALUES (?, ?, ?, ?, 0.8, 'user_message', 0, ?)`
    ).run(randomUUID().slice(0, 12), category, key, value, now());
    harvesterState.factsHarvested++;
    return true;
  } catch (_) {
    return false;
  }
}

export function harvestFromMessage(text) {
  if (!text || typeof text !== 'string' || text.length < 5) return { extracted: 0 };
  if (!harvesterState.running) return { extracted: 0, reason: 'not_running' };

  harvesterState.messagesProcessed++;
  harvesterState.lastHarvestAt = now();
  let extracted = 0;

  for (const [category, patterns] of Object.entries(PATTERNS)) {
    for (const pattern of patterns) {
      // Reset regex lastIndex for global patterns
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const value = match[1]?.trim();
        if (value && value.length >= 2 && value.length <= 100) {
          const key = value.toLowerCase().replace(/\s+/g, '_').slice(0, 50);
          if (storeFact(category, key, value)) {
            extracted++;
          }
        }
      }
    }
  }

  if (extracted > 0) {
    try {
      publish('system.context.harvested', JSON.stringify({ extracted, messageLength: text.length }));
    } catch (_) {}
  }

  return { extracted };
}

export function recallContext(query, category = null) {
  try {
    const q = `%${query}%`;
    let rows;
    if (category) {
      rows = db.prepare(
        `SELECT * FROM harvested_contexts WHERE category = ? AND (key LIKE ? OR value LIKE ?) ORDER BY access_count DESC, created_at DESC LIMIT 20`
      ).all(category, q, q);
    } else {
      rows = db.prepare(
        `SELECT * FROM harvested_contexts WHERE key LIKE ? OR value LIKE ? ORDER BY access_count DESC, created_at DESC LIMIT 20`
      ).all(q, q);
    }

    // Bump access counts
    for (const row of rows) {
      try {
        db.prepare(`UPDATE harvested_contexts SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`).run(now(), row.id);
      } catch (_) {}
    }

    return rows;
  } catch (_) {
    return [];
  }
}

export function buildUserContextPrompt() {
  try {
    const facts = db.prepare(
      `SELECT category, key, value FROM harvested_contexts ORDER BY access_count DESC, created_at DESC LIMIT 15`
    ).all();

    if (!facts.length) return '';

    const lines = facts.map(f => `[${f.category}] ${f.value}`);
    return `\n[User Context — harvested facts]\n${lines.join('\n')}\n`;
  } catch (_) {
    return '';
  }
}

export function startContextHarvester() {
  harvesterState = {
    running: true,
    factsHarvested: 0,
    lastHarvestAt: 0,
    messagesProcessed: 0,
  };
  return { started: true };
}

export function stopContextHarvester() {
  harvesterState.running = false;
  return { stopped: true };
}

export function resetContextHarvester() {
  harvesterState = { running: false, factsHarvested: 0, lastHarvestAt: 0, messagesProcessed: 0 };
}

export function getContextHarvesterStatus() {
  let totalFacts = 0;
  let categoryBreakdown = {};
  try {
    const counts = db.prepare(
      `SELECT category, COUNT(*) as cnt FROM harvested_contexts GROUP BY category`
    ).all();
    for (const c of counts) {
      categoryBreakdown[c.category] = c.cnt;
      totalFacts += c.cnt;
    }
  } catch (_) {}

  return {
    ...harvesterState,
    totalFacts,
    categoryBreakdown,
    patternCategories: Object.keys(PATTERNS),
  };
}

export function installContextHarvesterRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/awareness/context', route((_req, res) => {
    res.json(getContextHarvesterStatus());
  }));

  app.get('/api/awareness/context/recall', route((req, res) => {
    const query = req.query.q || '';
    const category = req.query.category || null;
    if (!query) return res.status(400).json({ error: 'q parameter required' });
    const results = recallContext(query, category);
    res.json({ results, count: results.length });
  }));

  app.get('/api/awareness/context/prompt', route((_req, res) => {
    res.json({ prompt: buildUserContextPrompt() });
  }));

  app.post('/api/awareness/context/start', route((_req, res) => {
    res.json(startContextHarvester());
  }));

  app.post('/api/awareness/context/stop', route((_req, res) => {
    res.json(stopContextHarvester());
  }));

  app.post('/api/awareness/context/harvest', route((req, res) => {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    res.json(harvestFromMessage(text));
  }));

  app.get('/api/awareness/context/facts', route((req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const cat = req.query.category;
    let rows;
    if (cat) {
      rows = db.prepare(`SELECT * FROM harvested_contexts WHERE category = ? ORDER BY created_at DESC LIMIT ?`).all(cat, limit);
    } else {
      rows = db.prepare(`SELECT * FROM harvested_contexts ORDER BY created_at DESC LIMIT ?`).all(limit);
    }
    res.json({ facts: rows });
  }));
}
