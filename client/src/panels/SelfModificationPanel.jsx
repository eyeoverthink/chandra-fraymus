import { useState, useEffect, useCallback } from 'react';

// Self-Modification Kernel (Phase Y). Three views:
//  Tunables   — every live knob, its bounds, current vs default, who last moved it
//  Experiments — the running one (with remaining window) and the verdict history
//  Code       — tested rsi/* branches awaiting review: diff, tests, Approve (merge) / Reject
// The kernel keeps/reverts parameter experiments on its own; code merges are the operator's.

const C = { card: '#111118', border: '#1e1e2a', dim: '#666', text: '#e0e0e0', green: '#10b981', red: '#ef4444', amber: '#f59e0b', blue: '#3b82f6', purple: '#a78bfa', cyan: '#22d3ee' };
const B = '/api/intelligence/self-modification';

function ago(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const mins = ms => `${Math.max(0, Math.round((ms || 0) / 60000))} min`;
const fmt = (v, unit) => v == null ? '—' : unit === 'ms' ? (v >= 60000 ? `${Math.round(v / 60000)} min` : `${Math.round(v / 1000)} s`) : (Number.isInteger(v) ? String(v) : v.toFixed(2));
const vColor = v => v === 'kept' ? C.green : v === 'reverted' ? C.red : v === 'running' ? C.cyan : v === 'aborted' ? C.amber : C.dim;
const sColor = s => s === 'ready' ? C.cyan : s === 'merged' ? C.green : s === 'failed' || s === 'rejected' ? C.red : s === 'building' ? C.amber : C.dim;
function btn(color, small) { return { background: color + '22', color, border: `1px solid ${color}55`, borderRadius: 6, padding: small ? '3px 8px' : '6px 10px', cursor: 'pointer', fontSize: small ? 11 : 13 }; }

function Stat({ label, value, color }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', textAlign: 'center', flex: 1, minWidth: 90 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.text }}>{value}</div>
      <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Objective({ o }) {
  if (!o) return null;
  const cells = [['objective', o.objective, C.cyan], ['goal quality', o.goalQuality, C.green], ['effectiveness', o.effectiveness, C.purple], ['run errors', o.runErrorRate, C.red], ['goals done', o.goalsDone, C.text], ['drops', o.schedulerDrops, C.amber]];
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {cells.map(([l, v, c]) => <Stat key={l} label={`${l} (${o.hours}h)`} value={v == null ? '—' : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(3) : v} color={c} />)}
    </div>
  );
}

export default function SelfModificationPanel({ wsEvent }) {
  const [status, setStatus] = useState(null);
  const [experiments, setExperiments] = useState([]);
  const [code, setCode] = useState([]);
  const [tab, setTab] = useState('experiments');
  const [open, setOpen] = useState(null);     // code proposal id with diff open
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ tunable: '', value: '', hypothesis: '' });

  const load = useCallback(async () => {
    try {
      const [s, e, c, t] = await Promise.all([fetch(B), fetch(`${B}/experiments?limit=40`), fetch(`${B}/code?limit=40`), fetch('/api/intelligence/tunables')]);
      const [sj, ej, cj, tj] = await Promise.all([s.json(), e.json(), c.json(), t.json()]);
      setStatus({ ...sj, tunablesFull: tj.tunables || [] }); setExperiments(ej.experiments || []); setCode(cj.proposals || []); setError('');
    } catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (wsEvent && /self_modification|tunable/.test(wsEvent.type || wsEvent.topic || '')) load(); }, [wsEvent, load]);

  const act = async (url, body, okMsg) => {
    setBusy(true); setMsg('');
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      const j = await r.json();
      setMsg(r.ok ? okMsg(j) : `refused: ${j.error || j.reason || r.status}`);
      await load();
    } catch (e) { setMsg(`error: ${e.message}`); } finally { setBusy(false); }
  };
  const showDiff = async (id) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id); setDiff('loading…');
    try { const j = await (await fetch(`${B}/code/${encodeURIComponent(id)}`)).json(); setDiff(j.diff || '(branch gone or no diff)'); } catch (e) { setDiff(e.message); }
  };

  const exp = status?.experiment;
  const v = status?.verdicts || {};
  const cc = status?.code?.counts || {};
  const tabs = [['experiments', `Experiments (${experiments.length})`], ['tunables', `Tunables (${status?.tunables?.length || 0})`], ['code', `Code (${cc.ready || 0} ready)`]];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, color: C.text, fontSize: 13 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Stat label="kept" value={v.kept || 0} color={C.green} />
        <Stat label="reverted" value={v.reverted || 0} color={C.red} />
        <Stat label="inconclusive" value={v.inconclusive || 0} color={C.dim} />
        <Stat label="branches ready" value={cc.ready || 0} color={C.cyan} />
        <Stat label="merged" value={cc.merged || 0} color={C.green} />
        <Stat label="ouroboros backlog" value={status?.ouroboros?.backlog ?? '—'} color={status?.ouroboros?.allowed ? C.text : C.amber} />
      </div>
      {error && <div style={{ color: C.red }}>{error}</div>}
      {msg && <div style={{ color: C.amber, fontSize: 12 }}>{msg}</div>}

      <div style={{ background: C.card, border: `1px solid ${exp ? C.cyan : C.border}`, borderRadius: 10, padding: 12 }}>
        {exp ? (
          <>
            <div style={{ fontSize: 12, color: C.cyan, marginBottom: 4 }}>RUNNING EXPERIMENT · {mins(exp.remainingMs)} left of {mins(exp.window_ms)}</div>
            <div style={{ fontWeight: 600 }}>{exp.tunable}: {exp.before_value} → {exp.after_value} <span style={{ color: C.dim, fontWeight: 400 }}>({exp.rule || exp.source})</span></div>
            <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>{exp.hypothesis}</div>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>baseline objective {exp.baseline?.objective ?? '—'} · coverage {exp.baseline?.coverage ?? '—'}</div>
            <button disabled={busy} style={{ ...btn(C.amber, true), marginTop: 8 }} onClick={() => act(`${B}/experiments/${exp.id}/evaluate`, { force: true }, j => `evaluated now: ${j.verdict} (${j.reason})`)}>evaluate now</button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 12, color: C.dim, marginBottom: 6 }}>No experiment running. Objective over the last window:</div>
            <Objective o={status?.objectiveNow} />
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button disabled={busy} style={btn(C.cyan, true)} onClick={() => act(`${B}/cycle`, {}, j => j.acted ? `cycle acted: ${j.started?.id || j.evaluation?.verdict}` : `cycle: ${j.reason}`)}>run kernel cycle</button>
              <button disabled={busy} style={btn(C.purple, true)} onClick={() => act(`${B}/code/backlog`, {}, j => j.built ? `built ${j.id} on ${j.branch}` : `no build: ${j.reason}`)}>build from Ouroboros backlog</button>
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} style={{ ...btn(tab === k ? C.cyan : C.dim, true) }}>{l}</button>)}
      </div>

      {tab === 'tunables' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={form.tunable} onChange={e => setForm(f => ({ ...f, tunable: e.target.value }))} style={{ background: '#0a0a0f', color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 6 }}>
              <option value="">start an experiment on…</option>
              {(status?.tunables || []).map(t => <option key={t.name} value={t.name}>{t.name} (now {t.value})</option>)}
            </select>
            <input value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} placeholder="new value" style={{ width: 110, background: '#0a0a0f', color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 6 }} />
            <input value={form.hypothesis} onChange={e => setForm(f => ({ ...f, hypothesis: e.target.value }))} placeholder="hypothesis (what should move, and why)" style={{ flex: 1, minWidth: 220, background: '#0a0a0f', color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: 6 }} />
            <button disabled={busy || !form.tunable || form.value === ''} style={btn(C.cyan, true)} onClick={() => act(`${B}/experiments`, { tunable: form.tunable, value: Number(form.value), hypothesis: form.hypothesis, force: true }, j => `started ${j.id}: ${j.tunable} ${j.before} → ${j.after}`)}>start</button>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ color: C.dim, textAlign: 'left' }}><th style={{ padding: 6 }}>tunable</th><th>value</th><th>default</th><th>bounds</th><th>source</th><th>module</th></tr></thead>
            <tbody>
              {(status?.tunables || []).map(t => {
                const full = (status?.tunablesFull || []).find(x => x.name === t.name);
                return (
                  <tr key={t.name} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: 6, color: C.purple }}>{t.name}</td>
                    <td style={{ color: t.value !== t.default ? C.cyan : C.text, fontWeight: t.value !== t.default ? 700 : 400 }}>{fmt(t.value, full?.unit)}</td>
                    <td style={{ color: C.dim }}>{fmt(t.default, full?.unit)}</td>
                    <td style={{ color: C.dim }}>{full ? `${fmt(full.min, full.unit)} – ${fmt(full.max, full.unit)}` : ''}</td>
                    <td style={{ color: t.source === 'default' ? C.dim : C.amber }}>{t.source}</td>
                    <td style={{ color: C.dim }}>{full?.module || ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'experiments' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {experiments.length === 0 && <div style={{ color: C.dim }}>No experiments yet. The kernel proposes from rules every 5 minutes when the objective window has enough data; the LLM proposer runs at most every 2 h.</div>}
          {experiments.map(e => (
            <div key={e.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 600 }}><span style={{ color: vColor(e.verdict), marginRight: 8 }}>{e.verdict.toUpperCase()}</span>{e.tunable}: {e.before_value} → {e.after_value}</div>
                <div style={{ fontSize: 11, color: C.dim }}>{e.rule || e.source} · {ago(e.started_at)} · Δ {e.delta == null ? '—' : (e.delta >= 0 ? '+' : '') + e.delta}</div>
              </div>
              {e.hypothesis && <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>{e.hypothesis}</div>}
              {e.reason && <div style={{ fontSize: 11, color: vColor(e.verdict), marginTop: 4 }}>{e.reason}</div>}
              {e.baseline && e.post && <div style={{ fontSize: 11, color: C.dim, marginTop: 4 }}>before: obj {e.baseline.objective} · q {e.baseline.goalQuality ?? '—'} · eff {e.baseline.effectiveness ?? '—'} · err {e.baseline.runErrorRate ?? '—'} &nbsp;|&nbsp; after: obj {e.post.objective} · q {e.post.goalQuality ?? '—'} · eff {e.post.effectiveness ?? '—'} · err {e.post.runErrorRate ?? '—'}</div>}
            </div>
          ))}
        </div>
      )}

      {tab === 'code' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {code.length === 0 && <div style={{ color: C.dim }}>No code proposals yet. The daemon builds at most one per cycle from the Ouroboros backlog, bounded by {status?.config?.maxReady ?? 3} unreviewed branches.</div>}
          {code.map(p => (
            <div key={p.id} style={{ background: C.card, border: `1px solid ${p.status === 'ready' ? C.cyan : C.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}><span style={{ color: sColor(p.status), marginRight: 8 }}>{p.status.toUpperCase()}</span>{p.title}</div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ color: C.purple }}>{p.target_file}</span>
                    <span>{p.branch}</span>
                    <span>{p.model}</span>
                    <span>{ago(p.created_at)}</span>
                    <span>{p.tests_selected ? `${p.tests_selected} test file(s) ${p.tests_passed ? 'green' : 'red'}` : 'syntax check only'}</span>
                    {p.lines_before != null && p.lines_after != null && <span>{p.lines_before} → {p.lines_after} lines</span>}
                  </div>
                  {p.diff_stat && <pre style={{ fontSize: 10, color: C.dim, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{p.diff_stat}</pre>}
                  {p.failure && <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>{p.failure}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {p.status === 'ready' && <button disabled={busy} style={btn(C.dim, true)} onClick={() => showDiff(p.id)}>{open === p.id ? 'hide diff' : 'diff'}</button>}
                  {p.status === 'ready' && <button disabled={busy} style={btn(C.green, true)} title="git merge --no-ff into master; restart to run it" onClick={() => act(`${B}/code/${p.id}/approve`, { by: 'nexus' }, j => `merged ${j.sha?.slice(0, 8)} — restart the server to run it`)}>approve & merge</button>}
                  {(p.status === 'ready' || p.status === 'failed') && <button disabled={busy} style={btn(C.red, true)} onClick={() => act(`${B}/code/${p.id}/reject`, { by: 'nexus' }, () => 'rejected, branch deleted')}>reject</button>}
                </div>
              </div>
              {open === p.id && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', color: C.text, background: '#0a0a0f', border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, maxHeight: 360, overflow: 'auto', marginTop: 8 }}>{diff}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
