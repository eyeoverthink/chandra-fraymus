/**
 * Card-seconds ledger — what the machines' time was spent on, and for whom.
 *
 * Gap 10 in docs/NEXUS-ENGINE-CREATION-METHODS.md. Nexus kept a cost ledger in dollars; nothing here is paid, so the
 * real cost is the time of the two graphics cards (this PC's RTX 3070, fraymus-home's RTX 5070) and of the CPU-only
 * machines in the model pool. Every use writes one row at the place it happens:
 *   model     — every model-pool call (model-pool.js runOnPool): the machine's time from the call's start to its end
 *   paint / motion / mesh / inpaint / matte / render — a worker job (media/workers.js), from the worker's own signed
 *               receipt; a failed job is charged the hub's elapsed time with ok = 0
 *   lease     — this PC's card held for local painting (media/gpu-lease.js)
 *   voice     — a line spoken by VoiceStudio on this PC's card (Make films and the narrator)
 *
 * Who: an AsyncLocalStorage store set where work enters — an agent's run (`agent:<id>`, fleet/runtime.js drive) or an
 * HTTP request (`api`) — and carried through every await and queued promise to the row, so no call site passes it.
 * Jobs add themselves to `via` (looks:…, make:…, episode:…, chain:…). Autonomous work has no store: it is charged to
 * `system:<label>` (the model call's own label: reflection, dream, goals…).
 *
 * The ledger is read, not only written: an agent over AGENT_CARD_SECONDS_PER_DAY of media card time in 24 h is
 * refused new card jobs (assertCardBudget), and every report is a question someone asked ("what did the dreams cost?").
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { db } from '../db.js';

const now = () => Date.now();
const clip = (s, n) => String(s ?? '').slice(0, n);
export const originStore = new AsyncLocalStorage();

/** The kinds that are media work on a card (what an agent's budget counts); model calls are its thinking, not media. */
export const MEDIA_KINDS = Object.freeze(['paint', 'motion', 'mesh', 'inpaint', 'lease', 'voice', 'render']);
/** Worker job kind → ledger kind, and whether it runs on the card. */
export const WORKER_KINDS = Object.freeze({ stills: ['paint', 'gpu'], i2v: ['motion', 'gpu'], mesh: ['mesh', 'gpu'], inpaint: ['inpaint', 'gpu'], matte: ['matte', 'cpu'], video: ['render', 'cpu'] });
export const AGENT_CARD_SECONDS_PER_DAY = Math.max(0, parseInt(process.env.AGENT_CARD_SECONDS_PER_DAY, 10) || 1800);
const KEEP_DAYS = 90;

db.exec(`CREATE TABLE IF NOT EXISTS card_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, machine TEXT NOT NULL, card TEXT NOT NULL,
  kind TEXT NOT NULL, seconds REAL NOT NULL, job TEXT, origin TEXT NOT NULL, via TEXT, label TEXT, ok INTEGER NOT NULL DEFAULT 1, detail TEXT)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_card_ledger_at ON card_ledger(at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_card_ledger_origin ON card_ledger(origin, at)`);

// ── who ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn` with an origin: { origin?: 'agent:x' | 'api' | …, via?: 'looks:…', run?: runId }. An inner call keeps the
 * outer origin (an agent's chain step is still the agent's) and adds its `via`.
 */
export function withOrigin({ origin = null, via = null, run = null } = {}, fn) {
  const cur = originStore.getStore();
  return originStore.run({ origin: cur?.origin || origin || 'system', via: [...(cur?.via || []), ...(via ? [via] : [])], run: cur?.run || run || null }, fn);
}
export const currentOrigin = () => originStore.getStore() || null;
/** The origin a row is charged to (pure): the store's, else `system:<first word of the label>`. */
export function originOf(store, label = '') {
  if (store?.origin) return store.origin;
  const word = String(label || '').split(/[:\s]/)[0].toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unlabelled';
  return `system:${word}`;
}

// ── writing ──────────────────────────────────────────────────────────────────────────────────────────

