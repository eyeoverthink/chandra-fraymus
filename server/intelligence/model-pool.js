/**
 * Model pool — every model call in the app goes to the first machine that can take it, and moves on when one fails.
 *
 * Why (2026-11-12): models lived on one machine at a time. When this PC's card could not hold the agents' model,
 * 44 of 60 agent runs timed out; when fraymus-home's model drive dropped off overnight, every call to it failed for
 * hours and nothing noticed. The pool makes the machines interchangeable:
 *
 *   MODEL_HOSTS = "home=qwen3:14b@http://100.99.98.101:11434|slots=2, local, kvm2=qwen3:4b@http://100.72.161.48:11434|slots=1|slow=3, …"
 *
 * Order is preference. `local` is this PC (through the Ollama scheduler, as before); `name=model@url` is another
 * Ollama, `model` being what it runs when a caller asks for the default model. A caller that names a model goes only
 * to machines that have that exact model installed. Options: `slots` (calls in flight, default 2 for the first remote,
 * 1 after), `slow` (multiplies the caller's timeout: CPU-only machines need it), `think=off` is set for qwen3 models.
 *
 * A machine is used when its last check (≤ 30 s old) found it answering with the model installed and it has a free
 * slot; this PC is skipped while the studio holds the graphics card or its queue is already deep. A call that fails
 * BEFORE a reply has started — no connection, an HTTP error such as the drive fault, a timeout with nothing received —
 * rests that machine for a minute and goes to the next. A reply that fails half-way through a stream is not repeated
 * elsewhere. Every choice and every fallback is counted, and `modelPoolStatus()` shows them.
 *
 * Without MODEL_HOSTS (and without the older FLEET_REMOTE_MODEL) the pool is just this PC: behaviour is unchanged.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { classifyUrl } from '../fraymus-os/registry.js';
import { OLLAMA_URL } from '../config.js';
import { withOllama, ollamaPaused, getSchedulerStatus } from './ollama-scheduler.js';
import { timedCard } from './card-ledger.js';

const now = () => Date.now();
const HEALTH_TTL_MS = 30_000, REST_MS = 60_000;
const LOCAL_QUEUE_SKIP = Math.max(1, parseInt(process.env.MODEL_POOL_LOCAL_QUEUE_SKIP, 10) || 3);

export const defaultModel = () => process.env.FRAYMUS_DEFAULT_MODEL || 'fraynix-dreamer-ultimate:8b';

/** Read a hosts list. Pure; unknown or public entries are refused with a reason. */
export function parseHosts(spec, { fallbackRemote = '' } = {}) {
  const raw = String(spec || '').trim() || (String(fallbackRemote || '').trim() ? `remote=${fallbackRemote}, local` : 'local');
  const hosts = [], refused = [];
  let remoteIndex = 0;
  for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    if (part === 'local') { if (!hosts.some(h => h.local)) hosts.push({ name: 'local', local: true, url: OLLAMA_URL, model: null, slots: Infinity, slow: 1 }); continue; }
    const [main, ...opts] = part.split('|').map(s => s.trim());
    const eq = main.indexOf('='), at = main.lastIndexOf('@');
    if (eq <= 0 || at <= eq + 1) { refused.push({ entry: part, reason: 'expected name=model@url' }); continue; }
    const name = main.slice(0, eq).trim(), model = main.slice(eq + 1, at).trim(), c = classifyUrl(main.slice(at + 1).trim());
    if (!/^[a-z0-9_-]{1,24}$/i.test(name) || hosts.some(h => h.name === name)) { refused.push({ entry: part, reason: 'name must be unique letters, digits, - or _' }); continue; }
    if (!c.url) { refused.push({ entry: part, reason: 'not a valid http(s) address' }); continue; }
    if (c.routeClass === 'public') { refused.push({ entry: part, reason: 'public host: prompts are only sent to private machines' }); continue; }
    const o = Object.fromEntries(opts.map(s => s.split('=').map(x => x.trim())).filter(([k, v]) => k && v));
    const slots = Math.min(8, Math.max(1, parseInt(o.slots, 10) || (remoteIndex === 0 ? 2 : 1)));
    const slow = Math.min(10, Math.max(1, Number(o.slow) || 1));
    const keep = /^\d{1,3}[smh]$/.test(o.keep || '') ? o.keep : '30m';
    hosts.push({ name, local: false, url: c.url, host: c.host, model, slots, slow, keep, think: o.think ? o.think !== 'off' : !/^qwen3/i.test(model) });
    remoteIndex++;
  }
  if (!hosts.some(h => h.local)) hosts.push({ name: 'local', local: true, url: OLLAMA_URL, model: null, slots: Infinity, slow: 1 });
  return { hosts, refused };
}

