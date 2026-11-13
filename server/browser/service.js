import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import dns from 'node:dns/promises';
import { DATA_DIR } from '../config.js';
import { classifyHost } from '../fraymus-os/registry.js';

let puppeteer;
try { puppeteer = await import('puppeteer'); } catch { puppeteer = null; }

const SCREENSHOTS_DIR = join(DATA_DIR, 'screenshots');
try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

let browser = null;
const pages = new Map();

// Pages opened for agents are public-only: every agent may use the browser tools, and without this a page could
// open file:///…/.env, Chandra's own API on 127.0.0.1 (approvals included) or a device on the LAN, and hand the
// result back to the model (found 2026-11-12). Every request such a page makes — the navigation, redirects,
// subresources, its scripts' fetch/XHR — must be http(s) to a public address. Operator pages (Browser panel) are not limited.
const publicOnlyPages = new WeakSet();
const resolved = new Map();   // hostname -> { ok, at }
async function hostIsPublic(hostname) {
  if (classifyHost(hostname) !== 'public') return false;
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return true;   // a literal already classified
  const hit = resolved.get(hostname);
  if (hit && Date.now() - hit.at < 300_000) return hit.ok;
  let ok = false;
  try { ok = (await dns.lookup(hostname, { all: true })).every(a => classifyHost(a.address) === 'public'); }
  catch (e) { console.error('browser: lookup failed for', hostname, e.message); }
  resolved.set(hostname, { ok, at: Date.now() });
  if (resolved.size > 2000) resolved.delete(resolved.keys().next().value);
  return ok;
}
export async function assertPublicPageUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error(`not a URL: ${String(raw).slice(0, 80)}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('agents may open only http(s) pages');
  if (!(await hostIsPublic(u.hostname))) throw new Error(`${u.hostname} is not a public address; agents cannot open local or private pages`);
  return u.href;
}
const settle = p => Promise.resolve(p).catch(e => console.error('browser: request', e.message));
async function guardPage(page) {
  publicOnlyPages.add(page);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isInterceptResolutionHandled?.()) return;
    let u; try { u = new URL(request.url()); } catch { return settle(request.abort('blockedbyclient')); }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return settle(request.continue());
    if (!['http:', 'https:'].includes(u.protocol)) return settle(request.abort('blockedbyclient'));
    settle(hostIsPublic(u.hostname).then(ok => (ok ? request.continue() : request.abort('blockedbyclient'))));
  });
}

export async function launchBrowser() {
  if (!puppeteer) throw new Error('puppeteer not installed — run: npm install puppeteer');
  if (browser && browser.connected) return;
  browser = await puppeteer.default.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--disable-gpu', '--window-size=1280,900'],
    defaultViewport: { width: 1280, height: 900 },
  });
  browser.on('disconnected', () => { browser = null; pages.clear(); });
}

export async function closeBrowser() {
  if (browser) { await browser.close().catch(() => {}); browser = null; pages.clear(); }
}

export function browserStatus() {
  return {
    available: !!puppeteer,
    running: !!browser?.connected,
    pages: [...pages.entries()].map(([id, p]) => ({ id, url: p.url() })),
  };
}

export async function openPage(url, opts = {}) {
  if (opts.publicOnly && url) url = await assertPublicPageUrl(url);
  await launchBrowser();
  const page = await browser.newPage();
  if (opts.publicOnly) await guardPage(page);
  if (opts.userAgent) await page.setUserAgent(opts.userAgent);
  await page.setViewport({ width: opts.width || 1280, height: opts.height || 900 });
  const id = randomUUID().slice(0, 8);
  pages.set(id, page);
  page.once('close', () => pages.delete(id));
  if (url) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
    } catch (e) {
      console.error('browser: navigation failed:', e.message);
    }
  }
  return { pageId: id, url: page.url(), title: await page.title() };
}

export async function navigatePage(pageId, url) {
  const page = getPage(pageId);
  if (publicOnlyPages.has(page)) url = await assertPublicPageUrl(url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30_000 });
  return { url: page.url(), title: await page.title() };
}

export async function screenshotPage(pageId, opts = {}) {
  const page = getPage(pageId);
  const filename = `screenshot_${pageId}_${Date.now()}.png`;
  const filepath = join(SCREENSHOTS_DIR, filename);
  await page.screenshot({
    path: filepath,
    fullPage: !!opts.fullPage,
    type: 'png',
  });
  const base64 = (await page.screenshot({ encoding: 'base64', fullPage: !!opts.fullPage }));
  return { filepath, filename, url: page.url(), base64Preview: base64.slice(0, 200) + '...', sizeBytes: Buffer.byteLength(base64, 'base64') };
}

export async function extractText(pageId, opts = {}) {
  const page = getPage(pageId);
  const selector = opts.selector || 'body';
  const text = await page.$eval(selector, el => el.innerText).catch(() => '');
  const title = await page.title();
  const url = page.url();
  const truncated = text.slice(0, opts.maxChars || 12_000);
  return { title, url, text: truncated, charCount: text.length, truncated: text.length > (opts.maxChars || 12_000) };
}

export async function extractHtml(pageId, opts = {}) {
  const page = getPage(pageId);
  const selector = opts.selector || 'body';
  const html = await page.$eval(selector, el => el.innerHTML).catch(() => '');
  return { url: page.url(), html: html.slice(0, opts.maxChars || 24_000), truncated: html.length > (opts.maxChars || 24_000) };
}

export async function extractLinks(pageId) {
  const page = getPage(pageId);
  const links = await page.$$eval('a[href]', anchors =>
    anchors.slice(0, 200).map(a => ({ href: a.href, text: (a.innerText || '').trim().slice(0, 100) }))
  );
  return { url: page.url(), links };
}

export async function extractImages(pageId) {
  const page = getPage(pageId);
  const images = await page.$$eval('img[src]', imgs =>
    imgs.slice(0, 100).map(img => ({ src: img.src, alt: img.alt || '', width: img.naturalWidth, height: img.naturalHeight }))
  );
  return { url: page.url(), images };
}

export async function clickElement(pageId, selector) {
  const page = getPage(pageId);
  await page.click(selector);
  await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});
  return { url: page.url(), title: await page.title() };
}

export async function fillInput(pageId, selector, value) {
  const page = getPage(pageId);
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
  return { ok: true };
}

export async function evaluateJs(pageId, code) {
  const page = getPage(pageId);
  const result = await page.evaluate(code);
  return { result: JSON.stringify(result)?.slice(0, 8000) };
}

export async function scrollPage(pageId, direction = 'down', amount = 600) {
  const page = getPage(pageId);
  const delta = direction === 'up' ? -amount : amount;
  await page.evaluate(d => window.scrollBy(0, d), delta);
  await new Promise(r => setTimeout(r, 500));
  return { scrollY: await page.evaluate(() => window.scrollY) };
}

export async function closePage(pageId) {
  const page = pages.get(pageId);
  if (page) { await page.close().catch(() => {}); pages.delete(pageId); }
  return { ok: true };
}

export async function waitForSelector(pageId, selector, timeout = 5000) {
  const page = getPage(pageId);
  await page.waitForSelector(selector, { timeout });
  return { found: true, url: page.url() };
}

function getPage(id) {
  const page = pages.get(id);
  if (!page) throw Object.assign(new Error(`No browser page with id "${id}"`), { status: 404, code: 'page_not_found' });
  return page;
}
