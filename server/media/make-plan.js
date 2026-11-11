/**
 * Creation plan — read a typed request and decide what to make, without asking the user to pick a category.
 *
 *   "a 90 second 8-bit short about a robot who finds a lighthouse"
 *     → { kind: 'video', style: '8bit', seconds: 90, format: '16:9', … } and, for every field, why.
 *
 * Everything here is deterministic and pure (no database, no model, no clock) so it can be tested and so
 * the same sentence always gets the same plan. Only two things are left to a model, both in make.js:
 * deciding still-or-video when the sentence gives no cue, and writing the script. This file builds the
 * prompt for the script, checks what comes back, and renders it in fraymus-video-studio's script format.
 *
 * First slice: the 8-bit and 2-bit looks. Other styles are recognised and refused by name rather than
 * silently turned into pixel art.
 */

import { castName } from './sprite-forge.js';

export const WIRED_STYLES = ['8bit', '2bit', 'cartoon', 'comic', 'explainer'];
export const PIXEL_STYLES = ['8bit', '2bit'];
/** Look → the studio recipe that renders it. */
export const RECIPES = Object.freeze({ '8bit': '8bit', '2bit': '2bit', cartoon: 'cartoon', comic: 'comic-strip', explainer: 'explainer' });
/** The cast used when a script does not name its own: the studio's two built-in figures. */
export const DEFAULT_CAST = Object.freeze([Object.freeze({ name: 'hero', look: 'a kid' }), Object.freeze({ name: 'robot', look: 'a robot' })]);
export const CAST = ['hero', 'robot'];           // the two sprites the pixel recipes can draw
export const MIN_SECONDS = 8, MAX_SECONDS = 180, DEFAULT_SECONDS = 30;
const TITLE_SECONDS = 2.5, OUTRO_SECONDS = 1.0, SCENE_PAD = 0.8, WORDS_PER_SECOND = 2.6;
const MAX_WORDS_PER_LINE = 34;
export const MAX_PLACES = 3;                      // distinct backdrops per film: each one is an image render

const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5 };
const STYLE_2BIT = /\b2[\s-]?bit\b|\btwo[\s-]bit\b|game\s?boy|\bdmg\b|four[\s-]shades?\b/i;
const STYLE_8BIT = /\b8[\s-]?bit\b|\beight[\s-]bit\b|\bnes\b|nintendo|pixel[\s-]?art|\bpixel(?:ated|s)?\b|retro[\s-]game|chiptune|arcade/i;
const STYLE_COMIC = /\bcomics?\b|\bgraphic novel\b/i;
const STYLE_CARTOON = /\bcartoon\b/i;
const STYLE_EXPLAINER = /\bexplainer\b|\bexplain(?:s|ing|ed)?\b|\bnarrated\b|\bdocumentary\b|\bvideo essay\b/i;
const PAGES_ONLY = /\bpages? only\b|\bjust the pages?\b|\bno video\b|\bwithout (?:a )?video\b/i;
const OTHER_STYLES = [
  ['music video', /\bmusic[\s-]video\b|\blyric[\s-]video\b/i],
  ['song', /\bsong\b/i], ['talking avatar', /\bavatar\b|\btalking[\s-]head\b/i], ['photoreal', /\bphoto[\s-]?real\w*\b|\blive[\s-]action\b/i],
  ['3D', /\b3[\s-]?d\b/i], ['anime', /\banime\b/i],
];
const STILL_RE = /\b(still|image|picture|pic|poster|wallpaper|sprite|icon|thumbnail|drawing|illustration|photo|logo|portrait of|painting)\b/i;
const VIDEO_RE = /\b(video|short|movie|film|animation|animated|animate|clip|episode|trailer|dialogue|dialog|skit|story|scene|cartoon)\b/i;

const clip = (s, n) => String(s ?? '').slice(0, n);
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);

function parseSeconds(text) {
  let m = /(\d+(?:\.\d+)?)\s*-?\s*(?:seconds?|secs?)\b/i.exec(text) || /\b(\d+(?:\.\d+)?)\s*s\b/.exec(text);
  if (m) return Number(m[1]);
  m = /\b(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|half)\s*(?:an?\s+)?-?\s*(?:minutes?|mins?)\b/i.exec(text);
  if (m) return (NUMBER_WORDS[m[1].toLowerCase()] ?? Number(m[1])) * 60;
  return null;
}

