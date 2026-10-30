import { useState, useEffect, useCallback } from 'react';

const TYPE_META = {
  agent:            { icon: '⊛', color: '#818cf8', label: 'Agent' },
  workflow:         { icon: '⬡', color: '#a78bfa', label: 'Workflow' },
  automation:       { icon: '⏲', color: '#38bdf8', label: 'Automation' },
  commerce:         { icon: '◈', color: '#f472b6', label: 'Commerce' },
  apparel:          { icon: '✦', color: '#fb923c', label: 'Apparel' },
  'mystery-shopper':{ icon: '⊘', color: '#34d399', label: 'Mystery' },
  'store-fixer':    { icon: '⊕', color: '#fbbf24', label: 'Fixer' },
};

const STATUS_COLOR = {
  completed: '#34d399', running: '#38bdf8', failed: '#f87171',
  pending: '#a78bfa', unknown: '#64748b',
};

function ago(ms) {
  if (!ms) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function StatusDot({ status }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: STATUS_COLOR[status] || STATUS_COLOR.unknown, marginRight: 6, flexShrink: 0
    }} />
  );
}

function TypeChip({ type }) {
  const m = TYPE_META[type] || { icon: '?', color: '#64748b', label: type };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 9999, fontSize: 11, fontWeight: 600,
      background: m.color + '22', color: m.color, border: `1px solid ${m.color}44`
    }}>
      {m.icon} {m.label}
    </span>
  );
}

function RunCard({ run, onClick }) {
  return (
    <button onClick={() => onClick(run)} style={{
      display: 'flex', alignItems: 'center', gap: 10, width: '100%',
      padding: '10px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 8, cursor: 'pointer', textAlign: 'left', color: 'inherit',
      transition: 'background 0.15s'
    }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.07)'}
      onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.03)'}
    >
      <StatusDot status={run.status} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
          <TypeChip type={run.type} />
          <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {run.label}
          </span>
        </div>
        {run.detail && (
          <div style={{ fontSize: 11, opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {run.detail}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, opacity: 0.4, whiteSpace: 'nowrap', flexShrink: 0 }}>
        {ago(run.timestamp)}
      </div>
    </button>
  );
}

function RunDetail({ run, onBack }) {
  const m = TYPE_META[run.type] || { icon: '?', color: '#64748b', label: run.type };
  const meta = run.meta || {};

  return (
    <div style={{ padding: 16 }}>
      <button onClick={onBack} style={{
        background: 'none', border: 'none', color: m.color, cursor: 'pointer',
        fontSize: 13, marginBottom: 12, padding: 0
      }}>← Back to history</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 22, background: m.color + '22', border: `2px solid ${m.color}44`
        }}>{m.icon}</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{run.label}</div>
          <div style={{ fontSize: 12, opacity: 0.5 }}>{m.label} Run · {run.id.slice(0, 12)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <Pill label="Status" value={run.status} color={STATUS_COLOR[run.status] || '#64748b'} />
        <Pill label="Type" value={m.label} color={m.color} />
        {run.timestamp > 0 && <Pill label="When" value={ago(run.timestamp)} color="#94a3b8" />}
        {meta.model && <Pill label="Model" value={meta.model} color="#818cf8" />}
        {meta.provider && <Pill label="Provider" value={meta.provider} color="#a78bfa" />}
        {meta.steps != null && <Pill label="Steps" value={String(meta.steps)} color="#38bdf8" />}
        {meta.duration_ms != null && <Pill label="Duration" value={`${(meta.duration_ms / 1000).toFixed(1)}s`} color="#34d399" />}
        {meta.score != null && <Pill label="Score" value={String(meta.score)} color="#fbbf24" />}
        {meta.grade && <Pill label="Grade" value={meta.grade} color="#34d399" />}
        {meta.products_created != null && <Pill label="Products" value={String(meta.products_created)} color="#fb923c" />}
        {meta.pages != null && <Pill label="Pages" value={String(meta.pages)} color="#fbbf24" />}
      </div>

      {run.detail && (
        <div style={{ padding: 12, background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
          {run.detail}
        </div>
      )}

      {meta.error && (
        <div style={{ padding: 12, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, fontSize: 12, color: '#f87171' }}>
          {meta.error}
        </div>
      )}
    </div>
  );
}

function Pill({ label, value, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '8px 14px', borderRadius: 10, background: color + '15', border: `1px solid ${color}30`, minWidth: 60 }}>
      <span style={{ fontSize: 10, opacity: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, color }}>{value}</span>
    </div>
  );
}

export default function RunHistory() {
  const [runs, setRuns] = useState([]);
  const [stats, setStats] = useState(null);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (typeFilter) params.set('type', typeFilter);
    if (statusFilter) params.set('status', statusFilter);
    params.set('limit', '100');
    fetch(`/api/run-history?${params}`)
      .then(r => r.json())
      .then(d => { setRuns(d.runs || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [typeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/run-history/stats').then(r => r.json()).then(setStats).catch(() => {});
  }, []);

  if (selected) return <RunDetail run={selected} onBack={() => setSelected(null)} />;

  const types = Object.keys(TYPE_META);
  const statuses = ['completed', 'running', 'failed', 'pending'];

  return (
    <div style={{ padding: 16, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Run History</h3>
        {stats && <span style={{ fontSize: 12, opacity: 0.4 }}>{stats.total} total runs</span>}
      </div>

      {stats && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {types.map(t => {
            const c = stats.counts?.[t] || 0;
            if (!c) return null;
            const m = TYPE_META[t];
            return (
              <span key={t} style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 9999,
                background: m.color + '18', color: m.color, fontWeight: 600
              }}>
                {m.icon} {c}
              </span>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6, padding: '4px 8px', color: 'inherit', fontSize: 12
        }}>
          <option value="">All Types</option>
          {types.map(t => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6, padding: '4px 8px', color: 'inherit', fontSize: 12
        }}>
          <option value="">All Statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={load} style={{
          background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6, padding: '4px 10px', color: 'inherit', fontSize: 12, cursor: 'pointer'
        }}>↻</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {loading && <div style={{ textAlign: 'center', padding: 40, opacity: 0.4 }}>Loading...</div>}
        {!loading && runs.length === 0 && (
          <div style={{ textAlign: 'center', padding: 40, opacity: 0.4 }}>No runs found</div>
        )}
        {!loading && runs.map(r => <RunCard key={`${r.type}-${r.id}`} run={r} onClick={setSelected} />)}
      </div>
    </div>
  );
}
