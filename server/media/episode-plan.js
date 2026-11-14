/**
 * Episode plan — a premise becomes a multi-act story, and each act is told as one flat (or stick) film.
 *
 * Gap 7 of docs/NEXUS-ENGINE-CREATION-METHODS.md (Nexus "/api/cartoon/episode": premise → 3–8 sections, each with its
 * own dialogue and picture prompts, written in one paid call and never checked). Here:
 *   1. one model call writes an OUTLINE (title, logline, cast from the recurring flat cast, acts with a beat and a
 *      place), and checkOutline() decides whether it is usable — count, length, cast, beats that differ;
 *   2. each act is planned by Make's own flat writer, handed actContext(): which act it is, its beat, how the story
 *      stands (the last lines of the act before), the cast, the facts looked up once for the premise;
 *   3. checkActNarration() — called from the flat checker as rule 18 — refuses an act that does not tell its beat or
 *      that repeats a line an earlier act already said, and the reason goes back to the writer like any other rule.
 * Everything in this file is pure: no model, no database, no clock.
 */
import { CAST, LEAD, SETTINGS, SETTING_NAMES } from './flat/kit.js';

export const EPISODE_LOOKS = Object.freeze(['flat', 'stick']);
export const ACTS_MIN = 3, ACTS_MAX = 8;
export const SECONDS_PER_ACT = Object.freeze({ min: 15, max: 60, default: 25 });
/** Two beats this alike (content-word Jaccard) are the same beat told twice. */
export const SAME_BEAT = 0.6;
/** A line of an act this alike to a line of an earlier act repeats it. */
export const SAME_LINE = 0.6;

const STOP = new Set('the a an and or but of to in on at by for with from into onto over under as is are was were be been being it its this that these those he she they them his her their you your we our i me my not no so then than there here what when where who why how all any some each one two very just also only still about after before again while until because if out up down off through can could will would shall should may might must do does did has have had get got make made'.split(' '));
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(Boolean);
/** Content words of a text, with a plural's s removed so "storms" meets "storm". */
export const contentWords = s => new Set(words(s).filter(w => w.length > 2 && !STOP.has(w)).map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)));
const jaccard = (a, b) => { const inter = [...a].filter(w => b.has(w)).length, uni = new Set([...a, ...b]).size; return uni ? inter / uni : 0; };
const ascii = s => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').normalize('NFKD').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** The place a beat happens: a kit setting by name, by one of its words, or by the beat's words. */
export function placeFor(where, beat, prev = null) {
  const n = String(where || '').toLowerCase().trim();
  if (SETTINGS[n]) return n;
  const byName = SETTING_NAMES.find(k => SETTINGS[k].words.some(w => n.includes(w)));
  if (byName) return byName;
  const text = ` ${String(beat).toLowerCase().replace(/[^a-z ]/g, ' ')} `;
  return SETTING_NAMES.find(k => [k, ...SETTINGS[k].words].some(w => text.includes(` ${w} `))) || prev || 'field';
}

/** Chat messages asking for an episode outline. `facts` is text looked up for the premise; `topical` names the web page it came from. */
export function outlineMessages(premise, { acts = 4, secondsPerAct = SECONDS_PER_ACT.default, facts = null, topical = null, feedback = null } = {}) {
  const cast = Object.entries(CAST).map(([k, c]) => `${k} (${c.title})`).join(', ');
  const system = [
    'You outline short animated episodes told by one narrator with a small recurring cast. The episode is split into acts; each act will become its own short film, so each act needs its own clear event.',
    'Reply with JSON only: {"title": "...", "logline": "one sentence", "cast": ["..."], "acts": [{"title": "...", "beat": "...", "where": "..."}]}',
    'Rules:',
    `- Exactly ${acts} acts. Each act is about ${secondsPerAct} seconds of narration.`,
    '- "beat" is 12 to 40 words: what happens in that act, in order, with the characters by name. Each beat is a NEW event that follows from the one before; the last beat resolves the story.',
    '- Act titles are 1 to 5 words.',
    `- "cast": 2 to 4 of: ${cast}. "${LEAD}" is the lead and is in every act. Give the other parts to the cast member whose title fits.`,
    `- "where": the main place of that act, one of: ${SETTING_NAMES.join(', ')}. Use at least two different places across the episode.`,
    '- Plain ASCII. No stage directions, no emoji. Do not invent statistics, dates, names of real people or quotations; if FACTS are given, the story does not contradict them.',
  ].join('\n');
  const source = topical ? `\n\nThis premise comes from a page found on the web recently: "${topical.title}". Keep the episode true to what that page says; tell it with the cast.` : '';
  const factText = facts ? `\n\nFACTS (${facts.source || 'looked up'}):\n${facts.text}` : '';
  return [{ role: 'system', content: system }, { role: 'user', content: `Premise: ${premise}${source}${factText}` + (feedback ? `\n\nYour previous outline was refused: ${feedback} Write it again and fix that.` : '') }];
}

