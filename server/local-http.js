import { LOCAL_ORIGINS, PORT } from './config.js';

export function allowedHost(host) {
  try {
    const url = new URL(`http://${host}`);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && Number(url.port || 80) === PORT && url.username === '' && url.password === ''
      && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
export function allowedRequest(req) {
  return allowedHost(req.headers.host) && (!req.headers.origin || LOCAL_ORIGINS.has(req.headers.origin))
    && req.headers['sec-fetch-site'] !== 'cross-site';
}
export function localBoundary(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!allowedRequest(req)) return res.status(403).json({ error: 'This service accepts requests from its local application only' });
  if (req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}
