import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { isClockTrusted } from './clock-honesty.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS writs (
    id TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    tool TEXT,
    agent_id TEXT,
    granted_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    receipt_hash TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_writs_status ON writs(status);
  CREATE INDEX IF NOT EXISTS idx_writs_agent ON writs(agent_id, status);

  CREATE TABLE IF NOT EXISTS writ_receipts (
    id TEXT PRIMARY KEY,
    writ_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    prev_hash TEXT,
    hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_writ ON writ_receipts(writ_id);
`);

const TIER_MAP = {
  TASK: 'local',
  QUERY: 'local',
  RUN: 'local',
  WORKFLOW: 'local',
  IMAGE: 'image',
  DREAM: 'sovereign',
  STATUS: 'info',
};

const EXPIRY_MS = {
  local: 10 * 60 * 1000,
  image: 10 * 60 * 1000,
  info: 5 * 60 * 1000,
  sovereign: 30 * 60 * 1000,
};

let _broadcast = null;
let _enabled = true;
let _ownerSlot = null;

export function initWritSystem(opts = {}) {
  _broadcast = opts.broadcast || null;
  _enabled = opts.enabled !== false;
  expireOldWrits();
  return { active: _enabled };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function lastReceiptHash() {
  const row = db.prepare('SELECT hash FROM writ_receipts ORDER BY created_at DESC LIMIT 1').get();
  return row?.hash || '0'.repeat(64);
}

function appendReceipt(writId, action, detail) {
  const id = randomUUID();
  const prevHash = lastReceiptHash();
  let clockTrusted = false;
  try { clockTrusted = isClockTrusted(); } catch (_) {}
  const payload = JSON.stringify({ writId, action, detail, prevHash, ts: Date.now(), clock_trusted: clockTrusted });
  const hash = sha256(payload);
  db.prepare(`INSERT INTO writ_receipts (id, writ_id, action, detail, prev_hash, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, writId, action, detail, prevHash, hash, Date.now());
  return hash;
}

function expireOldWrits() {
  const now = Date.now();
  const expired = db.prepare("UPDATE writs SET status = 'expired' WHERE status = 'active' AND expires_at < ?").run(now);
  return expired.changes;
}

export function classifyTier(headerOrCommand) {
  const text = (headerOrCommand || '').trim().toUpperCase();
  for (const [prefix, tier] of Object.entries(TIER_MAP)) {
    if (text.startsWith(prefix + ':') || text === prefix) return tier;
  }
  return 'local';
}