const parsed = parseHosts(process.env.MODEL_HOSTS, { fallbackRemote: process.env.FLEET_REMOTE_MODEL });
const HOSTS = parsed.hosts;
const state = new Map(HOSTS.map(h => [h.name, { ok: h.local, checkedAt: 0, why: h.local ? null : 'not checked yet', models: new Set(), restingUntil: 0, inFlight: 0, calls: 0, failures: 0, totalMs: 0, lastOkAt: null }]));
const stats = { calls: 0, fallbacks: 0, reasons: {}, lastFallback: null, noHost: 0 };

/** Forget the measured speed of every machine (choice falls back to the priors). For tests: one test's timings must not
 *  decide which machine the next test sees — two pool tests flaked about one run in three on exactly that (2026-11-12). */
export function resetPoolMeasurements() {
  for (const s of state.values()) Object.assign(s, { calls: 0, failures: 0, totalMs: 0, inFlight: 0, restingUntil: 0 });
  speeds.clear(); replyTokens.clear();
}

async function check(h) {
  const s = state.get(h.name);
  if (h.local || now() - s.checkedAt < HEALTH_TTL_MS) return s;
  try {
    const r = await fetch(`${h.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) Object.assign(s, { ok: false, why: `HTTP ${r.status}` });
    else { const j = await r.json(); s.models = new Set((j.models || []).flatMap(m => [m.name, m.model].filter(Boolean))); Object.assign(s, s.models.has(h.model) ? { ok: true, why: null } : { ok: false, why: `${h.model} is not installed there` }); }
  } catch (e) { Object.assign(s, { ok: false, why: `not answering (${String(e.message).slice(0, 60)})` }); }
  s.checkedAt = now();
  return s;
}

/** The model a host runs for this call, or null if it cannot take it. Explicit models need that exact model there. */
function modelOn(h, s, requested) {
  // Only "no model named" means "any machine's default". Until 2026-11-12 a request for this PC's default by name
  // (fraynix-dna:8b) also counted as "default", so asking for fraynix-dna was answered by qwen3:14b on fraymus-home.
  const isDefault = !requested;
  if (h.local) return isDefault ? defaultModel() : requested;          // this PC keeps its own default; explicit names were always sent here
  if (isDefault) return h.model;
  return s.models.has(requested) ? requested : null;
}

/**
 * A machine can be busy with something that is not a model call: a machine that also paints and renders for the hub
 * (a worker) should not have a language model loaded onto its card in the middle of a render. Another module registers
 * a guard (media/workers.js does, at start); it answers synchronously from what it last saw, so choosing a machine
 * never waits on it. Returns a reason to skip the machine, or null.
 */
let hostGuard = null;
export function setHostGuard(fn) { hostGuard = typeof fn === 'function' ? fn : null; }
function remoteSkip(h) { try { return hostGuard ? hostGuard({ name: h.name, host: h.host, url: h.url }) : null; } catch (e) { return null; } }

function localSkip() {
  if (ollamaPaused()) return 'the studio holds this PC\'s graphics card';
  const q = getSchedulerStatus?.() || {}; if ((q.queued || 0) >= LOCAL_QUEUE_SKIP) return `this PC's model queue is ${q.queued} deep`;
  return null;
}

/** Order the machines that could take this call right now, best first. */
async function candidates(requested) {
  const out = [];
  for (const h of HOSTS) {
    const s = await check(h);
    if (!h.local && (!s.ok || now() < s.restingUntil)) continue;
    const model = modelOn(h, s, requested); if (!model) continue;
    out.push({ h, s, model, full: !h.local && s.inFlight >= h.slots, skip: h.local ? localSkip() : remoteSkip(h) });
  }
  // Order by when each machine would likely FINISH this call, not by which is free right now: a full fast machine is
  // usually sooner than a free slow one (measured 2026-11-12: fraymus-home 5 s a call, this PC 56 s, a CPU-only VPS 262 s;
  // calls that arrived while fraymus-home's two slots were busy went to the slow ones and stayed there). The list order
  // still decides between machines within half again of the best estimate. A busy (skipped) machine comes last.
  out.forEach((c, i) => { c.order = i; c.eta = expectedSeconds(c.h, c.s); });
  const best = Math.min(...out.filter(c => !c.skip).map(c => c.eta), Infinity);
  const near = c => !c.skip && c.eta <= best * 1.5;
  return [...out.filter(near), ...out.filter(c => !near(c) && !c.skip).sort((a, b) => a.eta - b.eta), ...out.filter(c => c.skip)];
}

/** Seconds this machine would likely take to finish one more call: its measured call time, times the work queued ahead. */
function expectedSeconds(h, s) {
  const index = HOSTS.indexOf(h);
  const prior = h.local ? 20 : 8 * h.slow * (1 + 0.25 * Math.max(0, index));          // before three calls have been timed
  const per = s.calls >= 3 ? s.totalMs / s.calls / 1000 : prior;
  if (h.local) { const q = getSchedulerStatus?.() || {}; return per * (1 + ((q.queued || 0) + (q.running || 0)) / Math.max(1, q.maxConcurrent || 2)); }
  const ahead = Math.max(0, s.inFlight + (waiting.get(h.name)?.length || 0) - h.slots + 1);
  return per * (1 + ahead / h.slots);
}

// ── will this machine finish this call in time? ──────────────────────────────────────────────────────
//
// A long background call (the goal engine's: every measured problem, the projects and the queue, up to 2,048 tokens of
// reply) once went to this PC's fraynix-dna:8b while fraymus-home was busy, ran its 180 s and failed — three minutes of
// the card for nothing (card ledger, 2026-11-14). The pool now learns each machine's reading and writing speed per
// model from Ollama's own reply statistics, estimates each call before choosing, and does not send a call where it
// would overrun its limit. Background work that no machine can do in time fails at once ("too slow right now"), which
// costs no card time; interactive and agent calls keep trying, as before.
const speeds = new Map();      // `${host}|${model}` → { pps: prompt tokens/s, gps: generated tokens/s, n }
const replyTokens = new Map(); // label → typical generated tokens (EMA), so a short-answer caller is not judged by its cap
const CHARS_PER_TOKEN = 3.6, SPEED_EMA = 0.3, TOO_SLOW_SHARE = 0.85;
/** Learn from one finished reply (Ollama's prompt_eval_* and eval_* fields; durations in ns). */
export function learnSpeed(host, model, label, data) {
  const pc = Number(data?.prompt_eval_count) || 0, pd = Number(data?.prompt_eval_duration) || 0, ec = Number(data?.eval_count) || 0, ed = Number(data?.eval_duration) || 0;
  const k = `${host}|${model}`, old = speeds.get(k) || { pps: null, gps: null, n: 0 };
  const mix = (a, b) => (a == null ? b : a * (1 - SPEED_EMA) + b * SPEED_EMA);
  const next = { ...old, n: old.n + 1 };
  if (pc >= 32 && pd > 0) next.pps = mix(old.pps, pc / (pd / 1e9));     // a few cached tokens say nothing about reading speed
  if (ec >= 8 && ed > 0) next.gps = mix(old.gps, ec / (ed / 1e9));
  speeds.set(k, next);
  if (ec > 0 && label) replyTokens.set(label, mix(replyTokens.get(label) ?? null, ec));
}
/** Seconds a call would take on a machine, or null when that machine's speed for that model is not known yet. Pure on its inputs. */
export function estimateCall(speed, { promptChars = 0, maxTokens = 2048, typicalReply = null } = {}) {
  if (!speed?.gps) return null;
  const read = speed.pps ? (promptChars / CHARS_PER_TOKEN) / speed.pps : 0;
  const write = Math.min(maxTokens, typicalReply ?? maxTokens * 0.5) / speed.gps;
  return +(read + write).toFixed(1);
}
/** A machine is too slow for a call when its estimate eats more than TOO_SLOW_SHARE of the call's limit. */
export const tooSlow = (estSeconds, timeoutMs) => estSeconds != null && estSeconds > (timeoutMs / 1000) * TOO_SLOW_SHARE;
/** Interactive questions and agent runs keep trying a slow machine; everything else can wait for a better moment. */
export const deferrable = priority => !['interactive', 'agent_run'].includes(String(priority));
export function poolSpeeds() { return [...speeds.entries()].map(([k, v]) => ({ machine: k.split('|')[0], model: k.split('|')[1], readTokensPerSecond: v.pps && +v.pps.toFixed(1), writeTokensPerSecond: v.gps && +v.gps.toFixed(1), replies: v.n })); }

const note = (reason) => { stats.fallbacks++; const k = String(reason).replace(/\(.*$/, '').replace(/[0-9a-f]{20,}/g, '…').trim().slice(0, 70); stats.reasons[k] = (stats.reasons[k] || 0) + 1; stats.lastFallback = { at: now(), reason: String(reason).slice(0, 200) }; };

/**
 * Run one model call on the pool.
 * @param attempt  async ({ url, model, think, timeoutMs, local, name }) => result. Throw an error with `.started = true`
 *                 once any of the reply has been received: such a failure is not retried elsewhere.
 */
export async function runOnPool({ model = null, priority = 'goal', label = 'model', timeoutMs = 180_000, promptChars = 0, maxTokens = 2048 } = {}, attempt) {
  stats.calls++;
  const tried = [];
  // machines that would overrun this call's limit: left out for background work, tried last for a person or an agent
  const all = await candidates(model), tooSlowFor = [];
  const fits = all.filter(c => {
    const est = estimateCall(speeds.get(`${c.h.name}|${c.model}`), { promptChars, maxTokens, typicalReply: replyTokens.get(label) ?? null });
    if (!tooSlow(est, Math.round(timeoutMs * c.h.slow))) return true;
    tooSlowFor.push({ name: c.h.name, why: `would need about ${Math.round(est)} s of ${Math.round(timeoutMs * c.h.slow / 1000)} s` });
    return false;
  });
  if (!fits.length && tooSlowFor.length && deferrable(priority)) {
    stats.tooSlow = (stats.tooSlow || 0) + 1;
    note(`too slow right now: ${tooSlowFor.map(x => `${x.name} ${x.why}`).join('; ')}`);
    throw Object.assign(new Error(`no machine can finish this in time right now (${tooSlowFor.map(x => `${x.name}: ${x.why}`).join('; ')}); try again when a faster one is free`), { code: 'model_pool_too_slow', tooSlowFor });
  }
  const order = deferrable(priority) ? fits : [...fits, ...all.filter(c => !fits.includes(c))];
  for (const c of order) {
    const { h, s } = c;
    const t = Math.round(timeoutMs * h.slow), t0 = now();
    // the ledger is charged the machine's time on the call itself, not time spent queueing for a slot; a CPU-only
    // machine (slow > 1) is charged CPU, not card, time
    const charged = fn => timedCard({ machine: h.name, card: h.slow > 1 ? 'cpu' : 'gpu', kind: 'model', label, detail: { model: c.model } }, fn);
    try {
      let result;
      if (h.local) result = await withOllama(priority, () => charged(() => attempt({ url: h.url, model: c.model, think: undefined, timeoutMs: t, local: true, name: h.name })), { label });
      else {
        if (s.inFlight >= h.slots) await waitForSlot(h, s);
        s.inFlight++;
        try { result = await charged(() => attempt({ url: h.url, model: c.model, think: h.think ? undefined : false, timeoutMs: t, local: false, name: h.name, keepAlive: h.keep })); }
        finally { s.inFlight--; wake(h.name); }
      }
      s.calls++; s.totalMs += now() - t0; s.lastOkAt = now();
      if (tried.length) note(`${tried.map(x => `${x.name}: ${x.why}`).join('; ')} → answered by ${h.name}`);
      return result;
    } catch (e) {
      if (e?.started || e?.code === 'scheduler_dropped') throw e;          // half a reply, or this PC's queue chose to drop it: not ours to redirect
      s.failures++; if (!h.local) { s.restingUntil = now() + REST_MS; s.ok = false; s.why = String(e.message).slice(0, 140); s.checkedAt = now(); }
      tried.push({ name: h.name, why: String(e.message).slice(0, 90) });
    }
  }
  stats.noHost++;
  const skipped = tooSlowFor.filter(x => !tried.some(t => t.name === x.name)).map(x => `${x.name}: ${x.why} (left out)`);
  throw Object.assign(new Error(`no machine could answer (${[...tried.map(x => `${x.name}: ${x.why}`), ...skipped].join('; ') || 'none has the model'})`), { code: 'model_pool_exhausted', tried });
}

const waiting = new Map();
function waitForSlot(h, s) { return new Promise(res => { const list = waiting.get(h.name) || []; list.push(res); waiting.set(h.name, list); }); }
function wake(name) { const list = waiting.get(name); if (list?.length) list.shift()(); }

export function modelPoolStatus() {
  return { hosts: HOSTS.map(h => { const s = state.get(h.name), busy = h.local ? localSkip() : remoteSkip(h); return { name: h.name, local: h.local, address: h.local ? 'this PC' : h.host, defaultModel: h.local ? defaultModel() : h.model, slots: h.local ? 'scheduler' : h.slots, slow: h.slow, keepAlive: h.local ? null : h.keep,
    healthy: h.local ? !busy : s.ok && now() >= s.restingUntil && !busy, why: now() < s.restingUntil && !h.local ? `resting after: ${s.why}` : busy || s.why, inFlight: s.inFlight, calls: s.calls, failures: s.failures,
    meanSeconds: s.calls ? +(s.totalMs / s.calls / 1000).toFixed(1) : null, lastOkAt: s.lastOkAt, checkedAt: s.checkedAt || null }; }),
    refused: parsed.refused, speeds: poolSpeeds(), ...stats };
}

/** Ask every remote machine now (instead of waiting for its next call), and report. */
export async function checkAllHosts() {
  for (const h of HOSTS) {
    if (h.local) continue;
    const s = state.get(h.name); s.checkedAt = 0; await check(h);
    if (s.ok) s.restingUntil = 0;            // someone fixed it and asked: it is back at once, not after its rest
  }
  return modelPoolStatus();
}

// ── the two shapes of call the app makes ─────────────────────────────────────────────────────────────

// Node's fetch stops waiting for response headers after 300 s (undici headersTimeout), whatever the AbortSignal says.
// A CPU-only machine can take longer than that just to read a long agent prompt before its first byte, so the call failed
// with "fetch failed" at ~330 s while the pool still allowed it 480 s (measured 2026-11-12, llama3.2:3b on srv1). Remote
// calls go through node:http, which has no header deadline; the caller's AbortSignal is the only limit. Returns a
// standard Response so the stream readers do not change.
function poolFetch(url, { method = 'GET', headers = {}, body, signal, viaHttp = true } = {}) {
  if (!viaHttp) return fetch(url, { method, headers, body, signal });   // this PC: answers fast, keeps fetch
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(body);
    const req = http.request(url, { method, headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) } }, res => {
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v != null) out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      resolve(new Response(Readable.toWeb(res), { status: res.statusCode || 0, headers: out }));
    });
    const onAbort = () => req.destroy(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); req.on('close', () => signal.removeEventListener('abort', onAbort)); }
    req.on('error', reject);
    req.end(payload);
  });
}

