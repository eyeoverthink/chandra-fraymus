import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KITS, kitsFor, kitBrief, applyKits } from '../server/media/page-kit.js';
import { pageMessages, staticCheck } from '../server/media/page-builder.js';

const PAGE = `<!DOCTYPE html>
<html><head><title>Earth</title>
<!-- chandra:globe -->
<style>html,body{margin:0;height:100%;background:#02040a}canvas{position:fixed;inset:0;width:100vw;height:100vh}</style></head>
<body><canvas id="globe"></canvas><script>var globe = ChandraGlobe.mount(document.getElementById("globe"), { spin: 0, tilt: 0, longitude: 0, stars: false });</script></body></html>
`;

test('the land data is the real thing: Natural Earth, compact, with its source recorded', () => {
  const land = JSON.parse(readFileSync(new URL('../server/media/page-kit/world-land-110m.json', import.meta.url), 'utf8'));
  assert.match(land.source, /Natural Earth 1:110m land \(public domain\)/);
  assert.match(land.sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(land.polygons.length, 127);
  let points = 0;
  for (const rings of land.polygons) for (const ring of rings) {
    assert.equal(ring.length % 2, 0);
    for (let i = 0; i < ring.length; i += 2) { assert.ok(ring[i] >= -1800 && ring[i] <= 1800 && ring[i + 1] >= -900 && ring[i + 1] <= 900); points++; }
  }
  assert.ok(points > 5000 && points < 5200, `${points} points`);
});

test('a request about the Earth is offered the globe; others are not', () => {
  for (const t of ['an animated 3d world map, a spinning earth from space view', 'an interactive globe', 'show planet Earth turning', 'a map of the world I can drag'])
    assert.deepEqual(kitsFor(t).map(k => k.id), ['globe'], t);
  for (const t of ['bouncing balls that leave fading trails', 'a landing page for my bakery', 'a calculator'])
    assert.deepEqual(kitsFor(t), [], t);
  assert.match(pageMessages('a spinning earth')[0].content, /COMPONENT FOR THIS REQUEST[\s\S]+<!-- chandra:globe -->[\s\S]+ChandraGlobe\.mount/);
  assert.ok(!/COMPONENT FOR THIS REQUEST/.test(pageMessages('a calculator')[0].content));
  assert.match(kitBrief('a spinning earth'), /Do NOT write "stylised"/);
});

test('the marker becomes the component, and misuse is reported in words the writer can act on', () => {
  assert.deepEqual(staticCheck(PAGE), []);                                    // the writer's page passes the rules before anything is added
  const r = applyKits(PAGE, 'a spinning earth');
  assert.deepEqual(r.used, ['globe']); assert.deepEqual(r.problems, []);
  assert.ok(!r.html.includes('<!-- chandra:globe -->'));
  assert.ok(r.html.includes('root.ChandraGlobe = {') && r.html.length > 40_000 && r.html.length < 120_000);
  assert.equal((r.html.match(/<\/script>/gi) || []).length, 2);               // the component's script and the page's own
  assert.ok(!/https?:\/\//.test(r.html.replace(/naturalearthdata\.com/g, '')));  // nothing in the component reaches for the network

  const noMarker = applyKits(PAGE.replace('<!-- chandra:globe -->\n', ''), 'a spinning earth');
  assert.match(noMarker.problems.join(' '), /calls ChandraGlobe but does not contain the comment/);
  const noCall = applyKits(PAGE.replace(/var globe = [^<]+/, ''), 'a spinning earth');
  assert.match(noCall.problems.join(' '), /never calls ChandraGlobe\.mount/);
  const ownPlanet = applyKits('<!DOCTYPE html><html><head><title>x</title></head><body><canvas></canvas></body></html>', 'a spinning earth');
  assert.match(ownPlanet.problems.join(' '), /needs the globe component[\s\S]+Do not draw your own/);
  assert.deepEqual(applyKits('<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>', 'a calculator'), { html: '<!DOCTYPE html><html><head><title>x</title></head><body>hi</body></html>', used: [], problems: [] });
  assert.equal(KITS.length, 1);
});

test('in a real browser the globe shows land where there is land and sea where there is sea, and it turns', async () => {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--window-size=900,700'], defaultViewport: { width: 900, height: 700 } });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setContent(applyKits(PAGE, 'a spinning earth').html, { waitUntil: 'load' });
    // what is at the centre of the disc when a given place faces the viewer?
    const centre = (lon, lat) => page.evaluate(async (lon, lat) => {
      globe.lookAt(lon, lat);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = document.getElementById('globe'), d = c.getContext('2d').getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return { r: d[0], g: d[1], b: d[2], land: d[1] > d[2] };
    }, lon, lat);
    const places = [
      ['central Africa', 22, 0, true], ['the Amazon', -62, -5, true], ['the central United States', -98, 39, true], ['Siberia', 100, 60, true], ['central Australia', 134, -25, true],
      ['the mid Pacific', -150, 0, false], ['the mid Atlantic', -35, 30, false], ['the Indian Ocean', 80, -30, false], ['the South Pacific', -120, -40, false],
    ];
    for (const [name, lon, lat, land] of places) assert.equal((await centre(lon, lat)).land, land, `${name} should be ${land ? 'land' : 'sea'}`);
    const ice = await centre(0, -85);                                           // Antarctica is drawn as ice: bright and nearly grey
    assert.ok(ice.r > 150 && Math.abs(ice.r - ice.b) < 40, JSON.stringify(ice));
    // and it turns eastward: with spin on, the longitude facing the viewer falls
    const turned = await page.evaluate(async () => { globe.lookAt(0, 0); globe.setSpin(10); const a = globe.getLongitude(); await new Promise(r => setTimeout(r, 600)); const b = globe.getLongitude(); globe.setSpin(0); return { a, b }; });
    const moved = (turned.a - turned.b + 360) % 360;
    assert.ok(moved > 15 && moved < 90, `turned ${moved} degrees in 0.6 s at 10 turns a minute`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
