import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest, planCreation, settleKind, describePlan } from '../server/media/make-plan.js';
import { pageMessages, extractHtml, staticCheck, slugFor, titleOf, wantsMotion, verifyPage } from '../server/media/page-builder.js';

const page = (body, head = '<title>Test page</title>') => `<!DOCTYPE html>\n<html><head>${head}</head><body>${body}</body></html>\n`;
const dataUrl = html => 'data:text/html;charset=utf-8,' + encodeURIComponent(html);

test('a request for a web page is a page, whatever else the sentence mentions', () => {
  // the sentence that went wrong on 2026-11-10: it was sent to the film tool and refused as "3D"
  const p = planCreation('create a single page web application of an animated 3d world map, a spinning earth from space view.');
  assert.equal(p.kind, 'page'); assert.equal(p.blocked, null); assert.equal(p.style, 'web');
  assert.match(describePlan(p), /a web page \(you said so\)/);
  assert.equal(settleKind(p, 'video').kind, 'page');                                // nothing later turns it into a film
  for (const t of ['build me a calculator', 'make a landing page for my bakery', 'a browser game where you dodge asteroids', 'an interactive map of the solar system', 'write a web app that tracks habits', 'create a dashboard of my sales'])
    assert.equal(parseRequest(t).kind, 'page', t);
  // films that merely mention such things stay films
  for (const t of ['an 8-bit short about a boy who builds an app', 'make a cartoon about a calculator that comes alive', 'create a comic about a game show', 'a 2-bit still of a lighthouse', 'make an explainer video about how a dashboard works'])
    assert.notEqual(parseRequest(t).kind, 'page', t);
  assert.equal(planCreation('a spinning earth', { kind: 'page' }).kind, 'page');
  assert.equal(planCreation('build a web page about tides', { kind: 'video', style: 'explainer' }).kind, 'video');   // an explicit kind wins
});

test('the prompt forbids every way the first attempt failed', () => {
  const sys = pageMessages('a spinning earth')[0].content;
  assert.match(sys, /Three\.js, D3 and every other library are NOT available/);
  assert.match(sys, /Declare every variable once/);
  assert.match(sys, /Never present invented data as real/);
  assert.match(pageMessages('x', '- JavaScript error: scene is already declared')[1].content, /did not pass[\s\S]+scene is already declared/);
  assert.equal(wantsMotion('an animated 3d world map, a spinning earth'), true);
  assert.equal(wantsMotion('a landing page for my bakery'), false);
});

test('the document is pulled out of a reply, fenced or bare', () => {
  const doc = page('<p>hello there</p>');
  assert.equal(extractHtml('Here you go:\n```html\n' + doc + '```\nEnjoy!'), doc);
  assert.equal(extractHtml(doc + '\nsome trailing chatter'), doc);
  assert.equal(extractHtml('I cannot do that.'), null);
  assert.equal(titleOf(doc), 'Test page');
  assert.match(slugFor('Spinning Earth — from space!', 'make-ab12cd34-e1'), /^spinning-earth-from-space-[a-z0-9]{6}$/);
});

test('static rules catch what cannot work offline, and do not trip on ordinary code', () => {
  assert.deepEqual(staticCheck(page('<canvas id="c"></canvas><script>\n//canvas.width = 300; a comment, not a URL\nconst ns = "http://www.w3.org/2000/svg"; document.createElementNS("http://www.w3.org/2000/svg", "svg");\nconst a = 1 / 2; // half\n</script><svg xmlns="http://www.w3.org/2000/svg"></svg>').replace('const ns = "http://www.w3.org/2000/svg"; ', '')), []);
  const bad = (body, re, head) => assert.ok(staticCheck(page(body, head)).some(p => re.test(p)), `${re} not reported for: ${body.slice(0, 50)}`);
  bad('<script src="https://cdn.jsdelivr.net/npm/three/build/three.min.js"></script>', /refers to the network/);
  bad('<script src="lib.js"></script>', /<script src/);
  bad('<script type="module">\nimport * as THREE from \'three\';\n</script>', /import statement/);
  bad('<script>const s = new THREE.Scene();</script>', /library .* that is not on the page/);
  bad('<script>fetch("/api/data")</script>', /network request/);
  bad('<script>function draw(){ // rest of the code here\n}</script>', /placeholder comment/);
  bad('<script>alert("hi")</script>', /alert\(\)/);
  bad('<link rel="stylesheet" href="x.css">', /stylesheet/);
  bad('<p>x</p>', /no <title>/, '');
  assert.ok(staticCheck('<!DOCTYPE html><html><head><title>t</title></head><body><p>cut off').some(p => /cut off/.test(p)));
  assert.deepEqual(staticCheck(null), ['The reply did not contain an HTML document.']);
});

test('a real browser tells a working page from a broken, blank or frozen one', async () => {
  const moving = page('<canvas id="c" width="800" height="500"></canvas><script>const c=document.getElementById("c"),x=c.getContext("2d");let t=0;(function f(){t+=0.05;x.fillStyle="#04101e";x.fillRect(0,0,800,500);for(let i=0;i<40;i++){x.fillStyle="hsl("+(i*9)+",80%,55%)";x.beginPath();x.arc(400+Math.cos(t+i)*(60+i*5),250+Math.sin(t*1.3+i)*(40+i*4),14,0,7);x.fill()}requestAnimationFrame(f)})();</script>');
  const ok = await verifyPage(dataUrl(moving), { motionExpected: true });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.ok, true); assert.ok(ok.moved > 0.002, `moved ${ok.moved}`); assert.ok(ok.colours >= 4); assert.ok(ok.screenshot.length > 1000);

  // the same mistake the agent's pasted code made: one name declared twice
  const broken = await verifyPage(dataUrl(page('<canvas></canvas><script>const scene = document.createElement("canvas");\nconst scene = {};</script>')));
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(p => /JavaScript error: .*scene.*already been declared/.test(p)), broken.problems.join(' | '));

  const blank = await verifyPage(dataUrl(page('')));
  assert.ok(blank.problems.some(p => /blank/.test(p)));

  const frozen = await verifyPage(dataUrl(page('<h1 style="color:#c33">A still page with enough text to count as content</h1><div style="width:300px;height:200px;background:linear-gradient(90deg,#036,#6cf,#fc6)"></div>')), { motionExpected: true });
  assert.ok(frozen.problems.some(p => /Nothing moved/.test(p)));
  const still = await verifyPage(dataUrl(page('<h1 style="color:#c33">A still page with enough text to count as content</h1><div style="width:300px;height:200px;background:linear-gradient(90deg,#036,#6cf,#fc6)"></div>')));
  assert.equal(still.ok, true);                                                       // the same page is fine when nothing was meant to move
});
