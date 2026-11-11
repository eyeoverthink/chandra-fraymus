/**
 * Looks — what changes from one kind of film to another: who speaks, what the script must contain,
 * and how it is written down for the studio recipe that draws it.
 *
 *   8bit, 2bit   two forged sprites talk in a dialog box over painted backdrops        (make-plan.js)
 *   cartoon      two flat-cartoon people talk in speech bubbles on a day / sunset / night set
 *   comic        panels on pages: narration captions over painted, inked pictures, and the two people
 *                talking in balloons; pages (PNG + PDF) and, unless only pages were asked for, a film of them
 *   explainer    one narrator; headline words, optional bullet points, a painted picture behind each scene
 *
 * make.js asks this module three things for whatever look the plan names — the prompt for the writer,
 * the check of what the writer returned, and the script in the studio's own format — and never branches
 * on the look itself. Pure: no database, no model, no clock.
 */
import { scriptMessages, normalizeScript, buildStudioMarkdown, scriptBudget, paceOf, extractJson, headline, normalizeLine, cleanLine, cleanPlace, cleanTitle,
  wordsOf, MAX_PLACES, PIXEL_STYLES, DEFAULT_SECONDS, TITLE_SECONDS, OUTRO_SECONDS, WORDS_PER_SECOND } from './make-plan.js';
import { readLook, COLOURS } from './sprite-forge.js';

const clip = (s, n) => String(s ?? '').slice(0, n);

// ── people (cartoon and comic draw the same two flat figures; only colours vary) ──────────────────────

export const DEFAULT_PEOPLE = Object.freeze([Object.freeze({ name: 'ava', look: 'a girl in an orange shirt' }), Object.freeze({ name: 'max', look: 'a boy in a blue shirt' })]);
const SHIRTS = ['#ff7a59', '#4aa3ff', '#5fc97a', '#b07cf7', '#f7c948', '#ef5da8'];
const SKINS = { default: ['#f2c29b', '#c98d62'], pale: '#f7d9c4', light: '#f2c29b', fair: '#f2c29b', tan: '#d9a066', olive: '#c9a26b', brown: '#a8693f', dark: '#7a4a2a', black: '#5c3a21' };
const HAIRS = { default: ['#3b2416', '#1b1b1b'], black: '#1b1b1b', brown: '#5a3a1e', blonde: '#e8c45a', blond: '#e8c45a', red: '#b5432a', ginger: '#c8622a', orange: '#c8622a', grey: '#9a9a9a', gray: '#9a9a9a', white: '#e8e8e8', silver: '#bcbcbc', blue: '#3f6fd8', pink: '#e86aa6', green: '#3fa35a', purple: '#7a55c7' };
// brighter than the 8-bit palette: these figures are flat vector shapes, not sprites
const BRIGHT = { red: '#e8483f', crimson: '#b8303a', blue: '#4aa3ff', navy: '#2f4fa8', sky: '#7cc4ff', cyan: '#3fd0d0', teal: '#2aa198', green: '#5fc97a', lime: '#a8d840', olive: '#7a8a3a',
  yellow: '#f7c948', gold: '#e8b830', orange: '#ff7a59', purple: '#b07cf7', violet: '#b07cf7', magenta: '#d94fc0', pink: '#ef5da8', brown: '#a8693f', tan: '#d9a066', white: '#f4f4f4',
  silver: '#c8c8c8', grey: '#9aa0a8', gray: '#9aa0a8', black: '#3a3a44', cream: '#f2e4c4', ginger: '#c8622a', blonde: '#e8c45a', dark: '#5c3a21' };

/** Colours for the two flat-cartoon people from how the script describes them. */
export function forgePeople(cast) {
  const used = new Set();
  return (cast || []).slice(0, 2).map((c, i) => {
    const r = readLook(c.look, c.name);
    const why = [];
    const text = String(c.look || '').toLowerCase();
    const shirtWord = r.said.main || r.loose.find(w => w in BRIGHT);
    let color = shirtWord && BRIGHT[shirtWord] ? BRIGHT[shirtWord] : SHIRTS.find(s => !used.has(s));
    if (used.has(color)) color = SHIRTS.find(s => !used.has(s)) || color;
    used.add(color);
    if (shirtWord && BRIGHT[shirtWord]) why.push(`${shirtWord} clothes (said)`);
    const skinWord = r.said.skin || (Object.keys(SKINS).find(k => k !== 'default' && new RegExp(`\\b${k}[\\s-]+skin`).test(text)));
    const skin = (skinWord && SKINS[skinWord]) || SKINS.default[i % 2];
    if (skinWord && SKINS[skinWord]) why.push(`${skinWord} skin (said)`);
    const hairWord = r.said.hair;
    const hair = (hairWord && HAIRS[hairWord]) || HAIRS.default[i % 2];
    if (hairWord && HAIRS[hairWord]) why.push(`${hairWord} hair (said)`);
    return { name: c.name, look: clip(c.look, 160), color, skin, hair, why };
  });
}

