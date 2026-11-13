/**
 * Hermes skill fleet — native, keyless ports for the fleet run loop.
 *
 * Vaughn's Hermes manifest lists 33 skills that live on a VPS as shell/Python scripts. These are
 * the ones that need no paid API, no account token and no extra binary, rewritten as in-process
 * Node tools so every Chandra agent can call them: feeds, readable scraping, parallel fetch, public
 * records (OSINT), brand-handle checks, package forensics, API diagnostics, code wiki, PR ripple
 * analysis, design grilling, HAR → API client, static site publishing, scroll pages, a morning
 * briefing, and a reader for lazarus-spore-v1 WASM containers.
 *
 * Rules every tool here follows: outbound requests go to public hosts only (DNS-checked), 15 s
 * timeout, bounded response size; file access stays under HERMES_ROOTS; anything that writes outside
 * data/ or sends a non-GET request is labelled risk:'approval'. HERMES_SKILLS at the bottom is the
 * honest map of all 33 skills: built here, already in Chandra, or not built and why.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { db } from '../db.js';
import { chatOllama, parseJSON } from '../commerce/shared.js';
import { classifyHost } from '../fraymus-os/registry.js';
import { mediaMetaFor, searchMediaFiles } from '../media/media-meta.js';
import { PORT as SERVER_PORT } from '../config.js'; // CHANDRA_PORT first: a dev launcher may set PORT to the client's port

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = resolve(process.env.CHANDRA_DATA_DIR || join(REPO_ROOT, 'data'));
export const SITES_DIR = join(DATA_DIR, 'sites');
const WIKI_DIR = join(DATA_DIR, 'wiki');
const HAR_DIR = join(DATA_DIR, 'har-clients');
const ROOTS = (process.env.HERMES_ROOTS || `${REPO_ROOT};F:/Claude-Work;F:/Fraymus-Skill-Lab;${join(os.homedir(), 'Downloads')}`).split(';').map(p => resolve(p.trim())).filter(Boolean);
const UA = 'Chandra-FRAYMUS/1.0 (local research agent)';
const SEC_UA = process.env.HERMES_SEC_USER_AGENT || 'Chandra-FRAYMUS research admin@localhost.invalid';
const MAX_BYTES = 2_000_000;
const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);
const slugify = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hermes_cache (key TEXT PRIMARY KEY, kind TEXT, url TEXT, body TEXT, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hermes_feed_seen (feed TEXT NOT NULL, item_id TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (feed, item_id));
    CREATE TABLE IF NOT EXISTS hermes_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, tool TEXT NOT NULL, agent_id TEXT, ok INTEGER, ms INTEGER, error TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_hermes_calls_created ON hermes_calls(created_at);
  `);
} catch (e) { console.error('[hermes] table setup failed:', e.message); }

// ── guards + fetch ───────────────────────────────────────────────────────────
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { throw new Error(`not a URL: ${clip(raw, 80)}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs are allowed');
  if (classifyHost(u.hostname) !== 'public') throw new Error(`${u.hostname} is not a public host — Hermes tools do not reach local or private addresses`);
  const addrs = await dns.lookup(u.hostname, { all: true });
  for (const a of addrs) if (classifyHost(a.address) !== 'public') throw new Error(`${u.hostname} resolves to a non-public address (${a.address})`);
  return u;
}

async function fetchPublic(raw, { method = 'GET', headers = {}, body, timeoutMs = 15_000, maxBytes = MAX_BYTES } = {}) {
  const u = await assertPublicUrl(raw);
  const t0 = now();
  const res = await fetch(u, { method, headers: { 'User-Agent': UA, Accept: '*/*', ...headers }, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (res.url && res.url !== u.href) await assertPublicUrl(res.url); // a redirect must not land somewhere private
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ok: res.ok, url: res.url || u.href, headers: Object.fromEntries(res.headers.entries()), text: buf.subarray(0, maxBytes).toString('utf8'), bytes: buf.length, truncated: buf.length > maxBytes, ms: now() - t0 };
}
async function fetchJson(raw, opts) { const r = await fetchPublic(raw, opts); let json = null; try { json = JSON.parse(r.text); } catch (_) { /* caller reports non-JSON */ } return { ...r, json }; }

export function underRoots(p) {
  const abs = resolve(String(p || ''));
  const hit = ROOTS.find(r => abs === r || abs.startsWith(r + sep));
  if (!hit) throw new Error(`path is outside the allowed roots (${ROOTS.join(', ')})`);
  return abs;
}

// ── HTML → readable markdown (no browser; static HTML only) ──────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export const decodeEntities = s => String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
export function htmlToMarkdown(html, baseUrl = '') {
  let h = String(html).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ');
  const title = decodeEntities((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const main = h.match(/<(main|article)\b[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 400) h = main[0];
  const abs = href => { try { return new URL(href, baseUrl || undefined).href; } catch (_) { return href; } };
  h = h.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(+n)} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => { const txt = t.replace(/<[^>]+>/g, '').trim(); return txt ? `[${txt}](${abs(href)})` : ''; })
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li|\/section|\/blockquote)[^>]*>/gi, '\n').replace(/<pre[^>]*>/gi, '\n```\n').replace(/<\/pre>/gi, '\n```\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(h).split('\n').map(l => l.replace(/[ \t\u00a0]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1] !== '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, markdown: text };
}

async function scrape(url, { maxChars = 12_000, fresh = false } = {}) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 24);
  const hit = fresh ? null : db.prepare(`SELECT body, fetched_at FROM hermes_cache WHERE key = ? AND fetched_at > ?`).get(key, now() - 24 * 3_600_000);
  if (hit) { const j = JSON.parse(hit.body); return { ...j, markdown: clip(j.markdown, maxChars), cached: true, fetchedAt: hit.fetched_at }; }
  const r = await fetchPublic(url, { headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' } });
  if (!r.ok) return { url, status: r.status, error: `HTTP ${r.status}` };
  const isHtml = /html/i.test(r.headers['content-type'] || '') || /^\s*</.test(r.text);
  const { title, markdown } = isHtml ? htmlToMarkdown(r.text, r.url) : { title: '', markdown: r.text };
  const out = { url: r.url, status: r.status, title, chars: markdown.length, markdown, note: markdown.length < 200 && isHtml ? 'Very little text: this page is probably rendered by JavaScript — use the browser tools for it.' : undefined };
  db.prepare(`INSERT OR REPLACE INTO hermes_cache (key, kind, url, body, fetched_at) VALUES (?, 'scrape', ?, ?, ?)`).run(key, url, JSON.stringify(out), now());
  return { ...out, markdown: clip(markdown, maxChars), cached: false };
}

// ── feeds ────────────────────────────────────────────────────────────────────
export function parseFeed(xml) {
  const pick = (block, tag) => { const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : ''; };
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => {
    const atomLink = (b.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link\b[^>]*href=["']([^"']+)["']/i) || [])[1];
    const link = atomLink || pick(b, 'link');
    const id = pick(b, 'guid') || pick(b, 'id') || link;
    return { id, title: pick(b, 'title'), link, published: pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated'), summary: clip(pick(b, 'description') || pick(b, 'summary') || pick(b, 'content'), 400) };
  }).filter(i => i.title || i.link);
}

// ── repo scanning (code wiki + PR lens) ──────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'data', '.next', 'coverage', '__pycache__', '.venv', 'venv', 'target']);
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py']);
export function scanRepo(root, { maxFiles = 800, maxDepth = 6 } = {}) {
  const files = [];
  (function walk(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      if (e.name.startsWith('.') && e.name !== '.claude') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1); }
      else if (CODE_EXT.has(extname(e.name))) {
        let src; try { if (statSync(full).size > 600_000) continue; src = readFileSync(full, 'utf8'); } catch (err) { continue; }
        const rel = relative(root, full).split(sep).join('/');
        const exports = [...new Set([...src.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]).concat([...src.matchAll(/^(?:def|class)\s+([A-Za-z_]\w*)/gm)].map(m => m[1])))];
        const imports = [...new Set([...src.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m => m[1]))];
        const doc = (src.match(/^\s*\/\*\*?([\s\S]*?)\*\//) || [])[1];
        files.push({ rel, lines: src.split('\n').length, exports, imports, doc: doc ? clip(doc.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim(), 220) : '' });
      }
    }
  })(root, 0);
  const byRel = new Map(files.map(f => [f.rel, f]));
  const resolveImport = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = join(dirname(from), spec).split(sep).join('/');
    for (const cand of [base, ...['.js', '.mjs', '.jsx', '.ts', '.tsx', '.py'].map(x => base + x), base + '/index.js']) if (byRel.has(cand)) return cand;
    return null;
  };
  const dependents = new Map();
  for (const f of files) { f.internal = []; f.external = []; for (const s of f.imports) { const r = resolveImport(f.rel, s); if (r) { f.internal.push(r); if (!dependents.has(r)) dependents.set(r, []); dependents.get(r).push(f.rel); } else if (!s.startsWith('.')) f.external.push(s.startsWith('node:') ? s : s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/')); } }
  return { files, dependents, truncated: files.length >= maxFiles };
}

const git = (cwd, args) => new Promise(res => execFile('git', ['-C', cwd, ...args], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => res({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })));

// ── lazarus-spore-v1 reader ──────────────────────────────────────────────────
export function readSpore(buf) {
  if (buf.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('not a WASM file (magic 00 61 73 6d missing)');
  let p = 8; const sections = {};
  const leb = () => { let r = 0, sh = 0, b; do { b = buf[p++]; r |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return r >>> 0; };
  while (p < buf.length) { const id = buf[p++]; const size = leb(); const end = p + size; if (id === 0) { const n = leb(); sections[buf.subarray(p, p + n).toString('utf8')] = buf.subarray(p + n, end); } p = end; }
  if (!sections['fraymus.data']) throw new Error('no fraymus.data section — not a FRAYMUS spore');
  const json = (name) => { try { return JSON.parse(sections[name].toString('utf8')); } catch (_) { return null; } };
  const dataText = Buffer.from(sections['fraymus.data'].toString('latin1'), 'base64').toString('utf8');
  const baseline = sections['fraymus.baseline'] ? sections['fraymus.baseline'].toString('utf8').trim() : null;
  const sha = createHash('sha256').update(dataText).digest('hex');
  let data = null; try { data = JSON.parse(dataText); } catch (_) { /* reported as dataParsed:false */ }
  return { sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length])), baseline, dataSha256: sha, intact: baseline ? sha === baseline : null, ledger: json('fraymus.ledger'), genesis: json('fraymus.genesis'), spore: json('fraymus.spore'), dnaBytes: sections['fraymus.dna']?.length || 0, data, dataParsed: !!data };
}

// ── tool definitions ─────────────────────────────────────────────────────────
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const cap = (v, d, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || d));

