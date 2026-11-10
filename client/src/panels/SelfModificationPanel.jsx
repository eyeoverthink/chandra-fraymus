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
  const [cap, setCap] = useState(null);       // Phase AD capability status + lessons
  const [open, setOpen] = useState(null);     // code proposal id with diff open
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({ tunable: '', value: '', hypothesis: '' });

  const load = useCallback(async () => {
    try {
      const [s, e, c, t, r, ri, rp, sk, skl] = await Promise.all([fetch(B), fetch(`${B}/experiments?limit=40`), fetch(`${B}/code?limit=40`), fetch('/api/intelligence/tunables'), fetch('/api/intelligence/research'), fetch('/api/intelligence/research/items?limit=25&minRelevance=0.2'), fetch('/api/intelligence/research/proposals?limit=25'), fetch('/api/intelligence/skills'), fetch('/api/intelligence/skills/list?limit=40')]);
      const [sj, ej, cj, tj, rj, rij, rpj, skj, sklj] = await Promise.all([s.json(), e.json(), c.json(), t.json(), r.json(), ri.json(), rp.json(), sk.json(), skl.json()]);
      setStatus({ ...sj, tunablesFull: tj.tunables || [], research: { ...rj, itemsList: rij.items || [], proposalsList: rpj.proposals || [] }, skills: { ...skj, list: sklj.skills || [] } }); setExperiments(ej.experiments || []); setCode(cj.proposals || []); setError('');
    } catch (e) { setError(e.message); }
    try {
      const [cr, lr] = await Promise.all([fetch('/api/intelligence/capability'), fetch('/api/intelligence/capability/lessons?limit=12')]);
      const [cj, lj] = await Promise.all([cr.json(), lr.json()]);
      setCap({ ...cj, lessonList: lj.lessons || [] });
    } catch (e) { console.warn('capability status unavailable:', e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (wsEvent && /self_modification|tunable|skills|capability/.test(wsEvent.type || wsEvent.topic || '')) load(); }, [wsEvent, load]);
  const [skillOut, setSkillOut] = useState({});   // skill id → last test result
  const testSkill = async (s) => {
    setBusy(true);
    try { const r = await fetch(`/api/intelligence/skills/${encodeURIComponent(s.id)}/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: s.examples?.[0]?.input || {} }) }); const j = await r.json(); setSkillOut(o => ({ ...o, [s.id]: j })); }
    catch (e) { setSkillOut(o => ({ ...o, [s.id]: { error: e.message } })); } finally { setBusy(false); }
  };

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
  const conv = status?.conventions || {};
  const convOpen = Object.values(conv.open || {}).reduce((a, b) => a + b, 0);
  const research = status?.research || null;
  const skills = status?.skills || null;
  const tabs = [['experiments', `Experiments (${experiments.length})`], ['tunables', `Tunables (${status?.tunables?.length || 0})`], ['code', `Code (${cc.ready || 0} ready)`], ['conventions', `Conventions (${convOpen} open)`], ['research', `Research (${research?.relevantItems ?? 0} relevant)`], ['skills', `Skills (${skills?.counts?.active || 0} active)`], ['capability', `Capability (g ${cap?.latestAuto?.g != null ? cap.latestAuto.g.toFixed(2) : '—'})`]];

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

      {tab === 'conventions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: C.dim }}>Deterministic scan of server/ against the codebase's own conventions (CLAUDE.md). Each open finding is a cited file:line the code tier can fix inside one function; builds take the highest-priority rule first, preferring files a test covers.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(conv.open || {}).map(([rule, n]) => <Stat key={rule} label={rule.replace(/_/g, ' ')} value={n} color={C.amber} />)}
            <Stat label="fixed (resolved by scan)" value={conv.fixedTotal ?? 0} color={C.green} />
            <Stat label="in protected files" value={conv.protectedOpen ?? 0} color={C.dim} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button disabled={busy} style={btn(C.cyan, true)} onClick={() => act(`${B}/conventions/scan`, {}, j => `scanned ${j.files} files: ${j.findings} findings, ${j.newFindings} new, ${j.resolved} resolved`)}>scan now</button>
            <span style={{ fontSize: 11, color: C.dim, alignSelf: 'center' }}>last scan {ago(conv.lastScanAt)}</span>
          </div>
          {status?.proposerStats && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, fontSize: 12 }}>
              <div style={{ color: C.dim, marginBottom: 6 }}>Proposer credit — who earns their keep</div>
              {Object.entries(status.proposerStats.code || {}).map(([p, v]) => <div key={p}><span style={{ color: C.purple }}>{p}</span>: {v.ready} ready · {v.merged} merged · {v.rejected} rejected · {v.failed} failed · green rate {v.greenRate ?? '—'} · merge rate {v.mergeRate ?? '—'}</div>)}
              {Object.entries(status.proposerStats.experiments || {}).map(([p, v]) => <div key={p}><span style={{ color: C.cyan }}>{p}</span>: {v.kept} kept · {v.reverted} reverted · {v.inconclusive} inconclusive · keep rate {v.keepRate ?? '—'}</div>)}
            </div>
          )}
        </div>
      )}

      {tab === 'research' && research && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: C.dim }}>Keyless daily reads (arXiv, Hacker News, Semantic Scholar) on the organism's own topics, scored against its tunables and modules. The few most relevant are translated into ONE kernel proposal each — an experiment, a one-file sketch, a stored idea, or honestly none.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(research.items || {}).map(([k, v]) => <Stat key={k} label={`items ${k}`} value={v} color={k === 'translated' ? C.green : C.text} />)}
            <Stat label="relevant ≥ threshold" value={research.relevantItems ?? 0} color={C.cyan} />
            {Object.entries(research.proposals || {}).map(([k, v]) => <Stat key={k} label={k.replace(':', ' · ')} value={v} color={C.purple} />)}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button disabled={busy} style={btn(C.cyan, true)} onClick={() => act('/api/intelligence/research/scan', {}, j => `scan: ${j.fetched} fetched, ${j.newItems} new, ${j.translated} translated → ${j.proposals} proposals`)}>scan now</button>
            <button disabled={busy} style={btn(C.purple, true)} onClick={() => act('/api/intelligence/research/translate', { max: 3 }, j => `translated ${j.translated}, proposals ${j.proposals}`)}>translate top 3</button>
            <span style={{ fontSize: 11, color: C.dim, alignSelf: 'center' }}>last scan {ago(research.lastScanAt)}{research.lastScan?.errors?.length ? ` · ${research.lastScan.errors.length} source error(s)` : ''}</span>
          </div>
          <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>Proposals</div>
          {(research.proposalsList || []).length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>none yet</div>}
          {(research.proposalsList || []).map(p => (
            <div key={p.id} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, fontSize: 12 }}>
              <div><span style={{ color: p.kind === 'experiment' ? C.cyan : p.kind === 'code' ? C.purple : C.amber, fontWeight: 600, marginRight: 8 }}>{p.kind.toUpperCase()}</span><span style={{ color: C.dim }}>{p.status}</span> · <a href={p.url} target="_blank" rel="noreferrer" style={{ color: C.blue }}>{p.item_title}</a></div>
              <div style={{ color: C.text, marginTop: 4 }}>{p.kind === 'experiment' ? `${p.tunable} → ${p.value}: ${p.hypothesis}` : p.kind === 'code' ? `${p.target_file}: ${p.sketch}` : p.idea}</div>
            </div>
          ))}
          <div style={{ fontSize: 12, color: C.dim, marginTop: 4 }}>Most relevant items</div>
          {(research.itemsList || []).map(i => (
            <div key={i.id} style={{ display: 'flex', gap: 10, fontSize: 12, borderTop: `1px solid ${C.border}`, padding: '6px 0' }}>
              <span style={{ color: C.cyan, width: 40 }}>{i.relevance.toFixed(2)}</span>
              <span style={{ color: C.dim, width: 48 }}>{i.source}</span>
              <a href={i.url} target="_blank" rel="noreferrer" style={{ color: C.text, flex: 1, minWidth: 0, textDecoration: 'none' }}>{i.title}</a>
              <span style={{ color: i.status === 'translated' ? C.green : C.dim }}>{i.status}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'skills' && skills && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: C.dim }}>Programs the verifier proved by execution are crystallized into sandboxed tools (<code>skill.*</code>) every agent can call. Static gate (allow-listed builtins only), smoke-tested examples, Node permission sandbox, stripped env, 15 s timeout. Failing skills retire themselves; unused ones are flagged by the self-audit. Two skills → a composition goal → a third.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(skills.counts || {}).map(([k, v]) => <Stat key={k} label={k} value={v} color={k === 'active' ? C.green : k === 'failed' ? C.red : C.dim} />)}
            <Stat label="calls 24h" value={`${skills.calls24h?.ok ?? 0}/${skills.calls24h?.total ?? 0}`} color={C.cyan} />
            <Stat label="agents calling" value={skills.calls24h?.agents ?? 0} color={C.purple} />
            <Stat label="quality with skills" value={skills.outcomes?.withSkill?.meanQuality ?? '—'} color={C.green} />
            <Stat label="quality without" value={skills.outcomes?.without?.meanQuality ?? '—'} color={C.text} />
            {Object.entries(skills.compositions || {}).map(([k, v]) => <Stat key={k} label={`compose ${k}`} value={v} color={C.amber} />)}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button disabled={busy || skills.crystallizing} style={btn(C.cyan, true)} onClick={() => act('/api/intelligence/skills/crystallize', {}, j => j.crystallized ? `crystallized ${j.name} in ${j.iterations} attempt(s)` : `refused: ${j.reason}`)}>crystallize next fossil</button>
            <button disabled={busy || skills.composing} style={btn(C.amber, true)} onClick={() => act('/api/intelligence/skills/compose', { force: true }, j => j.composed ? `composition passed: loop ${j.loopId}` : `composition: ${j.reason || j.status}`)}>compose two skills</button>
            <span style={{ fontSize: 11, color: C.dim, alignSelf: 'center' }}>{skills.crystallizing ? 'crystallizing…' : skills.composing ? 'composing…' : skills.nextCandidate ? `next: ${skills.nextCandidate.goal}` : 'no fossil waiting'} · {skills.config?.perDay}/day</span>
          </div>
          {(skills.list || []).length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>No skills yet — every passed verification loop becomes a candidate.</div>}
          {(skills.list || []).map(s => (
            <div key={s.id} style={{ background: C.card, border: `1px solid ${s.status === 'active' ? C.green : C.border}`, borderRadius: 10, padding: 10, fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}><span style={{ color: s.status === 'active' ? C.green : s.status === 'failed' ? C.red : C.dim, marginRight: 8 }}>{s.status.toUpperCase()}</span><span style={{ color: C.cyan }}>{s.name}</span></div>
                  <div style={{ color: C.text, marginTop: 4 }}>{s.description}</div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <span>{s.source_kind}</span><span>{s.calls} calls · {s.failures} failed{s.meanMs != null ? ` · ${s.meanMs} ms` : ''}</span><span>{s.deterministic ? 'deterministic' : 'non-deterministic'}</span><span>{s.iterations} attempt(s)</span><span>{ago(s.created_at)}</span>
                    {s.input_schema?.properties && <span>in: {Object.keys(s.input_schema.properties).join(', ')}</span>}
                  </div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 2, fontStyle: 'italic' }}>from: {s.source_goal}</div>
                  {s.failure && <div style={{ fontSize: 11, color: C.red, marginTop: 4, whiteSpace: 'pre-wrap' }}>{s.failure}</div>}
                  {skillOut[s.id] && <pre style={{ fontSize: 10, color: skillOut[s.id].error ? C.red : C.green, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{JSON.stringify(skillOut[s.id].output ?? skillOut[s.id], null, 1).slice(0, 600)}</pre>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {s.status === 'active' && <button disabled={busy} style={btn(C.cyan, true)} onClick={() => testSkill(s)}>test</button>}
                  {s.status === 'active' && <button disabled={busy} style={btn(C.red, true)} onClick={() => act(`/api/intelligence/skills/${encodeURIComponent(s.id)}/retire`, { by: 'operator' }, () => `retired ${s.name}`)}>retire</button>}
                  {s.status === 'retired' && <button disabled={busy} style={btn(C.green, true)} onClick={() => act(`/api/intelligence/skills/${encodeURIComponent(s.id)}/restore`, { by: 'operator' }, () => `restored ${s.name}`)}>restore</button>}
                  {s.status === 'failed' && <button disabled={busy} style={btn(C.amber, true)} onClick={() => act('/api/intelligence/skills/crystallize', { loopId: s.source_loop_id, force: true }, j => j.crystallized ? `crystallized ${j.name}` : `refused: ${j.reason}`)}>retry</button>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'capability' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: C.dim }}>General capability, measured on freshly generated problems graded by code — no LLM judges anything here. <b>g</b> is the unweighted mean of per-family accuracy. The reasoner picks a strategy per family from measured results (Thompson sampling); lessons distilled from failures are A/B-tested on new seeds and kept only on gain. Blueprint: <code>docs/AGI-BLUEPRINT.md</code>.</div>
          {!cap && <div style={{ color: C.dim }}>Loading…</div>}
          {cap && (<>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Stat label="g (auto strategy)" value={cap.latestAuto?.g != null ? cap.latestAuto.g.toFixed(2) : '—'} color={C.green} />
              <Stat label="g (direct baseline)" value={cap.baselineDirect?.g != null ? cap.baselineDirect.g.toFixed(2) : '—'} color={C.text} />
              <Stat label="uplift" value={cap.upliftOverDirect != null ? (cap.upliftOverDirect >= 0 ? '+' : '') + cap.upliftOverDirect.toFixed(2) : '—'} color={cap.upliftOverDirect > 0 ? C.green : C.amber} />
              <Stat label="Brier (lower = calibrated)" value={cap.latestAuto?.brier != null ? cap.latestAuto.brier.toFixed(2) : '—'} color={C.cyan} />
              <Stat label="benchmarks" value={cap.runs ?? 0} color={C.purple} />
              <Stat label="lessons kept / reverted" value={`${cap.lessons?.kept || 0} / ${cap.lessons?.reverted || 0}`} color={C.amber} />
              <Stat label="agent reason calls 7d" value={cap.reasoner?.agentCalls?.n ?? 0} color={C.cyan} />
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button disabled={busy || !!cap.inFlight?.benchmark} style={btn(C.green, true)} onClick={() => act('/api/intelligence/capability/run', { strategy: 'auto' }, j => j.started ? `benchmark ${j.runId} started (${j.planned} problems)` : `refused: ${j.reason}`)}>run benchmark (auto)</button>
              <button disabled={busy || !!cap.inFlight?.benchmark} style={btn(C.dim, true)} onClick={() => act('/api/intelligence/capability/run', { strategy: 'direct' }, j => j.started ? `baseline ${j.runId} started` : `refused: ${j.reason}`)}>run baseline (direct)</button>
              <button disabled={busy || !!cap.inFlight?.lesson} style={btn(C.amber, true)} onClick={() => act('/api/intelligence/capability/lessons/test', {}, j => j.started ? `lesson test started for ${j.family}` : `no lesson: ${j.reason}`)}>distil + test a lesson</button>
              <span style={{ fontSize: 11, color: C.dim }}>{cap.inFlight?.benchmark ? `benchmark running: ${cap.inFlight.benchmark.done}/${cap.inFlight.benchmark.planned} (${cap.inFlight.benchmark.strategy})` : cap.inFlight?.lesson ? `testing a lesson for ${cap.inFlight.lesson.family}…` : `every ${Math.round((cap.config?.benchIntervalMs || 0) / 3600000)} h · ${cap.config?.perFamily} per family`}</span>
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Accuracy by family <span style={{ color: C.dim, fontWeight: 400, fontSize: 11 }}>latest auto run vs direct baseline</span></div>
              {(cap.config?.families || []).map(f => {
                const a = cap.latestAuto?.byFamily?.[f], d = cap.baselineDirect?.byFamily?.[f];
                return (
                  <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, margin: '3px 0' }}>
                    <span style={{ width: 84, color: C.text }}>{f}</span>
                    <div style={{ flex: 1, minWidth: 0, height: 10, background: '#0a0a10', borderRadius: 5, position: 'relative', overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', inset: 0, width: `${(a?.accuracy || 0) * 100}%`, background: C.green, opacity: 0.85 }} />
                      {d?.accuracy != null && <div style={{ position: 'absolute', top: 0, bottom: 0, left: `calc(${d.accuracy * 100}% - 1px)`, width: 2, background: C.text }} />}
                    </div>
                    <span style={{ width: 150, color: C.dim, fontSize: 11 }}>{a?.n ? `${a.correct}/${a.n}` : '—'}{a?.skipped ? ` (${a.skipped} skipped)` : ''} · direct {d?.n ? `${d.correct}/${d.n}` : '—'}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Strategy arms <span style={{ color: C.dim, fontWeight: 400, fontSize: 11 }}>posterior mean success · pulls · avg seconds — updated only from graded items</span></div>
              {(cap.reasoner?.arms || []).length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>No graded items yet.</div>}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(cap.reasoner?.arms || []).map(a => (
                  <span key={a.family + a.strategy} style={{ fontSize: 11, padding: '3px 7px', borderRadius: 6, border: `1px solid ${C.border}`, color: a.mean >= 0.6 ? C.green : a.mean <= 0.35 ? C.red : C.text }}>{a.family} · {a.strategy} · {a.mean.toFixed(2)} · {a.pulls} · {a.avgMs != null ? Math.round(a.avgMs / 1000) : '—'}s</span>
                ))}
              </div>
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Lessons</div>
              {(cap.lessonList || []).length === 0 && <div style={{ color: C.dim, fontSize: 12 }}>None yet — a lesson is distilled after a benchmark leaves ≥ 2 failures in one family.</div>}
              {(cap.lessonList || []).map(l => (
                <div key={l.id} style={{ fontSize: 12, padding: '5px 0', borderTop: `1px solid ${C.border}` }}>
                  <span style={{ color: l.status === 'kept' ? C.green : l.status === 'testing' ? C.cyan : C.dim, marginRight: 8 }}>{l.status.toUpperCase()}</span>
                  <span style={{ color: C.purple, marginRight: 8 }}>{l.family}</span>{l.text}
                  <div style={{ color: C.dim, fontSize: 11 }}>{l.n != null ? `with lesson ${l.lesson_correct}/${l.n}, without ${l.base_correct}/${l.n} — ${l.note || ''}` : (l.note || '')} · {ago(l.created_at)}
                    {l.status === 'kept' && <button disabled={busy} style={{ ...btn(C.red, true), marginLeft: 8 }} onClick={() => act(`/api/intelligence/capability/lessons/${encodeURIComponent(l.id)}/retire`, {}, () => 'lesson retired')}>retire</button>}
                  </div>
                </div>
              ))}
            </div>
          </>)}
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
                    {p.mode === 'span' && <span style={{ color: C.cyan }}>function-level (lines {p.span_start}–{p.span_end})</span>}
                    {p.source && <span>{p.source}</span>}
                    {p.outcome_delta != null && <span style={{ color: p.outcome_delta >= 0 ? C.green : C.red }}>post-merge Δ {p.outcome_delta}</span>}
                  </div>
                  {p.summary && <div style={{ fontSize: 11, color: C.text, marginTop: 4, fontStyle: 'italic' }}>model: {p.summary}</div>}
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
