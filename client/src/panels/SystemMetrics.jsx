import React, { useState, useEffect, useCallback } from 'react';

function StatCard({ label, value, sub, color = '#a78bfa' }) {
  return (
    <div style={{
      background: '#111827', border: '1px solid #1e293b', borderRadius: 10,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <span style={{ color: '#64748b', fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      <span style={{ color, fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ color: '#475569', fontSize: 11 }}>{sub}</span>}
    </div>
  );
}

function BarChart({ data, labelKey, valueKey, color = '#a78bfa', maxWidth = 160 }) {
  const max = Math.max(...data.map(d => d[valueKey]), 1);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {data.map((d, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#94a3b8', fontSize: 11, width: 90, textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {d[labelKey]}
          </span>
          <div style={{ flex: 1, maxWidth, background: '#1e293b', borderRadius: 4, height: 16, overflow: 'hidden' }}>
            <div style={{
              width: `${(d[valueKey] / max) * 100}%`, height: '100%',
              background: `linear-gradient(90deg, ${color}88, ${color})`,
              borderRadius: 4, minWidth: d[valueKey] > 0 ? 4 : 0,
              transition: 'width 0.3s ease',
            }} />
          </div>
          <span style={{ color: '#94a3b8', fontSize: 11, width: 30, fontWeight: 500 }}>{d[valueKey]}</span>
        </div>
      ))}
    </div>
  );
}

function MiniSparkline({ data, color = '#a78bfa' }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map(d => d.runs + d.bus), 1);
  const w = 200, h = 48;
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((d.runs + d.bus) / max) * h;
    return `${x},${y}`;
  }).join(' ');

  return (
    <div style={{ position: 'relative' }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
        <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => {
          const x = (i / (data.length - 1)) * w;
          const y = h - ((d.runs + d.bus) / max) * h;
          return <circle key={i} cx={x} cy={y} r="3" fill={color} />;
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        {data.map((d, i) => (
          <span key={i} style={{ color: '#475569', fontSize: 9 }}>{d.label}</span>
        ))}
      </div>
    </div>
  );
}

const STATUS_COLORS = {
  completed: '#34d399', running: '#fbbf24', failed: '#f87171',
  queued: '#60a5fa', error: '#f87171', cancelled: '#9ca3af',
};

export default function SystemMetrics() {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/metrics');
      if (!res.ok) throw new Error('fetch failed');
      setMetrics(await res.json());
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: 40, color: '#64748b', textAlign: 'center' }}>Loading metrics...</div>;
  if (!metrics) return <div style={{ padding: 40, color: '#64748b', textAlign: 'center' }}>Failed to load metrics</div>;

  const o = metrics.overview;

  return (
    <div style={{ padding: '12px 16px', height: '100%', overflowY: 'auto', background: '#0a0a1a' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: 15 }}>System Metrics</span>
        <button onClick={() => { setLoading(true); load(); }} style={{
          background: 'none', border: '1px solid #334155', borderRadius: 6,
          color: '#94a3b8', fontSize: 11, padding: '3px 10px', cursor: 'pointer',
        }}>Refresh</button>
      </div>

      {/* Top stats grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
        <StatCard label="Agent Runs" value={o.totalRuns} sub={`${o.runs24h} last 24h`} color="#60a5fa" />
        <StatCard label="Success Rate" value={`${o.successRate}%`} sub={`${o.failedRuns} failed`} color={o.successRate >= 80 ? '#34d399' : o.successRate >= 50 ? '#fbbf24' : '#f87171'} />
        <StatCard label="Workflows" value={o.totalWorkflows} sub={`${o.workflows24h} last 24h`} color="#34d399" />
        <StatCard label="Bus Messages" value={o.totalBusMessages} sub={`${o.busMessages24h} last 24h`} color="#f472b6" />
        <StatCard label="Alerts" value={o.totalAlerts} sub={`${o.unresolvedAlerts} unresolved`} color={o.unresolvedAlerts > 0 ? '#f87171' : '#34d399'} />
        <StatCard label="Reflections" value={o.totalReflections} color="#c084fc" />
      </div>

      {/* Evolution stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 18 }}>
        <StatCard label="Forged Agents" value={o.totalForgedAgents} color="#c084fc" />
        <StatCard label="Synthesized Workflows" value={o.totalSynthesizedWorkflows} color="#34d399" />
      </div>

      {/* Commerce pipeline stats */}
      <div style={{ marginBottom: 18 }}>
        <h3 style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Commerce Pipelines</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          <StatCard label="Content→Commerce" value={o.commercePipelines} color="#fbbf24" />
          <StatCard label="Apparel" value={o.apparelPipelines} color="#fbbf24" />
          <StatCard label="Mystery Shopper" value={o.mysteryShopperRuns} color="#fbbf24" />
          <StatCard label="Store Fixer" value={o.storeFixerRuns} color="#fbbf24" />
        </div>
      </div>

      {/* 7-day activity sparkline */}
      {metrics.recentActivity && metrics.recentActivity.length > 0 && (
        <div style={{ marginBottom: 18, background: '#111827', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
          <h3 style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>7-Day Activity</h3>
          <MiniSparkline data={metrics.recentActivity} color="#a78bfa" />
        </div>
      )}

      {/* Run status breakdown */}
      {metrics.runsByStatus && metrics.runsByStatus.length > 0 && (
        <div style={{ marginBottom: 18, background: '#111827', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
          <h3 style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Runs by Status</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {metrics.runsByStatus.map(r => (
              <div key={r.status} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '4px 10px', borderRadius: 6,
                background: (STATUS_COLORS[r.status] || '#9ca3af') + '18',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLORS[r.status] || '#9ca3af' }} />
                <span style={{ color: '#e2e8f0', fontSize: 12, fontWeight: 500 }}>{r.status}</span>
                <span style={{ color: '#94a3b8', fontSize: 12 }}>{r.c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top agents */}
      {metrics.topAgents && metrics.topAgents.length > 0 && (
        <div style={{ marginBottom: 18, background: '#111827', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
          <h3 style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Top Agents</h3>
          <BarChart data={metrics.topAgents} labelKey="agent_id" valueKey="run_count" color="#60a5fa" />
        </div>
      )}

      {/* Top bus topics */}
      {metrics.topBusTopics && metrics.topBusTopics.length > 0 && (
        <div style={{ marginBottom: 18, background: '#111827', border: '1px solid #1e293b', borderRadius: 10, padding: 14 }}>
          <h3 style={{ color: '#94a3b8', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Top Bus Topics</h3>
          <BarChart data={metrics.topBusTopics} labelKey="topic" valueKey="msg_count" color="#f472b6" />
        </div>
      )}
    </div>
  );
}
