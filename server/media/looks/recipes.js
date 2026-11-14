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
  // the toy-brick feature universe (Nexus) routes here too: a whole film world built of bricks, not one diorama
  brick: { label: 'Toy bricks', aliases: ['lego', 'lego style', 'brick', 'bricks', 'minifig', 'lego movie', 'the lego movie', 'brick movie', 'brick film'],
    style: 'colourful world built entirely of toy plastic bricks, blocky minifigure characters with painted faces and claw hands, glossy plastic sheen, tiny studs on every surface, cinematic studio lighting', negative: 'photo of a person, real skin, text, watermark', post: 'brick' },
  // ── added 2026-11-14 from Nexus Engine's catalog (gap 8): eight styles and three universes ───────────
  'pop-silkscreen': {
    label: 'Pop silkscreen', aliases: ['warhol', 'andy warhol', 'pop art', 'silkscreen', 'screen print', 'screenprint', 'pop-art'],
    style: '1960s pop-art screen print, a bold frontal portrait or everyday product, flat areas of vivid ink, high-contrast black key image, colour plates slightly off register',
    negative: 'photo, realistic shading, gradient, 3d render, text, watermark, logo', post: 'silkscreen',
  },
  'stencil-graffiti': {
    label: 'Urban stencil graffiti', aliases: ['banksy', 'stencil', 'stencil art', 'graffiti stencil', 'street art', 'spray stencil'],
    style: 'urban stencil street art, a single strong silhouette figure in a satirical pose, sprayed in black with one red detail, on a plain weathered wall, simple readable shapes',
    negative: 'photo, colourful mural, clutter, text, letters, watermark, signature', post: 'stencil',
  },
  'newspaper-strip': {
    label: 'Mid-century newspaper strip', aliases: ['peanuts', 'schulz', 'charles schulz', 'sunday funnies', 'sunday strip', 'newspaper comic', 'comic strip', '1950s comic', 'funny pages'],
    style: 'mid-century newspaper comic strip panel, simple round-headed children drawn with confident wobbly ink lines, plain flat background, a few flat printed colours',
    negative: 'photo, 3d render, shading, gradient, text, letters, speech bubbles, watermark', post: 'newsprint',
  },
  'sprite-16bit': {
    label: '16-bit platformer', aliases: ['16-bit', '16 bit', 'snes', 'super nintendo', 'sega genesis', 'mega drive', 'sprite sheet', '16-bit sprite', 'sixteen bit'],
    style: '16-bit era side-scrolling video game screen, a small heroic character sprite on a platform level, layered parallax background of hills and clouds, bright saturated colours, crisp pixel shapes',
    negative: 'photo, 3d render, blurry, text, user interface, watermark', post: '16bit',
  },
  hypercube: {
    label: 'Hypercube artifact', aliases: ['hypercube', 'tesseract', '4d', '4-d', 'four dimensional', 'four-dimensional', 'hyperdimensional', '3d 4d'],
    style: 'a luminous tesseract artifact floating in a dark void, nested translucent wireframe cubes projected from four dimensions, glowing edges, prismatic refraction, precise geometric linework, volumetric light',
    negative: 'photo of a person, text, watermark, blurry, clutter', post: null,
  },
  'night-story': {
    label: 'Nighttime story', aliases: ['nighttime story', 'bedtime story', 'sleep story', 'night story', 'storytime', 'youtube nighttime story', 'cozy night'],
    style: 'cozy nighttime storybook illustration for a calm story video, deep blue night, warm lit windows and lanterns, soft glow, gentle painterly textures, a peaceful quiet scene',
    negative: 'photo, harsh light, scary, gore, text, watermark', post: null,
  },
  'editorial-diagram': {
    label: 'Editorial diagram', aliases: ['linkedin', 'linkedin post', 'editorial diagram', 'business infographic', 'corporate illustration', 'professional diagram'],
    style: 'clean modern editorial illustration of an idea as a diagram, isometric people and objects connected by arrows and nodes, simple flat shapes with soft shadows, calm blue, teal and coral palette, generous white space',
    negative: 'photo, clutter, text, letters, numbers, watermark, logo', post: null,
  },
  'four-panel': {
    label: 'Four-panel story', aliases: ['reddit comic', 'reddit 4-panel', '4-panel', 'four-panel', 'four panel', '4 panel', '4 panel comic', 'webcomic'],
    style: 'simple webcomic panel, clean digital line art, flat colours, expressive simple characters, plain uncluttered background',
    negative: 'photo, 3d render, text, letters, speech bubbles, panel borders, watermark', post: null, panels: 4,
  },
  'yellow-sitcom': {
    label: 'Primetime yellow sitcom', aliases: ['simpsons', 'the simpsons', 'simpsons style', 'springfield', 'groening', 'matt groening'],
    style: 'primetime 2D animated sitcom still, characters with bright yellow skin, big round eyes and overbites, thick even black outlines, flat saturated colours, a suburban living room or small-town street',
    negative: 'photo, 3d render, realistic skin, shading, text, watermark, logo', post: null,
  },
  'cgi-feature': {
    label: 'Theatrical 3-D CGI', aliases: ['pixar', 'pixar style', 'dreamworks', 'disney pixar', 'toy story style', '3d animated movie', 'cgi movie', 'cgi feature', 'animated feature'],
    style: 'theatrical 3D CGI animated feature film still, appealing stylised characters with large expressive eyes, soft subsurface-scattered skin, rich global illumination, shallow depth of field, warm cinematic colour grade',
    negative: 'photo, uncanny realistic face, 2d, flat, text, watermark, logo', post: null,
  },
  'midcentury-super': {
    label: 'Mid-century super-family', aliases: ['incredibles', 'the incredibles', 'incredibles style', 'super family', 'mid-century superhero', 'retro superhero'],
    style: 'mid-century modern superhero family adventure, 1960s retro-futurist architecture, sleek red supersuits with simple emblems, stylised characters with exaggerated proportions, spy-thriller lighting in warm orange and teal',
    negative: 'photo, realistic, gritty, text, watermark, logo', post: null,
  },
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
const SMALL_SUBJECT = 'tiny figures, distant figures, figures far away, extreme wide shot, empty landscape';
export const CHECKPOINT_RECIPES = Object.freeze({ 'pastoral-anime': ANIME, 'classic-manga': ANIME, 'retro-robot-anime': ANIME, 'shonen-action': ANIME });