/** One use of a machine. Never throws: a ledger that broke a render would cost more than it saves. */
export function recordCard({ machine, card = 'gpu', kind, seconds, job = null, label = '', ok = true, detail = null, origin = null }) {
  try {
    if (!(seconds >= 0) || !kind || !machine) return;
    const store = originStore.getStore();
    db.prepare(`INSERT INTO card_ledger (at, machine, card, kind, seconds, job, origin, via, label, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(now(), clip(machine, 40), card === 'cpu' ? 'cpu' : 'gpu', clip(kind, 20), +Number(seconds).toFixed(3), job ? clip(job, 80) : (store?.via?.at(-1) || store?.run || null),
        origin || originOf(store, label), store?.via?.length ? clip(store.via.join(' > '), 200) : null, clip(label, 160), ok ? 1 : 0, detail ? clip(JSON.stringify(detail), 600) : null);
  } catch (e) { console.error('[card-ledger] record:', e.message); }
}
/** Time `fn` and record it, whatever it returns or throws. */
export async function timedCard(entry, fn) {
  const t0 = now();
  let ok = true;
  try { return await fn(); } catch (e) { ok = false; throw e; }
  finally { recordCard({ ...entry, seconds: (now() - t0) / 1000, ok: ok && entry.ok !== false }); }
}

// ── reading ──────────────────────────────────────────────────────────────────────────────────────────

const BY = { origin: 'origin', machine: 'machine', kind: 'kind', card: 'card', job: 'job', day: "strftime('%Y-%m-%d', at / 1000, 'unixepoch')", agent: "CASE WHEN origin LIKE 'agent:%' THEN origin ELSE 'not an agent' END" };
/**
 * Totals over the last `days`, grouped `by` origin | machine | kind | card | job | day | agent. Seconds are split
 * into card (gpu) and cpu; `share` is each group's part of the card total.
 */
export function cardLedger({ days = 1, by = 'origin', limit = 30 } = {}) {
  const d = Math.min(90, Math.max(0.01, Number(days) || 1)), since = now() - d * 86_400_000, col = BY[by] || BY.origin;
  const rows = db.prepare(`SELECT ${col} AS key, SUM(CASE WHEN card = 'gpu' THEN seconds ELSE 0 END) gpu, SUM(CASE WHEN card = 'cpu' THEN seconds ELSE 0 END) cpu, COUNT(*) n, SUM(1 - ok) failed
    FROM card_ledger WHERE at >= ? GROUP BY key ORDER BY gpu DESC, cpu DESC LIMIT ?`).all(since, Math.min(200, Math.max(1, parseInt(limit, 10) || 30)));
  const tot = db.prepare(`SELECT SUM(CASE WHEN card = 'gpu' THEN seconds ELSE 0 END) gpu, SUM(CASE WHEN card = 'cpu' THEN seconds ELSE 0 END) cpu, COUNT(*) n FROM card_ledger WHERE at >= ?`).get(since);
  const gpu = tot.gpu || 0;
  return { days: d, by: BY[by] ? by : 'origin', since, total: { gpuSeconds: +gpu.toFixed(1), cpuSeconds: +(tot.cpu || 0).toFixed(1), uses: tot.n },
    rows: rows.map(r => ({ key: r.key ?? '(none)', gpuSeconds: +(r.gpu || 0).toFixed(1), cpuSeconds: +(r.cpu || 0).toFixed(1), uses: r.n, failed: r.failed, share: gpu ? +((r.gpu || 0) / gpu).toFixed(3) : 0 })) };
}
/** Everything one job used: rows whose job or via names it. */
export function jobCardSeconds(jobId) {
  const id = String(jobId || ''); if (!id) return null;
  const like = `%${id.replace(/[%_\\]/g, '\\$&')}%`;
  const r = db.prepare(`SELECT SUM(CASE WHEN card = 'gpu' THEN seconds ELSE 0 END) gpu, SUM(CASE WHEN card = 'cpu' THEN seconds ELSE 0 END) cpu, COUNT(*) n FROM card_ledger WHERE job LIKE ? ESCAPE '\\' OR via LIKE ? ESCAPE '\\'`).get(like, like);
  return { gpuSeconds: +(r.gpu || 0).toFixed(1), cpuSeconds: +(r.cpu || 0).toFixed(1), uses: r.n };
}

// ── the budget: the ledger's consumer ────────────────────────────────────────────────────────────────

/** Media card seconds an agent used in the last 24 h. */
export function agentCardSeconds(agentId, { hours = 24 } = {}) {
  const r = db.prepare(`SELECT SUM(seconds) s FROM card_ledger WHERE origin = ? AND card = 'gpu' AND kind IN (${MEDIA_KINDS.map(() => '?').join(', ')}) AND at >= ?`)
    .get(`agent:${agentId}`, ...MEDIA_KINDS, now() - hours * 3_600_000);
  return +(r.s || 0).toFixed(1);
}
/**
 * Refuse new card work from an agent that has used its day. Pure decision + one read; called where an agent's media
 * job is queued (looks, Make). Operators and the system are never refused — the budget limits what agents start.
 */
export function cardBudgetDecision(origin, used, allowance = AGENT_CARD_SECONDS_PER_DAY) {
  if (!String(origin || '').startsWith('agent:') || !allowance) return { ok: true };
  return used >= allowance ? { ok: false, used, allowance, reason: `${origin.slice(6)} has used ${Math.round(used)} s of media card time in 24 hours (allowance ${allowance} s); it can start more when that falls` } : { ok: true, used, allowance };
}
export function assertCardBudget() {
  const store = originStore.getStore();
  if (!store?.origin?.startsWith('agent:')) return;
  const d = cardBudgetDecision(store.origin, agentCardSeconds(store.origin.slice(6)));
  if (!d.ok) throw Object.assign(new Error(d.reason), { status: 429, code: 'card_budget' });
}
export function cardBudgets() {
  const rows = db.prepare(`SELECT origin, SUM(seconds) s FROM card_ledger WHERE origin LIKE 'agent:%' AND card = 'gpu' AND kind IN (${MEDIA_KINDS.map(() => '?').join(', ')}) AND at >= ? GROUP BY origin ORDER BY s DESC`)
    .all(...MEDIA_KINDS, now() - 86_400_000);
  return { allowance: AGENT_CARD_SECONDS_PER_DAY, agents: rows.map(r => ({ agent: r.origin.slice(6), usedSeconds: +r.s.toFixed(1), left: +Math.max(0, AGENT_CARD_SECONDS_PER_DAY - r.s).toFixed(1) })) };
}

// ── history and upkeep ───────────────────────────────────────────────────────────────────────────────

/**
 * Backfill once from what was already recorded before the ledger: worker receipts and this PC's leases. A Make job's
 * agent is known from creation_jobs; anything else is charged to `before the ledger`. Rows keep their own times.
 */
export function backfillCardLedger() {
  let added = 0;
  try {
    const have = new Set(db.prepare(`SELECT job FROM card_ledger WHERE label LIKE 'backfill:%'`).all().map(r => r.job));
    const agentOf = id => { const m = /^make-[0-9a-f]+/.exec(id); if (!m) return null; try { const r = db.prepare(`SELECT source, agent_id FROM creation_jobs WHERE id = ?`).get(m[0]); return r?.agent_id ? `agent:${r.agent_id}` : r ? r.source || 'api' : null; } catch (_) { return null; } };
    const ins = db.prepare(`INSERT INTO card_ledger (at, machine, card, kind, seconds, job, origin, via, label, ok, detail) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const w of db.prepare(`SELECT id, worker, kind, state, receipt, purpose, seconds, created_at, completed_at FROM worker_jobs WHERE state IN ('done', 'error')`).all()) {
        if (have.has(w.id)) continue;
        const [kind, card] = WORKER_KINDS[w.kind] || [w.kind, 'gpu'];
        let secs = w.seconds || 0; try { const r = w.receipt ? JSON.parse(w.receipt) : null; if (r?.seconds != null) secs = r.seconds; } catch (_) { /* hub time stands */ }
        ins.run(w.completed_at || w.created_at, w.worker, card, kind, secs, w.id, agentOf(w.id) || 'before the ledger', `backfill: ${clip(w.purpose, 140)}`, w.state === 'done' ? 1 : 0, null); added++;
      }
      for (const l of db.prepare(`SELECT id, owner, purpose, acquired_at, released_at FROM gpu_leases WHERE released_at IS NOT NULL`).all()) {
        if (have.has(l.id)) continue;
        ins.run(l.released_at, 'this PC', 'gpu', 'lease', (l.released_at - l.acquired_at) / 1000, l.id, agentOf(String(l.purpose).match(/make-[0-9a-f]+/)?.[0] || '') || 'before the ledger', `backfill: ${clip(`${l.owner}: ${l.purpose}`, 140)}`, 1, null); added++;
      }
    });
    tx();
  } catch (e) { console.error('[card-ledger] backfill:', e.message); }
  return added;
}
export function pruneCardLedger() {
  try { return db.prepare(`DELETE FROM card_ledger WHERE at < ?`).run(now() - KEEP_DAYS * 86_400_000).changes; } catch (e) { console.error('[card-ledger] prune:', e.message); return 0; }
}

