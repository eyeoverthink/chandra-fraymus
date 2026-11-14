/**
 * The outline and main colour of every flat prop, measured from its own drawing rather than drawn by hand: the prop
 * is rendered once by Skia, its pixels become a mask (nearby parts joined by a small closing so a bird's wings and
 * body are one shape), the largest outline is traced by marching squares (looks/vector.js) and resampled for the
 * morph. Adding a prop to props.js gives it a silhouette with no further work. Cached per prop for the process.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PROPS } from './props.js';
import { contours } from '../looks/vector.js';
import { morph } from '../looks/layers.js';
import { resampleClosed, signedArea, rgbToHex, MORPH_POINTS } from './morph.js';

const SIZE = 640, HALF = SIZE / 2, STEP = 4;          // props are drawn within about ±300 units of their origin
const cache = new Map();

/** @returns {Promise<{ name, loop: [x, y][] in prop units, colour: '#rrggbb', area }>} */
export async function silhouetteOf(name) {
  if (cache.has(name)) return cache.get(name);
  const prop = PROPS[name];
  if (!prop) throw new Error(`no prop named ${name}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="${-HALF} ${-HALF} ${SIZE} ${SIZE}">${prop.draw(0.4)}</svg>`;
  const pic = await loadImage(Buffer.from(svg));
  const c = createCanvas(SIZE, SIZE), ctx = c.getContext('2d');
  ctx.drawImage(pic, 0, 0);
  const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const gw = SIZE / STEP, mask = new Uint8Array(gw * gw), votes = new Map();
  for (let y = 0; y < gw; y++) for (let x = 0; x < gw; x++) {
    const i = ((y * STEP + 2) * SIZE + x * STEP + 2) * 4;
    if (d[i + 3] > 60) {
      mask[y * gw + x] = 1;
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);   // 4 bits a channel: near colours vote together
      votes.set(key, (votes.get(key) || 0) + 1);
    }
  }
  const closed = morph(morph(mask, gw, gw, 3), gw, gw, -3);          // join parts that almost touch
  const loops = contours(closed, gw, gw);
  if (!loops.length) throw new Error(`prop ${name} draws nothing that can be outlined`);
  let best = loops[0];
  for (const l of loops) if (Math.abs(signedArea(l)) > Math.abs(signedArea(best))) best = l;
  let top = 0, topKey = 0;
  for (const [k, v] of votes) if (v > top) { top = v; topKey = k; }
  const colour = rgbToHex([((topKey >> 8) & 15) * 17, ((topKey >> 4) & 15) * 17, (topKey & 15) * 17]);
  const loop = resampleClosed(best.map(([x, y]) => [x * STEP - HALF, y * STEP - HALF]), MORPH_POINTS);
  const out = { name, loop, colour, area: Math.abs(signedArea(best)) * STEP * STEP };
  cache.set(name, out);
  return out;
}
