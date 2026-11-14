/**
 * The live make-chain runner: make-chains.js with Chandra's real makers as its steps.
 *
 *   write   → the model pool (chatOllama), the text becomes the running summary
 *   paint / restyle / move / motion / avatar → Looks jobs (looks/index.js), waited on until done
 *   make    → Make (make.js createFromRequest), waited on until the job row completes
 *   voice   → the narrator's voice path: VoiceStudio `vaughn-one`, the TTS cascade if it is down
 *
 * Every file a step makes is already on the shelf with its provenance; the chain only records which file each step
 * was handed and which it made. Fleet tools make_chain.* and routes under /api/make-chains.
 */
import { basename } from 'node:path';
import { db } from '../db.js';
import { mayRecoverAtBoot } from '../config.js';
import { publish } from '../fleet/bus.js';
import { chatOllama } from '../commerce/shared.js';
import { createChainRunner, STEP_KINDS, STEP_KIND_NAMES, MAX_STEPS, MAKE_AS, spokenText, BUILTIN_CHAINS } from './make-chains.js';
import { lookJob, startGenerate, startConvert, startAnimate, startMotion, startAvatar, startLayers, startVector, startExtend, startRig } from './looks/index.js';
import { startEpisode, getEpisode } from './episode-builder.js';
import { createFromRequest, getCreation } from './make.js';
import { voiceLine } from '../intelligence/narrator.js';
import { startWorld, getWorld } from './world-builder.js';
import { startGame, getGame } from './game-builder.js';

const clip = (s, n) => String(s ?? '').slice(0, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STEP_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.MAKE_CHAIN_STEP_TIMEOUT_MS, 10) || 45 * 60_000);
const emit = payload => { try { publish('studio', 'system.studio', JSON.stringify(payload)); } catch (e) { console.error('[make-chains] publish:', e.message); } };

const WRITE_SYSTEM = 'You are one step in a chain that makes a film, picture, page or recording. Write only what the step asks for, in plain prose, with no preamble, no headings and no commentary about the task. When you are given material from an earlier step, keep its people, places and events: the next step is made from what you write.';

async function waitLook(job, report) {
  const t0 = Date.now();
  for (;;) {
    const j = lookJob(job.id);
    if (!j) throw new Error(`looks job ${job.id} disappeared (a restart?)`);
    if (j.status === 'done') return j.result;
    if (j.status === 'error') throw new Error(`${job.kind}: ${j.error}`);
    report(`${job.kind}: ${j.stage}`);
    if (Date.now() - t0 > STEP_TIMEOUT_MS) throw new Error(`${job.kind} did not finish in ${Math.round(STEP_TIMEOUT_MS / 60_000)} minutes`);
    await sleep(2000);
  }
}

async function waitCreation(id, report) {
  const t0 = Date.now();
  for (;;) {
    const j = getCreation(id);
    if (!j) throw new Error(`creation ${id} is gone`);
    if (j.status === 'completed') return j;
    if (j.status === 'error' || j.status === 'cancelled') throw new Error(`make ${id}: ${j.error || j.status}`);
    report(`make: ${j.stage || j.status}${j.progress ? ` (${Math.round(j.progress * 100)}%)` : ''}`);
    if (Date.now() - t0 > STEP_TIMEOUT_MS) throw new Error(`make ${id} did not finish in ${Math.round(STEP_TIMEOUT_MS / 60_000)} minutes`);
    await sleep(3000);
  }
}

const source = ctx => (ctx.source === 'agent' ? 'agent' : 'api');const fileFrom = (name, kind) => ({ file: basename(String(name)), kind });