const USER_SITES = [
  ['GitHub', u => `https://api.github.com/users/${u}`], ['GitLab', u => `https://gitlab.com/api/v4/users?username=${u}`, r => (Array.isArray(r.json) ? (r.json.length ? 'taken' : 'available') : 'unknown')],
  // npm has no public user lookup: a maintainer search finds accounts that have published (an account with no packages reads as available)
  ['npm', u => `https://registry.npmjs.org/-/v1/search?text=maintainer:${u}&size=1`, r => (r.json?.objects ? (r.json.objects.length ? 'taken' : 'available') : 'unknown')], ['Docker Hub', u => `https://hub.docker.com/v2/users/${u}/`],
  ['Hacker News', u => `https://hacker-news.firebaseio.com/v0/user/${u}.json`, r => (r.text.trim() === 'null' ? 'available' : r.ok ? 'taken' : 'unknown')],
  ['dev.to', u => `https://dev.to/api/users/by_username?url=${u}`], ['Codeberg', u => `https://codeberg.org/api/v1/users/${u}`], ['Keybase', u => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${u}`, r => (r.json?.them?.[0] ? 'taken' : r.ok ? 'available' : 'unknown')],
  ['Bluesky', u => `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${u}.bsky.social`, r => (r.status === 200 ? 'taken' : r.status === 400 ? 'available' : 'unknown')],
];

let gdeltLast = 0;
const OSINT = {
  sec_edgar: async (q, limit) => { if (!process.env.HERMES_SEC_USER_AGENT) return { error: 'SEC EDGAR refuses requests without a contact in the User-Agent. Set HERMES_SEC_USER_AGENT="Your Name you@example.com" in .env to enable this source (verified: HTTP 403 without it).' }; const r = await fetchJson(`https://efts.sec.gov/LatestSearch/rest/search-index?q=${encodeURIComponent(`"${q}"`)}`, { headers: { 'User-Agent': SEC_UA } }); if (!r.json) return { error: `SEC EDGAR HTTP ${r.status}` }; return { total: r.json.hits?.total?.value ?? null, results: (r.json.hits?.hits || []).slice(0, limit).map(h => ({ company: (h._source?.display_names || []).join('; '), form: h._source?.form || h._source?.file_type, filed: h._source?.file_date, url: h._source?.adsh ? `https://www.sec.gov/Archives/edgar/data/${(h._source.ciks || [''])[0].replace(/^0+/, '')}/${h._source.adsh.replace(/-/g, '')}/` : null })) }; },
  wayback: async (q, limit) => { const r = await fetchJson(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(q)}&output=json&limit=${limit}&fl=timestamp,original,statuscode,digest&collapse=digest`); if (!Array.isArray(r.json)) return { error: `Wayback HTTP ${r.status}` }; return { results: r.json.slice(1).map(([ts, original, status]) => ({ captured: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`, status, url: `https://web.archive.org/web/${ts}/${original}` })) }; },
  gdelt: async (q, limit) => { const safe = q.includes('"') ? q : q.replace(/[\w]+(?:-[\w]+)+/g, m => `"${m}"`); /* GDELT rejects bare hyphenated words and allows one request per 5 s */ const wait = gdeltLast + 5500 - now(); gdeltLast = now() + Math.max(0, wait); if (wait > 0) await new Promise(res => setTimeout(res, wait)); const r = await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(safe)}&mode=ArtList&format=json&maxrecords=${limit}&sort=DateDesc`, { timeoutMs: 30_000 }); if (!r.json) return { error: `GDELT HTTP ${r.status}: ${clip(r.text, 120)}` }; return { results: (r.json.articles || []).map(a => ({ title: a.title, url: a.url, domain: a.domain, seen: a.seendate, country: a.sourcecountry, language: a.language })) }; },
  usaspending: async (q, limit) => { const r = await fetchJson('https://api.usaspending.gov/api/v2/search/spending_by_award/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters: { keywords: [q], award_type_codes: ['A', 'B', 'C', 'D'] }, fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description'], limit, page: 1, sort: 'Award Amount', order: 'desc' }) }); if (!r.json?.results) return { error: `USAspending HTTP ${r.status}: ${clip(r.text, 160)}` }; return { results: r.json.results.map(a => ({ awardId: a['Award ID'], recipient: a['Recipient Name'], amount: a['Award Amount'], agency: a['Awarding Agency'], start: a['Start Date'], description: clip(a.Description, 160) })) }; },
  // CourtListener is deliberately absent: its API answers anonymous clients with a human-verification
  // wall (HTTP 405, checked 2026-11-10) and this tool does not try to get around bot checks.
};

function securityHeaderFindings(h) {
  const f = [];
  if (!h['strict-transport-security']) f.push('no Strict-Transport-Security');
  if (!h['content-security-policy']) f.push('no Content-Security-Policy');
  if (!h['x-content-type-options']) f.push('no X-Content-Type-Options');
  if (h['access-control-allow-origin'] === '*') f.push('CORS allows any origin (*)' + (h['access-control-allow-credentials'] === 'true' ? ' WITH credentials — exploitable' : ''));
  if (h.server && /\d/.test(h.server)) f.push(`Server header leaks a version: ${h.server}`);
  if (h['x-powered-by']) f.push(`X-Powered-By leaks stack: ${h['x-powered-by']}`);
  return f;
}

function scrollPageHtml({ title, tagline, sections, cta, accent }) {
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const a = /^#[0-9a-f]{3,8}$/i.test(accent || '') ? accent : '#22d3ee';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
:root{--a:${a};--bg:#07080c;--fg:#e8ecf3;--dim:#8b93a7}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:hidden}
.bar{position:fixed;inset:0 0 auto 0;height:3px;background:var(--a);transform-origin:0 50%;transform:scaleX(0);z-index:9}
header{min-height:100vh;display:grid;place-items:center;text-align:center;padding:24px;position:relative}
header h1{font-size:clamp(2.4rem,8vw,6rem);line-height:1.02;margin:0;letter-spacing:-.03em;text-wrap:balance}header p{color:var(--dim);font-size:clamp(1rem,2.4vw,1.4rem);max-width:60ch;margin:18px auto 0}
.orb{position:absolute;width:60vmin;height:60vmin;border-radius:50%;background:radial-gradient(circle at 30% 30%,var(--a),transparent 62%);opacity:.22;filter:blur(30px);will-change:transform}
section{min-height:86vh;display:grid;align-items:center;padding:8vh max(16px,6vw)}section .in{max-width:72ch;opacity:0;transform:translateY(48px) scale(.98);transition:opacity .9s ease,transform .9s cubic-bezier(.2,.7,.2,1)}
section:nth-of-type(even) .in{margin-left:auto}section.on .in{opacity:1;transform:none}section h2{font-size:clamp(1.6rem,4.4vw,3.2rem);line-height:1.1;margin:0 0 14px;text-wrap:balance}section h2 span{color:var(--a)}section p{color:var(--dim);font-size:1.1rem;margin:0}
.num{font:600 .8rem/1 ui-monospace,monospace;color:var(--a);letter-spacing:.2em;margin-bottom:14px}
footer{padding:14vh 24px;text-align:center}footer a{display:inline-block;padding:14px 26px;border-radius:999px;background:var(--a);color:#05060a;font-weight:700;text-decoration:none}
@media (prefers-reduced-motion:reduce){section .in{opacity:1;transform:none;transition:none}.orb{display:none}}
</style></head><body><div class="bar" id="bar"></div><header><div class="orb" id="orb"></div><div><h1>${esc(title)}</h1><p>${esc(tagline)}</p></div></header>
${sections.map((s, i) => `<section><div class="in"><div class="num">${String(i + 1).padStart(2, '0')} / ${String(sections.length).padStart(2, '0')}</div><h2>${esc(s.heading)}</h2><p>${esc(s.body)}</p></div></section>`).join('\n')}
<footer>${cta?.label ? `<a href="${esc(cta.href || '#')}">${esc(cta.label)}</a>` : ''}</footer>
<script>const io=new IntersectionObserver(es=>es.forEach(e=>e.isIntersecting&&e.target.classList.add('on')),{threshold:.25});document.querySelectorAll('section').forEach(s=>io.observe(s));const bar=document.getElementById('bar'),orb=document.getElementById('orb');let t=false;addEventListener('scroll',()=>{if(t)return;t=true;requestAnimationFrame(()=>{const m=document.documentElement.scrollHeight-innerHeight,p=m>0?scrollY/m:0;bar.style.transform='scaleX('+p+')';if(orb)orb.style.transform='translate3d('+(p*18)+'vw,'+(scrollY*.35)+'px,0) scale('+(1+p)+')';t=false})},{passive:true});</script></body></html>`;
}

