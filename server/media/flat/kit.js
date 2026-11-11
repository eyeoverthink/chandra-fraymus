/**
 * Flat kit — the drawing vocabulary of the flat vector look.
 *
 * A shot is not painted by an image model. It is assembled from a fixed vocabulary — a setting, up to three
 * props, up to three members of one recurring cast, a camera move, an optional big label — and every item in
 * that vocabulary is drawn here as SVG, as a function of time. That gives what a diffusion model cannot:
 * the same characters in every shot of every film, pictures that can be checked against rules before a
 * frame is rendered, and motion that costs no graphics card.
 *
 * The cast is our own (six characters designed for this system). Nothing here imitates another studio's
 * characters; the shared part is the general style — flat shapes, dot eyes, a visible warm light.
 *
 * Pure: no database, no network, no clock, no randomness (scatter comes from a seeded generator).
 */

export const FORMATS = Object.freeze({ '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] });
/** Where the ground line and the caption sit, as shares of the height. Faces always end above the caption. */
export const LAYOUT = Object.freeze({
  '16:9': { ground: 0.74, caption: 0.92, label: 0.17, figure: 1.5 },
  '9:16': { ground: 0.70, caption: 0.84, label: 0.15, figure: 1.4 },
  '1:1': { ground: 0.66, caption: 0.86, label: 0.16, figure: 1.1 },
});

const f = n => (Math.round(n * 10) / 10).toString();
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = x => { const c = clamp(x); return c * c * (3 - 2 * c); };
const backOut = x => { const c = clamp(x) - 1; return 1 + c * c * (2.7 * c + 1.7); };
export const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Seeded scatter: the same shot always draws the same stars and the same trees. */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const hashOf = s => { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// ── the cast ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Six characters. `body` is a shape, `rx/ry` its half-size in figure units (one unit ≈ 1/1080 of the short
 * side), `mark` the one thing that makes the silhouette theirs. The first is the lead: the viewer's stand-in.
 */
export const CAST = Object.freeze({
  nilo: { title: 'the curious one', body: 'bean', rx: 78, ry: 92, color: '#1fb8a6', shade: '#16907f', mark: 'leaf', accent: '#ffd23f' },
  prof: { title: 'the one who explains', body: 'egg', rx: 70, ry: 108, color: '#8a5cf6', shade: '#6d42d8', mark: 'glasses', accent: '#f1f1f6' },
  bru: { title: 'the big gentle one', body: 'block', rx: 104, ry: 104, color: '#ff8c42', shade: '#e06a1f', mark: 'cap', accent: '#2b59c3' },
  zee: { title: 'the cheeky kid', body: 'drop', rx: 58, ry: 66, color: '#ff5d8f', shade: '#e03a70', mark: 'tufts', accent: '#ffe066' },
  baron: { title: 'the smug rich one', body: 'pear', rx: 86, ry: 100, color: '#2f4b8f', shade: '#213a75', mark: 'tophat', accent: '#f4c95d' },
  dot: { title: 'the small helper', body: 'round', rx: 56, ry: 56, color: '#ffd23f', shade: '#e0ae14', mark: 'band', accent: '#ff5d8f' },
});
export const LEAD = 'nilo';
export const FEELINGS = Object.freeze(['neutral', 'happy', 'scared', 'smug', 'sad', 'surprised', 'angry', 'curious', 'proud', 'tired']);
export const ACTS = Object.freeze(['idle', 'hop', 'shake', 'wave', 'cheer', 'enter-left', 'enter-right', 'float', 'run', 'droop']);
export const CAMERAS = Object.freeze(['still', 'push', 'pull', 'pan-left', 'pan-right', 'rise']);

function bodyPath(shape, rx, ry) {
  switch (shape) {
    case 'egg': return `M0,${-ry} C${rx * 0.95},${-ry} ${rx * 1.1},${ry * 0.35} ${rx * 0.78},${ry * 0.78} C${rx * 0.5},${ry * 1.05} ${-rx * 0.5},${ry * 1.05} ${-rx * 0.78},${ry * 0.78} C${-rx * 1.1},${ry * 0.35} ${-rx * 0.95},${-ry} 0,${-ry} Z`;
    case 'pear': return `M0,${-ry} C${rx * 0.6},${-ry} ${rx * 0.55},${-ry * 0.2} ${rx * 0.9},${ry * 0.3} C${rx * 1.25},${ry * 0.95} ${-rx * 1.25},${ry * 0.95} ${-rx * 0.9},${ry * 0.3} C${-rx * 0.55},${-ry * 0.2} ${-rx * 0.6},${-ry} 0,${-ry} Z`;
    case 'drop': return `M0,${-ry * 1.05} C${rx * 0.5},${-ry * 0.7} ${rx * 1.1},${-ry * 0.1} ${rx},${ry * 0.4} C${rx * 0.9},${ry * 1.1} ${-rx * 0.9},${ry * 1.1} ${-rx},${ry * 0.4} C${-rx * 1.1},${-ry * 0.1} ${-rx * 0.5},${-ry * 0.7} 0,${-ry * 1.05} Z`;
    case 'bean': return `M${-rx * 0.1},${-ry} C${rx * 0.9},${-ry * 1.05} ${rx * 1.15},${-ry * 0.1} ${rx * 0.95},${ry * 0.55} C${rx * 0.75},${ry * 1.1} ${-rx * 0.7},${ry * 1.1} ${-rx * 0.95},${ry * 0.5} C${-rx * 1.15},${-ry * 0.2} ${-rx * 0.9},${-ry * 0.95} ${-rx * 0.1},${-ry} Z`;
    case 'block': { const r = rx * 0.34; return `M${-rx + r},${-ry} H${rx - r} Q${rx},${-ry} ${rx},${-ry + r} V${ry - r} Q${rx},${ry} ${rx - r},${ry} H${-rx + r} Q${-rx},${ry} ${-rx},${ry - r} V${-ry + r} Q${-rx},${-ry} ${-rx + r},${-ry} Z`; }
    default: return `M0,${-ry} C${rx * 1.33},${-ry} ${rx * 1.33},${ry} 0,${ry} C${-rx * 1.33},${ry} ${-rx * 1.33},${-ry} 0,${-ry} Z`;
  }
}

function markSvg(c, name) {
  const { rx, ry, accent } = c;
  switch (c.mark) {
    case 'leaf': return `<path d="M0,${-ry} q-6,-34 10,-52" stroke="#16907f" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M10,${-ry - 52} c26,-22 52,-6 56,10 c-22,14 -46,10 -56,-10 Z" fill="#7bd66a"/>`
      + `<path d="M${-rx * 0.86},${-ry * 0.1} L${rx * 0.9},${ry * 0.34}" stroke="${accent}" stroke-width="13" stroke-linecap="round"/><rect x="${rx * 0.5}" y="${ry * 0.2}" width="46" height="40" rx="9" fill="${accent}"/>`;
    case 'glasses': return `<circle cx="-24" cy="${-ry * 0.34}" r="23" fill="none" stroke="${accent}" stroke-width="7"/><circle cx="26" cy="${-ry * 0.34}" r="23" fill="none" stroke="${accent}" stroke-width="7"/><path d="M-1,${-ry * 0.34} h4" stroke="${accent}" stroke-width="7"/>`
      + `<path d="M-30,${-ry * 0.02} q30,-20 60,0 q-30,16 -60,0 Z" fill="#d9d4e8"/>`;
    case 'cap': return `<path d="M${-rx * 0.72},${-ry * 0.92} q${rx * 0.72},${-ry * 0.62} ${rx * 1.44},0 Z" fill="${accent}"/><rect x="${rx * 0.3}" y="${-ry * 0.98}" width="${rx * 0.78}" height="15" rx="7" fill="${accent}"/>`;
    case 'tufts': return `<circle cx="${-rx * 0.62}" cy="${-ry * 0.86}" r="22" fill="${accent}"/><circle cx="${rx * 0.62}" cy="${-ry * 0.86}" r="22" fill="${accent}"/>`;
    case 'tophat': return `<rect x="-52" y="${-ry - 16}" width="104" height="14" rx="6" fill="#141a33"/><rect x="-36" y="${-ry - 86}" width="72" height="74" rx="6" fill="#141a33"/><rect x="-36" y="${-ry - 34}" width="72" height="13" fill="${accent}"/>`
      + `<circle cx="27" cy="${-ry * 0.36}" r="21" fill="none" stroke="${accent}" stroke-width="6"/><path d="M48,${-ry * 0.3} q14,40 4,74" stroke="${accent}" stroke-width="4" fill="none"/>`;
    case 'band': return `<path d="M${-rx * 0.99},${-ry * 0.02} Q0,${ry * 0.3} ${rx * 0.99},${-ry * 0.02}" stroke="${accent}" stroke-width="15" fill="none" stroke-linecap="round"/>`;
    default: return name ? '' : '';
  }
}

/** Eyes, brows and mouth for a feeling. `blink` closes the eyes. Centre is the face centre. */
function faceSvg(feel, eyeGap, blink) {
  const e = (x, ry = 9, rx = 9, dy = 0) => blink ? `<path d="M${x - 11},${dy} h22" stroke="#1a1a2e" stroke-width="6" stroke-linecap="round"/>` : `<ellipse cx="${x}" cy="${dy}" rx="${rx}" ry="${ry}" fill="#1a1a2e"/>`;
  const L = -eyeGap, R = eyeGap, line = d => `<path d="${d}" stroke="#1a1a2e" stroke-width="6" stroke-linecap="round" fill="none"/>`;
  switch (feel) {
    case 'happy': return e(L) + e(R) + line(`M-22,30 q22,24 44,0`);
    case 'scared': return e(L, 13, 11) + e(R, 13, 11) + line(`M${L - 16},-26 l22,-8`) + line(`M${R + 16},-26 l-22,-8`) + `<ellipse cx="0" cy="38" rx="13" ry="16" fill="#1a1a2e"/>`;
    case 'smug': return line(`M${L - 12},0 q12,-9 24,0`) + line(`M${R - 12},0 q12,-9 24,0`) + line(`M-8,34 q22,12 34,-10`);
    case 'sad': return e(L) + e(R) + line(`M${L - 16},-30 l22,10`) + line(`M${R + 16},-30 l-22,10`) + line(`M-20,42 q20,-20 40,0`);
    case 'surprised': return e(L, 13, 12) + e(R, 13, 12) + line(`M${L - 12},-32 h24`) + line(`M${R - 12},-32 h24`) + `<circle cx="0" cy="38" r="12" fill="#1a1a2e"/>`;
    case 'angry': return e(L, 8) + e(R, 8) + line(`M${L - 16},-30 l26,12`) + line(`M${R + 16},-30 l-26,12`) + line(`M-18,40 h36`);
    case 'curious': return e(L) + e(R, 12, 10) + line(`M${R - 12},-34 q12,-10 24,-2`) + line(`M-10,36 q10,6 22,-2`);
    case 'proud': return line(`M${L - 12},2 q12,-12 24,0`) + line(`M${R - 12},2 q12,-12 24,0`) + line(`M-24,28 q24,26 48,0`);
    case 'tired': return line(`M${L - 12},2 h24`) + line(`M${R - 12},2 h24`) + line(`M${L - 12},18 q12,8 24,0`) + line(`M${R - 12},18 q12,8 24,0`) + line(`M-12,42 h24`);
    default: return e(L) + e(R) + line(`M-14,36 h28`);
  }
}

/**
 * One cast member standing on the point (x, y), where y is the ground under the feet.
 * @param t      seconds since the shot began
 * @param dur    length of the shot in seconds (entrances are timed against it)
 */
export function figureSvg(who, { x, y, scale = 1, feel = 'neutral', act = 'idle', t = 0, phase = 0, w = 1920 }) {
  const c = CAST[who] || CAST[LEAD];
  const s = scale;
  let dx = 0, dy = Math.sin(t * 2.2 + phase) * 5, rot = 0, armL = 0.5, armR = 0.5, leg = 0;
  if (act === 'hop') dy = -Math.abs(Math.sin(t * 5 + phase)) * 46;
  else if (act === 'shake') { dx = Math.sin(t * 34 + phase) * 7; armL = armR = 0.75; }
  else if (act === 'wave') armR = 1.5 + Math.sin(t * 9) * 0.25;
  else if (act === 'cheer') { armL = armR = 1.55 + Math.sin(t * 10) * 0.12; dy = -Math.abs(Math.sin(t * 6)) * 30; }
  else if (act === 'float') dy = -120 + Math.sin(t * 1.4 + phase) * 26;
  else if (act === 'droop') { rot = 7; armL = armR = 0.15; dy = 0; }
  else if (act === 'run') { leg = Math.sin(t * 14) * 0.6; dx = Math.sin(t * 1.6) * 60; armL = 0.6 + leg * 0.5; armR = 0.6 - leg * 0.5; }
  else if (act === 'enter-left' || act === 'enter-right') { const k = 1 - backOut(t / 0.6); dx = (act === 'enter-left' ? -1 : 1) * k * (w * 0.6) / s; leg = k > 0.02 ? Math.sin(t * 16) * 0.6 : 0; }
  const blink = ((t + phase * 0.7) % 3.1) < 0.13;
  const legLen = 46, legY = c.ry * 0.86, armY = -c.ry * 0.05;
  const legs = [-1, 1].map(side => { const a = side * leg; const fx = side * c.rx * 0.38 + Math.sin(a) * legLen, fy = legY + Math.cos(a) * legLen; return `<path d="M${f(side * c.rx * 0.38)},${f(legY - 8)} L${f(fx)},${f(fy)} h${side * 20}" stroke="#1a1a2e" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`; }).join('');
  const arm = (side, up) => { const ang = (0.25 + up * 0.62) * Math.PI; const len = c.rx * 0.82; const ax = side * (c.rx * 0.92), hx = ax + side * Math.sin(ang) * len, hy = armY - Math.cos(ang) * len; return `<path d="M${f(ax)},${f(armY)} L${f(hx)},${f(hy)}" stroke="#1a1a2e" stroke-width="9" stroke-linecap="round"/><circle cx="${f(hx)}" cy="${f(hy)}" r="8" fill="#1a1a2e"/>`; };
  const total = c.ry + legLen + 4;
  return `<g transform="translate(${f(x + dx * s)},${f(y + dy * s)}) scale(${f(s * 100) / 100}) rotate(${rot}) translate(0,${f(-total)})">`
    + `<ellipse cx="0" cy="${f(total - dy)}" rx="${f(c.rx * 0.9)}" ry="13" fill="#000" opacity="${f(clamp(0.22 + dy / 600, 0.06, 0.22) * 100) / 100}"/>`
    + legs + arm(-1, armL) + arm(1, armR)
    + `<path d="${bodyPath(c.body, c.rx, c.ry)}" fill="${c.color}"/>`
    + `<path d="${bodyPath(c.body, c.rx * 0.82, c.ry * 0.84)}" fill="${c.shade}" opacity="0.45" transform="translate(${f(c.rx * 0.14)},${f(c.ry * 0.14)})"/>`
    + `<path d="${bodyPath(c.body, c.rx * 0.9, c.ry * 0.9)}" fill="${c.color}" transform="translate(${f(-c.rx * 0.05)},${f(-c.ry * 0.05)})"/>`
    + `<ellipse cx="${f(-c.rx * 0.36)}" cy="${f(-c.ry * 0.62)}" rx="${f(c.rx * 0.22)}" ry="${f(c.ry * 0.1)}" fill="#fff" opacity="0.28"/>`
    + markSvg(c, who)
    + `<g transform="translate(0,${f(-c.ry * 0.34)})">${faceSvg(FEELINGS.includes(feel) ? feel : 'neutral', c.rx * 0.34, blink)}</g>`
    + `</g>`;
}

/** How tall a figure is in figure units (feet to top of head), so a layout can keep faces above the caption. */
export const figureHeight = who => { const c = CAST[who] || CAST[LEAD]; return c.ry * 2 + 50; };

// ── settings: a painted place, in three depths, each with a light you can see ────────────────────────

const stars = (w, h, n, seed, t, top = 0.62) => { const r = rng(seed); let s = ''; for (let i = 0; i < n; i++) { const x = r() * (w + 400) - 200, y = r() * h * top, rad = 1.2 + r() * 2.6, tw = 0.55 + 0.45 * Math.sin(t * (1 + r() * 2) + r() * 6); s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(rad)}" fill="#fff" opacity="${f(tw * 100) / 100}"/>`; } return s; };
const hills = (w, y, amp, color, seed, n = 5) => { const r = rng(seed); let d = `M-300,${f(y)}`; const step = (w + 600) / n; for (let i = 0; i < n; i++) { const x0 = -300 + i * step; d += ` Q${f(x0 + step / 2)},${f(y - amp * (0.5 + r()))} ${f(x0 + step)},${f(y)}`; } return `<path d="${d} V${f(y + 2400)} H-300 Z" fill="${color}"/>`; };
const glow = (id, x, y, r) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="url(#${id})"/>`;
const motes = (w, h, n, seed, t, color, rise = 14) => { const r = rng(seed); let s = ''; for (let i = 0; i < n; i++) { const x0 = r() * w, y0 = r() * h, sp = 0.4 + r(), ph = r() * 6; const y = ((y0 - t * rise * sp) % h + h) % h, x = x0 + Math.sin(t * 0.7 + ph) * 18; s += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(2 + r() * 4)}" fill="${color}" opacity="${f((0.15 + r() * 0.35) * 100) / 100}"/>`; } return s; };

/**
 * Each setting returns { sky:[top,bottom], glow:[colour, x, y, radius], back, mid, ground, front } where the
 * layers are SVG strings. x/y of the glow are shares of the frame. `g` is the ground line in pixels.
 */
export const SETTINGS = Object.freeze({
  space: { words: ['space', 'orbit', 'galaxy', 'universe', 'cosmos'], sky: ['#0b0a2a', '#2a1a5e'], glow: ['#ff9a5a', 0.82, 0.2, 0.34],
    draw: ({ w, h, g, t, seed }) => ({ back: stars(w, h, 150, seed, t, 1), mid: `<circle cx="${f(w * 0.82)}" cy="${f(h * 0.2)}" r="${f(h * 0.07)}" fill="#ffb86b"/><circle cx="${f(w * 0.82 - h * 0.02)}" cy="${f(h * 0.2 - h * 0.02)}" r="${f(h * 0.045)}" fill="#ffd9a0" opacity="0.6"/>`, ground: `<path d="M-300,${f(g)} Q${f(w / 2)},${f(g - h * 0.07)} ${f(w + 300)},${f(g)} V${f(h + 400)} H-300 Z" fill="#3b2a78"/><ellipse cx="${f(w * 0.3)}" cy="${f(g + h * 0.07)}" rx="${f(w * 0.07)}" ry="${f(h * 0.014)}" fill="#2c1f5e"/><ellipse cx="${f(w * 0.72)}" cy="${f(g + h * 0.12)}" rx="${f(w * 0.1)}" ry="${f(h * 0.018)}" fill="#2c1f5e"/>`, front: motes(w, h, 14, seed + 3, t, '#b9a6ff', 5) }) },
  night: { words: ['night', 'midnight', 'dark', 'moonlit'], sky: ['#0d1b3e', '#27407a'], glow: ['#ffe9a8', 0.2, 0.2, 0.3],
    draw: ({ w, h, g, t, seed }) => ({ back: stars(w, h, 90, seed, t), mid: `<circle cx="${f(w * 0.2)}" cy="${f(h * 0.2)}" r="${f(h * 0.06)}" fill="#fff3c4"/><circle cx="${f(w * 0.2 + h * 0.025)}" cy="${f(h * 0.2 - h * 0.012)}" r="${f(h * 0.052)}" fill="#1a2c5c" opacity="0.55"/>` + hills(w, g - h * 0.02, h * 0.1, '#1c3160', seed + 1), ground: hills(w, g, h * 0.02, '#16284f', seed + 2, 3), front: motes(w, h, 10, seed + 3, t, '#ffe9a8', 8) }) },
  field: { words: ['field', 'farm', 'meadow', 'countryside', 'outside', 'village', 'grass', 'day', 'sky', 'air', 'park', 'garden'], sky: ['#4cc9f0', '#bdeeff'], glow: ['#fff1a8', 0.8, 0.18, 0.36],
    draw: ({ w, h, g, t, seed }) => ({ back: `<circle cx="${f(w * 0.8)}" cy="${f(h * 0.18)}" r="${f(h * 0.065)}" fill="#ffe066"/>` + cloudsSvg(w, h, t, seed), mid: hills(w, g - h * 0.03, h * 0.12, '#6cc56a', seed + 1) + hills(w, g - h * 0.01, h * 0.07, '#4fae58', seed + 5, 4), ground: hills(w, g, h * 0.015, '#3d9a4c', seed + 2, 3), front: '' }) },
  sunset: { words: ['sunset', 'dusk', 'evening', 'sunrise', 'dawn'], sky: ['#3d2b6b', '#ff8a5c'], glow: ['#ffd27a', 0.5, 0.56, 0.5],
    draw: ({ w, h, g, t, seed }) => ({ back: `<circle cx="${f(w * 0.5)}" cy="${f(g - h * 0.04)}" r="${f(h * 0.1)}" fill="#ffd27a"/>` + cloudsSvg(w, h, t, seed, '#ffb38a', 0.5), mid: hills(w, g - h * 0.02, h * 0.11, '#7a3b6e', seed + 1), ground: hills(w, g, h * 0.015, '#4a2550', seed + 2, 3), front: motes(w, h, 8, seed + 3, t, '#ffd27a', 6) }) },
  city: { words: ['city', 'town', 'street', 'paris', 'london', 'downtown', 'skyline', 'buildings'], sky: ['#1b2a57', '#f08a5d'], glow: ['#ffcf7a', 0.72, 0.5, 0.42],
    draw: ({ w, h, g, t, seed }) => { const r = rng(seed); let far = '', near = ''; for (let i = -2; i < 16; i++) { const bw = w * (0.05 + r() * 0.04), bh = h * (0.14 + r() * 0.26), x = i * w * 0.075 + r() * 20; far += `<rect x="${f(x)}" y="${f(g - bh)}" width="${f(bw)}" height="${f(bh + 20)}" fill="#2a3a78"/>`; } for (let i = -2; i < 11; i++) { const bw = w * (0.07 + r() * 0.05), bh = h * (0.1 + r() * 0.2), x = i * w * 0.11 + r() * 30; near += `<rect x="${f(x)}" y="${f(g - bh)}" width="${f(bw)}" height="${f(bh + 20)}" fill="#1a2552"/>`; for (let k = 0; k < 6; k++) { if (r() < 0.55) { const wx = x + bw * (0.18 + (k % 2) * 0.42), wy = g - bh + bh * (0.12 + Math.floor(k / 2) * 0.26); near += `<rect x="${f(wx)}" y="${f(wy)}" width="${f(bw * 0.2)}" height="${f(bh * 0.12)}" fill="#ffd97a" opacity="${f((0.7 + 0.3 * Math.sin(t * 1.3 + k + i)) * 100) / 100}"/>`; } } } return { back: stars(w, h, 30, seed, t, 0.4), mid: far, ground: near + `<rect x="-300" y="${f(g)}" width="${f(w + 600)}" height="${f(h)}" fill="#141c40"/><rect x="-300" y="${f(g + h * 0.06)}" width="${f(w + 600)}" height="${f(h * 0.008)}" fill="#3a4a8a"/>`, front: '' }; } },
  lab: { words: ['lab', 'laboratory', 'science', 'experiment', 'research', 'workshop'], sky: ['#16324f', '#1f5f7a'], glow: ['#8dffd6', 0.5, 0.12, 0.42],
    draw: ({ w, h, g, t }) => ({ back: `<rect x="-300" y="0" width="${f(w + 600)}" height="${f(g)}" fill="none"/>` + [0.14, 0.4, 0.66, 0.9].map(k => `<rect x="${f(w * k - w * 0.09)}" y="${f(h * 0.22)}" width="${f(w * 0.18)}" height="${f(h * 0.012)}" fill="#0f2740"/>`).join('') + [0.1, 0.17, 0.37, 0.44, 0.62, 0.7, 0.87].map((k, i) => `<rect x="${f(w * k)}" y="${f(h * 0.22 - h * (0.04 + (i % 3) * 0.015))}" width="${f(w * 0.022)}" height="${f(h * (0.04 + (i % 3) * 0.015))}" rx="6" fill="${['#8dffd6', '#ff8fb3', '#ffd97a'][i % 3]}" opacity="0.85"/>`).join(''), mid: `<path d="M${f(w * 0.5)},0 V${f(h * 0.09)}" stroke="#0f2740" stroke-width="6"/><circle cx="${f(w * 0.5)}" cy="${f(h * 0.12)}" r="${f(h * 0.028)}" fill="#d8fff2"/>`, ground: `<rect x="-300" y="${f(g)}" width="${f(w + 600)}" height="${f(h)}" fill="#0f2740"/><rect x="-300" y="${f(g)}" width="${f(w + 600)}" height="${f(h * 0.012)}" fill="#2a7f95"/>`, front: motes(w, h, 12, 7, t, '#8dffd6', 10) }) },
  room: { words: ['room', 'house', 'home', 'inside', 'office', 'kitchen', 'indoors', 'hall', 'museum', 'shop'], sky: ['#3b2a45', '#6b3f55'], glow: ['#ffcf7a', 0.5, 0.2, 0.46],
    draw: ({ w, h, g }) => ({ back: `<rect x="${f(w * 0.08)}" y="${f(h * 0.2)}" width="${f(w * 0.2)}" height="${f(h * 0.22)}" rx="10" fill="#22304f"/><path d="M${f(w * 0.18)},${f(h * 0.2)} v${f(h * 0.22)} M${f(w * 0.08)},${f(h * 0.31)} h${f(w * 0.2)}" stroke="#3b2a45" stroke-width="8"/><rect x="${f(w * 0.7)}" y="${f(h * 0.24)}" width="${f(w * 0.16)}" height="${f(h * 0.14)}" rx="8" fill="#8a5a6a"/><rect x="${f(w * 0.72)}" y="${f(h * 0.26)}" width="${f(w * 0.12)}" height="${f(h * 0.1)}" fill="#f4c95d" opacity="0.5"/>`, mid: `<path d="M${f(w * 0.5)},0 V${f(h * 0.15)}" stroke="#241a2c" stroke-width="6"/><path d="M${f(w * 0.5 - h * 0.045)},${f(h * 0.19)} l${f(h * 0.02)},${f(-h * 0.045)} h${f(h * 0.05)} l${f(h * 0.02)},${f(h * 0.045)} Z" fill="#241a2c"/><circle cx="${f(w * 0.5)}" cy="${f(h * 0.2)}" r="${f(h * 0.022)}" fill="#fff0c2"/>`, ground: `<rect x="-300" y="${f(g)}" width="${f(w + 600)}" height="${f(h)}" fill="#2a1d33"/><rect x="-300" y="${f(g)}" width="${f(w + 600)}" height="${f(h * 0.014)}" fill="#8a5a6a"/>`, front: '' }) },
  ocean: { words: ['ocean', 'sea', 'underwater', 'water', 'deep', 'lake', 'river'], sky: ['#0a4d8c', '#04264d'], glow: ['#7ae7ff', 0.5, 0.0, 0.6],
    draw: ({ w, h, g, t, seed }) => ({ back: [0.2, 0.42, 0.63, 0.82].map((k, i) => `<path d="M${f(w * k)},0 L${f(w * k + w * 0.12 + Math.sin(t * 0.6 + i) * 20)},${f(h)} h${f(w * 0.07)} L${f(w * k + w * 0.05)},0 Z" fill="#7ae7ff" opacity="0.07"/>`).join(''), mid: hills(w, g - h * 0.02, h * 0.09, '#0b3a6b', seed + 1), ground: hills(w, g, h * 0.02, '#082b52', seed + 2, 4) + [0.12, 0.34, 0.86].map((k, i) => `<path d="M${f(w * k)},${f(g + 10)} q${f(18 + Math.sin(t * 1.4 + i) * 16)},${f(-h * 0.06)} 0,${f(-h * 0.12)}" stroke="#2fbf8f" stroke-width="12" fill="none" stroke-linecap="round"/>`).join(''), front: motes(w, h, 22, seed + 3, t, '#c9f6ff', 34) }) },
  desert: { words: ['desert', 'sand', 'dunes', 'outback', 'egypt', 'wasteland', 'dry'], sky: ['#ffb347', '#ffe0a3'], glow: ['#fff3c4', 0.78, 0.2, 0.4],
    draw: ({ w, h, g, t, seed }) => ({ back: `<circle cx="${f(w * 0.78)}" cy="${f(h * 0.2)}" r="${f(h * 0.07)}" fill="#fff3c4"/>`, mid: hills(w, g - h * 0.02, h * 0.13, '#e89b4a', seed + 1, 4) + hills(w, g - h * 0.005, h * 0.07, '#d98236', seed + 4, 3), ground: hills(w, g, h * 0.012, '#c46f2c', seed + 2, 3), front: motes(w, h, 9, seed + 3, t, '#fff3c4', 4) }) },
  forest: { words: ['forest', 'woods', 'jungle', 'trees', 'rainforest'], sky: ['#0f3d3e', '#2f7d5b'], glow: ['#fff1a8', 0.3, 0.14, 0.42],
    draw: ({ w, h, g, t, seed }) => { const r = rng(seed); let far = '', near = ''; for (let i = 0; i < 12; i++) { const x = r() * (w + 400) - 200, th = h * (0.3 + r() * 0.2); far += `<rect x="${f(x - 9)}" y="${f(g - th * 0.5)}" width="18" height="${f(th * 0.5)}" fill="#0c2e30"/><path d="M${f(x)},${f(g - th)} l${f(th * 0.24)},${f(th * 0.6)} h${f(-th * 0.48)} Z" fill="#1b5a4a"/>`; } for (let i = 0; i < 5; i++) { const x = [0.02, 0.16, 0.88, 0.98, 0.6][i] * w + r() * 30, th = h * (0.5 + r() * 0.16); near += `<rect x="${f(x - 16)}" y="${f(g - th * 0.5)}" width="32" height="${f(th * 0.5)}" fill="#07201f"/><path d="M${f(x)},${f(g - th)} l${f(th * 0.22)},${f(th * 0.62)} h${f(-th * 0.44)} Z" fill="#124236"/>`; } return { back: `<path d="M${f(w * 0.3)},0 L${f(w * 0.52)},${f(g)} h${f(w * 0.12)} L${f(w * 0.36)},0 Z" fill="#fff1a8" opacity="0.1"/>`, mid: far, ground: hills(w, g, h * 0.015, '#0b2a25', seed + 2, 3) + near, front: motes(w, h, 16, seed + 3, t, '#eaffb0', 9) }; } },
  mountains: { words: ['mountain', 'mountains', 'peak', 'alps', 'cliff', 'island', 'coast', 'rocks'], sky: ['#5b7fc7', '#cfe3ff'], glow: ['#fff6d6', 0.24, 0.2, 0.38],
    draw: ({ w, h, g, t, seed }) => { const peak = (cx, ph, bw, col) => `<path d="M${f(cx - bw)},${f(g)} L${f(cx)},${f(g - ph)} L${f(cx + bw)},${f(g)} Z" fill="${col}"/><path d="M${f(cx - bw * 0.2)},${f(g - ph * 0.8)} L${f(cx)},${f(g - ph)} L${f(cx + bw * 0.2)},${f(g - ph * 0.8)} l${f(-bw * 0.1)},${f(ph * 0.06)} l${f(-bw * 0.1)},${f(-ph * 0.05)} l${f(-bw * 0.1)},${f(ph * 0.05)} Z" fill="#fff"/>`; return { back: `<circle cx="${f(w * 0.24)}" cy="${f(h * 0.2)}" r="${f(h * 0.055)}" fill="#fff6d6"/>` + cloudsSvg(w, h, t, seed), mid: peak(w * 0.2, h * 0.34, w * 0.26, '#6b78b4') + peak(w * 0.72, h * 0.42, w * 0.3, '#5a67a6') + peak(w * 0.46, h * 0.26, w * 0.22, '#7d8ac4'), ground: hills(w, g, h * 0.02, '#4a5a8f', seed + 2, 3), front: '' }; } },
  snow: { words: ['snow', 'ice', 'arctic', 'winter', 'frozen', 'antarctica', 'siberia', 'cold'], sky: ['#3a5a8c', '#cfe8ff'], glow: ['#ffe7b8', 0.7, 0.24, 0.36],
    draw: ({ w, h, g, t, seed }) => { const r = rng(seed + 9); let fl = ''; for (let i = 0; i < 46; i++) { const x0 = r() * w, y0 = r() * h, sp = 40 + r() * 60; fl += `<circle cx="${f(x0 + Math.sin(t + i) * 14)}" cy="${f(((y0 + t * sp) % h))}" r="${f(2.5 + r() * 3.5)}" fill="#fff" opacity="0.85"/>`; } return { back: `<circle cx="${f(w * 0.7)}" cy="${f(h * 0.24)}" r="${f(h * 0.05)}" fill="#ffe7b8"/>`, mid: hills(w, g - h * 0.02, h * 0.12, '#dbeaff', seed + 1), ground: hills(w, g, h * 0.02, '#f4f9ff', seed + 2, 3), front: fl }; } },
  micro: { words: ['cell', 'body', 'blood', 'microscopic', 'inside the body', 'bacteria', 'tiny', 'atom', 'molecule', 'brain'], sky: ['#5a1846', '#c2255c'], glow: ['#ffb3c7', 0.5, 0.4, 0.6],
    draw: ({ w, h, g, t, seed }) => { const r = rng(seed); let blobs = ''; for (let i = 0; i < 12; i++) { const x = r() * w, y = r() * h, rad = h * (0.03 + r() * 0.06), ph = r() * 6; blobs += `<circle cx="${f(x + Math.sin(t * 0.5 + ph) * 24)}" cy="${f(y + Math.cos(t * 0.4 + ph) * 24)}" r="${f(rad)}" fill="#ff8fab" opacity="0.16"/>`; } return { back: blobs, mid: hills(w, g - h * 0.01, h * 0.06, '#8a1c4f', seed + 1), ground: hills(w, g, h * 0.02, '#6a123f', seed + 2, 4), front: motes(w, h, 20, seed + 3, t, '#ffd1dc', 12) }; } },
});

function cloudsSvg(w, h, t, seed, color = '#fff', op = 0.9) {
  const r = rng(seed + 11); let s = '';
  for (let i = 0; i < 4; i++) { const y = h * (0.08 + r() * 0.2), sc = 0.7 + r() * 0.7, x = ((r() * w + t * (6 + i * 3)) % (w + 500)) - 250; s += `<g transform="translate(${f(x)},${f(y)}) scale(${f(sc * 100) / 100})" fill="${color}" opacity="${op}"><ellipse cx="0" cy="0" rx="90" ry="34"/><ellipse cx="-52" cy="10" rx="56" ry="26"/><ellipse cx="56" cy="12" rx="62" ry="24"/><ellipse cx="10" cy="-22" rx="52" ry="30"/></g>`; }
  return s;
}

export const SETTING_NAMES = Object.freeze(Object.keys(SETTINGS));
/** What a setting already paints in its sky: asking for the same thing as a prop would draw it twice. */
export const ALREADY_THERE = Object.freeze({ field: ['sun'], desert: ['sun'], sunset: ['sun'], mountains: ['sun'], snow: ['sun'], night: ['moon'], space: ['star'] });

/** Camera: zoom and pan as a function of progress through the shot (0…1). */
export function cameraAt(move, p) {
  const k = ease(p);
  switch (move) {
    case 'push': return { z: 1 + 0.1 * k, px: 0, py: 0 };
    case 'pull': return { z: 1.1 - 0.1 * k, px: 0, py: 0 };
    case 'pan-left': return { z: 1.06, px: 70 - 140 * k, py: 0 };
    case 'pan-right': return { z: 1.06, px: -70 + 140 * k, py: 0 };
    case 'rise': return { z: 1.06, px: 0, py: 46 - 92 * k };
    default: return { z: 1 + 0.02 * k, px: 0, py: 0 };
  }
}

export { f as fmt, clamp, ease, backOut, glow };
