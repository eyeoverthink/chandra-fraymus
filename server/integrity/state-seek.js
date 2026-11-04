// Boot continuity inventory and immutable-file integrity verification.
// Ported from FRAYNIX-DREAMER-120B's learnStateSeekOnBoot() + stateSeek() + writeDistManifest()
//
// At boot: ensure critical directories exist, register continuity files with the
// watchdog, verify-and-heal immutable files, find state-fossil references when
// file fossils fail, generate a boot inventory, and publish health to the bus.
// Vaughn D. Scott | EYEOVERTHINK® | ephless llc

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { db } from '../db.js';
import { trackFile, verifyAll, isProtectedMutableFile, getManifest } from './watchdog.js';

const BOOT_MANIFEST_FILE = join(DATA_DIR, 'boot-manifest.json');

const CRITICAL_DIRS = [
  'dreams',
  'remembered',
  'fossils',
  'ledger',
  'carbon',
  'agents',
];

const CRITICAL_FILES = [
  'chandra.db',
  'streaming-identity.json',
];

const CRITICAL_GLOBS = [
  { dir: 'dreams', pattern: /^\d{4}-dreamer-.*\.md$/, label: 'dream_files' },
  { dir: 'remembered', pattern: /^\d{4}-remembered-.*\.md$/, label: 'remembered_files' },
  { dir: 'ledger', pattern: /\.jsonl$/, label: 'ledger_files' },
];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function ensureDirectories() {
  const results = [];
  for (const dir of CRITICAL_DIRS) {
    const fullPath = join(DATA_DIR, dir);
    const existed = existsSync(fullPath);
    if (!existed) {
      mkdirSync(fullPath, { recursive: true });
    }
    results.push({ dir, existed, path: fullPath });
  }
  return results;
}

function discoverContinuityFiles() {
  const files = [];
  for (const f of CRITICAL_FILES) {
    const fullPath = join(DATA_DIR, f);
    if (existsSync(fullPath)) {
      files.push(fullPath);
    }
  }
  for (const { dir, pattern } of CRITICAL_GLOBS) {
    const fullDir = join(DATA_DIR, dir);
    if (!existsSync(fullDir)) continue;
    try {
      const entries = readdirSync(fullDir).filter(f => pattern.test(f));
      const latest = entries.sort().slice(-3);
      for (const entry of latest) {
        files.push(join(fullDir, entry));
      }
    } catch {}
  }
  return files;
}

function registerWithWatchdog(files) {
  const manifest = getManifest();
  const tracked = manifest.tracked || {};
  const results = { already_tracked: 0, newly_tracked: 0, failed: 0, protected_mutable: 0 };
  for (const f of files) {
    if (isProtectedMutableFile(f)) {
      results.protected_mutable++;
      continue;
    }
    if (tracked[f]) {
      results.already_tracked++;
      continue;
    }
    try {
      trackFile(f);
      results.newly_tracked++;
    } catch (e) {
      results.failed++;
      console.error(`[state-seek] track failed for ${f}:`, e.message);
    }
  }
  return results;
}

function findStateFossilReferences(missingFiles) {
  let referencesFound = 0;
  for (const filePath of missingFiles) {
    try {
      const row = db.prepare(
        `SELECT data FROM state_fossils WHERE data LIKE ? ORDER BY created_at DESC LIMIT 1`
      ).get(`%${filePath.replace(/\\/g, '/')}%`);
      if (row) {
        const fossil = JSON.parse(row.data);
        if (fossil && typeof fossil === 'object') {
          referencesFound++;
          console.log(`[state-seek] Found state fossil reference for ${filePath}`);
        }
      }
    } catch {}
  }
  return { restored: 0, references_found: referencesFound, attempted: missingFiles.length,
    reason: 'State fossil references are not recoverable file payloads' };
}