// Characters owned by a franchise: never drawn, the subject becomes an original character
const FRANCHISE_CHARACTERS = ['goku', 'vegeta', 'gohan', 'piccolo', 'frieza', 'trunks', 'krillin', 'bulma', 'astro boy', 'astroboy', 'mighty atom', 'totoro', 'chihiro', 'ponyo', 'nausicaa', 'ashitaka', 'spider-man', 'spiderman', 'miles morales', 'gwen stacy', 'spider-gwen', 'jinx', 'ekko', 'caitlyn', 'samurai jack', 'kubo', 'wirt', 'pikachu', 'mickey mouse', 'naruto', 'luffy', 'sailor moon', 'black jack', 'kimba', 'leo the lion', 'princess knight',
  // added with the new universes (2026-11-14)
  'homer simpson', 'bart simpson', 'marge simpson', 'lisa simpson', 'maggie simpson', 'mr burns', 'ned flanders', 'krusty the clown',
  'buzz lightyear', 'lightning mcqueen', 'shrek', 'wall-e', 'nemo', 'mr incredible', 'mr. incredible', 'elastigirl', 'frozone', 'edna mode', 'jack-jack',
  'emmet', 'wyldstyle', 'lord business', 'unikitty', 'charlie brown', 'snoopy', 'linus van pelt', 'lucy van pelt'];
// left out on purpose: names that are also ordinary words (san, vi, greg, howl, kiki, astro, woody, dory, dash, violet,
// lucy, donkey, bart, marge, homer) would rewrite 'San Francisco', 'a wolf's howl' or 'a woody hillside'

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
  // a style name taken from between an article and a preposition leaves both behind: "a Banksy stencil of a child" →
  // "a of a child", "a reddit comic about a cat" → "a about a cat" (seen live). Drop the article, then the preposition.
  s = s.replace(/\b(a|an|the)\s+(?=(of|about|with|for|on|in|at|where|showing)\b)/gi, '').replace(/^(of|about|with|for|on|in|at|where|showing)\s+/i, '').trim();
  // a style phrase taken off the end can leave its preposition behind ("powering up in")
  s = s.replace(/\s+(in|with|as|of|like|on|at|by|a|the)$/i, '').trim();
  return { subject: s || 'a scene', replaced: [...new Set(replaced)] };
}

