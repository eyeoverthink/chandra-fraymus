import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const groups = address.split(':'), first = parseInt(groups[0],16), second = parseInt(groups[1] || '0',16);
    return first >= 0x2000 && first <= 0x2fff && first !== 0x2002
      && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

export function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) throw new Error('Only ordinary public HTTP(S) URLs are supported');
  let url;
  try { url = new URL(value); } catch { throw new Error('Only ordinary public HTTP(S) URLs are supported'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Only ordinary public HTTP(S) URLs on their default ports are supported');
  url.hash = '';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) throw new Error('Private/reserved network destinations are blocked');
  return url;
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

// Request seams are server-owned for tests, never model arguments. Pin every
// connection to a checked DNS answer; do not share keepalive sockets or proxies.
let active = 0;
export async function requestPublicPage(value, options = {}) {
  if (active >= 4) throw new Error('Public web requests are busy; retry later');
  active++;
  try { return await requestPage(value, options); } finally { active--; }
}
async function requestPage(value, { signal, lookupImpl = lookup, getImpl, timeoutMs = 10000 } = {}) {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  signal.throwIfAborted();
  const url = publicUrl(value), host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookupImpl(host, { all: true }), signal);
  signal.throwIfAborted();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => !a || isIP(a.address) !== a.family || !isPublicAddress(a.address))) throw new Error('Private/reserved network destinations are blocked');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    let request, response, finished = false;
    const finish = (error, value) => {
      if (finished) return; finished = true;
      signal.removeEventListener('abort', abort);
      response?.destroy();
      request?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(signal.reason || new Error('Web request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      const get = getImpl || (url.protocol === 'https:' ? https.get : http.get);
      request = get(url, { signal, agent: false, autoSelectFamily: false, maxHeaderSize: 16384, rejectUnauthorized: true,
        lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
        headers: { 'User-Agent': 'Fraymus-local-agent/1.0', Accept: 'text/html,text/plain,application/json', 'Accept-Encoding': 'identity' } }, incoming => {
        if (finished) { incoming.destroy(); return; }
        response = incoming;
        const status = incoming.statusCode || 0, contentType = String(incoming.headers['content-type'] || '');
        const common = { url: url.href, status, contentType, fetchedAt: Date.now(), untrusted: true };
        if (status >= 300 && status < 400) {
          let redirect;
          try { if (incoming.headers.location) redirect = publicUrl(new URL(String(incoming.headers.location), url).href).href; } catch {}
          finish(null, { ...common, bytes: 0, redirect, redirectBlocked: !redirect, followed: false }); return;
        }
        if (status < 200 || status >= 300) {
          const error = Object.assign(new Error(`HTTP ${status}`), { httpStatus: status });
          const retry = String(incoming.headers['retry-after'] || '');
          if (/^\d{1,6}$/.test(retry)) error.retryAfterSeconds = Math.min(86400, Number(retry));
          else if (retry.length <= 128 && Number.isFinite(Date.parse(retry))) error.retryAfterSeconds = Math.min(86400, Math.max(0, Math.ceil((Date.parse(retry) - Date.now()) / 1000)));
          finish(error); return;
        }
        if (!/^(?:text\/|application\/(?:json|[^;]+\+json))/i.test(contentType)) { finish(new Error('This tool reads text pages, not binary files')); return; }
        const encoding = String(incoming.headers['content-encoding'] || 'identity').toLowerCase();
        if (encoding !== 'identity') { finish(new Error('Compressed web responses are unsupported; server must honor Accept-Encoding: identity')); return; }
        const declared = incoming.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > 1024 * 1024)) { finish(new Error('Web response exceeds 1 MiB or has an invalid length')); return; }
        const chunks = []; let bytes = 0;
        incoming.on('data', chunk => {
          if (finished) return;
          bytes += chunk.length;
          if (bytes > 1024 * 1024) finish(new Error('Web response exceeds 1 MiB'));
          else chunks.push(Buffer.from(chunk));
        });
        incoming.once('error', error => finish(error));
        incoming.once('aborted', () => finish(new Error('Web response was truncated')));
        incoming.once('end', () => {
          if (finished) return;
          if (incoming.complete === false || (declared !== undefined && Number(declared) !== bytes)) { finish(new Error('Web response was truncated')); return; }
          const body = Buffer.concat(chunks);
          const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
          let text;
          try { text = new TextDecoder(charset, { fatal: true }).decode(body); }
          catch { finish(new Error('Unsupported charset or malformed text response')); return; }
          finish(null, { ...common, bytes, text, rawSha256: createHash('sha256').update(body).digest('hex'), redirect: undefined, followed: false });
        });
      });
      request.once('error', error => finish(error));
      if (signal.aborted) abort();
    } catch (error) { finish(error); }
  });
}
