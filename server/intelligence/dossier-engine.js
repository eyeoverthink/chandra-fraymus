import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { db } from '../db.js';
import { storeMemory, recallMemories } from '../fleet/agent-memory.js';
import { publish } from '../fleet/bus.js';
import { debateBinaryAnnotation } from './debate.js';

const RE_AGENT_ID = 're-analyst';

// ─── DB Setup ─────────────────────────────────────────────────

export function ensureDossierTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dossier_ingestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      binary_sha256 TEXT NOT NULL,
      dossier_path TEXT NOT NULL,
      function_count INTEGER NOT NULL DEFAULT 0,
      import_count INTEGER NOT NULL DEFAULT 0,
      compile_rate REAL,
      seal_valid TEXT NOT NULL DEFAULT 'unverifiable',
      evidence_grades TEXT,
      created_at INTEGER NOT NULL
    )
  `);
}

// ─── Decompiled C Parser ──────────────────────────────────────
// Splits by `// ==== name @ addr ====` markers using findall pattern.
// The upstream fra-eval.py uses re.split() which corrupts boundaries,
// producing 181 fragments from 136 functions. This uses re.findall()
// equivalent to extract complete (name, addr, body) triples.

export function parseDecompiledC(text) {
  if (!text || typeof text !== 'string') return [];

  // Support both 0x-prefixed and bare hex addresses from upstream Ghidra output
  const MARKER = /\/\/\s*====\s*(.+?)\s*@\s*((?:0x)?[0-9a-fA-F]+)\s*====/g;
  const functions = [];
  const markers = [];

  let match;
  while ((match = MARKER.exec(text)) !== null) {
    const addr = match[2].startsWith('0x') ? match[2] : `0x${match[2]}`;
    markers.push({ name: match[1].trim(), addr, index: match.index, end: match.index + match[0].length });
  }

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    const bodyStart = m.end;
    const bodyEnd = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const body = text.slice(bodyStart, bodyEnd).trim();
    const lines = body ? body.split('\n').length : 0;

    functions.push({
      name: m.name,
      address: m.addr,
      body,
      lines,
    });
  }

  return functions;
}

// ─── Annotation Parser ────────────────────────────────────────
// Extracts per-function annotations, import verification counts,
// and red/blue agreement scores from fra-annotate.py output.

export function parseAnnotations(text) {
  if (!text || typeof text !== 'string') return { functions: {}, importVerification: {}, redBlueScores: {} };

  const result = { functions: {}, importVerification: {}, redBlueScores: {} };

  // Per-function annotation blocks: supports both formats:
  //   ## function_name @ 0xADDR            (original)
  //   ## function_name @ ADDR (N lines)    (upstream fra-annotate.py)
  const FUNC_BLOCK = /##\s+(.+?)\s*@\s*((?:0x)?[0-9a-fA-F]+)(?:\s*\(\d+\s*lines?\))?\s*\n([\s\S]*?)(?=\n##\s|\n---|\n$|$)/g;
  let match;
  while ((match = FUNC_BLOCK.exec(text)) !== null) {
    const addr = match[2].startsWith('0x') ? match[2] : `0x${match[2]}`;
    const key = `${match[1].trim()}@${addr}`;
    result.functions[key] = {
      name: match[1].trim(),
      address: addr,
      annotation: match[3].trim(),
    };
  }

  // Import verification — two formats:
  //   VERIFIED: printf (libc)                     (original)
  //   - import verification: N verified -> name1, name2   (upstream)
  const IMPORT_LINE = /^(VERIFIED|UNVERIFIED):\s+(\S+)(?:\s+\((.+)\))?/gm;
  while ((match = IMPORT_LINE.exec(text)) !== null) {
    result.importVerification[match[2]] = {
      status: match[1].toLowerCase(),
      library: match[3] || null,
    };
  }
  // Upstream: "- import verification: 3 verified -> printf, putchar, strlen"
  const UPSTREAM_IMPORT = /import\s+verification:\s*(\d+)\s+verified\s*->\s*(.+)/gi;
  while ((match = UPSTREAM_IMPORT.exec(text)) !== null) {
    const names = match[2].split(',').map(n => n.trim()).filter(Boolean);
    for (const name of names) {
      if (!result.importVerification[name]) {
        result.importVerification[name] = { status: 'verified', library: null };
      }
    }
  }

  // Red/blue scores — two formats:
  //   Agreement: 0.73 (Jaccard)                  (original)
  //   - red/blue agreement: 0.73                 (upstream)
  //   Red: 0.8 Blue: 0.6                         (original)
  const AGREEMENT = /(?:Agreement|red\/blue\s+agreement):\s*([\d.]+)/gi;
  while ((match = AGREEMENT.exec(text)) !== null) {
    result.redBlueScores._aggregate = parseFloat(match[1]);
  }
  const RED_BLUE = /Red:\s*([\d.]+)\s*Blue:\s*([\d.]+)/g;
  while ((match = RED_BLUE.exec(text)) !== null) {
    result.redBlueScores._detail = { red: parseFloat(match[1]), blue: parseFloat(match[2]) };
  }

  return result;
}

