/**
 * Platform games: words or a picture become a side-scrolling game page you can play and win.
 *
 * Gap 6 in docs/NEXUS-ENGINE-CREATION-METHODS.md (Nexus's GameDevSuite and SceneGameAbstractor, methods 17–18: a
 * picture quantised to a tile grid, a tile platformer, standalone export — with no check that a level can be won).
 *   from words   — the model pool chooses a name, a palette and a difficulty; page-kit/platformer.js generates the
 *                  level from a seed
 *   from a picture — looks.layers splits it: the subject (cut out) is the hero, the background plate is the backdrop,
 *                  and the plate read as a tile grid (layers.levelFromPicture, 64 × 14) is the level
 *   either way   — the level goes through `makePlayable`: a reachability search with the game's own jump numbers, and
 *                  steps added where it stops, until the goal can be reached. Then coins, start and goal.
 *   check        — the page opens in headless Chromium (draws, moves on its own), then it is played: running right
 *                  must move the hero, a jump must leave the ground and land again; the level must be winnable by
 *                  the search. A game that fails is removed from Sites.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { db } from '../db.js';
import { PORT, mayRecoverAtBoot, DATA_DIR } from '../config.js';
import { withOrigin } from '../intelligence/card-ledger.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { SITES_DIR, verifyPage, withBrowserPage, slugFor } from './page-builder.js';
import { shelfFile } from './looks/convert.js';
import { image as rgbImage } from './looks/filters.js';
import { levelFromPicture } from './looks/layers.js';
import { startLayers, lookJob } from './looks/index.js';

const sharp = createRequire(import.meta.url)('sharp');
const KIT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'page-kit', 'platformer.js');
const clip = (s, n) => String(s ?? '').slice(0, n);
const now = () => Date.now();
const HEX = /^#[0-9a-f]{6}$/i;
const emit = p => { try { publish('studio', 'system.studio', JSON.stringify(p)); } catch (e) { console.error('[games] publish:', e.message); } };

// the kit is a browser script; the server runs its level functions too, so a level is judged by the same code that plays it
let kit = null;
export function platformerKit() {
  if (kit) return kit;
  const g = {}; new Function('globalThis', 'window', readFileSync(KIT_PATH, 'utf8'))(g, undefined);
  kit = g.ChandraPlatformer;
  return kit;
}

db.exec(`CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, request TEXT, source_file TEXT, status TEXT NOT NULL, stage TEXT, slug TEXT, spec TEXT, check_result TEXT, error TEXT, created_at INTEGER, completed_at INTEGER)`);
if (mayRecoverAtBoot()) db.prepare(`UPDATE games SET status = 'error', error = 'interrupted by restart', completed_at = ? WHERE status IN ('queued', 'running')`).run(now());

// ── spec from words ──────────────────────────────────────────────────────────────────────────────────

export function gameMessages(request, feedback = null) {
  return [
    { role: 'system', content: 'You set up a small side-scrolling platform game for a browser. Reply with ONE JSON object and nothing else: {"name": short title, "tagline": one sentence, "seed": integer, "difficulty": 1 | 2 | 3, "palette": {"sky": ["#top", "#bottom"], "ground": "#rrggbb", "platform": "#rrggbb", "accent": "#rrggbb" (coins and flag), "hero": "#rrggbb"}}. Colours should fit the theme asked for, and the hero and coins must stand out against the sky and the ground.' },
    { role: 'user', content: `Game to make: ${request}${feedback ? `\n\nYour last answer was not usable: ${feedback}` : ''}` },
  ];
}

const DEFAULT_PAL = { sky: ['#6ec6ff', '#e0f6ff'], ground: '#5b8c3a', platform: '#c58b4b', accent: '#ffd23f', hero: '#7b61ff' };
export function checkGameSpec(raw) {
  let o = raw;
  if (typeof raw === 'string') { const a = raw.indexOf('{'), z = raw.lastIndexOf('}'); try { o = a >= 0 && z > a ? JSON.parse(raw.slice(a, z + 1)) : null; } catch (_) { o = null; } }
  if (!o || typeof o !== 'object') return { ok: false, reason: 'not a JSON object' };
  const p = o.palette || {}, fixes = [];
  const palette = {};
  for (const k of ['ground', 'platform', 'accent', 'hero']) { if (HEX.test(String(p[k] || ''))) palette[k] = String(p[k]).toLowerCase(); else { palette[k] = DEFAULT_PAL[k]; fixes.push(`palette.${k}: default`); } }
  palette.sky = Array.isArray(p.sky) && p.sky.length === 2 && p.sky.every(c => HEX.test(String(c))) ? p.sky.map(c => String(c).toLowerCase()) : (fixes.push('palette.sky: default'), DEFAULT_PAL.sky);
  const d = Number(o.difficulty);
  return { ok: true, fixes, spec: { name: clip(String(o.name || 'A platform game').trim(), 60), tagline: clip(String(o.tagline || '').trim(), 160),
    seed: Number.isInteger(o.seed) ? Math.abs(o.seed) % 1e6 : 7, difficulty: [1, 2, 3].includes(d) ? d : 2, palette } };
}

// ── level from a picture ─────────────────────────────────────────────────────────────────────────────

/** Rows of a level read from a picture; its columns follow the picture's width (16:9 → 28). */
export const PICTURE_ROWS = 16;

