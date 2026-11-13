// Reproduces the screenshots in docs/screenshots/2026-11-13 (headless Chromium via the project's Puppeteer).
// It only opens the protocol menu with its toggle and closes it by reloading: it never clicks a menu item.
// Full-resolution screenshots of the home screen for docs/WHATS-NEW-2026-11-13.md.
// Usage (from the repo): node F:/Claude-Work/chandra-readme/capture.mjs <outDir>
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire('F:/Fraymus-Skill-Lab/chandra-fraymus/package.json');
const puppeteer = require('puppeteer');
const out = process.argv[2] || 'F:/Fraymus-Skill-Lab/chandra-fraymus/docs/screenshots/2026-11-13';
mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toTop = () => page.evaluate(() => { scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0; });

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1.5 } });
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 60_000 });
await sleep(26_000);   // let ~13 pulses arrive so the orb's sparklines have history

const clipOf = async (selector, pad = 12) => {
  const box = await page.$eval(selector, el => { const r = el.getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; });
  return { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad };
};
const clickText = async (selector, text) => page.evaluate((s, t) => {
  const el = [...document.querySelectorAll(s)].find(e => e.textContent.trim().startsWith(t));
  if (el) { el.scrollIntoView({ block: 'center' }); el.click(); return true; } return false;
}, selector, text);

// 1. the whole home screen
await toTop();
await page.screenshot({ path: join(out, '01-home.jpg'), type: 'jpeg', quality: 88 });
console.log('01-home');

// 2. the orb with its legend and two minutes of history
await page.$eval('.fraymus-orb', el => el.scrollIntoView({ block: 'center' }));
await sleep(800);
await page.screenshot({ path: join(out, '02-orb.png'), clip: await clipOf('.fraymus-orb') });
console.log('02-orb');

// 3. a pinned ring card: the model pool machine by machine
await clickText('.orb-legend li', 'Thought routing');
await sleep(1200);
await page.screenshot({ path: join(out, '03-orb-routing-card.png'), clip: await clipOf('.fraymus-orb') });
await clickText('.orb-legend li', 'Thought matrix');
await sleep(1200);
await page.screenshot({ path: join(out, '04-orb-matrix-card.png'), clip: await clipOf('.orb-card', 8) });
console.log('03/04-cards');

// 5. the status strip with the protocol menu open
await toTop();
await page.evaluate(() => [...document.querySelectorAll('.pulse-strip button')].find(b => b.textContent.includes('▾'))?.click());
await sleep(800);
await page.screenshot({ path: join(out, '05-status-and-protocols.png'), clip: { x: 0, y: 0, width: 1440, height: 470 } });
await page.reload({ waitUntil: 'networkidle2' });   // closes the menu without touching any menu item
await sleep(6000);
console.log('05-strip');

// 6. the shelf filtered to the narrator's audio
if (await clickText('button', 'Audio')) {
  await sleep(2500);
  const shelf = await page.evaluate(() => { const h = [...document.querySelectorAll('h2,h3,div,span')].find(e => /^Made here/i.test(e.textContent.trim())); h?.scrollIntoView({ block: 'start' }); return !!h; });
  await sleep(800);
  await page.screenshot({ path: join(out, '06-shelf-narration.jpg'), type: 'jpeg', quality: 88 });
  console.log('06-shelf', shelf);
}

// 7. a question answered by the agent from measured data
await toTop();
const box = await page.$('textarea[aria-label="Command"], input[aria-label="Command"], [aria-label="Command"]');
if (box) {
  await box.click();
  await box.type('how far is the system from AGI?');
  await page.keyboard.press('Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await sleep(3000);
    const done = await page.evaluate(() => /requirements|blueprint/i.test(document.body.innerText) && !/The agent is working/.test(document.body.innerText));
    if (done) break;
  }
  await sleep(1500);
  const aside = await page.evaluate(() => { const h = [...document.querySelectorAll('h2')].find(e => /Transcript and tools/i.test(e.textContent)); const a = h?.closest('aside, section, div'); a?.scrollIntoView({ block: 'start' }); return !!a; });
  await sleep(600);
  await page.screenshot({ path: join(out, '07-agi-answer.jpg'), type: 'jpeg', quality: 88 });
  console.log('07-agi', aside, Math.round((Date.now() - t0) / 1000) + ' s');
}

await browser.close();