export const ADAPTERS = {
  async write(step, r, ctx) {
    const messages = [{ role: 'system', content: WRITE_SYSTEM }, { role: 'user', content: r.prompt }];
    if (r.feedback) messages.push({ role: 'user', content: r.feedback });
    const text = String(await chatOllama(messages, { priority: 'goal', label: 'make-chain:write', temperature: 0.6, maxTokens: Math.min(2000, Number(step.maxTokens) || 900), timeoutMs: 240_000 }) || '').trim();
    if (text.length < 10) throw new Error('the writer returned nothing');
    return { summary: text };
  },
  async paint(step, r, ctx, report) {
    const res = await waitLook(startGenerate({ prompt: clip(r.prompt, 600), look: step.look || null, format: step.format || '16:9', source: source(ctx) }), report);
    const pic = (res.pictures || []).find(p => p.ok);
    if (!pic) throw new Error(`nothing was painted: ${(res.pictures || []).map(p => p.error).filter(Boolean).join('; ') || 'no picture'}`);
    return { file: fileFrom(pic.file, 'image'), detail: { recipe: res.recipe, paintedOn: pic.paintedOn, replaced: res.replacedCharacters } };
  },
  async restyle(step, r, ctx, report) {
    const res = await waitLook(startConvert({ file: ctx.previousFile.file, look: step.look, source: source(ctx) }), report);
    return { file: fileFrom(res.file, 'image'), detail: { look: res.label } };
  },
  async move(step, r, ctx, report) {
    const res = await waitLook(startAnimate({ file: ctx.previousFile.file, move: step.move || 'push-in', seconds: step.seconds || 5, look: step.look || null, format: step.format || '16:9', source: source(ctx) }), report);
    return { file: fileFrom(res.file, 'video'), detail: { move: res.move, seconds: res.seconds } };
  },
  async motion(step, r, ctx, report) {
    const res = await waitLook(startMotion({ file: ctx.previousFile.file, prompt: clip(r.prompt, 600), seconds: step.seconds || 2, format: step.format || '16:9', look: step.look || null, source: source(ctx) }), report);
    return { file: fileFrom(res.file, 'video'), detail: { paintedOn: res.paintedOn, movement: res.movement?.overall } };
  },
  async avatar(step, r, ctx, report) {
    const res = await waitLook(startAvatar({ file: ctx.previousFile.file, look: step.look || null, seconds: step.seconds || 6, format: step.format || '1:1', source: source(ctx) }), report);
    return { file: fileFrom(res.film, 'video'), detail: { model: res.model, still: res.still } };
  },
  async game(step, r, ctx, report) {
    const pic = step.fromPicture && ctx.previousFile?.kind === 'image' ? ctx.previousFile.file : null;
    if (!pic && !r.prompt) throw new Error('a game step needs a prompt, or fromPicture with a picture before it');
    report('game: setting up');
    const started = startGame({ request: r.prompt || '', file: pic, source: source(ctx) });
    await started.done;
    const gm = getGame(started.id);
    if (gm.status !== 'completed') throw new Error(`game: ${gm.error || gm.status}`);
    return { file: fileFrom(gm.slug, 'page'), detail: { url: gm.url, name: gm.spec?.name, ran: gm.check?.play?.ran } };
  },
  async world(step, r, ctx, report) {
    const pic = step.fromPicture && ctx.previousFile?.kind === 'image' ? ctx.previousFile.file : null;
    if (!pic && !r.prompt) throw new Error('a world step needs a prompt, or fromPicture with a picture before it');
    const started = startWorld({ request: pic ? '' : r.prompt, file: pic, source: source(ctx) });
    await started.done;
    const w = getWorld(started.id);
    if (w.status !== 'completed') throw new Error(`world: ${w.error || w.status}`);
    report('world: walked through and kept');
    return { file: fileFrom(w.slug, 'page'), detail: { url: w.url, name: w.spec?.name, walked: w.check?.walk?.walked } };
  },
  async vector(step, r, ctx, report) {
    const res = await waitLook(startVector({ file: ctx.previousFile.file, style: step.style || 'cutout', detail: step.detail, source: source(ctx) }), report);
    return { file: fileFrom(res.file, 'image'), detail: { svg: res.svg, style: res.label, lines: res.stats?.lines, check: res.check } };
  },
  async layers(step, r, ctx, report) {
    const res = await waitLook(startLayers({ file: ctx.previousFile.file, context: clip(r.context || '', 300), plate: step.plate === 'fill' ? 'fill' : 'paint', source: source(ctx) }), report);
    const keep = step.keep === 'subject' ? res.subject : res.plate;
    return { file: fileFrom(keep, 'image'), detail: { subject: res.subject, plate: res.plate, matte: res.matte, plateBy: res.plateBy, level: res.level?.tiles } };
  },
  async rig(step, r, ctx, report) {
    const res = await waitLook(startRig({ file: ctx.previousFile.file, rig: step.rig || 'bullet-time', seconds: step.seconds || 5, look: step.look || null, format: step.format || '16:9', source: source(ctx) }), report);
    return { file: fileFrom(res.file, 'video'), detail: { rig: res.rig, depth: res.depth, parallax: res.parallax?.relative ?? null } };
  },
  async extend(step, r, ctx, report) {
    const res = await waitLook(startExtend({ file: ctx.previousFile.file, prompt: clip(r.prompt, 600), seconds: step.seconds || 3, source: source(ctx) }), report);
    return { file: fileFrom(res.file, 'video'), detail: { added: res.added, seconds: res.seconds, seam: res.seam?.seam, paintedOn: res.paintedOn } };
  },
  async episode(step, r, ctx, report) {
    const premise = clip(r.prompt || ctx.previousSummary || '', 600);
    if (premise.length < 10) throw new Error('an episode step needs a premise (prompt) or a running summary before it');
    report('episode: outlining');
    const started = startEpisode({ premise, acts: step.acts || 3, secondsPerAct: step.secondsPerAct || 20, style: step.style || 'flat', format: step.format || '16:9', source: source(ctx) });
    await started.done;
    const ep = getEpisode(started.id);
    if (ep.status !== 'completed') throw new Error(`episode: ${ep.error || ep.status}`);
    // the acts' narration is the story so far for any later step
    const said = (ep.acts || []).flatMap(a => (a.shots || []).map(s => s.say)).join(' ');
    return { file: fileFrom(ep.file, 'video'), summary: said ? clip(said, 3000) : null, detail: { episode: ep.id, title: ep.outline?.title, acts: ep.acts.length, seconds: ep.check?.seconds } };
  },
  async make(step, r, ctx, report) {
    const asKind = step.as === 'still' ? 'still' : step.as === 'page' ? 'page' : step.as === 'video' ? 'video' : undefined;
    const usePicture = step.usePicture && ctx.previousFile?.kind === 'image' ? ctx.previousFile.file : undefined;
    const started = await createFromRequest({ request: clip(r.prompt, 1500), kind: asKind, style: step.style, seconds: step.seconds, format: step.format, image: usePicture, source: source(ctx), agentId: ctx.agentId || null });
    if (!started.accepted) throw new Error(`Make refused it: ${started.message || started.reason}`);
    const job = await waitCreation(started.id, report);
    const out = job.output || {};
    const kind = out.kind === 'page' ? 'page' : out.kind === 'still' ? 'image' : 'video';
    // a film's script is text the next step can build on; a page or picture keeps the running summary as it was
    // flat and stick films store their narration as numbered lines ("1. …"); other looks store studio markdown, left alone
    const lines = String(job.script || '').split('\n').filter(l => /^\d+\.\s/.test(l)).map(l => l.replace(/^\d+\.\s+/, ''));
    const said = lines.length ? lines.join(' ') : null;
    return { file: fileFrom(out.file, kind), summary: said ? clip(said, 3000) : null, detail: { job: job.id, style: job.style, title: out.title || null, seconds: out.seconds || null, url: out.url || null } };
  },
  async voice(step, r) {
    const text = spokenText(r.text);
    if (text.length < 2) throw new Error('nothing to say');
    const a = await voiceLine(text);
    return { file: fileFrom(a.url, 'audio'), detail: { engine: a.engine, seconds: a.durationEstimate, said: clip(text, 300) } };
  },
};

