/**
 * Dream grounding — the nightly consolidation may only learn what the evidence shows.
 *
 * Measured 2026-11-12: the daemon's dream step had written 1,616 "dream" memories; not one had ever been read, 945
 * (58 %) were word-for-word repeats, and the rest were sentences like "Goal-seeking behavior appears to be
 * increasing, indicating a need for ongoing monitoring". The model was handed a JSON dump and asked for "learnings";
 * nothing checked that a learning said anything the dump contained. gbrain's dream cycle does the opposite (read
 * 2026-11-11): a cheap triage decides whether there is anything to consolidate, synthesis must quote its source, and
 * a claim whose quote is not in the source is dropped mechanically. This module is that, for this daemon. Pure.
 *
 *   buildEvidence(activity)        the hour's activity as short numbered lines E1…En, written by code
 *   triage(lines, previous)        is there enough, and enough that is new, to be worth a model call?
 *   dreamMessages(lines)           the prompt: lessons must cite E-numbers and quote one cited line exactly
 *   checkLesson(lesson, lines)     keep it only if it cites an outcome line, the quote is in a cited line, it adds no number, and it is about something
 *   anchoredness(text, lines)      share of a lesson's content words that appear in its best-matching evidence line
 */
const STOP = new Set('a an and are as at be been but by can could did do does for from had has have how i if in into is it its may might more most no not of on or our over should so some such than that the their them then there these they this those to under until up very was we were what when where which while who why will with would you your about across after again also any because before being both each few further here just made many much need needs ongoing only other own same seem seems suggest suggests system indicate indicates indicating appear appears appearing'.split(' '));
const words = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 2 && !STOP.has(w));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9.%]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const MAX_LINES = 40, MIN_LINES = 4, MAX_LESSONS = 4;
// words that say how something went; a lesson without one (or a number) only says what something is about
const RESULT = /\b(fail(ed|s|ure|ing)?|timed? ?out|timeouts?|errors?|succe(ed(ed|s)?|ss(ful(ly)?)?)|complet(ed|es)|pass(ed|es)?|scor(ed|es|e|ing)|quality|verdicts?|reject(ed|s)?|approved|dropped|crash(ed|es)?|unable|could not|did not|struggl(ed|es)|ended)\b/i;
const POSITIVE = /\b(succe(ed(ed|s)?|ss(ful(ly)?)?)|well|effective(ly)?|strong(ly)?|approved|passed|high quality|high-quality)\b/i;
const NEGATIVE = /\b(fail(ed|s|ure)?|struggl(ed|es)|unable|poor(ly)?|low quality|could not|did not)\b/i;

/** Turn the gathered activity into short factual lines. Each line says one thing that happened. */
// Two kinds of line. An OUTCOME says what happened and how it went (a scored execution, a run that ended, a verifier
// verdict, an alert). An INTENT says only what was meant to happen (a goal proposed). The first measurement of this
// module (2026-11-12) found lessons that quoted a goal's objective — "Explore outcome and dream memory categories…" —
// and restated it as a finding ("…helps uncover hidden correlations"): the quote was real and nothing was learned.
// So a lesson must cite at least one outcome line.
export function buildEvidence(a = {}) {
  const out = [], seen = new Set();
  const add = (kind, s) => { const t = clip(s, 240); if (t && !seen.has(t)) { seen.add(t); out.push({ kind, text: t }); } };
  const q = x => (x == null || Number.isNaN(+x) ? null : (+x).toFixed(2));
  for (const r of rollups(a.executions || [])) add('outcome', r);
  for (const e of a.executions || []) add('outcome', `${e.agent_id || 'an agent'} ${e.status} goal "${clip(e.objective, 110)}"${q(e.quality) ? ` with quality ${q(e.quality)}` : ''}${e.error ? `; error: ${clip(e.error, 80)}` : e.reply_excerpt ? `; reply began: "${clip(e.reply_excerpt, 90)}"` : ''}`);
  for (const r of a.runs || []) add('outcome', `agent run by ${r.agent || 'an agent'} ended ${r.status}${r.error ? `: ${clip(r.error, 90)}` : ''}`);
  for (const v of a.verifications || []) add('outcome', `verifier loop "${clip(v.goal, 100)}" ${v.status}${v.iterations_used != null ? ` after ${v.iterations_used} iterations` : ''}`);
  for (const d of a.debates || []) add('outcome', `debate "${clip(d.topic, 110)}" verdict ${d.verdict || 'none'}${q(d.confidence) ? ` at confidence ${q(d.confidence)}` : ''}`);
  for (const h of a.alerts || []) add('outcome', `${h.severity || 'info'} alert ${h.rule}: ${clip(h.message, 120)}`);
  for (const w of a.workflows || []) add('outcome', `workflow ${w.workflow_id} ${w.status}${w.duration_ms != null ? ` in ${Math.round(w.duration_ms / 1000)} s` : ''}`);
  for (const c of a.chains || []) add('outcome', `chain "${clip(c.objective, 110)}" ${c.status}${c.stop_reason ? ` (${clip(c.stop_reason, 60)})` : ''}`);
  for (const m of a.routing || []) add('outcome', `model ${m.model_selected} on a ${m.complexity || ''} ${m.task_type || 'task'} ${m.success ? 'succeeded' : 'failed'}`);
  for (const g of a.goals || []) add('intent', `goal proposed: "${clip(g.objective, 140)}"${g.priority ? ` (${g.priority} priority)` : ''}`);
  for (const p of a.perspectiveShifts || []) add('intent', `perspective shifted from ${p.from_perspective} to ${p.to_perspective}${p.reason ? `: ${clip(p.reason, 90)}` : ''}`);
  // bus traffic is mostly the organism talking about itself; only topics that carry an outcome are evidence
  for (const b of (a.bus || []).filter(x => /goals|fleet\.retired|self_audit|capability|research|skills|creation/.test(x.topic || ''))) add('outcome', `bus ${b.topic} from ${b.from_agent}: ${clip(b.payload, 120)}`);
  // outcomes first, so the cap never cuts them for intents
  return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === 'outcome' ? -1 : 1)).slice(0, MAX_LINES).map((l, i) => ({ id: `E${i + 1}`, kind: l.kind, text: l.text }));
}