/** A picture's tile grid (open where it is like the sky, solid elsewhere), made winnable and decorated. */
export function levelFromImage(img, { cols = 64, rows = 14, seed = 7 } = {}) {
  const K = platformerKit();
  const raw = levelFromPicture(img, { cols, rows }).tiles;
  const fixed = K.level.makePlayable(raw);
  return { tiles: K.level.decorate(fixed.tiles, seed), fixes: fixed.fixes, reachable: fixed.reachable };
}

async function dataUrl(bytes, { height, format = 'png' }) {
  const s = sharp(bytes).resize({ height, withoutEnlargement: true });
  const b = format === 'jpeg' ? await s.flatten({ background: '#ffffff' }).jpeg({ quality: 72 }).toBuffer() : await s.png().toBuffer();
  return `data:image/${format};base64,${b.toString('base64')}`;
}

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function gamePage(spec) {
  const code = readFileSync(KIT_PATH, 'utf8');
  if (/<\/script/i.test(code)) throw new Error('platformer.js must not contain a closing script tag');
  const data = JSON.stringify(spec).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(spec.name)}</title>
<style>
html,body{margin:0;height:100%;background:#0b0f18;color:#eef2f8;font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
#game{position:fixed;inset:0;width:100vw;height:100vh;display:block;touch-action:none}
.title{position:fixed;right:14px;top:12px;text-align:right;background:rgba(10,14,24,.55);border-radius:10px;padding:8px 12px;max-width:min(380px,60vw)}
.title b{display:block;font-size:17px}.title span{font-size:12.5px;opacity:.85}
.help{position:fixed;left:14px;bottom:12px;font-size:12px;background:rgba(10,14,24,.55);border-radius:8px;padding:6px 10px}
.pad{position:fixed;inset:auto 0 14px 0;display:none;justify-content:space-between;padding:0 14px;pointer-events:none}
.pad div{display:flex;gap:10px;pointer-events:auto}
.pad button{width:64px;height:64px;border-radius:16px;border:1px solid rgba(255,255,255,.3);background:rgba(10,14,24,.55);color:#fff;font-size:24px}
@media (pointer:coarse){.pad{display:flex}.help{display:none}}
</style></head><body>
<canvas id="game" aria-label="${esc(spec.name)}: a platform game"></canvas>
<div class="title"><b>${esc(spec.name)}</b>${spec.tagline ? `<span>${esc(spec.tagline)}</span>` : ''}</div>
<div class="help">← → or A D run · Space / ↑ jump (hold for higher) · reach the flag</div>
<div class="pad"><div><button data-k="left" aria-label="left">◀</button><button data-k="right" aria-label="right">▶</button></div><div><button data-k="jump" aria-label="jump">⤒</button></div></div>
<script>
${code}
</script>
<script>
(function(){
  var spec = ${data};
  var game = ChandraPlatformer.mount(document.getElementById('game'), spec);
  document.querySelectorAll('.pad button').forEach(function(b){
    var k = b.getAttribute('data-k');
    b.addEventListener('pointerdown', function(e){ e.preventDefault(); game.press(k, true); });
    ['pointerup','pointerleave','pointercancel'].forEach(function(ev){ b.addEventListener(ev, function(){ game.press(k, false); }); });
  });
})();
</script></body></html>`;
}

// ── the check ────────────────────────────────────────────────────────────────────────────────────────

/** Play the page a little: run right (jumping now and then), and one standing jump that leaves the ground and lands. */
export async function playCheck(url, { cpuThrottle = 0 } = {}) {
  return withBrowserPage(async page => {
    const errors = [];
    page.on('pageerror', e => errors.push(clip(e.message, 200)));
    await page.setViewport({ width: 1280, height: 720 });
    // tests slow the page's CPU to reproduce a loaded machine (few frames a second)
    if (cpuThrottle > 1) await (await page.createCDPSession()).send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    await new Promise(r => setTimeout(r, 900));
    const st = () => page.evaluate(() => window.__chandraGame && window.__chandraGame.state());
    const s0 = await st();
    if (!s0) return { ok: false, problems: ['the page has no game handle (the component did not mount)'], errors };
    const problems = [];
    // every wait is in GAME time (state().time), not wall time: a loaded machine draws fewer frames, and a check
    // timed by the wall clock then fails a game that plays correctly (seen in a full test run)
    const waitGame = async (seconds, until = null) => {
      const start = (await st()).time, wallEnd = Date.now() + Math.max(8_000, seconds * 6_000);
      for (;;) {
        const s = await st();
        if ((until && until(s)) || s.time - start >= seconds || Date.now() > wallEnd) return s;
        await new Promise(r => setTimeout(r, 30));
      }
    };
    // standing still, the hero is on the ground at every reading (coyote time and jumps depend on it)
    let airborne = 0;
    for (let i = 0; i < 10; i++) { if (!(await st()).ground) airborne++; await new Promise(r => setTimeout(r, 25)); }
    if (airborne) problems.push(`standing still, the hero read as in the air ${airborne} of 10 times`);
    // a standing jump held for 0.3 s: it must take off, rise at least a tile and land within 1.5 s more. The rise is
    // the game's own record of the jump's highest point — the software renderer draws ~10 frames a second, and a
    // reading between frames once caught the hero on the way down (0.5 tiles for a 1.56-tile jump)
    const before = await st();
    await page.keyboard.down('Space');
    await waitGame(0.3);
    await page.keyboard.up('Space');
    const after = await waitGame(1.5, s => s.ground && s.jumps > before.jumps);
    const jumped = after.jumps > before.jumps ? after.rise : 0;
    if (!(jumped >= 1)) problems.push(after.jumps > before.jumps ? `a jump rose only ${jumped.toFixed(2)} tiles` : 'pressing jump did not make the hero jump');
    if (!after.ground) problems.push('after a jump the hero did not land');
    // run right for about two seconds, holding jump 0.3 s at a time as a player does (a tap is a short hop by design)
    const r0 = await st();
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 6; i++) { await page.keyboard.down('Space'); await waitGame(0.3); await page.keyboard.up('Space'); await waitGame(0.05); }
    await page.keyboard.up('ArrowRight');
    const r1 = await st();
    const ran = r1.x - r0.x;
    if (ran < 3) problems.push(`running right for two seconds moved only ${ran.toFixed(1)} tiles`);
    for (const e of errors) problems.push(`JavaScript error: ${e}`);
    return { ok: !problems.length, problems, jumped: +jumped.toFixed(2), landed: after.ground, ran: +ran.toFixed(1), coinsOnTheWay: r1.coins, falls: r1.deaths, errors };
  });
}

// ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────

const tail = { p: Promise.resolve() };
const setG = (id, f) => { const k = Object.keys(f); db.prepare(`UPDATE games SET ${k.map(x => `${x} = ?`).join(', ')} WHERE id = ?`).run(...k.map(x => (typeof f[x] === 'object' && f[x] !== null ? JSON.stringify(f[x]) : f[x])), id); };
const rowOut = r => r && ({ id: r.id, request: r.request, sourceFile: r.source_file, status: r.status, stage: r.stage, slug: r.slug, url: r.slug ? `/sites/${r.slug}/` : null,
  spec: r.spec ? JSON.parse(r.spec) : null, check: r.check_result ? JSON.parse(r.check_result) : null, error: r.error, createdAt: r.created_at, completedAt: r.completed_at });
export const getGame = id => rowOut(db.prepare(`SELECT * FROM games WHERE id = ?`).get(String(id)));
export const listGames = (limit = 20) => db.prepare(`SELECT * FROM games ORDER BY created_at DESC LIMIT ?`).all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20))).map(rowOut);

async function waitLayers(job, onStage) {
  const t0 = now();
  for (;;) {
    const j = lookJob(job.id);
    if (!j) throw new Error('the layers job disappeared');
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw Object.assign(new Error(j.error), { partial: j.partial || null });
    onStage(`splitting the picture: ${j.stage}`);
    if (now() - t0 > 20 * 60_000) throw new Error('splitting the picture took over 20 minutes');
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function runGame(id, { request, file, plate }) {
  const t0 = now(), K = platformerKit();
  setG(id, { status: 'running', stage: 'starting' });
  let dir = null;
  try {
    let spec, fixes = [], notes = [];
    if (file) {
      // the picture: its subject is the hero, its background the backdrop and the level
      let hero = null, backdropBytes = readFileSync(shelfFile(file)), layers = null;
      try {
        layers = await waitLayers(startLayers({ file, plate: plate === 'paint' ? 'paint' : 'fill', context: request || '' }), s => setG(id, { stage: s }));
        hero = await dataUrl(readFileSync(join(DATA_DIR, 'media', layers.subject)), { height: 160 });
        backdropBytes = readFileSync(join(DATA_DIR, 'media', layers.plate));
      } catch (e) {
        // a refused background plate still leaves a good cut-out subject: use it as the hero over the original picture
        const subject = e.partial?.subject ? join(DATA_DIR, 'media', e.partial.subject) : null;
        if (subject && existsSync(subject)) {
          hero = await dataUrl(readFileSync(subject), { height: 160 });
          notes.push(`the background could not be cleanly filled (${clip(e.message, 120)}): the cut-out subject is the hero, over the original picture (so it also shows in the backdrop)`);
        } else notes.push(`the picture could not be split (${clip(e.message, 140)}): it is the backdrop, and the hero is drawn`);
      }
      setG(id, { stage: 'reading the level from the picture' });
      const { data, info } = await sharp(backdropBytes).rotate().removeAlpha().resize({ width: 960, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
      // the grid keeps the picture's shape (square cells), because the picture is drawn under the level cell for cell
      const rows = PICTURE_ROWS, cols = Math.max(24, Math.min(96, Math.round(rows * info.width / info.height)));
      const lvl = levelFromImage(rgbImage(info.width, info.height, new Uint8ClampedArray(data)), { seed: 7, cols, rows });
      fixes = lvl.fixes;
      const words = request ? checkGameSpec(await chatOllama(gameMessages(request), { format: 'json', temperature: 0.5, maxTokens: 500, priority: 'goal', label: 'games:spec', timeoutMs: 120_000 }).catch(e => { notes.push(`no name from the model (${clip(e.message, 80)})`); return '{}'; })) : null;
      spec = { name: words?.ok && request ? words.spec.name : `A game from ${file}`, tagline: words?.ok ? words.spec.tagline : 'A level read from a picture.', tiles: lvl.tiles,
        palette: { ...DEFAULT_PAL, ...(words?.ok ? words.spec.palette : {}), sky: ['#0b0f18', '#0b0f18'] }, hero, backdrop: await dataUrl(backdropBytes, { height: 540, format: 'jpeg' }), backdropMode: 'level' };
    } else {
      let r = null, feedback = null;
      for (let n = 1; n <= 3 && !r?.ok; n++) {
        setG(id, { stage: `setting up the game${n > 1 ? `, attempt ${n}` : ''}` });
        r = checkGameSpec(await chatOllama(gameMessages(request, feedback), { format: 'json', temperature: 0.5, maxTokens: 500, priority: 'goal', label: 'games:spec', timeoutMs: 120_000 }));
        feedback = r.reason;
      }
      if (!r?.ok) throw new Error(`no usable game set-up (${r?.reason})`);
      fixes = r.fixes;
      spec = { ...r.spec, tiles: K.level.generate({ seed: r.spec.seed, cols: 64, rows: 14, difficulty: r.spec.difficulty }) };
    }
    const win = K.level.reachable(spec.tiles), W = spec.tiles[0].length;
    if (win.maxCol < W - 3) throw new Error(`the level cannot be won (the search reaches column ${win.maxCol} of ${W})`);
    setG(id, { stage: 'building the page', spec: { ...spec, hero: spec.hero ? '(sprite)' : null, backdrop: spec.backdrop ? '(picture)' : null } });
    const slug = slugFor(spec.name, id.slice(5));
    dir = join(SITES_DIR, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), gamePage(spec), 'utf8');
    const url = `http://127.0.0.1:${PORT}/sites/${slug}/`;
    setG(id, { stage: 'opening it in a browser' });
    const seen = await verifyPage(url, { motionExpected: true });
    setG(id, { stage: 'playing it' });
    const play = seen.ok ? await playCheck(url) : null;
    const check = { inBrowser: seen.ok, problems: [...seen.problems, ...(play?.problems || [])], movedOnItsOwn: seen.moved, play, winnable: { reachedColumn: win.maxCol, of: W, standingCells: win.count } };
    if (!seen.ok || !play?.ok) {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('[games] cleanup:', e.message); }
      // fixes and notes go with the failure too: a failed picture game once lost the reason its subject was not cut out
      throw Object.assign(new Error(`the game failed its check: ${check.problems.slice(0, 3).join('; ')}`), { check: { ...check, fixes, notes } });
    }
    if (seen.screenshot) writeFileSync(join(dir, 'preview.png'), seen.screenshot);
    writeFileSync(join(dir, 'page.json'), JSON.stringify({ slug, title: spec.name, request: request || `game from ${file}`, kind: 'game', fixes, notes, checked: check, madeAt: new Date().toISOString() }, null, 2), 'utf8');
    setG(id, { status: 'completed', stage: 'done', slug, check_result: { ...check, fixes, notes, seconds: +((now() - t0) / 1000).toFixed(1) }, completed_at: now() });
    emit({ action: 'game_ready', id, slug, name: spec.name });
  } catch (e) {
    setG(id, { status: 'error', stage: 'failed', error: clip(e.message, 600), check_result: e.check || null, completed_at: now() });
    emit({ action: 'game_failed', id, error: clip(e.message, 200) });
  }
}

