/**
 * Distill data — what the models may learn from. Only verified work, in chat format, with a fixed held-out share.
 *
 * Why (2026-11-12): Chandra improves its prompts, memory, tools and strategies, and its model weights never learn. The
 * plan (docs/WEIGHTS-AND-GEMINI-OUTLINE.md) is a small LoRA adapter trained on its own verified work, measured on what
 * it was not trained on. This module decides what counts as verified and writes nothing itself; the service does.
 *
 * Sources, and why each is trusted:
 *   human_up      goal runs Vaughn rated 👍 (his latest vote on the run is positive)
 *   tool_run      goal runs scored ≥ GOOD_QUALITY that made at least one real tool call, not voted down
 *   verified_code verifier loops that passed: proved by execution
 *   film_script   pixel-film scripts the writer produced, rebuilt into the reply shape the writer is asked for and
 *                 accepted by today's checker (normalizeFor) — the checker is code, so it decides, not a score
 * Never: capability-gauge items (the gauge must stay a test of what was not seen); runs whose assistant text narrates a
 * tool call instead of making one (the fleet's known fault — training on it would teach it); records holding anything
 * shaped like a secret.
 *
 *   isHeldOut(source, id)      fixed 20 % by hash, never trained on
 *   secretIn(text)             the first secret-shaped match, or null
 *   narrates(text)             a written-out tool call or tool result in assistant text
 *   createDistiller({db, creationsDir, normalizeFor, scriptMessagesFor})  → { collect() }
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const HOLDOUT_SHARE = 0.2, GOOD_QUALITY = 0.6, MAX_MESSAGE_CHARS = 6000, MAX_RECORD_CHARS = 24_000;

export function isHeldOut(source, id, share = HOLDOUT_SHARE) {
  const h = createHash('sha1').update(`${source}:${id}`).digest();
  return h.readUInt32BE(0) / 0x100000000 < share;
}

const SECRET = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._-]{24,}/,
  /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9._\/+-]{12,}/i,
];
export function secretIn(text) {
  const s = String(text ?? '');
  for (const re of SECRET) { const m = s.match(re); if (m) return m[0].slice(0, 12) + '…'; }
  return null;
}

// "} The tool returned: {...}", "Tool Response:", or a call written out as {"name": "x", "parameters": {...}}
export const narrates = text => /\bthe tool returned\b|\btool (response|output|result)\s*:|"name"\s*:\s*"[\w.:-]+"\s*,\s*"(parameters|arguments)"\s*:/i.test(String(text ?? ''));

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n)} …[cut]` : String(s ?? ''));
const parseCalls = raw => { try { const v = JSON.parse(raw || 'null'); return Array.isArray(v) ? v : null; } catch { return null; } };

/** A stored run's messages → chat messages a trainer understands (assistant tool_calls, tool results). */
export function runToChat(agentId, rows) {
  const out = [{ role: 'system', content: `You are ${agentId}, an agent of Chandra-FRAYMUS. When a task needs a tool, call it; never describe a call you did not make.` }];
  for (const m of rows) {
    if (m.role === 'user') out.push({ role: 'user', content: clip(m.content, MAX_MESSAGE_CHARS) });
    else if (m.role === 'assistant') {
      const calls = parseCalls(m.tool_calls);
      const msg = { role: 'assistant', content: clip(m.content || '', MAX_MESSAGE_CHARS) };
      if (calls?.length) msg.tool_calls = calls.map(c => ({ type: 'function', function: { name: c.function?.name || c.name, arguments: typeof c.function?.arguments === 'string' ? safeJson(c.function.arguments) : (c.function?.arguments ?? c.arguments ?? {}) } }));
      out.push(msg);
    } else if (m.role === 'tool') out.push({ role: 'tool', name: m.name || undefined, content: clip(m.content, MAX_MESSAGE_CHARS) });
    // system rows inside a run are harness notes ("[harness] …"); a run that has them is excluded before this point
  }
  return out;
}
/** Did a stored tool result report a failure? (`{"result": {"error": …}}`, `{"error": …}`, `"ok": false`, a refusal) */
export function toolFailed(content) {
  const v = safeJson(String(content ?? ''));
  const r = v && typeof v === 'object' ? (v.result && typeof v.result === 'object' ? v.result : v) : null;
  if (r && (r.error || r.ok === false || r.refused || r.denied)) return true;
  return /^\s*(error|refused|denied)\b/i.test(String(content ?? ''));
}
const safeJson = s => { try { return JSON.parse(s); } catch { return { raw: s }; } };

/** Why a chat may not be trained on, or null. */
export function rejectChat(chat) {
  const text = JSON.stringify(chat);
  if (text.length > MAX_RECORD_CHARS) return 'too_long';
  if (!chat.some(m => m.role === 'user')) return 'no_task';
  const last = chat.at(-1);
  if (last.role !== 'assistant' || !String(last.content).trim()) return 'no_final_answer';
  if (chat.some(m => m.role === 'assistant' && narrates(m.content))) return 'narrated_tool_call';
  // scan each message's own text: inside JSON.stringify a quote becomes \" and `api_key = "…"` slipped past (test)
  if (chat.some(m => secretIn(m.content) || (m.tool_calls && secretIn(m.tool_calls.map(c => JSON.stringify(c.function?.arguments ?? '')).join(' '))))) return 'secret_shaped';
  return null;
}

