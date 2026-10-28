// Two emoji encoding variants:
// 1. Visible: 16-emoji alphabet (forms.js) — human-readable
// 2. Steganographic: Unicode variation selectors (fraymusComms.js) — invisible to most renderers
import { EMOJI_ALPHABET, STEGO_BASE_EMOJI } from '../core/constants.js';

// ═══ Visible Emoji (16-symbol alphabet) ═══

export function toEmoji(u8) {
  return [...u8].map((b) => EMOJI_ALPHABET[b >> 4] + EMOJI_ALPHABET[b & 15]).join('');
}

export function fromEmoji(s) {
  const chars = [...s];
  const out = [];
  for (let i = 0; i + 1 < chars.length; i += 2) {
    const hi = EMOJI_ALPHABET.indexOf(chars[i]);
    const lo = EMOJI_ALPHABET.indexOf(chars[i + 1]);
    if (hi >= 0 && lo >= 0) out.push((hi << 4) | lo);
  }
  return new Uint8Array(out);
}

// ═══ Steganographic Emoji (variation selector encoding) ═══

export function encodeEmoji(bytes) {
  let out = '';
  for (const b of bytes) {
    out += STEGO_BASE_EMOJI;
    out += String.fromCodePoint(b < 16 ? 0xFE00 + b : 0xE0100 + (b - 16));
  }
  return out;
}

export function decodeEmoji(str) {
  const out = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xFE00 && cp <= 0xFE0F) out.push(cp - 0xFE00);
    else if (cp >= 0xE0100 && cp <= 0xE01EF) out.push(cp - 0xE0100 + 16);
  }
  return new Uint8Array(out);
}

export function stripEmoji(str) {
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xFE00 && cp <= 0xFE0F) continue;
    if (cp >= 0xE0100 && cp <= 0xE01EF) continue;
    out += ch;
  }
  return out;
}
