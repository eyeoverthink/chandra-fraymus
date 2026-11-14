/**
 * Flat plan — a sentence becomes a shot list, and the shot list is checked against numbered rules.
 *
 * The method (abstracted from how shot-by-shot cartoon shorts are produced with paid tools, and rebuilt on
 * what runs here for free):
 *   1. study what works and write it down as RULES with numbers where possible;
 *   2. keep one recurring cast;
 *   3. plan: one narration line per shot, and for each shot what the picture shows, how it moves, what sounds;
 *   4. check every shot against the rules BEFORE anything is rendered, and send misses back with the reason;
 *   5. record the voice, then cut each picture in exactly where its line begins;
 *   6. check the finished film again, by measurement.
 * Steps 1–4 live in this file and are pure. A paid image model has to be asked, looked at and asked again;
 * here a shot is assembled from a fixed vocabulary, so most rules can be decided from the plan alone.
 */
import { CAST, LEAD, FEELINGS, ACTS, CAMERAS, SETTINGS, SETTING_NAMES, ALREADY_THERE } from './kit.js';
import { PROPS, PROP_NAMES, findProp, lineNamesProp, phraseSaid } from './props.js';

export const SFX_NAMES = Object.freeze(['none', 'whoosh', 'pop', 'ding', 'thud', 'boom', 'zap', 'tick', 'sparkle', 'rumble', 'splash']);
/** A prop that is on screen suggests its own sound when the planner names none. */
const PROP_SFX = { cannon: 'boom', fire: 'rumble', bolt: 'zap', rocket: 'whoosh', comet: 'whoosh', plane: 'whoosh', coin: 'ding', lightbulb: 'ding', trophy: 'sparkle', star: 'sparkle', clock: 'tick', ship: 'splash', fish: 'splash', drop: 'splash', rock: 'thud', crate: 'thud', skull: 'thud', exclaim: 'pop', question: 'pop', factory: 'rumble', car: 'whoosh' };

/** Narration pace of one voice reading line by line with trimmed silence, and the pause between lines. */
// lineWords is what the 14B writer actually writes (asked for 9-word lines it wrote 7), so the time is filled with more shots
// cps: letters and digits spoken a second, fitted over the first seven films voiced by VoiceStudio (the same fit by words was
  // off by 2.8 s, by letters 1.6 s: "emus run" and "antibodies neutralise" are both two words). gap is the real pause laid between lines.
export const FLAT_PACE = Object.freeze({ cps: 11.6, lettersPerWord: 4.4, wps: 11.6 / 4.4, gap: 0.22, tail: 0.7, lineWords: 7.5 });
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean);
const toAscii = s => String(s ?? '').replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—−]/g, '-').replace(/…/g, '...').normalize('NFKD').replace(/[^\x20-\x7E]/g, '');

export function flatBudget(seconds, pace = FLAT_PACE) {
  const speak = Math.max(6, seconds - pace.tail), total = Math.round(speak * pace.cps / pace.lettersPerWord);
  const shots = Math.min(28, Math.max(4, Math.round(total / pace.lineWords)));
  return { shots, minShots: Math.max(4, shots - 2), maxShots: shots + 3, words: total };
}
export const flatSeconds = (shots, pace = FLAT_PACE) => +(pace.tail + shots.reduce((s, x) => s + String(x.say || '').replace(/[^A-Za-z0-9]/g, '').length / pace.cps, 0)).toFixed(1);

