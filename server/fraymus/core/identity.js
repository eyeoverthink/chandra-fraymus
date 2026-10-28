// Unified identity system — Ed25519 (Web Crypto API + pure BigInt fallback)
// Sources: v13.js (Web Crypto), fraymusMail.js (pure BigInt RFC 8032)
import { hex, unhex, sha256, sha256hex } from './crypto.js';

// ═══════════════════════════════════════════════════════════════
// Web Crypto Ed25519 (preferred when available)
// ═══════════════════════════════════════════════════════════════

export async function generateIdentity(name) {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pubkey = hex(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { name, pubkey, number: await numberFromPub(pubkey), priv };
}

export async function numberFromPub(pubHex) {
  const h = hex(await sha256(unhex(pubHex))).slice(0, 16);
  return 'fx-' + h.match(/.{4}/g).join('-');
}

export async function signText(identity, text) {
  const key = await crypto.subtle.importKey('jwk', identity.priv, { name: 'Ed25519' }, false, ['sign']);
  const sig = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(text));
  return hex(new Uint8Array(sig));
}

export async function verifyText(pubHex, text, sigHex) {
  const keyData = unhex(pubHex);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, unhex(sigHex), new TextEncoder().encode(text));
}

// ═══════════════════════════════════════════════════════════════
// Pure BigInt Ed25519 (RFC 8032) — runs anywhere, no Web Crypto needed
// Source: fraymusMail.js
// ═══════════════════════════════════════════════════════════════

const p = 2n ** 255n - 19n;
const q = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (a, m = p) => ((a % m) + m) % m;
const pw = (b, e, m = p) => {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; }
  return r;
};
const inv = (x) => pw(x, p - 2n);
const d = mod(-121665n * inv(121666n));
const I = pw(2n, (p - 1n) / 4n);

const ptAdd = (P, Q) => {
  const A = mod((P[1] - P[0]) * (Q[1] - Q[0])), B = mod((P[1] + P[0]) * (Q[1] + Q[0]));
  const C = mod(2n * P[3] * Q[3] * d), D = mod(2n * P[2] * Q[2]);
  const E = B - A, F = D - C, G = D + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
};
const ptMul = (s, P) => {
  let Q = [0n, 1n, 1n, 0n];
  while (s > 0n) { if (s & 1n) Q = ptAdd(Q, P); P = ptAdd(P, P); s >>= 1n; }
  return Q;
};
const ptEq = (P, Q) =>
  mod(P[0] * Q[2] - Q[0] * P[2]) === 0n && mod(P[1] * Q[2] - Q[1] * P[2]) === 0n;

const recoverX = (y, sign) => {
  if (y >= p) return null;
  const x2 = mod((y * y - 1n) * inv(d * y * y + 1n));
  if (x2 === 0n) return sign ? null : 0n;
  let x = pw(x2, (p + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * I);
  if (mod(x * x - x2) !== 0n) return null;
  if (Number(x & 1n) !== sign) x = p - x;
  return x;
};

const gy = mod(4n * inv(5n)), gx = recoverX(gy, 0), G = [gx, gy, 1n, mod(gx * gy)];
const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) + BigInt(b[i]); return n; };
const le32 = (n) => { const o = new Uint8Array(32); for (let i = 0; i < 32; i++) { o[i] = Number(n & 255n); n >>= 8n; } return o; };
const compress = (P) => { const zi = inv(P[2]); const x = mod(P[0] * zi), y = mod(P[1] * zi); return le32(y | ((x & 1n) << 255n)); };
const decompress = (b) => {
  if (b.length !== 32) return null;
  let y = le(b); const sign = Number(y >> 255n); y &= (1n << 255n) - 1n;
  const x = recoverX(y, sign); return x === null ? null : [x, y, 1n, mod(x * y)];
};

const cat = (...a) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0; for (const x of a) { o.set(x, i); i += x.length; }
  return o;
};
const sha = async (alg, b) => new Uint8Array(await crypto.subtle.digest(alg, b));

async function expand(secret) {
  const h = await sha('SHA-512', secret);
  let a = le(h.slice(0, 32)); a &= (1n << 254n) - 8n; a |= 1n << 254n;
  return [a, h.slice(32)];
}

// Pure BigInt operations
export async function purePublicKey(secretHex) {
  const [a] = await expand(unhex(secretHex));
  return hex(compress(ptMul(a, G)));
}

export async function pureSign(secretHex, msg) {
  const [a, prefix] = await expand(unhex(secretHex));
  const A = compress(ptMul(a, G));
  const r = le(await sha('SHA-512', cat(prefix, msg))) % q;
  const R = compress(ptMul(r, G));
  const k = le(await sha('SHA-512', cat(R, A, msg))) % q;
  return hex(cat(R, le32((r + k * a) % q)));
}

export async function pureVerify(pubHex, msg, sigHex) {
  const pub = unhex(pubHex), sig = unhex(sigHex);
  if (pub.length !== 32 || sig.length !== 64) return false;
  const A = decompress(pub), R = decompress(sig.slice(0, 32));
  if (!A || !R) return false;
  const s = le(sig.slice(32)); if (s >= q) return false;
  const h = le(await sha('SHA-512', cat(sig.slice(0, 32), pub, msg))) % q;
  return ptEq(ptMul(s, G), ptAdd(R, ptMul(h, A)));
}

export async function newPureIdentity(name) {
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  const pub = await purePublicKey(secret);
  const number = await numberFromPub(pub);
  return { name: String(name || 'me').slice(0, 64), secret, public: pub, number, created: Math.floor(Date.now() / 1000) };
}

export async function checkPureIdentity(id) {
  return !!id && /^[0-9a-f]{64}$/.test(id.secret || '')
    && (await purePublicKey(id.secret)) === id.public
    && (await numberFromPub(id.public)) === id.number;
}

// RFC 8032 §7.1 test vector
export async function selfTest() {
  const sk = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
  const pub = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
  const sig = 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
  return (await purePublicKey(sk)) === pub
    && (await pureSign(sk, new Uint8Array(0))) === sig
    && (await pureVerify(pub, new Uint8Array(0), sig));
}
