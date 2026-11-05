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
//
// Supported domain: strings containing BMP characters, integers within
// Number.MAX_SAFE_INTEGER, and booleans/null. Supplementary-plane key
// sorting and float formatting may diverge from CPython; the 13 known
// upstream receipts do not contain those values.

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
    // HIVE-04: DEL (U+007F) — Python escapes it, ASCII printable range is 0x20..0x7E
    if (code === 0x7F) {
      out += '\\u007f';
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

// ─── Field Validation ─────────────────────────────────────────
// HIVE-03: reject records missing required fields before trusted dispatch

const RAW_REQUIRED_FIELDS = ['organ', 'type', 'prev', 'self'];
const PROJECTION_REQUIRED_FIELDS = ['src', 'msg'];

function validateRecordFields(record, format) {
  const required = format === 'raw' ? RAW_REQUIRED_FIELDS : PROJECTION_REQUIRED_FIELDS;
  const missing = required.filter(f => !(f in record));
  if (missing.length > 0) return `missing required fields: ${missing.join(', ')}`;
  return null;
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
// HIVE-03: return all non-empty lines plus a flag indicating whether
// the file ends with a newline. Callers decide how to handle partial
// trailing lines and malformed records — no silent dropping here.

function readHiveFile(filePath) {
  let stat;
  try { stat = statSync(filePath); }
  catch (e) { throw new Error(`Hive file not found: ${filePath}`); }

  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`Hive file exceeds ${MAX_FILE_SIZE} byte limit: ${stat.size} bytes`);
  }

  const content = readFileSync(filePath, 'utf8');
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  return { lines, endsWithNewline };
}

// ─── Line Parsing ─────────────────────────────────────────────
// HIVE-03: parse all lines, report malformed ones explicitly.
// Only skip a truly partial trailing line (file not newline-terminated).

function parseLines(lines, endsWithNewline) {
  const records = [];
  const malformed = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      records.push({ index: i, record: JSON.parse(lines[i]) });
    } catch (e) {
      if (i === lines.length - 1 && !endsWithNewline) {
        malformed.push({ index: i, reason: 'partial_trailing_line', message: e.message });
      } else {
        malformed.push({ index: i, reason: 'invalid_json', message: e.message });
      }
    }
  }
  return { records, malformed };
}

// ─── Dedup Identity ───────────────────────────────────────────
// HIVE-05: use receipt `self` for raw (stable across reformatting),
// canonical hash for projection (no upstream identity field).

function dedupIdentity(record, format, rawLine) {
  if (format === 'raw' && record.self) {
    return record.self;
  }
  if (format === 'projection') {
    return sha256(pythonCanonical(record));
  }
  return receiptContentHash(rawLine);
}

// ─── Trusted Topic Resolution ─────────────────────────────────
// HIVE-01: unverified events use hive.unverified.* namespace so
// bus triggers on hive.* never fire on untrusted data.

function resolveTopic(record, format, chainVerified) {
  if (format === 'raw') {
    const baseTopic = `${record.organ}:${record.type}`;
    return chainVerified ? `hive.${baseTopic}` : `hive.unverified.${baseTopic}`;
  }
  return `hive.unverified.${record.src}`;
}

// ─── Ingestion ────────────────────────────────────────────────

export function ingestHiveFile(path) {
  const filePath = path || DEFAULT_PROJECTION_PATH;
  const { lines, endsWithNewline } = readHiveFile(filePath);
  if (lines.length === 0) return { format: 'unknown', ingested: 0, skipped: 0, errors: [], malformed: [] };

  const format = detectFormat(lines[0]);
  if (format === 'unknown') {
    return { format: 'unknown', ingested: 0, skipped: 0, errors: ['Unrecognized hive format'], malformed: [] };
  }

  // HIVE-03: parse all lines, report malformed explicitly
  const { records: parsed, malformed } = parseLines(lines, endsWithNewline);
  if (parsed.length === 0) {
    return { format, ingested: 0, skipped: 0, errors: ['No valid records found'], malformed };
  }

  const records = parsed.map(p => p.record);
  const recordIndices = parsed.map(p => p.index);
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

  for (let ri = 0; ri < records.length; ri++) {
    const r = records[ri];
    const originalIndex = recordIndices[ri];

    // HIVE-03: validate required fields
    const fieldError = validateRecordFields(r, format);
    if (fieldError) {
      errors.push(`Receipt ${originalIndex}: ${fieldError}`);
      continue;
    }

    // HIVE-05: stable dedup identity
    const dedupKey = dedupIdentity(r, format, lines[originalIndex]);
    if (checkStmt.get(dedupKey)) { skipped++; continue; }

    // HIVE-01: chain-verified status determines trusted vs untrusted topic
    let chainVerified = 0;
    if (format === 'raw' && chainResult) {
      if (chainResult.intact) {
        chainVerified = 1;
      } else if (chainResult.breakIndex !== null && ri < chainResult.breakIndex) {
        chainVerified = 1;
      }
    }

    const topic = resolveTopic(r, format, !!chainVerified);

    // HIVE-02: atomic publish + checkpoint via SQLite transaction.
    // If crash before COMMIT: both bus_messages row and hive_ingestion
    // row roll back. On restart, no checkpoint exists → receipt replays
    // → exactly one durable publication per receipt.
    try {
      db.transaction(() => {
        publish(AGENT_ID, topic, {
          ...r,
          _hive: {
            format,
            receiptIndex: originalIndex,
            chainVerified: !!chainVerified,
            ingestedAt: new Date(now).toISOString()
          }
        });
        insertStmt.run(dedupKey, format, originalIndex, topic, chainVerified, now);
      })();
      ingested++;
    } catch (e) {
      errors.push(`Atomic ingest failed for receipt ${originalIndex}: ${e.message}`);
    }
  }

  if (format === 'raw' && chainResult) {
    try {
      publish(AGENT_ID, 'hive.chain.status', {
        status: chainResult.intact ? 'INTACT' : 'DAMAGED',
        total: records.length,
        malformedCount: malformed.length,
        breakIndex: chainResult.breakIndex,
        reason: chainResult.reason,
        verifiedAt: new Date(now).toISOString()
      });
    } catch (_) { /* chain status event is advisory */ }
  }

  const result = { format, ingested, skipped, errors, malformed };
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
// HIVE-03: malformed records are reported, never silently dropped.
// A file with malformed complete lines is never reported as INTACT.

export function verifyHiveChain(path) {
  const filePath = path || DEFAULT_RAW_PATH;
  const { lines, endsWithNewline } = readHiveFile(filePath);
  if (lines.length === 0) return { total: 0, intact: false, format: 'unknown', malformed: [] };

  const format = detectFormat(lines[0]);
  if (format === 'projection') {
    return { error: 'Chain verification impossible for projection format — chain fields (prev, self) are absent' };
  }
  if (format === 'unknown') {
    return { error: 'Unrecognized hive format' };
  }

  const { records: parsed, malformed } = parseLines(lines, endsWithNewline);
  if (parsed.length === 0) {
    return { total: 0, intact: false, format: 'raw', malformed, error: 'No valid records found' };
  }

  const records = parsed.map(p => p.record);
  const result = verifyRawChain(records);

  const hasMalformedComplete = malformed.some(m => m.reason === 'invalid_json');

  return {
    total: records.length,
    intact: result.intact && !hasMalformedComplete,
    breakIndex: result.breakIndex,
    format: 'raw',
    malformed,
    malformedComplete: hasMalformedComplete
  };
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

export { pythonCanonical as _pythonCanonical, computeReceiptSelf as _computeReceiptSelf, pythonJsonString as _pythonJsonString };
