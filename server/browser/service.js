import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { DATA_DIR } from '../config.js';

let puppeteer;
try { puppeteer = await import('puppeteer'); } catch { puppeteer = null; }

const SCREENSHOTS_DIR = join(DATA_DIR, 'screenshots');
try { mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch {}

let browser = null;
const pages = new Map();

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
  await launchBrowser();
  const page = await browser.newPage();
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