// Deterministic council: no LLM, just rule-based
export function requestWrit(agentId, tool, command) {
  if (!_enabled) return { granted: true, writ: null, reason: 'writ system disabled' };

  expireOldWrits();

  const tier = classifyTier(command);

  // Sovereign tier requires owner slot
  if (tier === 'sovereign') {
    if (!_ownerSlot || _ownerSlot.expires_at < Date.now()) {
      const receipt = appendReceipt('NONE', 'deny_sovereign', `agent=${agentId}, tool=${tool}, reason=no_owner_slot`);
      if (_broadcast) _broadcast('integrity', { type: 'writ_denied', tier, agentId, tool });
      return {
        granted: false,
        reason: 'Sovereign tier requires owner slot. No active owner slot.',
        tier,
        receipt,
      };
    }
  }

  // Check for existing active writ for this agent+tool
  const existing = db.prepare("SELECT * FROM writs WHERE agent_id = ? AND tool = ? AND status = 'active' AND expires_at > ?")
    .get(agentId, tool, Date.now());
  if (existing) {
    return { granted: true, writ: existing, reason: 'existing active writ', tier };
  }

  // Grant new writ
  const writId = randomUUID();
  const expiresAt = Date.now() + (EXPIRY_MS[tier] || EXPIRY_MS.local);

  db.prepare(`INSERT INTO writs (id, tier, tool, agent_id, granted_by, status, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(writId, tier, tool, agentId, 'council', expiresAt, Date.now());

  const receipt = appendReceipt(writId, 'grant', `tier=${tier}, agent=${agentId}, tool=${tool}`);

  if (_broadcast) _broadcast('integrity', { type: 'writ_granted', writId, tier, agentId, tool });

  return { granted: true, writ: { id: writId, tier, tool, agent_id: agentId, expires_at: expiresAt }, receipt, tier };
}

export function consumeWrit(writId) {
  const writ = db.prepare("SELECT * FROM writs WHERE id = ? AND status = 'active'").get(writId);
  if (!writ) return { consumed: false, reason: 'writ not found or not active' };
  if (writ.expires_at < Date.now()) {
    db.prepare("UPDATE writs SET status = 'expired' WHERE id = ?").run(writId);
    return { consumed: false, reason: 'writ expired' };
  }

  db.prepare("UPDATE writs SET status = 'consumed', consumed_at = ? WHERE id = ?").run(Date.now(), writId);
  const receipt = appendReceipt(writId, 'consume', `tier=${writ.tier}, agent=${writ.agent_id}, tool=${writ.tool}`);

  return { consumed: true, writ, receipt };
}

// Owner slot: single-use sovereign permission
export function mintOwnerSlot(reason) {
  if (_ownerSlot && _ownerSlot.expires_at > Date.now()) {
    return { minted: false, reason: 'Active owner slot already exists', existing: _ownerSlot };
  }

  _ownerSlot = {
    id: randomUUID(),
    minted_at: Date.now(),
    expires_at: Date.now() + EXPIRY_MS.sovereign,
    reason: reason || 'owner command',
    consumed: false,
  };

  appendReceipt(_ownerSlot.id, 'mint_owner_slot', reason || 'owner command');
  if (_broadcast) _broadcast('integrity', { type: 'owner_slot_minted', slot: _ownerSlot });
  return { minted: true, slot: _ownerSlot };
}

export function consumeOwnerSlot() {
  if (!_ownerSlot || _ownerSlot.consumed || _ownerSlot.expires_at < Date.now()) {
    return { consumed: false, reason: 'No active owner slot' };
  }
  _ownerSlot.consumed = true;
  _ownerSlot.consumed_at = Date.now();
  appendReceipt(_ownerSlot.id, 'consume_owner_slot', 'sovereign execution');
  return { consumed: true, slot: _ownerSlot };
}

export function getOwnerSlot() {
  if (!_ownerSlot) return null;
  if (_ownerSlot.expires_at < Date.now()) return { ...(_ownerSlot), status: 'expired' };
  if (_ownerSlot.consumed) return { ...(_ownerSlot), status: 'consumed' };
  return { ...(_ownerSlot), status: 'active' };
}

export function getWritStats() {
  expireOldWrits();
  const total = db.prepare('SELECT COUNT(*) as c FROM writs').get().c;
  const active = db.prepare("SELECT COUNT(*) as c FROM writs WHERE status = 'active'").get().c;
  const consumed = db.prepare("SELECT COUNT(*) as c FROM writs WHERE status = 'consumed'").get().c;
  const expired = db.prepare("SELECT COUNT(*) as c FROM writs WHERE status = 'expired'").get().c;
  const receipts = db.prepare('SELECT COUNT(*) as c FROM writ_receipts').get().c;
  const recentWrits = db.prepare('SELECT * FROM writs ORDER BY created_at DESC LIMIT 20').all();
  const recentReceipts = db.prepare('SELECT * FROM writ_receipts ORDER BY created_at DESC LIMIT 20').all();
  return { total, active, consumed, expired, receipts, ownerSlot: getOwnerSlot(), recentWrits, recentReceipts };
}

export function verifyReceiptChain(limit) {
  const rows = db.prepare('SELECT * FROM writ_receipts ORDER BY created_at ASC LIMIT ?').all(limit || 100);
  let prevHash = '0'.repeat(64);
  const violations = [];

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].prev_hash !== prevHash) {
      violations.push({ index: i, id: rows[i].id, expected: prevHash, actual: rows[i].prev_hash });
    }
    prevHash = rows[i].hash;
  }

  return {
    entries: rows.length,
    valid: violations.length === 0,
    violations,
  };
}

export function isEnabled() { return _enabled; }
export function setEnabled(val) { _enabled = !!val; return _enabled; }

export function selftest() {
  const results = [];

  // Grant local writ
  const local = requestWrit('test-agent', 'test_tool', 'TASK: test');
  results.push({ name: 'grant_local', pass: local.granted === true && local.tier === 'local' });

  // Consume writ
  if (local.writ?.id) {
    const consumed = consumeWrit(local.writ.id);
    results.push({ name: 'consume_writ', pass: consumed.consumed === true });

    // Double-consume fails
    const double = consumeWrit(local.writ.id);
    results.push({ name: 'double_consume_fails', pass: double.consumed === false });
  } else {
    results.push({ name: 'consume_writ', pass: false });
    results.push({ name: 'double_consume_fails', pass: false });
  }

  // Sovereign denied without owner slot
  _ownerSlot = null;
  const sov = requestWrit('test-agent', 'dream_tool', 'DREAM: test');
  results.push({ name: 'sovereign_denied_no_slot', pass: sov.granted === false });

  // Mint owner slot then sovereign granted
  mintOwnerSlot('selftest');
  const sov2 = requestWrit('test-agent', 'dream_tool', 'DREAM: test');
  results.push({ name: 'sovereign_granted_with_slot', pass: sov2.granted === true && sov2.tier === 'sovereign' });

  // Receipt chain valid
  const chain = verifyReceiptChain(50);
  results.push({ name: 'receipt_chain_valid', pass: chain.valid === true });

  // Tier classification
  results.push({ name: 'tier_task', pass: classifyTier('TASK: x') === 'local' });
  results.push({ name: 'tier_dream', pass: classifyTier('DREAM: x') === 'sovereign' });
  results.push({ name: 'tier_image', pass: classifyTier('IMAGE: x') === 'image' });

  const allPass = results.every(r => r.pass);
  return { pass: allPass, results, probes: results.length };
}
