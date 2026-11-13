/**
 * Looks that redraw a picture out of things rather than filter its pixels: ASCII characters and toy bricks.
 * Both read a small grid of the picture and draw each cell at full size with @napi-rs/canvas, so the output
 * is crisp at any resolution. Deterministic: the same picture gives the same frame.
 */
import { createRequire } from 'node:module';
import { image, luminance } from './filters.js';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas');

function cellAverages(src, cols, rows) {
  const { w, h, d } = src, out = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.floor(c * w / cols), x1 = Math.max(x0 + 1, Math.floor((c + 1) * w / cols)), y0 = Math.floor(r * h / rows), y1 = Math.max(y0 + 1, Math.floor((r + 1) * h / rows));
    let a = 0, b = 0, e = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const p = (y * w + x) * 3; a += d[p]; b += d[p + 1]; e += d[p + 2]; n++; }
    const o = (r * cols + c) * 3; out[o] = a / n; out[o + 1] = b / n; out[o + 2] = e / n;
  }
  return out;
}
const toImage = (canvas, w, h) => {
  const rgba = canvas.getContext('2d').getImageData(0, 0, w, h).data, out = image(w, h);
  for (let i = 0, p = 0; p < rgba.length; i += 3, p += 4) { out.d[i] = rgba[p]; out.d[i + 1] = rgba[p + 1]; out.d[i + 2] = rgba[p + 2]; }
  return out;
};

const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
/** ASCII art: each cell's brightness picks a character from a 70-step ramp; `color` keeps each cell's hue,
 *  otherwise phosphor green on black. Output w×h; `cols` characters across.
 *
 *  A character covers only about a quarter of its cell, so drawing it in the cell's own colour kept about a third of the
 *  picture's light (measured 0.32 on a shaded 3-D render). So: the ramp is read through a gamma (mid tones get dense
 *  characters), each character is drawn in the cell's hue lifted toward full brightness, and cells darker than
 *  `blank` (the picture's own near-black) stay empty, so a dark backdrop does not fill with dots. */
export function ascii(src, { w = 1920, h = 1080, cols = 160, color = true, blank = 30, tint = 0.28 } = {}) {
  const cw = w / cols, ch = cw * 1.85, rows = Math.max(1, Math.floor(h / ch)), avg = cellAverages(src, cols, rows);
  const canvas = createCanvas(w, h), g = canvas.getContext('2d');
  g.fillStyle = '#05070a'; g.fillRect(0, 0, w, h);
  g.font = `bold ${Math.round(ch * 0.95)}px Consolas, "Courier New", monospace`; g.textBaseline = 'top';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const o = (r * cols + c) * 3, l = 0.299 * avg[o] + 0.587 * avg[o + 1] + 0.114 * avg[o + 2];
    if (l < blank) continue;
    const t = Math.min(1, (l - blank) / (255 - blank)), ch2 = RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(Math.pow(t, 0.7) * (RAMP.length - 1)))];
    if (ch2 === ' ') continue;
    const x = c * cw, y = r * ch + (h - rows * ch) / 2;
    if (tint > 0) {                                                          // the cell, faintly, in its own colour: the figure keeps its body
      g.fillStyle = color ? `rgb(${(avg[o] * tint) | 0},${(avg[o + 1] * tint) | 0},${(avg[o + 2] * tint) | 0})` : `rgb(0,${(l * tint * 0.6) | 0},${(l * tint * 0.2) | 0})`;
      g.fillRect(Math.floor(x), Math.floor(y), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
    }
    if (color) {
      const top = Math.max(1, avg[o], avg[o + 1], avg[o + 2]), bright = 120 + 135 * Math.pow(t, 0.6), k = bright / top;
      g.fillStyle = `rgb(${Math.min(255, avg[o] * k) | 0},${Math.min(255, avg[o + 1] * k) | 0},${Math.min(255, avg[o + 2] * k) | 0})`;
    } else {
      const v = 90 + 165 * Math.pow(t, 0.6);
      g.fillStyle = `rgb(${(v * 0.25) | 0},${Math.min(255, v) | 0},${(v * 0.35) | 0})`;
    }
    g.fillText(ch2, x, y);
  }
  return toImage(canvas, w, h);
}

// Toy-brick colours (common plastic-brick shades, approximate)
const BRICKS = ['#f4f4f4', '#a0a5a9', '#6c6e68', '#1b2a34', '#05131d', '#6074a1', '#0a3463', '#3f5a72', '#c91a09', '#720e0f', '#fe8a18', '#f2cd37', '#bbe90b', '#237841', '#4b9f4a', '#0055bf', '#5a93db', '#36aebf', '#81007b', '#e4adc8', '#d67923', '#a0bcac', '#e4cd9e', '#958a73', '#582a12', '#352100', '#aa7d55']
  .map(s => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]);
/** Toy-brick mosaic: the picture rebuilt from 1×1 plates in real brick colours, each with a lit stud.
 *  Output w×h; `studs` plates across. */
export function brick(src, { w = 1920, h = 1080, studs = 64 } = {}) {
  const s = w / studs, rows = Math.max(1, Math.round(h / s)), avg = cellAverages(src, studs, rows);
  const canvas = createCanvas(w, h), g = canvas.getContext('2d');
  g.fillStyle = '#111'; g.fillRect(0, 0, w, h);
  const top = (h - rows * s) / 2;
  for (let r = 0; r < rows; r++) for (let c = 0; c < studs; c++) {
    const o = (r * studs + c) * 3;
    let best = BRICKS[0], bd = Infinity;
    for (const b of BRICKS) { const dd = (avg[o] - b[0]) ** 2 * 0.3 + (avg[o + 1] - b[1]) ** 2 * 0.59 + (avg[o + 2] - b[2]) ** 2 * 0.11; if (dd < bd) { bd = dd; best = b; } }
    const x = c * s, y = top + r * s, [R, G, B] = best, sh = k => `rgb(${(R * k) | 0},${(G * k) | 0},${(B * k) | 0})`;
    g.fillStyle = sh(0.78); g.fillRect(x, y, s, s);
    g.fillStyle = sh(1); g.fillRect(x + 1, y + 1, s - 2.5, s - 2.5);
    const cx = x + s / 2, cy = y + s / 2, rad = s * 0.3;
    g.beginPath(); g.arc(cx + s * 0.05, cy + s * 0.06, rad, 0, Math.PI * 2); g.fillStyle = sh(0.62); g.fill();
    g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fillStyle = sh(1.06); g.fill();
    g.beginPath(); g.arc(cx - rad * 0.3, cy - rad * 0.3, rad * 0.45, Math.PI, Math.PI * 1.6); g.strokeStyle = `rgba(255,255,255,0.55)`; g.lineWidth = Math.max(1, s * 0.06); g.stroke();
  }
  return toImage(canvas, w, h);
}

export const GLYPH_LOOKS = Object.freeze({
  ascii: { fn: ascii, label: 'ASCII', technique: 'the picture redrawn in coloured characters (70-step brightness ramp)', hold: 2, fullSize: true },
  'ascii-green': { fn: (src, o) => ascii(src, { ...o, color: false }), label: 'ASCII terminal', technique: 'phosphor-green characters on black', hold: 2, fullSize: true },
  brick: { fn: brick, label: 'Toy bricks', technique: 'a mosaic of 1×1 plates in real brick colours, each with a lit stud', hold: 2, fullSize: true },
});
export { luminance };
