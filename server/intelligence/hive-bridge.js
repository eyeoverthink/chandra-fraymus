import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { db } from '../db.js';
import { publish } from '../fleet/bus.js';

const DEFAULT_RAW_PATH = 'C:/Users/eyeka/hive/receipts.jsonl';
const DEFAULT_PROJECTION_PATH = 'C:/Users/eyeka/hive/hive_genesis.jsonl';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const AGENT_ID = 'hive-bridge';

// ─── DB Setup ─────────────────────────────────────────────────

export function ensureHiveBridgeTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hive_ingestion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_hash TEXT NOT NULL UNIQUE,
      source_format TEXT NOT NULL CHECK(source_format IN ('raw', 'projection')),
      receipt_index INTEGER NOT NULL,
      topic TEXT NOT NULL,
      chain_verified INTEGER NOT NULL DEFAULT 0,
      ingested_at INTEGER NOT NULL
    )
  `);
}

// ─── Python-compatible JSON canonicalization ──────────────────
// Byte-exact match for: json.dumps(obj, sort_keys=True)
// Python defaults: separators=(', ', ': '), ensure_ascii=True
// This is the ONLY correct way to reproduce the upstream SHA-256
// chain — JSON.stringify does not match (no spaces, no ASCII escaping).

function pythonJsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x22) { out += '\\"'; continue; }
    if (code === 0x5C) { out += '\\\\'; continue; }
    if (code === 0x08) { out += '\\b'; continue; }
    if (code === 0x0C) { out += '\\f'; continue; }
    if (code === 0x0A) { out += '\\n'; continue; }
    if (code === 0x0D) { out += '\\r'; continue; }
    if (code === 0x09) { out += '\\t'; continue; }
    if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    if (code >= 0x80) {
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
        const low = s.charCodeAt(i + 1);
        if (low >= 0xDC00 && low <= 0xDFFF) {
          out += '\\u' + code.toString(16).padStart(4, '0');
          out += '\\u' + low.toString(16).padStart(4, '0');
          i++;
          continue;
        }
      }
      out += '\\u' + code.toString(16).padStart(4, '0');
      continue;
    }
    out += s[i];
  }
  return out + '"';
}

function pythonCanonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number in hive record');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return pythonJsonString(value);
  if (Array.isArray(value)) {
    return '[' + value.map(v => pythonCanonical(v)).join(', ') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const pairs = keys.map(k => pythonJsonString(k) + ': ' + pythonCanonical(value[k]));
    return '{' + pairs.join(', ') + '}';
  }
  throw new Error(`Unsupported type in hive record: ${typeof value}`);
}

// ─── Hashing ──────────────────────────────────────────────────

function sha256(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function receiptContentHash(line) {
  return sha256(line.trim());
}

// ─── Format Detection ─────────────────────────────────────────

export function detectFormat(firstLine) {
  try {
    const obj = JSON.parse(firstLine);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      if ('prev' in obj && 'self' in obj && 'organ' in obj) return 'raw';
      if ('src' in obj && 'msg' in obj) return 'projection';
    }
  } catch (_) { /* invalid JSON → unknown */ }
  return 'unknown';
}

// ─── Chain Verification (raw format only) ─────────────────────

function computeReceiptSelf(record) {
  const withoutSelf = {};
  for (const k of Object.keys(record)) {
    if (k !== 'self') withoutSelf[k] = record[k];
  }
  return sha256(pythonCanonical(withoutSelf));
}

const GENESIS_PREV = '0'.repeat(64);

function verifyRawChain(records) {
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const expectedSelf = computeReceiptSelf(r);
    if (r.self !== expectedSelf) {
      return { intact: false, breakIndex: i, reason: 'self_mismatch', expected: expectedSelf, actual: r.self };
    }
    const expectedPrev = i === 0 ? GENESIS_PREV : records[i - 1].self;
    if (r.prev !== expectedPrev) {
      return { intact: false, breakIndex: i, reason: 'prev_mismatch', expected: expectedPrev, actual: r.prev };
    }
  }
  return { intact: true, breakIndex: null, reason: null };
}

// ─── File Reading ─────────────────────────────────────────────

function readHiveFile(filePath) {
  let stat;
  try { stat = statSync(filePath); }
  catch (e) { throw new Error(`Hive file not found: ${filePath}`); }

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`Hive file exceeds ${MAX_FILE_SIZE} byte limit: ${stat.size} bytes`);
  }

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (lines.length > 0) {
    try { JSON.parse(lines[lines.length - 1]); }
    catch (_) { lines.pop(); }
  }
  return lines;
}

// ─── Ingestion ────────────────────────────────────────────────

export function ingestHiveFile(path) {
  const filePath = path || DEFAULT_PROJECTION_PATH;
  const lines = readHiveFile(filePath);
  if (lines.length === 0) return { format: 'unknown', ingested: 0, skipped: 0, errors: [] };

  const format = detectFormat(lines[0]);
  if (format === 'unknown') {
    return { format: 'unknown', ingested: 0, skipped: 0, errors: ['Unrecognized hive format'] };
  }

  const records = lines.map(l => JSON.parse(l));
  let chainResult = null;

  if (format === 'raw') {
    chainResult = verifyRawChain(records);
  }

  const checkStmt = db.prepare('SELECT id FROM hive_ingestion WHERE receipt_hash = ?');
  const insertStmt = db.prepare(
    `INSERT INTO hive_ingestion (receipt_hash, source_format, receipt_index, topic, chain_verified, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let ingested = 0;
  let skipped = 0;
  const errors = [];
  const now = Date.now();

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const lineHash = receiptContentHash(lines[i]);

    if (checkStmt.get(lineHash)) { skipped++; continue; }

    const topic = format === 'raw'
      ? `hive.${r.organ}:${r.type}`
      : `hive.${r.src}`;

    let chainVerified = 0;
    if (format === 'raw' && chainResult) {
      if (chainResult.intact) {
        chainVerified = 1;
      } else if (chainResult.breakIndex !== null && i < chainResult.breakIndex) {
        chainVerified = 1;
      }
    }

    try {
      publish(AGENT_ID, topic, {
        ...r,
        _hive: {
          format,
          receiptIndex: i,
          chainVerified: !!chainVerified,
          ingestedAt: new Date(now).toISOString()
        }
      });
    } catch (e) {
      errors.push(`Bus publish failed for receipt ${i}: ${e.message}`);
      continue;
    }

    try {
      insertStmt.run(lineHash, format, i, topic, chainVerified, now);
      ingested++;
    } catch (e) {
      errors.push(`DB insert failed for receipt ${i}: ${e.message}`);
    }
  }

  if (format === 'raw' && chainResult) {
    try {
      publish(AGENT_ID, 'hive.chain.status', {
        status: chainResult.intact ? 'INTACT' : 'DAMAGED',
        total: records.length,
        breakIndex: chainResult.breakIndex,
        reason: chainResult.reason,
        verifiedAt: new Date(now).toISOString()
      });
    } catch (_) { /* chain status event is advisory */ }
  }

  const result = { format, ingested, skipped, errors };
  if (format === 'raw') {
    result.chainStatus = chainResult.intact ? 'INTACT' : 'DAMAGED';
    if (!chainResult.intact) {
      result.chainBreakIndex = chainResult.breakIndex;
      result.chainBreakReason = chainResult.reason;
    }
  }
  return result;
}

