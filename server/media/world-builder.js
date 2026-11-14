/**
 * Walkable worlds: a place (real or imagined) or a picture becomes a page you can walk and fly through.
 *
 * Absorbed from Vaughn's Nexus Engine (docs/NEXUS-ENGINE-CREATION-METHODS.md, methods 8 and 20): a model wrote world
 * parameters (water level, elevation, fog, palette, landmarks) from a search, and a three.js scene drew them. Here:
 *   spec   — the model pool writes the same kind of JSON; for a real place the opening of its Wikipedia article is
 *            given as FACTS, and a landmark whose name the facts (or the request) do not contain is dropped:
 *            a world of a real place may not invent real landmarks. `checkWorldSpec` clamps every number.
 *   ground — page-kit/terrain.js builds the terrain from the spec (seeded noise, ridges, a peak where a peak is
 *            named, a flat spot under anything built), or from a picture: its brightness is the height, its colours
 *            the ground (`worldFromPicture`, e.g. a background plate from looks.layers).
 *   page   — a fixed template, not written by a model: the component, the spec, a title card, the landmark list and
 *            the controls. Saved under Sites.
 *   check  — opened in headless Chromium under the site policy: it must draw and move on its own, and then a walk
 *            is driven through the page (W held for a second): the position must change and the eye must stay
 *            on the ground. A world that fails is removed and the job says what the browser saw.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { withOrigin } from '../intelligence/card-ledger.js';
import { createRequire } from 'node:module';
import { db } from '../db.js';
import { DATA_DIR, PORT, mayRecoverAtBoot } from '../config.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { SITES_DIR, verifyPage, withBrowserPage, slugFor } from './page-builder.js';
import { groundFacts } from './make.js';
import { shelfFile } from './looks/convert.js';

const sharp = createRequire(import.meta.url)('sharp');
const KIT = join(dirname(fileURLToPath(import.meta.url)), 'page-kit', 'terrain.js');
const clip = (s, n) => String(s ?? '').slice(0, n);
const now = () => Date.now();
export const LANDMARK_KINDS = ['tower', 'peak', 'plaza', 'bridge', 'ruin', 'depot'];
export const MIN_LAND_IN_VIEW = 0.1, MAX_LAND_IN_VIEW = 0.85;
/** The place a world request is about, for the Wikipedia lookup: the world words go ("a walkable world of the Isle of Skye" → "Isle of Skye"). */
export function placeOf(request) {
  return String(request || '').replace(/\b(a|an|make|create|build|me|please|walkable|explorable|open|3-?d|three-dimensional|world|worlds|map|level|scene|landscape|version|place|of|the|in|style)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}
const HEX = /^#[0-9a-f]{6}$/i;
const emit = p => { try { publish('studio', 'system.studio', JSON.stringify(p)); } catch (e) { console.error('[worlds] publish:', e.message); } };

db.exec(`CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, request TEXT, source_file TEXT, status TEXT NOT NULL, stage TEXT, slug TEXT, spec TEXT, facts TEXT, check_result TEXT, error TEXT, created_at INTEGER, completed_at INTEGER)`);
if (mayRecoverAtBoot()) db.prepare(`UPDATE worlds SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status IN ('queued', 'running')`).run(now());

// ── the spec ─────────────────────────────────────────────────────────────────────────────────────────

export function worldMessages(request, facts = null, feedback = null) {
  const sys = [
    'You design a small walkable 3-D world for a browser. Reply with ONE JSON object and nothing else:',
    '{"name": short title, "summary": 1-2 sentences about the place, "seed": integer, "elevation": 0.3-2 (how tall the land is),',
    ' "water": 0-0.6 (share of the land under water), "rugged": 0-1 (0 rolling hills, 1 jagged ridges), "island": true|false,',
    ' "fog": 0-1, "sky": ["#top", "#horizon"], "palette": {"water","shore","ground","rock","snow"} as "#rrggbb" (snow null where it never snows),',
    ` "landmarks": 3 to 6 of {"name", "kind": one of ${LANDMARK_KINDS.join(' | ')}, "x": -1..1, "z": -1..1, "color": "#rrggbb"}, "start": {"x": -1..1, "z": -1..1}}`,
    'Colours should match the real place or the mood asked for. Spread landmarks apart; start away from all of them.',
    facts ? 'FACTS about the place are given. Landmark names must be names that appear in the FACTS; do not invent real places. If the FACTS name none, use descriptive names ("the old harbour").' : 'If the place is imaginary, invent fitting landmark names.',
  ].join('\n');
  const user = `${facts ? `FACTS:\n${facts}\n\n` : ''}World to make: ${request}${feedback ? `\n\nYour last answer was not usable: ${feedback}` : ''}`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const words = s => new Set(String(s || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []);
const GENERIC = new Set(['the', 'old', 'new', 'great', 'little', 'high', 'low', 'north', 'south', 'east', 'west', 'upper', 'lower']);
/**
 * Is a landmark name grounded? Every distinctive word of it appears in the facts or in the request. A descriptive
 * name ("the old harbour") made only of ordinary words passes when the facts have none of its own.
 */
export function nameGrounded(name, facts, request) {
  const src = words(`${facts || ''} ${request || ''}`), own = [...words(name)].filter(w => !GENERIC.has(w));
  const capitals = (String(name).match(/\b[A-Z][a-z]+/g) || []).map(w => w.toLowerCase()).filter(w => !GENERIC.has(w));
  if (!capitals.length) return true;                                     // a description, not a proper name
  return capitals.every(w => src.has(w)) && own.length > 0;
}

/** Clamp and tidy a model's world JSON. Returns { ok, spec, fixes, reason }. */
export function checkWorldSpec(raw, { facts = null, request = '' } = {}) {
  let o = raw;
  if (typeof raw === 'string') { const a = raw.indexOf('{'), z = raw.lastIndexOf('}'); try { o = a >= 0 && z > a ? JSON.parse(raw.slice(a, z + 1)) : null; } catch (_) { o = null; } }
  if (!o || typeof o !== 'object') return { ok: false, reason: 'not a JSON object' };
  const fixes = [];
  const pal = o.palette && typeof o.palette === 'object' ? o.palette : {};
  const palette = {};
  for (const k of ['water', 'shore', 'ground', 'rock', 'snow']) {
    if (k === 'snow' && pal.snow === null) { palette.snow = null; continue; }
    if (HEX.test(String(pal[k] || ''))) palette[k] = String(pal[k]).toLowerCase(); else fixes.push(`palette.${k} missing or not a colour: default used`);
  }
  const sky = Array.isArray(o.sky) && o.sky.length === 2 && o.sky.every(c => HEX.test(String(c))) ? o.sky.map(c => String(c).toLowerCase()) : (fixes.push('sky not two colours: default used'), ['#7fb6ff', '#dfefff']);
  const landmarks = [];
  for (const L of (Array.isArray(o.landmarks) ? o.landmarks : []).slice(0, 8)) {
    const name = clip(String(L?.name || '').trim(), 40);
    if (!name) continue;
    if (facts && !nameGrounded(name, facts, request)) { fixes.push(`landmark "${name}" is not in the facts: dropped`); continue; }
    const kind = LANDMARK_KINDS.includes(L.kind) ? L.kind : 'tower';
    if (kind !== L.kind) fixes.push(`landmark "${name}" kind "${L.kind}" is not one of ${LANDMARK_KINDS.join(', ')}: tower`);
    landmarks.push({ name, kind, x: num(L.x, -1, 1, 0), z: num(L.z, -1, 1, 0), color: HEX.test(String(L.color || '')) ? String(L.color).toLowerCase() : '#f4a261' });
    if (landmarks.length >= 6) break;
  }
  // landmarks closer than a tenth of the map are pushed apart: two on one spot hide each other
  for (let i = 0; i < landmarks.length; i++) for (let j = 0; j < i; j++) {
    const a = landmarks[i], b = landmarks[j];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 0.2) { a.x = Math.max(-1, Math.min(1, a.x + (a.x >= b.x ? 0.25 : -0.25))); fixes.push(`landmark "${a.name}" moved away from "${b.name}"`); }
  }
  const spec = {
    name: clip(String(o.name || 'A world').trim(), 60), summary: clip(String(o.summary || '').trim(), 280),
    seed: Number.isInteger(o.seed) ? Math.abs(o.seed) % 100000 : 7, elevation: num(o.elevation, 0.3, 2, 1), water: num(o.water, 0, 0.6, 0.28),
    rugged: num(o.rugged, 0, 1, 0.4), island: o.island === true, fog: num(o.fog, 0, 1, 0.35), sky, palette, landmarks,
    start: { x: num(o.start?.x, -1, 1, 0), z: num(o.start?.z, -1, 1, 0.6) },
  };
  if (!spec.summary) fixes.push('no summary');
  return { ok: true, spec, fixes };
}

// ── a world from a picture ───────────────────────────────────────────────────────────────────────────

/** A picture's brightness becomes the height and its colours the ground, at 256²; blurred so pixels are not cliffs. */
export async function worldFromPicture(bytes, { size = 256 } = {}) {
  const base = sharp(bytes).rotate().flatten({ background: '#808080' }).resize(size, size, { fit: 'cover' });
  const colours = await base.clone().removeAlpha().raw().toBuffer();
  const grey = await base.clone().greyscale().blur(1.6).extractChannel(0).raw().toBuffer();
  // stretch the brightness range to the full height range, so a dim picture is not flat
  let lo = 255, hi = 0; for (const v of grey) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const h = Buffer.from(grey.map(v => Math.round(((v - lo) / Math.max(1, hi - lo)) * 255)));
  return { size, heights: h.toString('base64'), colours: colours.toString('base64') };
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function worldPage(spec, { credit = '' } = {}) {
  const kit = readFileSync(KIT, 'utf8');
  if (/<\/script/i.test(kit)) throw new Error('terrain.js must not contain a closing script tag');
  const data = JSON.stringify(spec).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(spec.name)}</title>
<style>
html,body{margin:0;height:100%;background:#0b0f18;color:#eef2f8;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
#world{position:fixed;inset:0;width:100vw;height:100vh;display:block;touch-action:none;cursor:grab}
.card{position:fixed;left:14px;top:14px;max-width:min(380px,calc(100vw - 200px));background:rgba(10,14,24,.62);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px 14px}
.card h1{margin:0 0 4px;font-size:18px} .card p{margin:0 0 8px;font-size:13px;opacity:.85} .card ul{margin:0;padding-left:18px;font-size:12.5px;opacity:.9}
.help{position:fixed;left:14px;bottom:14px;font-size:12px;background:rgba(10,14,24,.55);border-radius:8px;padding:6px 10px;opacity:.9}
.mode{position:fixed;right:14px;bottom:14px;font-size:12px;background:rgba(10,14,24,.55);border-radius:8px;padding:6px 10px}
.pad{position:fixed;right:14px;bottom:52px;display:none;grid-template-columns:repeat(3,48px);gap:6px}
.pad button{height:48px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(10,14,24,.6);color:#fff;font-size:18px}
@media (pointer:coarse){.pad{display:grid}.help{display:none}}
.credit{position:fixed;right:14px;top:auto;bottom:4px;font-size:10px;opacity:.6}
</style></head><body>
<canvas id="world" aria-label="${esc(spec.name)}: a walkable world"></canvas>
<div class="card"><h1>${esc(spec.name)}</h1>${spec.summary ? `<p>${esc(spec.summary)}</p>` : ''}${spec.landmarks.length ? `<ul>${spec.landmarks.map(l => `<li>${esc(l.name)} <span style="opacity:.6">(${esc(l.kind)})</span></li>`).join('')}</ul>` : ''}</div>
<div class="help">W/S or ↑/↓ walk · A/D or ←/→ turn · drag to look · F fly · Space/Shift up/down</div>
<div class="mode" id="mode">walking</div>
<div class="pad" id="pad"><span></span><button data-k="up" aria-label="forward">▲</button><span></span><button data-k="left" aria-label="turn left">◀</button><button data-k="fly" aria-label="walk or fly">✈</button><button data-k="right" aria-label="turn right">▶</button><span></span><button data-k="down" aria-label="back">▼</button><span></span></div>
${credit ? `<div class="credit">${esc(credit)}</div>` : ''}
<script>
${kit}
</script>
<script>
(function(){
  var spec = ${data};
  var modeEl = document.getElementById('mode');
  var w = ChandraTerrain.mount(document.getElementById('world'), spec, { onMode: function(m){ modeEl.textContent = m === 'fly' ? 'flying' : 'walking'; } });
  document.querySelectorAll('#pad button').forEach(function(b){
    var k = b.getAttribute('data-k');
    b.addEventListener('pointerdown', function(e){ e.preventDefault(); if (k === 'fly') w.setMode(w.state().mode === 'walk' ? 'fly' : 'walk'); else w.press(k, true); });
    ['pointerup','pointerleave','pointercancel'].forEach(function(ev){ b.addEventListener(ev, function(){ if (k !== 'fly') w.press(k, false); }); });
  });
})();
</script></body></html>`;
}

// ── the check ────────────────────────────────────────────────────────────────────────────────────────

/** Drive a walk through the page: the position must change and the eye must stay on the ground. */
export async function walkCheck(url) {
  return withBrowserPage(async page => {
    const errors = [];
    page.on('pageerror', e => errors.push(clip(e.message, 200)));
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    await new Promise(r => setTimeout(r, 800));
    const before = await page.evaluate(() => window.__chandraWorld && window.__chandraWorld.state());
    if (!before) return { ok: false, problems: ['the page has no world handle (the component did not mount)'], errors };
    // the first view must show the world, not open sea or sky (the first world started at the shore facing out)
    // …and not a wall of ground with no sky (all three first worlds, at 100 %: the land was far too tall for the eye)
    const firstViewProblem = before.landShare < MIN_LAND_IN_VIEW ? `the first view shows almost no land (${Math.round(before.landShare * 100)} % of the frame, at least ${MIN_LAND_IN_VIEW * 100} %)`
      : before.landShare > MAX_LAND_IN_VIEW ? `the first view is a wall of ground (${Math.round(before.landShare * 100)} % of the frame is land, at most ${MAX_LAND_IN_VIEW * 100} %)` : null;
    await page.keyboard.down('KeyW'); await new Promise(r => setTimeout(r, 1200)); await page.keyboard.up('KeyW');
    await new Promise(r => setTimeout(r, 300));
    const after = await page.evaluate(() => window.__chandraWorld.state());
    const walked = Math.hypot(after.x - before.x, after.z - before.z);
    const onGround = Math.abs(after.y - after.ground - 5.5) < 2;
    const problems = firstViewProblem ? [firstViewProblem] : [];
    if (walked < 3) problems.push(`holding W for 1.2 s moved only ${walked.toFixed(2)} map units`);
    if (!onGround) problems.push(`after walking the eye is ${(after.y - after.ground).toFixed(1)} above the ground, not 5.5`);
    await page.keyboard.press('KeyF'); await new Promise(r => setTimeout(r, 300));
    const fly = await page.evaluate(() => window.__chandraWorld.state());
    if (fly.mode !== 'fly' || fly.y - fly.ground < 20) problems.push('F did not take off');
    for (const e of errors) problems.push(`JavaScript error: ${e}`);
    return { ok: !problems.length, problems, landInFirstView: before.landShare, walked: +walked.toFixed(1), eyeAboveGround: +(after.y - after.ground).toFixed(2), flewTo: +(fly.y - fly.ground).toFixed(1), landmarksSeen: after.landmarksVisible, errors };
  });
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────

const jobsTail = { p: Promise.resolve() };
const setW = (id, f) => { const k = Object.keys(f); db.prepare(`UPDATE worlds SET ${k.map(x => `${x} = ?`).join(', ')} WHERE id = ?`).run(...k.map(x => (typeof f[x] === 'object' && f[x] !== null ? JSON.stringify(f[x]) : f[x])), id); };
const rowOut = r => r && ({ id: r.id, request: r.request, sourceFile: r.source_file, status: r.status, stage: r.stage, slug: r.slug, url: r.slug ? `/sites/${r.slug}/` : null,
  spec: r.spec ? JSON.parse(r.spec) : null, facts: r.facts ? JSON.parse(r.facts) : null, check: r.check_result ? JSON.parse(r.check_result) : null, error: r.error, createdAt: r.created_at, completedAt: r.completed_at });
export const getWorld = id => rowOut(db.prepare(`SELECT * FROM worlds WHERE id = ?`).get(String(id)));
export const listWorlds = (limit = 20) => db.prepare(`SELECT * FROM worlds ORDER BY created_at DESC LIMIT ?`).all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20))).map(rowOut);

async function writeSpec(id, request, facts) {
  let feedback = null, last = null;
  for (let n = 1; n <= 3; n++) {
    setW(id, { stage: `writing the world${n > 1 ? `, attempt ${n}` : ''}` });
    const raw = await chatOllama(worldMessages(request, facts?.text || null, feedback), { format: 'json', temperature: 0.5, maxTokens: 1400, priority: 'goal', label: 'worlds:spec', timeoutMs: 180_000 });
    const r = checkWorldSpec(raw, { facts: facts?.text || null, request });
    if (r.ok) return { ...r, attempts: n };
    feedback = r.reason; last = r.reason;
  }
  throw new Error(`no usable world description after 3 attempts (${last})`);
}

async function runWorld(id, { request, file }) {
  const t0 = now();
  setW(id, { status: 'running', stage: 'starting' });
  let dir = null;
  try {
    let data = null, picFacts = null;
    if (file) { setW(id, { stage: 'reading the picture' }); data = await worldFromPicture(readFileSync(shelfFile(file))); }
    const facts = request ? await groundFacts(placeOf(request)) : { text: null, why: 'made from a picture' };
    setW(id, { facts: { source: facts.source || null, url: facts.url || null, why: facts.why } });
    const { spec, fixes, attempts } = request
      ? await writeSpec(id, request, facts)
      : { spec: checkWorldSpec({ name: `World from ${file}`, summary: 'A landscape read from a picture: its brightness is the height, its colours the ground.', water: 0.12, landmarks: [] }).spec, fixes: [], attempts: 0 };
    if (data) { spec.data = data; spec.water = Math.min(spec.water, 0.15); }
    setW(id, { stage: 'building the page', spec: { ...spec, data: data ? { size: data.size, fromPicture: file } : undefined } });
    const slug = slugFor(spec.name, id.slice(6));
    dir = join(SITES_DIR, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), worldPage(spec, { credit: facts.source ? `Facts: ${facts.source}` : '' }), 'utf8');
    const url = `http://127.0.0.1:${PORT}/sites/${slug}/`;
    setW(id, { stage: 'opening it in a browser' });
    const seen = await verifyPage(url, { motionExpected: true });
    setW(id, { stage: 'walking through it' });
    const walk = seen.ok ? await walkCheck(url) : null;
    const check = { inBrowser: seen.ok, problems: [...seen.problems, ...(walk?.problems || [])], colours: seen.colours, movedOnItsOwn: seen.moved, walk };
    if (!seen.ok || !walk?.ok) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('[worlds] cleanup:', e.message); }
      throw Object.assign(new Error(`the world failed its check: ${check.problems.slice(0, 3).join('; ')}`), { check });
    }
    if (seen.screenshot) writeFileSync(join(dir, 'preview.png'), seen.screenshot);
    const page = { slug, title: spec.name, request: request || `world from ${file}`, kind: 'world', fixes, attempts, facts: { source: facts.source || null, why: facts.why }, checked: check, madeAt: new Date().toISOString() };
    writeFileSync(join(dir, 'page.json'), JSON.stringify(page, null, 2), 'utf8');
    setW(id, { status: 'completed', stage: 'done', slug, check_result: { ...check, fixes, attempts, seconds: +((now() - t0) / 1000).toFixed(1) }, completed_at: now() });
    emit({ action: 'world_ready', id, slug, name: spec.name });
  } catch (e) {
    setW(id, { status: 'error', stage: 'failed', error: clip(e.message, 600), check_result: e.check || null, completed_at: now() });
    emit({ action: 'world_failed', id, error: clip(e.message, 200) });
  }
}

/** Start a world from words (`request`) or from a shelf picture (`file`). Returns at once. */
export function startWorld({ request = '', file = null, source = 'api' } = {}) {
  const text = clip(request, 600).replace(/\s+/g, ' ').trim();
  if (!text && !file) throw Object.assign(new Error('say what world to make (request) or name a picture on the shelf (file)'), { status: 400 });
  if (file) shelfFile(file);                                          // throws a 404 when it is not there
  const id = `world-${randomUUID().slice(0, 10)}`;
  db.prepare(`INSERT INTO worlds (id, request, source_file, status, stage, created_at) VALUES (?, ?, ?, 'queued', 'queued', ?)`).run(id, text, file, now());
  const done = jobsTail.p.then(() => withOrigin({ via: id }, () => runWorld(id, { request: text, file })));
  jobsTail.p = done.catch(e => console.error('[worlds] queue:', e.message));
  return { id, status: 'queued', done };
}

// ── tools and routes ─────────────────────────────────────────────────────────────────────────────────

export function createWorldTools() {
  return [
    { name: 'world.create', group: 'studio', risk: 'safe', ownsReply: true,
      description: 'Make a walkable 3-D world as a web page (walk, look around, fly), from words — a real place ("the Isle of Skye") or an imagined one ("a desert planet with glass towers") — or from a picture on the shelf, whose brightness becomes the land. Real places are checked against their Wikipedia article and get no invented landmarks. The page is opened in a real browser and walked through before it is kept; it appears under Sites. Returns a job id; a world takes about a minute.',
      parameters: { type: 'object', properties: { request: { type: 'string', description: "The world, in the user's words" }, file: { type: 'string', description: 'Optional: a picture on the shelf to build the land from' } } },
      execute: async ({ args = {} } = {}) => {
        try {
          const r = startWorld({ request: args.request, file: args.file, source: 'agent' });
          return { jobId: r.id, status: r.status, replyToUser: `I have started the world. It is not finished yet: it is written, built, then opened in a real browser and walked through, and it appears under Sites only if that works. Job ${r.id}.` };
        } catch (e) { return { error: clip(e.message, 300), replyToUser: `I did not start the world. ${clip(e.message, 300)}` }; }
      } },
    { name: 'world.status', group: 'studio', risk: 'safe',
      description: 'Progress and result of a walkable world started with world.create: stage, the page address, what the browser check saw.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: async ({ args = {} } = {}) => (args.id ? (getWorld(args.id) || { error: 'no such world' }) : { worlds: listWorlds(5) }) },
  ];
}

export function installWorldRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message }) : next(e)));
  app.get('/api/worlds', route((req, res) => res.json({ worlds: listWorlds(req.query.limit), kinds: LANDMARK_KINDS })));
  app.post('/api/worlds', route((req, res) => { const r = startWorld({ ...(req.body || {}), source: 'api' }); res.status(202).json({ id: r.id, status: r.status }); }));
  app.get('/api/worlds/:id', route((req, res) => { const w = getWorld(req.params.id); if (!w) return res.status(404).json({ error: 'no such world' }); res.json(w); }));
}
