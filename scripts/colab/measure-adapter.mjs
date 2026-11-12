// Measures a trained adapter against its base, paired, on what it was NOT trained on. Decides adoption; nothing else does.
//
//   node scripts/colab/measure-adapter.mjs --base qwen3:14b --candidate qwen3-chandra:14b [--heldout <heldout.jsonl>] [--films 12]
//
// Two mechanical tests, each item answered by both models with the same prompt (temperature 0.2):
//   tools   every held-out run that made a tool call: the model gets the run's system line and task, and is offered the
//           tools that run called (schema from the arguments it used) plus distractors from other runs. Pass = the first
//           reply is a structured call to an offered tool; narrating a call or answering without one fails.
//   films   pixel-film requests (the held-out ones plus a fixed list): the writer prompt the app uses; pass = today's
//           checker accepts the reply on the first attempt (normalizeFor, final: false).
// Then: paired wins / losses and a sign-flip p per test. Adopt only if a test improves and none gets worse; the capability
// gauge on the same seeds is the third check (forgetting) and is run separately — see docs/WEIGHTS-AND-GEMINI-OUTLINE.md.
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { planCreation, PACES } from '../../server/media/make-plan.js';
import { scriptMessagesFor, normalizeFor } from '../../server/media/make-looks.js';
import { signFlipP } from '../../server/intelligence/memory-rank.js';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OLLAMA = process.env.CHANDRA_HOME_OLLAMA || 'http://100.99.98.101:11434';
const BASE = flag('--base', 'qwen3:14b'), CAND = flag('--candidate', 'qwen3-chandra:14b');
const FILMS = Math.min(40, Math.max(0, parseInt(flag('--films', '12'), 10) || 0));
const DISTILL = 'data/distill';
const heldPath = flag('--heldout', (() => { const d = existsSync(DISTILL) ? readdirSync(DISTILL).filter(x => existsSync(join(DISTILL, x, 'heldout.jsonl'))).sort().pop() : null; return d ? join(DISTILL, d, 'heldout.jsonl') : null; })());
if (!heldPath) { console.error('no heldout.jsonl: run POST /api/intelligence/distill/export first'); process.exit(2); }
const held = readFileSync(heldPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

async function chat(model, messages, tools) {
  const r = await fetch(`${OLLAMA}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({ model, messages, tools, stream: false, think: false, keep_alive: '10m', options: { temperature: 0.2, num_predict: 1600 } }) });
  if (!r.ok) throw new Error(`${model}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).message || {};
}
const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'string' : typeof v === 'object' ? 'object' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string');
const schemaFrom = call => ({ type: 'function', function: { name: call.name, description: `Chandra tool ${call.name}`, parameters: { type: 'object', properties: Object.fromEntries(Object.entries(call.arguments || {}).map(([k, v]) => [k, { type: typeOf(v) }])), required: [] } } });

// ── tools ──
const calledIn = rec => rec.messages.flatMap(m => (m.tool_calls || []).map(c => ({ name: c.function.name, arguments: c.function.arguments })));
const toolItems = held.filter(r => calledIn(r).length);
const allCalls = held.flatMap(calledIn);
const toolResults = [];
for (const rec of toolItems) {
  const own = calledIn(rec), names = new Set(own.map(c => c.name));
  const distract = [...new Map(allCalls.filter(c => !names.has(c.name)).map(c => [c.name, c])).values()].slice(0, 4);
  const tools = [...new Map([...own, ...distract].map(c => [c.name, schemaFrom(c)])).values()];
  const prompt = rec.messages.slice(0, rec.messages.findIndex(m => m.role === 'user') + 1);
  const row = { id: rec.id, offered: tools.map(t => t.function.name) };
  for (const [k, model] of [['base', BASE], ['cand', CAND]]) {
    const m = await chat(model, prompt, tools);
    const call = m.tool_calls?.[0]?.function?.name;
    row[k] = call && row.offered.includes(call) ? 1 : 0;
    row[`${k}Said`] = call ? `call ${call}` : String(m.content || '').replace(/\s+/g, ' ').slice(0, 100);
  }
  toolResults.push(row); console.log(`tools ${row.id}: base ${row.base} (${row.baseSaid}) | candidate ${row.cand} (${row.candSaid})`);
}

// ── films ──
const REQUESTS = [
  'a 25 second 8-bit short about a fox who finds a lantern in a snowy forest', 'a 20 second 2-bit short where a lighthouse keeper and her cat watch a storm',
  'a 30 second 8-bit short about two robots fixing a broken windmill', 'a 25 second 8-bit short where a baker and a mouse share the last loaf',
  'a 20 second 2-bit short about an astronaut who hears music on the moon', 'a 30 second 8-bit short where a girl and her dog chase a kite at the beach',
  'a 25 second 8-bit short about a wizard who forgets a spell', 'a 20 second 8-bit short where a knight meets a shy dragon',
  'a 30 second 2-bit short about a fisherman and a talking fish', 'a 25 second 8-bit short where a grandpa teaches a boy to fly a plane',
  'a 20 second 8-bit short about a ghost who is afraid of the dark', 'a 30 second 8-bit short where two friends find a map in the attic',
];
const filmHeld = held.filter(r => r.source === 'film_script').map(r => (r.messages.find(m => m.role === 'user')?.content || '').replace(/^Request:\s*/, '').split('\n')[0]).filter(Boolean);
const filmReqs = [...filmHeld, ...REQUESTS].slice(0, FILMS);
const filmResults = [];
for (const req of filmReqs) {
  const plan = { ...planCreation(req), pace: PACES.voicestudio };
  if (!['8bit', '2bit'].includes(plan.style)) continue;
  const row = { request: req };
  for (const [k, model] of [['base', BASE], ['cand', CAND]]) {
    const m = await chat(model, scriptMessagesFor(plan, null));
    const s = normalizeFor(m.content || '', plan, { final: false });
    row[k] = s.ok ? 1 : 0; row[`${k}Why`] = s.ok ? 'accepted' : s.reason;
  }
  filmResults.push(row); console.log(`films "${req.slice(0, 50)}": base ${row.base} (${row.baseWhy.slice(0, 60)}) | candidate ${row.cand} (${row.candWhy.slice(0, 60)})`);
}

const sum = (rows, name) => {
  const a = rows.map(r => r.cand), b = rows.map(r => r.base);
  const s = { test: name, n: rows.length, base: b.reduce((x, y) => x + y, 0), candidate: a.reduce((x, y) => x + y, 0), gained: a.filter((v, i) => v && !b[i]).length, lost: a.filter((v, i) => !v && b[i]).length, p: rows.length ? signFlipP(a, b, { rounds: 20000 }) : null };
  console.log(`${name.padEnd(6)} n ${s.n}  base ${s.base}/${s.n}  candidate ${s.candidate}/${s.n}  gained ${s.gained} lost ${s.lost}  p ${s.p}`);
  return s;
};
console.log(`\n${BASE} (base) vs ${CAND} (candidate), held-out ${heldPath}`);
const totals = [sum(toolResults, 'tools'), sum(filmResults, 'films')];
const better = totals.some(t => t.gained > t.lost), worse = totals.some(t => t.lost > t.gained);
const verdict = worse ? 'do not adopt: a test got worse' : better ? 'candidate leads on this sample; confirm with the capability gauge (forgetting) before adopting' : 'no difference on this sample';
console.log(`verdict: ${verdict}`);
const outDir = join('data', 'distill', 'measurements'); mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${CAND.replace(/[:/]/g, '_')}.json`);
writeFileSync(out, JSON.stringify({ base: BASE, candidate: CAND, heldout: heldPath, totals, verdict, toolResults, filmResults }, null, 2));
console.log('saved', out);
