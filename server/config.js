import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ROOT = resolve(process.env.FRAYMUS_WORKSPACE || resolve(PROJECT_ROOT, '..'));
export const REAL_DATA_DIR = resolve(PROJECT_ROOT, 'data');

/**
 * Tests never open the real store by default. Under the test runner (NODE_TEST_CONTEXT) a process that names no
 * CHANDRA_DATA_DIR gets a throwaway folder, removed on exit by db.js (and swept by scripts/run-tests.mjs if a
 * process dies before that). Before 2026-11-13 every test that built the runtime read and wrote data/chandra.db —
 * and one run marked a live render "interrupted by restart". A test that names a folder still gets that folder.
 */
export const TEST_SCRATCH_PREFIX = 'chandra-test-data-';
export const TEST_SCRATCH_DATA = !process.env.CHANDRA_DATA_DIR && !!process.env.NODE_TEST_CONTEXT;
if (TEST_SCRATCH_DATA) {
  const scratch = mkdtempSync(join(tmpdir(), TEST_SCRATCH_PREFIX));
  process.env.CHANDRA_DATA_DIR = scratch;
  // whoever makes the folder removes it — many tests load config without ever opening the database. db.js prepends
  // its close handler, so on Windows the database file is closed before this runs.
  process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch (e) { console.error('[config] test data cleanup:', e.message); } });
}
export const DATA_DIR = resolve(process.env.CHANDRA_DATA_DIR || REAL_DATA_DIR);

/**
 * True when this process may close rows a dead process left running (boot recovery). A second line behind the
 * scratch default: never from a test process whose data folder is the real one, however it got there.
 */
export function mayRecoverAtBoot(env = process.env, dataDir = DATA_DIR) {
  return !(env.NODE_TEST_CONTEXT && resolve(dataDir) === REAL_DATA_DIR);
}

export function loopbackUrl(value, name = 'service URL') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an HTTP loopback origin without credentials or a path`);
  }
  return url.origin;
}
export const PRODUCTION = process.env.NODE_ENV === 'production';

function serviceUrl(value, name) {
  const url = new URL(value);
  if (PRODUCTION) return url.origin;
  return loopbackUrl(value, name);
}
export const OLLAMA_URL = serviceUrl(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', 'OLLAMA_BASE_URL');
export const VOICE_URL = serviceUrl(process.env.FRAYMUS_VOICE_URL || 'http://127.0.0.1:9099', 'FRAYMUS_VOICE_URL');
export const HOST = process.env.HOST || '127.0.0.1';
if (!PRODUCTION && !['localhost', '127.0.0.1', '::1'].includes(HOST)) throw new Error('This local deployment binds only to loopback');
export const PORT = Number(process.env.CHANDRA_PORT || process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
const ALLOWED_ORIGINS_ENV = process.env.ALLOWED_ORIGINS;
export const LOCAL_ORIGINS = new Set([
  ...[PORT, 5173, 4178].flatMap(port =>
    [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]),
  ...(ALLOWED_ORIGINS_ENV ? ALLOWED_ORIGINS_ENV.split(',').map(s => s.trim()) : []),
]);
