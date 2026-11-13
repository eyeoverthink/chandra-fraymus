/**
 * Style recipes: how to *generate* a new picture in a look — a written description of the look's visual traits
 * for the image model, what to keep out of it, and which filter finishes it (looks/filters.js).
 *
 * Names of artists, studios and films are only used to route a request to a recipe ("Miyazaki" → pastoral-anime).
 * They never go into the image prompt: a style is described by its traits, not by whose it is. Characters that
 * belong to a franchise (Goku, Astro Boy, Totoro, Miles Morales…) are never drawn — the request's subject is
 * rewritten to "an original character" and the result says so. Pure: no I/O.
 */

export const RECIPES = Object.freeze({
  'pastoral-anime': {
    label: 'Pastoral hand-painted anime', aliases: ['miyazaki', 'hayao', 'ghibli', 'studio ghibli', 'totoro style', 'spirited away style'],
    style: 'hand-painted 2D anime film still, lush watercolour background painting, soft natural daylight, rolling countryside and big painterly clouds, gentle expressive character design with simple shapes, warm nostalgic colour palette, detailed foliage',
    negative: 'photo, 3d render, harsh lighting, text, watermark, logo, deformed', post: null,
  },
  'classic-manga': {
    label: 'Classic 1960s manga', aliases: ['tezuka', 'osamu tezuka', 'osamu', 'samu tezuka', '1960s manga', 'vintage manga', 'old manga'],
    style: '1960s manga and early television anime style, big round expressive eyes, simple rounded character shapes, bold clean ink lines, screentone shading, limited flat colours, retro futurism',
    negative: 'photo, realistic, 3d render, modern anime, text, watermark, deformed', post: 'anime-cel',
  },
  'retro-robot-anime': {
    label: 'Retro atomic-age robot anime', aliases: ['astro boy', 'astroboy', 'atom boy', 'mighty atom', 'atomic age anime'],
    style: '1960s retro sci-fi anime, an original small heroic robot child with big round eyes and jet boots, clean cel shading, bright primary colours, atomic-age city skyline with rocket towers, optimistic',
    negative: 'photo, realistic, gritty, 3d render, text, watermark, logo, deformed', post: 'anime-cel',
  },
  'shonen-action': {
    label: '90s shonen action anime', aliases: ['dragon ball', 'dragonball', 'dbz', 'dragon ball z', 'toriyama', 'super saiyan', 'shonen'],
    style: '1990s shonen action anime screenshot, an original spiky-haired martial artist in a dynamic fighting pose, glowing energy aura, speed lines, bold cel shading with hard shadows, saturated colours, rocky wasteland and blue sky',
    negative: 'photo, realistic, 3d render, chibi, text, watermark, logo, deformed hands', post: 'anime-cel',
  },
  'comic-hybrid': {
    label: 'Comic-book 3D hybrid', aliases: ['spider-verse', 'spiderverse', 'spider verse', 'into the spider-verse', 'across the spider-verse', 'comic hybrid', 'halftone'],
    style: 'stylised 3D animated film still printed like a comic book, halftone dots in the shadows, bold ink outlines, graffiti colours, chromatic offset, dynamic low camera angle, city at night',
    negative: 'photo, realistic skin, blurry, text, watermark, logo', post: 'comic-hybrid',
  },
  'painted-3d': {
    label: 'Painted 3D', aliases: ['arcane', 'painted 3d', 'oil painting animation', 'gouache animation', 'fortiche'],
    style: 'stylised 3D character render with hand-painted textures, visible oil and gouache brush strokes, painterly lighting with strong rim light, moody steampunk city, cinematic',
    negative: 'photo, plastic, smooth cg, text, watermark, logo', post: 'painted',
  },
  'gold-ornament': {
    label: 'Golden ornament', aliases: ['klimt', 'gustav klimt', 'mia and me', 'art nouveau gold', 'golden period'],
    style: 'art nouveau painting with ornamental golden patterns, gold leaf mosaic of spirals, squares and eyes, decorative flowers, a flat ornamented figure with a delicately painted face',
    negative: 'photo, 3d render, text, watermark, logo', post: 'ornament',
  },
  woodblock: {
    label: 'Woodblock print', aliases: ['ukiyo-e', 'ukiyoe', 'woodblock', 'hokusai', 'hiroshige', 'samurai jack', 'kubo', 'kubo and the two strings'],
    style: 'Japanese ukiyo-e woodblock print, flat planes of colour, bold black outlines, bokashi gradient sky, stylised waves and mountains, washi paper texture',
    negative: 'photo, 3d render, gradient shading, text, watermark, signature', post: 'woodblock',
  },
  brunaille: {
    label: 'Brunaille storybook', aliases: ['over the garden wall', 'fleischer', 'brunaille', 'vintage storybook', '1920s cartoon', 'rubber hose'],
    style: 'vintage 1920s storybook illustration, muted brown monochrome watercolour, autumn forest at dusk, a rubber-hose style cartoon character, soft vignette, aged paper',
    negative: 'photo, 3d render, saturated colours, text, watermark', post: 'brunaille',
  },
  cutout: {
    label: 'Paper cutout', aliases: ['fantastic planet', 'la planete sauvage', 'paper cutout', 'cutout animation', 'cut-out', '1970s psychedelic'],
    style: '1970s surreal psychedelic science-fiction illustration made of flat paper cutouts, intricate pen linework, strange alien landscape, muted blues and ochres',
    negative: 'photo, 3d render, glossy, text, watermark', post: 'cutout',
  },
  'lowpoly-ink': {
    label: 'Low-poly ink', aliases: ['tekkonkinkreet', 'tekkon', 'low poly', 'low-poly', 'lowpoly'],
    style: 'dense hand-drawn ink cityscape, chaotic signage and wires, low-poly 3D shapes covered in loose raw ink textures, warm sunset colour',
    negative: 'photo, clean vector, text, watermark', post: 'lowpoly-ink',
  },
  'charcoal-watercolor': {
    label: 'Charcoal and watercolour', aliases: ['red turtle', 'the red turtle', 'charcoal', 'watercolor', 'watercolour'],
    style: 'soft charcoal line drawing with delicate watercolour washes, minimal composition, a quiet island shore and sea, pale sky, lots of empty space',
    negative: 'photo, 3d render, saturated colours, text, watermark', post: 'charcoal-watercolor',
  },
  rotoscope: {
    label: 'Rotoscope graphic novel', aliases: ['waltz with bashir', 'rotoscope', 'rotoscoped', 'a scanner darkly', 'graphic novel animation'],
    style: 'graphic novel rotoscoped animation still, flat colours, heavy black outlines, dreamlike documentary scene, night lit by flares',
    negative: 'photo, 3d render, text, watermark', post: 'rotoscope',
  },
  flat: {
    label: 'Flat vector explainer', aliases: ['kurzgesagt', 'in a nutshell', 'flat vector', 'flat design', 'explainer art'],
    style: 'flat vector illustration, simple geometric shapes, cute round characters with dot eyes, glowing soft gradients, bold saturated palette, space or nature scene',
    negative: 'photo, 3d render, texture, text, watermark', post: null,
  },
  brick: { label: 'Toy bricks', aliases: ['lego', 'lego style', 'brick', 'bricks', 'minifig'], style: 'colourful toy brick diorama, plastic bricks, studio lighting', negative: 'photo of a person, text, watermark', post: 'brick' },
  '8bit': { label: '8-bit', aliases: ['8-bit', '8 bit', 'nes', 'pixel art'], style: 'detailed pixel art scene, video game background', negative: 'photo, blurry, text', post: '8bit' },
  '2bit': { label: '2-bit', aliases: ['2-bit', '2 bit', 'game boy', 'gameboy'], style: 'monochrome pixel art scene, simple shapes', negative: 'photo, blurry, text', post: '2bit' },
  ascii: { label: 'ASCII', aliases: ['ascii', 'ascii art', 'text art'], style: 'high-contrast black and white illustration, strong silhouettes', negative: 'blurry, text', post: 'ascii' },
});
export const RECIPE_NAMES = Object.freeze(Object.keys(RECIPES));