/** What the sentence itself says. Fields it does not mention are null. */
export function parseRequest(text) {
  const t = String(text || '');
  // A pixel look named outright wins ("an 8-bit cartoon" is 8-bit); then the looks that are a form of their own
  const style = STYLE_2BIT.test(t) ? '2bit' : STYLE_8BIT.test(t) ? '8bit' : STYLE_COMIC.test(t) ? 'comic' : STYLE_CARTOON.test(t) ? 'cartoon' : STYLE_EXPLAINER.test(t) ? 'explainer' : null;
  const other = style ? null : (OTHER_STYLES.find(([, re]) => re.test(t)) || [null])[0];
  // "cartoon" names the look here, so it is not by itself a sign that a film was asked for ("a cartoon still of …")
  const still = STILL_RE.test(t), video = VIDEO_RE.test(style === 'cartoon' ? t.replace(/\bcartoon\b/gi, ' ') : t);
  const seconds = parseSeconds(t);
  let kind = video || seconds != null ? 'video' : still ? 'still' : null;
  // A comic always has pages; the film of it comes too unless the sentence asks for pages alone. A cartoon or an explainer is a film.
  if (style === 'comic') kind = PAGES_ONLY.test(t) || (still && !video && seconds == null) ? 'still' : 'video';
  else if ((style === 'cartoon' || style === 'explainer') && kind == null) kind = 'video';
  const format = /\bvertical\b|\b9\s*[:x]\s*16\b|\btiktok\b|\breels?\b|youtube shorts|\bfor (?:my |a )?phone\b|portrait (?:mode|orientation)/i.test(t) ? '9:16'
    : /\bsquare\b|\b1\s*[:x]\s*1\b/i.test(t) ? '1:1' : null;
  const palette = style === '2bit' ? (/\bpocket\b/i.test(t) ? 'gb-pocket' : /black[\s-]and[\s-]white|gr[ae]yscale|\bmono(?:chrome)?\b/i.test(t) ? 'gb-mono' : null) : null;
  const silent = /\b(silent|no (?:voice|narration|dialogue|talking)|without (?:voice|narration))\b/i.test(t);
  return { kind, style, otherStyle: other, seconds, format, palette, silent };
}

/**
 * Merge the sentence, explicit options and defaults into one plan. `decided` says where each value came
 * from, so the reply can read "8-bit (you said so), 30 seconds (default)" and one word can correct it.
 */
export function planCreation(text, overrides = {}) {
  const request = clip(String(text || '').replace(/\s+/g, ' ').trim(), 1500);
  const p = parseRequest(request);
  const decided = {};
  const pick = (field, explicit, parsed, fallback, fallbackWhy) => {
    if (explicit != null && explicit !== '') { decided[field] = { value: explicit, why: 'set explicitly' }; return explicit; }
    if (parsed != null) { decided[field] = { value: parsed, why: 'from your words' }; return parsed; }
    decided[field] = { value: fallback, why: fallbackWhy }; return fallback;
  };
  const notes = [];
  let blocked = null;

  const styleOverride = overrides.style != null && overrides.style !== '' ? String(overrides.style).toLowerCase().replace(/[\s-]/g, '').replace(/^comic.*$/, 'comic') : null;
  if (styleOverride && !WIRED_STYLES.includes(styleOverride)) blocked = { reason: 'style_not_wired', style: overrides.style };
  else if (!styleOverride && !p.style && p.otherStyle) blocked = { reason: 'style_not_wired', style: p.otherStyle };
  const style = pick('style', blocked ? null : styleOverride, p.style, '8bit', 'default look');

  const kindOverride = ['still', 'video'].includes(overrides.kind) ? overrides.kind : null;
  // an explicit look can change what the sentence alone implied: re-read the kind for looks that are always a film
  const impliedKind = p.kind ?? (style === 'cartoon' || style === 'explainer' || style === 'comic' ? 'video' : null);
  const kind = pick('kind', kindOverride, impliedKind, null, 'not stated — decided when the job starts');
  if (!blocked && kind === 'still' && (style === 'cartoon' || style === 'explainer')) blocked = { reason: 'still_not_wired', style };

  let seconds = null;
  if (kind !== 'still') {
    const asked = Number(overrides.seconds) > 0 ? Number(overrides.seconds) : null;
    seconds = pick('seconds', asked, p.seconds, DEFAULT_SECONDS, 'default length');
    const clamped = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(seconds)));
    if (clamped !== seconds) { notes.push(`Length set to ${clamped} s (this slice makes ${MIN_SECONDS}–${MAX_SECONDS} s).`); decided.seconds = { value: clamped, why: `${decided.seconds.why}, clamped` }; }
    seconds = clamped;
  }
  const formatOverride = ['16:9', '9:16', '1:1'].includes(overrides.format) ? overrides.format : null;
  const format = pick('format', formatOverride, p.format, '16:9', 'default shape');
  let palette = null;
  if (PIXEL_STYLES.includes(style)) {
    const paletteOverride = typeof overrides.palette === 'string' && overrides.palette ? overrides.palette : null;
    palette = pick('palette', paletteOverride, p.palette, style === '2bit' ? 'gb' : 'nes', `the ${style} palette`);
  }
  const voice = overrides.voice === 'silent' || (overrides.voice == null && p.silent) ? 'silent' : 'spoken';
  const backdrops = overrides.backdrops === false || overrides.backdrops === 'false' ? false : !/\bno (?:backdrops?|backgrounds?|scenery)\b|\bplain background\b/i.test(request);

  return { request, kind, style, seconds, format, palette, voice, backdrops, cast: [...CAST], decided, notes, blocked, wired: [...WIRED_STYLES] };
}