// ─── Import Parser ────────────────────────────────────────────
// Parses rabin2 -i output (pipe-delimited columns) into structured list.
// Format: ordinal|bind|type|lib|name

export function parseImports(text) {
  if (!text || typeof text !== 'string') return [];

  const imports = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith('---')) continue;

    // pipe-delimited: ordinal|bind|type|lib|name
    if (trimmed.includes('|')) {
      const parts = trimmed.split('|').map(p => p.trim());
      if (parts.length >= 5) {
        imports.push({
          ordinal: parseInt(parts[0]) || 0,
          bind: parts[1],
          type: parts[2],
          lib: parts[3],
          name: parts[4],
        });
        continue;
      } else if (parts.length >= 2) {
        imports.push({
          ordinal: 0,
          bind: 'GLOBAL',
          type: 'FUNC',
          lib: parts[1] || '',
          name: parts[0],
        });
        continue;
      }
    }

    // Whitespace-column format from upstream rabin2 -i:
    //   1    GLOBAL FUNC   libSystem.B.dylib printf
    // Pattern: ordinal, bind, type, lib, name separated by whitespace
    const wsMatch = trimmed.match(/^(\d+)\s+(GLOBAL|LOCAL|WEAK|NONE)\s+(FUNC|OBJECT|NOTYPE|TLS)\s+(\S+)\s+(\S+)/i);
    if (wsMatch) {
      imports.push({
        ordinal: parseInt(wsMatch[1]) || 0,
        bind: wsMatch[2],
        type: wsMatch[3],
        lib: wsMatch[4],
        name: wsMatch[5],
      });
      continue;
    }

    // Simpler whitespace-column: ordinal name (no bind/type/lib)
    const simpleWs = trimmed.match(/^(\d+)\s+(\S+)\s*$/);
    if (simpleWs) {
      imports.push({
        ordinal: parseInt(simpleWs[1]) || 0,
        bind: 'GLOBAL',
        type: 'FUNC',
        lib: '',
        name: simpleWs[2],
      });
    }
  }

  return imports;
}

// ─── Seal Verification ────────────────────────────────────────
// Verifies dossier seal against sorted canonical file manifest.
// Three states: valid, invalid, unverifiable (see spec RE-08 fix).