/** Check an outline reply. Returns { ok, reason?, outline?, fixes }. The cast is mapped onto the kit; the lead is always in. */
export function checkOutline(raw, { acts = 4 } = {}) {
  let obj = raw;
  if (typeof raw === 'string') { const a = raw.indexOf('{'), z = raw.lastIndexOf('}'); try { obj = a >= 0 && z > a ? JSON.parse(raw.slice(a, z + 1)) : null; } catch (_) { obj = null; } }
  if (!obj || typeof obj !== 'object') return { ok: false, reason: 'The reply was not one JSON object.', fixes: [] };
  const fixes = [];
  const want = Math.max(ACTS_MIN, Math.min(ACTS_MAX, acts | 0));
  const title = clip(ascii(obj.title).replace(/["#<>`|\\]/g, ''), 60);
  if (title.length < 3) return { ok: false, reason: 'The episode has no title.', fixes };
  let cast = [...new Set((Array.isArray(obj.cast) ? obj.cast : []).map(c => String(typeof c === 'string' ? c : c?.name || '').toLowerCase().trim()).filter(c => CAST[c]))];
  if (!cast.includes(LEAD)) { cast.unshift(LEAD); fixes.push(`the lead ${LEAD} added to the cast`); }
  if (cast.length > 4) { fixes.push(`cast cut to four (${cast.slice(4).join(', ')} left out)`); cast = cast.slice(0, 4); }
  if (cast.length < 2) return { ok: false, reason: `The cast needs at least two of the recurring characters (${Object.keys(CAST).join(', ')}); it named ${cast.join(', ') || 'none'}.`, fixes };
  const list = Array.isArray(obj.acts) ? obj.acts : [];
  const parsed = list.map(a => ({ title: clip(ascii(a?.title || '').replace(/["#<>`|\\]/g, ''), 40), beat: clip(ascii(a?.beat || a?.summary || ''), 400), where: String(a?.where || a?.setting || '') }))
    .filter(a => a.beat);
  if (parsed.length > want) { fixes.push(`${parsed.length} acts written, ${want} asked: the extra acts before the last were left out`); parsed.splice(want - 1, parsed.length - want); }
  if (parsed.length < want) return { ok: false, reason: `${parsed.length} acts with a beat; ${want} were asked for.`, fixes };
  let prev = null;
  const out = [];
  for (const [i, a] of parsed.entries()) {
    const n = words(a.beat).length;
    if (n < 8) return { ok: false, reason: `Act ${i + 1}'s beat has ${n} words; a beat says what happens in 12 to 40 words.`, fixes };
    const where = placeFor(a.where, a.beat, prev);
    if (a.where && where !== String(a.where).toLowerCase().trim()) fixes.push(`act ${i + 1}: "${clip(a.where, 30)}" read as ${where}`);
    prev = where;
    out.push({ n: i + 1, title: a.title || `Act ${i + 1}`, beat: a.beat, where });
  }
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const s = jaccard(contentWords(out[i].beat), contentWords(out[j].beat));
    if (s >= SAME_BEAT) return { ok: false, reason: `Acts ${i + 1} and ${j + 1} tell nearly the same beat; every act needs a new event.`, fixes };
  }
  if (new Set(out.map(a => a.where)).size < 2) fixes.push('every act happens in one place (two were asked for)');
  return { ok: true, outline: { title, logline: clip(ascii(obj.logline || ''), 200), cast, acts: out }, fixes };
}

/** The last two narration lines of an act: how the story stands when the next act begins. */
export const actSummary = shots => (shots || []).slice(-2).map(s => s.say).join(' ');

/**
 * What act k (1-based) is handed: the episode, its own beat, how the story stands, and every line already said
 * (so it can be refused for repeating one).
 */
export function actContext(outline, k, earlier = []) {
  const act = outline.acts[k - 1];
  const prev = earlier[earlier.length - 1];
  return {
    episode: outline.title, logline: outline.logline, act: k, of: outline.acts.length, title: act.title, beat: act.beat, where: act.where,
    cast: outline.cast, previously: prev ? actSummary(prev.shots) : null, nextBeat: outline.acts[k]?.beat || null,
    earlierLines: earlier.flatMap(e => (e.shots || []).map(s => s.say)),
  };
}

/** The user-message block the flat writer gets for an act (appended after its request). */
export function actBrief(ctx) {
  const lines = [
    `EPISODE: "${ctx.episode}" — ${ctx.logline || ''}`.trim(),
    `This is act ${ctx.act} of ${ctx.of}: "${ctx.title}". Tell ONLY this act's beat: ${ctx.beat}`,
    `Cast for the whole episode: ${ctx.cast.join(', ')}. Use them by these names in "who"; ${LEAD} is the lead.`,
  ];
  if (ctx.previously) lines.push(`The act before ended with: "${ctx.previously}" Begin right after that moment: do not introduce the characters again and do not retell the earlier acts.`);
  else lines.push('This is the first act: line 1 hooks the viewer into the whole episode.');
  if (ctx.nextBeat) lines.push(`Stop before the next act's event (${clip(ctx.nextBeat, 120)}): the last line leaves the story moving towards it, as a statement.`);
  else lines.push('This is the last act: the last line resolves the episode.');
  return lines.join('\n');
}

/**
 * Rule 18 for an act: it tells its beat (shares content words with it) and repeats no line an earlier act said.
 * Returns { ok, detail, reason }.
 */
export function checkActNarration(shots, ctx) {
  const said = contentWords(shots.map(s => s.say).join(' ')), beat = contentWords(ctx.beat);
  const shared = [...beat].filter(w => said.has(w));
  const need = Math.min(3, Math.max(1, Math.ceil(beat.size / 5)));
  if (shared.length < need) return { ok: false, detail: `${shared.length} of the beat's words used`, reason: `This act does not tell its beat (it shares ${shared.length} of ${need} needed words with it: ${[...beat].slice(0, 8).join(', ')}). Tell what the beat says happens: ${ctx.beat}` };
  for (const [i, s] of shots.entries()) {
    const a = contentWords(s.say);
    if (a.size < 3) continue;
    const hit = (ctx.earlierLines || []).find(e => jaccard(a, contentWords(e)) >= SAME_LINE);
    if (hit) return { ok: false, detail: `shot ${i + 1} repeats an earlier act`, reason: `Shot ${i + 1} ("${clip(s.say, 60)}") repeats what an earlier act already said ("${clip(hit, 60)}"). Every act moves the story on.` };
  }
  return { ok: true, detail: `tells its beat (${shared.slice(0, 5).join(', ')}); repeats no earlier line`, reason: '' };
}

// The world poller's finds are search results for Chandra's interests, not news: reference, stock and how-to pages are
// among them (measured 2026-11-14: "Gartner hype cycle - Wikipedia", "Donate Overlay royalty-free images - Shutterstock",
// "18 Easy Ways to Increase Your Attention Span"). None of those holds a story, so none is a premise.
const NOT_A_STORY = /\b(login|sign in|subscribe|404|page not found|wikipedia|wikihow|shutterstock|royalty-free|stock (photos?|images?)|dictionary|definition of)\b|^(how to|a (practical )?guide|\d+ (easy |simple |best )?(ways|tips|steps))\b/i;
/** A premise from something the world poller found on the web recently, or null. Pure: the rows are passed in. */
export function topicalPick(rows, used = new Set()) {
  const ok = (rows || []).filter(r => r && r.title && r.title.length >= 20 && !used.has(r.url) && !NOT_A_STORY.test(r.title));
  // search results cut long titles with "..." ("…in themselves: The ..."): the cut-off tail is not part of the premise
  return ok[0] ? { title: ascii(ok[0].title).replace(/[\s:,;-]*(\b\w{1,4}\s*)?(\.\.\.|…)\s*$/, '').trim(), url: ok[0].url, snippet: ascii(ok[0].snippet || '').slice(0, 300), observedAt: ok[0].observed_at } : null;
}