/** A whole reply at once (what chatOllama does). Returns the reply text. */
export async function poolChat(messages, { model = null, priority = 'goal', label = 'chat', timeoutMs = 180_000, temperature = 0.7, maxTokens = 2048, format = null } = {}) {
  const promptChars = (messages || []).reduce((n, m) => n + String(m?.content || '').length, 0);
  return runOnPool({ model, priority, label, timeoutMs, promptChars, maxTokens }, async ({ url, model: m, think, timeoutMs: t, keepAlive, local, name }) => {
    const res = await poolFetch(`${url}/api/chat`, { viaHttp: !local, method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(t),
      body: JSON.stringify({ model: m, messages, stream: false, options: { temperature, num_predict: maxTokens }, ...(format ? { format } : {}), ...(think === false ? { think: false } : {}), ...(keepAlive ? { keep_alive: keepAlive } : {}) }) });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    learnSpeed(name, m, label, data);
    return data.message?.content || '';
  });
}

/**
 * A streamed reply (what agent runs do). `onResponse(res, host)` reads the stream; anything it throws is a failure
 * after the reply started and is not retried elsewhere.
 */
export async function poolStream(body, { model = null, priority = 'agent_run', label = 'stream', timeoutMs = 120_000 } = {}, onResponse) {
  return runOnPool({ model, priority, label, timeoutMs }, async ({ url, model: m, think, timeoutMs: t, keepAlive, name, local }) => {
    const res = await poolFetch(`${url}/api/chat`, { viaHttp: !local, method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(t),
      body: JSON.stringify({ ...body, model: m, ...(think === false ? { think: false } : {}), ...(keepAlive ? { keep_alive: keepAlive } : {}) }) });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    try { return await onResponse(res, name, m); } catch (e) { throw Object.assign(e, { started: true }); }
  });
}