// A reply that says it found nothing or could not act. The first live grounded dream (2026-11-12) had five of these,
// all scored 0.06–0.27, beside replies that produced something and scored 0.45–0.69 — and the model, given 40 lines,
// wrote four lessons about single executions instead. Patterns across lines are computed here; the model only phrases them.
export const EMPTY_REPLY = /\b(no relevant memor|(could ?n[o']t|did ?n[o']t|unable to) (find|generate|access|complete|locate|retrieve)|nothing (was )?found|no (results|data|memories) (were |was )?found|i am unable|i'm unable)/i;
const fmt = n => n.toFixed(2);
const meanOf = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Deterministic summaries over the hour's executions: per agent, and found-nothing vs produced-something. */
export function rollups(executions) {
  const scored = executions.filter(e => e.quality != null && !Number.isNaN(+e.quality)).map(e => ({ ...e, quality: +e.quality }));
  const out = [];
  const byAgent = new Map();
  for (const e of scored) byAgent.set(e.agent_id, [...(byAgent.get(e.agent_id) || []), e.quality]);
  for (const [agent, qs] of [...byAgent].filter(([, v]) => v.length >= 2).sort((x, y) => y[1].length - x[1].length)) {
    out.push(`${agent} ran ${qs.length} goals this hour, quality ${fmt(Math.min(...qs))} to ${fmt(Math.max(...qs))}, mean ${fmt(meanOf(qs))}`);
  }
  const empty = scored.filter(e => EMPTY_REPLY.test(e.reply_excerpt || '')), rest = scored.filter(e => !EMPTY_REPLY.test(e.reply_excerpt || ''));
  if (empty.length >= 2 && rest.length >= 1) {
    const eq = empty.map(e => e.quality), rq = rest.map(e => e.quality);
    out.push(`${empty.length} of ${scored.length} goals this hour got a reply saying the agent found nothing or could not act; those scored ${fmt(Math.min(...eq))} to ${fmt(Math.max(...eq))}, mean ${fmt(meanOf(eq))}; the other ${rest.length} scored mean ${fmt(meanOf(rq))}`);
  }
  return out;
}

/** Words that stand for this evidence, for telling one hour from the last. */
export const fingerprint = lines => [...new Set(lines.flatMap(l => words(l.text)))].sort();

/**
 * Is there anything worth a model call?
 * @returns {{ go: boolean, reason: string, novelty: number }}
 */
export function triage(lines, previousFingerprint = [], { minLines = MIN_LINES, minNovelty = 0.25 } = {}) {
  if (lines.length < minLines) return { go: false, reason: `only ${lines.length} evidence lines (need ${minLines})`, novelty: 0 };
  const now = fingerprint(lines), prev = new Set(previousFingerprint);
  const novelty = now.length ? +(now.filter(w => !prev.has(w)).length / now.length).toFixed(3) : 0;
  if (prev.size && novelty < minNovelty) return { go: false, reason: `the hour is ${Math.round(100 * (1 - novelty))} % the same as the last dream`, novelty };
  return { go: true, reason: 'enough new evidence', novelty };
}

export function dreamMessages(lines) {
  const system = [
    'You consolidate what happened in an AI system over the last hour into a few lessons it should remember.',
    'You are given numbered EVIDENCE lines. A lesson may only say what the evidence shows.',
    'Reply with JSON only: {"lessons": [{"lesson": "...", "evidence": ["E3", "E7"], "quote": "..."}]}',
    'Rules:',
    `- At most ${MAX_LESSONS} lessons; fewer is better than vague. If the evidence shows nothing worth remembering, reply {"lessons": []}.`,
    '- "lesson" is one specific sentence that names the thing it is about (the goal, the agent, the alert, the model). No advice to "monitor", "consider" or "investigate".',
    '- Each line is marked [outcome] (what happened and how it went) or [intent] (only what was meant to happen). A lesson is about what happened: it must cite at least one [outcome] line. Never state an intent as a result.',
    '- The first lines are summaries computed over the whole hour (per agent, and replies that found nothing). A lesson that explains a pattern across several outcomes is worth more than one about a single goal.',
    '- Say how it went: who did what, and the result the evidence shows (failed, timed out, scored 0.20, passed after 2 iterations). A sentence about what something "can" do is not a lesson.',
    '- "evidence" lists the E-numbers the lesson rests on.',
    '- "quote" is copied EXACTLY from one of those evidence lines: at least four words in a row.',
    '- Use only numbers that appear in the evidence.',
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `EVIDENCE:\n${lines.map(l => `${l.id}. [${l.kind || 'outcome'}] ${l.text}`).join('\n')}` }];
}