/** The rules, numbered. `hard` rules send a plan back; the others are reported with the film. */
export const RULES = Object.freeze([
  { n: 1, hard: true, text: 'The first line is a hook: at most 14 words.' },
  { n: 2, hard: true, text: 'The last line is a statement that lands the ending, never a question.' },
  { n: 3, hard: true, text: 'One narration line per shot, 3 to 18 words each.' },
  { n: 4, hard: true, text: 'The number of shots fits the asked length.' },
  { n: 5, hard: true, text: 'Every shot shows something: at least one cast member or one prop.' },
  { n: 6, hard: true, text: 'Never more than three characters in a shot.' },
  { n: 7, hard: true, text: 'The lead character is in at least half of the shots.' },
  { n: 8, hard: true, text: 'At least two shots are picture jokes: the picture shows exactly what the words say.' },
  { n: 9, hard: false, text: 'Every setting is a painted place with a light you can see (true of every setting in the kit).' },
  { n: 10, hard: false, text: 'A film of six shots or more visits at least two settings.' },
  { n: 11, hard: false, text: 'A number or word shown big on screen is one the narration says.' },
  { n: 12, hard: true, text: 'The whole narration fits the asked length.' },
  { n: 13, hard: false, text: 'Each character shows one clear feeling per shot.' },
  { n: 14, hard: false, text: 'No camera move is used more than three shots in a row.' },
  { n: 15, hard: false, text: 'A film of six shots or more uses at least two cast members.' },
  { n: 16, hard: false, text: 'No prop appears in more than half of the shots.' },
  { n: 17, hard: true, text: 'No line repeats another: every line adds something new.' },
]);

/** Chat messages asking the writer for a shot list. `feedback` is the reason the previous one was refused. */
export function flatMessages(plan, feedback = null) {
  const b = flatBudget(plan.seconds);
  const castLines = Object.entries(CAST).map(([k, c]) => `${k} (${c.title})`).join(', ');
  const system = [
    'You plan very short flat-vector animated films: one narrator, a small recurring cast, bold simple pictures.',
    'If the request asks to explain something, explain it truthfully in plain words. If it asks for a story, tell it to the viewer as "you" ("you are a soldier", "your enemy is..."), with one main character.',
    'Reply with JSON only: {"title": "...", "shots": [{"say": "...", "where": "...", "show": ["..."], "who": ["..."], "feel": "..."}]}',
    'Rules:',
    `- ${b.minShots} to ${b.maxShots} shots, about ${b.words} words of narration in total: one line per shot, each line 6 to 12 words. Count your shots before you answer.`,
    '- "say" is exactly what the narrator says. Plain ASCII, no brackets, no stage directions, no emoji.',
    '- Line 1 is a hook of at most 14 words. Every line after it adds a new event or fact, in order. The last line lands the ending as a statement and the film stops: no summary, no moral, no "and that is how".',
    `- "where" is one of: ${SETTING_NAMES.join(', ')}. Use at least two different places.`,
    `- "show" has one to three of: ${PROP_NAMES.join(', ')}. Choose things the line actually talks about, so the picture shows what the words say.`,
    `- "who" has zero to three of: ${castLines}. "${LEAD}" is the lead and appears in most shots.`,
    '- Give the other parts in the story to other cast members (the powerful or rich one to baron, the expert to prof, the strong one to bru, the child to zee, the helper to dot). At least two different cast members appear in the film.',
    '- Change what is shown from shot to shot: nothing appears in more than half of the shots.',
    `- "feel" is the one feeling of that shot, one of: ${FEELINGS.join(', ')}.`,
    '- Positions, movement, camera, sound effects and big on-screen numbers are added for you: do not write them.',
    '- Do not invent statistics, dates, names, quotations or events. If you are not sure of a number, leave it out or say "about". If FACTS are given below the request, the film says only what they support.',
    '- Do not put a cast name in "show": the cast goes in "who".',
  ].join('\n');
  const facts = plan.facts?.text ? `\n\nFACTS from ${plan.facts.source} — use these and nothing that contradicts them; where they give a number or a date, use that one; do not add events they do not mention:\n${plan.facts.text}` : '';
  return [{ role: 'system', content: system }, { role: 'user', content: `Request: ${plan.request}${facts}` + (feedback ? `\n\nYour previous plan was refused: ${feedback} Plan it again and fix that.` : '') }];
}

