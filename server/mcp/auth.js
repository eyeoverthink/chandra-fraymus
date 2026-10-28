import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';

export const SCOPES = ['read', 'run', 'admin'];
const now = () => Date.now();
const sha = s => createHash('sha256').update(s).digest('hex');

const cleanScopes = s => {
  const list = (Array.isArray(s) ? s : String(s || 'read run').split(/[\s,]+/)).filter(x => SCOPES.includes(x));
  if (!list.length) throw new Error(`scopes must include one of: ${SCOPES.join(', ')}`);
  return [...new Set(list)];
};

const eq = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createToken(userId, name, scopes, ttlSec, kind = 'pat', clientId) {
  const token = `cf_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  db.prepare('INSERT INTO access_tokens (id, user_id, name, kind, client_id, hash, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, userId || 'local', String(name || 'token').slice(0, 60), kind, clientId || null,
      sha(token), cleanScopes(scopes).join(' '), ttlSec ? now() + ttlSec * 1000 : null, now());
  return { id, token };
}

export function createClient(userId, name, scopes) {
  const clientId = `cfc_${randomBytes(9).toString('hex')}`;
  const secret = `cfs_${randomBytes(32).toString('base64url')}`;
  db.prepare('INSERT INTO oauth_clients (client_id, user_id, name, secret_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(clientId, userId || 'local', String(name || 'client').slice(0, 60), sha(secret), cleanScopes(scopes).join(' '), now());
  return { clientId, clientSecret: secret };
}

export function verifyBearer(header) {
  const tok = String(header || '').replace(/^Bearer\s+/i, '').trim();
  if (!tok) return null;
  const admin = process.env.MCP_ADMIN_TOKEN;
  if (admin && admin.length >= 24 && eq(tok, admin)) {
    return { userId: process.env.MCP_ADMIN_USER || 'local', scopes: [...SCOPES], via: 'env-admin-token' };
  }
  const row = db.prepare('SELECT id, user_id, name, scopes, expires_at FROM access_tokens WHERE hash = ?').get(sha(tok));
  if (!row || (row.expires_at && row.expires_at < now())) return null;
  db.prepare('UPDATE access_tokens SET last_used = ? WHERE id = ?').run(now(), row.id);
  return { userId: row.user_id, scopes: row.scopes.split(' '), via: row.name };
}

export const can = (p, scope) => p.scopes.includes('admin') || p.scopes.includes(scope);

const failures = new Map();
const throttled = ip => { const f = failures.get(ip); return !!f && f.n >= 10 && now() - f.t < 60_000; };
const fail = ip => { const f = failures.get(ip); failures.set(ip, { n: f && now() - f.t < 60_000 ? f.n + 1 : 1, t: now() }); };

export function installOAuthRoutes(app) {
  const issuer = req => process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;

  app.get('/.well-known/oauth-authorization-server', (req, res) => res.json({
    issuer: issuer(req),
    token_endpoint: `${issuer(req)}/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: [...SCOPES],
    response_types_supported: [],
  }));

  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json({
    resource: `${issuer(req)}/mcp`,
    authorization_servers: [issuer(req)],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
  }));

  app.post('/oauth/token', (req, res) => {
    const err = (code, error) => res.status(code).setHeader('Cache-Control', 'no-store').json({ error });
    if (throttled(req.ip)) return err(429, 'too_many_attempts');
    const b = req.body || {};
    if (b.grant_type !== 'client_credentials') return err(400, 'unsupported_grant_type');

    let id = b.client_id, secret = b.client_secret;
    const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (basic) {
      const [i, ...s] = Buffer.from(basic[1], 'base64').toString().split(':');
      id = decodeURIComponent(i);
      secret = decodeURIComponent(s.join(':'));
    }

    const c = id ? db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(String(id)) : null;
    if (!c || !secret || !eq(sha(String(secret)), c.secret_hash)) { fail(req.ip); return err(401, 'invalid_client'); }

    const allowed = c.scopes.split(' ');
    const asked = b.scope ? String(b.scope).split(/\s+/).filter(Boolean) : allowed;
    if (asked.some(s => !allowed.includes(s))) return err(400, 'invalid_scope');

    const { token } = createToken(c.user_id, `oauth:${c.name}`, asked, 3600, 'oauth', c.client_id);
    res.setHeader('Cache-Control', 'no-store').json({ access_token: token, token_type: 'Bearer', expires_in: 3600, scope: asked.join(' ') });
  });
}

export function installAccessRoutes(app) {
  const uid = () => 'local';

  app.get('/api/access', (_req, res) => res.json({
    tokens: db.prepare("SELECT id, name, kind, scopes, expires_at, created_at, last_used FROM access_tokens WHERE user_id = ? AND (kind = 'pat' OR expires_at > ?) ORDER BY created_at DESC").all(uid(), now()),
    clients: db.prepare('SELECT client_id, name, scopes, created_at FROM oauth_clients WHERE user_id = ? ORDER BY created_at DESC').all(uid()),
    envAdminToken: !!process.env.MCP_ADMIN_TOKEN,
  }));

  app.post('/api/access/tokens', (req, res) => {
    try {
      const b = req.body || {};
      res.json(createToken(uid(), b.name, b.scopes, b.ttlDays ? Math.min(Number(b.ttlDays), 365) * 86400 : undefined));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/access/clients', (req, res) => {
    try {
      const b = req.body || {};
      res.json(createClient(uid(), b.name, b.scopes));
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/access/tokens/:id', (req, res) => {
    res.json({ ok: Number(db.prepare('DELETE FROM access_tokens WHERE id = ? AND user_id = ?').run(req.params.id, uid()).changes) > 0 });
  });

  app.delete('/api/access/clients/:id', (req, res) => {
    const id = req.params.id;
    const r = db.prepare('DELETE FROM oauth_clients WHERE client_id = ? AND user_id = ?').run(id, uid());
    if (Number(r.changes)) db.prepare('DELETE FROM access_tokens WHERE client_id = ?').run(id);
    res.json({ ok: Number(r.changes) > 0 });
  });
}