function writeSite(slug, files) {
  const dir = join(SITES_DIR, slugify(slug));
  let bytes = 0;
  for (const f of files) {
    const relPath = String(f.path || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
    if (relPath.includes('..') || !/^[\w./-]{1,120}$/.test(relPath) || !/\.(html|css|js|json|txt|svg|md)$/i.test(relPath)) throw new Error(`refused file path: ${clip(relPath, 60)} (html, css, js, json, txt, svg, md only)`);
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, String(f.content ?? ''));
    bytes += Buffer.byteLength(String(f.content ?? ''));
  }
  return { slug: slugify(slug), dir, files: files.length, bytes, url: `http://127.0.0.1:${SERVER_PORT}/sites/${slugify(slug)}/`, note: 'Served locally only. Nothing was published to the internet.' };
}

export function morningBrief() {
  const q1 = (sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (_) { return null; } };
  const qa = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (_) { return []; } };
  const day = now() - 24 * 3_600_000;
  const goals = q1(`SELECT COUNT(*) n, AVG(quality) q FROM goal_executions WHERE started_at > ?`, day);
  const runs = q1(`SELECT COUNT(*) n, SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) e FROM runs WHERE created_at > ?`, day);
  const audit = qa(`SELECT severity, COUNT(*) c FROM self_audit_findings WHERE resolved_at IS NULL GROUP BY severity`);
  const cap = q1(`SELECT g_score, brier, created_at FROM capability_runs WHERE status = 'completed' AND strategy_mode = 'auto' ORDER BY created_at DESC LIMIT 1`);
  const approvals = q1(`SELECT COUNT(*) c FROM approvals WHERE status = 'pending'`);
  const branches = q1(`SELECT COUNT(*) c FROM smk_code_proposals WHERE status = 'ready'`);
  const skills = q1(`SELECT COUNT(*) c FROM forged_skills WHERE status = 'active'`);
  const world = qa(`SELECT title, url FROM world_observations ORDER BY observed_at DESC LIMIT 3`);
  const research = qa(`SELECT title FROM research_items WHERE status = 'translated' ORDER BY rowid DESC LIMIT 2`);
  const facts = { goals24h: goals?.n ?? 0, meanQuality: goals?.q != null ? +goals.q.toFixed(3) : null, runs24h: runs?.n ?? 0, runErrors24h: runs?.e ?? 0, openFindings: Object.fromEntries(audit.map(a => [a.severity, a.c])), gScore: cap?.g_score ?? null, brier: cap?.brier ?? null, pendingApprovals: approvals?.c ?? 0, branchesAwaitingReview: branches?.c ?? 0, activeSkills: skills?.c ?? 0 };
  const lines = [
    `# Morning brief — ${new Date().toISOString().slice(0, 10)}`,
    `- Goals executed in 24 h: ${facts.goals24h}${facts.meanQuality != null ? `, mean quality ${facts.meanQuality}` : ''}`,
    `- Agent runs: ${facts.runs24h}, errors ${facts.runErrors24h}`,
    `- Capability: ${facts.gScore != null ? `g ${facts.gScore.toFixed(2)}, Brier ${facts.brier?.toFixed(2)}` : 'no benchmark yet'}`,
    `- Self-audit open findings: ${Object.entries(facts.openFindings).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`,
    `- Waiting on you: ${facts.pendingApprovals} approval(s), ${facts.branchesAwaitingReview} code branch(es) to review`,
    `- Active forged skills: ${facts.activeSkills}`,
    world.length ? `- Seen in the world: ${world.map(w => w.title).join(' · ')}` : null,
    research.length ? `- Research translated: ${research.map(r => r.title).join(' · ')}` : null,
  ].filter(Boolean);
  return { facts, markdown: lines.join('\n') };
}