/** Every model the pool can reach, with the machines that hold it: `[{ model, hosts: [name…], default: [name…] }]`. */
export async function poolModels() {
  const byModel = new Map();
  const add = (model, host, isDefault) => {
    if (!model) return;
    const e = byModel.get(model) || { model, hosts: [], default: [] };
    if (!e.hosts.includes(host)) e.hosts.push(host);
    if (isDefault && !e.default.includes(host)) e.default.push(host);
    byModel.set(model, e);
  };
  for (const h of HOSTS) {
    if (h.local) {
      try {
        const r = await fetch(`${h.url}/api/tags`, { signal: AbortSignal.timeout(4000) });
        if (r.ok) for (const m of (await r.json()).models || []) add(m.name, h.name, m.name === defaultModel());
      } catch (e) { console.error('[model-pool] local tags:', e.message); }
      continue;
    }
    const s = await check(h);
    if (!s.ok) continue;
    for (const m of s.models || []) add(m, h.name, m === h.model);
  }
  return [...byModel.values()].sort((a, b) => b.default.length - a.default.length || a.model.localeCompare(b.model));
}

export function installModelPoolRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/intelligence/model-pool', route((_req, res) => res.json(modelPoolStatus())));
  app.post('/api/intelligence/model-pool/check', route(async (_req, res) => res.json(await checkAllHosts())));
}