export const chains = createChainRunner({ db, adapters: ADAPTERS, emit });
if (mayRecoverAtBoot()) {
  const closed = chains.recoverAtBoot('interrupted by restart');
  if (closed) console.log(`[make-chains] closed ${closed} run(s) a previous process left open`);
}

// ── fleet tools ──────────────────────────────────────────────────────────────────────────────────────

const brief = r => r && ({ id: r.id, chain: r.name, status: r.status, step: r.currentStep, of: r.steps.length, error: r.error,
  steps: r.results.map(s => ({ n: s.n, kind: s.kind, label: s.label, status: s.status, stage: s.stage, file: s.file, summary: s.summary ? clip(s.summary, 400) : null, error: s.error || null })) });

export function createMakeChainTools() {
  const stepSchema = { type: 'object', properties: {
    kind: { type: 'string', enum: [...STEP_KIND_NAMES] },
    label: { type: 'string', description: 'Short name for the step' },
    prompt: { type: 'string', description: 'Template for write/paint/motion/make. {{input}}, {{previous_summary}}, {{step_N}} are filled in' },
    text: { type: 'string', description: 'voice: what to say (default {{previous_summary}})' },
    look: { type: 'string', description: 'paint: style recipe; restyle/move/motion/avatar: a look' },
    move: { type: 'string', description: 'move: camera move (push-in, orbit, ken-burns…)' },
    style: { type: 'string', description: 'make: the look (flat, stick, 8bit, cartoon, comic, explainer…)' },
    as: { type: 'string', enum: Object.keys(MAKE_AS), description: 'make: what it makes' },
    keep: { type: 'string', enum: ['subject', 'plate'], description: 'layers: which layer is passed on (default plate)' },
    context: { type: 'string', description: 'layers: what the scene is, to guide the repainted background' },
    seconds: { type: 'integer' },
  }, required: ['kind'] };
  return [
    { name: 'make_chain.list', group: 'studio', risk: 'safe',
      description: 'The make chains Chandra can run: several creation steps in order (write → paint → camera move → voice, story → film, idea → playable page…), each handed the text and the newest file the step before it made. Lists the built-in and saved chains with their steps, and the step kinds.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ chains: chains.listChains().map(c => ({ id: c.id, name: c.name, description: c.description, builtin: c.builtin, steps: c.steps.map(s => `${s.kind}${s.label ? `: ${s.label}` : ''}`) })),
        stepKinds: Object.fromEntries(STEP_KIND_NAMES.map(k => [k, STEP_KINDS[k].about])), maxSteps: MAX_STEPS }) },
    { name: 'make_chain.run', group: 'studio', risk: 'safe', ownsReply: true,
      description: `Run a make chain: name a chain and give the user's words as \`input\`, or pass your own \`steps\`. Built-in chains: ${BUILTIN_CHAINS.map(c => `${c.id} (${c.name})`).join('; ')}. Saved chains are listed by make_chain.list.` + ' ' + ' Every step is handed the running summary and the newest file; a written step that ignores what it was handed is rewritten once and then fails the run. Returns a run id at once; films and motion take minutes. Use this when the user wants one idea carried through several kinds of making (a story that becomes a film, a picture that becomes a moving clip with a voice).',
      parameters: { type: 'object', properties: {
        chainId: { type: 'string', description: 'A chain id from make_chain.list' },
        input: { type: 'string', description: "The user's idea, in their words" },
        steps: { type: 'array', items: stepSchema, description: 'Your own steps, instead of a chainId' },
        name: { type: 'string', description: 'Name for your own steps' },
        file: { type: 'string', description: 'Optional: a picture already on the shelf to start from' },
      } },
      execute: async ({ args = {} } = {}, ctx = {}) => {
        try {
          const r = chains.startRun({ chainId: args.chainId, steps: args.steps, name: args.name, input: args.input, inputFile: args.file ? { file: basename(args.file), kind: 'image' } : null, source: 'agent', agentId: ctx?.agent?.id || null });
          return { runId: r.id, status: r.status, chain: r.chain, replyToUser: `I started the chain "${r.chain.name}" (${r.chain.steps} steps). It is not finished yet: each step waits for the one before it, and what it makes appears on the shelf as it is done. Run ${r.id}.` };
        } catch (e) {
          // a wrong chain id is the caller's slip: no owned reply, so the agent sees the real ids and can call again
          if (e.status === 404) return { error: `${e.message}. Chains: ${chains.listChains().map(c => c.id).join(', ')}` };
          return { error: clip(e.message, 500), replyToUser: `I did not start the chain. ${clip(e.message, 400)}` };
        }
      } },
    { name: 'make_chain.status', group: 'studio', risk: 'safe',
      description: 'Progress of a make-chain run: each step, its stage, the file it made and what it wrote. Pass `id`, or nothing for the latest runs.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
      execute: async ({ args = {} } = {}) => (args.id ? (brief(chains.getRun(args.id)) || { error: 'no such run' }) : { runs: chains.listRuns(5).map(brief) }) },
    { name: 'make_chain.save', group: 'studio', risk: 'safe',
      description: 'Save a new make chain (a name and up to 8 steps) so it can be run again by id. Built-in chains cannot be changed.',
      parameters: { type: 'object', required: ['name', 'steps'], properties: { name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'array', items: stepSchema } } },
      execute: async ({ args = {} } = {}, ctx = {}) => {
        try { const c = chains.saveChain({ name: args.name, description: args.description, steps: args.steps, createdBy: ctx?.agent?.id || 'agent' }); return { saved: true, id: c.id, name: c.name, steps: c.steps.length }; }
        catch (e) { return { saved: false, error: clip(e.message, 500) }; }
      } },
  ];
}

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────

