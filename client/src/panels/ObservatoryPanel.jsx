import React, { useState, useEffect, useCallback } from 'react';

const C = {
  bg: '#0a0a0f', card: '#111118', border: '#1e1e2a',
  text: '#e0e0e0', dim: '#666', accent: '#7c3aed',
  green: '#10b981', red: '#ef4444', amber: '#f59e0b',
  teal: '#14b8a6', purple: '#a78bfa', blue: '#3b82f6',
  pink: '#ec4899',
};

function StatPill({ label, value, color, sub }) {
  return (
    <div style={{ background: color + '15', border: `1px solid ${color}30`, borderRadius: 8, padding: '8px 14px', minWidth: 90, textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: C.dim, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function MiniSparkline({ data, color, width = 200, height = 40 }) {
  if (!data || data.length < 2) return <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.dim, fontSize: 11 }}>No data</div>;
  const vals = data.map(d => typeof d === 'number' ? d : d.value || 0);
  const max = Math.max(...vals, 0.01);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const points = vals.map((v, i) => `${(i / (vals.length - 1)) * width},${height - ((v - min) / range) * (height - 4) - 2}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function BarChart({ items, color, maxWidth = 160 }) {
  if (!items || items.length === 0) return <div style={{ color: C.dim, fontSize: 11 }}>No data</div>;
  const max = Math.max(...items.map(i => i.value), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.slice(0, 8).map((item, idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <span style={{ color: C.dim, width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>{item.label}</span>
          <div style={{ flex: 1, maxWidth, height: 10, background: C.border, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${(item.value / max) * 100}%`, height: '100%', background: color, borderRadius: 3 }} />
          </div>
          <span style={{ color: C.text, fontSize: 10, width: 30, textAlign: 'right' }}>{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function TimelineCard({ title, color, icon, children }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, borderTop: `2px solid ${color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
        <span style={{ color, fontSize: 13, fontWeight: 600 }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

function GoalsList({ goals }) {
  if (!goals || goals.length === 0) return <div style={{ color: C.dim, fontSize: 11 }}>No goals yet</div>;
  const statusColor = { proposed: C.amber, accepted: C.green, rejected: C.red, executing: C.blue, completed: C.teal };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {goals.slice(0, 6).map(g => (
        <div key={g.id} style={{ background: '#0d0d15', border: `1px solid ${C.border}`, borderRadius: 6, padding: '6px 10px', fontSize: 11 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.objective}</span>
            <span style={{ background: (statusColor[g.status] || C.dim) + '20', color: statusColor[g.status] || C.dim, padding: '1px 6px', borderRadius: 3, fontSize: 10, flexShrink: 0 }}>{g.status}</span>
            {g.priority && <span style={{ color: g.priority === 'high' ? C.red : g.priority === 'low' ? C.dim : C.amber, fontSize: 10 }}>{g.priority}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ObservatoryPanel({ wsEvent }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/observatory?days=${days}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError('');
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (wsEvent?.type === 'daemon' || wsEvent?.type === 'intelligence' || wsEvent?.type === 'system.goals') load();
  }, [wsEvent, load]);

  if (error) return <div style={{ color: C.red, padding: 20, fontSize: 13 }}>Observatory error: {error}</div>;
  if (!data) return <div style={{ color: C.dim, padding: 20, fontSize: 13 }}>Loading observatory...</div>;

  const heartData = (data.heart?.timeline || []).map(h => ({ value: h.intensity || 0 }));
  const chainStatusCounts = {};
  (data.chains?.runs || []).forEach(r => { chainStatusCounts[r.status] = (chainStatusCounts[r.status] || 0) + 1; });
  const memoryItems = (data.memory?.categories || []).map(c => ({ label: c.category, value: c.count }));
  const nsItems = (data.memory?.vertisoNamespaces || []).map(n => ({ label: n.namespace, value: n.count }));
  const verifierData = (data.verifier?.loops || []).map(v => ({ value: v.status === 'approved' ? 1 : 0 }));

  return (
    <div style={{ padding: '16px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: C.text, maxHeight: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Intelligence Observatory</h2>
          <span style={{ fontSize: 11, color: C.dim }}>Temporal view of the full intelligence stack</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {[1, 7, 14, 30].map(d => (
            <button key={d} onClick={() => setDays(d)} style={{
              background: days === d ? C.accent + '30' : 'transparent',
              border: `1px solid ${days === d ? C.accent : C.border}`,
              color: days === d ? C.accent : C.dim, borderRadius: 4,
              padding: '3px 8px', fontSize: 10, cursor: 'pointer',
            }}>{d}d</button>
          ))}
          <button onClick={load} disabled={loading} style={{
            background: 'transparent', border: `1px solid ${C.border}`, color: C.dim,
            borderRadius: 4, padding: '3px 8px', fontSize: 10, cursor: 'pointer',
          }}>{loading ? '...' : '↻'}</button>
        </div>
      </div>

      {/* Top stats row */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <StatPill label="Heart Readings" value={data.heart?.timeline?.length || 0} color={C.pink} />
        <StatPill label="Dreams" value={data.dreams?.count || 0} color={C.purple} />
        <StatPill label="Consciousness" value={data.consciousness?.passRate != null ? `${data.consciousness.passRate}%` : '—'} color={C.teal} sub="pass rate" />
        <StatPill label="Chain Success" value={data.chains?.successRate != null ? `${data.chains.successRate}%` : '—'} color={C.green} sub={`${data.chains?.runs?.length || 0} runs`} />
        <StatPill label="Verifier" value={data.verifier?.successRate != null ? `${data.verifier.successRate}%` : '—'} color={C.blue} sub={`${data.verifier?.loops?.length || 0} loops`} />
        <StatPill label="Goals" value={data.goals?.proposals?.length || 0} color={C.amber} />
        <StatPill label="Forged" value={data.evolution?.forgedAgents || 0} color={C.accent} sub="agents" />
        <StatPill label="Synthesized" value={data.evolution?.synthesizedWorkflows || 0} color={C.accent} sub="workflows" />
      </div>

      {/* Grid of temporal cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>

        <TimelineCard title="Heart Emotion" color={C.pink} icon="💗">
          <MiniSparkline data={heartData} color={C.pink} width={270} height={50} />
          {data.heart?.timeline?.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: C.dim }}>
              Latest: <span style={{ color: C.pink }}>{data.heart.timeline[data.heart.timeline.length - 1]?.primary || '—'}</span>
              {' '}({(data.heart.timeline[data.heart.timeline.length - 1]?.intensity * 100 || 0).toFixed(0)}%)
            </div>
          )}
        </TimelineCard>

        <TimelineCard title="Consciousness Proofs" color={C.teal} icon="🧠">
          {data.consciousness?.proofs?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {data.consciousness.proofs.slice(0, 5).map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: p.passed ? C.green : C.red }}>{p.passed ? '✓ Passed' : '✗ Failed'} ({p.proofCount} proofs)</span>
                  <span style={{ color: C.dim }}>{new Date(p.ts).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          ) : <div style={{ color: C.dim, fontSize: 11 }}>No proofs in period</div>}
        </TimelineCard>

        <TimelineCard title="Chain Runs" color={C.green} icon="⛓">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {Object.entries(chainStatusCounts).map(([status, count]) => (
              <span key={status} style={{ fontSize: 11, color: status === 'completed' ? C.green : status === 'crashed' ? C.red : C.amber }}>
                {status}: {count}
              </span>
            ))}
          </div>
          <MiniSparkline data={(data.chains?.runs || []).map(r => ({ value: r.status === 'completed' ? 1 : 0 }))} color={C.green} width={270} height={35} />
        </TimelineCard>

        <TimelineCard title="Verifier Loops" color={C.blue} icon="🔬">
          <MiniSparkline data={verifierData} color={C.blue} width={270} height={35} />
          <div style={{ marginTop: 6, fontSize: 11, color: C.dim }}>
            {data.verifier?.loops?.length || 0} total, {data.verifier?.loops?.filter(v => v.status === 'approved').length || 0} approved
          </div>
        </TimelineCard>

        <TimelineCard title="Goal Proposals" color={C.amber} icon="🎯">
          <GoalsList goals={data.goals?.proposals} />
        </TimelineCard>

        <TimelineCard title="Daemon Cycles" color={C.accent} icon="⚙">
          {data.daemon?.cycles?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {data.daemon.cycles.slice(0, 6).map((c, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                  <span style={{ color: C.text }}>{c.type}</span>
                  <span style={{ color: C.dim }}>{c.duration_ms ? `${(c.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
                </div>
              ))}
            </div>
          ) : <div style={{ color: C.dim, fontSize: 11 }}>No cycles in period</div>}
        </TimelineCard>

        <TimelineCard title="Agent Memory" color={C.purple} icon="📦">
          <BarChart items={memoryItems} color={C.purple} />
        </TimelineCard>

        <TimelineCard title="Vertiso Namespaces" color={C.teal} icon="🌊">
          <BarChart items={nsItems} color={C.teal} />
        </TimelineCard>

        <TimelineCard title="Reflections" color={C.pink} icon="🔮">
          {data.reflections?.recent?.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {data.reflections.recent.slice(0, 5).map((r, i) => {
                let actions = 0;
                try { actions = JSON.parse(r.actions_taken || '[]').length; } catch {}
                return (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                    <span style={{ color: C.text }}>{r.trigger} — {actions} action{actions !== 1 ? 's' : ''}</span>
                    <span style={{ color: C.dim }}>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</span>
                  </div>
                );
              })}
            </div>
          ) : <div style={{ color: C.dim, fontSize: 11 }}>No reflections in period</div>}
        </TimelineCard>
      </div>
    </div>
  );
}
