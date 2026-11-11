/**
 * Flat scene — one frame of one shot, as an SVG string.
 *
 * `shotSvg(shot, t, opts)` is a pure function of the shot description and the time since the shot began, so a
 * film is the same every time it is rendered, any frame can be drawn on its own, and a test can look at the
 * layout without a renderer. `layoutOf` exposes where things were put (so the rule "every face sits above the
 * caption" is a calculation, not an opinion).
 */
import { FORMATS, LAYOUT, CAST, LEAD, SETTINGS, ALREADY_THERE, figureSvg, figureHeight, cameraAt, rng, hashOf, esc, fmt as f, clamp, backOut, ease } from './kit.js';
import { PROPS } from './props.js';

const SLOTS = { left: 0.22, center: 0.5, right: 0.78 };
export const FONT = `'Arial Black', 'Segoe UI Black', Impact, 'Arial', sans-serif`;

/** Where everything in a shot goes, in pixels. Deterministic; shared by the renderer and the rule checks. */
export function layoutOf(shot, format = '16:9') {
  const [w, h] = FORMATS[format] || FORMATS['16:9'], L = LAYOUT[format] || LAYOUT['16:9'];
  // three things side by side in a frame 1080 px wide overlap at full size: the more there is to show, the smaller each is drawn
  const crowd = Math.min(3, (shot.cast || []).length) + (shot.props || []).filter(n => PROPS[n] && PROPS[n].where !== 'sky').length;
  const u = (Math.min(w, h) / 1080) * L.figure * (w > h ? (crowd >= 4 ? 0.88 : 1) : crowd >= 4 ? 0.74 : crowd === 3 ? 0.82 : crowd === 2 ? 0.93 : 1), g = h * L.ground;   // a wide frame has the room
  const cast = (shot.cast || []).slice(0, 3).map((c, i) => {
    const at = SLOTS[c.at] != null ? c.at : ['center', 'left', 'right'][i];
    const scale = u * ((shot.cast || []).length > 2 ? 0.86 : 1);
    const x = w * SLOTS[at], top = g - figureHeight(c.who) * scale - (c.act === 'float' ? 150 * scale : 0);
    return { ...c, at, x, y: g, scale, top, faceBottom: g - figureHeight(c.who) * scale * 0.5 };
  });
  // two members asked for the same place: the later one moves to a free one
  const used = new Set();
  for (const c of cast) { if (used.has(c.at)) { const free = ['left', 'center', 'right'].find(k => !used.has(k)); if (free) { c.at = free; c.x = w * SLOTS[free]; } } used.add(c.at); }
  const freeSlots = ['center', 'left', 'right'].filter(k => !used.has(k)).map(k => w * SLOTS[k]);
  const between = [0.36, 0.64, 0.5].map(k => w * k);
  const props = [], names = (shot.props || []).filter(n => PROPS[n] && !(ALREADY_THERE[shot.setting] || []).includes(n)).slice(0, 3);
  let gi = 0, fi = 0, si = 0;
  // sky props keep clear of the setting's own light (a bird drawn on top of the sun reads as a mistake) and of a big label
  const lightX = (SETTINGS[shot.setting] || SETTINGS.field).glow[1], awayFirst = lightX > 0.6 ? [0.22, 0.5, 0.78] : lightX < 0.4 ? [0.78, 0.5, 0.22] : [0.2, 0.8, 0.5];
  const skyX = shot.label ? (lightX > 0.6 ? [0.16, 0.84, 0.5] : [0.84, 0.16, 0.5]) : awayFirst, skyY = shot.label ? 0.31 : 0.2;
  for (const n of names) {
    const p = PROPS[n];
    if (p.where === 'sky') { props.push({ name: n, x: w * skyX[si % 3], y: h * (skyY + (si > 1 ? 0.1 : 0)), scale: u * 0.86, layer: 'mid' }); si++; }
    else if (p.where === 'ground') { const free = gi < freeSlots.length; const x = free ? freeSlots[gi] : between[(gi - freeSlots.length) % 3]; props.push({ name: n, x, y: g + (free ? 0 : -6), scale: u * (free ? 1.05 : 0.7), layer: free ? 'ground' : 'behind' }); gi++; }
    else { const free = gi + fi < freeSlots.length; const x = free ? freeSlots[gi + fi] : between[fi % 3]; props.push({ name: n, x, y: free ? g - 250 * u : g - (figureHeight(LEAD) + 190) * u, scale: u * (free ? 0.95 : 0.62), layer: 'ground' }); fi++; }
  }
  return { w, h, u, g, cast, props, captionY: h * L.caption, labelY: h * L.label };
}

const strokeText = (inner, attrs, stroke, sw, fill = "#ffffff") => `<text ${attrs} fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round">${inner}</text><text ${attrs} fill="${fill}">${inner}</text>`;

/** The caption: a few words at a time, the one being spoken in yellow. */
export function captionSvg(words, hot, { w, y, size }) {
  if (!words?.length) return '';
  const plain = words.map(esc).join(' ');
  const coloured = words.map((wd, i) => `<tspan fill="${i === hot ? '#ffe066' : '#ffffff'}">${esc(wd)}</tspan>`).join(' ');
  const attrs = `x="${f(w / 2)}" y="${f(y)}" font-family="${FONT}" font-size="${size}" font-weight="900" text-anchor="middle"`;
  return `<text ${attrs} fill="none" stroke="#0b0b1a" stroke-width="${f(size * 0.26)}" stroke-linejoin="round">${plain}</text><text ${attrs} fill="#ffffff">${coloured}</text>`;
}