function cleanSay(raw) {
  let s = toAscii(raw).replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ').replace(/^\s*(narrator|voice|vo)\s*:\s*/i, '').replace(/["#>_`|\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (words(s).length >= 2) { s = s[0].toUpperCase() + s.slice(1); if (!/[.!?]$/.test(s)) s = s.replace(/[,;:\s-]+$/, '') + '.'; }
  return s;
}
const settingFor = (name, line, prev) => {
  const n = String(name || '').toLowerCase().trim();
  if (SETTINGS[n]) return { setting: n, how: null };
  const fromName = SETTING_NAMES.find(k => SETTINGS[k].words.some(w => n.includes(w)));
  if (fromName) return { setting: fromName, how: `"${n}" read as ${fromName}` };
  const text = ` ${String(line).toLowerCase().replace(/[^a-z ]/g, ' ')} `;
  const fromLine = SETTING_NAMES.find(k => [k, ...SETTINGS[k].words].some(w => text.includes(` ${w} `)));
  if (fromLine) return { setting: fromLine, how: `setting taken from the words (${fromLine})` };
  return { setting: prev || 'field', how: n ? `unknown setting "${n}": ${prev || 'field'} used` : null };
};
/** Props a line talks about, in the order the kit lists them: the fallback when the planner named none that exist. */
export function propsFromLine(line, max = 2) {
  // longest phrase first, and a word already inside a chosen phrase does not choose a second prop ("machine gun" is a gun, not a machine)
  const hits = PROP_NAMES.map(p => ({ p, phrase: phraseSaid(line, p) })).filter(h => h.phrase).sort((a, b) => b.phrase.length - a.phrase.length);
  const chosen = [];
  for (const h of hits) { if (chosen.length >= max) break; if (chosen.some(c => c.phrase !== h.phrase && ` ${c.phrase} `.includes(` ${h.phrase} `))) continue; chosen.push(h); }
  return chosen.map(h => h.p);
}