export function installMakeChainRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(e => (e.status ? res.status(e.status).json({ error: e.message, errors: e.errors }) : next(e)));
  app.get('/api/make-chains', route((req, res) => res.json({ chains: chains.listChains(), stepKinds: Object.fromEntries(STEP_KIND_NAMES.map(k => [k, STEP_KINDS[k]])), maxSteps: MAX_STEPS, runs: chains.listRuns(Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10))) })));
  app.get('/api/make-chains/runs', route((req, res) => res.json({ runs: chains.listRuns(Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20))) })));
  app.get('/api/make-chains/runs/:id', route((req, res) => { const r = chains.getRun(req.params.id); if (!r) return res.status(404).json({ error: 'no such run' }); res.json(r); }));
  app.post('/api/make-chains/run', route((req, res) => {
    const b = req.body || {};
    const r = chains.startRun({ chainId: b.chainId, steps: b.steps, name: b.name, input: b.input, inputFile: b.file ? { file: basename(String(b.file)), kind: 'image' } : null, source: 'api' });
    res.status(202).json({ id: r.id, status: r.status, chain: r.chain });
  }));
  app.post('/api/make-chains', route((req, res) => res.status(201).json(chains.saveChain({ ...(req.body || {}), createdBy: 'operator' }))));
  app.get('/api/make-chains/:id', route((req, res) => { const c = chains.getChain(req.params.id); if (!c) return res.status(404).json({ error: 'no such chain' }); res.json(c); }));
  app.delete('/api/make-chains/:id', route((req, res) => res.json(chains.deleteChain(req.params.id))));
}