/**
 * Animagine is trained on Danbooru-style tags and follows English sentences loosely: "a girl and her cat on a hill" in a
 * sentence lost the cat and drew the girl small (2026-11-13, same seed). So a local model rewrites the subject as tags,
 * and code checks them. These two are pure; the call is in looks/index.js.
 */
export const FRAMING_TAGS = Object.freeze(['close-up', 'portrait', 'upper body', 'cowboy shot', 'full body']);
export function animeTagsMessages(subject) {
  return [
    { role: 'system', content: 'You turn a picture description into Danbooru-style tags for an anime image model. Reply with JSON only: {"subjects": [..], "tags": [..], "framing": "..."}.\n'
      + 'Rules: "subjects" has one tag for each person, animal or machine the description names, in order (1girl, 1boy, cat, robot dog…), plus one tag saying how they are together if there are two or more (girl holding cat, boy walking with robot dog…). '
      + '"tags" has what they do, wear and hold, then the setting and time of day — only what the description says: invent no clothes, colours, poses or objects. No generic tags (female, male, animal, nature, outdoor, people). '
      + 'Lowercase, a few words per tag, at most 16 tags. No artist, studio, franchise or character names; no quality words. '
      + `"framing" is one of: ${FRAMING_TAGS.join(', ')} — choose the closest framing in which everything named is still visible, so the characters are large in the picture.` },
    { role: 'user', content: subject },
  ];
}
/** The model's reply → { tags, framing } or null. Tags must be short, plain and free of the names cleanSubject removes. */
const GENERIC_TAGS = new Set(['female', 'male', 'animal', 'animals', 'nature', 'outdoor', 'outdoors', 'people', 'person', 'scenery', 'pet']);
export function checkTags(raw) {
  let j; try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!j || !Array.isArray(j.tags)) return null;
  const clean = list => [...new Set((Array.isArray(list) ? list : []).map(t => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t && t.length <= 40 && t.split(' ').length <= 6 && !GENERIC_TAGS.has(t)))]
    .filter(t => cleanSubject(t).replaced.length === 0 && recipeFor(t) === null);
  const subjects = clean(j.subjects).slice(0, 5), tags = clean(j.tags).filter(t => !subjects.includes(t)).slice(0, 16);
  if (subjects.length + tags.length < 2) return null;
  const framing = FRAMING_TAGS.includes(String(j.framing || '').toLowerCase()) ? String(j.framing).toLowerCase() : 'cowboy shot';
  return { subjects, tags, framing };
}

/** The image-model prompt for a subject in a recipe: subject first, then the look's traits. */
export function recipePrompt(recipeId, subject) {
  const r = RECIPES[recipeId];
  if (!r) throw new Error(`unknown recipe: ${recipeId}`);
  const alt = CHECKPOINT_RECIPES[recipeId];
  // Animagine shrinks a subject written as a sentence into a scene-rich style (measured 2026-11-13), so its prompt is
  // tags first (from animeTagsMessages, or the subject when no tags came back), then the framing, then the style.
  return { prompt: `${subject}, ${r.style}`, negative: r.negative, post: r.post,
    ...(alt ? { checkpoint: alt.checkpoint, checkpointPrompt: `${subject}, ${r.style}, ${alt.quality}`,
      checkpointNegative: `${r.negative}, ${alt.negative}, ${SMALL_SUBJECT}`, postWithCheckpoint: alt.postWithCheckpoint } : {}) };
}
/**
 * A four-panel story (the "Reddit 4-panel" format): a model writes the beats, code checks them, each beat is painted
 * as its own panel and the panels are laid out 2 × 2 with captions. Setup, development, turn, punchline.
 */
