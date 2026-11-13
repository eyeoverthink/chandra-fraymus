/**
 * The home screen's rings, measured. Each ring is one real process of the organism and moves only as fast as that
 * process is working (Vaughn, 2026-11-12: "the spinning wheels can and should represent logic, cipher, data
 * processing, real-time algorithms, thought-matrix … the counter-directional spin can route or represent true
 * application processes"). Before this they were a CSS animation with no input.
 *
 *   agents   — fleet runs in flight; tool calls per minute (messages role='tool')
 *   routing  — the model pool: calls per minute across every machine, calls in flight on each machine
 *   logic    — reasoner calls, verifier loops and cipher runs per minute; loops / runs in flight
 *   matrix   — the CTRNN: ticks per second, mean activation, synapse density, saturation
 *
 * Rates come from the last 5 minutes of rows, or from the difference between two readings for counters. Nothing is
 * smoothed into motion that did not happen: a stalled process reads zero and its ring stops.
 */
const WINDOW_MS = 5 * 60_000;
let lastTick = null;   // { tick, at } for the CTRNN rate
let lastPool = null;   // { calls, at } for the pool rate

function count(db, sql, ...params) {
  try { return db.prepare(sql).get(...params)?.c ?? 0; }
  catch (e) { console.error('fraymus-os pulse:', e.message); return 0; }
}

export function readPulse({ db, ctrnn = null, poolStatus = null, now = Date.now() } = {}) {
  const since = now - WINDOW_MS;
  const perMin = n => +(n / (WINDOW_MS / 60_000)).toFixed(2);

  const agentsActive = count(db, `SELECT COUNT(*) c FROM runs WHERE status IN ('running', 'queued')`);
  const toolCalls = count(db, `SELECT COUNT(*) c FROM messages WHERE role = 'tool' AND created_at > ?`, since);
  const waiting = count(db, `SELECT COUNT(*) c FROM approvals WHERE status = 'pending'`);

  let routing = { rate: 0, active: 0, hosts: [] };
  try {
    const pool = poolStatus ? poolStatus() : null;
    if (pool) {
      const calls = pool.calls || 0;
      const rate = lastPool && now > lastPool.at ? Math.max(0, (calls - lastPool.calls) / ((now - lastPool.at) / 60_000)) : 0;
      lastPool = { calls, at: now };
      const recent = count(db, `SELECT COUNT(*) c FROM fleet_model_calls WHERE at > ?`, since);
      routing = {
        rate: +Math.max(rate, perMin(recent)).toFixed(2),
        active: pool.hosts.reduce((n, h) => n + (h.inFlight || 0), 0),
        hosts: pool.hosts.map(h => ({ name: h.name, local: h.local, model: h.defaultModel, healthy: !!h.healthy, why: h.healthy ? null : (h.checkedAt ? String(h.why || 'not answering').slice(0, 60) : 'not checked yet'), inFlight: h.inFlight || 0, calls: h.calls || 0 })),
      };
    }
  } catch (e) { console.error('fraymus-os pulse pool:', e.message); }

  const reasoner = count(db, `SELECT COUNT(*) c FROM reasoner_calls WHERE created_at > ?`, since);
  const verifierRunning = count(db, `SELECT COUNT(*) c FROM verification_loops WHERE status = 'running'`);
  const verifierRecent = count(db, `SELECT COUNT(*) c FROM verification_loops WHERE created_at > ?`, since);
  const cipherRunning = count(db, `SELECT COUNT(*) c FROM cipher_runs WHERE status = 'running'`);
  const cipherRecent = count(db, `SELECT COUNT(*) c FROM cipher_runs WHERE created_at > ?`, since);

  let matrix = { running: false, rate: 0, active: 0 };
  try {
    if (ctrnn) {
      const m = ctrnn.metrics();
      const tick = ctrnn.tick;
      const tps = lastTick && now > lastTick.at ? Math.max(0, (tick - lastTick.tick) / ((now - lastTick.at) / 1000)) : 0;
      lastTick = { tick, at: now };
      matrix = { running: !!ctrnn.running, rate: +tps.toFixed(1), active: m.activeSynapses, tick,
        meanActivation: +m.meanActivation.toFixed(3), connectivity: +m.connectivityRatio.toFixed(3), saturation: +(m.saturationRatio ?? 0).toFixed(3) };
    }
  } catch (e) { console.error('fraymus-os pulse ctrnn:', e.message); }

  return {
    at: now, windowMs: WINDOW_MS, waiting,
    rings: [
      { id: 'agents', label: 'Agents & tools', unit: 'tool calls / min', rate: perMin(toolCalls), active: agentsActive, detail: `${agentsActive} run${agentsActive === 1 ? '' : 's'} in flight` },
      { id: 'routing', label: 'Thought routing', unit: 'model calls / min', rate: routing.rate, active: routing.active, hosts: routing.hosts,
        detail: routing.hosts.map(h => `${h.name} ${h.model}${h.inFlight ? ` ×${h.inFlight}` : ''}${h.healthy ? '' : ` (${h.why})`}`).join(' · ') },
      { id: 'logic', label: 'Logic & cipher', unit: 'reasoner, verifier, cipher / min', rate: perMin(reasoner + verifierRecent + cipherRecent), active: verifierRunning + cipherRunning,
        detail: `reasoner ${reasoner} · verifier ${verifierRecent}${verifierRunning ? ` (${verifierRunning} running)` : ''} · cipher ${cipherRecent}${cipherRunning ? ` (${cipherRunning} running)` : ''} in 5 min` },
      { id: 'matrix', label: 'Thought matrix (CTRNN)', unit: 'ticks / s', rate: matrix.rate, active: matrix.active, running: matrix.running,
        detail: matrix.running ? `${matrix.rate} ticks/s · activation ${matrix.meanActivation} · synapses ${matrix.active} · saturation ${matrix.saturation}` : 'stopped' },
    ],
  };
}