/**
 * Anime recipes are painted with an anime checkpoint when a worker has it (Animagine XL 4.0, CreativeML Open RAIL++-M,
 * on fraymus-home since 2026-11-13). Its model card asks for quality words at the end and a fixed negative; the model
 * draws cel shading itself, so the extra ink filter is skipped (`postWithCheckpoint`). Without the file, the recipe
 * paints with SDXL base and finishes with its filter as before.
 */
export const ANIME_CHECKPOINT = 'animagine-xl-4.0-opt.safetensors';
const ANIME = { checkpoint: ANIME_CHECKPOINT, quality: 'masterpiece, high score, great score, absurdres',
  negative: 'lowres, bad anatomy, bad hands, text, error, missing finger, extra digits, fewer digits, cropped, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry', postWithCheckpoint: null };
export const CHECKPOINT_RECIPES = Object.freeze({ 'pastoral-anime': ANIME, 'classic-manga': ANIME, 'retro-robot-anime': ANIME, 'shonen-action': ANIME });

// Characters owned by a franchise: never drawn, the subject becomes an original character
const FRANCHISE_CHARACTERS = ['goku', 'vegeta', 'gohan', 'piccolo', 'frieza', 'trunks', 'krillin', 'bulma', 'astro boy', 'astroboy', 'mighty atom', 'totoro', 'chihiro', 'ponyo', 'nausicaa', 'ashitaka', 'spider-man', 'spiderman', 'miles morales', 'gwen stacy', 'spider-gwen', 'jinx', 'ekko', 'caitlyn', 'samurai jack', 'kubo', 'wirt', 'pikachu', 'mickey mouse', 'naruto', 'luffy', 'sailor moon', 'black jack', 'kimba', 'leo the lion', 'princess knight'];
// left out on purpose: names that are also ordinary words (san, vi, greg, howl, kiki, astro) would rewrite 'San Francisco' or 'a wolf's howl'