/** Start a game from words (`request`) or a shelf picture (`file`; `plate: 'paint'` repaints its background on the card). */
export function startGame({ request = '', file = null, plate = 'fill', source = 'api' } = {}) {
  const text = clip(request, 600).replace(/\s+/g, ' ').trim();
  if (!text && !file) throw Object.assign(new Error('say what game to make (request) or name a picture on the shelf (file)'), { status: 400 });
  if (file) shelfFile(file);
  const id = `game-${randomUUID().slice(0, 10)}`;
  db.prepare(`INSERT INTO games (id, request, source_file, status, stage, created_at) VALUES (?, ?, ?, 'queued', 'queued', ?)`).run(id, text, file, now());
  const done = tail.p.then(() => withOrigin({ via: id }, () => runGame(id, { request: text, file, plate })));
  tail.p = done.catch(e => console.error('[games] queue:', e.message));
  return { id, status: 'queued', done };
}

// ── tools and routes ─────────────────────────────────────────────────────────────────────────────────

export function createGameTools() {
  return [
    { name: 'game.create', group: 'studio', risk: 'safe', ownsReply: true,
      description: 'Make a playable side-scrolling platform game as a web page (run, jump, collect coins, reach the flag), from words (a theme: "a candy world at night") or from a picture on the shelf — its subject becomes the hero, its background the backdrop and the level. Every level is checked to be winnable, and the page is opened in a real browser and played before it is kept under Sites. Returns a job id.',
      parameters: { type: 'object', properties: { request: { type: 'string', description: "The game's theme, in the user's words" }, file: { type: 'string', description: 'Optional: a picture on the shelf to make the game from' } } },
      execute: async ({ args = {} } = {}) => {
        try {
          const r = startGame({ request: args.request, file: args.file, source: 'agent' });
          return { jobId: r.id, status: r.status, replyToUser: `I have started the game. It is not finished yet: the level is checked to be winnable, then the page is opened in a real browser and played, and it appears under Sites only if that works. Job ${r.id}.` };
        } catch (e) { return { error: clip(e.message, 300), replyToUser: `I did not start the game. ${clip(e.message, 300)}` }; }
      } },
    { name: 'game.status', group: 'studio', risk: 'safe',
      description: 'Progress and result of a platform game started with game.create: stage, page address, the play check.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: async ({ args = {} } = {}) => (args.id ? (getGame(args.id) || { error: 'no such game' }) : { games: listGames(5) }) },
  ];
}

export function installGameRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message }) : next(e)));
  app.get('/api/games', route((req, res) => res.json({ games: listGames(req.query.limit), reach: platformerKit().REACH, physics: platformerKit().PHYS })));
  app.post('/api/games', route((req, res) => { const r = startGame({ ...(req.body || {}), source: 'api' }); res.status(202).json({ id: r.id, status: r.status }); }));
  app.get('/api/games/:id', route((req, res) => { const g = getGame(req.params.id); if (!g) return res.status(404).json({ error: 'no such game' }); res.json(g); }));
}