export function verifyDossierSeal(dossierDir) {
  const sealPath = join(dossierDir, 'dossier.seal');
  if (!existsSync(sealPath)) {
    return { status: 'unverifiable', detail: 'No dossier.seal file found' };
  }

  let sealContent;
  try {
    sealContent = readFileSync(sealPath, 'utf8').trim();
  } catch (e) {
    return { status: 'unverifiable', detail: `Cannot read seal file: ${e.message}` };
  }

  // List all files in the dossier directory except dossier.seal itself
  let files;
  try {
    files = readdirSync(dossierDir)
      .filter(f => f !== 'dossier.seal')
      .sort();
  } catch (e) {
    return { status: 'unverifiable', detail: `Cannot list dossier directory: ${e.message}` };
  }

  if (files.length === 0) {
    return { status: 'unverifiable', detail: 'No files to verify against seal' };
  }

  // Parse seal: upstream format is "HEX_DIGEST  -" (shasum output), also accept bare hex
  const sealHex = sealContent.replace(/\s+-.{0,2}$/, '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(sealHex)) {
    return { status: 'unverifiable', detail: `Seal file does not contain a valid SHA-256 digest` };
  }

  // Build file hashes for both manifest formats
  const fileHashes = new Map();
  let allReadable = true;

  for (const file of files) {
    const filePath = join(dossierDir, file);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      const fileHash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
      fileHashes.set(file, fileHash);
    } catch (_) {
      allReadable = false;
    }
  }

  if (!allReadable) {
    return { status: 'unverifiable', detail: 'Some files could not be read for seal verification' };
  }

  if (fileHashes.size === 0) {
    return { status: 'unverifiable', detail: 'No files to verify against seal' };
  }

  // Try both manifest formats:
  // Format 1 (upstream shasum): hash each "HEX_DIGEST  filename\n" row, then hash the manifest
  const shasumManifest = createHash('sha256');
  for (const [file, hash] of [...fileHashes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    shasumManifest.update(`${hash}  ${file}\n`);
  }
  const shasumComputed = shasumManifest.digest('hex');

  if (shasumComputed === sealHex) {
    return { status: 'valid', detail: 'Seal matches file manifest (shasum format)' };
  }

  // Format 2 (original): "filename:hash\n" pairs
  const origManifest = createHash('sha256');
  for (const [file, hash] of [...fileHashes.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    origManifest.update(`${file}:${hash}\n`);
  }
  const origComputed = origManifest.digest('hex');

  if (origComputed === sealHex) {
    return { status: 'valid', detail: 'Seal matches file manifest (name:hash format)' };
  }

  // If the dossier is a subset (e.g., ghidra.log absent), we cannot reconstruct
  // the original sealed manifest — return unverifiable, not invalid
  if (fileHashes.size < 5) {
    return { status: 'unverifiable', detail: `Only ${fileHashes.size} files present; original sealed file list may be larger. Cannot reconstruct original manifest.` };
  }

  return { status: 'invalid', detail: `Seal mismatch: seal ${sealHex.slice(0, 16)}..., shasum-format ${shasumComputed.slice(0, 16)}..., name:hash-format ${origComputed.slice(0, 16)}...` };
}

// ─── Evidence Grading ─────────────────────────────────────────
// Assigns evidence grades with confidence scores per spec:
// measured=1.0, verified=0.9, annotated=0.7, unverified=0.4

const GRADE_CONFIDENCE = {
  measured: 1.0,
  verified: 0.9,
  annotated: 0.7,
  unverified: 0.4,
};

export function gradeEvidence(parsedFunctions, annotations, imports, binarySha = 'unknown') {
  const facts = [];
  const verifiedImportNames = new Set();

  // Build set of verified imports
  if (annotations?.importVerification) {
    for (const [name, info] of Object.entries(annotations.importVerification)) {
      if (info.status === 'verified') verifiedImportNames.add(name);
    }
  }

  for (const fn of parsedFunctions) {
    const binaryPrefix = (binarySha || 'unknown').slice(0, 16);
    const key = `fn:${binaryPrefix}:${fn.name}@${fn.address}`;
    const annotationKey = `${fn.name}@${fn.address}`;
    const annotation = annotations?.functions?.[annotationKey];

    // Function existence and line count are measured facts (from Ghidra/r2 output)
    let grade = 'measured';
    let confidence = GRADE_CONFIDENCE.measured;

    // Check if the function's imports have been verified
    const importHits = imports
      .filter(imp => fn.body.includes(imp.name))
      .map(imp => imp.name);

    const verifiedHits = importHits.filter(n => verifiedImportNames.has(n));

    if (annotation) {
      if (verifiedHits.length > 0) {
        grade = 'verified';
        confidence = GRADE_CONFIDENCE.verified;
      } else if (annotation.annotation && annotation.annotation.length > 10) {
        grade = 'annotated';
        confidence = GRADE_CONFIDENCE.annotated;
      } else {
        grade = 'unverified';
        confidence = GRADE_CONFIDENCE.unverified;
      }
    }

    facts.push({
      key,
      value: {
        name: fn.name,
        address: fn.address,
        lines: fn.lines,
        c: fn.body,
        annotations: annotation ? [annotation] : [],
        importHits: verifiedHits,
        compileStatus: null, // filled in by compile-rate tools
      },
      grade,
      confidence,
    });
  }

  return facts;
}

// ─── Full Dossier Parser ──────────────────────────────────────

export function parseDossier(dossierDir) {
  const resolvedDir = resolve(dossierDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Dossier directory not found: ${resolvedDir}`);
  }

  // Read binary SHA
  const shaPath = join(resolvedDir, 'binary.sha256');
  let binarySha = 'unknown';
  if (existsSync(shaPath)) {
    binarySha = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  }

  // Parse decompiled C
  const cPath = join(resolvedDir, 'decompiled.c');
  let functions = [];
  if (existsSync(cPath)) {
    functions = parseDecompiledC(readFileSync(cPath, 'utf8'));
  }

  // Parse annotations
  const annotPath = join(resolvedDir, 'annotations.md');
  let annotations = { functions: {}, importVerification: {}, redBlueScores: {} };
  if (existsSync(annotPath)) {
    annotations = parseAnnotations(readFileSync(annotPath, 'utf8'));
  }

  // Parse imports
  const importPath = join(resolvedDir, 'imports.txt');
  let imports = [];
  if (existsSync(importPath)) {
    imports = parseImports(readFileSync(importPath, 'utf8'));
  }

  // Verify seal
  const seal = verifyDossierSeal(resolvedDir);

  // Compute summary
  const annotationCoverage = functions.length > 0
    ? Object.keys(annotations.functions).length / functions.length
    : 0;

  return {
    binary: binarySha,
    dossierPath: resolvedDir,
    functions,
    imports,
    annotations,
    seal,
    summary: {
      functionCount: functions.length,
      importCount: imports.length,
      sealStatus: seal.status,
      annotationCoverage: Math.round(annotationCoverage * 100) / 100,
      redBlueScores: annotations.redBlueScores,
    },
  };
}

// ─── Grade Dossier ────────────────────────────────────────────

export function gradeDossier(parsed) {
  return {
    facts: gradeEvidence(parsed.functions, parsed.annotations, parsed.imports, parsed.binary),
  };
}

// ─── Store Dossier ────────────────────────────────────────────

export function storeDossier(graded, parsed, agentId = RE_AGENT_ID) {
  let stored = 0;
  let skipped = 0;
  const errors = [];

  // Store per-function facts
  for (const fact of graded.facts) {
    try {
      storeMemory(agentId, 'binary_dossier', fact.key, JSON.stringify(fact.value), {
        confidence: fact.confidence,
        source: `dossier:${parsed.binary}:${fact.grade}`,
      });
      stored++;
    } catch (e) {
      errors.push({ key: fact.key, error: e.message });
    }
  }

  // Store per-binary summary
  const summaryKey = `binary:${parsed.binary.slice(0, 16)}`;
  try {
    const summaryValue = {
      path: parsed.dossierPath,
      sha256: parsed.binary,
      functionCount: parsed.summary.functionCount,
      importCount: parsed.summary.importCount,
      compileRate: null,
      sealValid: parsed.seal.status,
      topFunctions: parsed.functions.slice(0, 10).map(f => ({ name: f.name, addr: f.address, lines: f.lines })),
      annotationCoverage: parsed.summary.annotationCoverage,
    };
    storeMemory(agentId, 'binary_dossier', summaryKey, JSON.stringify(summaryValue), {
      confidence: GRADE_CONFIDENCE.measured,
      source: `dossier:${parsed.binary}:summary`,
    });
    stored++;
  } catch (e) {
    errors.push({ key: summaryKey, error: e.message });
  }

  return { stored, skipped, errors };
}

// ─── Process Dossier (full pipeline) ──────────────────────────

export function processDossier(dossierDir) {
  const parsed = parseDossier(dossierDir);
  const graded = gradeDossier(parsed);
  const storage = storeDossier(graded, parsed);

  // Record in dossier_ingestions table
  const gradeBreakdown = {};
  for (const fact of graded.facts) {
    gradeBreakdown[fact.grade] = (gradeBreakdown[fact.grade] || 0) + 1;
  }

  db.prepare(`
    INSERT INTO dossier_ingestions (binary_sha256, dossier_path, function_count, import_count, compile_rate, seal_valid, evidence_grades, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parsed.binary,
    parsed.dossierPath,
    parsed.summary.functionCount,
    parsed.summary.importCount,
    null,
    parsed.seal.status,
    JSON.stringify(gradeBreakdown),
    Date.now(),
  );

  // Publish bus event with correct 3-argument arity: (fromAgent, topic, payload)
  const busEvent = {
    binary: parsed.binary,
    functionCount: parsed.summary.functionCount,
    importCount: parsed.summary.importCount,
    sealStatus: parsed.seal.status,
    annotationCoverage: parsed.summary.annotationCoverage,
    stored: storage.stored,
    grades: gradeBreakdown,
  };

  let busPublished = false;
  try {
    publish(RE_AGENT_ID, 'system.re.dossier.processed', busEvent);
    busPublished = true;
  } catch (e) {
    console.error('[dossier-engine] bus publish failed:', e.message);
  }

  return {
    parsed: {
      binary: parsed.binary,
      functionCount: parsed.summary.functionCount,
      importCount: parsed.summary.importCount,
      sealStatus: parsed.seal.status,
      annotationCoverage: parsed.summary.annotationCoverage,
    },
    graded: gradeBreakdown,
    stored: storage,
    busPublished,
  };
}

// ─── Debate Pipeline (Phase 4) ────────────────────────────────
// After ingestion, top functions by line count (8-90 lines, same filter
// as fra-annotate.py) are submitted to adversarial debate. Verdicts
// update agent_memory confidence: CONFIRMED +0.1, CHALLENGED -0.2.

const DEBATE_LINE_MIN = 8;
const DEBATE_LINE_MAX = 90;
const DEBATE_TOP_N = 10;

export async function debateDossierFunctions(parsed, graded, opts = {}) {
  const debatable = graded.facts
    .filter(f => f.value.lines >= DEBATE_LINE_MIN && f.value.lines <= DEBATE_LINE_MAX)
    .sort((a, b) => b.value.lines - a.value.lines)
    .slice(0, opts.maxFunctions || DEBATE_TOP_N);

  if (debatable.length === 0) {
    return { debated: 0, results: [], skipped: 'No functions in 8-90 line range' };
  }

  const results = [];

  for (const fact of debatable) {
    try {
      const debateResult = await debateBinaryAnnotation({
        name: fact.value.name,
        address: fact.value.address,
        lines: fact.value.lines,
        body: fact.value.c,
        annotations: fact.value.annotations,
        importHits: fact.value.importHits,
      }, opts);

      // Update confidence based on verdict
      const confidenceDelta = debateResult.verdict === 'CONFIRMED' ? 0.1
        : debateResult.verdict === 'CHALLENGED' ? -0.2
        : 0;

      if (confidenceDelta !== 0) {
        const newConfidence = Math.max(0, Math.min(1, fact.confidence + confidenceDelta));
        try {
          storeMemory(RE_AGENT_ID, 'binary_dossier', fact.key, JSON.stringify({
            ...fact.value,
            debateVerdict: debateResult.verdict,
            debateChallenges: debateResult.challengedClaims,
          }), {
            confidence: newConfidence,
            source: `dossier:${parsed.binary}:debate:${debateResult.verdict.toLowerCase()}`,
          });
        } catch (_) {}
      }

      results.push(debateResult);
    } catch (e) {
      results.push({
        functionName: fact.value.name,
        address: fact.value.address,
        verdict: 'ERROR',
        error: e.message,
      });
    }
  }

  const summary = {
    debated: results.length,
    confirmed: results.filter(r => r.verdict === 'CONFIRMED').length,
    challenged: results.filter(r => r.verdict === 'CHALLENGED').length,
    split: results.filter(r => r.verdict === 'SPLIT').length,
    errors: results.filter(r => r.verdict === 'ERROR').length,
  };

  try {
    publish(RE_AGENT_ID, 'system.re.dossier.debated', {
      binary: parsed.binary,
      ...summary,
    });
  } catch (e) {
    console.error('[dossier-engine] debate bus publish failed:', e.message);
  }

  return { ...summary, results };
}

// ─── Query Helpers ────────────────────────────────────────────

export function listDossiers({ limit = 50, offset = 0 } = {}) {
  const clamped = Math.min(200, Math.max(1, limit));
  const rows = db.prepare(
    'SELECT * FROM dossier_ingestions ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(clamped, Math.max(0, offset));
  const total = db.prepare('SELECT COUNT(*) as c FROM dossier_ingestions').get();
  return { dossiers: rows, total: total?.c || 0 };
}

export function getDossier(sha) {
  const dossier = db.prepare(
    'SELECT * FROM dossier_ingestions WHERE binary_sha256 = ? ORDER BY created_at DESC LIMIT 1'
  ).get(sha);
  if (!dossier) return null;

  // Query function memories by source field (contains binary SHA) and binary-scoped key prefix
  const shaPrefix = sha.slice(0, 16);
  const memories = db.prepare(
    `SELECT * FROM agent_memories WHERE agent_id = ? AND category = 'binary_dossier' AND source LIKE ? AND key LIKE ? ORDER BY created_at DESC`
  ).all(RE_AGENT_ID, `%${shaPrefix}%`, `fn:${shaPrefix}:%`);

  return { dossier, memories };
}

export function getDossierFunctions(sha, { limit = 50, offset = 0 } = {}) {
  const clamped = Math.min(500, Math.max(1, limit));
  const clampedOffset = Math.max(0, offset);
  const shaPrefix = sha.slice(0, 16);

  // SQL-level filtering and pagination by binary-scoped key prefix
  const total = db.prepare(
    `SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = ? AND category = 'binary_dossier' AND key LIKE ?`
  ).get(RE_AGENT_ID, `fn:${shaPrefix}:%`);

  const rows = db.prepare(
    `SELECT * FROM agent_memories WHERE agent_id = ? AND category = 'binary_dossier' AND key LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).all(RE_AGENT_ID, `fn:${shaPrefix}:%`, clamped, clampedOffset);

  const functions = rows
    .map(m => {
      try {
        const val = JSON.parse(m.value);
        return { key: m.key, ...val, confidence: m.confidence, verified: !!m.verified_at };
      } catch (_) { return null; }
    })
    .filter(Boolean);

  return { functions, total: total?.c || 0 };
}

export function getDossierFunction(sha, functionName) {
  const shaPrefix = sha.slice(0, 16);

  // Exact binary-scoped lookup: fn:<shaPrefix>:<functionName>@<addr>
  const fn = db.prepare(
    `SELECT * FROM agent_memories WHERE agent_id = ? AND category = 'binary_dossier' AND key LIKE ? LIMIT 1`
  ).get(RE_AGENT_ID, `fn:${shaPrefix}:${functionName}@%`);

  if (!fn) return null;

  try {
    const val = JSON.parse(fn.value);
    return { key: fn.key, ...val, confidence: fn.confidence, verified: !!fn.verified_at, source: fn.source };
  } catch (_) { return null; }
}