const words = s => ` ${String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ')} `;

/** The recipe a request asks for, by recipe id or by any of its aliases; null when none is named. */
export function recipeFor(text) {
  const w = words(text);
  let best = null;
  for (const [id, r] of Object.entries(RECIPES)) for (const a of [id, ...r.aliases]) {
    if (w.includes(` ${a.toLowerCase()} `) && (!best || a.length > best.alias.length)) best = { id, alias: a };
  }
  return best ? best.id : null;
}

/**
 * The subject of a request with every artist/film alias and every franchise character taken out.
 * Returns { subject, replaced: [names] } — replaced characters become "an original character".
 */
export function cleanSubject(text) {
  let s = ` ${String(text || '')} `, replaced = [];
  for (const name of FRANCHISE_CHARACTERS.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^\\p{L}])${name.replace(/[-]/g, '[- ]?')}(?=[^\\p{L}]|$)`, 'giu');
    if (re.test(s)) { replaced.push(name); s = s.replace(re, '$1an original character'); }
  }
  const aliases = Object.values(RECIPES).flatMap(r => r.aliases).sort((a, b) => b.length - a.length);
  for (const a of aliases) s = s.replace(new RegExp(`(^|[^\\p{L}])${a.replace(/[-]/g, '[- ]?')}(?:'s)?(?:\\s+(?:style|inspired|look|art|animation))?(?=[^\\p{L}]|$)`, 'giu'), '$1');
  s = s.replace(/\b(in the style of|style of|in the style|like|inspired by)\s*(,|$)/gi, '$2').replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim().replace(/^[,.\s]+|[,.\s]+$/g, '');
  // a style phrase taken off the end can leave its preposition behind ("powering up in")
  s = s.replace(/\s+(in|with|as|of|like|on|at|by|a|the)$/i, '').trim();
  return { subject: s || 'a scene', replaced: [...new Set(replaced)] };
}

/** The image-model prompt for a subject in a recipe: subject first, then the look's traits. */
export function recipePrompt(recipeId, subject) {
  const r = RECIPES[recipeId];
  if (!r) throw new Error(`unknown recipe: ${recipeId}`);
  const alt = CHECKPOINT_RECIPES[recipeId];
  return { prompt: `${subject}, ${r.style}`, negative: r.negative, post: r.post,
    ...(alt ? { checkpoint: alt.checkpoint, checkpointPrompt: `${subject}, ${r.style}, ${alt.quality}`, checkpointNegative: `${r.negative}, ${alt.negative}`, postWithCheckpoint: alt.postWithCheckpoint } : {}) };
}
