/**
 * Make chains: several creation steps run in order, each handed what the one before it made.
 *
 * Absorbed from the Skills Foundry in Vaughn's AI Studio app "Nexus Engine" (docs/NEXUS-ENGINE-CREATION-METHODS.md,
 * method 24): every step receives a running summary (the newest text a step wrote) and the newest file (a picture,
 * clip, page or recording), so "story → keyframe → film" runs as one job instead of three hand-offs. Nexus Engine
 * did this with paid Gemini calls and no check between steps; here every step is one of Chandra's own makers
 * (pool model, Looks, Make, Vaughn's voice) and a step that ignores what came before it fails the run.
 *
 * This file is pure plus a factory: the step implementations are passed in (`adapters`), so tests run the whole
 * runner with fakes and the service (make-chains-service.js) wires the real makers.
 *
 * Templates: {{input}} {{previous_summary}} {{previous_file}} {{step_N}} (summary of step N) {{step_N_file}}.
 */
import { randomUUID } from 'node:crypto';

const clip = (s, n) => String(s ?? '').slice(0, n);
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch (e) { console.error('[make-chains] bad JSON in a row:', e.message); return d; } };

/**
 * Every kind of step. `needs` = the kind of file it must be handed; `gives` = what it adds to the chain.
 * `fields` = which step fields are templates (rendered before the step runs).
 */
export const STEP_KINDS = {
  write:   { needs: null,    gives: 'text',  fields: ['prompt'],  required: ['prompt'],         about: 'the pool model writes text (a story, beats, a script, a description) — this becomes the running summary' },
  paint:   { needs: null,    gives: 'image', fields: ['prompt'],  required: ['prompt'],         about: 'paint a new picture in a style recipe (looks.generate)' },
  restyle: { needs: 'image', gives: 'image', fields: [],          required: ['look'],           about: 'turn the newest picture into a look (woodblock, comic hybrid, 8-bit, ASCII…)' },
  move:    { needs: 'image', gives: 'video', fields: [],          required: [],                 about: 'a camera move over the newest picture (push-in, orbit, ken-burns…)' },
  motion:  { needs: 'image', gives: 'video', fields: ['prompt'],  required: ['prompt'],         about: 'bring the newest picture to life with Wan 2.2 on fraymus-home' },
  avatar:  { needs: 'image', gives: 'video', fields: [],          required: [],                 about: 'a 3-D model of the character in the newest picture, filmed turning' },
  game:    { needs: null,    gives: 'page',  fields: ['prompt'],  required: [],                 about: 'a winnable platform game page from words (`prompt`) or, with `fromPicture: true`, from the newest picture (its subject becomes the hero)' },
  world:   { needs: null,    gives: 'page',  fields: ['prompt'],  required: [],                 about: 'a walkable 3-D world page from words (`prompt`) or, with `fromPicture: true`, from the newest picture' },
  vector:  { needs: 'image', gives: 'image', fields: [],          required: [],                 about: 'trace the newest picture into vector art (style: ink, cutout, comic, neon); passes on its PNG, the SVG is beside it' },
  layers:  { needs: 'image', gives: 'image', fields: ['context'], required: [],                 about: 'split the newest picture into its subject (transparent cutout) and the background with the subject removed; `keep` (subject | plate, default plate) says which is passed on' },
  make:    { needs: null,    gives: 'any',   fields: ['prompt'],  required: ['prompt'],         about: 'Make from a sentence: a film in any wired look, a still, comic pages or a web page' },
  voice:   { needs: null,    gives: 'audio', fields: ['text'],    required: [],                 about: "say the text (default: the running summary) in Vaughn's voice" },
  rig:     { needs: 'image', gives: 'video', fields: [],          required: [],                 about: 'a camera rig with depth over the newest picture (rig: bullet-time, fpv-dive, crane-up): its subject is cut out and moved apart from the background' },
  extend:  { needs: 'video', gives: 'video', fields: ['prompt'],  required: ['prompt'],         about: 'continue the newest clip from its last frame with Wan 2.2 (what happens next); kept only if the join reads as a continuation' },
  episode: { needs: null,    gives: 'video', fields: ['prompt'],  required: [],                 about: 'a multi-act flat (or stick) episode from a premise (`prompt`, default the running summary); `acts` 3–8, `secondsPerAct`' },
};
export const STEP_KIND_NAMES = Object.keys(STEP_KINDS);
/** What a make step produces, by its "as" field (Make's own kinds). */
export const MAKE_AS = { page: 'page', still: 'image', video: 'video' };
export const MAX_STEPS = 8;
const VARS = /\{\{\s*(input|previous_summary|previous_file|step_(\d+)(_file)?)\s*\}\}/g;