/**
 * One frame.
 * @param shot  { setting, props: string[], cast: [{who, feel, at, act}], camera, label, seed }
 * @param t     seconds since the shot began
 * @param opts  { format, dur, caption: { words, hot } }
 */
export function shotSvg(shot, t, { format = '16:9', dur = 4, caption = null } = {}) {
  const L = layoutOf(shot, format), { w, h, u, g } = L;
  const S = SETTINGS[shot.setting] || SETTINGS.field, seed = shot.seed ?? hashOf(`${shot.setting}|${(shot.props || []).join(',')}`);
  const layers = S.draw({ w, h, g, t, seed });
  const cam = cameraAt(shot.camera, clamp(t / Math.max(0.5, dur)));
  const lay = (depth, inner) => `<g transform="translate(${f(cam.px * depth * u)},${f(cam.py * depth * u)})">${inner}</g>`;
  const pop = i => backOut((t - 0.1 - i * 0.14) / 0.4);
  const propSvg = (p, i) => { const k = pop(i); return k <= 0.01 ? '' : `<g transform="translate(${f(p.x)},${f(p.y)}) scale(${(p.scale * k).toFixed(3)})">${PROPS[p.name].draw(t)}</g>`; };
  const byLayer = name => L.props.map((p, i) => p.layer === name ? propSvg(p, i) : '').join('');
  const figures = L.cast.map((c, i) => figureSvg(c.who, { x: c.x, y: c.y, scale: c.scale, feel: c.feel, act: c.act, t, phase: i * 1.7 + (seed % 7), w })).join('');
  let label = '';
  if (shot.label) {
    const text = String(shot.label).slice(0, 18), k = backOut((t - 0.25) / 0.45);
    if (k > 0.01) { const size = Math.round(Math.min(190, (w * 0.86) / Math.max(4, text.length) / 0.68) * (format === '16:9' ? 0.9 : 1)); label = `<g transform="translate(${f(w / 2)},${f(L.labelY)}) scale(${k.toFixed(3)})">${strokeText(esc(text), `x="0" y="${f(size * 0.35)}" font-family="${FONT}" font-size="${size}" font-weight="900" text-anchor="middle"`, '#0b0b1a', f(size * 0.2))}</g>`; }
  }
  const [gc, gx, gy, gr] = S.glow, R = Math.max(w, h) * gr;
  const fade = t < 0.12 ? 1 - t / 0.12 : 0;   // a four-frame dip from black softens each cut without a transition effect
  const capSize = Math.round((format === '9:16' ? 86 : format === '1:1' ? 74 : 78) * (Math.min(w, h) / 1080));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${S.sky[0]}"/><stop offset="1" stop-color="${S.sky[1]}"/></linearGradient>`
    + `<radialGradient id="glow"><stop offset="0" stop-color="${gc}" stop-opacity="0.75"/><stop offset="0.35" stop-color="${gc}" stop-opacity="0.28"/><stop offset="1" stop-color="${gc}" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.42"/></radialGradient></defs>`
    + `<rect width="${w}" height="${h}" fill="url(#sky)"/>`
    + `<g transform="translate(${f(w / 2)},${f(g)}) scale(${cam.z.toFixed(4)}) translate(${f(-w / 2)},${f(-g)})">`
    + lay(0.25, (layers.back || '') + `<circle cx="${f(w * gx)}" cy="${f(h * gy)}" r="${f(R)}" fill="url(#glow)"/>`)
    + lay(0.55, (layers.mid || '') + byLayer('mid'))
    + lay(1, (layers.ground || '') + byLayer('behind') + byLayer('ground') + figures)
    + lay(1.3, layers.front || '')
    + `</g>`
    + `<rect width="${w}" height="${h}" fill="url(#vig)"/>`
    + label
    + (caption ? captionSvg(caption.words, caption.hot, { w, y: L.captionY, size: capSize }) : '')
    + (fade > 0 ? `<rect width="${w}" height="${h}" fill="#000" opacity="${fade.toFixed(2)}"/>` : '')
    + `</svg>`;
}

/** Character sheet: one cast member with every feeling, for the shelf and for checking the design by eye. */
export function castSheetSvg(who, feelings) {
  const c = CAST[who], w = 1920, h = 1080, per = Math.min(feelings.length, 5), rows = Math.ceil(feelings.length / per);
  let cells = '';
  feelings.forEach((feel, i) => { const x = w * ((i % per) + 0.5) / per, y = 330 + Math.floor(i / per) * 400; cells += figureSvg(who, { x, y: y + 150, scale: 1.05, feel, t: 0.4 + i * 0.37 }) + `<text x="${f(x)}" y="${y + 215}" font-family="${FONT}" font-size="34" text-anchor="middle" fill="#ffffff">${esc(feel)}</text>`; });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#1b1f3b"/><text x="60" y="96" font-family="${FONT}" font-size="64" fill="${c.color}">${esc(who)}</text><text x="60" y="146" font-family="${FONT}" font-size="30" fill="#cfd4de">${esc(c.title)} · ${rows} rows of feelings · colours ${c.color} ${c.shade} ${c.accent}</text>${cells}</svg>`;
}

export { ease };
