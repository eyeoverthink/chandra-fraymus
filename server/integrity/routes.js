import { initStrixLaws, getPolicy, updatePolicy, boundResult, readSpill, budgetCheck,
  compactHistory, listSalvage, sealToolResult, selftest as strixSelftest } from './strix-laws.js';
import { initGuardTasks, guardPayload, guardCommandInput, guardAgentMessage, guardBusMessage,
  getGuardStats, isEnabled as guardEnabled, setEnabled as setGuardEnabled,
  selftest as guardSelftest } from './guard-tasks.js';
import { initWritSystem, requestWrit, consumeWrit, mintOwnerSlot, consumeOwnerSlot,
  getOwnerSlot, getWritStats, verifyReceiptChain, classifyTier,
  isEnabled as writEnabled, setEnabled as setWritEnabled,
  selftest as writSelftest } from './writ-system.js';
import { initClockHonesty, checkClock, getLastVerdict, isClockTrusted, isClockSuspect,
  getClockStats, startMonitor, stopMonitor, selftest as clockSelftest } from './clock-honesty.js';
import { installIntegrityRoutes as installWatchdogRoutes } from './watchdog.js';
import { installPlasmidRoutes } from './plasmid-backup.js';
import { installSelftestRoutes } from './continuity-selftest.js';

export function installGovernanceRoutes(app, opts = {}) {
  const broadcast = opts.broadcast || (() => {});

  initStrixLaws({ broadcast });
  initGuardTasks({ broadcast });
  initWritSystem({ broadcast });
  initClockHonesty({ broadcast }).catch(e => console.error('[clock-honesty] init error:', e.message));

  installWatchdogRoutes(app);
  installPlasmidRoutes(app);

  // -- Strix Laws --
  app.get('/api/integrity/strix/policy', (_req, res) => {
    res.json(getPolicy());
  });

  app.put('/api/integrity/strix/policy', (req, res) => {
    const patch = req.body || {};
    res.json(updatePolicy(patch));
  });

  app.post('/api/integrity/strix/bound', (req, res) => {
    const { text, maxLines, maxChars } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    res.json(boundResult(text, maxLines, maxChars));
  });

  app.get('/api/integrity/strix/spill/:hash', (req, res) => {
    const data = readSpill(req.params.hash);
    if (!data) return res.status(404).json({ error: 'spill not found' });
    res.type('text/plain').send(data);
  });

  app.get('/api/integrity/strix/budget/:step/:total', (req, res) => {
    const step = parseInt(req.params.step) || 0;
    const total = parseInt(req.params.total) || 8;
    res.json(budgetCheck(step, total));
  });

  app.get('/api/integrity/strix/salvage', (_req, res) => {
    res.json(listSalvage());
  });

  app.post('/api/integrity/strix/selftest', (_req, res) => {
    res.json(strixSelftest());
  });

  // -- Guard Tasks --
  app.post('/api/integrity/guard/check', (req, res) => {
    const { payload, source, lane, requireHeader } = req.body || {};
    if (!payload) return res.status(400).json({ error: 'payload required' });
    res.json(guardPayload(payload, { source, lane, requireHeader }));
  });

  app.get('/api/integrity/guard/stats', (_req, res) => {
    res.json(getGuardStats());
  });

  app.post('/api/integrity/guard/toggle', (req, res) => {
    const { enabled } = req.body || {};
    res.json({ enabled: setGuardEnabled(enabled !== false) });
  });

  app.post('/api/integrity/guard/selftest', (_req, res) => {
    res.json(guardSelftest());
  });

  // -- Writ System --
  app.post('/api/integrity/writ/request', (req, res) => {
    const { agentId, tool, command } = req.body || {};
    if (!agentId || !tool) return res.status(400).json({ error: 'agentId and tool required' });
    res.json(requestWrit(agentId, tool, command || 'TASK:'));
  });

  app.post('/api/integrity/writ/consume', (req, res) => {
    const { writId } = req.body || {};
    if (!writId) return res.status(400).json({ error: 'writId required' });
    res.json(consumeWrit(writId));
  });

  app.post('/api/integrity/writ/owner-slot', (req, res) => {
    const { reason } = req.body || {};
    res.json(mintOwnerSlot(reason));
  });

  app.post('/api/integrity/writ/consume-owner', (_req, res) => {
    res.json(consumeOwnerSlot());
  });

  app.get('/api/integrity/writ/owner-slot', (_req, res) => {
    res.json(getOwnerSlot() || { status: 'none' });
  });

  app.get('/api/integrity/writ/stats', (_req, res) => {
    res.json(getWritStats());
  });

  app.get('/api/integrity/writ/chain', (req, res) => {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    res.json(verifyReceiptChain(limit));
  });

  app.post('/api/integrity/writ/toggle', (req, res) => {
    const { enabled } = req.body || {};
    res.json({ enabled: setWritEnabled(enabled !== false) });
  });

  app.post('/api/integrity/writ/selftest', (_req, res) => {
    res.json(writSelftest());
  });

  // -- Clock Honesty --
  app.get('/api/integrity/clock/status', (_req, res) => {
    res.json(getLastVerdict());
  });

  app.post('/api/integrity/clock/check', async (_req, res) => {
    try {
      res.json(await checkClock());
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/integrity/clock/stats', (_req, res) => {
    res.json(getClockStats());
  });

  app.get('/api/integrity/clock/trusted', (_req, res) => {
    res.json({ trusted: isClockTrusted(), suspect: isClockSuspect(), verdict: getLastVerdict() });
  });

  app.post('/api/integrity/clock/selftest', (_req, res) => {
    res.json(clockSelftest());
  });

  // -- Unified --
  app.get('/api/integrity/governance', (_req, res) => {
    res.json({
      strix: { policy: getPolicy() },
      guard: { enabled: guardEnabled(), stats: getGuardStats() },
      writ: { enabled: writEnabled(), stats: getWritStats() },
      clock: { verdict: getLastVerdict(), trusted: isClockTrusted() },
    });
  });

  app.post('/api/integrity/selftest/all', async (_req, res) => {
    const strix = strixSelftest();
    const guard = guardSelftest();
    const writ = writSelftest();
    const clock = clockSelftest();
    const allPass = strix.pass && guard.pass && writ.pass && clock.pass;
    res.json({
      pass: allPass,
      modules: {
        strix: { pass: strix.pass, tests: strix.results.length },
        guard: { pass: guard.pass, tests: guard.results.length },
        writ: { pass: writ.pass, tests: writ.results.length },
        clock: { pass: clock.pass, tests: clock.results.length },
      },
      detail: { strix, guard, writ, clock },
    });
  });

  installSelftestRoutes(app, opts);

  console.log('[integrity] Governance routes installed (strix + guard + writ + clock + continuity selftest)');
}

