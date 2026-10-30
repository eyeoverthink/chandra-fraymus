import { db } from '../db.js';

const now = () => Date.now();

// In-memory subscriber handlers keyed by topic → Set<{ agentId, handler }>
const subscribers = new Map();

let broadcastFn = () => {};

export function initBus({ broadcast } = {}) {
  if (broadcast) broadcastFn = broadcast;
}

// ─── Subscriptions ──────────────────────────────────────────────

export function subscribe(agentId, topic) {
  db.prepare(
    `INSERT OR IGNORE INTO bus_subscriptions (agent_id, topic, subscribed_at) VALUES (?, ?, ?)`
  ).run(agentId, topic, now());
  return { subscribed: true, agentId, topic };
}

export function unsubscribe(agentId, topic) {
  const info = db.prepare(
    `DELETE FROM bus_subscriptions WHERE agent_id = ? AND topic = ?`
  ).run(agentId, topic);
  return { unsubscribed: info.changes > 0 };
}

export function listSubscriptions(agentId) {
  if (agentId) {
    return db.prepare(
      `SELECT topic, subscribed_at FROM bus_subscriptions WHERE agent_id = ? ORDER BY topic`
    ).all(agentId);
  }
  return db.prepare(
    `SELECT agent_id, topic, subscribed_at FROM bus_subscriptions ORDER BY topic, agent_id`
  ).all();
}

// ─── Publish ────────────────────────────────────────────────────

export function publish(fromAgent, topic, payload) {
  const ts = now();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const info = db.prepare(
    `INSERT INTO bus_messages (from_agent, to_agent, topic, payload, created_at) VALUES (?, NULL, ?, ?, ?)`
  ).run(fromAgent, topic, payloadStr, ts);

  const msg = { id: info.lastInsertRowid, from: fromAgent, topic, payload: payloadStr, createdAt: ts };

  // Notify in-memory handlers
  const handlers = subscribers.get(topic);
  if (handlers) {
    for (const h of handlers) {
      try { h.handler(msg); } catch (_) {}
    }
  }

  broadcastFn({ type: 'bus', event: 'publish', from: fromAgent, topic, preview: payloadStr.slice(0, 200) });
  return msg;
}

// ─── Direct Message ─────────────────────────────────────────────

export function directMessage(fromAgent, toAgent, payload) {
  const ts = now();
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const info = db.prepare(
    `INSERT INTO bus_messages (from_agent, to_agent, topic, payload, created_at) VALUES (?, ?, 'dm', ?, ?)`
  ).run(fromAgent, toAgent, payloadStr, ts);

  const msg = { id: info.lastInsertRowid, from: fromAgent, to: toAgent, topic: 'dm', payload: payloadStr, createdAt: ts };

  broadcastFn({ type: 'bus', event: 'dm', from: fromAgent, to: toAgent, preview: payloadStr.slice(0, 200) });
  return msg;
}

// ─── Read ───────────────────────────────────────────────────────

export function inbox(agentId, { limit = 50, since = 0 } = {}) {
  const subs = db.prepare(
    `SELECT topic FROM bus_subscriptions WHERE agent_id = ?`
  ).all(agentId).map(r => r.topic);

  if (subs.length === 0) {
    return db.prepare(
      `SELECT * FROM bus_messages WHERE to_agent = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?`
    ).all(agentId, since, limit);
  }

  const topicPlaceholders = subs.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM bus_messages
     WHERE (to_agent = ? OR (topic IN (${topicPlaceholders}) AND from_agent != ?))
       AND created_at > ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(agentId, ...subs, agentId, since, limit);
}

export function history(topic, { limit = 50, since = 0 } = {}) {
  return db.prepare(
    `SELECT * FROM bus_messages WHERE topic = ? AND created_at > ? ORDER BY created_at DESC LIMIT ?`
  ).all(topic, since, Math.min(200, Math.max(1, limit)));
}

export function topics() {
  return db.prepare(
    `SELECT topic, COUNT(*) as messageCount, MAX(created_at) as lastActivity
     FROM bus_messages WHERE topic != 'dm'
     GROUP BY topic ORDER BY lastActivity DESC`
  ).all();
}

export function busStats() {
  const total = db.prepare(`SELECT COUNT(*) as count FROM bus_messages`).get().count;
  const today = db.prepare(
    `SELECT COUNT(*) as count FROM bus_messages WHERE created_at > ?`
  ).get(now() - 86400000).count;
  const topicCount = db.prepare(
    `SELECT COUNT(DISTINCT topic) as count FROM bus_messages WHERE topic != 'dm'`
  ).get().count;
  const subCount = db.prepare(`SELECT COUNT(*) as count FROM bus_subscriptions`).get().count;
  return { total, today, topics: topicCount, subscriptions: subCount };
}

// ─── In-memory handler registration (for runtime agent hooks) ──

export function onTopic(topic, agentId, handler) {
  if (!subscribers.has(topic)) subscribers.set(topic, new Set());
  subscribers.get(topic).add({ agentId, handler });
}

export function offTopic(topic, agentId) {
  const set = subscribers.get(topic);
  if (!set) return;
  for (const entry of set) {
    if (entry.agentId === agentId) set.delete(entry);
  }
  if (set.size === 0) subscribers.delete(topic);
}