/** Fill a template from the chain so far. Unknown or not-yet-made values are reported, never left as braces. */
export function renderTemplate(tpl, ctx) {
  const missing = [];
  const text = String(tpl ?? '').replace(VARS, (_m, name, n, isFile) => {
    let v;
    if (name === 'input') v = ctx.input;
    else if (name === 'previous_summary') v = ctx.previousSummary;
    else if (name === 'previous_file') v = ctx.previousFile?.file;
    else { const s = ctx.steps?.[Number(n) - 1]; v = isFile ? s?.file?.file : s?.summary; }
    if (v === undefined || v === null || v === '') { missing.push(name); return ''; }
    return String(v);
  });
  return { text: text.replace(/[ \t]+\n/g, '\n').trim(), missing };
}

/** Step numbers a template refers to ({{step_N}} / {{step_N_file}}). */
const stepRefs = tpl => [...String(tpl ?? '').matchAll(VARS)].filter(m => m[2]).map(m => Number(m[2]));
const refersBack = tpl => /\{\{\s*(previous_summary|previous_file|step_\d+(_file)?)\s*\}\}/.test(String(tpl ?? ''));

/**
 * Check a chain before it runs: known kinds, required fields, at most MAX_STEPS, no reference to a step that has not
 * run yet, and every step that needs a picture has one made earlier (or given as the chain's input picture).
 */
export function validateChain(def, { inputFile = null, inputMayBeGiven = false } = {}) {
  const errors = [];
  const steps = Array.isArray(def?.steps) ? def.steps : [];
  if (!steps.length) errors.push('a chain needs at least one step');
  if (steps.length > MAX_STEPS) errors.push(`at most ${MAX_STEPS} steps (got ${steps.length})`);
  let have = inputFile ? inputFile.kind : null;
  steps.slice(0, MAX_STEPS).forEach((s, i) => {
    const at = `step ${i + 1}`;
    const k = STEP_KINDS[s?.kind];
    if (!k) { errors.push(`${at}: unknown kind "${s?.kind}" (kinds: ${STEP_KIND_NAMES.join(', ')})`); return; }
    for (const f of k.required) if (!String(s[f] ?? '').trim()) errors.push(`${at} (${s.kind}): "${f}" is required`);
    for (const f of k.fields) for (const n of stepRefs(s[f])) if (n < 1 || n > i) errors.push(`${at}: {{step_${n}}} refers to a step that has not run yet`);
    if (s.kind === 'make' && s.as && !MAKE_AS[s.as]) errors.push(`${at} (make): "as" must be one of ${Object.keys(MAKE_AS).join(', ')}`);
    const excused = inputMayBeGiven && have === null;        // a saved chain may start from a picture given at run time
    if (k.needs && have !== k.needs && !excused) errors.push(`${at} (${s.kind}) needs a ${k.needs}, and ${have ? `the newest file before it is a ${have}` : 'nothing before it makes one'}`);
    if (k.gives === 'image' || k.gives === 'video' || k.gives === 'audio') have = k.gives;
    else if (k.gives === 'any') have = MAKE_AS[s.as] || 'unknown';  // a make step says what it makes ("as"), if a later step needs it
  });
  return { ok: errors.length === 0, errors };
}

