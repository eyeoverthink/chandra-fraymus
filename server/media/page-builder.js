/**
 * Page builder — a typed request for a web page becomes one self-contained HTML file that has been
 * opened in a real browser and seen to work, saved where the library lists it.
 *
 * Why it exists (2026-11-10): asked for "a single page web application of an animated 3d world map",
 * the home agent called the film tool, was refused, then pasted Three.js code into the chat — code that
 * declared the same constant twice and imported a library the page could never load — described it as
 * working, and saved nothing. Three faults: wrong tool, unverified claim, no artifact. This module is
 * the right tool, and it only reports what a browser showed.
 *
 *   write   a coding model returns one HTML document: inline CSS and JavaScript, no network at all
 *   check   static rules (complete document, no external URL, no bare imports, nothing elided)
 *   run     the page is saved under data/sites/<slug>/ and loaded from the server's own /sites route —
 *           so under the same Content-Security-Policy a person's browser will apply — in headless
 *           Chromium; script errors, blocked requests and console errors are collected, and two
 *           screenshots 1.2 s apart show whether anything is drawn and whether it moves
 *   retry   whatever failed is sent back to the writer, word for word, up to three attempts
 *
 * A page that never passes is not kept in the library: the job fails and says what the browser saw.
 * The drafts stay in the job's folder for inspection.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { DATA_DIR, PORT } from '../config.js';
import { kitBrief, applyKits } from './page-kit.js';

export const SITES_DIR = join(DATA_DIR, 'sites');
export const MAX_PAGE_BYTES = 300_000;
const clip = (s, n) => String(s ?? '').slice(0, n);

/** Does the request ask for something that moves? Then two screenshots must differ. */
export const wantsMotion = text => /\b(animat\w*|spinning|spins?|rotat\w*|moving|moves?|bouncing|flowing|live|game|simulation|clock|timer|particles?|orbit\w*|scroll\w*)\b/i.test(String(text || ''));

/** Chat messages asking a coding model for the page. `feedback` is what the browser reported about the previous attempt. */
export function pageMessages(request, feedback = null) {
  const system = [
    'You write complete, working single-file web pages.',
    'Reply with exactly one fenced code block, ```html … ```, holding the whole document from <!DOCTYPE html> to </html>. No explanation before or after.',
    'Hard rules — the page is opened offline under a strict content policy, so breaking any of these makes it fail:',
    '- Everything is inline: one <style> and one <script> inside the file. No external files of any kind: no CDN, no <script src>, no <link href>, no web fonts, no images from a URL, no fetch, no import statements. Three.js, D3 and every other library are NOT available — use the Canvas 2D API or raw WebGL that you write yourself.',
    '- Write all of the code. Never leave a placeholder, a "TODO", a "rest of the code here" comment or an empty function that the page depends on.',
    '- The page fills the browser window, adapts when the window is resized, and shows something as soon as it loads.',
    '- If it should move, drive it with requestAnimationFrame so it is already moving one second after load, with no click needed.',
    '- Declare every variable once. Check that every function you call exists. No alert(), prompt() or confirm().',
    '- Put a <title> in the head and a small, unobtrusive caption on the page saying what it is.',
    '- Honesty: you have no data files. If the request needs real-world data you do not have (true coastlines, country borders, photographs, live figures), draw a clearly stylised version and say so in the caption, for example "stylised continents, not a real map". Never present invented data as real.',
    '- Keep it under 250 lines unless the request truly needs more.',
  ].join('\n');
  const user = `Build this page: ${request}` + (feedback ? `\n\nYour previous page was opened in a browser and did not pass. This is what happened:\n${feedback}\nWrite the whole page again with that fixed.` : '');
  // a tested component for what a model cannot make from memory (real coastlines); see page-kit.js
  const kit = kitBrief(request);
  return [{ role: 'system', content: kit ? `${system}\n\nCOMPONENT FOR THIS REQUEST\n${kit}` : system }, { role: 'user', content: user }];
}

/** Pull the HTML document out of a model reply (a fenced block, or a bare document). */
export function extractHtml(reply) {
  const s = String(reply || '');
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(s);
  let html = fence ? fence[1] : s;
  const start = html.search(/<!doctype html|<html[\s>]/i);
  if (start < 0) return null;
  const end = html.toLowerCase().lastIndexOf('</html>');
  html = end > start ? html.slice(start, end + 7) : html.slice(start);
  return html.trim() + '\n';
}