/** Share of a text's content words found in its single best-matching evidence line. 1 = everything it says is there. */
export function anchoredness(text, lines) {
  const w = [...new Set(words(text))]; if (!w.length || !lines.length) return 0;
  return +Math.max(...lines.map(l => { const s = new Set(words(l.text)); return w.filter(x => s.has(x)).length / w.length; })).toFixed(3);
}

/**
 * Does a lesson stand on its evidence?
 * @returns {{ ok: true, cited: string[] } | { ok: false, why: 'no_citation'|'unknown_citation'|'no_outcome'|'no_quote'|'quote_not_in_evidence'|'number_not_in_evidence'|'too_vague'|'no_result'|'result_contradicts' }}
 */
export function checkLesson(l, lines, { minAnchored = 0.35 } = {}) {
  const byId = new Map(lines.map(x => [x.id, x.text]));
  const cited = [...new Set((Array.isArray(l?.evidence) ? l.evidence : String(l?.evidence || '').split(/[\s,]+/)).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  if (!cited.length) return { ok: false, why: 'no_citation' };
  if (cited.some(c => !byId.has(c))) return { ok: false, why: 'unknown_citation' };
  const kindOf = new Map(lines.map(x => [x.id, x.kind || 'outcome']));
  if (!cited.some(c => kindOf.get(c) === 'outcome')) return { ok: false, why: 'no_outcome' };
  const quote = norm(l.quote);
  if (quote.split(' ').length < 4) return { ok: false, why: 'no_quote' };
  if (!cited.some(c => norm(byId.get(c)).includes(quote))) return { ok: false, why: 'quote_not_in_evidence' };
  const citedText = cited.map(c => norm(byId.get(c))).join(' ');
  const nums = (norm(l.lesson).match(/\d[\d.%]*/g) || []).map(n => n.replace(/\.$/, ''));
  if (nums.some(n => !citedText.includes(n))) return { ok: false, why: 'number_not_in_evidence' };
  if (anchoredness(l.lesson, cited.map(c => ({ text: byId.get(c) }))) < minAnchored) return { ok: false, why: 'too_vague' };
  // Second measurement: an outcome line also carries the goal's objective, so a quote from that half let the
  // objective through again ("X can be integrated to uncover…"). The lesson must say how it went…
  const said = String(l.lesson || '');
  // (a number alone does not count: names carry digits — "FMP/1", "v1")
  if (!RESULT.test(said)) return { ok: false, why: 'no_result' };
  // …and not the opposite of what the cited outcomes show ("successfully" over a 0.20 score).
  const outcomes = cited.filter(c => kindOf.get(c) === 'outcome').map(c => byId.get(c));
  // the scores the cited outcomes show: each execution's, and a roll-up's mean (its range is not one result)
  const scores = outcomes.flatMap(t => [...t.matchAll(/(?:with quality|mean) (\d\.\d+)/g)].map(m => +m[1]));
  const anyFailed = outcomes.some(t => /\b(failed|error|timed out|timeout|rejected)\b/i.test(t));
  const avg = scores.length ? meanOf(scores) : null;
  // Fourth measurement: "completed its goal successfully" over mixed scores, "with high quality" over 0.25–0.51.
  // A success word needs no failure among the citations and an average of at least 0.5; a failure word needs one of
  // the citations to show a failure or an average under 0.5.
  const good = !anyFailed && avg != null && avg >= 0.5, bad = anyFailed || (avg != null && avg < 0.5);
  if ((POSITIVE.test(said) && !good) || (NEGATIVE.test(said) && !bad)) return { ok: false, why: 'result_contradicts' };
  return { ok: true, cited };
}

/** Is this lesson already known? Word-set Jaccard against existing dreams. */
export function alreadyKnown(text, existing, threshold = 0.7) {
  const a = new Set(words(text)); if (!a.size) return true;
  return existing.some(e => { const b = new Set(words(e)); let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i) >= threshold; });
}

/** What gets stored: the lesson, and what it rests on, so a reader can check it. */
export const storedText = l => `${clip(l.lesson, 300)} [evidence ${l.evidence.join(', ')}: "${clip(l.quote, 140)}"]`;
