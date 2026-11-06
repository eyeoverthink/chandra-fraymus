import { createHash } from 'node:crypto';
import { createLogger } from '../observability/logger.js';

const log = createLogger('etag');

let etagHits = 0;
let etagMisses = 0;
let etagGenerated = 0;

function generateETag(body) {
  const hash = createHash('md5').update(body).digest('hex');
  return `"${hash.substring(0, 16)}"`;
}

export function etag() {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const origJson = res.json.bind(res);
    res.json = function (data) {
      const body = JSON.stringify(data);
      const tag = generateETag(body);
      etagGenerated++;

      res.setHeader('ETag', tag);
      res.setHeader('Cache-Control', 'no-cache');

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && ifNoneMatch === tag) {
        etagHits++;
        res.status(304).end();
        return res;
      }

      etagMisses++;
      return origJson.call(res, data);
    };

    next();
  };
}

export function getETagStats() {
  const total = etagHits + etagMisses;
  return {
    hits: etagHits,
    misses: etagMisses,
    generated: etagGenerated,
    hitRate: total > 0 ? Math.round((etagHits / total) * 1000) / 10 : 0,
    savedResponses: etagHits,
  };
}

export function installETagRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);

  app.get('/api/caching/etag', route((_req, res) => {
    res.json(getETagStats());
  }));
}