/** Rebuild the writer's reply shape for a pixel film from its lineage; null when the lineage cannot say. */
export function pixelReply(script) {
  if (!script?.scenes?.length || !Array.isArray(script.cast) || script.cast.length < 2) return null;
  const places = Array.isArray(script.places) ? script.places : [];
  return {
    title: script.title,
    cast: script.cast.map(c => ({ name: c.name, look: c.look })),
    scenes: script.scenes.map(s => ({ speaker: s.speaker, place: typeof s.place === 'number' ? places[s.place] || places[0] || '' : s.place || '', say: s.say })),
  };
}

export function createDistiller({ db, creationsDir, normalizeFor, scriptMessagesFor }) {
  const excluded = {};
  const skip = (source, why) => { excluded[source] = excluded[source] || {}; excluded[source][why] = (excluded[source][why] || 0) + 1; };
  const records = [];
  const add = (source, id, messages, meta = {}) => records.push({ source, id, heldOut: isHeldOut(source, id), messages, meta });

  function runRecords(source, rows) {
    for (const e of rows) {
      const own = db.prepare(`SELECT role, content, tool_calls, name, created_at FROM messages WHERE run_id = ? ORDER BY created_at, rowid`).all(e.run_id);
      if (!own.length) { skip(source, 'no_messages'); continue; }
      // the task is stored on the thread with no run id (first live export: every run read as `no_task`):
      // take the thread's last user message written before the run's first message
      const task = own.some(m => m.role === 'user') ? null : db.prepare(
        `SELECT role, content, tool_calls, name FROM messages WHERE thread_id = ? AND role = 'user' AND run_id IS NULL AND created_at <= ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
      ).get(e.thread_id, own[0].created_at);
      const msgs = task ? [task, ...own] : own;
      if (msgs.some(m => m.role === 'system' && /\[harness\]/.test(m.content || ''))) { skip(source, 'harness_nudged'); continue; }
      // a machine-scored run teaches its calls as the right first move; one whose call failed (first live export: wrong
      // arguments → "missing required field(s)", scored 0.6 anyway) would teach the mistake. A 👍 run stays: Vaughn judged all of it.
      if (source === 'tool_run' && msgs.some(m => m.role === 'tool' && toolFailed(m.content))) { skip(source, 'tool_call_failed'); continue; }
      const chat = runToChat(e.agent_id, msgs);
      const why = rejectChat(chat);
      if (why) { skip(source, why); continue; }
      add(source, e.id, chat, { agent: e.agent_id, quality: e.quality });
    }
  }

  function collect() {
    // latest vote per execution decides; a run voted down is never used by any source
    const votes = new Map(db.prepare(`SELECT exec_id, rating FROM outcome_feedback ORDER BY created_at`).all().map(v => [v.exec_id, v.rating]));
    const ups = db.prepare(`SELECT id, run_id, thread_id, agent_id, quality FROM goal_executions WHERE run_id IS NOT NULL`).all().filter(e => votes.get(e.id) > 0);
    runRecords('human_up', ups);
    const upIds = new Set(ups.map(e => e.id));
    const toolRuns = db.prepare(
      `SELECT e.id, e.run_id, e.thread_id, e.agent_id, e.quality FROM goal_executions e
       WHERE e.quality >= ? AND e.run_id IS NOT NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.run_id = e.run_id AND m.role = 'tool')`
    ).all(GOOD_QUALITY).filter(e => !upIds.has(e.id) && !(votes.get(e.id) < 0));
    runRecords('tool_run', toolRuns);

    for (const v of db.prepare(`SELECT id, goal, language, final_code FROM verification_loops WHERE status = 'passed' AND final_code IS NOT NULL`).all()) {
      const chat = [
        { role: 'system', content: 'You write a self-proving program: plain code, standard library only; every check prints PASS or FAIL; the last line is ALL PASS.' },
        { role: 'user', content: clip(v.goal, MAX_MESSAGE_CHARS) },
        { role: 'assistant', content: `\`\`\`${v.language === 'python' ? 'python' : 'js'}\n${clip(v.final_code, MAX_MESSAGE_CHARS)}\n\`\`\`` },
      ];
      const why = rejectChat(chat);
      if (why) skip('verified_code', why); else add('verified_code', v.id, chat, { language: v.language });
    }

    if (creationsDir && existsSync(creationsDir)) {
      for (const dir of readdirSync(creationsDir).filter(d => d.startsWith('make-'))) {
        const f = join(creationsDir, dir, 'lineage.json');
        if (!existsSync(f)) { skip('film_script', 'no_lineage'); continue; }
        let l; try { l = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { skip('film_script', 'bad_lineage'); continue; }
        const plan = l.plan;
        if (!plan || !['8bit', '2bit'].includes(plan.style)) { skip('film_script', `look_${plan?.style || 'unknown'}_not_rebuilt`); continue; }
        const reply = pixelReply({ ...l.script, cast: l.script?.cast || l.cast });
        if (!reply) { skip('film_script', 'no_cast_in_lineage'); continue; }
        // strict, as on a first attempt: what we teach is a script that passes without a second try
        const check = normalizeFor(JSON.stringify(reply), plan, { final: false });
        if (!check?.ok) { skip('film_script', 'refused_by_todays_checker'); continue; }
        const chat = [...scriptMessagesFor(plan, null), { role: 'assistant', content: JSON.stringify(reply) }];
        const why = rejectChat(chat);
        if (why) skip('film_script', why); else add('film_script', l.job || dir, chat, { style: plan.style, seconds: plan.seconds, attempts: l.script?.attempts ?? null });
      }
    }
    const bySource = {};
    for (const r of records) { const b = (bySource[r.source] = bySource[r.source] || { train: 0, heldOut: 0 }); b[r.heldOut ? 'heldOut' : 'train']++; }
    return { records, bySource, excluded };
  }
  return { collect };
}