const STOP = new Set('a an the and or but of to in on at for with from by as is are was were be been it its this that these those he she they we you i his her their our your my not no so if then than into about over under up down out after before while when where which who what how all any each some more most very can will just also there here them him me us do does did have has had one two'.split(' '));
export const contentWords = text => new Set(String(text || '').toLowerCase().match(/[a-z][a-z'-]{2,}/g)?.filter(w => !STOP.has(w)) || []);

/**
 * Did a written step build on what came before? It must share at least `min` content words with the running summary
 * it was handed (or a fifth of that summary's words when it is short). Only asked of steps whose prompt refers back.
 */
export function buildsOn(previous, text, min = 3) {
  const a = contentWords(previous), b = contentWords(text);
  if (!a.size) return { ok: true, shared: [] };
  const shared = [...a].filter(w => b.has(w));
  const need = Math.min(min, Math.max(1, Math.ceil(a.size / 5)));
  return { ok: shared.length >= need, shared: shared.slice(0, 12), need };
}

/** What a voice says: the text without stage directions ("PICTURE: …", "SFX: …" up to the line end) — the first live run read one aloud. */
export const spokenText = text => clip(String(text || '').replace(/\b[A-Z][A-Z ]{1,20}:\s[^\n]*/g, ' ').replace(/\s+/g, ' ').trim(), 900);

/** The built-in chains: offline counterparts of Nexus Engine's three default chains, plus one for pictures. */
export const BUILTIN_CHAINS = [
  {
    id: 'story-to-short', name: 'Story → flat story short',
    description: 'Write a short story from your idea, then make it into a narrated flat-vector film with the recurring cast.',
    steps: [
      { kind: 'write', label: 'Write the story', prompt: 'Write a short, original story (5 to 7 sentences) for a narrated animated short about: {{input}}\nOne clear character, one problem, one turn, an ending. Plain prose, no title, no lists.' },
      { kind: 'make', label: 'Make the film', prompt: 'a 40 second flat story short: {{previous_summary}}', style: 'flat', as: 'video' },
    ],
  },
  {
    id: 'topic-to-explainer-pack', name: 'Topic → storyboard → art + camera + voice',
    description: "Plan an explainer opening, paint its hero picture, give it a camera move, and record the opening line in Vaughn's voice.",
    steps: [
      { kind: 'write', label: 'Plan the opening', prompt: 'You are planning the opening of a short explainer about: {{input}}\nWrite two sentences of narration a curious viewer would want to hear first, then one line that starts "PICTURE:" describing a single striking image for it. Only facts you are sure of.' },
      { kind: 'paint', label: 'Paint the hero picture', prompt: 'flat vector illustration, {{previous_summary}}', look: 'flat' },
      { kind: 'move', label: 'Camera move', move: 'push-in', seconds: 6 },
      { kind: 'voice', label: 'Record the opening', text: '{{step_1}}' },
    ],
  },
  {
    id: 'picture-to-motion', name: 'Picture → look → motion',
    description: 'Paint a picture from your words, restyle it, then bring it to life on fraymus-home.',
    steps: [
      { kind: 'paint', label: 'Paint', prompt: '{{input}}', look: 'pastoral-anime' },
      { kind: 'restyle', label: 'Restyle', look: 'comic-hybrid' },
      { kind: 'motion', label: 'Bring it to life', prompt: 'gentle natural movement of what is in the picture: {{input}}', seconds: 3 },
    ],
  },
  {
    id: 'story-to-game-page', name: 'Story → playable page',
    description: 'Write a tiny game concept from your idea, then build it as a single-page browser game that must run in a real browser.',
    steps: [
      { kind: 'write', label: 'Design the game', prompt: 'Design a tiny browser game (playable in one minute, keyboard or mouse) based on: {{input}}\nIn 4 to 6 sentences: the goal, the controls, what the player sees, how you win or lose. No code.' },
      { kind: 'make', label: 'Build the page', prompt: 'a single-page browser game: {{previous_summary}}', as: 'page' },
    ],
  },
];

/**
 * The runner. `adapters[kind](step, rendered, ctx, report)` does one step and resolves to
 * `{ summary?, file?: { file, kind: 'image'|'video'|'page'|'audio'|'still' }, detail? }`.
 */
export function createChainRunner({ db, adapters, clock = () => Date.now(), emit = () => {}, writeRetries = 1 }) {
  db.exec(`CREATE TABLE IF NOT EXISTS make_chains (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, steps TEXT NOT NULL, created_by TEXT, created_at INTEGER, updated_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS make_chain_runs (
    id TEXT PRIMARY KEY, chain_id TEXT, name TEXT, input TEXT, input_file TEXT, status TEXT NOT NULL, current_step INTEGER DEFAULT 0,
    steps TEXT, results TEXT, error TEXT, source TEXT, agent_id TEXT, created_at INTEGER, started_at INTEGER, completed_at INTEGER)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_make_chain_runs_created ON make_chain_runs(created_at)`);

  let tail = Promise.resolve();
  const builtin = new Map(BUILTIN_CHAINS.map(c => [c.id, c]));
  const setRun = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE make_chain_runs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => fields[k]), id);
  };
  const runOut = r => r && ({ id: r.id, chainId: r.chain_id, name: r.name, input: r.input, inputFile: parse(r.input_file, null), status: r.status, currentStep: r.current_step,
    steps: parse(r.steps, []), results: parse(r.results, []), error: r.error, source: r.source, agentId: r.agent_id,
    createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at, seconds: r.completed_at && r.started_at ? +((r.completed_at - r.started_at) / 1000).toFixed(1) : null });

  function getChain(id) {
    if (builtin.has(id)) return { ...builtin.get(id), builtin: true };
    const r = db.prepare(`SELECT * FROM make_chains WHERE id = ?`).get(String(id));
    return r ? { id: r.id, name: r.name, description: r.description, steps: parse(r.steps, []), createdBy: r.created_by, updatedAt: r.updated_at, builtin: false } : null;
  }
  function listChains() {
    const own = db.prepare(`SELECT * FROM make_chains ORDER BY updated_at DESC LIMIT 100`).all()
      .map(r => ({ id: r.id, name: r.name, description: r.description, steps: parse(r.steps, []), createdBy: r.created_by, updatedAt: r.updated_at, builtin: false }));
    return [...BUILTIN_CHAINS.map(c => ({ ...c, builtin: true })), ...own];
  }
  function saveChain({ id, name, description = '', steps, createdBy = 'operator' }) {
    const nm = clip(name, 80).trim();
    if (!nm) throw Object.assign(new Error('a chain needs a name'), { status: 400 });
    if (id && builtin.has(id)) throw Object.assign(new Error('built-in chains cannot be changed; save it under a new name'), { status: 400 });
    const v = validateChain({ steps }, { inputMayBeGiven: true });
    if (!v.ok) throw Object.assign(new Error(`chain not saved: ${v.errors.join('; ')}`), { status: 422, errors: v.errors });
    const cid = id && /^[\w-]{3,60}$/.test(id) ? id : `chain-${randomUUID().slice(0, 8)}`;
    const t = clock();
    db.prepare(`INSERT INTO make_chains (id, name, description, steps, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, steps = excluded.steps, updated_at = excluded.updated_at`)
      .run(cid, nm, clip(description, 400), JSON.stringify(steps.slice(0, MAX_STEPS)), clip(createdBy, 60), t, t);
    return getChain(cid);
  }
  function deleteChain(id) {
    if (builtin.has(id)) return { deleted: false, reason: 'built-in chains cannot be deleted' };
    return { deleted: db.prepare(`DELETE FROM make_chains WHERE id = ?`).run(String(id)).changes > 0 };
  }

  async function runSteps(id) {
    const row = db.prepare(`SELECT * FROM make_chain_runs WHERE id = ?`).get(id);
    if (!row || row.status !== 'queued') return;
    const steps = parse(row.steps, []);
    const ctx = { input: row.input, previousSummary: row.input, previousFile: parse(row.input_file, null), steps: [], source: row.source, agentId: row.agent_id, runId: id };
    const results = [];
    setRun(id, { status: 'running', started_at: clock() });
    emit({ action: 'chain_started', id, name: row.name, steps: steps.length });
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i], kind = STEP_KINDS[step.kind];
        const t0 = clock();
        const result = { n: i + 1, kind: step.kind, label: step.label || step.kind, status: 'running', startedAt: t0, handed: { summary: clip(ctx.previousSummary, 300), file: ctx.previousFile } };
        results.push(result);
        setRun(id, { current_step: i + 1, results: JSON.stringify(results) });
        const rendered = {};
        for (const f of kind.fields) {
          const r = renderTemplate(step[f] ?? (f === 'text' ? '{{previous_summary}}' : ''), ctx);
          if (r.missing.length) throw new Error(`step ${i + 1}: nothing to put in ${r.missing.map(m => `{{${m}}}`).join(', ')}`);
          rendered[f] = r.text;
        }
        if (kind.needs && ctx.previousFile?.kind !== kind.needs) throw new Error(`step ${i + 1} (${step.kind}) needs a ${kind.needs} and the newest file is ${ctx.previousFile ? `a ${ctx.previousFile.kind}` : 'missing'}`);
        const report = stage => { result.stage = clip(stage, 160); setRun(id, { results: JSON.stringify(results) }); };
        let out, attempt = 0, feedback = null;
        for (;;) {
          out = await adapters[step.kind](step, { ...rendered, feedback }, ctx, report) || {};
          // the gate: a written step that was told to build on the running summary must visibly do so
          if (step.kind !== 'write' || !refersBack(step.prompt) || !out.summary) break;
          const handed = ctx.previousSummary;
          const check = buildsOn(handed, out.summary);
          result.continuity = check;
          if (check.ok) break;
          if (attempt++ >= writeRetries) throw new Error(`step ${i + 1} did not build on what it was handed (shares ${check.shared.length} of the ${check.need} words it needed)`);
          feedback = `Your last answer ignored the material you were given. Use its people, places and events; it shared only ${check.shared.length} words with it.`;
          report('rewriting: the first answer ignored the earlier step');
        }
        if (!out.summary && !out.file) throw new Error(`step ${i + 1} (${step.kind}) finished without text or a file`);
        if (out.summary) ctx.previousSummary = clip(out.summary, 4000);
        if (out.file) ctx.previousFile = out.file;
        ctx.steps.push({ summary: out.summary || null, file: out.file || null });
        Object.assign(result, { status: 'done', summary: out.summary ? clip(out.summary, 2000) : null, file: out.file || null, detail: out.detail || null, seconds: +((clock() - t0) / 1000).toFixed(1), stage: 'done' });
        setRun(id, { results: JSON.stringify(results) });
        emit({ action: 'chain_step_done', id, n: i + 1, kind: step.kind, file: out.file?.file || null });
      }
      setRun(id, { status: 'completed', completed_at: clock(), results: JSON.stringify(results), error: null });
      emit({ action: 'chain_completed', id, name: row.name, files: results.filter(r => r.file).map(r => r.file.file) });
    } catch (e) {
      const last = results[results.length - 1];
      if (last && last.status === 'running') Object.assign(last, { status: 'error', error: clip(e.message, 500) });
      setRun(id, { status: 'error', error: clip(e.message, 600), completed_at: clock(), results: JSON.stringify(results) });
      emit({ action: 'chain_failed', id, error: clip(e.message, 200) });
    }
  }

  /** Queue a run. Returns at once with the run id; the steps run one chain at a time. */
  function startRun({ chainId, steps, name, input = '', inputFile = null, source = 'api', agentId = null }) {
    const chain = chainId ? getChain(chainId) : { id: null, name: clip(name, 80) || 'Ad-hoc chain', steps };
    if (!chain) throw Object.assign(new Error(`no chain named ${chainId}`), { status: 404 });
    const text = clip(input, 2000).trim();
    const firstNeedsInput = chain.steps.some(s => STEP_KINDS[s.kind]?.fields.some(f => /\{\{\s*input\s*\}\}/.test(String(s[f] ?? ''))));
    if (firstNeedsInput && !text) throw Object.assign(new Error('this chain starts from your words: give an input'), { status: 400 });
    const v = validateChain(chain, { inputFile });
    if (!v.ok) throw Object.assign(new Error(`chain cannot run: ${v.errors.join('; ')}`), { status: 422, errors: v.errors });
    const id = `chainrun-${randomUUID().slice(0, 10)}`;
    db.prepare(`INSERT INTO make_chain_runs (id, chain_id, name, input, input_file, status, steps, results, source, agent_id, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, '[]', ?, ?, ?)`)
      .run(id, chain.id, chain.name, text, inputFile ? JSON.stringify(inputFile) : null, JSON.stringify(chain.steps), source, agentId, clock());
    const done = tail.then(() => runSteps(id));
    tail = done.catch(e => console.error('[make-chains] queue:', e.message));
    return { id, status: 'queued', chain: { id: chain.id, name: chain.name, steps: chain.steps.length }, done };
  }

  const getRun = id => runOut(db.prepare(`SELECT * FROM make_chain_runs WHERE id = ?`).get(String(id)));
  const listRuns = (limit = 20) => db.prepare(`SELECT * FROM make_chain_runs ORDER BY created_at DESC LIMIT ?`).all(Math.min(100, Math.max(1, parseInt(limit, 10) || 20))).map(runOut);

  /** Runs a dead process left queued or running cannot resume (their steps' jobs died with it): close them. */
  function recoverAtBoot(reason) {
    return db.prepare(`UPDATE make_chain_runs SET status = 'error', error = ?, completed_at = ? WHERE status IN ('queued', 'running')`).run(clip(reason, 200), clock()).changes;
  }

  return { getChain, listChains, saveChain, deleteChain, startRun, getRun, listRuns, recoverAtBoot };
}
