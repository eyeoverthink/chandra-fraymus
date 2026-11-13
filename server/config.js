import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ROOT = resolve(process.env.FRAYMUS_WORKSPACE || resolve(PROJECT_ROOT, '..'));
export const DATA_DIR = resolve(process.env.CHANDRA_DATA_DIR || resolve(PROJECT_ROOT, 'data'));

/**
 * True when this process may close rows a dead process left running (boot recovery). Never from a test process
 * that has the real database open: on 2026-11-13 test/http.test.js loaded the runtime with no data folder named,
 * make.js "recovered" the real creation_jobs table and a live render was marked "interrupted by restart" the
 * minute `npm test` began. A test that names its own CHANDRA_DATA_DIR recovers its own rows as before.
 */
export function mayRecoverAtBoot(env = process.env) {
  return !(env.NODE_TEST_CONTEXT && !env.CHANDRA_DATA_DIR);
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