/** Does a label repeat something the line says? Digits must match digits; words must be words of the line. */
export function labelIsSaid(label, line) {
  const l = String(label || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim(); if (!l) return false;
  const text = String(line || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
  const digits = l.replace(/[^0-9]/g, '');
  if (digits) return text.replace(/[^0-9]/g, '').includes(digits) || text.replace(/\s/g, '').includes(l.replace(/\s/g, ''));
  const said = new Set(words(text));
  return words(l).every(w => said.has(w));
}

const ROLE_WORDS = Object.freeze({
  baron: ['commander', 'king', 'queen', 'rich', 'boss', 'government', 'general', 'president', 'owner', 'leader', 'emperor', 'minister', 'officer', 'banker', 'merchant', 'lord', 'mayor', 'company', 'conman', 'thief'],
  prof: ['scientist', 'scientists', 'doctor', 'doctors', 'expert', 'experts', 'historians', 'professor', 'researchers', 'engineer', 'engineers', 'teacher', 'astronomer', 'inventor'],
  bru: ['soldier', 'soldiers', 'army', 'farmer', 'farmers', 'worker', 'workers', 'guard', 'guards', 'sailor', 'sailors', 'miners', 'police', 'troops', 'immune', 'defenders', 'fighters', 'crew'],
  zee: ['child', 'kid', 'children', 'boy', 'girl', 'student', 'students', 'baby'],
  dot: ['friend', 'friends', 'helper', 'assistant', 'neighbour', 'neighbor', 'team', 'messenger', 'signal', 'signals'],
});
const RELATED = Object.freeze({ field: 'sunset', desert: 'sunset', micro: 'lab', space: 'night', city: 'room', lab: 'micro', room: 'city', ocean: 'sunset', forest: 'night', mountains: 'snow', snow: 'night', night: 'room', sunset: 'night' });
const FEEL_ACT = Object.freeze({ scared: 'shake', angry: 'shake', happy: 'hop', surprised: 'hop', proud: 'cheer', sad: 'droop', tired: 'droop', curious: 'wave' });

/**
 * The art director: stage the pictures the writer only named. The writer is good at words and poor at
 * variety (one place, one character and the same prop in fifteen shots in a row); these are mechanical
 * decisions, so code makes them, deterministically, and records each one in `fixes`.
 * Mutates `shots`.
 */
export function direct(shots, fixes = []) {
  const n = shots.length; if (!n) return shots;
  const note = m => { if (!fixes.includes(m)) fixes.push(m); };
  const said = s => new Set(words(String(s.say).toLowerCase().replace(/[^a-z ]/g, ' ')));
  // 1. no prop in more than half of the shots: drop it first where the line does not name it, then where the shot has something else to show
  const cap = Math.max(2, Math.ceil(n / 2)), count = {};
  for (const s of shots) for (const p of s.props) count[p] = (count[p] || 0) + 1;
  for (const p of Object.keys(count).filter(k => count[k] > cap && n >= 4)) {
    const order = shots.map((s, i) => i).filter(i => shots[i].props.includes(p)).sort((a, b) => (lineNamesProp(shots[a].say, p) - lineNamesProp(shots[b].say, p)) || (shots[b].props.length - shots[a].props.length) || (b - a));
    for (const i of order) { if (count[p] <= cap) break; const s = shots[i]; if (s.props.length < 2 && !s.cast.length) continue; s.props = s.props.filter(x => x !== p); count[p]--; }
    note(`staging: "${p}" was in too many shots; kept in ${count[p]} of ${n}`);
  }
  // the picture shows what the words say: a shot whose props are none of the things its line names gets the named thing added
  for (const s of shots) if (!s.props.some(p => lineNamesProp(s.say, p))) { const add = propsFromLine(s.say).filter(p => !s.props.includes(p) && (count[p] || 0) < cap).slice(0, 3 - s.props.length); if (add.length) { s.props = [...add, ...s.props]; for (const p of add) count[p] = (count[p] || 0) + 1; } }
  // 2. the parts in the story go to the cast: a line about a commander shows the baron, soldiers show bru
  for (const s of shots) { const w = said(s); for (const [who, list] of Object.entries(ROLE_WORDS)) if (s.cast.length < 2 && !s.cast.some(c => c.who === who) && list.some(x => w.has(x))) { s.cast.push({ who, feel: s.cast[0]?.feel === 'scared' ? 'angry' : 'neutral', at: null, act: 'idle' }); note(`staging: ${who} plays a part the words name`); break; } }
  // 2b. the same pair standing side by side shot after shot is a slideshow: in a long run, every third shot is one of them alone, turn about
  { let run = 0; for (let i = 1; i < n; i++) { const same = shots[i].cast.length >= 2 && shots[i].cast.map(c => c.who).join() === shots[i - 1].cast.map(c => c.who).join(); run = same ? run + 1 : 0; if (run >= 2 && run % 3 === 2) { shots[i].cast = [shots[i].cast[Math.floor(run / 3) % shots[i].cast.length]]; note('staging: a pair that stood together for many shots takes turns alone'); } } }
  // 3. at least two places in a film of six shots or more: the ending moves on (day turns to sunset, the cell to the lab)
  if (n >= 6 && new Set(shots.map(s => s.setting)).size < 2) { const from = shots[0].setting, to = RELATED[from] || 'sunset', start = Math.ceil(n * 0.7); for (let i = start; i < n; i++) shots[i].setting = to; note(`staging: the last ${n - start} shots move from ${from} to ${to}, so the film has more than one place`); }
  // 4. a number the narrator says is shown big, in at most a third of the shots
  let labels = shots.filter(s => s.label).length;
  for (const s of shots) { if (s.label || labels >= Math.ceil(n / 3)) continue; const m = /\b\d[\d,.]*\d\b/.exec(s.say); if (m && m[0].replace(/[^0-9]/g, '').length >= 2) { s.label = m[0].replace(/[.,]$/, ''); labels++; } }
  // 5. movement follows the feeling; the lead walks in at the start; positions are left to the layout
  shots.forEach((s, i) => s.cast.forEach((c, k) => { if (!c.act || c.act === 'idle') c.act = i === 0 && k === 0 ? 'enter-left' : (FEEL_ACT[c.feel] && (c.feel !== 'curious' || (i + k) % 2 === 0) ? FEEL_ACT[c.feel] : 'idle'); }));
  // 6. camera: what the writer did not choose rotates, and nothing repeats three times running
  const cams = ['push', 'pan-right', 'still', 'pull', 'pan-left', 'rise'];
  shots.forEach((s, i) => { if (!s.camera) s.camera = cams[i % cams.length]; if (i >= 2 && s.camera === shots[i - 1].camera && s.camera === shots[i - 2].camera) s.camera = cams[(cams.indexOf(s.camera) + 2) % cams.length]; });
  // 7. sound: what is on screen is heard; a big number pops; otherwise a soft whoosh on some cuts
  shots.forEach((s, i) => { if (!s.sfx || s.sfx === 'none') s.sfx = s.props.map(p => PROP_SFX[p]).find(Boolean) || (s.label ? 'pop' : i > 0 && i % 3 === 0 ? 'whoosh' : 'none'); });
  // 8. shape morphs: where two shots in a row each feature a different prop, the cut becomes the first prop's outline
  // flowing into the second's (morph.js) instead of a dip to black. Never two morphs in a row — every cut a morph is
  // its own kind of slideshow.
  const hero = s => (s.props || []).find(p => !(ALREADY_THERE[s.setting] || []).includes(p)) || null;
  const morphs = [];
  for (let i = 1; i < n; i++) {
    delete shots[i].morphFrom;
    const a = hero(shots[i - 1]), b = hero(shots[i]);
    // not when the new shot still shows the first prop: it would travel away and pop back in beside its own morph
    // (seen in the first film: rocket → satellite while the rocket stayed in the shot)
    if (a && b && a !== b && !shots[i - 1].morphFrom && !(shots[i].props || []).includes(a)) { shots[i].morphFrom = a; shots[i].morphTo = b; morphs.push(`${a} → ${b}`); }
  }
  if (morphs.length) note(`staging: ${morphs.length} cut${morphs.length > 1 ? 's' : ''} become shape morphs (${morphs.join(', ')})`);
  return shots;
}

/**
 * Check and tidy a shot list.
 * @returns {{ ok, reason?, title, shots, cast, words, estSeconds, rules: [{n, ok, detail}], fixes }}
 * `final: true` accepts a plan that still breaks a hard rule about length or count and says so in `fixes`.
 */
export function normalizeFlat(raw, plan, { final = false } = {}) {
  let obj = raw;
  if (typeof raw === 'string') { const a = raw.indexOf('{'), z = raw.lastIndexOf('}'); try { obj = a >= 0 && z > a ? JSON.parse(raw.slice(a, z + 1)) : null; } catch (_) { obj = null; } }
  const list = obj && (Array.isArray(obj.shots) ? obj.shots : Array.isArray(obj.scenes) ? obj.scenes : null);
  if (!list) return { ok: false, reason: 'The reply was not JSON with a "shots" list.', shots: [], fixes: [], rules: [] };
  const seconds = plan.seconds ?? 40, b = flatBudget(seconds), fixes = [], shots = [];
  let prevSetting = null;
  list.forEach((item, idx) => {
    const say = cleanSay(typeof item === 'string' ? item : item?.say ?? item?.line ?? item?.text ?? '');
    if (words(say).length < 2) return;
    const it = item && typeof item === 'object' ? item : {};
    const st = settingFor(it.where ?? it.setting ?? it.place, say, prevSetting); if (st.how) fixes.push(`shot ${shots.length + 1}: ${st.how}`);
    prevSetting = st.setting;
    const rawProps = it.show ?? it.props;
    const asked = (Array.isArray(rawProps) ? rawProps : typeof rawProps === 'string' ? rawProps.split(',') : []).map(p => String(p));
    let props = [...new Set(asked.map(findProp).filter(Boolean))].slice(0, 3);
    const unknown = asked.filter(p => p.trim() && !findProp(p));
    if (unknown.length) fixes.push(`shot ${shots.length + 1}: not in the kit, left out: ${unknown.slice(0, 3).join(', ')}`);
    if (!props.length) { props = propsFromLine(say); if (props.length) fixes.push(`shot ${shots.length + 1}: props chosen from the words (${props.join(', ')})`); }
    const rawCast = Array.isArray(it.cast) ? it.cast : Array.isArray(it.who) ? it.who : typeof it.who === 'string' && it.who.trim() ? it.who.split(',') : [];
    const shotFeel = String(it.feel || '').toLowerCase();
    const cast = rawCast.map(c => (typeof c === 'string' ? { who: c } : c || {})).map(c => {
      const who = String(c.who || c.name || '').toLowerCase().trim();
      return { who: CAST[who] ? who : LEAD, feel: FEELINGS.includes(String(c.feel).toLowerCase()) ? String(c.feel).toLowerCase() : FEELINGS.includes(shotFeel) ? shotFeel : 'neutral', at: ['left', 'center', 'right'].includes(c.at) ? c.at : null, act: ACTS.includes(String(c.act).toLowerCase()) ? String(c.act).toLowerCase() : 'idle' };
    });
    const seen = new Set(), unique = cast.filter(c => !seen.has(c.who) && seen.add(c.who));
    if (unique.length > 3) fixes.push(`shot ${shots.length + 1}: more than three characters, the first three kept`);
    let label = toAscii(it.label || '').replace(/["<>]/g, '').trim().slice(0, 18);
    if (label && !labelIsSaid(label, say)) { fixes.push(`shot ${shots.length + 1}: label "${label}" is not something the line says; removed`); label = ''; }
    const camera = CAMERAS.includes(String(it.camera).toLowerCase()) ? String(it.camera).toLowerCase() : null;
    const sfx = SFX_NAMES.includes(String(it.sfx).toLowerCase()) ? String(it.sfx).toLowerCase() : null;
    shots.push({ say, setting: st.setting, props, cast: unique.slice(0, 3), camera, label, sfx });
  });
  // a plan that runs long is cut before its ending when no further attempt is coming
  if (final) { let cutN = 0; while (shots.length > 4 && flatSeconds(shots) > seconds * 1.15) { shots.splice(shots.length - 2, 1); cutN++; } if (cutN) fixes.push(`${cutN} shots cut before the ending to fit ${seconds} seconds`); }
  direct(shots, fixes);

  const total = shots.reduce((n, s) => n + words(s.say).length, 0), est = flatSeconds(shots);
  const withLead = shots.filter(s => s.cast.some(c => c.who === LEAD)).length;
  const jokes = shots.filter(s => s.props.some(p => lineNamesProp(s.say, p)) || (s.label && labelIsSaid(s.label, s.say))).length;
  const empty = shots.findIndex(s => !s.cast.length && !s.props.length);
  const badLen = shots.findIndex(s => { const n = words(s.say).length; return n < 3 || n > 18; });
  const settingsUsed = new Set(shots.map(s => s.setting)).size;
  const first = shots[0]?.say || '', last = shots[shots.length - 1]?.say || '';
  const check = {
    1: [words(first).length <= 14, `${words(first).length} words`],
    2: [!!last && !/\?\s*$/.test(last), last.slice(0, 60)],
    3: [badLen < 0, badLen < 0 ? 'all lines in range' : `shot ${badLen + 1} has ${words(shots[badLen].say).length} words`],
    // the count the writer is asked for is a target; what is refused is a shot that would sit for over 5.5 s or flash by in under 1.8 s
    4: [shots.length >= Math.ceil(seconds / 5.5) && shots.length <= Math.floor(seconds / 1.8), `${shots.length} shots (between ${Math.ceil(seconds / 5.5)} and ${Math.floor(seconds / 1.8)} for ${seconds} s)`],
    5: [empty < 0, empty < 0 ? 'every shot shows something' : `shot ${empty + 1} shows nothing`],
    6: [shots.every(s => s.cast.length <= 3), 'at most three'],
    7: [shots.length > 0 && withLead >= Math.ceil(shots.length / 2), `${LEAD} in ${withLead} of ${shots.length}`],
    8: [jokes >= 2, `${jokes} shots show what their line says`],
    9: [shots.every(s => !!SETTINGS[s.setting]), 'all from the kit'],
    10: [shots.length < 6 || settingsUsed >= 2, `${settingsUsed} settings`],
    11: [shots.every(s => !s.label || labelIsSaid(s.label, s.say)), 'labels repeat the narration'],
    12: [est >= seconds * 0.85 && est <= seconds * 1.2, `about ${Math.round(est)} of ${seconds} seconds (${total} words)`],
    13: [shots.every(s => s.cast.every(c => FEELINGS.includes(c.feel))), 'one feeling each'],
    14: [true, 'varied'],
    15: [shots.length < 6 || new Set(shots.flatMap(s => s.cast.map(c => c.who))).size >= 2, `${new Set(shots.flatMap(s => s.cast.map(c => c.who))).size} cast members`],
    16: [true, ''],
    17: [true, 'no line repeats another'],
  };
  { const sets = shots.map(s => new Set(words(s.say.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')).filter(w => w.length > 2))); let hit = null;
    for (let i = 0; i < sets.length && !hit; i++) for (let j = i + 1; j < sets.length; j++) { const inter = [...sets[i]].filter(w => sets[j].has(w)).length, uni = new Set([...sets[i], ...sets[j]]).size; if (uni && inter / uni >= 0.5) { hit = [i, j]; break; } }
    if (hit) check[17] = [false, `shots ${hit[0] + 1} and ${hit[1] + 1} say nearly the same thing`];
    // a slogan repeated with new endings ("Your immune system is always…" five times) is padding too
    const opens = {}; shots.forEach((x, i) => { const k = words(x.say.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')).slice(0, 3).join(' '); (opens[k] = opens[k] || []).push(i); });
    const rep = Object.entries(opens).find(([k, v]) => k.split(' ').length === 3 && v.length >= 3);
    if (!hit && rep) check[17] = [false, `shots ${rep[1][1] + 1} and ${rep[1][2] + 1} say nearly the same thing (${rep[1].length} lines begin "${rep[0]}")`]; }
  { const count = {}; for (const s of shots) for (const p of s.props) count[p] = (count[p] || 0) + 1; const worst = Object.entries(count).sort((a, b) => b[1] - a[1])[0]; check[16] = [!worst || shots.length < 4 || worst[1] <= Math.ceil(shots.length / 2), worst ? `${worst[0]} in ${worst[1]} of ${shots.length}` : 'no props']; }
  const rules = RULES.map(r => ({ n: r.n, hard: r.hard, ok: !!check[r.n][0], detail: check[r.n][1] }));
  const base = { title: toAscii(obj.title || '').replace(/["#>_`|\\:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Untitled', shots, scenes: shots, cast: [...new Set(shots.flatMap(s => s.cast.map(c => c.who)))], words: total, estSeconds: est, rules, fixes };
  if (shots.length < 2) return { ...base, ok: false, reason: 'Fewer than two usable shots.' };
  const reasons = {
    1: `Line 1 has ${words(first).length} words; a hook is at most 14.`,
    2: 'The last line is a question. End on a statement that lands the ending.',
    3: badLen >= 0 ? `Shot ${badLen + 1} has ${words(shots[badLen].say).length} words; every line is 3 to 18 words.` : '',
    4: `${shots.length} shots; write ${b.minShots} to ${b.maxShots}, one line of about ${FLAT_PACE.lineWords} words each.`,
    5: empty >= 0 ? `Shot ${empty + 1} shows nothing: give it a cast member or a prop from the list.` : '',
    6: 'A shot has more than three characters.',
    7: `${LEAD} is in ${withLead} of ${shots.length} shots; the lead must be in at least half.`,
    8: `Only ${jokes} shots show what their line says; in at least two shots choose a prop the line names (for example the line says "rocket" and props has "rocket").`,
    17: `${check[17][1]}: "${shots[(/shots (\d+) and (\d+)/.exec(check[17][1]) || [0, 1, 1])[2] - 1]?.say}". Every line must add a new event or fact; do not pad the ending with slogans.`,
    12: est < seconds * 0.85 ? `${total} words would run about ${Math.round(est)} seconds and ${seconds} were asked for. Write about ${b.words} words: ${b.shots} shots of roughly ${FLAT_PACE.lineWords} words each.` : `${total} words would run about ${Math.round(est)} seconds; ${seconds} were asked for. Aim for about ${b.words} words.`,
  };
  const failed = rules.filter(r => r.hard && !r.ok);
  if (failed.length && !final) return { ...base, ok: false, reason: failed.slice(0, 2).map(r => `Rule ${r.n}: ${reasons[r.n]}`).join(' ') };
  // last resort: repair what can be repaired without the writer, and say so
  if (failed.some(r => r.n === 7)) { for (const s of shots) if (!s.cast.some(c => c.who === LEAD) && s.cast.length < 3 && shots.filter(x => x.cast.some(c => c.who === LEAD)).length < Math.ceil(shots.length / 2)) s.cast.unshift({ who: LEAD, feel: 'curious', at: null, act: 'idle' }); fixes.push(`${LEAD} added to shots to keep the lead on screen`); }
  if (failed.some(r => r.n === 17)) { const key = x => new Set(words(x.say.toLowerCase().replace(/[^a-z0-9 ]/g, ' ')).filter(w => w.length > 2)); const alike = (o, t) => { const inter = [...o].filter(w => t.has(w)).length, uni = new Set([...o, ...t]).size; return uni && inter / uni >= 0.5; }; const kept = []; for (let i = shots.length - 1; i >= 0; i--) { const k = key(shots[i]); if (kept.some(o => alike(o, k))) shots.splice(i, 1); else kept.push(k); } fixes.push('lines that repeated an earlier line were removed'); }
  if (failed.some(r => r.n === 5)) { for (const s of shots) if (!s.cast.length && !s.props.length) s.cast.push({ who: LEAD, feel: 'curious', at: 'center', act: 'idle' }); fixes.push('empty shots given the lead character'); }
  for (const r of failed) if (![5, 7, 17].includes(r.n)) fixes.push(`rule ${r.n} not met: ${r.detail}`);
  return { ...base, ok: true };
}

/** Is every content word of an article title present in the subject? Plurals count ("emus" names "Emu"). */
export function titleFitsSubject(title, subject) {
  const clean = w => w.toLowerCase().replace(/[^a-z0-9]/g, ''), forms = w => [w, w.replace(/s$/, ''), w.replace(/es$/, '')];
  const have = new Set(String(subject).split(/\s+/).map(clean).filter(Boolean).flatMap(forms));
  const need = String(title).replace(/\([^)]*\)/g, ' ').split(/[\s/-]+/).map(clean).filter(w => w && !['the', 'of', 'a', 'an', 'and', 'in', 'on'].includes(w));
  // a one-word title must be named outright; of a longer title most words must be ("Adaptive immune system" is about "immune system")
  const hits = need.filter(w => forms(w).some(f => have.has(f))).length;
  return need.length > 0 && (need.length === 1 ? hits === 1 : hits >= Math.max(2, Math.ceil(need.length * 0.6)));
}
