import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE_ROOT = resolve(process.env.FRAYMUS_WORKSPACE || resolve(PROJECT_ROOT, '..'));
export const DATA_DIR = resolve(process.env.CHANDRA_DATA_DIR || resolve(PROJECT_ROOT, 'data'));

export function loopbackUrl(value, name = 'service URL') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an HTTP loopback origin without credentials or a path`);
  }
  return url.origin;
}
export const OLLAMA_URL = loopbackUrl(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434', 'OLLAMA_BASE_URL');
export const VOICE_URL = loopbackUrl(process.env.FRAYMUS_VOICE_URL || 'http://127.0.0.1:9099', 'FRAYMUS_VOICE_URL');
export const HOST = process.env.HOST || '127.0.0.1';
if (!['localhost', '127.0.0.1', '::1'].includes(HOST)) throw new Error('This local deployment binds only to loopback');
export const PORT = Number(process.env.PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
export const LOCAL_ORIGINS = new Set([PORT, 5173, 4178].flatMap(port =>
  [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]));
