import { db } from '../db.js';

const now = () => Date.now();

const buckets = new Map();

const DEFAULT_RATE = { maxTokens: 60, refillPerSec: 1 };

export function getRateConfig(keyId) {
  const override = db.prepare('SELECT scopes FROM access_tokens WHERE id = ?').get(keyId);
  if (override && override.scopes.includes('admin')) return { maxTokens: 600, refillPerSec: 10 };
  return DEFAULT_RATE;
}

function getBucket(keyId) {
  if (buckets.has(keyId)) return buckets.get(keyId);
  const config = getRateConfig(keyId);
  const bucket = { tokens: config.maxTokens, lastRefill: now(), config };
  buckets.set(keyId, bucket);
  return bucket;
}

function refill(bucket) {
  const elapsed = (now() - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(bucket.config.maxTokens, bucket.tokens + elapsed * bucket.config.refillPerSec);
  bucket.lastRefill = now();
}

export function tryConsume(keyId) {
  const bucket = getBucket(keyId);
  refill(bucket);
  if (bucket.tokens < 1) {
    const waitSec = Math.ceil((1 - bucket.tokens) / bucket.config.refillPerSec);
    return { allowed: false, retryAfter: waitSec, remaining: 0, limit: bucket.config.maxTokens };
  }
  bucket.tokens -= 1;
  return { allowed: true, remaining: Math.floor(bucket.tokens), limit: bucket.config.maxTokens };
}

export function resetBucket(keyId) {
  buckets.delete(keyId);
}

export function bucketStatus(keyId) {
  const bucket = getBucket(keyId);
  refill(bucket);
  return { remaining: Math.floor(bucket.tokens), limit: bucket.config.maxTokens, refillPerSec: bucket.config.refillPerSec };
}

setInterval(() => {
  const cutoff = now() - 600_000;
  for (const [key, bucket] of buckets) {
    if (bucket.lastRefill < cutoff) buckets.delete(key);
  }
}, 300_000);