// ─── Chain-Only Verification ──────────────────────────────────

export function verifyHiveChain(path) {
  const filePath = path || DEFAULT_RAW_PATH;
  const lines = readHiveFile(filePath);
  if (lines.length === 0) return { total: 0, intact: true, format: 'unknown' };

  const format = detectFormat(lines[0]);
  if (format === 'projection') {
    return { error: 'Chain verification impossible for projection format — chain fields (prev, self) are absent' };
  }
  if (format === 'unknown') {
    return { error: 'Unrecognized hive format' };
  }

  const records = lines.map(l => JSON.parse(l));
  const result = verifyRawChain(records);
  return { total: records.length, intact: result.intact, breakIndex: result.breakIndex, format: 'raw' };
}

// ─── Stats ────────────────────────────────────────────────────

export function getIngestionStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM hive_ingestion').get();
  const raw = db.prepare("SELECT COUNT(*) as c FROM hive_ingestion WHERE source_format = 'raw'").get();
  const proj = db.prepare("SELECT COUNT(*) as c FROM hive_ingestion WHERE source_format = 'projection'").get();
  const verified = db.prepare('SELECT COUNT(*) as c FROM hive_ingestion WHERE chain_verified = 1').get();
  const lastRun = db.prepare('SELECT MAX(ingested_at) as ts FROM hive_ingestion').get();

  return {
    lastRun: lastRun?.ts ? new Date(lastRun.ts).toISOString() : null,
    totalIngested: total?.c || 0,
    rawCount: raw?.c || 0,
    projectionCount: proj?.c || 0,
    chainVerifiedCount: verified?.c || 0,
    chainStatus: (raw?.c || 0) > 0 ? (verified?.c === raw?.c ? 'INTACT' : 'PARTIAL') : 'NO_RAW_DATA'
  };
}

// ─── Exported for testing ─────────────────────────────────────

export { pythonCanonical as _pythonCanonical, computeReceiptSelf as _computeReceiptSelf };