/**
 * Fix the kind once it is known and apply what follows from it. Returns a new plan.
 * A video is always 16:9 in this slice: the studio's pixel recipes scale each axis separately, so a
 * vertical or square frame would stretch the picture. Stills are made here and keep any shape.
 */
export function settleKind(plan, kind, why = 'decided from the request') {
  const next = { ...plan, decided: { ...plan.decided }, notes: [...plan.notes] };
  if (!next.kind) { next.kind = kind === 'still' ? 'still' : 'video'; next.decided.kind = { value: next.kind, why }; }
  if (next.kind === 'video') {
    if (!next.seconds) { next.seconds = DEFAULT_SECONDS; next.decided.seconds = { value: DEFAULT_SECONDS, why: 'default length' }; }
    if (next.format !== '16:9') {
      next.notes.push(`Made in 16:9: ${next.format} film is not wired yet (the pixel recipes stretch in it; the others are untested).`);
      next.format = '16:9'; next.decided.format = { value: '16:9', why: 'only shape wired for film' };
    }
  } else { next.seconds = null; delete next.decided.seconds; }
  return next;
}

/** One line a person can read back: what will be made and why each choice. */
export function describePlan(plan) {
  if (plan.blocked?.reason === 'still_not_wired') return `A ${plan.blocked.style} is a film here; a still in that look is not wired. Ask for it as a video, or ask for an 8-bit, 2-bit or comic still.`;
  if (plan.blocked) return `"${plan.blocked.style}" is not wired yet. Wired looks: ${plan.wired.join(', ')}. Say one of those and it will be made in that look.`;
  const d = plan.decided, why = k => (d[k]?.why === 'from your words' ? 'you said so' : d[k]?.why);
  const comic = plan.style === 'comic';
  const kind = plan.kind ? `${plan.kind === 'still' ? (comic ? 'comic pages' : 'a still') : comic ? 'comic pages and a film of them' : 'a video'} (${why('kind')})` : 'still or video — to be decided from the request';
  const parts = [kind, `${plan.style} (${why('style')})`];
  if (plan.seconds) parts.push(`${plan.seconds} s (${why('seconds')})`);
  parts.push(`${plan.format} (${why('format')})`);
  if (plan.kind !== 'still' || comic) {
    const pictures = { cartoon: 'built-in sets', comic: 'painted narration panels', explainer: 'painted pictures behind the words' }[plan.style] || 'painted backdrops';
    parts.push(plan.voice === 'silent' ? 'no voice' : plan.style === 'explainer' ? 'one voice' : 'two voices', plan.backdrops === false || plan.style === 'cartoon' ? (plan.style === 'cartoon' ? pictures : 'no painted pictures') : pictures);
  }
  return parts.join(', ') + (plan.notes.length ? '. ' + plan.notes.join(' ') : '');
}

