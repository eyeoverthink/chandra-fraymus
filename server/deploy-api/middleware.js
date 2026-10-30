import { verifyBearer, can } from '../mcp/auth.js';
import { tryConsume } from './rate-limiter.js';

export function requireApiKey(scope = 'run') {
  return (req, res, next) => {
    const principal = verifyBearer(req.headers.authorization);
    if (!principal) return res.status(401).json({ error: 'API key required', hint: 'Pass Bearer token in Authorization header' });
    if (!can(principal, scope)) return res.status(403).json({ error: `Scope '${scope}' required` });
    const rate = tryConsume(principal.via);
    res.setHeader('X-RateLimit-Remaining', rate.remaining);
    res.setHeader('X-RateLimit-Limit', rate.limit);
    if (!rate.allowed) {
      res.setHeader('Retry-After', rate.retryAfter);
      return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: rate.retryAfter });
    }
    req.apiPrincipal = principal;
    next();
  };
}

export function optionalApiKey() {
  return (req, _res, next) => {
    const principal = verifyBearer(req.headers.authorization);
    if (principal) req.apiPrincipal = principal;
    next();
  };
}
