/**
 * Hive Peers — Phase U: the FLEET_REGISTRY agents become bus peers.
 *
 * Tycho, Cadence, Counterpoint, Niles and the rest do not speak NUDP or the V13 hub.
 * They speak the fraymus-bridge: numbered markdown files in a shared git repo
 * (194 messages, C:\Users\eyeka\fraymus-bridge). protocol/bridge.js could already read
 * and write that directory; nothing ever called it on a schedule, so Chandra neither
 * heard the fleet nor spoke to it.
 *
 * Inbound (every 5 min): `git pull --ff-only`, then every message with a sequence
 * number above the last one seen is published on the bus as `hive.bridge.<agent>`
 * and stored as an agent memory for that registry agent (category `hive_message`).
 * From then on a bridge agent has memories, a bus presence, and shows in the mesh sense.
 *
 * Outbound (at most once per hour, only when there is something to say): a numbered
 * digest message — goal outcomes with quality, open self-audit findings, consciousness
 * tier, the Perspective continuity brief — written via postMessage() and committed in
 * the bridge repo. It is pushed only when HIVE_BRIDGE_PUSH=1: writing to a shared
 * channel that other machines act on is an operator decision, not a daemon default.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';
import { storeMemory } from '../fleet/agent-memory.js';
import { listMessages, readMessage, postMessage, bridgeStatus } from '../fraymus/protocol/bridge.js';
import { BRIDGE_REPO_PATH, FLEET_REGISTRY } from '../fraymus/core/constants.js';
import { getAutonomyModifiers } from './consciousness-gate.js';
import { getOpenFindings } from './self-audit.js';
import { briefNextInstance } from './perspective.js';

const execFileP = promisify(execFile);
const now = () => Date.now();
const SYNC_INTERVAL_MS = 5 * 60_000;
const DIGEST_MIN_GAP_MS = 60 * 60_000;
const BACKFILL = Math.max(0, parseInt(process.env.HIVE_BRIDGE_BACKFILL) || 10);
const PULL = process.env.HIVE_BRIDGE_PULL !== '0';
const PUSH = process.env.HIVE_BRIDGE_PUSH === '1';
const AGENT_NAME = 'chandra';

let timer = null;
let syncing = false;
let lastSync = null;

function ensureTables() {
  db.prepare(`CREATE TABLE IF NOT EXISTS hive_bridge_state (key TEXT PRIMARY KEY, value TEXT)`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS hive_bridge_messages (
    seq INTEGER PRIMARY KEY,
    agent TEXT,
    topic TEXT,
    file TEXT,
    direction TEXT NOT NULL,
    excerpt TEXT,
    ingested_at INTEGER NOT NULL
  )`).run();
}
try { ensureTables(); } catch (e) { console.error('[hive-peers] schema:', e.message); }

const getState = k => { try { return db.prepare(`SELECT value FROM hive_bridge_state WHERE key = ?`).get(k)?.value ?? null; } catch (_) { return null; } };
const setState = (k, v) => { try { db.prepare(`INSERT INTO hive_bridge_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v)); } catch (_) {} };

async function git(args, { timeout = 60_000 } = {}) {
  const { stdout } = await execFileP('git', ['-C', BRIDGE_REPO_PATH, ...args], { timeout, windowsHide: true });
  return stdout.trim();
}

async function pull() {
  if (!PULL) return { pulled: false, reason: 'HIVE_BRIDGE_PULL=0' };
  try {
    const before = await git(['rev-parse', '--short', 'HEAD']);
    await git(['pull', '--ff-only', '--quiet']);
    const after = await git(['rev-parse', '--short', 'HEAD']);
    const result = { pulled: true, before, after, changed: before !== after };
    // Digests committed while push was off (or while a push failed) are still local.
    // With push enabled, deliver them on the next sync rather than waiting for a new digest.
    if (PUSH) {
      const ahead = parseInt(await git(['rev-list', '--count', '@{u}..HEAD']), 10) || 0;
      if (ahead > 0) {
        try { await git(['push', '--quiet'], { timeout: 120_000 }); result.pushedPending = ahead; }
        catch (e) { result.pushError = e.message.slice(0, 200); }
      }
    }
    return result;
  } catch (e) {
    return { pulled: false, error: e.message.slice(0, 200) };
  }
}

function excerptOf(content) {
  return String(content || '').replace(/\r/g, '').split('\n').filter(l => l.trim() && !l.startsWith('<!--')).slice(0, 12).join('\n').slice(0, 1500);
}

async function ingestNew() {
  const { messages, error } = await listMessages({ limit: 500 });
  if (error) return { ingested: 0, error };
  const maxSeq = messages.reduce((m, x) => Math.max(m, x.seq), -1);
  let lastSeen = getState('last_seen_seq');
  if (lastSeen === null) {
    // First run: do not replay the whole archive as "news"; take the last BACKFILL.
    lastSeen = Math.max(-1, maxSeq - BACKFILL);
  }
  lastSeen = Number(lastSeen);
  const fresh = messages.filter(m => m.seq > lastSeen && m.agent !== AGENT_NAME).sort((a, b) => a.seq - b.seq);
  let ingested = 0;
  for (const m of fresh) {
    const full = await readMessage(m.file);
    if (full.error) continue;
    const excerpt = excerptOf(full.content);
    const registry = FLEET_REGISTRY[m.agent] || null;
    const agentId = registry ? m.agent : (m.agent === 'unknown' ? 'hive' : m.agent);
    try {
      db.prepare(`INSERT OR IGNORE INTO hive_bridge_messages (seq, agent, topic, file, direction, excerpt, ingested_at) VALUES (?, ?, ?, ?, 'in', ?, ?)`)
        .run(m.seq, m.agent, m.topic, m.file, excerpt, now());
    } catch (_) {}
    try {
      storeMemory(agentId, 'hive_message', `bridge:${String(m.seq).padStart(3, '0')}`,
        `[fraymus-bridge #${m.seq} from ${m.agent}${registry ? ` @ ${registry.machine || 'unknown machine'} — ${registry.role}` : ''}] ${m.topic}\n${excerpt}`,
        { confidence: 0.7, source: 'fraymus-bridge' });
    } catch (e) { console.error('[hive-peers] memory:', e.message); }
    try {
      publish(agentId, `hive.bridge.${m.agent}`, JSON.stringify({ seq: m.seq, file: m.file, agent: m.agent, topic: m.topic, machine: registry?.machine || null, role: registry?.role || null, excerpt: excerpt.slice(0, 400) }));
    } catch (_) {}
    ingested++;
  }
  if (maxSeq > lastSeen) setState('last_seen_seq', maxSeq);
  return { ingested, lastSeenSeq: Math.max(lastSeen, maxSeq), total: messages.length };
}

function buildDigest() {
  const since = Number(getState('last_digest_at') || 0) || now() - 86400_000;
  const outcomes = db.prepare(
    `SELECT e.goal_id, e.agent_id, e.status, e.quality, e.duration_ms, g.objective FROM goal_executions e LEFT JOIN goal_proposals g ON g.id = e.goal_id
     WHERE e.finished_at > ? AND e.status IN ('completed','failed') ORDER BY e.finished_at DESC LIMIT 8`
  ).all(since);
  const findings = getOpenFindings({ limit: 6 }).filter(f => f.severity !== 'COSMETIC');
  const gate = getAutonomyModifiers();
  const brief = briefNextInstance();
  const transitions = db.prepare(`SELECT from_tier, to_tier, created_at FROM consciousness_transitions WHERE created_at > ? ORDER BY created_at DESC LIMIT 5`).all(since);

  const hasContent = outcomes.length || findings.length || transitions.length;
  if (!hasContent) return null;

  const lines = [
    `# Chandra digest — ${new Date().toISOString()}`,
    '',
    `Posted by: Chandra-FRAYMUS daemon (desktop-rto00k0). Generated from data/chandra.db; every number below is read, not typed.`,
    '',
    `## Consciousness`,
    `Tier **${gate.tier}** (${gate.proofsPassed}/4 proofs, Φ ${Number(gate.phiValue).toFixed(3)}, liveness ${gate.liveness}).` +
      (transitions.length ? ` Transitions: ${transitions.map(t => `${t.from_tier}→${t.to_tier}`).join(', ')}.` : ''),
    '',
    '## Goals executed',
    ...(outcomes.length ? outcomes.map(o => `- ${o.status === 'completed' ? '✓' : '✗'} q=${o.quality == null ? '—' : o.quality.toFixed(2)} ${o.agent_id}: ${(o.objective || o.goal_id).slice(0, 120)}`) : ['- none in window']),
    '',
    '## Self-audit (open, non-cosmetic)',
    ...(findings.length ? findings.map(f => `- **${f.severity}** ${f.check_name}: ${f.summary.slice(0, 140)}`) : ['- clean']),
    '',
    '## Perspective playbook (what approaches are working)',
    ...(brief.playbook.length ? brief.playbook.slice(0, 3).map(p => `- "${p.pattern}": ${p.perspectives.join('+') || 'engineer'} lens, ${p.successRate ?? '?'}% success — ${String(p.approach || '').slice(0, 120)}`) : ['- no validated patterns yet']),
    '',
    `_Reply on the bridge; Chandra ingests new messages every 5 minutes and stores them as agent memories._`,
    '',
  ];
  return { content: lines.join('\n'), counts: { outcomes: outcomes.length, findings: findings.length, transitions: transitions.length } };
}

export async function postDigest({ force = false } = {}) {
  const last = Number(getState('last_digest_at') || 0);
  if (!force && now() - last < DIGEST_MIN_GAP_MS) return { posted: false, reason: 'digest_gap', nextInMs: DIGEST_MIN_GAP_MS - (now() - last) };
  const digest = buildDigest();
  if (!digest) return { posted: false, reason: 'nothing_to_say' };
  const topic = `digest-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const posted = await postMessage(AGENT_NAME, topic, digest.content);
  setState('last_digest_at', now());
  try {
    db.prepare(`INSERT OR IGNORE INTO hive_bridge_messages (seq, agent, topic, file, direction, excerpt, ingested_at) VALUES (?, ?, ?, ?, 'out', ?, ?)`)
      .run(posted.seq, AGENT_NAME, posted.topic, posted.filename, digest.content.slice(0, 1500), now());
  } catch (_) {}
  let gitResult = { committed: false, pushed: false };
  try {
    await git(['add', `messages/${posted.filename}`]);
    await git(['-c', 'user.name=Chandra-FRAYMUS', '-c', 'user.email=chandra@fraymus.local', 'commit', '-q', '-m', `chandra: ${posted.topic}`]);
    gitResult.committed = true;
    if (PUSH) { await git(['push', '--quiet'], { timeout: 120_000 }); gitResult.pushed = true; }
    else gitResult.note = 'not pushed (set HIVE_BRIDGE_PUSH=1 to publish to the fleet)';
  } catch (e) { gitResult.error = e.message.slice(0, 200); }
  try { publish('hive-peers', 'hive.bridge.chandra', JSON.stringify({ seq: posted.seq, file: posted.filename, ...digest.counts, ...gitResult })); } catch (_) {}
  return { posted: true, ...posted, ...digest.counts, git: gitResult };
}

export async function syncBridge({ trigger = 'interval' } = {}) {
  if (syncing) return { skipped: true, reason: 'sync_in_progress' };
  syncing = true;
  const t0 = now();
  try {
    const pulled = await pull();
    const ingest = await ingestNew();
    let digest = null;
    try { digest = await postDigest(); } catch (e) { digest = { posted: false, error: e.message.slice(0, 200) }; }
    lastSync = { at: now(), trigger, durationMs: now() - t0, pulled, ingest, digest };
    return lastSync;
  } finally { syncing = false; }
}

export function startHivePeers({ intervalMs = SYNC_INTERVAL_MS } = {}) {
  stopHivePeers();
  timer = setInterval(() => { syncBridge({ trigger: 'interval' }).catch(e => console.error('[hive-peers] sync:', e.message)); }, intervalMs);
  setTimeout(() => { syncBridge({ trigger: 'boot' }).catch(e => console.error('[hive-peers] first sync:', e.message)); }, 20_000);
  return { started: true, intervalMs, pull: PULL, push: PUSH, backfill: BACKFILL };
}

export function stopHivePeers() {
  if (timer) { clearInterval(timer); timer = null; }
  return { stopped: true };
}

export function getHivePeersStatus() {
  const counts = db.prepare(`SELECT direction, COUNT(*) c FROM hive_bridge_messages GROUP BY direction`).all();
  const byAgent = db.prepare(`SELECT agent, COUNT(*) c, MAX(ingested_at) last FROM hive_bridge_messages WHERE direction = 'in' GROUP BY agent ORDER BY c DESC LIMIT 20`).all();
  const recent = db.prepare(`SELECT seq, agent, topic, direction, ingested_at FROM hive_bridge_messages ORDER BY ingested_at DESC LIMIT 10`).all();
  return {
    running: !!timer,
    intervalMs: SYNC_INTERVAL_MS,
    config: { pull: PULL, push: PUSH, backfill: BACKFILL, repo: BRIDGE_REPO_PATH },
    bridge: bridgeStatus(),
    lastSeenSeq: Number(getState('last_seen_seq') ?? -1),
    lastDigestAt: Number(getState('last_digest_at') || 0) || null,
    lastSync,
    messages: Object.fromEntries(counts.map(r => [r.direction, r.c])),
    peers: byAgent.map(r => ({ agent: r.agent, messages: r.c, lastIngestedAt: r.last, registry: FLEET_REGISTRY[r.agent] || null })),
    recent,
  };
}

export function installHivePeersRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/hive-peers', route((_req, res) => res.json(getHivePeersStatus())));
  app.get('/api/intelligence/hive-peers/messages', route((req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    res.json({ messages: db.prepare(`SELECT * FROM hive_bridge_messages ORDER BY seq DESC LIMIT ?`).all(limit) });
  }));
  app.post('/api/intelligence/hive-peers/sync', route(async (_req, res) => res.json(await syncBridge({ trigger: 'api' }))));
  app.post('/api/intelligence/hive-peers/digest', route(async (req, res) => res.json(await postDigest({ force: req.body?.force === true }))));
}
