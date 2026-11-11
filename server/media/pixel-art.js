/**
 * Pixel art — turn any image into an authentic 2-bit or 8-bit still.
 *
 * Same method as the pixel recipes in fraymus-video-studio (studio/gfx.py quantize / pixelate), ported
 * so a still does not need Python: cover-crop to the console's native resolution, ordered 4×4 Bayer
 * dither, map to the palette, integer nearest-neighbour upscale. Palettes of four colours or fewer are
 * mapped by a luminance ramp (the Game Boy way); larger ones by nearest RGB.
 *
 * Pure: no database, no network, no clock. sharp does the resampling and the PNG.
 */
import sharp from 'sharp';

export const PALETTES = Object.freeze({
  gb: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  'gb-mono': ['#000000', '#555555', '#aaaaaa', '#ffffff'],
  'gb-pocket': ['#1f1f1f', '#4d533c', '#8b956d', '#c4cfa1'],
  nes: ['#000000', '#fcfcfc', '#7c7c7c', '#bcbcbc', '#0000fc', '#0078f8', '#3cbcfc', '#a4e4fc', '#940084', '#d800cc',
    '#f878f8', '#a80020', '#f83800', '#f87858', '#fca044', '#ac7c00', '#f8b800', '#00b800', '#58d854', '#b8f818',
    '#005800', '#008888', '#00e8d8', '#503000', '#fce0a8', '#6844fc', '#e40058', '#881400'],
});

/** Native resolution (16:9) and integer scale to 1080p for each look. */
export const STYLES = Object.freeze({
  '2bit': { native: [240, 135], scale: 8, palette: 'gb', label: 'Game Boy, four shades' },
  '8bit': { native: [320, 180], scale: 6, palette: 'nes', label: 'NES, 28-colour palette' },
});

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => v / 16 - 0.5);
const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

export function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A palette name or a list of hex colours → { name, colours: [[r,g,b], …] }. */
export function resolvePalette(nameOrList, fallback = 'nes') {
  if (Array.isArray(nameOrList)) {
    if (nameOrList.length < 2 || nameOrList.length > 64) throw new Error('a custom palette needs 2 to 64 colours');
    return { name: 'custom', colours: nameOrList.map(hexRgb) };
  }
  const name = Object.hasOwn(PALETTES, nameOrList) ? nameOrList : fallback;
  return { name, colours: PALETTES[name].map(hexRgb) };
}

/** Native size and scale for a style and frame shape ('16:9' | '9:16' | '1:1'). */
export function nativeSize(style, format = '16:9') {
  const s = STYLES[style] || STYLES['8bit'];
  const [w, h] = s.native;
  if (format === '9:16') return { w: h, h: w, scale: s.scale };
  if (format === '1:1') return { w: h, h, scale: s.scale };
  return { w, h, scale: s.scale };
}

/**
 * Map every pixel of a raw RGB buffer to a palette colour.
 * @param {Uint8Array} rgb  width × height × 3 bytes
 * @returns {Buffer} same shape, palette colours only
 */
export function quantize(rgb, width, height, colours, { dither = true } = {}) {
  if (rgb.length !== width * height * 3) throw new Error(`expected ${width * height * 3} bytes, got ${rgb.length}`);
  const n = colours.length;
  const out = Buffer.allocUnsafe(rgb.length);
  const spread = (255 / Math.max(2, n)) * 0.9;
  const ramp = n <= 4 ? [...colours].sort((a, b) => lum(...a) - lum(...b)) : null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const d = dither ? BAYER[(y & 3) * 4 + (x & 3)] * spread : 0;
      const r = rgb[i] + d, g = rgb[i + 1] + d, b = rgb[i + 2] + d;
      let c;
      if (ramp) {
        c = ramp[Math.min(n - 1, Math.max(0, Math.floor((lum(r, g, b) / 256) * n)))];
      } else {
        let best = Infinity;
        for (const p of colours) {
          const dist = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
          if (dist < best) { best = dist; c = p; }
        }
      }
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
    }
  }
  return out;
}

/** Distinct colours in a raw RGB buffer (for checking a result really is palette-only). */
export function distinctColours(rgb) {
  const seen = new Set();
  for (let i = 0; i < rgb.length; i += 3) seen.add((rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2]);
  return seen.size;
}

/**
 * Image bytes in, pixel-art PNG out.
 * @returns {{ png: Buffer, width, height, native: {w,h}, scale, style, palette, colours }}
 */
export async function pixelateBuffer(input, { style = '8bit', palette, format = '16:9', dither = true } = {}) {
  if (!STYLES[style]) throw new Error(`unknown pixel style: ${style} (have ${Object.keys(STYLES).join(', ')})`);
  const pal = resolvePalette(palette ?? STYLES[style].palette, STYLES[style].palette);
  const { w, h, scale } = nativeSize(style, format);
  const { data, info } = await sharp(input).rotate().flatten({ background: '#000000' }).toColourspace('srgb')
    .resize(w, h, { fit: 'cover', position: 'attention' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected an RGB image after conversion, got ${info.channels} channel(s)`);
  const q = quantize(data, w, h, pal.colours, { dither });
  const png = await sharp(q, { raw: { width: w, height: h, channels: 3 } })
    .resize(w * scale, h * scale, { kernel: 'nearest' }).png({ compressionLevel: 9 }).toBuffer();
  return { png, width: w * scale, height: h * scale, native: { w, h }, scale, style, palette: pal.name, colours: distinctColours(q) };
}