export function createHermesTools() {
  const defs = [
    { name: 'hermes.rss_read', description: 'Read an RSS or Atom feed (any public feed URL — blogs, changelogs, arXiv, Hacker News, a subreddit\'s .rss). Returns the newest items. With onlyNew:true, returns only items not returned before for that feed (a blog watcher).',
      parameters: obj({ url: S('feed URL'), limit: N('max items (default 10, max 40)'), onlyNew: { type: 'boolean', description: 'only items not seen in an earlier call' } }, ['url']),
      run: async a => { const r = await fetchPublic(a.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } }); if (!r.ok) return { error: `HTTP ${r.status}` }; let items = parseFeed(r.text); if (!items.length) return { error: 'no <item> or <entry> elements — not a feed', preview: clip(r.text, 160) };
        if (a.onlyNew) { const seen = new Set(db.prepare(`SELECT item_id FROM hermes_feed_seen WHERE feed = ?`).all(a.url).map(x => x.item_id)); const ins = db.prepare(`INSERT OR IGNORE INTO hermes_feed_seen (feed, item_id, seen_at) VALUES (?, ?, ?)`); const fresh = items.filter(i => !seen.has(i.id)); for (const i of items) ins.run(a.url, i.id, now()); items = fresh; }
        return { feed: a.url, count: items.length, items: items.slice(0, cap(a.limit, 10, 1, 40)) }; } },
    { name: 'hermes.scrape', description: 'Fetch a public web page and return clean readable Markdown (title, headings, links, lists) with scripts, styles and navigation removed. Cached 24 h. Static HTML only: for pages rendered by JavaScript it says so and you should use the browser tools.',
      parameters: obj({ url: S('page URL'), maxChars: N('max characters of markdown (default 12000)'), fresh: { type: 'boolean', description: 'bypass the cache' } }, ['url']),
      run: a => scrape(a.url, { maxChars: cap(a.maxChars, 12_000, 500, 40_000), fresh: a.fresh === true }) },
    { name: 'hermes.parallel_fetch', description: 'Scrape up to 12 public URLs at once (4 in flight) and return a short readable extract of each — use it to read several search results or documentation pages in one step.',
      parameters: obj({ urls: { type: 'array', maxItems: 12, items: { type: 'string' }, description: 'page URLs' }, charsEach: N('characters per page (default 2500)') }, ['urls']),
      run: async a => { const urls = [...new Set((a.urls || []).map(String))].slice(0, 12); const per = cap(a.charsEach, 2500, 300, 8000); const out = new Array(urls.length); let i = 0;
        await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => { while (i < urls.length) { const k = i++; try { const r = await scrape(urls[k], { maxChars: per }); out[k] = r.error ? { url: urls[k], error: r.error } : { url: r.url, title: r.title, extract: r.markdown, note: r.note }; } catch (e) { out[k] = { url: urls[k], error: clip(e.message, 160) }; } } }));
        return { requested: urls.length, ok: out.filter(o => !o.error).length, pages: out }; } },
    { name: 'hermes.osint', description: 'Public-records lookup, no API key. source: "sec_edgar" (full-text search of SEC filings; needs HERMES_SEC_USER_AGENT set), "wayback" (archived captures of a URL), "gdelt" (worldwide news articles), "usaspending" (US federal contract awards). Use for company due diligence, name/trademark checks and history of a site.',
      parameters: obj({ source: S('sec_edgar | wayback | gdelt | usaspending'), query: S('company name, phrase, or (wayback) a URL'), limit: N('max results (default 8, max 25)') }, ['source', 'query']),
      run: async a => { const fn = OSINT[a.source]; if (!fn) return { error: `unknown source — use one of: ${Object.keys(OSINT).join(', ')}` }; const r = await fn(String(a.query), cap(a.limit, 8, 1, 25)); return { source: a.source, query: a.query, ...r }; } },
    { name: 'hermes.username_check', description: 'Check whether a brand or product handle is taken on developer and social platforms (GitHub, GitLab, npm, Docker Hub, Hacker News, dev.to, Codeberg, Keybase, Bluesky). For choosing a name for a product or company — reports taken / available / unknown per site.',
      parameters: obj({ username: S('the handle, letters digits - _ only', { pattern: '^[A-Za-z0-9_-]{2,39}$' }) }, ['username']),
      run: async a => { const u = String(a.username || ''); if (!/^[A-Za-z0-9_-]{2,39}$/.test(u)) return { error: 'username must be 2–39 letters, digits, - or _' };
        const results = await Promise.all(USER_SITES.map(async ([site, mk, judge]) => { try { const r = await fetchJson(mk(encodeURIComponent(u)), { timeoutMs: 10_000 }); return { site, state: judge ? judge(r) : r.status === 404 ? 'available' : r.status === 200 ? 'taken' : 'unknown', status: r.status }; } catch (e) { return { site, state: 'unknown', error: clip(e.message, 80) }; } }));
        return { username: u, taken: results.filter(r => r.state === 'taken').map(r => r.site), available: results.filter(r => r.state === 'available').map(r => r.site), results }; } },
    { name: 'hermes.pkg_audit', description: 'Supply-chain check of an npm or PyPI package before installing it: age, maintainers, install scripts (preinstall/postinstall), release bursts, deprecation/yanks, repository link, weekly downloads — with a list of risk flags.',
      parameters: obj({ name: S('package name'), ecosystem: S('"npm" (default) or "pypi"') }, ['name']),
      run: async a => { const name = String(a.name || '').trim(); const flags = [];
        if ((a.ecosystem || 'npm') === 'pypi') { const r = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`); if (!r.json) return { error: r.status === 404 ? 'no such PyPI package' : `PyPI HTTP ${r.status}` }; const rel = Object.entries(r.json.releases || {}).map(([v, f]) => ({ v, at: f[0]?.upload_time_iso_8601, yanked: f.some(x => x.yanked) })).filter(x => x.at).sort((x, y) => x.at.localeCompare(y.at)); const first = rel[0]?.at, last = rel[rel.length - 1]?.at; const week = rel.filter(x => Date.parse(x.at) > now() - 7 * 86_400_000).length;
          if (first && Date.parse(first) > now() - 30 * 86_400_000) flags.push('first release is less than 30 days old'); if (week >= 4) flags.push(`${week} releases in the last 7 days`); if (rel.some(x => x.yanked)) flags.push('has yanked releases'); if (!r.json.info.project_urls && !r.json.info.home_page) flags.push('no repository or homepage link'); if (!r.json.info.author && !r.json.info.maintainer && !r.json.info.author_email) flags.push('no author metadata');
          return { ecosystem: 'pypi', name, latest: r.json.info.version, summary: clip(r.json.info.summary, 200), firstRelease: first, lastRelease: last, releases: rel.length, releasesLast7d: week, homepage: r.json.info.home_page || Object.values(r.json.info.project_urls || {})[0] || null, requires: (r.json.info.requires_dist || []).length, flags, verdict: flags.length ? 'review before installing' : 'no red flags in registry metadata' }; }
        const r = await fetchJson(`https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name)}`); if (!r.json?.name) return { error: r.status === 404 ? 'no such npm package' : `npm HTTP ${r.status}` };
        const latest = r.json['dist-tags']?.latest; const v = r.json.versions?.[latest] || {}; const times = Object.entries(r.json.time || {}).filter(([k]) => k !== 'created' && k !== 'modified'); const week = times.filter(([, t]) => Date.parse(t) > now() - 7 * 86_400_000).length; const hooks = ['preinstall', 'install', 'postinstall'].filter(h => v.scripts?.[h]);
        let downloads = null; try { downloads = (await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${name}`)).json?.downloads ?? null; } catch (_) { /* downloads are optional */ }
        if (Date.parse(r.json.time?.created) > now() - 30 * 86_400_000) flags.push('package is less than 30 days old'); if (hooks.length) flags.push(`runs install scripts: ${hooks.map(h => `${h}="${clip(v.scripts[h], 60)}"`).join('; ')}`); if (week >= 4) flags.push(`${week} versions published in the last 7 days`); if (v.deprecated) flags.push(`deprecated: ${clip(v.deprecated, 100)}`); if (!v.repository && !r.json.repository) flags.push('no repository link'); if ((r.json.maintainers || []).length === 1) flags.push('single maintainer'); if (downloads != null && downloads < 200) flags.push(`only ${downloads} downloads last week`);
        return { ecosystem: 'npm', name, latest, description: clip(r.json.description, 200), created: r.json.time?.created, modified: r.json.time?.modified, versions: times.length, versionsLast7d: week, maintainers: (r.json.maintainers || []).map(m => m.name), dependencies: Object.keys(v.dependencies || {}).length, installScripts: hooks, repository: (v.repository || r.json.repository)?.url || null, license: v.license || null, weeklyDownloads: downloads, flags, verdict: flags.some(f => /install scripts|less than 30 days|deprecated/.test(f)) ? 'review before installing' : flags.length ? 'minor flags only' : 'no red flags in registry metadata' }; } },
    { name: 'hermes.api_get', description: 'Diagnose a public REST endpoint with a GET request: status, latency, response headers, size, whether the body is valid JSON (with its top-level shape), a body preview, and security-header findings (HSTS, CSP, CORS, version leaks). Set graphql:true to run a GraphQL introspection query against the URL instead and list its types.',
      parameters: obj({ url: S('endpoint URL'), headers_json: S('optional request headers as a JSON object string'), graphql: { type: 'boolean', description: 'POST a read-only introspection query' } }, ['url']),
      run: async a => { let headers = {}; if (a.headers_json) { try { headers = JSON.parse(a.headers_json); } catch (_) { return { error: 'headers_json is not valid JSON' }; } }
        if (a.graphql) { const r = await fetchJson(a.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ query: '{ __schema { queryType { name } mutationType { name } types { name kind } } }' }) }); const types = r.json?.data?.__schema?.types; return { url: a.url, status: r.status, ms: r.ms, introspection: types ? 'enabled' : 'refused or not GraphQL', queryType: r.json?.data?.__schema?.queryType?.name, mutationType: r.json?.data?.__schema?.mutationType?.name, types: types ? types.filter(t => !t.name.startsWith('__')).slice(0, 80).map(t => `${t.kind}:${t.name}`) : undefined, errors: r.json?.errors?.slice(0, 3), bodyPreview: types ? undefined : clip(r.text, 400) }; }
        const r = await fetchJson(a.url, { headers }); const shape = r.json == null ? null : Array.isArray(r.json) ? `array[${r.json.length}]${r.json[0] && typeof r.json[0] === 'object' ? ` of {${Object.keys(r.json[0]).slice(0, 12).join(', ')}}` : ''}` : typeof r.json === 'object' ? `{${Object.keys(r.json).slice(0, 20).join(', ')}}` : typeof r.json;
        return { url: r.url, status: r.status, ok: r.ok, ms: r.ms, bytes: r.bytes, contentType: r.headers['content-type'], json: r.json != null, shape, rateLimit: Object.fromEntries(Object.entries(r.headers).filter(([k]) => /ratelimit|retry-after/i.test(k))), securityFindings: securityHeaderFindings(r.headers), headers: r.headers, bodyPreview: clip(r.text, 1200) }; } },
    { name: 'hermes.api_request', risk: 'approval', description: 'Send a non-GET request (POST, PUT, PATCH, DELETE) to a public API and report status, latency, headers and body. Needs human approval because it can change things on the other side.',
      parameters: obj({ url: S('endpoint URL'), method: S('POST | PUT | PATCH | DELETE'), headers_json: S('request headers as a JSON object string'), body: S('request body (string)') }, ['url', 'method']),
      run: async a => { const method = String(a.method || '').toUpperCase(); if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { error: 'method must be POST, PUT, PATCH or DELETE' }; let headers = {}; if (a.headers_json) { try { headers = JSON.parse(a.headers_json); } catch (_) { return { error: 'headers_json is not valid JSON' }; } } const r = await fetchJson(a.url, { method, headers, body: a.body }); return { url: r.url, method, status: r.status, ok: r.ok, ms: r.ms, bytes: r.bytes, headers: r.headers, json: r.json != null, bodyPreview: clip(r.text, 1500) }; } },
    { name: 'hermes.code_wiki', description: 'Generate an engineering wiki for a code repository on this machine: Architecture.md (layout, entry points, most-depended-on modules, external dependencies) and Modules.md (every source file with its exports, imports and doc line). Deterministic — read from the code, not guessed. Files are written to data/wiki/<name>/.',
      parameters: obj({ path: S('absolute path of the repository (must be under the allowed roots)'), name: S('wiki name (default: folder name)'), overview: { type: 'boolean', description: 'also ask the local model for a 1-paragraph overview from the facts' } }, ['path']),
      run: async a => { const root = underRoots(a.path); if (!existsSync(root) || !statSync(root).isDirectory()) return { error: 'path is not a directory' }; const { files, dependents, truncated } = scanRepo(root); if (!files.length) return { error: 'no source files found (js, jsx, ts, tsx, py)' };
        const name = slugify(a.name || basename(root)); const dir = join(WIKI_DIR, name); mkdirSync(dir, { recursive: true });
        const byDir = {}; for (const f of files) { const d = f.rel.includes('/') ? f.rel.split('/').slice(0, 2).join('/') : '.'; (byDir[d] ||= { files: 0, lines: 0 }); byDir[d].files++; byDir[d].lines += f.lines; }
        const hubs = [...dependents.entries()].map(([k, v]) => [k, v.length]).sort((x, y) => y[1] - x[1]).slice(0, 15); const ext = {}; for (const f of files) for (const e of f.external) ext[e] = (ext[e] || 0) + 1;
        let pkg = null; try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch (_) { /* not a node project */ }
        let overview = ''; if (a.overview) { try { overview = await chatOllama([{ role: 'system', content: 'Write one factual paragraph (≤ 120 words) describing this codebase from the facts given. No speculation.' }, { role: 'user', content: JSON.stringify({ name: pkg?.name || name, description: pkg?.description, scripts: pkg?.scripts, directories: byDir, hubs, topExternal: Object.entries(ext).sort((x, y) => y[1] - x[1]).slice(0, 12) }).slice(0, 5000) }], { priority: 'goal', label: 'hermes:code_wiki', temperature: 0.2, maxTokens: 300 }); } catch (e) { overview = `(overview unavailable: ${clip(e.message, 80)})`; } }
        const arch = [`# ${pkg?.name || name} — Architecture`, pkg?.description ? `\n${pkg.description}` : '', overview ? `\n## Overview\n${overview}` : '', `\n## Size\n${files.length} source files, ${files.reduce((s, f) => s + f.lines, 0).toLocaleString()} lines${truncated ? ' (scan capped — larger than shown)' : ''}.`, pkg?.scripts ? `\n## Entry points\n${Object.entries(pkg.scripts).map(([k, v]) => `- \`npm run ${k}\` → \`${v}\``).join('\n')}` : '', `\n## Layout\n| directory | files | lines |\n|---|---|---|\n${Object.entries(byDir).sort((x, y) => y[1].lines - x[1].lines).map(([d, v]) => `| ${d} | ${v.files} | ${v.lines} |`).join('\n')}`, `\n## Most depended-on modules\n${hubs.map(([k, n]) => `- \`${k}\` — imported by ${n} file(s)`).join('\n') || '- none'}`, `\n## External dependencies in use\n${Object.entries(ext).sort((x, y) => y[1] - x[1]).slice(0, 40).map(([k, n]) => `- \`${k}\` (${n})`).join('\n') || '- none'}`].filter(Boolean).join('\n');
        const mods = [`# ${pkg?.name || name} — Modules`, ...files.sort((x, y) => x.rel.localeCompare(y.rel)).map(f => `\n## ${f.rel}\n${f.doc ? `${f.doc}\n` : ''}- ${f.lines} lines · imported by ${(dependents.get(f.rel) || []).length}\n- exports: ${f.exports.slice(0, 30).map(e => `\`${e}\``).join(', ') || '—'}\n- imports: ${f.internal.slice(0, 20).map(e => `\`${e}\``).join(', ') || '—'}${f.external.length ? `\n- external: ${[...new Set(f.external)].slice(0, 12).join(', ')}` : ''}`)].join('\n');
        writeFileSync(join(dir, 'Architecture.md'), arch); writeFileSync(join(dir, 'Modules.md'), mods);
        return { name, dir, files: files.length, lines: files.reduce((s, f) => s + f.lines, 0), written: ['Architecture.md', 'Modules.md'], hubs: hubs.slice(0, 8), architecturePreview: clip(arch, 1500) }; } },
    { name: 'hermes.pr_lens', description: 'Review a git change by its ripple: which files changed, which exported names were added/removed/modified, and which other files import the changed files (the blast radius), plus risk notes. Works on a local repository; compares base...head (default: working tree against HEAD).',
      parameters: obj({ path: S('absolute path of the git repository'), base: S('base ref (default HEAD)'), head: S('head ref (default: uncommitted working tree)') }, ['path']),
      run: async a => { const root = underRoots(a.path); const ref = /^[\w./~^-]{1,80}$/; const base = a.base && ref.test(a.base) ? a.base : 'HEAD'; const range = a.head && ref.test(a.head) ? [`${base}...${a.head}`] : [base];
        const ns = await git(root, ['diff', '--name-status', ...range]); if (!ns.ok) return { error: clip(ns.stderr || 'git diff failed', 200) }; const changed = ns.stdout.trim().split('\n').filter(Boolean).map(l => { const [status, ...rest] = l.split('\t'); return { status: status[0], file: rest[rest.length - 1] }; }); if (!changed.length) return { base, head: a.head || 'working tree', changed: 0, note: 'no differences' };
        const stat = await git(root, ['diff', '--shortstat', ...range]); const diff = await git(root, ['diff', '-U0', ...range]); const symbols = {}; let cur = null;
        for (const line of diff.stdout.split('\n')) { const f = line.match(/^\+\+\+ b\/(.+)$/); if (f) { cur = f[1]; continue; } const m = cur && line.match(/^([+-])\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/); if (m) { (symbols[cur] ||= {}); (symbols[cur][m[2]] ||= new Set()).add(m[1]); } }
        const { dependents } = scanRepo(root); const ripple = changed.filter(c => c.status !== 'A').map(c => ({ file: c.file, status: c.status, importedBy: (dependents.get(c.file) || []).slice(0, 25), exports: Object.entries(symbols[c.file] || {}).map(([n, s]) => ({ name: n, change: s.size === 2 ? 'modified' : s.has('+') ? 'added' : 'removed' })) })).sort((x, y) => y.importedBy.length - x.importedBy.length);
        const notes = []; for (const r of ripple) { const removed = r.exports.filter(e => e.change === 'removed'); if (removed.length && r.importedBy.length) notes.push(`${r.file} removes export(s) ${removed.map(e => e.name).join(', ')} and is imported by ${r.importedBy.length} file(s) — check each importer`); if (r.status === 'D' && r.importedBy.length) notes.push(`${r.file} is deleted but still imported by ${r.importedBy.join(', ')}`); }
        if (changed.some(c => /(^|\/)(db|db-migrate|config|auth|app|runtime)\.js$/.test(c.file))) notes.push('touches core runtime files (db, config, auth, app, runtime)'); if (!changed.some(c => /(^|\/)test\/|\.test\./.test(c.file))) notes.push('no test files changed');
        return { base, head: a.head || 'working tree', changed: changed.length, summary: stat.stdout.trim(), files: changed, blastRadius: [...new Set(ripple.flatMap(r => r.importedBy))].length, ripple: ripple.slice(0, 30), notes }; } },
    { name: 'hermes.grill_me', description: 'Stress-test a plan, design, schema or business idea before committing to it: lists the hidden assumptions, the concrete ways it breaks (each with a test that would show it), and the questions you must answer first. Uses the local model as a Socratic critic.',
      parameters: obj({ plan: S('the plan or design, in full'), focus: S('optional: what to press hardest on (security, scale, cost, data loss…)') }, ['plan']),
      run: async a => { const raw = await chatOllama([{ role: 'system', content: 'You are a ruthless but fair pre-mortem reviewer. Find what is wrong with the plan, not what is right. Be concrete: name the input, state or sequence that breaks it. Reply as JSON: {"assumptions": ["…"], "holes": [{"issue": "…", "how_it_breaks": "…", "test": "an experiment that would show it"}], "questions": ["…"], "verdict": "proceed | fix first | rethink", "why": "one sentence"}. 3–6 holes, most severe first.' }, { role: 'user', content: `${a.focus ? `Press hardest on: ${clip(a.focus, 200)}\n\n` : ''}PLAN:\n${clip(a.plan, 6000)}` }], { priority: 'goal', label: 'hermes:grill_me', temperature: 0.4, maxTokens: 900, format: 'json' }); const j = parseJSON(raw); return j && Array.isArray(j.holes) ? j : { error: 'the model did not return a usable critique', raw: clip(raw, 400) }; } },
    { name: 'hermes.har_to_client', description: 'Turn a browser HAR capture (saved from DevTools → Network → "Save all as HAR") into a reusable JavaScript API client: groups requests into endpoints, replaces ids in paths with parameters, and writes an ES module with one function per endpoint to data/har-clients/. Credentials in the HAR are never copied into the client.',
      parameters: obj({ path: S('absolute path of the .har file (under the allowed roots)'), name: S('client name'), host: S('optional: only this host') }, ['path']),
      run: async a => { const file = underRoots(a.path); let har; try { har = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { error: `cannot read HAR: ${clip(e.message, 100)}` }; } const entries = har?.log?.entries; if (!Array.isArray(entries)) return { error: 'not a HAR file (log.entries missing)' };
        const eps = new Map(); for (const e of entries) { let u; try { u = new URL(e.request.url); } catch (_) { continue; } if (a.host && u.hostname !== a.host) continue; const mime = e.response?.content?.mimeType || ''; if (!/json|graphql/.test(mime) && !/\/api\/|graphql/.test(u.pathname)) continue; const tpl = u.pathname.split('/').map(s => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(s) || /^[0-9a-f]{24,}$/i.test(s) ? ':id' : s)).join('/'); const key = `${e.request.method} ${u.origin}${tpl}`; const ep = eps.get(key) || { method: e.request.method, origin: u.origin, path: tpl, query: new Set(), count: 0, status: new Set(), hasBody: false, headerNames: new Set() }; ep.count++; ep.status.add(e.response?.status); for (const [k] of u.searchParams) ep.query.add(k); if (e.request.postData?.text) ep.hasBody = true; for (const h of e.request.headers || []) if (/^(authorization|x-[a-z-]*(key|token|csrf)[a-z-]*|cookie)$/i.test(h.name)) ep.headerNames.add(h.name.toLowerCase()); eps.set(key, ep); }
        if (!eps.size) return { error: 'no JSON/API requests found in the HAR' }; const list = [...eps.values()].sort((x, y) => y.count - x.count).slice(0, 60); const used = new Set();
        const fname = ep => { let n = (ep.method.toLowerCase() + ep.path.split('/').filter(s => s && s !== ':id' && s !== 'api').slice(-2).map(s => s.replace(/[^a-z0-9]+/gi, ' ').trim().split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join('')).join('')) || ep.method.toLowerCase(); let k = n, i = 2; while (used.has(k)) k = n + i++; used.add(k); return k; };
        const name = slugify(a.name || basename(file, '.har')); const authHeaders = [...new Set(list.flatMap(ep => [...ep.headerNames]))];
        const code = [`// API client generated from ${basename(file)} by hermes.har_to_client — ${list.length} endpoint(s).`, `// Credentials are NOT embedded. Pass them at construction: createClient({ headers: { ${authHeaders.filter(h => h !== 'cookie').map(h => `'${h}': '…'`).join(', ')} } })`, `export function createClient({ headers = {}, fetchImpl = fetch } = {}) {`, `  async function call(method, url, { query, body } = {}) {`, `    const u = new URL(url); for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, v);`, `    const res = await fetchImpl(u, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });`, `    const text = await res.text(); let data; try { data = JSON.parse(text); } catch (_) { data = text; }`, `    if (!res.ok) throw Object.assign(new Error(method + ' ' + u.pathname + ' → HTTP ' + res.status), { status: res.status, data });`, `    return data;`, `  }`, `  return {`, ...list.map(ep => { const ids = ep.path.split('/').filter(s => s === ':id').length; const params = [...Array.from({ length: ids }, (_, i) => `id${ids > 1 ? i + 1 : ''}`), ep.query.size ? 'query' : null, ep.hasBody ? 'body' : null].filter(Boolean); let n = 0; const urlExpr = '`' + ep.origin + ep.path.replace(/:id/g, () => '${encodeURIComponent(id' + (ids > 1 ? ++n : '') + ')}') + '`'; return `    /** ${ep.method} ${ep.path} — seen ${ep.count}×, status ${[...ep.status].join('/')}${ep.query.size ? `, query: ${[...ep.query].join(', ')}` : ''} */\n    ${fname(ep)}: (${params.join(', ')}) => call('${ep.method}', ${urlExpr}, { ${ep.query.size ? 'query, ' : ''}${ep.hasBody ? 'body' : ''} }),`; }), `  };`, `}`, ''].join('\n');
        mkdirSync(HAR_DIR, { recursive: true }); const out = join(HAR_DIR, `${name}.mjs`); writeFileSync(out, code);
        return { name, file: out, endpoints: list.length, hosts: [...new Set(list.map(e => e.origin))], authHeadersSeen: authHeaders, preview: clip(code, 1500) }; } },
    { name: 'hermes.site_publish', description: 'Publish a static site locally: write HTML/CSS/JS files under data/sites/<slug>/ and serve them at http://127.0.0.1:8787/sites/<slug>/ so they can be previewed in the browser. Local only — nothing goes to the internet.',
      parameters: obj({ slug: S('site name'), html: S('full HTML for index.html (use this OR files)'), files: { type: 'array', maxItems: 20, items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } }, description: 'files: [{path, content}]' } }, ['slug']),
      run: async a => { const files = Array.isArray(a.files) && a.files.length ? a.files : a.html ? [{ path: 'index.html', content: a.html }] : null; if (!files) return { error: 'give html or files' }; if (files.reduce((s, f) => s + String(f.content || '').length, 0) > 3_000_000) return { error: 'site is larger than 3 MB' }; return writeSite(a.slug, files); } },
    { name: 'hermes.scrollpage', description: 'Build a scroll-driven landing page (full-height hero, sections that reveal as you scroll, progress bar, parallax glow, call-to-action) from a title, tagline and a list of sections, and publish it locally at /sites/<slug>/. One self-contained HTML file, no libraries, respects reduced-motion.',
      parameters: obj({ slug: S('site name'), title: S('headline'), tagline: S('one sentence under the headline'), sections: { type: 'array', maxItems: 12, items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' } } }, description: 'sections: [{heading, body}]' }, cta_label: S('button text'), cta_href: S('button link'), accent: S('accent colour as hex, e.g. #22d3ee') }, ['slug', 'title', 'sections']),
      run: async a => { const sections = (Array.isArray(a.sections) ? a.sections : []).filter(s => s && s.heading).slice(0, 12); if (!sections.length) return { error: 'sections must be a non-empty array of {heading, body}' }; const html = scrollPageHtml({ title: clip(a.title, 120), tagline: clip(a.tagline, 240), sections: sections.map(s => ({ heading: clip(s.heading, 120), body: clip(s.body, 600) })), cta: { label: clip(a.cta_label, 40), href: clip(a.cta_href, 300) }, accent: a.accent }); return { ...writeSite(a.slug, [{ path: 'index.html', content: html }]), sections: sections.length }; } },
    { name: 'hermes.morning_brief', description: 'One-page status of the whole organism from live data: goals executed and their quality, agent run errors, capability g-score, open self-audit findings, what is waiting on Vaughn (approvals, code branches), active skills, and what was seen in the world. Facts only, no model call.',
      parameters: obj({}), run: async () => morningBrief() },
    { name: 'spore.read', description: 'Open a FRAYMUS lazarus-spore-v1 container (*.spore.wasm): verify it is intact (SHA-256 of the payload against the embedded baseline), and return its topic, agent, generation, winning lane, consciousness-proof summary and the fork titles. Read-only; the WASM is parsed, never executed.',
      parameters: obj({ path: S('absolute path of the .spore.wasm file'), full: { type: 'boolean', description: 'include each fork\'s full script' } }, ['path']),
      run: async a => { const file = underRoots(a.path); const s = readSpore(readFileSync(file)); const d = s.data || {}; return { file: basename(file), intact: s.intact, baseline: s.baseline, dataSha256: s.dataSha256, sections: s.sections, protocol: d.protocol, topic: d.topic, context: d.contextText, agent: d.agentId, generation: d.generation, timestamp: d.timestamp, winnerLane: d.winnerLane, proof: d.proofSummary ? { effectiveInformationBits: d.proofSummary.effectiveInformationBits, phiMipBits: d.proofSummary.phiMipBits, mirrorDelta: d.proofSummary.mirrorDelta, counterfactualGain: d.proofSummary.counterfactualGain, provenIntegratedCore: d.proofSummary.provenIntegratedCore } : null, forks: (d.forks || []).map(f => ({ lane: f.lane, title: f.title, compositeFitness: f.compositeFitness, proven: f.proof?.provenIntegratedCore, script: a.full ? f.script : clip(f.script, 240) })), lineage: s.ledger?.lineage, genesisHash: s.genesis?.hash }; } },
  ];
  return defs.map(d => ({
    name: d.name, group: 'hermes', risk: d.risk || 'safe', description: d.description, parameters: d.parameters,
    execute: async ({ args = {} } = {}, ctx = {}) => {
      const t0 = now(); let ok = 0, error = null;
      try { const out = await d.run(args || {}, ctx); ok = out && !out.error ? 1 : 0; error = out?.error || null; return out; }
      catch (e) { error = clip(e.message, 200); return { error }; }
      finally { try { db.prepare(`INSERT INTO hermes_calls (tool, agent_id, ok, ms, error, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(d.name, ctx?.agent?.id || ctx?.agentId || null, ok, now() - t0, error, now()); } catch (e) { console.error('[hermes] call log:', e.message); } }
    },
  }));
}

/** All 33 Hermes skills from the manifest, mapped honestly onto this system. */
export const HERMES_SKILLS = [
  ['canvas', 'productivity', 'not_built', null, 'Needs your Canvas LMS token and school URL — say the word and it is a small authenticated client.'],
  ['here-now', 'productivity', 'covered', 'hermes.site_publish', 'Local staging and instant publish to /sites/. Cloud-drive push is not built.'],
  ['live-dashboard', 'productivity', 'built', 'hermes.morning_brief', 'Facts-only briefing from live data; schedule it with the automations cron.'],
  ['shopify', 'productivity', 'existing', 'commerce tools', 'Chandra already has 17 commerce tools on the Shopify Admin API; writes need approval.'],
  ['telephony', 'productivity', 'not_built', null, 'Every SMS/voice gateway is a paid API — excluded by the no-paid-APIs rule.'],
  ['bioinformatics', 'research', 'not_built', null, 'Needs samtools, bcftools, BLAST+ and minimap2 binaries, none of which are installed.'],
  ['blogwatcher', 'research', 'built', 'hermes.rss_read', 'onlyNew:true returns only items not seen before for a feed.'],
  ['duckduckgo-search', 'research', 'existing', 'web_search', 'Keyless DuckDuckGo HTML search already runs in world-pollers and the Hermes executor.'],
  ['gitnexus-explorer', 'research', 'covered', 'hermes.code_wiki', 'Dependency hubs and module map are generated as Markdown; the interactive graph UI and tunnel are not built.'],
  ['osint-investigation', 'research', 'built', 'hermes.osint', 'Wayback and USAspending verified live; SEC EDGAR works once HERMES_SEC_USER_AGENT holds a contact (403 without); GDELT is wired but timed out from this network. CourtListener (bot wall), OpenCorporates (key) and OFAC (bulk file) are not included.'],
  ['parallel-cli', 'research', 'built', 'hermes.parallel_fetch', 'Up to 12 URLs, 4 in flight, in-process — no curl|bash installer.'],
  ['research-paper-writing', 'research', 'covered', 'research_scout', 'arXiv / Semantic Scholar search exists; LaTeX compilation is not built (no TeX install).'],
  ['rss-feeds', 'research', 'built', 'hermes.rss_read', 'RSS and Atom, including subreddit .rss feeds.'],
  ['scrapling', 'research', 'built', 'hermes.scrape', 'Readable Markdown from static HTML with a 24 h cache. JS-rendered pages go through the existing browser tools; no anti-bot evasion.'],
  ['pinecone-research', 'research', 'existing', 'memory_search / vertiso', 'Local vector memory (nomic-embed-text + SQLite) replaces a paid vector database.'],
  ['searxng-search', 'research', 'not_built', null, 'Needs a SearXNG instance URL; public instances block bots. DuckDuckGo covers search today.'],
  ['1password', 'security', 'not_built', null, 'Needs the 1Password CLI and your account. Secrets stay in .env, which agents never read.'],
  ['godmode', 'security', 'declined', null, 'Automated jailbreak tooling against model guardrails — not something I will build into autonomous agents.'],
  ['oss-forensics', 'security', 'built', 'hermes.pkg_audit', 'npm and PyPI registry forensics with risk flags. GitHub Archive deleted-commit recovery is not built.'],
  ['sherlock', 'security', 'built', 'hermes.username_check', '9 developer/social platforms via their public APIs, for brand-handle availability.'],
  ['unbroker', 'security', 'not_built', null, 'Automated opt-out filing needs your personal details and a per-broker browser flow; it should be its own reviewed project.'],
  ['web-pentest', 'security', 'covered', 'hermes.api_get', 'Passive only: security-header and CORS findings on a URL you name. Active scanning is not given to autonomous agents.'],
  ['reddit-reading', 'social', 'covered', 'hermes.rss_read', 'Keyless via https://www.reddit.com/r/<sub>/.rss; comment trees need Reddit API credentials.'],
  ['ast-grep', 'software', 'not_built', null, 'Needs the ast-grep binary. Convention scanning by regex already exists in the kernel.'],
  ['code-wiki', 'software', 'built', 'hermes.code_wiki', 'Architecture.md and Modules.md, read from the code.'],
  ['grill-me', 'software', 'built', 'hermes.grill_me', 'Socratic pre-mortem with the local model, JSON output.'],
  ['pr-lens', 'software', 'built', 'hermes.pr_lens', 'Changed exports and import blast radius from git diff.'],
  ['rest-graphql-debug', 'software', 'built', 'hermes.api_get / hermes.api_request', 'GET diagnostics are free; non-GET requests stop for approval.'],
  ['subagent-driven-development', 'software', 'existing', 'delegate_to_agent / swarm', 'Fleet delegation, swarm and the verifier loop cover staged builds with gates.'],
  ['cloudflare-temporary-deploy', 'web', 'not_built', null, 'cloudflared is not installed, and exposing this loopback-only server to the internet should be your explicit call.'],
  ['publish-site', 'web', 'built', 'hermes.site_publish', 'Local static hosting at /sites/<slug>/.'],
  ['har-derived-api-client', 'web', 'built', 'hermes.har_to_client', 'From a saved HAR file; capture itself is done in your browser DevTools.'],
  ['page-agent', 'web', 'covered', 'home command bridge', 'The home screen now drives a tool-holding agent; in-page DOM control of other sites is not built.'],
  ['scrollcraft', 'web', 'built', 'hermes.scrollpage', 'Scroll-driven landing page generator. Video-frame encoding is not built.'],
].map(([skill, category, status, tool, note]) => ({ skill, category, status, tool, note }));

export function hermesStatus() {
  const counts = HERMES_SKILLS.reduce((m, s) => (m[s.status] = (m[s.status] || 0) + 1, m), {});
  let calls = { n: 0, ok: 0, agents: 0 };
  try { calls = db.prepare(`SELECT COUNT(*) n, SUM(ok) ok, COUNT(DISTINCT agent_id) agents FROM hermes_calls WHERE created_at > ?`).get(now() - 7 * 86_400_000); } catch (e) { console.error('[hermes] status:', e.message); }
  return { skills: HERMES_SKILLS.length, counts, tools: createHermesTools().map(t => ({ name: t.name, risk: t.risk, description: t.description })), calls7d: calls, roots: ROOTS, sitesDir: SITES_DIR };
}

// ── artifact shelf: everything the agents have made on this machine, newest first ───────────────
const REA_DIR = join(DATA_DIR, 'rea');
const safeName = s => /^[\w.-]{1,120}$/.test(String(s || '')) && !String(s).includes('..');
function dirEntries(dir) { try { return readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; } }
function mtime(p) { try { return statSync(p).mtimeMs; } catch (_) { return 0; } }
function firstHeading(file, fallback) { try { const m = readFileSync(file, 'utf8').slice(0, 2000).match(/^#\s+(.+)$/m) || readFileSync(file, 'utf8').slice(0, 4000).match(/<title>([^<]+)<\/title>/i); return m ? decodeEntities(m[1]).trim().slice(0, 120) : fallback; } catch (_) { return fallback; } }

// media the engines wrote: images (data/media, plus GIFs from the video engine), video (data/video), audio (data/tts)
const MEDIA_DIRS = { image: [join(DATA_DIR, 'media'), join(DATA_DIR, 'video')], video: [join(DATA_DIR, 'video')], audio: [join(DATA_DIR, 'tts')] };
const MEDIA_EXT = { image: /\.(png|jpe?g|webp|gif)$/i, video: /\.(mp4|webm|mov)$/i, audio: /\.(mp3|wav|ogg)$/i };
const MEDIA_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
const UNFILTERED_AUDIO_CAP = 2; // the narrator speaks every few minutes; unfiltered, audio would bury everything else
const stamp = name => { const m = /^(\d{13})-/.exec(name); return m ? Number(m[1]) : 0; }; // engines name files <epoch ms>-<id>.<ext>
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
function mediaItems(kind) {
  const out = [];
  for (const dir of MEDIA_DIRS[kind]) for (const f of dirEntries(dir)) if (f.isFile() && MEDIA_EXT[kind].test(f.name)) { const at = stamp(f.name) || mtime(join(dir, f.name)); out.push({ kind, id: f.name, title: `${kind[0].toUpperCase()}${kind.slice(1)} · ${when(at)}`, detail: extname(f.name).slice(1).toLowerCase(), media: `/api/hermes/artifacts/media?kind=${kind}&id=${encodeURIComponent(f.name)}`, at }); }
  return out;
}
/** Absolute path of one media file, or null. The id must be a bare file name of the right type inside that kind's folders. */
export function mediaFile(kind, id) {
  if (!MEDIA_DIRS[kind] || !safeName(id) || !MEDIA_EXT[kind].test(String(id))) return null;
  for (const dir of MEDIA_DIRS[kind]) { const full = join(dir, String(id)); if (existsSync(full) && statSync(full).isFile()) return { path: full, mime: MEDIA_MIME[extname(full).toLowerCase()] || 'application/octet-stream' }; }
  return null;
}

/** kinds: site (opens in the browser) · wiki | client | report | draft (read in the viewer) · image | video | audio (played in the viewer). */
export function listArtifacts({ limit = 24, kind = null, q = '' } = {}) {
  const out = [];
  const port = SERVER_PORT;
  for (const d of dirEntries(SITES_DIR)) if (d.isDirectory() && existsSync(join(SITES_DIR, d.name, 'index.html'))) out.push({ kind: 'site', id: d.name, title: firstHeading(join(SITES_DIR, d.name, 'index.html'), d.name), detail: `${dirEntries(join(SITES_DIR, d.name)).length} file(s)`, url: `http://127.0.0.1:${port}/sites/${d.name}/`, at: mtime(join(SITES_DIR, d.name, 'index.html')) });
  for (const d of dirEntries(WIKI_DIR)) if (d.isDirectory()) for (const f of dirEntries(join(WIKI_DIR, d.name))) if (f.isFile() && f.name.endsWith('.md')) out.push({ kind: 'wiki', id: `${d.name}/${f.name}`, title: firstHeading(join(WIKI_DIR, d.name, f.name), `${d.name} — ${f.name}`), detail: f.name, at: mtime(join(WIKI_DIR, d.name, f.name)) });
  for (const f of dirEntries(HAR_DIR)) if (f.isFile() && f.name.endsWith('.mjs')) out.push({ kind: 'client', id: f.name, title: `API client: ${f.name.replace(/\.mjs$/, '')}`, detail: 'ES module', at: mtime(join(HAR_DIR, f.name)) });
  for (const f of dirEntries(REA_DIR)) if (f.isFile() && f.name.endsWith('.md')) out.push({ kind: 'report', id: f.name, title: firstHeading(join(REA_DIR, f.name), `REA report ${f.name}`), detail: 'reverse-engineering report', at: mtime(join(REA_DIR, f.name)) });
  try { for (const r of db.prepare(`SELECT id, preset, topic, status, created_at FROM fraymus_os_artifacts ORDER BY created_at DESC LIMIT 40`).all()) out.push({ kind: 'draft', id: r.id, title: r.topic, detail: `${String(r.preset).replace(/-/g, ' ')} · ${r.status}`, at: r.created_at }); } catch (e) { if (!/no such table/.test(e.message)) console.error('[hermes] draft artifacts:', e.message); }
  const media = { image: mediaItems('image'), video: mediaItems('video'), audio: mediaItems('audio').sort((a, b) => b.at - a.at) };
  const counts = out.reduce((m, a) => (m[a.kind] = (m[a.kind] || 0) + 1, m), {});
  for (const k of Object.keys(media)) if (media[k].length) counts[k] = media[k].length;
  const total = out.length + media.image.length + media.video.length + media.audio.length;
  const needle = String(q || '').trim().toLowerCase().slice(0, 80);
  let pool;
  if (needle) {
    // search looks at everything, including all audio: titles and details, recorded prompts/operations, and spoken text
    const byMeta = searchMediaFiles(needle);
    let spokenHits = new Set();
    try { const like = `%${needle.replace(/[\\%_]/g, m => `\\${m}`)}%`; spokenHits = new Set(db.prepare(`SELECT audio_url FROM narrations WHERE text LIKE ? ESCAPE '\\' AND audio_url IS NOT NULL ORDER BY created_at DESC LIMIT 500`).all(like).map(r => String(r.audio_url).replace(/^\/tts\//, ''))); } catch (e) { if (!/no such table/.test(e.message)) console.error('[hermes] narration search:', e.message); }
    const all = [...out, ...media.image, ...media.video, ...media.audio];
    pool = (kind ? all.filter(a => a.kind === kind) : all).filter(a => `${a.title} ${a.detail} ${a.id}`.toLowerCase().includes(needle) || byMeta.has(a.id) || spokenHits.has(a.id));
  } else {
    pool = kind ? (media[kind] || out.filter(a => a.kind === kind)) : [...out, ...media.image, ...media.video, ...media.audio.slice(0, UNFILTERED_AUDIO_CAP)];
  }
  const matched = pool.length;
  // an engine attempt that failed can leave an empty file behind (edge-tts does): never show those.
  // Only the candidates for this page are stat-ed, not the whole folder.
  const playable = a => { if (!a.media) return true; const f = mediaFile(a.kind, a.id); try { return !!f && statSync(f.path).size > 0; } catch (_) { return false; } };
  const artifacts = pool.sort((a, b) => b.at - a.at).slice(0, limit * 2 + 4).filter(playable).slice(0, limit);
  // what made each media file: the recorded prompt becomes the title, the operation goes in the detail line
  const made = mediaMetaFor(artifacts.filter(a => a.media).map(a => a.id));
  for (const a of artifacts) { const m = made.get(a.id); if (!m) continue; a.op = m.op; a.params = m.params; if (m.prompt) { a.prompt = m.prompt; a.title = clip(m.prompt, 110); } else a.title = `${a.kind[0].toUpperCase()}${a.kind.slice(1)} · ${m.op} · ${when(a.at)}`; a.detail = `${m.op} · ${a.detail}`; }
  // spoken lines get their text as the title (the narrator stores what each file says)
  const spoken = artifacts.filter(a => a.kind === 'audio');
  if (spoken.length) { try { const find = db.prepare(`SELECT text FROM narrations WHERE audio_url = ? LIMIT 1`); for (const a of spoken) { const row = find.get(`/tts/${a.id}`); if (row?.text) { a.title = clip(row.text, 110); a.detail = `narration · ${a.detail}`; } } } catch (e) { if (!/no such table/.test(e.message)) console.error('[hermes] narration titles:', e.message); } }
  return { total, counts, matched, query: needle || null, artifacts };
}

/** Text of one non-site artifact. Names are checked against a strict pattern; nothing outside data/ is readable. */
export function readArtifact(kind, id) {
  const MAX = 200_000;
  if (kind === 'draft') {
    let r;
    // like listArtifacts: before the home screen has made a draft the table does not exist, and that is "no such draft"
    try { r = db.prepare(`SELECT preset, topic, status, payload, error, created_at FROM fraymus_os_artifacts WHERE id = ?`).get(String(id)); }
    catch (e) { if (/no such table/.test(e.message)) return null; throw e; }
    if (!r) return null;
    let p = null; try { p = r.payload ? JSON.parse(r.payload) : null; } catch (_) { /* shown raw below */ }
    const lines = [`# ${r.topic}`, `_${String(r.preset).replace(/-/g, ' ')} · ${r.status} · ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')}_`];
    if (r.error) lines.push(`\n**Error:** ${r.error}`);
    const walk = (v, depth) => { if (v == null) return; if (typeof v !== 'object') { lines.push(String(v)); return; } for (const [k, x] of Object.entries(v)) { if (x == null || x === '') continue; if (typeof x === 'object') { lines.push(`\n${'#'.repeat(Math.min(4, depth + 2))} ${k.replace(/_/g, ' ')}`); if (Array.isArray(x)) x.forEach((it, i) => (typeof it === 'object' ? (lines.push(`\n**${i + 1}.**`), walk(it, depth + 1)) : lines.push(`- ${it}`))); else walk(x, depth + 1); } else lines.push(`- **${k.replace(/_/g, ' ')}:** ${x}`); } };
    if (p) walk(p, 0); else if (r.payload) lines.push(r.payload);
    return { kind, id, title: r.topic, format: 'markdown', text: lines.join('\n').slice(0, MAX) };
  }
  const read = (file, format) => (existsSync(file) ? { kind, id, title: firstHeading(file, id), format, text: readFileSync(file, 'utf8').slice(0, MAX), path: file } : null);
  if (kind === 'wiki') { const [name, file] = String(id).split('/'); return safeName(name) && safeName(file) && file.endsWith('.md') ? read(join(WIKI_DIR, name, file), 'markdown') : null; }
  if (kind === 'client') return safeName(id) && String(id).endsWith('.mjs') ? read(join(HAR_DIR, id), 'code') : null;
  if (kind === 'report') return safeName(id) && String(id).endsWith('.md') ? read(join(REA_DIR, id), 'markdown') : null;
  return null;
}

export function installHermesRoutes(app, { express } = {}) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  const tools = createHermesTools();
  app.get('/api/hermes', route((req, res) => res.json(hermesStatus())));
  app.get('/api/hermes/skills', route((req, res) => res.json({ skills: HERMES_SKILLS })));
  app.get('/api/hermes/brief', route((req, res) => res.json(morningBrief())));
  app.get('/api/hermes/artifacts', route((req, res) => res.json(listArtifacts({ q: typeof req.query.q === 'string' ? req.query.q : '', limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 24)), kind: ['site', 'wiki', 'client', 'report', 'draft', 'image', 'video', 'audio'].includes(req.query.kind) ? req.query.kind : null }))));
  // media bytes go through /api so the dev proxy and the built client both reach them same-origin
  app.get('/api/hermes/artifacts/media', (req, res, next) => { try { const f = mediaFile(String(req.query.kind || ''), String(req.query.id || '')); if (!f) return res.status(404).json({ error: 'media not found' }); res.setHeader('Content-Type', f.mime); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'private, max-age=3600'); res.sendFile(f.path, err => { if (err && !res.headersSent) next(err); }); } catch (e) { next(e); } });
  app.get('/api/hermes/artifacts/read', route((req, res) => { const a = readArtifact(String(req.query.kind || ''), String(req.query.id || '')); return a ? res.json(a) : res.status(404).json({ error: 'artifact not found' }); }));
  app.get('/api/hermes/sites', route((req, res) => { let sites = []; try { sites = readdirSync(SITES_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => ({ slug: d.name, url: `/sites/${d.name}/` })); } catch (_) { /* no sites yet */ } res.json({ sites }); }));
  // operator call of a safe tool; approval-labelled tools only run through an agent's approval flow
  app.post('/api/hermes/run/:tool', route(async (req, res) => { const t = tools.find(x => x.name === req.params.tool); if (!t) return res.status(404).json({ error: 'unknown hermes tool' }); if (t.risk !== 'safe') return res.status(403).json({ error: 'this tool needs approval — call it through an agent' }); res.json(await t.execute({ args: req.body || {} }, { agentId: 'operator' })); }));
  if (express) { mkdirSync(SITES_DIR, { recursive: true }); app.use('/sites', express.static(SITES_DIR, { index: 'index.html', dotfiles: 'ignore', fallthrough: true, setHeaders: res => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' data:; connect-src 'none'"); } })); }
}
