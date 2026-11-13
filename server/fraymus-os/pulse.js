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

  // Every reasoning process, not three of them: the ring used to count only `reason` tool calls, verifier loops and
  // cipher_runs (a table that has never had a row), so it read "still" while Logic Chain stages finished at ~67 an
  // hour, debates ran and benchmark problems were solved (2026-11-13).
  const reasoner = count(db, `SELECT COUNT(*) c FROM reasoner_calls WHERE created_at > ?`, since);
  const chainStages = count(db, `SELECT COUNT(*) c FROM chain_stages WHERE ended_at > ?`, since);
  const chainRunning = count(db, `SELECT COUNT(*) c FROM chain_runs WHERE status = 'running'`);
  const debates = count(db, `SELECT COUNT(*) c FROM debates WHERE created_at > ?`, since);
  const debatesRunning = count(db, `SELECT COUNT(*) c FROM debates WHERE status = 'running'`);
  const benchmark = count(db, `SELECT COUNT(*) c FROM capability_items WHERE created_at > ?`, since);
  const verifierRunning = count(db, `SELECT COUNT(*) c FROM verification_loops WHERE status = 'running'`);
  const verifierRecent = count(db, `SELECT COUNT(*) c FROM verification_loops WHERE created_at > ?`, since);
  const cipherRunning = count(db, `SELECT COUNT(*) c FROM cipher_runs WHERE status = 'running'`);
  const cipherRecent = count(db, `SELECT COUNT(*) c FROM cipher_runs WHERE created_at > ?`, since);
  const logicParts = [['chain stages', chainStages], ['debates', debates], ['reasoner', reasoner], ['benchmark', benchmark], ['verifier', verifierRecent], ['cipher', cipherRecent]];

  let matrix = { running: false, rate: 0, active: 0 };
  try {
    if (ctrnn) {
      const m = ctrnn.metrics();
      const tick = ctrnn.tick;
      const tps = lastTick && now > lastTick.at ? Math.max(0, (tick - lastTick.tick) / ((now - lastTick.at) / 1000)) : 0;
      lastTick = { tick, at: now };
      // every neuron's output, tanh(B), for the orb's core — 256 numbers, so the picture is the network as it is now
      const st = typeof ctrnn.state === 'function' ? ctrnn.state() : null;
      const grid = st?.B ? st.B.map(b => Math.round(Math.tanh(b) * 100) / 100) : null;
      matrix = { running: !!ctrnn.running, rate: +tps.toFixed(1), active: m.activeSynapses, tick, grid, gridSize: st?.gridSize || null,
        meanActivation: +m.meanActivation.toFixed(3), connectivity: +m.connectivityRatio.toFixed(3), saturation: +(m.saturationRatio ?? 0).toFixed(3) };
    }
  } catch (e) { console.error('fraymus-os pulse ctrnn:', e.message); }

  return {
    at: now, windowMs: WINDOW_MS, waiting,
    rings: [
      { id: 'agents', label: 'Agents & tools', unit: 'tool calls / min', rate: perMin(toolCalls), active: agentsActive, detail: `${agentsActive} run${agentsActive === 1 ? '' : 's'} in flight` },
      { id: 'routing', label: 'Thought routing', unit: 'model calls / min', rate: routing.rate, active: routing.active, hosts: routing.hosts,
        detail: routing.hosts.map(h => `${h.name} ${h.model}${h.inFlight ? ` ×${h.inFlight}` : ''}${h.healthy ? '' : ` (${h.why})`}`).join(' · ') },
      { id: 'logic', label: 'Logic & cipher', unit: 'reasoning steps / min', rate: perMin(logicParts.reduce((n, [, c]) => n + c, 0)),
        active: chainRunning + debatesRunning + verifierRunning + cipherRunning, parts: Object.fromEntries(logicParts),
        detail: `${logicParts.filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(' · ') || 'nothing'} in 5 min${chainRunning ? ` · ${chainRunning} chain${chainRunning === 1 ? '' : 's'} running` : ''}${debatesRunning ? ` · ${debatesRunning} debate${debatesRunning === 1 ? '' : 's'} running` : ''}${verifierRunning ? ` · ${verifierRunning} verifier running` : ''}` },
      { id: 'matrix', label: 'Thought matrix (CTRNN)', unit: 'ticks / s', rate: matrix.rate, active: matrix.active, running: matrix.running,
        grid: matrix.grid, gridSize: matrix.gridSize, meanActivation: matrix.meanActivation, connectivity: matrix.connectivity, saturation: matrix.saturation,
        detail: matrix.running ? `${matrix.rate} ticks/s · activation ${matrix.meanActivation} · synapses ${matrix.active} · saturation ${matrix.saturation}` : 'stopped' },
    ],
  };
}