/** Rules a page must meet before a browser is started for it. Returns a list of problems (empty = pass). */
export function staticCheck(html) {
  const problems = [];
  if (!html) return ['The reply did not contain an HTML document.'];
  const bytes = Buffer.byteLength(html);
  if (bytes > MAX_PAGE_BYTES) problems.push(`The page is ${Math.round(bytes / 1000)} KB; the limit is ${MAX_PAGE_BYTES / 1000} KB.`);
  if (!/<\/html>\s*$/i.test(html)) problems.push('The document is cut off: it does not end with </html>.');
  if (!/<body[\s>]/i.test(html)) problems.push('There is no <body>.');
  if (!/<title>[^<]{1,120}<\/title>/i.test(html)) problems.push('There is no <title>.');
  // any network reference: the page is served with connect-src 'none' and only same-origin files, and there are none
  const withoutNs = html.replace(/xmlns(?::\w+)?\s*=\s*["'][^"']*["']/gi, '').replace(/createElementNS\(\s*["'][^"']*["']/gi, 'createElementNS(""');
  const urls = [...withoutNs.matchAll(/\bhttps?:\/\/[^\s"'`)<>]+|(?<=["'(=])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`)<>]*/gi)].map(m => m[0]);
  if (urls.length) problems.push(`It refers to the network (${clip([...new Set(urls)].slice(0, 3).join(', '), 160)}). Nothing outside the file can load; write that part yourself.`);
  if (/<script[^>]*\bsrc\s*=/i.test(html)) problems.push('It has <script src=…>. All JavaScript must be inline.');
  if (/<link[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) problems.push('It links a stylesheet. All CSS must be inline.');
  if (/^\s*import\s+[\w*{][^;]*\sfrom\s+["'][^"']+["']/m.test(html) || /\bimport\s*\(\s*["']/.test(html)) problems.push('It uses an import statement. No library can be imported; write the code inline.');
  if (/\b(?:THREE|d3|Chart|PIXI|p5|BABYLON)\s*\./.test(html) && !/\b(?:const|let|var|class|function)\s+(?:THREE|d3|Chart|PIXI|p5|BABYLON)\b/.test(html)) problems.push('It uses a library (Three.js, D3 or similar) that is not on the page. Use Canvas 2D or your own WebGL.');
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/.test(html)) problems.push('It makes a network request. The page must work with no network.');
  if (/\/\/\s*(?:\.\.\.|rest of|remaining|todo|your code|add (?:more|your)|implement)|\/\*\s*\.\.\.\s*\*\/|<!--\s*\.\.\.\s*-->/i.test(html)) problems.push('Part of the code is left out with a placeholder comment. Write all of it.');
  if (/\b(?:alert|prompt|confirm)\s*\(/.test(html)) problems.push('It calls alert(), prompt() or confirm().');
  return problems;
}

/** A folder name for the page: words from its title, plus a short id so two pages never collide. */
export function slugFor(title, id) {
  const base = String(title || 'page').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'page';
  return `${base}-${String(id).replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase()}`;
}

export const titleOf = html => clip((/<title>([^<]*)<\/title>/i.exec(html || '') || [])[1] || '', 80).trim();

/** What a screenshot shows: how many distinct colours (coarsely) and how much of it differs from another. */
async function pictureStats(png) {
  const { data, info } = await sharp(png).resize(160, 100, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const seen = new Set();
  for (let i = 0; i < data.length; i += 3) seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
  return { colours: seen.size, data, pixels: info.width * info.height };
}

function changedFraction(a, b) {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 3) if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 24) changed++;
  return changed / a.pixels;
}

let browserPromise = null;
async function getBrowser() {
  if (browserPromise) { const b = await browserPromise.catch(() => null); if (b?.connected) return b; browserPromise = null; }
  browserPromise = (async () => {
    const puppeteer = (await import('puppeteer')).default;
    // software GL so raw WebGL pages can be judged on a machine whose card is busy or absent
    const b = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800'], defaultViewport: { width: 1280, height: 800 } });
    b.on('disconnected', () => { browserPromise = null; });
    return b;
  })();
  return browserPromise;
}
process.once('exit', () => { browserPromise?.then(b => b.close()).catch(() => {}); });

/**
 * Open a page in headless Chromium and report what happened.
 * @returns {{ ok, problems: string[], errors: string[], blocked: string[], colours, moved, motionExpected, screenshot: Buffer|null }}
 */
export async function verifyPage(url, { motionExpected = false } = {}) {
  const errors = [], blocked = [], problems = [];
  let page, shotB = null, colours = 0, moved = 0;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    page.on('pageerror', e => errors.push(clip(e.message, 240)));
    page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (/favicon.ico/i.test(m.location()?.url || '')) return;   // every browser asks for an icon; a page without one is not broken
      if (/Content Security Policy|Refused to/i.test(t)) blocked.push(clip(t, 200)); else errors.push(clip(t, 240)); } });
    page.on('requestfailed', r => { if (!r.url().startsWith(url) && !/favicon.ico/i.test(r.url())) blocked.push(clip(`${r.url()} (${r.failure()?.errorText || 'failed'})`, 200)); });
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20_000 });
    if (!res || !res.ok()) problems.push(`The page did not load (HTTP ${res ? res.status() : 'no response'}).`);
    await new Promise(r => setTimeout(r, 1500));
    const shotA = await page.screenshot({ type: 'png' });
    await new Promise(r => setTimeout(r, 1200));
    shotB = await page.screenshot({ type: 'png' });
    const a = await pictureStats(shotA), b = await pictureStats(shotB);
    colours = b.colours; moved = +changedFraction(a, b).toFixed(4);
    const text = await page.evaluate(() => (document.body?.innerText || '').trim().length).catch(() => 0);
    if (colours < 4 && text < 20) problems.push('The page is blank: one flat colour and almost no text one second after loading.');
    if (motionExpected && moved < 0.002) problems.push('Nothing moved: two screenshots taken 1.2 seconds apart are identical, but the request asks for motion. Start the animation on load with requestAnimationFrame.');
  } catch (e) { problems.push(`The browser could not open the page: ${clip(e.message, 160)}`); }
  finally { try { await page?.close(); } catch (_) { /* already closed */ } }
  const uniq = list => [...new Set(list)].slice(0, 5);
  for (const e of uniq(errors)) problems.push(`JavaScript error: ${e}`);
  for (const b of uniq(blocked)) problems.push(`Blocked: ${b}`);
  return { ok: problems.length === 0, problems, errors: uniq(errors), blocked: uniq(blocked), colours, moved, motionExpected, screenshot: shotB };
}

/**
 * Write → check → run → retry. `ask(messages)` returns the model's reply; `onStage(text)` reports progress.
 * Resolves the kept page, or throws with what the browser saw on the last attempt.
 */
export async function buildPage({ id, request, ask, writers = [], draftsDir, onStage = () => {}, attempts = 3 }) {
  mkdirSync(draftsDir, { recursive: true });
  const log = [];
  let feedback = null, last = null;
  for (let n = 1; n <= attempts; n++) {
    onStage(`writing the page${n > 1 ? `, attempt ${n}` : ''}`);
    let reply, by;
    try { ({ reply, by } = await ask(pageMessages(request, feedback))); }
    catch (e) { log.push({ attempt: n, by: null, problems: [`the writer did not answer: ${clip(e.message, 160)}`] }); feedback = null; continue; }
    const html = extractHtml(reply);
    if (html) writeFileSync(join(draftsDir, `attempt-${n}.html`), html, 'utf8');
    let problems = staticCheck(html);
    // components are added after the static rules, which judge only what the writer wrote
    const kit = html ? applyKits(html, request) : { html, used: [], problems: [] };
    problems = problems.concat(kit.problems);
    const finalHtml = kit.html;
    let seen = null, slug = null;
    if (!problems.length) {
      slug = slugFor(titleOf(html), `${id}${n}`);
      const dir = join(SITES_DIR, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), finalHtml, 'utf8');
      onStage(`opening it in a browser${n > 1 ? `, attempt ${n}` : ''}`);
      seen = await verifyPage(`http://127.0.0.1:${PORT}/sites/${slug}/`, { motionExpected: wantsMotion(request) });
      problems = seen.problems;
      if (seen.ok) {
        if (seen.screenshot) writeFileSync(join(dir, 'preview.png'), seen.screenshot);
        const page = { slug, title: titleOf(html), request, bytes: Buffer.byteLength(finalHtml), lines: html.split('\n').length, components: kit.used, writtenBy: by, attempts: n,
          checked: { inBrowser: true, javascriptErrors: 0, blockedRequests: 0, colours: seen.colours, movedFraction: seen.moved, motionExpected: seen.motionExpected }, madeAt: new Date().toISOString() };
        writeFileSync(join(dir, 'page.json'), JSON.stringify({ ...page, job: id, earlierAttempts: log }, null, 2), 'utf8');
        return { ...page, dir, log, hasPreview: !!seen.screenshot };
      }
      // not good enough to keep: it must not sit in the library looking finished
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('[page-builder] cleanup:', e.message); }
    }
    log.push({ attempt: n, by, problems, colours: seen?.colours ?? null, moved: seen?.moved ?? null });
    feedback = problems.map(p => `- ${p}`).join('\n');
    last = problems;
  }
  const err = new Error(`no working page after ${attempts} attempts. Last attempt: ${clip((last || ['the writer gave no page']).join(' '), 400)}`);
  err.log = log;
  throw err;
}

export function pageExists(slug) { return existsSync(join(SITES_DIR, String(slug), 'index.html')); }