/** Cartoon and comic can only draw people: a script that cast the pixel pair by default gets two people instead. */
function peopleCast(script) {
  const isPixelDefault = script.cast?.length === 2 && script.cast[0].name === 'hero' && script.cast[1].name === 'robot' && script.cast[1].look === 'a robot';
  if (!isPixelDefault) return script;
  const rename = { hero: DEFAULT_PEOPLE[0].name, robot: DEFAULT_PEOPLE[1].name };
  return { ...script, cast: DEFAULT_PEOPLE.map(c => ({ ...c })), scenes: script.scenes.map(s => ({ ...s, speaker: s.speaker ? rename[s.speaker] ?? s.speaker : s.speaker })) };
}

// ── cartoon ──────────────────────────────────────────────────────────────────────────────────────────

function cartoonMessages(plan, feedback) {
  const b = scriptBudget(plan.seconds ?? DEFAULT_SECONDS, paceOf(plan));
  const system = [
    'You write scripts for very short flat cartoons in which two people talk in speech bubbles.',
    'Reply with JSON only, in this shape: {"title": "…", "cast": [{"name": "…", "look": "…"}, {"name": "…", "look": "…"}], "scenes": [{"speaker": "…", "mood": "happy", "set": "day", "say": "…"}]}',
    'Rules:',
    '- "cast" has exactly two entries and both are people. "name" is one short lowercase word. "look" says in 4 to 10 words who the person is and the colour of their clothes and hair.',
    '- Every "speaker" is exactly one of the two cast names. Both people must speak.',
    `- ${b.minScenes} to ${b.maxScenes} scenes, about ${b.words} words of dialogue in total.`,
    '- Each "say" is one or two short plain sentences, at most 24 words, exactly what the person says out loud. It appears in a speech bubble.',
    '- "mood" is how the speaker feels in that line: happy, surprised or sad. "set" is the sky: day, sunset or night; change it only when time passes.',
    '- No stage directions, no brackets, no emoji, no quotation marks inside a line. Plain ASCII punctuation only.',
    '- "title" is at most 20 characters.',
    '- Tell a complete small story with some warmth or a joke: a beginning, a turn, and an ending. The last line must land the ending: it is a statement, never a question.',
    '- Stay on what was asked for.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `Request: ${plan.request}` + (feedback ? `\n\nYour previous script was refused: ${feedback} Write it again and fix that.` : '') }];
}

function cartoonMarkdown(plan, script) {
  const people = forgePeople(script.cast);
  const front = ['---', `title: ${script.title}`, 'recipe: cartoon', `cast: ${people.map(p => `${p.name}=${p.color}`).join(', ')}`, `format: ${plan.format}`, '---'];
  const body = ['## title', `# ${script.title.toUpperCase()}`, 'dur: 2.2', `set: ${script.scenes[0]?.set || 'day'}`, ''];
  let set = script.scenes[0]?.set || 'day';
  script.scenes.forEach((sc, i) => { set = sc.set || set; body.push(`## line${String(i + 1).padStart(2, '0')}`, `speaker: ${sc.speaker}`, `mood: ${sc.mood || 'happy'}`, `set: ${set}`, `say: ${sc.say}`, ''); });
  return front.concat(body).join('\n');
}

// ── comic ────────────────────────────────────────────────────────────────────────────────────────────

function comicBudget(plan) {
  const seconds = plan.seconds ?? DEFAULT_SECONDS;
  const panels = Math.min(12, Math.max(4, Math.round(seconds / 5)));
  return { panels, min: Math.max(4, panels - 1), max: Math.min(12, panels + 2) };
}

function comicMessages(plan, feedback) {
  const b = comicBudget(plan), words = scriptBudget(plan.seconds ?? DEFAULT_SECONDS, paceOf(plan)).words;
  const system = [
    'You write short comic strips. Each panel is either a narration panel (a caption over a picture of the place, nobody speaking) or a dialogue panel (one of two people speaks in a balloon).',
    'Reply with JSON only, in this shape: {"title": "…", "cast": [{"name": "…", "look": "…"}, {"name": "…", "look": "…"}], "panels": [{"speaker": "", "place": "…", "say": "…"}, {"speaker": "…", "mood": "happy", "set": "day", "say": "…", "sfx": ""}]}',
    'Rules:',
    '- "cast" has exactly two entries and both are people. "name" is one short lowercase word. "look" says in 4 to 10 words who the person is and the colour of their clothes and hair.',
    `- ${b.min} to ${b.max} panels, about ${words} words in total. The first panel is a narration panel that sets the scene.`,
    '- Narration panel: "speaker" is "" and "say" is the caption, one plain sentence of at most 18 words. Give it a "place": 5 to 12 words describing the picture (location, main object, time of day), with nobody speaking in it. Use at most ' + MAX_PLACES + ' different places.',
    '- Dialogue panel: "speaker" is exactly one of the two cast names and "say" is what they say, at most 18 words. "mood" is happy, surprised or sad; "set" is day, sunset or night. Both people must speak.',
    '- "sfx" is optional: one loud comic word such as CRASH! or ZAP!, in at most one or two panels, only where something actually happens.',
    '- No stage directions, no brackets, no emoji, no quotation marks inside a line. Plain ASCII punctuation only. "title" is at most 20 characters.',
    '- Tell a complete small story: a beginning, a turn, and an ending. The last panel must land the ending: it is a statement, never a question.',
    '- Stay on what was asked for.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `Request: ${plan.request}` + (feedback ? `\n\nYour previous script was refused: ${feedback} Write it again and fix that.` : '') }];
}

function comicMarkdown(plan, script, backdrops = []) {
  const people = forgePeople(script.cast);
  const front = ['---', `title: ${script.title}`, 'recipe: comic-strip', `cast: ${people.map(p => `${p.name}=${p.color}`).join(', ')}`, 'panels_per_page: 4', `format: ${plan.format}`, '---'];
  const body = [];
  let set = 'day';
  script.scenes.forEach((sc, i) => {
    set = sc.set || set;
    body.push(`## p${String(i + 1).padStart(2, '0')}`);
    if (sc.speaker) body.push(`speaker: ${sc.speaker}`, `mood: ${sc.mood || 'happy'}`);
    else { const f = backdrops[sc.place ?? 0]; if (f) body.push(`visual: ${String(f).replace(/\\/g, '/')}`); }   // only narration panels are painted: the people are drawn by the recipe
    body.push(`set: ${set}`);
    if (sc.sfx) body.push(`sfx: ${sc.sfx}`);
    body.push(`say: ${sc.say}`, '');
  });
  return front.concat(body).join('\n');
}

function normalizeComic(raw, plan, opts) {
  const s = normalizeScript(raw, plan, { ...opts, narration: true });
  if (!s.ok) return s;
  if (!s.scenes.some(x => !x.speaker) && !opts?.final) return { ...s, ok: false, reason: 'There is no narration panel. The first panel must have "speaker": "" and a "place".' };
  return s;
}

// ── explainer ────────────────────────────────────────────────────────────────────────────────────────

const EXPLAINER_WPS = 2.5;
const THEMES = [['ember', /\b(warm|fire|red|urgent|danger|warning|heat|energy|war)\b/i], ['paper', /\b(paper|light|calm|gentle|history|classic|vintage|minimal)\b/i]];

export function explainerBudget(seconds) {
  const speech = Math.max(6, (seconds ?? DEFAULT_SECONDS) - TITLE_SECONDS - OUTRO_SECONDS);
  const scenes = Math.min(10, Math.max(3, Math.round(speech / 8)));
  return { scenes, minScenes: Math.max(3, scenes - 1), maxScenes: Math.min(12, scenes + 2), words: Math.max(20, Math.round((speech - scenes * 0.8) * EXPLAINER_WPS)) };
}

function explainerMessages(plan, feedback) {
  const b = explainerBudget(plan.seconds);
  const system = [
    'You write narration scripts for short explainer videos. One narrator speaks; a few big headline words appear on screen for each scene.',
    'Reply with JSON only, in this shape: {"title": "…", "scenes": [{"headline": "…", "say": "…", "bullets": ["…", "…"], "picture": "…"}]}',
    'Rules:',
    `- ${b.minScenes} to ${b.maxScenes} scenes, about ${b.words} words of narration in total.`,
    '- "say" is what the narrator says in that scene: one to three plain sentences, at most 40 words.',
    '- "headline" is 2 to 5 words that sum the scene up. It is not a copy of the sentence.',
    '- "bullets" is optional: 2 to 4 points of at most 6 words each, only in a scene that really lists things. Otherwise leave it out.',
    `- "picture" is what to show behind the scene: 5 to 12 words describing a real, photographable image. Use at most ${MAX_PLACES} different pictures in the whole video and repeat the exact same words to keep one.`,
    '- The first scene hooks the viewer; the last scene gives the takeaway.',
    '- Be accurate. Explain the idea plainly. Do not invent statistics, dates, names or quotations; if you are not sure of a number, do not give one.',
    '- No emoji, no quotation marks inside a line, plain ASCII punctuation only. "title" is at most 28 characters.',
    '- Stay on what was asked for.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `Request: ${plan.request}` + (feedback ? `\n\nYour previous script was refused: ${feedback} Write it again and fix that.` : '') }];
}

const cleanShort = (raw, maxWords) => wordsOf(String(raw ?? '').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/["#>_`|\\@]/g, ' ').replace(/^(?:\s*[-+x*]\s+)+/i, '').replace(/\s+/g, ' ').trim()).slice(0, maxWords).join(' ');

function normalizeExplainer(raw, plan, { final = false } = {}) {
  const obj = extractJson(raw);
  const list = obj && (Array.isArray(obj.scenes) ? obj.scenes : null);
  if (!list) return { ok: false, reason: 'The reply was not JSON with a "scenes" list.', scenes: [], fixes: [] };
  const b = explainerBudget(plan.seconds), fixes = [], scenes = [], places = [], index = new Map();
  let last = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    let say = cleanLine(item.say ?? item.narration ?? item.text ?? '');
    const w = wordsOf(say);
    if (w.length < 3) continue;
    if (w.length > 45) { const cut = w.slice(0, 45).join(' '); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')); say = end > cut.length * 0.5 ? cut.slice(0, end + 1) : cut.replace(/[,;:\s-]+$/, '') + '.'; fixes.push(`scene ${scenes.length + 1}: narration cut to 45 words`); }
    let head = cleanShort(item.headline ?? item.title ?? '', 6).replace(/[.,;:]+$/, '');
    if (!head) {
      if (!final) return { ok: false, reason: `Scene ${scenes.length + 1} has no "headline".`, scenes, fixes };
      head = wordsOf(say.replace(/[^A-Za-z0-9' ]/g, ' ')).filter(x => x.length > 3).slice(0, 3).join(' ') || 'Next'; fixes.push(`scene ${scenes.length + 1}: headline taken from the narration`);
    }
    const bullets = (Array.isArray(item.bullets) ? item.bullets : []).map(x => cleanShort(typeof x === 'string' ? x : x?.text, 7)).filter(x => wordsOf(x).length >= 1).slice(0, 4);
    const look = cleanPlace(item.picture ?? item.place ?? item.visual ?? '');
    if (look) {
      const k = normalizeLine(look);
      if (index.has(k)) last = index.get(k);
      else if (places.length < MAX_PLACES) { index.set(k, places.length); last = places.length; places.push(look); }
      else if (!fixes.includes(`more than ${MAX_PLACES} pictures: later scenes reuse the last one`)) fixes.push(`more than ${MAX_PLACES} pictures: later scenes reuse the last one`);
    }
    scenes.push({ speaker: null, say, headline: head, bullets: bullets.length >= 2 ? bullets : [], place: last });
  }
  const first = scenes.find(s => s.place != null)?.place ?? null;
  for (const s of scenes) if (s.place == null) s.place = first;
  if (scenes.length < 2) return { ok: false, reason: 'Fewer than two usable scenes.', scenes, places, fixes };
  let kept = scenes;
  if (kept.length > b.maxScenes + 3) {
    if (!final) return { ok: false, reason: `${kept.length} scenes is too many; use at most ${b.maxScenes}.`, scenes, fixes };
    kept = [...kept.slice(0, b.maxScenes - 1), kept[kept.length - 1]]; fixes.push(`trimmed to ${kept.length} scenes, ending kept`);
  }
  let total = kept.reduce((n, s) => n + wordsOf(s.say).length, 0);
  if (total > b.words * 1.4) {
    if (!final) return { ok: false, reason: `${total} words is too long; aim for about ${b.words}.`, scenes: kept, fixes };
    kept = [...kept];
    while (kept.length > 3 && total > b.words * 1.4) { const gone = kept.splice(kept.length - 2, 1)[0]; total -= wordsOf(gone.say).length; }
    fixes.push(`cut scenes before the ending to fit (${total} words)`);
  }
  if (total < b.words * 0.6) {
    if (!final) return { ok: false, reason: `${total} words is too short; write about ${b.words} words of narration.`, scenes: kept, fixes };
    fixes.push(`shorter than asked (${total} of about ${b.words} words)`);
  }
  const title = cleanTitle(obj.title, plan.request);
  const theme = (THEMES.find(([, re]) => re.test(plan.request)) || ['teal'])[0];
  const estSeconds = +(TITLE_SECONDS + OUTRO_SECONDS + kept.reduce((s, sc) => s + wordsOf(sc.say).length / EXPLAINER_WPS + 0.8, 0)).toFixed(1);
  return { ok: true, title, theme, cast: [{ name: 'narrator', look: 'the narrator' }], scenes: kept, places, words: total, estSeconds, fixes };
}

function explainerMarkdown(plan, script, backdrops = []) {
  const front = ['---', `title: ${script.title}`, 'recipe: explainer', `theme: ${script.theme || 'teal'}`, 'captions: true', `format: ${plan.format}`, '---'];
  const visual = place => { const f = backdrops[place ?? 0]; return f ? [`visual: ${String(f).replace(/\\/g, '/')}`] : []; };
  const body = ['## title', 'kind: title', `# ${headline(script.title)}`, `dur: ${TITLE_SECONDS}`, ...visual(script.scenes[0]?.place), ''];
  script.scenes.forEach((sc, i) => {
    body.push(`## s${String(i + 1).padStart(2, '0')}`, `kind: ${sc.bullets?.length ? 'bullets' : 'statement'}`, `# ${headline(sc.headline)}`, ...visual(sc.place), `say: ${sc.say}`);
    for (const bl of sc.bullets || []) body.push(`- ${bl}`);
    body.push('');
  });
  return front.concat(body).join('\n');
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────────

/** Chat messages asking the writer for a script in the plan's look. */
export function scriptMessagesFor(plan, feedback = null) {
  if (plan.style === 'cartoon') return cartoonMessages(plan, feedback);
  if (plan.style === 'comic') return comicMessages(plan, feedback);
  if (plan.style === 'explainer') return explainerMessages(plan, feedback);
  return scriptMessages(plan, feedback);
}

const GENERIC_NAMES = new Set(['hero', 'robot', 'narrator', 'cat', 'dog', 'bird', 'ghost', 'alien', 'kid', 'boy', 'girl', 'man', 'woman', 'baker', 'keeper', 'astronaut', 'wizard']);
const MAX_SFX = 2;

/** Finishing touches common to the dialogue looks: proper names get their capital back, and sound-effect words stay rare. */
function polish(script) {
  const proper = script.cast.map(c => c.name).filter(n => !GENERIC_NAMES.has(n) && n.length > 1);
  let sfx = 0;
  const scenes = script.scenes.map(sc => {
    let say = sc.say;
    for (const n of proper) say = say.replace(new RegExp(`\\b${n}\\b`, 'gi'), n[0].toUpperCase() + n.slice(1));
    const next = { ...sc, say };
    if (next.sfx && ++sfx > MAX_SFX) delete next.sfx;
    return next;
  });
  const fixes = sfx > MAX_SFX ? [...script.fixes, `kept ${MAX_SFX} of ${sfx} sound-effect words`] : [...script.fixes];
  if (script.drawsPeopleOnly) for (const c of script.cast) { const k = readLook(c.look, c.name).kind; if (k !== 'human') fixes.push(`${c.name} is described as a ${k} but is drawn as a person: this look draws people only`); }
  return { ...script, scenes, fixes };
}

/** Check and tidy what the writer (or a caller) supplied, by the rules of the plan's look. */
export function normalizeFor(raw, plan, opts = {}) {
  if (plan.style === 'explainer') return normalizeExplainer(raw, plan, opts);
  const s = plan.style === 'comic' ? normalizeComic(raw, plan, opts) : normalizeScript(raw, plan, opts);
  if (!s.ok) return s;
  return polish(PIXEL_STYLES.includes(plan.style) ? s : { ...peopleCast(s), drawsPeopleOnly: true });
}

/** The script in the studio's markdown format for the plan's look. `backdrops[i]` is the picture for `script.places[i]`. */
export function buildMarkdownFor(plan, script, backdrops = []) {
  if (plan.style === 'cartoon') return cartoonMarkdown(plan, script);
  if (plan.style === 'comic') return comicMarkdown(plan, script, backdrops);
  if (plan.style === 'explainer') return explainerMarkdown(plan, script, backdrops);
  return buildStudioMarkdown(plan, script, backdrops);
}

/** Does this look use pictures painted by the image model, and for which places? Cartoon sets are drawn by the recipe. */
export function paintsBackdrops(plan) { return plan.backdrops !== false && plan.style !== 'cartoon'; }

/** How many voices a look uses and who they are, for the plan summary and the lineage. */
export function voiceRoles(plan, script) {
  if (plan.style === 'explainer') return ['narrator'];
  return script.cast.map(c => c.name);
}

export { WORDS_PER_SECOND };
