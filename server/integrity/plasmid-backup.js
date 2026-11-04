import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../config.js';

const BACKUP_DIR = join(DATA_DIR, 'plasmid-backups');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function encode2BitDNA(buf) {
  const bases = ['A', 'C', 'G', 'T'];
  let strand = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    strand += bases[(b >> 6) & 3];
    strand += bases[(b >> 4) & 3];
    strand += bases[(b >> 2) & 3];
    strand += bases[b & 3];
  }
  return strand;
}

function decode2BitDNA(strand) {
  const baseMap = { A: 0, C: 1, G: 2, T: 3 };
  const bytes = [];
  for (let i = 0; i + 3 < strand.length; i += 4) {
    const b = ((baseMap[strand[i]] || 0) << 6)
            | ((baseMap[strand[i+1]] || 0) << 4)
            | ((baseMap[strand[i+2]] || 0) << 2)
            | (baseMap[strand[i+3]] || 0);
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

export function createPlasmidBackup(filePaths, metadata = {}) {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const entries = [];
  for (const fp of filePaths) {
    const absPath = resolve(fp);
    if (!existsSync(absPath)) continue;
    const stat = statSync(absPath);
    if (stat.size > 50 * 1024 * 1024) continue;
    const data = readFileSync(absPath);
    const b64 = data.toString('base64');
    const hash = sha256(data);
    entries.push({
      path: absPath,
      name: basename(absPath),
      size: stat.size,
      hash,
      data_b64: b64,
    });
  }

  if (entries.length === 0) {
    return { error: 'No valid files to back up' };
  }

  const payload = JSON.stringify({
    magic: 'CHANDRA-PLASMID',
    version: 1,
    created_at: Date.now(),
    metadata: {
      source: 'chandra-fraymus',
      reason: metadata.reason || 'scheduled backup',
      ...metadata,
    },
    entries: entries.map(e => ({
      path: e.path,
      name: e.name,
      size: e.size,
      hash: e.hash,
      data_b64: e.data_b64,
    })),
  });

  const payloadBuf = Buffer.from(payload, 'utf-8');
  const payloadHash = sha256(payloadBuf);

  const dnaPreamble = `FRAY|PLASMID|v1|gen=${Date.now()}|sha=${payloadHash.slice(0, 16)}|files=${entries.length}|`;
  const dnaStrand = encode2BitDNA(payloadBuf);

  const fullPlasmid = dnaPreamble + '\n' + dnaStrand + '\n' + `SEAL|${payloadHash}`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const plasmidFile = join(BACKUP_DIR, `chandra-${timestamp}.plasmid.dna`);
  writeFileSync(plasmidFile, fullPlasmid);

  return {
    file: plasmidFile,
    files_packed: entries.length,
    total_bytes: entries.reduce((s, e) => s + e.size, 0),
    payload_hash: payloadHash,
    strand_length: dnaStrand.length,
    entries: entries.map(e => ({ path: e.path, name: e.name, size: e.size, hash: e.hash })),
  };
}

export function restorePlasmidBackup(plasmidPath, opts = {}) {
  if (!existsSync(plasmidPath)) {
    return { error: 'Plasmid file not found' };
  }

  const raw = readFileSync(plasmidPath, 'utf-8');
  const lines = raw.split('\n');

  if (lines.length < 3 || !lines[0].startsWith('FRAY|PLASMID|')) {
    return { error: 'Invalid plasmid format' };
  }

  const preamble = lines[0];
  const dnaStrand = lines.slice(1, -1).join('');
  const sealLine = lines[lines.length - 1];

  const expectedHash = sealLine.replace('SEAL|', '');
  const decoded = decode2BitDNA(dnaStrand);
  const actualHash = sha256(decoded);

  if (actualHash !== expectedHash) {
    return {
      error: 'Plasmid integrity check failed',
      expected: expectedHash,
      actual: actualHash,
    };
  }

  let payload;
  try {
    payload = JSON.parse(decoded.toString('utf-8'));
  } catch (e) {
    return { error: 'Plasmid payload decode failed: ' + e.message };
  }

  if (payload.magic !== 'CHANDRA-PLASMID') {
    return { error: 'Wrong plasmid magic: ' + payload.magic };
  }

  const restored = [];
  const skipped = [];

  for (const entry of payload.entries) {
    const data = Buffer.from(entry.data_b64, 'base64');
    const hash = sha256(data);
    if (hash !== entry.hash) {
      skipped.push({ path: entry.path, reason: 'hash mismatch within plasmid' });
      continue;
    }

    if (existsSync(entry.path) && !opts.force) {
      const currentHash = sha256(readFileSync(entry.path));
      if (currentHash === entry.hash) {
        skipped.push({ path: entry.path, reason: 'already intact' });
        continue;
      }
    }

    try {
      const dir = join(entry.path, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(entry.path, data);
      restored.push({ path: entry.path, size: data.length, hash });
    } catch (e) {
      skipped.push({ path: entry.path, reason: e.message });
    }
  }

  return {
    plasmid_version: payload.version,
    created_at: payload.created_at,
    metadata: payload.metadata,
    total_entries: payload.entries.length,
    restored: restored.length,
    skipped: skipped.length,
    restored_files: restored,
    skipped_files: skipped,
  };
}

export function listPlasmidBackups() {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const files = readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.plasmid.dna'))
    .sort()
    .reverse();

  return files.map(f => {
    const full = join(BACKUP_DIR, f);
    const stat = statSync(full);
    const firstLine = readFileSync(full, 'utf-8').split('\n')[0];
    const filesMatch = firstLine.match(/files=(\d+)/);
    return {
      file: f,
      path: full,
      size: stat.size,
      modified: stat.mtimeMs,
      files_packed: filesMatch ? parseInt(filesMatch[1]) : 0,
    };
  });
}

export function verifyPlasmid(plasmidPath) {
  if (!existsSync(plasmidPath)) return { valid: false, error: 'File not found' };
  const raw = readFileSync(plasmidPath, 'utf-8');
  const lines = raw.split('\n');
  if (lines.length < 3 || !lines[0].startsWith('FRAY|PLASMID|')) {
    return { valid: false, error: 'Invalid format' };
  }
  const dnaStrand = lines.slice(1, -1).join('');
  const sealLine = lines[lines.length - 1];
  const expectedHash = sealLine.replace('SEAL|', '');
  const decoded = decode2BitDNA(dnaStrand);
  const actualHash = sha256(decoded);

  const positive = actualHash === expectedHash;

  const tamperedStrand = dnaStrand.slice(0, -4) + 'AAAA';
  const tamperedDecoded = decode2BitDNA(tamperedStrand);
  const tamperedHash = sha256(tamperedDecoded);
  const negative = tamperedHash !== expectedHash;

  return {
    valid: positive,
    positive_control: { pass: positive, hash: actualHash, expected: expectedHash },
    negative_control: { pass: negative, tampered_hash: tamperedHash },
    verdict: positive && negative
      ? 'PROVEN: intact plasmid passes, tampered plasmid fails'
      : positive ? 'PARTIAL: passes but negative control inconclusive'
      : 'DENIED: plasmid integrity compromised'
  };
}

export function installPlasmidRoutes(app) {
  app.get('/api/integrity/plasmid/list', (_req, res) => {
    res.json(listPlasmidBackups());
  });

  app.post('/api/integrity/plasmid/backup', (req, res) => {
    const { paths, metadata } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array required' });
    }
    try {
      res.json(createPlasmidBackup(paths, metadata || {}));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/plasmid/restore', (req, res) => {
    const { path: plasmidPath, force } = req.body || {};
    if (!plasmidPath) return res.status(400).json({ error: 'path required' });
    try {
      res.json(restorePlasmidBackup(plasmidPath, { force: !!force }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/plasmid/verify', (req, res) => {
    const { path: plasmidPath } = req.body || {};
    if (!plasmidPath) return res.status(400).json({ error: 'path required' });
    try {
      res.json(verifyPlasmid(plasmidPath));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/integrity/plasmid/auto-backup', (_req, res) => {
    const critical = [];
    const dbPath = join(DATA_DIR, 'chandra.db');
    const idPath = join(DATA_DIR, 'streaming-identity.json');
    const manifestPath = join(DATA_DIR, 'integrity-manifest.json');
    if (existsSync(dbPath)) critical.push(dbPath);
    if (existsSync(idPath)) critical.push(idPath);
    if (existsSync(manifestPath)) critical.push(manifestPath);
    try {
      res.json(createPlasmidBackup(critical, { reason: 'auto-backup of critical files' }));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