// ── tools and routes ─────────────────────────────────────────────────────────────────────────────────

export function createCardLedgerTools() {
  return [{ name: 'card_ledger', group: 'studio', risk: 'safe',
    description: 'How much graphics-card and CPU time the machines spent, and on what: grouped by who started it (an agent, the operator, the system\'s own loops), by machine, by kind (model calls, painting, motion, 3-D, voice…), by day or by job, over the last `days`. Also each agent\'s media card time against its daily allowance.',
    parameters: { type: 'object', properties: { by: { type: 'string', enum: Object.keys(BY) }, days: { type: 'number', minimum: 0.04, maximum: 90 } }, additionalProperties: false },
    execute: async ({ args = {} } = {}) => ({ ...cardLedger({ days: args.days || 1, by: args.by || 'origin', limit: 15 }), budgets: cardBudgets() }) }];
}
export function installCardLedgerRoutes(app) {
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/api/card-ledger', route((req, res) => res.json({ ...cardLedger({ days: req.query.days, by: req.query.by, limit: req.query.limit }), budgets: cardBudgets() })));
  app.get('/api/card-ledger/job/:id', route((req, res) => res.json({ job: req.params.id, ...jobCardSeconds(req.params.id) })));
  app.get('/api/card-ledger/budgets', route((req, res) => res.json(cardBudgets())));
}
