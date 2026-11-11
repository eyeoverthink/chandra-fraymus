/**
 * Page kit — tested building blocks a generated web page may use.
 *
 * A model cannot draw the world's coastlines from memory, and a page may not load anything from the
 * network. So for the few things that need real data or careful maths, the page writer is offered a
 * component that already works: it writes one marker comment where the component's script should go and
 * calls the component's small API; the builder replaces the marker with the component's code before the
 * page is checked and opened in the browser. The writer still makes the page; it no longer has to invent
 * the Earth.
 *
 *   globe   <!-- chandra:globe -->   ChandraGlobe.mount(canvas, { spin, tilt, longitude, stars, interactive })
 *           a spinning Earth with Natural Earth 1:110m coastlines (public domain), drag / zoom / reset
 *
 * To add a component: a script in server/media/page-kit/ that defines one global and touches no network,
 * an entry in KITS (when it applies, its marker, how to call it), and a browser test.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'page-kit');
let globeScript = null;

function globe() {
  if (globeScript) return globeScript;
  const land = JSON.parse(readFileSync(join(DIR, 'world-land-110m.json'), 'utf8'));
  const code = readFileSync(join(DIR, 'globe.js'), 'utf8');
  if (!code.includes('/*LAND_DATA*/[]')) throw new Error('globe.js has no land data placeholder');
  globeScript = code.replace('/*LAND_DATA*/[]', JSON.stringify(land.polygons));
  if (/<\/script/i.test(globeScript)) throw new Error('kit code must not contain a closing script tag');
  return globeScript;
}

export const KITS = Object.freeze([
  {
    id: 'globe', marker: '<!-- chandra:globe -->', global: 'ChandraGlobe',
    when: /\b(earth|globe|world map|planet earth|spinning (?:world|planet)|map of the world|from space)\b/i,
    script: globe,
    credit: 'Coastlines: Natural Earth 1:110m (public domain)',
    brief: [
      'A tested Earth component is available for this request. USE IT — do not draw your own planet or continents.',
      '- Put this exact comment once in the <head>, on its own line: <!-- chandra:globe -->   (it becomes the component\'s script; write nothing else for it)',
      '- Put a <canvas id="globe"></canvas> in the body and size it with CSS (for a full-window Earth: position:fixed; inset:0; width:100vw; height:100vh).',
      '- After the page loads, call: var globe = ChandraGlobe.mount(document.getElementById("globe"), { spin: 2, tilt: 20, longitude: 0, stars: true, interactive: true });',
      '  spin = turns per minute (0 stops it), tilt = degrees the north pole leans toward the viewer, longitude = which meridian faces the viewer at the start.',
      '- It returns an object with setSpin(turnsPerMinute), setTilt(degrees), lookAt(longitude, latitude), getLongitude() and destroy(). It draws the stars, the atmosphere and the sunlit side itself; dragging turns it, the wheel zooms, a double click resets.',
      '- You write everything around it: the title, a caption, and any controls the request asks for (for example a speed slider calling globe.setSpin, or buttons calling globe.lookAt). Keep controls small and out of the way of the Earth.',
      '- In the caption, credit the map with exactly: Coastlines: Natural Earth 1:110m (public domain). Do NOT write "stylised" or "not a real map" — these are real coastlines.',
    ].join('\n'),
  },
]);

/** The components that apply to a request. */
export function kitsFor(request) { return KITS.filter(k => k.when.test(String(request || ''))); }

/** Extra instructions for the page writer about the components it should use. */
export function kitBrief(request) { return kitsFor(request).map(k => k.brief).join('\n\n'); }

/**
 * Replace each marker with its component. Returns { html, used: [ids], problems: [] }.
 * A component the request called for but the page did not use, or used without its marker, is a problem
 * the writer is told about.
 */
export function applyKits(html, request) {
  let out = String(html || '');
  const used = [], problems = [];
  for (const k of KITS) {
    const marked = out.includes(k.marker), called = new RegExp(`\\b${k.global}\\s*\\.`).test(out);
    if (marked) { out = out.split(k.marker).join(''); out = out.replace(/<\/head>/i, m => `<script>\n${k.script()}\n</script>\n${m}`); used.push(k.id); }
    if (called && !marked) problems.push(`The page calls ${k.global} but does not contain the comment ${k.marker} in its <head>, so the component is missing. Add that exact comment.`);
    if (marked && !called) problems.push(`The page includes ${k.marker} but never calls ${k.global}.mount(…). Call it once the page has loaded.`);
    if (!marked && !called && k.when.test(String(request || ''))) problems.push(`This request needs the ${k.id} component, and the page does not use it. Add the comment ${k.marker} in the <head> and call ${k.global}.mount(document.getElementById("globe"), { spin: 2 }). Do not draw your own.`);
    if (marked && !/<\/head>/i.test(html)) problems.push('The page has no </head> to place the component in.');
  }
  return { html: out, used, problems };
}