function generateBootManifest(seekResult) {
  const artifacts = {};
  const files = discoverContinuityFiles();
  for (const f of files) {
    try {
      const data = readFileSync(f);
      const relPath = f.replace(DATA_DIR, '').replace(/^[\\/]/, '');
      artifacts[relPath] = {
        bytes: data.length,
        sha256: sha256(data),
        modified: statSync(f).mtimeMs,
      };
    } catch {}
  }

  const manifest = {
    name: 'CHANDRA-FRAYMUS',
    built: new Date().toISOString(),
    identity: 'chandra-fraymus-v1',
    scope: 'File inventory; not a consistent database backup',
    boot_seek: {
      intact: seekResult.intact,
      tampered: seekResult.tampered,
      missing: seekResult.missing,
      healed: seekResult.healed,
      skipped: seekResult.skipped || 0,
    },
    artifact_count: Object.keys(artifacts).length,
    artifacts,
  };

  try {
    writeFileSync(BOOT_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error('[state-seek] manifest write failed:', e.message);
  }
  return manifest;
}

export function stateSeekOnBoot({ broadcast } = {}) {
  const t0 = Date.now();
  const report = {
    ts: new Date().toISOString(),
    directories: null,
    continuity_files: 0,
    registration: null,
    verify: null,
    fossil_fallback: null,
    manifest: null,
    duration_ms: 0,
    verdict: 'UNKNOWN',
  };

  try {
    report.directories = ensureDirectories();

    const files = discoverContinuityFiles();
    report.continuity_files = files.length;

    report.registration = registerWithWatchdog(files);

    const seekResult = verifyAll();
    report.verify = {
      intact: seekResult.intact,
      tampered: seekResult.tampered,
      missing: seekResult.missing,
      healed: seekResult.healed,
      failed: seekResult.failed,
      skipped: seekResult.skipped || 0,
    };

    if (seekResult.failed > 0) {
      const missingPaths = (seekResult.files || [])
        .filter(f => !f.healed && ['missing', 'tampered'].includes(f.status))
        .map(f => f.path);
      report.fossil_fallback = findStateFossilReferences(missingPaths);
    }

    report.manifest = generateBootManifest(seekResult);

    if (seekResult.tampered === 0 && seekResult.missing === 0) {
      report.verdict = 'ALL_CLEAR';
    } else if (seekResult.failed === 0) {
      report.verdict = `HEALED_${seekResult.healed}_FILES`;
    } else {
      report.verdict = `${seekResult.failed}_UNRECOVERABLE`;
    }
  } catch (e) {
    report.verdict = `BOOT_ERROR: ${e.message}`;
    console.error('[state-seek] boot error:', e.message);
  }

  report.duration_ms = Date.now() - t0;

  if (broadcast) {
    try {
      broadcast('integrity', {
        type: 'state_seek_boot',
        verdict: report.verdict,
        files_discovered: report.continuity_files,
        files_checked: (report.verify?.intact || 0) + (report.verify?.tampered || 0) + (report.verify?.missing || 0),
        protected_mutable: report.registration?.protected_mutable || 0,
        tampered: report.verify?.tampered || 0,
        healed: report.verify?.healed || 0,
        duration_ms: report.duration_ms,
      });
    } catch {}
  }

  const emoji = report.verdict === 'ALL_CLEAR' ? '✅' : '⚠️';
  console.log(`[state-seek] ${emoji} Boot: ${report.verdict} | ${report.continuity_files} files | ${report.duration_ms}ms`);

  return report;
}

export function getBootManifest() {
  if (!existsSync(BOOT_MANIFEST_FILE)) return null;
  try {
    return JSON.parse(readFileSync(BOOT_MANIFEST_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function installStateSeekRoutes(app) {
  app.get('/api/integrity/state-seek', (_req, res) => {
    try {
      const report = stateSeekOnBoot();
      res.json(report);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/integrity/boot-manifest', (_req, res) => {
    const manifest = getBootManifest();
    if (!manifest) return res.status(404).json({ error: 'no boot manifest yet' });
    res.json(manifest);
  });
}