/** How much dialogue fits: scenes and words for the requested length. */
export function scriptBudget(seconds) {
  const speech = Math.max(4, seconds - TITLE_SECONDS - OUTRO_SECONDS);
  const scenes = Math.min(20, Math.max(2, Math.round(speech / 6)));
  const total = Math.max(12, Math.round((speech - scenes * SCENE_PAD) * WORDS_PER_SECOND));
  return { scenes, words: total, minScenes: Math.max(2, scenes - 2), maxScenes: Math.min(24, scenes + 2) };
}

export function estimateSeconds(scenes) {
  return +(TITLE_SECONDS + OUTRO_SECONDS + scenes.reduce((s, sc) => s + words(sc.say).length / WORDS_PER_SECOND + SCENE_PAD, 0)).toFixed(1);
}

/** Chat messages asking a local model for the script. `feedback` carries the reason a previous attempt was refused. */
export function scriptMessages(plan, feedback = null) {
  const b = scriptBudget(plan.seconds);
  const system = [
    'You write scripts for very short retro pixel-art films.',
    'Exactly two characters appear on screen and talk to each other. You choose who they are from the request. There is no narrator and no other speaker.',
    'Reply with JSON only, in this shape: {"title": "…", "cast": [{"name": "…", "look": "…"}, {"name": "…", "look": "…"}], "scenes": [{"speaker": "…", "place": "…", "say": "…"}]}',
    'Rules:',
    '- "cast" has exactly two entries. "name" is one short lowercase word. "look" says in 4 to 12 words what kind of being it is (person, robot, cat, dog, bird, ghost, alien, astronaut) and its colours, hair or clothing.',
    '- Every "speaker" is exactly one of the two cast names. Both characters must speak.',
    `- ${b.minScenes} to ${b.maxScenes} scenes, about ${b.words} words of dialogue in total.`,
    `- Each "say" is one or two short plain sentences, at most 28 words, and is exactly what the character says out loud.`,
    '- No stage directions, no brackets, no emoji, no quotation marks inside a line. Plain ASCII punctuation only.',
    '- "title" is at most 22 characters.',
    `- "place" is where the scene happens, as a picture: 5 to 12 words naming the location, its main object and the time of day or weather (no people, no dialogue). Invent it from this story; do not reuse wording from these rules. Use at most ${MAX_PLACES} different places in the whole film and repeat the exact same words while the place does not change.`,
    '- Tell a complete small story: a beginning, a turn, and an ending. The last line must land the ending: it is a statement, never a question.',
    '- Stay on what was asked for. Do not mention pixels, video games or the fact that this is a film unless asked.',
  ].join('\n');
  const user = `Request: ${plan.request}` + (feedback ? `\n\nYour previous script was refused: ${feedback} Write it again and fix that.` : '');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const toAscii = s => String(s ?? '')
  .replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...')
  .normalize('NFKD').replace(/[^\x20-\x7E]/g, '');

function cleanLine(raw, names = []) {
  let s = toAscii(raw).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ');        // stage directions
  const prefix = new RegExp(`^\\s*(?:${['hero', 'robot', 'narrator', ...names].map(n => n.replace(/[^a-z0-9]/gi, '')).filter(Boolean).join('|')})\\s*:\\s*`, 'i');
  s = s.replace(prefix, '').replace(/["#>_`|\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const w = words(s);
  if (w.length > MAX_WORDS_PER_LINE) {
    const cut = w.slice(0, MAX_WORDS_PER_LINE).join(' ');
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > cut.length * 0.5 ? cut.slice(0, end + 1) : cut.replace(/[,;:\s-]+$/, '') + '.';
  }
  if (words(s).length >= 2) {
    // a spoken line reads as a sentence: capital first letter, capital "I", closing punctuation
    s = s[0].toUpperCase() + s.slice(1);
    s = s.replace(/\bi\b(?=[ ',.!?]|$)/g, 'I');
    s = s.replace(/(?<![.]{2})([.!?]\s+)([a-z])/g, (_, gap, ch) => gap + ch.toUpperCase());   // not after an ellipsis
    if (!/[.!?]$/.test(s)) s = s.replace(/[,;:\s-]+$/, '') + '.';
  }
  return s;
}

/** A place description: plain words only, at most sixteen. */
function cleanPlace(raw) {
  if (typeof raw !== 'string') return '';
  const s = toAscii(raw).replace(/[^A-Za-z0-9 ,'-]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[,' -]+|[,' -]+$/g, '');
  const w = words(s);
  return w.length < 2 ? '' : w.slice(0, 16).join(' ');
}

function cleanTitle(raw, fallbackFrom) {
  let t = toAscii(raw).replace(/["#>_`|\\:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) t = words(toAscii(fallbackFrom).replace(/[^A-Za-z0-9 ]/g, ' ')).filter(w => w.length > 2 && !/^(the|and|for|about|with|make|create|short|video|bit|second|seconds|minute|pixel|animation)$/i.test(w) && !/^\d+$/.test(w)).slice(0, 3).join(' ');
  if (!t) t = 'Untitled';
  if (t.length > 24) { const cut = t.slice(0, 24); t = cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut; }
  return t;
}

/** Pull the first JSON object out of a model reply. */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

/**
 * Check and tidy a script (from the model, or supplied by the caller).
 * @returns {{ ok, reason?, title, scenes: [{speaker, say}], words, estSeconds, fixes: string[] }}
 * `final: true` accepts a script that is off-length by trimming or keeping it, and says so in `fixes`.
 */
export function normalizeScript(raw, plan, { final = false, narration = false } = {}) {
  // narration: true (comic) lets a scene have no speaker — a caption panel read by the narrator
  const obj = extractJson(raw);
  const list = obj && (Array.isArray(obj.scenes) ? obj.scenes : Array.isArray(obj.panels) ? obj.panels : Array.isArray(obj.lines) ? obj.lines : Array.isArray(obj.dialogue) ? obj.dialogue : null);
  if (!list) return { ok: false, reason: 'The reply was not JSON with a "scenes" list.', scenes: [], fixes: [] };
  const b = scriptBudget(plan.seconds ?? DEFAULT_SECONDS);
  const fixes = [];
  let scenes = [];
  const places = [], placeIndex = new Map();
  let lastPlace = null;
  const cast = readCast(obj.cast, fixes);
  const names = cast.map(c => c.name);
  for (const item of list) {
    const say = cleanLine(typeof item === 'string' ? item : item?.say ?? item?.line ?? item?.text ?? '', names);
    if (words(say).length < 2) continue;
    const said = String((typeof item === 'object' && item?.speaker) || '').toLowerCase().trim();
    let speaker = names.includes(said) ? said : names.find(n => castName(said, '') === n) || null;
    const narrated = narration && (!said || /^(narrator|narration|caption|none|null)$/.test(said));
    if (!speaker && !narrated) {
      const prev = scenes[scenes.length - 1]?.speaker;
      // a loose match on the name or the look ("the bot" → the robot), otherwise the two simply take turns
      const loose = said && cast.filter(c => said.includes(c.name) || c.name.includes(said) || (/robot|bot|machine|android/.test(said) && /robot|android|machine/.test(`${c.name} ${c.look}`)));
      speaker = loose && loose.length === 1 ? loose[0].name : prev === names[0] ? names[1] : names[0];
      fixes.push(`scene ${scenes.length + 1}: speaker set to ${speaker}`);
    }
    const look = cleanPlace(typeof item === 'object' ? item?.place ?? item?.setting ?? item?.location : '');
    if (look) {
      const k = normalizeLine(look);
      if (placeIndex.has(k)) lastPlace = placeIndex.get(k);
      else if (places.length < MAX_PLACES) { placeIndex.set(k, places.length); lastPlace = places.length; places.push(look); }
      else if (!fixes.includes(`more than ${MAX_PLACES} places: later scenes reuse the last one`)) fixes.push(`more than ${MAX_PLACES} places: later scenes reuse the last one`);
    }
    // fields only some looks draw: a face, a sky, a sound-effect word
    const extra = {};
    if (item && typeof item === 'object') {
      const mood = String(item.mood || '').toLowerCase(); if (['happy', 'surprised', 'sad'].includes(mood)) extra.mood = mood;
      const set = String(item.set || item.time || '').toLowerCase(); if (['day', 'sunset', 'night'].includes(set)) extra.set = set;
      const sfx = toAscii(item.sfx || '').replace(/[^A-Za-z!? ]/g, '').trim().toUpperCase(); if (sfx && sfx.length <= 12) extra.sfx = sfx;
    }
    scenes.push({ speaker, say, place: lastPlace, ...extra });
  }
  const firstPlace = scenes.find(s => s.place != null)?.place ?? null;
  for (const s of scenes) if (s.place == null) s.place = firstPlace;      // lines before the first named place happen there too
  if (scenes.length < 2) return { ok: false, reason: 'Fewer than two usable lines of dialogue.', scenes, places, fixes };
  if (scenes.length > b.maxScenes + 4) {
    if (!final) return { ok: false, reason: `${scenes.length} scenes is too many; use at most ${b.maxScenes}.`, scenes, fixes };
    scenes = [...scenes.slice(0, b.maxScenes - 1), scenes[scenes.length - 1]]; fixes.push(`trimmed to ${scenes.length} scenes, ending kept`);
  }
  let total = scenes.reduce((n, s) => n + words(s.say).length, 0);
  if (total > b.words * 1.4) {
    if (!final) return { ok: false, reason: `${total} words is too long; aim for about ${b.words}.`, scenes, fixes };
    while (scenes.length > 3 && total > b.words * 1.4) { const gone = scenes.splice(scenes.length - 2, 1)[0]; total -= words(gone.say).length; }
    fixes.push(`cut lines before the ending to fit (${total} words)`);
  }
  // say it as a shape the writer can copy: a bare word count was ignored twice in a row by the 14B model
  if (total < b.words * 0.6 && !final) return { ok: false, reason: `${total} words is too short; write about ${b.words} words of dialogue: ${b.scenes + 1} lines of roughly ${Math.round(b.words / (b.scenes + 1))} words each.`, scenes, fixes };
  if (total < b.words * 0.6) fixes.push(`shorter than asked (${total} of about ${b.words} words)`);
  const oneVoice = names.some(n => !scenes.some(s => s.speaker === n));
  if (oneVoice && !final) return { ok: false, reason: `Only one character speaks; both ${names[0]} and ${names[1]} must have lines.`, scenes, fixes };
  if (oneVoice) fixes.push('only one character speaks');
  const last = scenes[scenes.length - 1].say;
  if (/\?\s*$/.test(last)) {
    if (!final) return { ok: false, reason: 'The last line is a question. End with a statement that finishes the story.', scenes, fixes };
    fixes.push('the last line is a question; the story may feel unfinished');
  }
  const title = cleanTitle(obj.title, plan.request);
  return { ok: true, title, cast, scenes, places, words: total, estSeconds: estimateSeconds(scenes), fixes };
}

/** Two characters with a name and a look, from the script; the built-in pair when the script does not give two. */
function readCast(raw, fixes) {
  const out = [];
  for (const c of Array.isArray(raw) ? raw : []) {
    if (out.length === 2) { fixes.push('more than two characters: only the first two appear'); break; }
    const src = typeof c === 'string' ? { name: c, look: c } : c && typeof c === 'object' ? c : null;
    if (!src) continue;
    const look = words(toAscii(src.look ?? src.description ?? src.name ?? '').replace(/[^A-Za-z0-9 ,'-]/g, ' ')).slice(0, 20).join(' ');
    let name = castName(src.name || look, '');
    if (!name) continue;
    if (out.some(o => o.name === name)) name = `${name.slice(0, 10)}2`;
    out.push({ name, look: look || name });
  }
  if (out.length === 2) return out;
  if (Array.isArray(raw) && raw.length) fixes.push('the cast was not two usable characters: the built-in kid and robot are used');
  return DEFAULT_CAST.map(c => ({ ...c }));
}

/** "LIGHTHOUSE KEEPER" → "LIGHTHOUSE | KEEPER": title cards hold about twelve big characters a line. */
export function headline(title) {
  const t = String(title).toUpperCase();
  if (t.length <= 12 || !t.includes(' ')) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = 0; i < t.length; i++) if (t[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  return `${t.slice(0, best)} | ${t.slice(best + 1)}`;
}

/** The script in fraymus-video-studio's markdown format (front matter + one "## scene" block per line of dialogue). */
export function buildStudioMarkdown(plan, script, backdrops = []) {
  // backdrops[i] is the picture file for script.places[i] (or for the whole film when the script named no place); null = use the built-in landscape
  const visual = place => { const f = backdrops[place ?? 0]; return f ? [`visual: ${String(f).replace(/\\/g, '/')}`] : []; };
  const front = ['---', `title: ${script.title}`, `recipe: ${plan.style}`, `cast: ${(script.cast?.length ? script.cast.map(c => c.name) : CAST).join(', ')}`, `palette: ${plan.palette}`, `format: ${plan.format}`, '---'];
  const body = ['## title', `# ${headline(script.title)}`, 'sub: PRESS START', `dur: ${TITLE_SECONDS}`, ...visual(script.scenes[0]?.place), ''];
  script.scenes.forEach((sc, i) => body.push(`## line${String(i + 1).padStart(2, '0')}`, `speaker: ${sc.speaker}`, ...visual(sc.place), `say: ${sc.say}`, ''));
  return front.concat(body).join('\n');
}

export const normalizeLine = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Spoken text → who says it, so the voice endpoint can give each character its own voice. */
export function speakerLines(script) {
  const map = new Map();
  for (const sc of script.scenes) map.set(normalizeLine(sc.say), sc.speaker);
  return map;
}

/** The request with the words that are instructions to us, not part of the picture, taken out. */
export function subjectOf(plan) {
  return clip(plan.request
    .replace(/\b(make|create|draw|generate|render|give me|i want|i'd like|please|me)\b/gi, ' ')
    .replace(/\b(an?|the)?\s*\d+(?:\.\d+)?\s*-?\s*(seconds?|secs?|minutes?|mins?)\b/gi, ' ')
    .replace(/\b(8|2|eight|two)[\s-]?bit\b|\bpixel[\s-]?art\b|\bgame\s?boy\b|\bnes\b/gi, ' ')
    .replace(/\b(short|video|movie|film|animation|animated|clip|still|image|picture)\b\s*(?:about|of|where|in which)?/gi, ' ')
    .replace(/\s+/g, ' ').replace(/^[\s,.:-]+/, '').trim(), 400) || clip(plan.request, 400);
}

/** Prompt for one backdrop: the place, empty, with open ground at the bottom where the characters stand. */
export function backdropPrompt(plan, look) {
  if (plan.style === 'explainer') return `${look}, cinematic wide photograph, dramatic natural light, rich detail, no text, no captions`;
  if (plan.style === 'comic') return `${look}, comic book illustration, bold black ink lines, flat colours, wide establishing shot, nobody in the foreground, no text, no speech bubbles`;
  const art = plan.style === '2bit' ? 'Game Boy style pixel art background, four shades, high contrast' : '8-bit NES style pixel art background, limited colour palette';
  return `${look}, wide side view, empty scene with nobody in it, flat open ground along the bottom of the picture, ${art}, flat colours, bold simple shapes, no text`;
}

/** What a backdrop must not contain, per look. */
export function backdropNegative(plan) {
  if (plan.style === 'explainer') return 'text, letters, captions, watermark, logo, blurry, deformed, low quality';
  if (plan.style === 'comic') return 'text, letters, speech bubble, watermark, photo, photograph, blurry, deformed';
  return 'people, person, character, figure, face, animal, photo, photograph, blurry, gradient, text, letters, watermark';
}

export { cleanLine, cleanPlace, cleanTitle, readCast, toAscii, words as wordsOf, TITLE_SECONDS, OUTRO_SECONDS, SCENE_PAD, WORDS_PER_SECOND };

/** Prompt for the local image model when a still has no source picture. */
export function stillPrompt(plan) {
  const subject = clip(plan.request.replace(/\b(make|create|draw|generate|give me|i want|please)\b/gi, ' ').replace(/\s+/g, ' ').trim(), 400);
  const look = plan.style === '2bit' ? 'Game Boy style pixel art, four shades, high contrast' : '8-bit NES style pixel art, limited colour palette';
  return `${subject}, ${look}, flat colours, bold simple shapes, clear silhouette, centred subject, no text`;
}
