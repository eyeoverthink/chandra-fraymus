/**
 * "How is the system?" answered from the live database, without a model.
 *
 * Why (2026-11-13): asked "analyze your system status", the home screen listed the Ollama models installed on this
 * PC and nothing else — the health shortcut only knew the model registry. This reads what the organism is actually
 * doing: agent runs (and runs stuck on a tool), goals and their quality, the daemon, the consciousness audit, the
 * self-audit, the model pool, approvals waiting, the capability gauge. Every line is a count or a reading from a
 * table; a table that does not exist yet is skipped, never guessed.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const STUCK_MS = 30 * 60_000;

function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// consciousness_audits.created_at is TEXT `datetime('now')` (UTC, no zone); everything else here is epoch ms
function sqlUtc(text) {
  const t = Date.parse(String(text).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? t : null;
}

export function systemFacts(db, { fleet = null, clock = Date.now } = {}) {
  const now = clock();
  const one = (sql, ...p) => { try { return db.prepare(sql).get(...p) ?? null; } catch { return null; } };
  const all = (sql, ...p) => { try { return db.prepare(sql).all(...p); } catch { return null; } };
  const facts = {};

  const runs = one(`SELECT
      SUM(created_at > ?) AS total,
      SUM(created_at > ? AND status = 'error') AS errors,
      SUM(status = 'running') AS running,
      SUM(status = 'queued') AS queued,
      SUM(status = 'running' AND updated_at < ?) AS stuck
    FROM runs`, now - DAY, now - DAY, now - STUCK_MS);
  if (runs) facts.runs = { total24h: runs.total || 0, errors24h: runs.errors || 0, running: runs.running || 0, queued: runs.queued || 0, stuck: runs.stuck || 0 };

  const goals = one(`SELECT COUNT(*) AS n, SUM(status = 'completed') AS done, AVG(quality) AS q
    FROM goal_executions WHERE started_at > ?`, now - DAY);
  if (goals) facts.goals = { executed24h: goals.n || 0, completed24h: goals.done || 0, meanQuality: goals.q == null ? null : Number(goals.q) };

  const cycle = one(`SELECT created_at, duration_ms FROM daemon_cycles ORDER BY created_at DESC LIMIT 1`);
  if (cycle) facts.daemon = { lastCycleAgoMs: now - cycle.created_at, lastCycleSeconds: Math.round((cycle.duration_ms || 0) / 1000) };

  const audit = one(`SELECT verdict, proofs_passed, proofs_total, phi, created_at FROM consciousness_audits ORDER BY created_at DESC LIMIT 1`);
  if (audit) facts.consciousness = { verdict: audit.verdict, proofs: `${audit.proofs_passed}/${audit.proofs_total}`, phi: audit.phi, agoMs: sqlUtc(audit.created_at) == null ? null : now - sqlUtc(audit.created_at) };

  const findings = all(`SELECT severity, COUNT(*) AS c FROM self_audit_findings WHERE resolved_at IS NULL GROUP BY severity`);
  if (findings) {
    facts.selfAudit = Object.fromEntries(findings.map(r => [r.severity, r.c]));
    facts.selfAudit.top = (all(`SELECT severity, summary FROM self_audit_findings WHERE resolved_at IS NULL AND severity IN ('BLOCKING','REAL')
      ORDER BY CASE severity WHEN 'BLOCKING' THEN 0 ELSE 1 END, last_seen DESC LIMIT 3`) || [])
      .map(r => { const text = String(r.summary || ''); return `${r.severity}: ${text.length > 110 ? `${text.slice(0, 107)}…` : text}`; });
  }

  const alerts = one(`SELECT COUNT(*) AS c FROM health_alerts WHERE resolved = 0 AND created_at > ?`, now - DAY);
  if (alerts) facts.alerts = alerts.c || 0;

  const approvals = one(`SELECT COUNT(*) AS c FROM approvals WHERE status = 'pending'`);
  if (approvals) facts.pendingApprovals = approvals.c || 0;

  const g = one(`SELECT g_score, brier, completed_at FROM capability_runs WHERE status = 'completed' AND strategy_mode = 'auto' ORDER BY completed_at DESC LIMIT 1`);
  if (g) facts.capability = { g: g.g_score, brier: g.brier, agoMs: now - (g.completed_at || now) };

  const dreams = one(`SELECT COUNT(*) AS c FROM agent_memories WHERE category = 'dream' AND created_at > ?`, now - DAY);
  if (dreams) facts.dreamsKept24h = dreams.c || 0;

  try {
    const hosts = fleet?.poolStatus?.().hosts;
    if (hosts) facts.pool = hosts.map(h => ({ name: h.name, model: h.defaultModel, healthy: h.healthy, calls: h.calls, meanSeconds: h.meanSeconds }));
  } catch (e) { console.error('system-report pool:', e.message); }

  return facts;
}

export function renderSystemReport(facts, { models = null } = {}) {
  const lines = [];
  const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : 'n/a');
  const r = facts.runs;
  if (r) {
    lines.push(`Agent runs, last 24 h: ${r.total24h} (${r.errors24h} errors, ${pct(r.errors24h, r.total24h)}). Now: ${r.running} running, ${r.queued} queued.`);
    if (r.stuck) lines.push(`⚠ ${r.stuck} run${r.stuck === 1 ? ' has' : 's have'} been running with no progress for over 30 min.`);
  }
  const gl = facts.goals;
  if (gl) lines.push(`Goals, last 24 h: ${gl.executed24h} executed, ${gl.completed24h} completed${gl.meanQuality == null ? '' : `, mean quality ${gl.meanQuality.toFixed(2)}`}.`);
  if (facts.daemon) lines.push(`Daemon: last cycle ${ago(facts.daemon.lastCycleAgoMs)} (took ${facts.daemon.lastCycleSeconds} s).`);
  const c = facts.consciousness;
  if (c) lines.push(`Consciousness audit: ${c.verdict}, ${c.proofs} proofs, Φ ${Number(c.phi).toFixed(3)} (${ago(c.agoMs)}).`);
  const s = facts.selfAudit;
  if (s) {
    lines.push(`Self-audit open findings: ${s.BLOCKING || 0} blocking, ${s.REAL || 0} real, ${s.COSMETIC || 0} cosmetic.`);
    for (const t of s.top || []) lines.push(`  • ${t}`);
  }
  if (facts.alerts != null) lines.push(`Unresolved health alerts (24 h): ${facts.alerts}.`);
  if (facts.pendingApprovals) lines.push(`${facts.pendingApprovals} tool call${facts.pendingApprovals === 1 ? ' is' : 's are'} waiting for your approval.`);
  if (facts.capability) lines.push(`Capability gauge: g ${Number(facts.capability.g).toFixed(3)}, Brier ${Number(facts.capability.brier).toFixed(3)} (${ago(facts.capability.agoMs)}).`);
  if (facts.dreamsKept24h != null) lines.push(`Grounded dreams kept, last 24 h: ${facts.dreamsKept24h}.`);
  if (facts.pool?.length) lines.push(`Model pool: ${facts.pool.map(h => `${h.name} ${h.model} ${h.healthy ? 'up' : 'DOWN'}${h.calls ? `, ${h.calls} calls${h.meanSeconds ? ` ~${Number(h.meanSeconds).toFixed(1)} s` : ''}` : ''}`).join('; ')}.`);
  if (models) lines.push(models);
  return lines.length ? lines.join('\n') : 'No system tables could be read.';
}