export function panelMessages(subject, n = 4, feedback = null) {
  return [
    { role: 'system', content: `You write ${n}-panel comic stories. Reply with JSON only: {"cast": "...", "panels": [{"scene": "...", "caption": "..."}]}. Exactly ${n} panels: setup, development, a turn, a punchline that pays off the setup. `
      + '"cast" describes how the main character (or two) look, 5 to 30 words, with colours and one or two details ("a plump grey cat with white paws and a pink nose"): it is put in front of every panel so the character looks the same in all of them. '
      + '"scene" is what happens in that panel and where, 6 to 30 words, using the same names for the characters ("the cat"). "caption" is one short line of 2 to 14 words that the reader reads under the panel. Plain ASCII, no speaker names, no stage directions, no franchise or real people\'s names.' },
    { role: 'user', content: `Story: ${subject}` + (feedback ? `\n\nYour previous panels were refused: ${feedback} Write them again and fix that.` : '') },
  ];
}
/** The model's reply → { ok, panels: [{scene, caption}], reason }. */
export function checkPanels(raw, n = 4) {
  let j = raw; if (typeof raw === 'string') { try { const a = raw.indexOf('{'), z = raw.lastIndexOf('}'); j = JSON.parse(raw.slice(a, z + 1)); } catch { return { ok: false, reason: 'The reply was not JSON with a "panels" list.' }; } }
  const ascii = s => String(s ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
  const list = (Array.isArray(j?.panels) ? j.panels : []).map(p => ({ scene: ascii(p?.scene), caption: ascii(p?.caption).replace(/^["']|["']$/g, '') }));
  if (list.length !== n) return { ok: false, reason: `${list.length} panels; exactly ${n} are needed.` };
  const wc = s => s.split(/\s+/).filter(Boolean).length;
  for (const [i, p] of list.entries()) {
    if (wc(p.scene) < 6) return { ok: false, reason: `Panel ${i + 1}'s scene has ${wc(p.scene)} words; say what the picture shows in 6 to 30.` };
    if (wc(p.caption) < 2 || wc(p.caption) > 14) return { ok: false, reason: `Panel ${i + 1}'s caption has ${wc(p.caption)} words; a caption is 2 to 14.` };
    if (cleanSubject(p.scene).replaced.length) return { ok: false, reason: `Panel ${i + 1} names a franchise character; describe an original one.` };
  }
  if (new Set(list.map(p => p.caption.toLowerCase())).size < n) return { ok: false, reason: 'Two captions are the same; every panel moves the story on.' };
  // the cast is painted into every panel's prompt: a shared seed alone gave four different cats (2026-11-14)
  const cast = ascii(j.cast);
  if (wc(cast) < 5 || wc(cast) > 30) return { ok: false, reason: `"cast" has ${wc(cast)} words; describe how the main character looks in 5 to 30, with colours.` };
  if (cleanSubject(cast).replaced.length) return { ok: false, reason: 'The cast names a franchise character; describe an original one.' };
  return { ok: true, cast, panels: list.map(p => ({ scene: p.scene.split(/\s+/).slice(0, 30).join(' '), caption: p.caption })) };
}

/** Extra negative for tagged anime prompts: a weighted animal next to a person leaks animal ears onto the person. */
const PERSON = /\b(\d+)?(girl|boy|girls|boys|woman|man|person|child|kid)s?\b/, BEAST = /\b(cat|dog|fox|wolf|rabbit|bunny|bear|horse|bird|kitten|puppy)\b/;
export function taggedNegative(recipeId, { subjects = [] } = {}) {
  const base = recipePrompt(recipeId, 'x').checkpointNegative;
  const both = subjects.some(s => PERSON.test(s)) && subjects.some(s => BEAST.test(s) && !PERSON.test(s));
  return both ? `${base}, animal ears, kemonomimi, animal tail on a person` : base;
}

/** The anime checkpoint's prompt from checked tags: tags, framing, the recipe's look, the model's quality words. */
export function taggedPrompt(recipeId, { subjects = [], tags, framing }) {
  const r = RECIPES[recipeId], alt = CHECKPOINT_RECIPES[recipeId];
  if (!r || !alt) throw new Error(`no anime checkpoint for recipe ${recipeId}`);
  // every named subject weighted (ComfyUI's "(text:weight)" emphasis) so the scene cannot drop one of them
  const named = subjects.map(s => `(${s}:1.3)`);
  return [...named, ...tags, framing, r.style, alt.quality].filter(Boolean).join(', ');
}
