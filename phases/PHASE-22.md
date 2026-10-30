# Phase 22: Agent Live Bus

**Commit:** (this phase)
**Previous:** [Phase 21 — Deploy-as-API](./PHASE-21.md)
**Next:** Phase 23 (TBD)

---

## Summary

Phase 22 adds a real-time pub/sub message bus to the agent fleet. Agents can publish messages to topics, subscribe to topics, and send direct messages to each other — all persisted to SQLite and broadcast via WebSocket. This transforms the fleet from 17 isolated agents into a collaborative team that can coordinate asynchronously.

## What Shipped

### Agent Live Bus (`server/fleet/bus.js`)

Core pub/sub engine with both persistent (SQLite) and real-time (in-memory handlers) delivery:

- **`publish(fromAgent, topic, payload)`** — post a message to a topic; all subscribers are notified and the message persists to `bus_messages`
- **`directMessage(fromAgent, toAgent, payload)`** — point-to-point message stored with topic `dm`
- **`subscribe(agentId, topic)`** / **`unsubscribe(agentId, topic)`** — manage topic subscriptions (stored in `bus_subscriptions` with upsert)
- **`inbox(agentId, { limit, since })`** — retrieve all messages addressed to an agent: subscribed topic messages + DMs
- **`history(topic, { limit, since })`** — message history for a specific topic
- **`topics()`** — list all topics with message counts and last activity
- **`busStats()`** — aggregate stats (total messages, today, topic count, subscription count)
- **`onTopic(topic, agentId, handler)`** / **`offTopic(topic, agentId)`** — in-memory handler registration for runtime hooks

### Bus API Routes (`server/fleet/bus-routes.js`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/fleet/bus/publish` | Publish to a topic |
| POST | `/api/fleet/bus/dm` | Direct message to an agent |
| POST | `/api/fleet/bus/subscribe` | Subscribe agent to topic |
| DELETE | `/api/fleet/bus/subscribe` | Unsubscribe agent from topic |
| GET | `/api/fleet/bus/topics` | List topics with counts |
| GET | `/api/fleet/bus/history/:topic` | Message history per topic |
| GET | `/api/fleet/bus/inbox/:agentId` | Agent inbox (subs + DMs) |
| GET | `/api/fleet/bus/subscriptions` | List all subscriptions |
| GET | `/api/fleet/bus/stats` | Aggregate bus statistics |

### Agent Tools (3 new in `server/fleet/tools.js`)

- **`bus_publish`** — publish a message to a topic (auto-fills `from` from agent context)
- **`bus_dm`** — send a direct message to another agent
- **`bus_read`** — check inbox for subscribed topic messages and DMs

### Bus Dashboard Panel (`client/src/panels/BusPanel.jsx`)

11th Detail Drawer panel with:
- Stats overview (total messages, today, topics, subscriptions)
- Compose section (publish to topic or DM, agent picker)
- Topic browser (click to filter, message counts)
- Subscription viewer
- Live message feed with real-time WebSocket updates

### DB Schema

```sql
CREATE TABLE bus_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT,
  topic TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
-- Indexed on (topic, created_at DESC) and (to_agent, created_at DESC)

CREATE TABLE bus_subscriptions (
  agent_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  subscribed_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, topic)
);
```

## Architecture

```
Agent A ──publish("commerce.done", result)──→ Bus Engine ──→ SQLite persistence
                                                   │
                                                   ├──→ In-memory handlers (if any)
                                                   ├──→ WebSocket broadcast (UI)
                                                   └──→ Agent B reads via inbox()
                                                        (subscribed to "commerce.done")

Agent C ──dm(toAgent: "ariadne", "analyze this")──→ Bus Engine ──→ SQLite
                                                          │
                                                          └──→ Ariadne reads via inbox()
```

### Delegation vs. Bus

| Feature | `delegate_to_agent` (Phase 19) | Agent Live Bus (Phase 22) |
|---------|-------------------------------|--------------------------|
| Pattern | Synchronous call-response | Asynchronous pub/sub |
| Blocking | Yes — caller waits for answer | No — fire and forget |
| Persistence | Thread messages only | All messages in `bus_messages` |
| Multi-recipient | One agent at a time | All subscribers on a topic |
| Depth limit | 2 levels max | Unlimited (no nesting) |
| Use case | "Do this and give me the answer" | "Here's what happened, act on it" |

## Files Changed

| File | Change |
|------|--------|
| `server/fleet/bus.js` | **New** — core pub/sub engine |
| `server/fleet/bus-routes.js` | **New** — 9 REST endpoints |
| `client/src/panels/BusPanel.jsx` | **New** — Bus Dashboard panel |
| `server/db-migrate.js` | Added `bus_messages` + `bus_subscriptions` tables |
| `server/runtime.js` | Import + init bus, install bus routes |
| `server/fleet/tools.js` | Added 3 bus tools (bus_publish, bus_dm, bus_read) |
| `client/src/nexus/DetailDrawer.jsx` | Registered BusPanel as panel #11 |
| `client/src/nexus/CommandCenter.jsx` | Added Bus widget + event style |
| `phases/PHASE-22.md` | This file |
| `README.md` | Phase 22 row, Bus section, updated counts |

## Known Limitations

1. Subscriptions are persistent but in-memory handlers (`onTopic`) reset on server restart
2. No automatic agent wake-up on new messages — agents read inbox when they're active
3. No message TTL or auto-cleanup (messages persist indefinitely)
4. No topic access control — any agent can publish to or read from any topic
